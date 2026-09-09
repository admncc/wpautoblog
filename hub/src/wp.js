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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    timer.fail(err, { context: { url, hint: 'Netzwerk, DNS, TLS oder Zeitueberschreitung' } });
    throw new WpError(`WordPress nicht erreichbar (${url}): ${err.message}`);
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
    return `Unter ${url} ist nichts erreichbar (404). Bitte Adresse der Website und Aktivierung des Plugins pruefen.`;
  }
  if (status >= 500) {
    return `WordPress meldet einen internen Fehler (HTTP ${status}). Antwort: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  }
  return `Unerwartete Antwort von WordPress (HTTP ${status}). Ist das Plugin aktiviert und die URL korrekt? `
    + `Antwort: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

async function ping(site) {
  return callSite(site, 'ping', { hub_version: VERSION });
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
  });
}

module.exports = { WpError, ping, publishArticle, callSite };
