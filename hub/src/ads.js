'use strict';
const { db } = require('./db');
const { logger } = require('./logger');
const { randomId, nacheinander } = require('./util');
const wp = require('./wp');
const adstxt = require('./adstxt');
const { VERSION } = require('./config');

/**
 * Die ads.txt aller Websites an einer Stelle.
 *
 * Zwei Wege fuehren zur Website, je nachdem, wie sie eingestellt ist:
 *
 * - Sende-Modus: Der Hub ruft das Plugin direkt an und hat die Antwort sofort.
 * - Abhol-Modus: Der Hub legt einen Auftrag ab. Das Plugin holt ihn beim naechsten
 *   Lebenszeichen (alle 15 Minuten) und meldet das Ergebnis zurueck.
 *
 * Geaendert wird immer so wenig wie moeglich: "ergaenzen" und "entfernen" fassen
 * nur die genannten Zeilen an. Die ganze Datei wird nur ersetzt, wenn jemand sie
 * im Hub von Hand bearbeitet hat - und dann mit einem Fingerabdruck abgesichert,
 * damit nichts ueberschrieben wird, das in der Zwischenzeit jemand anderes
 * geaendert hat.
 */

const PARALLEL = 3;
const LIVE_TIMEOUT_MS = 12000;

/* Ab dieser Fassung ersetzt das Plugin eine vorhandene Variable, statt sie ein
   zweites Mal anzuhaengen. Ohne das wuerde jeder Durchlauf eine weitere
   OWNERDOMAIN-Zeile in die Datei schreiben. */
const OWNERDOMAIN_PLUGIN = '1.6.2';

/**
 * Reicht die Plugin-Version auf dieser Website?
 *
 * Nicht jede Faehigkeit kann der Hub allein: Das Aufraeumen doppelter Zeilen
 * passiert im Plugin. Eine aeltere Fassung kennt den Auftrag nicht und wuerde mit
 * einer Meldung antworten, aus der niemand schlau wird.
 */
function versionReicht(vorhanden, noetig) {
  const teile = (v) => String(v || '0').split('.').map((n) => Number(n) || 0);
  const [a, b] = [teile(vorhanden), teile(noetig)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

function site(siteId) {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
}

function verbundeneSites() {
  return db.prepare("SELECT * FROM sites WHERE status = 'connected' ORDER BY name COLLATE NOCASE").all();
}

/** Was das Plugin gemeldet hat, in die Datenbank. */
function merke(siteId, status) {
  db.prepare(
    `UPDATE sites SET ads_txt = ?, ads_mode = ?, ads_url = ?, ads_path = ?, ads_digest = ?,
       ads_writable = ?, ads_root = ?, ads_backup = ?, ads_at = datetime('now'), ads_error = NULL
     WHERE id = ?`
  ).run(
    String(status.content || ''),
    String(status.mode || 'leer'),
    String(status.url || ''),
    String(status.path || ''),
    String(status.digest || ''),
    status.writable ? 1 : 0,
    status.root ? 1 : 0,
    status.has_backup ? 1 : 0,
    siteId
  );
}

function merkeFehler(siteId, fehler) {
  db.prepare("UPDATE sites SET ads_error = ?, ads_at = datetime('now') WHERE id = ?")
    .run(String(fehler).slice(0, 500), siteId);
}

// ------------------------------------------------------------- Auftragsablage

/** Ein wartender Auftrag je Website. Ein neuer ersetzt den alten. */
function legeAuftragAb(siteId, action, { content = '', entries = [] } = {}) {
  db.prepare("DELETE FROM ads_jobs WHERE site_id = ? AND status = 'wartet'").run(siteId);
  const id = randomId('adj');
  db.prepare(
    'INSERT INTO ads_jobs (id, site_id, action, content, entries) VALUES (?, ?, ?, ?, ?)'
  ).run(id, siteId, action, content, JSON.stringify(entries));
  logger.info('ads', 'auftrag', `ads.txt-Auftrag "${action}" abgelegt, die Website holt ihn ab`, {
    siteId, context: { job: id, zeilen: entries.length },
  });
  return { id, action, wartet: true };
}

/** Der Auftrag, den das Plugin beim Lebenszeichen mitbekommt. */
function offenerAuftrag(siteId) {
  const job = db
    .prepare("SELECT * FROM ads_jobs WHERE site_id = ? AND status = 'wartet' ORDER BY created_at ASC LIMIT 1")
    .get(siteId);
  if (!job) return null;

  let entries = [];
  try {
    entries = JSON.parse(job.entries || '[]');
  } catch { /* dann eben ohne */ }

  return { id: job.id, action: job.action, content: job.content || '', entries };
}

/** Rueckmeldung des Plugins zu einem Auftrag. */
function auftragFertig(siteId, jobId, antwort) {
  const job = db.prepare('SELECT * FROM ads_jobs WHERE id = ? AND site_id = ?').get(String(jobId || ''), siteId);
  if (!job) return false;

  if (antwort && antwort.ok === false) {
    db.prepare("UPDATE ads_jobs SET status = 'fehler', message = ?, done_at = datetime('now') WHERE id = ?")
      .run(String(antwort.message || 'Fehler in WordPress').slice(0, 500), job.id);
    merkeFehler(siteId, antwort.message || 'Fehler in WordPress');
    logger.error('ads', 'auftrag', `ads.txt-Auftrag fehlgeschlagen: ${antwort.message}`, { siteId });
    return true;
  }

  merke(siteId, antwort || {});
  db.prepare("UPDATE ads_jobs SET status = 'fertig', done_at = datetime('now') WHERE id = ?").run(job.id);
  logger.info('ads', 'auftrag', `ads.txt-Auftrag "${job.action}" erledigt (${(antwort && antwort.bytes) || 0} Bytes)`, {
    siteId, context: { modus: antwort && antwort.mode },
  });
  return true;
}

/** Wartet fuer diese Website gerade ein Auftrag? */
function wartet(siteId) {
  return db.prepare("SELECT * FROM ads_jobs WHERE site_id = ? AND status = 'wartet' LIMIT 1").get(siteId) || null;
}

// --------------------------------------------------------------- Lesen

/**
 * Holt den aktuellen Stand von einer Website.
 * Im Abhol-Modus wird nur der Auftrag abgelegt; das Ergebnis kommt spaeter.
 */
async function lese(siteId) {
  const s = site(siteId);
  if (!s) throw new Error('Website nicht gefunden.');
  if (s.status !== 'connected') throw new Error(`"${s.name}" ist nicht verbunden.`);

  if (s.delivery === 'pull') return legeAuftragAb(s.id, 'read');

  try {
    const antwort = await wp.callSite(s, 'ads-read', {});
    merke(s.id, antwort);
    return { ...antwort, wartet: false };
  } catch (err) {
    merkeFehler(s.id, err.message);
    throw err;
  }
}

/**
 * Prueft, was unter der echten Adresse steht.
 *
 * Das ist der einzige Beweis, der zaehlt: Nicht was WordPress meint zu haben,
 * sondern was ein Vermarkter beim Abruf zu sehen bekommt. Ein Cache, eine
 * Weiterleitung oder eine Datei im falschen Verzeichnis fallen nur hier auf.
 */
async function pruefeOeffentlich(siteId) {
  const s = site(siteId);
  if (!s || !s.url) return null;

  const ziel = `${String(s.url).replace(/\/+$/, '')}/ads.txt`;
  let ergebnis;
  try {
    const antwort = await fetch(ziel, {
      headers: { 'User-Agent': `WPAutoblogHub/${VERSION}`, Accept: 'text/plain' },
      redirect: 'follow',
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    if (antwort.status === 404) {
      ergebnis = { stand: 'fehlt', text: 'Unter dieser Adresse liegt keine ads.txt (404).' };
    } else if (!antwort.ok) {
      ergebnis = { stand: 'fehler', text: `Der Abruf antwortete mit HTTP ${antwort.status}.` };
    } else {
      const typ = antwort.headers.get('content-type') || '';
      const roh = (await antwort.text()).slice(0, 1024 * 1024);
      if (/text\/html/i.test(typ) || /^\s*</.test(roh)) {
        ergebnis = { stand: 'fehler', text: 'Unter der Adresse kommt eine HTML-Seite zurück, keine Textdatei.' };
      } else {
        const hier = adstxt.pruefe(s.ads_txt || '').eintraege;
        const dort = adstxt.pruefe(roh).eintraege;
        ergebnis = dort === hier
          ? { stand: 'ok', text: `Öffentlich abrufbar, ${dort} Einträge.` }
          : { stand: 'abweichung', text: `Öffentlich stehen ${dort} Einträge, im Hub ${hier}.` };
      }
    }
  } catch (err) {
    ergebnis = { stand: 'fehler', text: `Nicht abrufbar: ${err.message}` };
  }

  db.prepare("UPDATE sites SET ads_live = ?, ads_live_at = datetime('now') WHERE id = ?")
    .run(`${ergebnis.stand}: ${ergebnis.text}`, s.id);
  return ergebnis;
}

/** Alle verbundenen Websites einlesen. */
async function leseAlle(siteIds = null) {
  const reihe = nacheinander(PARALLEL);
  const sites = siteIds && siteIds.length
    ? siteIds.map((id) => site(id)).filter((s) => s && s.status === 'connected')
    : verbundeneSites();

  const ergebnisse = await Promise.all(sites.map((s) => reihe(async () => {
    try {
      const stand = await lese(s.id);
      if (!stand.wartet) await pruefeOeffentlich(s.id).catch(() => null);
      return { site_id: s.id, name: s.name, ok: true, wartet: Boolean(stand.wartet) };
    } catch (err) {
      return { site_id: s.id, name: s.name, ok: false, message: err.message };
    }
  })));

  logger.info('ads', 'lesen', `ads.txt von ${ergebnisse.filter((e) => e.ok).length} von ${sites.length} Websites eingelesen`);
  return ergebnisse;
}

// -------------------------------------------------------------- Schreiben

/** Die ganze Datei ersetzen. Nur fuer den Editor je Website. */
async function ersetze(siteId, inhalt, { erzwingen = false } = {}) {
  const s = site(siteId);
  if (!s) throw new Error('Website nicht gefunden.');
  if (s.status !== 'connected') throw new Error(`"${s.name}" ist nicht verbunden.`);

  const text = adstxt.schreibe(adstxt.parse(inhalt));
  if (s.delivery === 'pull') return legeAuftragAb(s.id, 'write', { content: text });

  try {
    const antwort = await wp.callSite(s, 'ads-write', {
      mode: 'replace',
      content: text,
      based_on: erzwingen ? '' : (s.ads_digest || ''),
    });
    merke(s.id, antwort);
    logger.info('ads', 'schreiben', `ads.txt von ${s.name} ersetzt (${antwort.bytes || 0} Bytes)`, {
      siteId: s.id, context: { modus: antwort.mode },
    });
    return { ...antwort, wartet: false };
  } catch (err) {
    merkeFehler(s.id, err.message);
    throw err;
  }
}

/**
 * Zeilen auf mehreren Websites ergaenzen oder entfernen.
 *
 * Die Zeilen gehen so, wie sie sind, an jede Website. Dort wird verglichen und
 * nur angehaengt, was fehlt. Der Hub schickt also nie eine ganze Datei - was auf
 * der Website steht, bleibt stehen, auch wenn der Hub es nicht kennt.
 */
async function aufSeiten(aktion, siteIds, zeilen) {
  if (!['add', 'remove'].includes(aktion)) throw new Error('Unbekannte Aktion.');
  const texte = zeilen.map((z) => adstxt.alsText(z)).filter(Boolean);
  if (!texte.length) throw new Error('Es sind keine gültigen Zeilen dabei.');

  const reihe = nacheinander(PARALLEL);
  const ergebnisse = await Promise.all(siteIds.map((id) => reihe(async () => {
    const s = site(id);
    if (!s) return { site_id: id, name: 'unbekannt', ok: false, message: 'Website nicht gefunden.' };
    if (s.status !== 'connected') {
      return { site_id: id, name: s.name, ok: false, message: 'Nicht verbunden.' };
    }

    if (s.delivery === 'pull') {
      legeAuftragAb(s.id, aktion, { entries: texte });
      return { site_id: s.id, name: s.name, ok: true, wartet: true };
    }

    try {
      const vorher = adstxt.pruefe(s.ads_txt || '').eintraege;
      const antwort = await wp.callSite(s, 'ads-write', { mode: aktion, entries: texte });
      merke(s.id, antwort);
      const nachher = adstxt.pruefe(antwort.content || '').eintraege;
      return {
        site_id: s.id,
        name: s.name,
        ok: true,
        wartet: false,
        geaendert: nachher - vorher,
        eintraege: nachher,
      };
    } catch (err) {
      merkeFehler(s.id, err.message);
      return { site_id: s.id, name: s.name, ok: false, message: err.message };
    }
  })));

  const wort = aktion === 'add' ? 'ergaenzt' : 'entfernt';
  logger.info('ads', aktion, `${texte.length} Zeile(n) auf ${ergebnisse.filter((e) => e.ok).length} Website(s) ${wort}`, {
    context: { zeilen: texte, fehler: ergebnisse.filter((e) => !e.ok).map((e) => `${e.name}: ${e.message}`) },
  });
  return ergebnisse;
}

/**
 * Raeumt doppelte Zeilen auf einer Website weg.
 *
 * Das Aufraeumen passiert auf der Website, nicht im Hub: So wird nur angefasst,
 * was dort wirklich steht, auch wenn der Hub einen aelteren Stand kennt.
 */
async function entdoppele(siteId) {
  const s = site(siteId);
  if (!s) throw new Error('Website nicht gefunden.');
  if (s.status !== 'connected') throw new Error(`"${s.name}" ist nicht verbunden.`);

  if (!versionReicht(s.plugin_version, '1.5.1')) {
    throw new Error(`Das Plugin auf "${s.name}" ist noch auf Version ${s.plugin_version || 'unbekannt'}.`
      + ' Zum Aufräumen braucht es mindestens 1.5.1. Das Update kommt von selbst, oder du stößt es'
      + ' unter Websites an.');
  }

  // Doppelte Angaben wie zweimal MANAGERDOMAIN erkennt erst die neuere Fassung.
  // Ein aelteres Plugin raeumte die Eintraege weg und liesse die Angabe stehen -
  // der Hub meldete dann "aufgeraeumt", und die doppelte Zeile stuende weiter da.
  const entfaellt = adstxt.entdoppele(s.ads_txt || '').entfernt;
  if (entfaellt.some((z) => z.art === 'variable') && !versionReicht(s.plugin_version, '1.6.3')) {
    throw new Error(`Auf "${s.name}" steht eine Angabe wie ${entfaellt.find((z) => z.art === 'variable').name}`
      + ` doppelt. Dafür braucht es Plugin 1.6.3, dort läuft noch ${s.plugin_version || 'eine ältere Fassung'}.`
      + ' Das Update kommt von selbst, oder du stößt es unter Websites an.');
  }

  const vorher = adstxt.pruefe(s.ads_txt || '').doppelt.length;
  if (s.delivery === 'pull') return legeAuftragAb(s.id, 'dedupe');

  try {
    const antwort = await wp.callSite(s, 'ads-write', { mode: 'dedupe' });
    merke(s.id, antwort);
    const nachher = adstxt.pruefe(antwort.content || '').doppelt.length;
    logger.info('ads', 'entdoppeln', `${vorher - nachher} doppelte Zeile(n) bei ${s.name} entfernt`, {
      siteId: s.id, context: { vorher, nachher },
    });
    return { ...antwort, wartet: false, entfernt: Math.max(vorher - nachher, 0) };
  } catch (err) {
    merkeFehler(s.id, err.message);
    throw err;
  }
}

/** Dasselbe fuer mehrere Websites auf einmal. */
async function entdoppeleAlle(siteIds) {
  const reihe = nacheinander(PARALLEL);
  return Promise.all(siteIds.map((id) => reihe(async () => {
    const s = site(id);
    if (!s) return { site_id: id, name: 'unbekannt', ok: false, message: 'Website nicht gefunden.' };
    try {
      const stand = await entdoppele(id);
      return {
        site_id: s.id, name: s.name, ok: true,
        wartet: Boolean(stand.wartet), entfernt: stand.entfernt || 0,
      };
    } catch (err) {
      return { site_id: s.id, name: s.name, ok: false, message: err.message };
    }
  })));
}

/**
 * Leert die ads.txt auf mehreren Websites.
 *
 * Die haerteste Aktion in diesem Bereich: Danach verkauft dort niemand mehr
 * Werbung, bis wieder etwas drinsteht. Endgueltig ist sie trotzdem nicht - das
 * Plugin sichert den bisherigen Stand vor jedem Schreiben, und "Letzte Aenderung
 * zuruecknehmen" holt ihn auf der Einzelseite zurueck.
 */
async function leere(siteIds) {
  const reihe = nacheinander(PARALLEL);

  const ergebnisse = await Promise.all(siteIds.map((id) => reihe(async () => {
    const s = site(id);
    if (!s) return { site_id: id, name: 'unbekannt', ok: false, message: 'Website nicht gefunden.' };
    if (s.status !== 'connected') return { site_id: id, name: s.name, ok: false, message: 'Nicht verbunden.' };

    const vorher = adstxt.pruefe(s.ads_txt || '').eintraege;

    // Bewusst als "die ganze Datei ersetzen, und zwar durch nichts" statt als
    // eigener Befehl: Das versteht jede Fassung des Plugins, die ads.txt ueberhaupt
    // kennt. Ein eigener Modus wuerde erst nach dem naechsten Plugin-Update
    // funktionieren, und bis dahin kaeme von dort nur "Es wurde kein Inhalt
    // gesendet" - eine Meldung, aus der niemand schlau wird.
    if (s.delivery === 'pull') {
      legeAuftragAb(s.id, 'write', { content: '' });
      return { site_id: s.id, name: s.name, ok: true, wartet: true, vorher };
    }

    try {
      const antwort = await wp.callSite(s, 'ads-write', { mode: 'replace', content: '' });
      merke(s.id, antwort);
      return { site_id: s.id, name: s.name, ok: true, wartet: false, vorher };
    } catch (err) {
      merkeFehler(s.id, err.message);
      return { site_id: s.id, name: s.name, ok: false, message: err.message };
    }
  })));

  logger.warn('ads', 'leeren',
    `ads.txt auf ${ergebnisse.filter((e) => e.ok).length} von ${siteIds.length} Website(s) geleert`, {
      context: {
        websites: ergebnisse.filter((e) => e.ok).map((e) => `${e.name} (${e.vorher} Einträge)`),
        fehler: ergebnisse.filter((e) => !e.ok).map((e) => `${e.name}: ${e.message}`),
      },
    });
  return ergebnisse;
}

/** Den Stand vor dem letzten Schreiben zurueckholen. */
async function zuruecknehmen(siteId) {
  const s = site(siteId);
  if (!s) throw new Error('Website nicht gefunden.');
  if (s.delivery === 'pull') return legeAuftragAb(s.id, 'restore');

  const antwort = await wp.callSite(s, 'ads-write', { mode: 'restore' });
  merke(s.id, antwort);
  logger.warn('ads', 'zurueck', `ads.txt von ${s.name} auf den vorherigen Stand zurueckgesetzt`, { siteId: s.id });
  return { ...antwort, wartet: false };
}

// ------------------------------------------------------------- OWNERDOMAIN

/**
 * Steht in der ads.txt, wem die Seite gehoert?
 *
 * OWNERDOMAIN nennt die Domain des Inhabers der Werbeplaetze. Vermarkter und
 * Pruefwerkzeuge lesen die Zeile, um zusammengehoerende Seiten zu erkennen; fehlt
 * sie, zaehlt die Seite als unvollstaendig gepflegt. Die Zeile ist immer dieselbe
 * und ergibt sich aus der Adresse der Website - niemand muss sie je selbst tippen.
 *
 * Vier Zustaende, und nur einer davon ist Arbeit:
 *   ok         - steht drin und passt
 *   fehlt      - die Zeile gehoert hinein (das macht der Hub von selbst)
 *   anders     - dort steht eine andere Domain. Das aendert nur ein Mensch.
 *   ungelesen  - noch nie gelesen, es gibt also nichts zu beurteilen
 *   unbekannt  - keine Adresse hinterlegt, aus der sich eine Domain ergibt
 */
function ownerdomain(s) {
  const soll = adstxt.domainAusAdresse(s.url);
  const ist = adstxt.variable(s.ads_txt || '', 'OWNERDOMAIN');
  // "www.maikikii.de" statt "maikikii.de" ist kein Fehler, den man jemandem
  // melden muss - gemeint ist dieselbe Domain.
  const wie = (wert) => String(wert || '').trim().toLowerCase().replace(/^www\./, '');

  let stand = 'ok';
  if (!soll) stand = 'unbekannt';
  else if (!s.ads_at) stand = 'ungelesen';
  else if (ist === null) stand = 'fehlt';
  else if (wie(ist) !== soll) stand = 'anders';

  return { soll, ist: ist === null ? '' : ist, stand };
}

/**
 * Setzt die OWNERDOMAIN-Zeile auf einer Website.
 *
 * Geschickt wird nur die eine Zeile, nicht die ganze Datei: Das Zusammenfuehren
 * passiert im Plugin, und was dort sonst noch steht, bleibt unangetastet.
 *
 * Eine fremde Domain wird nicht von selbst ueberschrieben. Wer OWNERDOMAIN von
 * Hand auf etwas anderes gesetzt hat, hatte einen Grund - den Knopf dafuer gibt
 * es, aber ein Mensch muss ihn druecken.
 */
async function setzeOwnerdomain(siteId, { ueberschreiben = false } = {}) {
  const s = site(siteId);
  if (!s) throw new Error('Website nicht gefunden.');
  if (s.status !== 'connected') throw new Error(`"${s.name}" ist nicht verbunden.`);

  const stand = ownerdomain(s);
  if (!stand.soll) {
    throw new Error(`Aus der Adresse von "${s.name}" lässt sich keine Domain ablesen`
      + `${s.url ? ` ("${s.url}")` : ''}. OWNERDOMAIN braucht eine echte Domain.`);
  }
  if (stand.stand === 'ok') return { ...stand, geaendert: false, wartet: false };
  if (stand.stand === 'anders' && !ueberschreiben) {
    throw new Error(`In der ads.txt von "${s.name}" steht schon OWNERDOMAIN=${stand.ist}.`
      + ' Das ändert der Hub nicht von selbst.');
  }
  if (!versionReicht(s.plugin_version, OWNERDOMAIN_PLUGIN)) {
    throw new Error(`Das Plugin auf "${s.name}" ist noch auf Version ${s.plugin_version || 'unbekannt'}.`
      + ` Für OWNERDOMAIN braucht es mindestens ${OWNERDOMAIN_PLUGIN}, sonst stünde die Zeile`
      + ' hinterher doppelt in der Datei. Das Update kommt von selbst, oder du stößt es unter'
      + ' Websites an.');
  }

  const zeile = `OWNERDOMAIN=${stand.soll}`;
  if (s.delivery === 'pull') {
    legeAuftragAb(s.id, 'add', { entries: [zeile] });
    return { ...stand, geaendert: false, wartet: true };
  }

  try {
    const antwort = await wp.callSite(s, 'ads-write', { mode: 'add', entries: [zeile] });
    merke(s.id, antwort);
    const nachher = ownerdomain(site(siteId));
    logger.info('ads', 'ownerdomain', `OWNERDOMAIN=${stand.soll} in der ads.txt von ${s.name} gesetzt`, {
      siteId: s.id, context: { vorher: stand.ist || '(fehlte)', nachher: nachher.ist },
    });
    return { ...nachher, geaendert: true, wartet: false };
  } catch (err) {
    merkeFehler(s.id, err.message);
    throw err;
  }
}

/** Dasselbe fuer mehrere Websites. */
async function setzeOwnerdomainAlle(siteIds, { ueberschreiben = false } = {}) {
  const reihe = nacheinander(PARALLEL);
  return Promise.all(siteIds.map((id) => reihe(async () => {
    const s = site(id);
    if (!s) return { site_id: id, name: 'unbekannt', ok: false, message: 'Website nicht gefunden.' };
    try {
      const stand = await setzeOwnerdomain(id, { ueberschreiben });
      return {
        site_id: s.id, name: s.name, ok: true, domain: stand.soll,
        geaendert: Boolean(stand.geaendert), wartet: Boolean(stand.wartet),
      };
    } catch (err) {
      return { site_id: s.id, name: s.name, ok: false, message: err.message };
    }
  })));
}

/**
 * Der taegliche Durchlauf: nachsehen und nachtragen.
 *
 * Erst wird jede Datei frisch gelesen - danach urteilt der Hub nicht ueber einen
 * Stand von letzter Woche. Nachgetragen wird nur, wo die Zeile ganz fehlt. Eine
 * Website im Abhol-Modus gibt ihren Stand erst beim naechsten Lebenszeichen her
 * und kommt deshalb im naechsten Durchlauf dran.
 */
async function pflegeOwnerdomain() {
  await leseAlle();

  const faellig = uebersicht().filter((s) => s.connected && s.ownerdomain.stand === 'fehlt');
  if (!faellig.length) return { geprueft: 0, gesetzt: 0, fehler: 0, ergebnisse: [] };

  const ergebnisse = await setzeOwnerdomainAlle(faellig.map((s) => s.id));
  const gesetzt = ergebnisse.filter((e) => e.ok && !e.wartet).length;
  const fehler = ergebnisse.filter((e) => !e.ok);

  logger.info('ads', 'ownerdomain',
    `OWNERDOMAIN auf ${gesetzt} von ${faellig.length} Website(s) nachgetragen`, {
      context: {
        gesetzt: ergebnisse.filter((e) => e.ok).map((e) => `${e.name}: ${e.domain}`),
        fehler: fehler.map((e) => `${e.name}: ${e.message}`),
      },
    });
  return { geprueft: faellig.length, gesetzt, fehler: fehler.length, ergebnisse };
}

// ------------------------------------------------------------- Fuer die Oberflaeche

/** Kurzfassung je Website fuer die Uebersicht. */
function uebersicht() {
  return db.prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE').all().map((s) => {
    const zahlen = adstxt.pruefe(s.ads_txt || '');
    const auftrag = wartet(s.id);
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      connected: s.status === 'connected',
      delivery: s.delivery,
      mode: s.ads_mode || '',
      path: s.ads_path || '',
      ads_url: s.ads_url || '',
      writable: Boolean(s.ads_writable),
      root: s.ads_root == null ? null : Boolean(s.ads_root),
      backup: Boolean(s.ads_backup),
      gelesen_am: s.ads_at || null,
      fehler: s.ads_error || null,
      live: s.ads_live || null,
      live_am: s.ads_live_at || null,
      eintraege: zahlen.eintraege,
      direkt: zahlen.direkt,
      reseller: zahlen.reseller,
      variablen: zahlen.variablen,
      kaputt: zahlen.fehler.length,
      doppelt: zahlen.doppelt.length,
      widerspruch: zahlen.widerspruch.length,
      vermarkter: adstxt.vermarkter(s.ads_txt || ''),
      ownerdomain: ownerdomain(s),
      wartet: auftrag ? { action: auftrag.action, seit: auftrag.created_at } : null,
    };
  });
}

/** Eine einzelne Website mit allen Zeilen. */
function einzeln(siteId) {
  const s = site(siteId);
  if (!s) return null;
  const kopf = uebersicht().find((e) => e.id === siteId);
  return {
    ...kopf,
    content: s.ads_txt || '',
    digest: s.ads_digest || '',
    zeilen: adstxt.parse(s.ads_txt || ''),
    pruefung: adstxt.pruefe(s.ads_txt || ''),
    // Genau die Zeilen, die beim Aufraeumen verschwinden wuerden. Welche von zwei
    // gleichen bleibt, entscheidet die Vollstaendigkeit - das soll man vorher sehen.
    entfaellt: adstxt.entdoppele(s.ads_txt || '').entfernt,
  };
}

/**
 * Welcher Vermarkter steht auf welcher Seite?
 * Das ist die Frage, wegen der es diesen Bereich gibt: Auf einer von acht Seiten
 * fehlt ein Eintrag, und niemand sieht es, weil man acht Dateien vergleichen muesste.
 */
function vergleich() {
  const sites = uebersicht().filter((s) => s.connected);
  const alle = new Map();

  for (const s of sites) {
    for (const zeile of adstxt.parse(db.prepare('SELECT ads_txt FROM sites WHERE id = ?').get(s.id).ads_txt || '')) {
      if (zeile.art !== 'eintrag') continue;
      const key = adstxt.schluessel(zeile);
      if (!alle.has(key)) {
        alle.set(key, { domain: zeile.domain, konto: zeile.konto, beziehung: zeile.beziehung, kennung: zeile.kennung, sites: [] });
      }
      alle.get(key).sites.push(s.id);
    }
  }

  return {
    sites: sites.map((s) => ({ id: s.id, name: s.name })),
    zeilen: [...alle.values()]
      .map((e) => ({ ...e, fehlt: sites.filter((s) => !e.sites.includes(s.id)).map((s) => s.id) }))
      .sort((a, b) => b.sites.length - a.sites.length || a.domain.localeCompare(b.domain)),
  };
}

module.exports = {
  lese, leseAlle, ersetze, aufSeiten, entdoppele, entdoppeleAlle, leere, zuruecknehmen, pruefeOeffentlich,
  ownerdomain, setzeOwnerdomain, setzeOwnerdomainAlle, pflegeOwnerdomain, OWNERDOMAIN_PLUGIN,
  uebersicht, einzeln, vergleich,
  offenerAuftrag, auftragFertig, wartet, nacheinander, versionReicht,
};
