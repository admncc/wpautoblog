'use strict';
const { sign, decrypt } = require('./util');
const { PUBLIC_URL, VERSION } = require('./config');
const { logger, excerpt } = require('./logger');
const images = require('./images');

const TIMEOUT_MS = 45000;

class WpError extends Error {}

/**
 * Signierter Aufruf an das WordPress-Plugin.
 * Das Plugin prueft Zeitstempel und HMAC-Signatur, ein Passwort wird nie uebertragen.
 */
async function callSite(site, path, payload) {
  const secret = decrypt(site.secret);
  if (!secret) throw new WpError('Fuer diese Website existiert kein Token. Bitte im Hub neu erzeugen.');
  if (!site.url) {
    throw new WpError('Fuer diese Website ist keine URL hinterlegt. Sie wird gesetzt, sobald sich das WordPress-Plugin meldet.');
  }

  const body = JSON.stringify(payload || {});
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `${site.url}/wp-json/wp-autoblog/v1/${path}`;
  const timer = logger.start('wordpress', path, `WordPress-Aufruf ${path} an ${site.url}`, {
    siteId: site.id,
    context: { url, body_bytes: body.length },
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WPAB-Site': site.id,
        'X-WPAB-Timestamp': String(timestamp),
        'X-WPAB-Signature': sign(secret, timestamp, body),
        'X-WPAB-Hub': PUBLIC_URL || '',
        'User-Agent': `WPAutoblogHub/${VERSION}`,
      },
      body,
      // Einer Weiterleitung darf hier nicht gefolgt werden: Aus einem POST wird
      // dabei laut Standard ein GET, und damit sind Inhalt und Signatur weg.
      // WordPress antwortet dann mit "keine Route gefunden" - ein 404, das
      // aussieht, als fehle das Plugin, obwohl nur die Adresse nicht genau stimmt.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    timer.fail(err, { context: { url, hint: 'Netzwerk, DNS, TLS oder Zeitueberschreitung' } });
    throw new WpError(`WordPress nicht erreichbar (${url}): ${err.message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    const ziel = response.headers.get('location') || '';
    timer.fail(`Weiterleitung ${response.status}`, { status: response.status, context: { url, ziel } });
    throw new WpError(
      `Die Website leitet den Aufruf weiter (HTTP ${response.status}${ziel ? ` nach ${ziel}` : ''}).`
      + ' Bei einer Weiterleitung geht die Signatur verloren, deshalb bricht der Hub hier ab.'
      + ' Bitte die Adresse der Website im Hub genau so eintragen, wie WordPress sie selbst nennt'
      + ' (mit oder ohne "www", http oder https).'
    );
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    timer.fail('Antwort war kein JSON', {
      status: response.status,
      context: { url, response: excerpt(raw, 800), content_type: response.headers.get('content-type') },
    });
    throw new WpError(erklaereAntwort(raw, response.status, url));
  }
  if (!response.ok || data.ok === false) {
    timer.fail(data.message || `HTTP ${response.status}`, { status: response.status, context: { url, response: excerpt(raw, 800) } });
    throw new WpError(data.message || `WordPress meldet einen Fehler (HTTP ${response.status}).`);
  }

  timer.ok(`WordPress-Aufruf ${path} erfolgreich (HTTP ${response.status})`, {
    status: response.status,
    context: { url, response: excerpt(raw, 500) },
  });
  return data;
}

/** Uebersetzt typische WordPress-Fehlerseiten in eine verstaendliche Meldung. */
function erklaereAntwort(raw, status, url) {
  const text = String(raw || '');

  if (/Datenbankverbindung|database connection/i.test(text)) {
    return `Die WordPress-Seite selbst hat ein Problem: Sie erreicht ihre eigene Datenbank nicht `
      + `("Fehler beim Aufbau einer Datenbankverbindung"). Das liegt nicht am Hub und nicht am Plugin. `
      + `Bitte ${url.replace(/\/wp-json.*/, '')} im Browser aufrufen; zeigt die Seite denselben Fehler, `
      + `muss der Hoster oder der Datenbankdienst geprueft werden. Danach hier erneut senden.`;
  }
  if (/rest_no_route|No route was found/i.test(text)) {
    return 'WordPress kennt die Empfangsadresse nicht. Ist das Plugin "Autoblog Connector" aktiviert?';
  }
  if (/rest_disabled|REST API.*(disabled|deaktiviert)/i.test(text)) {
    return 'Die REST-API von WordPress ist gesperrt, meist durch ein Sicherheits-Plugin. Bitte dort freigeben.';
  }
  if (status === 403) {
    return 'WordPress hat die Anfrage abgewiesen (403). Haeufige Ursache: eine Firewall oder ein Sicherheits-Plugin vor der REST-API.';
  }
  if (status === 404) {
    // 404 heisst nicht zwingend "Plugin fehlt". Antwortet die Website im Browser
    // normal, weist hier jemand gezielt den Hub ab - und dann sucht man sonst
    // stundenlang an der falschen Stelle.
    return `Unter ${url} ist nichts erreichbar (404). Entweder ist das Plugin nicht aktiv,`
      + ` oder die Website weist Anfragen vom Server des Hubs ab. Laesst sich die Website im`
      + ` Browser normal aufrufen, ist es das Zweite: dann liegt es an einem Schutzdienst`
      + ` davor (Cloudflare) oder an einem Sicherheits-Plugin. "Verbindung testen" zeigt die`
      + ` Einzelheiten.`;
  }
  if (status >= 500) {
    return `WordPress meldet einen internen Fehler (HTTP ${status}). Antwort: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  }
  return `Unerwartete Antwort von WordPress (HTTP ${status}). Ist das Plugin aktiviert und die URL korrekt? `
    + `Antwort: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/** Eine Adresse aus dem oeffentlichen Netz? Interne taugen nicht zum Vergleich. */
function istOeffentlich(ip) {
  if (!ip || ip.includes(':')) return false;              // IPv6 bleibt hier aussen vor
  const [a, b] = ip.split('.').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/**
 * Redet der Hub ueberhaupt mit der richtigen Maschine?
 *
 * WordPress meldet beim Lebenszeichen, unter welcher Adresse es selbst laeuft.
 * Weicht die von dem ab, was der Hub erreicht, ist die Sache klar: Der Name loest
 * auf dem Hub-Server veraltet auf, und jeder Aufruf landet bei einem fremden
 * Rechner. Der kennt die Domain nicht und antwortet auf jeden Pfad mit 404 - die
 * Website selbst ist voellig in Ordnung.
 *
 * Steht ein Schutzdienst wie Cloudflare davor, sind die Adressen berechtigt
 * verschieden. Dann sagt dieser Vergleich nichts, und es wird nichts behauptet.
 */
function andereMaschine(site, adressen) {
  const gemeldet = String(site.server_ip || '').trim();
  if (!istOeffentlich(gemeldet)) return null;
  const erreichbar = adressen.filter(istOeffentlich);
  if (!erreichbar.length || erreichbar.includes(gemeldet)) return null;

  return {
    ok: false,
    text: `WordPress meldet, es laeuft auf ${gemeldet}`
      + `${site.server_software ? ` (${site.server_software})` : ''}.`
      + ` Der Hub erreicht unter diesem Namen aber ${erreichbar.join(', ')}.`
      + ' Das sind verschiedene Maschinen: Der Hub redet mit dem falschen Server, und der'
      + ' kennt die Domain nicht - daher der 404 auf jedem Pfad. Liegt kein Schutzdienst'
      + ' (Cloudflare o. ae.) davor, ist der Namenseintrag auf dem Server des Hubs veraltet.',
  };
}

/**
 * Wenn die Website dem Hub die Tuer vor der Nase zumacht.
 *
 * Der haeufigste Fall bei einer Website, die im Browser tadellos laeuft: Nicht die
 * Website ist kaputt, sondern der Hub ist unerwuenscht. Sein Server steht in einem
 * Rechenzentrum, und genau solche Adressen sperren Schutzdienste gern pauschal -
 * mal mit 403, mal mit 404, je nach Einstellung.
 *
 * Das ist besonders verwirrend, weil die Verbindung in WordPress "steht": Dort
 * meldet sich das Plugin beim Hub, und diese Richtung ist nicht gesperrt. Nur der
 * Rueckweg ist zu.
 */
function sperreErklaeren(site, antwort, adressen = []) {
  const schritte = [];
  const cloudflare = /cloudflare/i.test(antwort.server || '') || Boolean(antwort.cfRay);

  schritte.push({
    ok: false,
    text: 'Im Browser ist diese Website erreichbar, dem Hub gegenueber nicht. Dann liegt es'
      + ' nicht am Plugin, sondern daran, dass die Website Anfragen vom Server des Hubs abweist.'
      + ' Der Weg andersherum (WordPress meldet sich beim Hub) ist davon nicht betroffen,'
      + ' deshalb steht dort "verbunden".',
  });

  if (cloudflare) {
    schritte.push({
      ok: false,
      text: 'Vor dieser Website steht Cloudflare. Dort nachsehen unter "Security" -> "Events":'
        + ' Der abgewiesene Aufruf steht mit Grund und Regel im Protokoll. Freigeben laesst er sich'
        + ' unter "Security" -> "WAF" -> "Tools" (IP Access Rules) mit der Aktion "Allow", oder'
        + ' ueber eine WAF-Regel mit "Skip". Haeufigster Ausloeser ist "Bot Fight Mode" unter'
        + ' "Security" -> "Bots" - der sperrt Rechenzentrums-Adressen pauschal.'
        + ' Die Einstellungen gelten je Domain: Dass eine andere Website funktioniert, sagt nichts'
        + ' ueber diese hier.',
    });
  } else {
    schritte.push({
      ok: false,
      text: `Geantwortet hat "${antwort.server || 'unbekannt'}". Zu pruefen sind in dieser Reihenfolge:`
        + ' ein Sicherheits-Plugin in WordPress (Wordfence und aehnliche sperren Adressen nach'
        + ' wenigen Aufrufen), die Firewall des Hosters, und ein vorgeschalteter Schutzdienst.',
    });
  }

  const hubAdresse = PUBLIC_URL ? PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
  schritte.push({
    ok: true,
    text: `Freizugeben ist die Adresse des Hubs${hubAdresse ? ` (${hubAdresse})` : ''}.`
      + ' Die dazugehoerige IP zeigt ein "ping" auf diesen Namen.'
      + (adressen.length ? ` Die Website selbst erreicht der Hub unter ${adressen.join(', ')}.` : ''),
  });

  schritte.push({
    ok: true,
    text: 'Sofort und ohne Cloudflare-Aenderung geht es mit dem Abhol-Modus: Unter'
      + ' "Verbindung" den Uebertragungsweg auf "WordPress holt die Artikel selbst ab" stellen.'
      + ' Dann meldet sich immer WordPress beim Hub, und der Hub muss die Website nie erreichen.',
  });

  return schritte;
}

/**
 * Sucht die Ursache, wenn der signierte Aufruf scheitert.
 * Prueft der Reihe nach: Ist die Website erreichbar? Antwortet die REST-API von
 * WordPress? Ist das Plugin registriert? Daraus ergibt sich, wo das Problem sitzt.
 */
async function diagnose(site) {
  const schritte = [];
  const holen = async (pfad) => {
    const ziel = `${site.url}${pfad}`;
    try {
      const antwort = await fetch(ziel, {
        headers: { 'User-Agent': `WPAutoblogHub/${VERSION}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      // Nicht vorschnell kuerzen: Die Antwort wird gleich als JSON gelesen, und ein
      // abgeschnittenes /wp-json/ laesst sich nicht mehr auswerten. Das meldete die
      // Diagnose dann als "REST-API gesperrt", obwohl alles in Ordnung war.
      const text = (await antwort.text()).slice(0, 2 * 1024 * 1024);
      return {
        ziel,
        status: antwort.status,
        text,
        typ: antwort.headers.get('content-type') || '',
        // Wer antwortet da eigentlich? Bei einer Sperre ist das die wichtigste Angabe.
        server: antwort.headers.get('server') || '',
        cfRay: antwort.headers.get('cf-ray') || '',
      };
    } catch (err) {
      return { ziel, fehler: err.message };
    }
  };

  const istDbFehler = (text) => /Datenbankverbindung|database connection/i.test(text || '');

  /**
   * Wohin loest der Name auf?
   *
   * Ein veralteter Eintrag im Namensdienst des Servers schickt den Hub an einen
   * fremden Rechner, der diese Domain nicht kennt - und der antwortet auf alles
   * mit 404. Von aussen sieht die Website dabei tadellos aus, und man sucht den
   * Fehler stundenlang im Plugin.
   */
  let adressen = [];
  try {
    const { hostname } = new URL(site.url);
    adressen = (await require('dns').promises.lookup(hostname, { all: true })).map((a) => a.address);
    schritte.push({
      ok: true,
      text: `Der Name ${hostname} zeigt vom Hub aus auf ${adressen.join(', ')}.`,
    });
  } catch (err) {
    schritte.push({ ok: false, text: `Der Name liess sich vom Hub aus nicht aufloesen (${err.message}).` });
    return schritte;
  }

  // Der entscheidende Vergleich, wenn WordPress seine eigene Adresse gemeldet hat.
  const falscherServer = andereMaschine(site, adressen);
  if (falscherServer) {
    schritte.push(falscherServer);
    schritte.push({
      ok: true,
      text: 'Zu pruefen ist die Namensaufloesung auf dem Server des Hubs, nicht die Website:'
        + ' "dig +short <domain>" gegen "dig +short <domain> @1.1.1.1" vergleichen, den'
        + ' Zwischenspeicher leeren ("resolvectl flush-caches") und in /etc/hosts nachsehen,'
        + ' ob dort ein alter Eintrag steht.',
    });
  }

  // 1. Die Website selbst
  const start = await holen('/');
  if (start.fehler) {
    schritte.push({ ok: false, text: `Die Adresse ${site.url} ist vom Hub aus nicht erreichbar (${start.fehler}).` });
    return schritte;
  }
  if (istDbFehler(start.text)) {
    schritte.push({ ok: false, text: `Die Startseite meldet bereits einen Datenbankfehler (HTTP ${start.status}).` });
  } else if (start.status >= 400) {
    // Eine Startseite, die 404 sagt, ist kein "antwortet": Hier antwortet jemand,
    // aber nicht die Website.
    schritte.push({
      ok: false,
      text: `Die Startseite antwortet dem Hub mit HTTP ${start.status}`
        + `${start.server ? ` (Server: ${start.server})` : ''}. Im Browser ist die Seite vermutlich`
        + ` normal zu sehen - dann wird nicht die Website abgewiesen, sondern der Hub.`,
    });
  } else {
    schritte.push({
      ok: true,
      text: `Startseite antwortet (HTTP ${start.status}${start.server ? `, Server: ${start.server}` : ''}).`,
    });
  }

  // 2. Die REST-API von WordPress
  const rest = await holen('/wp-json/');
  if (rest.fehler) {
    schritte.push({ ok: false, text: `Die REST-API ist nicht erreichbar (${rest.fehler}).` });
    return schritte;
  }
  if (istDbFehler(rest.text)) {
    schritte.push({
      ok: false,
      text: `Die REST-API meldet einen Datenbankfehler, obwohl die Startseite laeuft. `
        + `Typisch, wenn die Startseite aus einem Seiten-Cache kommt und die Datenbank in Wahrheit `
        + `nicht erreichbar oder ueberlastet ist. Zu pruefen: Datenbankdienst, Verbindungsgrenze `
        + `(max_connections) und die Zugangsdaten in der wp-config.php.`,
    });
    return schritte;
  }

  let daten = null;
  try {
    daten = JSON.parse(rest.text);
  } catch { /* kein JSON */ }

  if (!daten) {
    schritte.push({
      ok: false,
      text: `Unter ${rest.ziel} kommt kein JSON zurueck (HTTP ${rest.status}, ${rest.typ || 'ohne Typ'})`
        + `${rest.server ? `, geantwortet hat "${rest.server}"` : ''}.`
        + ` Anfang der Antwort: ${excerpt(rest.text.replace(/\s+/g, ' '), 160)}`,
    });
    schritte.push(...sperreErklaeren(site, rest, adressen));
    return schritte;
  }

  schritte.push({ ok: true, text: `REST-API antwortet (WordPress-Seite "${daten.name || ''}").` });

  const namensraeume = Array.isArray(daten.namespaces) ? daten.namespaces : [];
  schritte.push(
    namensraeume.includes('wp-autoblog/v1')
      ? { ok: true, text: 'Das Plugin "Autoblog Connector" ist aktiv und registriert.' }
      : { ok: false, text: 'Das Plugin "Autoblog Connector" ist auf dieser Website nicht aktiv. Bitte unter Plugins aktivieren.' }
  );

  // 3. Weist die Website auf eine andere Adresse?
  if (daten.home && daten.home.replace(/\/+$/, '') !== site.url) {
    schritte.push({
      ok: false,
      text: `WordPress nennt als eigene Adresse ${daten.home}, hinterlegt ist aber ${site.url}. `
        + `Bitte die Adresse der Website im Hub angleichen.`,
    });
  }

  return schritte;
}

async function ping(site) {
  return callSite(site, 'ping', { hub_version: VERSION });
}

/** Stoesst das Plugin-Update auf der WordPress-Seite an. */
async function updatePlugin(site) {
  return callSite(site, 'update', { download_url: require('./pluginpack').downloadUrl(site.id) });
}

/** Soll das Quellvideo im Beitrag eingebettet werden? Steht am Kanal. */
function quelleEinbetten(article) {
  const { db } = require('./db');
  const kanal = db
    .prepare('SELECT c.embed_video FROM videos v JOIN channels c ON c.id = v.channel_ref WHERE v.article_id = ?')
    .get(article.id);
  return kanal ? Boolean(kanal.embed_video) : true;
}

async function publishArticle(site, article) {
  return callSite(site, 'publish', {
    article_id: article.id,
    post_id: article.wp_post_id || 0,
    title: article.title,
    slug: article.slug,
    content: article.content_html,
    excerpt: article.excerpt,
    status: site.wp_status || 'draft',
    category: article.category || site.wp_category || '',
    tags: article.tags ? article.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    author_id: site.wp_author_id || 0,
    meta: { title: article.meta_title, description: article.meta_desc },
    // WordPress laedt die Bilder ueber diese Adressen selbst herunter.
    images: images.forDelivery(article.id),
    // Bei Artikeln aus Videos: Quelle zum Einbetten und Nennen.
    source: article.source_url
      ? { url: article.source_url, title: article.source_title || '', embed: quelleEinbetten(article) }
      : null,
  });
}

module.exports = {
  WpError, ping, diagnose, updatePlugin, publishArticle, callSite,
  andereMaschine, istOeffentlich,
};
