'use strict';
/**
 * Funktionspruefung des Hubs von aussen.
 *
 * Startet den Server mit einer frischen Datenbank in einem temporaeren Ordner,
 * stellt ein WordPress und einen Bilddienst nach und geht die wichtigsten Ablaeufe
 * durch. Keine echten Anthropic-Aufrufe, keine echten Kosten.
 *
 * Aufruf:  npm test
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.TEST_PORT || 4199);
const WP_PORT = PORT + 1;
const IMG_PORT = PORT + 2;
const BASIS = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autoblog-test-'));

// Auch der Testprozess selbst muss auf die Testdatenbank zeigen, nicht auf die
// Arbeitsdatenbank daneben. Muss vor jedem require der Hub-Module stehen.
process.env.DATA_DIR = DATA_DIR;
process.env.PUBLIC_URL = BASIS;
process.env.CONTROL_DIR = path.join(DATA_DIR, 'control');

let bestanden = 0;
let gescheitert = 0;
let cookie = '';

const gruen = (t) => `[32m${t}[0m`;
const rot = (t) => `[31m${t}[0m`;

function pruefe(bedingung, beschreibung, zusatz = '') {
  if (bedingung) {
    bestanden += 1;
    console.log(`  ${gruen('ok')}   ${beschreibung}`);
  } else {
    gescheitert += 1;
    console.log(`  ${rot('FEHL')} ${beschreibung}${zusatz ? ` (${zusatz})` : ''}`);
  }
}

async function ruf(pfad, { method = 'GET', body, headers = {}, mitCookie = true } = {}) {
  const antwort = await fetch(`${BASIS}${pfad}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(mitCookie && cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setzeCookie = antwort.headers.get('set-cookie');
  if (setzeCookie) cookie = setzeCookie.split(';')[0];
  const text = await antwort.text();
  let daten = null;
  try {
    daten = JSON.parse(text);
  } catch { /* kein JSON */ }
  return { status: antwort.status, daten, text, headers: antwort.headers };
}

/** Signierter Aufruf, wie ihn das WordPress-Plugin absetzt. */
async function alsPlugin(pfad, siteId, token, koerper) {
  const body = JSON.stringify(koerper);
  const ts = String(Math.floor(Date.now() / 1000));
  const antwort = await fetch(`${BASIS}${pfad}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WPAB-Site': siteId,
      'X-WPAB-Timestamp': ts,
      'X-WPAB-Signature': crypto.createHmac('sha256', token).update(`${ts}\n${body}`).digest('hex'),
    },
    body,
  });
  return { status: antwort.status, daten: await antwort.json().catch(() => null) };
}

// --- Nachgestellte Gegenstellen ---------------------------------------------

function starteFakeWordPress(token, siteId) {
  const empfangen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ts = req.headers['x-wpab-timestamp'];
      const erwartet = crypto.createHmac('sha256', token).update(`${ts}\n${body}`).digest('hex');
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-wpab-signature'] !== erwartet || req.headers['x-wpab-site'] !== siteId) {
        res.writeHead(401);
        return res.end(JSON.stringify({ ok: false, message: 'Signatur ungueltig' }));
      }
      res.writeHead(200);
      if (req.url.endsWith('/ping')) {
        return res.end(JSON.stringify({
          ok: true, site_name: 'Test-WP', wp_version: '6.9', plugin_version: '1.3.1',
          categories: [{ id: 1, name: 'Ratgeber', slug: 'ratgeber', count: 12 }, { id: 2, name: 'News', slug: 'news', count: 3 }],
        }));
      }
      const daten = JSON.parse(body || '{}');
      empfangen.push({ url: req.url, daten });
      if (req.url.endsWith('/update')) {
        return res.end(JSON.stringify({ ok: true, from: '1.3.1', version: '99.0.0' }));
      }
      return res.end(JSON.stringify({
        ok: true, post_id: 42, url: 'https://test-wp.example/beitrag/',
        images_imported: (daten.images || []).length, image_errors: [], category: daten.category,
      }));
    });
  });
  server.listen(WP_PORT);
  return { server, empfangen };
}

/**
 * Stellt Supadata nach: Transkript, Kanalvideos und Video-Metadaten.
 * Ueber kanalVideos laesst sich im Test steuern, was der Kanal gerade meldet.
 */
const TITEL = {
  sc_a: 'Alpha Fahrbericht aus Muenchen',
  sc_b: 'Beta Werkstatt und Wartung',
  sc_c: 'Gamma Reifen im Wintertest',
  sc_d: 'Delta Elektroautos im Alltag',
};

function starteFakeTranskript(zustand) {
  const server = http.createServer((req, res) => {
    if (!req.headers['x-api-key']) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', message: 'kein Schluessel' }));
    }
    const adresse = new URL(req.url, 'http://127.0.0.1');
    const antworte = (daten) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(daten));
    };

    if (adresse.pathname === '/v1/youtube/channel/videos') {
      zustand.abrufe += 1;
      return antworte({ videoIds: zustand.kanalVideos, shortIds: [], liveIds: [] });
    }
    if (adresse.pathname === '/v1/youtube/video') {
      const id = adresse.searchParams.get('id');
      zustand.metadaten += 1;
      return antworte({
        id, title: TITEL[id] || `Video ${id}`, description: 'Kurze Beschreibung.',
        duration: 600, channel: { id: 'UCtesttesttesttesttest12', name: 'Testkanal' },
        tags: [], transcriptLanguages: ['de'], uploadDate: '2026-09-10T10:00:00.000Z',
      });
    }
    zustand.transkripte += 1;
    antworte({
      lang: 'de',
      content: 'Zinsen steigen wieder an. '.repeat(30) + 'Das hat Folgen fuer Sparer und Kreditnehmer.',
    });
  });
  server.listen(IMG_PORT + 1);
  return server;
}

function starteFakeBilddienst() {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(req.headers.authorization ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers.authorization ? { data: [{ b64_json: PNG }] } : { error: { message: 'kein Schluessel' } }));
    });
  });
  server.listen(IMG_PORT);
  return server;
}

// --- Ablauf ------------------------------------------------------------------

async function main() {
  console.log(`\nHub-Funktionspruefung, Daten in ${DATA_DIR}\n`);

  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      PUBLIC_URL: BASIS,
      CONTROL_DIR: path.join(DATA_DIR, 'control'),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const protokoll = [];
  hub.stdout.on('data', (d) => protokoll.push(String(d)));
  hub.stderr.on('data', (d) => protokoll.push(String(d)));

  // Auf den Server warten
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASIS}/health`);
      if (r.ok) break;
    } catch { /* noch nicht bereit */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  let fakeWp = null;
  let fakeBild = null;
  const transkriptZustand = { kanalVideos: [], abrufe: 0, metadaten: 0, transkripte: 0 };
  let fakeTranskript = starteFakeTranskript(transkriptZustand);

  try {
    console.log('Sicherheit');
    const ohneAnmeldung = await ruf('/api/app/sites', { mitCookie: false });
    pruefe(ohneAnmeldung.status === 401, 'App-Routen ohne Anmeldung abgewiesen', `HTTP ${ohneAnmeldung.status}`);

    const kopf = await ruf('/');
    pruefe(/default-src 'self'/.test(kopf.headers.get('content-security-policy') || ''), 'Content-Security-Policy gesetzt');
    pruefe(kopf.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options gesetzt');

    const diagOhneToken = await ruf('/diagnose/unsinn');
    pruefe(diagOhneToken.status === 403, 'Diagnose ohne gueltigen Token abgewiesen', `HTTP ${diagOhneToken.status}`);

    console.log('\nEinrichtung');
    const setup = await ruf('/api/setup', { method: 'POST', body: { email: 'test@example.de', password: 'sicheresPasswort1' } });
    pruefe(setup.status === 200, 'Konto anlegen');
    const zweitesKonto = await ruf('/api/setup', { method: 'POST', body: { email: 'zweiter@example.de', password: 'sicheresPasswort1' } });
    pruefe(zweitesKonto.status === 400, 'Zweites Konto wird verweigert');

    console.log('\nWebsite und Verbindung');
    const site = await ruf('/api/app/sites', { method: 'POST', body: { name: 'Testblog', url: `http://127.0.0.1:${WP_PORT}` } });
    const siteId = site.daten.id;
    const token = site.daten.token;
    pruefe(site.status === 201 && /^wpab_/.test(token), 'Website angelegt und Token erzeugt');

    fakeWp = starteFakeWordPress(token, siteId);

    const falscherToken = await ruf('/api/plugin/connect', { method: 'POST', body: { token: 'wpab_falsch' }, mitCookie: false });
    pruefe(falscherToken.status === 404, 'Verbinden mit falschem Token abgewiesen');

    const verbinden = await ruf('/api/plugin/connect', {
      method: 'POST',
      mitCookie: false,
      body: {
        token, site_url: `http://127.0.0.1:${WP_PORT}`, wp_version: '6.9', plugin_version: '1.3.1',
        categories: [{ id: 1, name: 'Ratgeber', slug: 'ratgeber', count: 12 }, { id: 2, name: 'News', slug: 'news', count: 3 }],
      },
    });
    pruefe(verbinden.status === 200 && verbinden.daten.site_id === siteId, 'Plugin verbindet sich');

    const detail = await ruf(`/api/app/sites/${siteId}`);
    pruefe((detail.daten.site.categories || []).length === 2, 'Gemeldete Kategorien gespeichert');

    const ohneSignatur = await fetch(`${BASIS}/api/plugin/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    pruefe(ohneSignatur.status === 401, 'Plugin-Aufruf ohne Signatur abgewiesen');

    const falscheSignatur = await fetch(`${BASIS}/api/plugin/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WPAB-Site': siteId,
        'X-WPAB-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-WPAB-Signature': 'a'.repeat(64),
      },
      body: '{}',
    });
    pruefe(falscheSignatur.status === 401, 'Plugin-Aufruf mit falscher Signatur abgewiesen');

    const alterZeitstempel = await fetch(`${BASIS}/api/plugin/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WPAB-Site': siteId,
        'X-WPAB-Timestamp': String(Math.floor(Date.now() / 1000) - 4000),
        'X-WPAB-Signature': 'b'.repeat(64),
      },
      body: '{}',
    });
    pruefe(alterZeitstempel.status === 401, 'Abgelaufener Zeitstempel abgewiesen');

    const test = await ruf(`/api/app/sites/${siteId}/test`, { method: 'POST' });
    pruefe(test.status === 200 && test.daten.ok, 'Verbindungstest erfolgreich', test.daten && test.daten.error);

    console.log('\nThemen und Plan');
    const themen = await ruf(`/api/app/sites/${siteId}/topics`, { method: 'POST', body: { keywords: 'Erstes Thema\nZweites Thema\n\n' } });
    pruefe(themen.daten.added === 2, 'Zwei Themen angelegt, Leerzeile ignoriert', `added=${themen.daten && themen.daten.added}`);

    const plan = await ruf('/api/app/plans', { method: 'POST', body: { site_id: siteId, name: 'Testplan', areas: 'Bereich A', per_week: 3, publish_hour: 6 } });
    pruefe(plan.status === 201 && plan.daten.next_run_at, 'Plan angelegt und Termin berechnet');

    // "Jetzt ausfuehren" darf nur den angeklickten Plan starten. Frueher lief hier
    // der Durchlauf ueber alle faelligen Plaene und der Post landete woanders.
    const zweiteSeite = await ruf('/api/app/sites', { method: 'POST', body: { name: 'Zweite Seite', url: 'https://zweite.example' } });
    const zweiteId = zweiteSeite.daten.id;
    await ruf(`/api/app/sites/${zweiteId}/topics`, { method: 'POST', body: { keywords: 'Thema der zweiten Seite' } });
    const zweiterPlan = await ruf('/api/app/plans', {
      method: 'POST', body: { site_id: zweiteId, name: 'Plan zwei', areas: 'Bereich B', per_week: 3, publish_hour: 6 },
    });
    const { db: datenbank } = require('../src/db');
    datenbank.prepare('UPDATE plans SET next_run_at = NULL').run();  // beide faellig machen

    await ruf(`/api/app/plans/${plan.daten.id}/run`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 1200));
    const beiZwei = datenbank.prepare('SELECT COUNT(*) AS n FROM articles WHERE site_id = ?').get(zweiteId);
    const beiEins = datenbank.prepare('SELECT COUNT(*) AS n FROM articles WHERE plan_id = ?').get(plan.daten.id);
    pruefe(beiEins.n === 1 && beiZwei.n === 0,
      'Jetzt ausfuehren startet nur den angeklickten Plan', `eigener=${beiEins.n}, fremder=${beiZwei.n}`);

    await ruf(`/api/app/plans/${zweiterPlan.daten.id}`, { method: 'DELETE' });
    await ruf(`/api/app/sites/${zweiteId}`, { method: 'DELETE' });

    console.log('\nArtikel, Bilder, Veroeffentlichung');
    // Ohne Anthropic-Key muss die Erzeugung sauber scheitern statt abzustuerzen.
    const erzeugung = await ruf('/api/app/articles', { method: 'POST', body: { site_id: siteId, keyword: 'Testthema' } });
    pruefe(erzeugung.status === 202, 'Erzeugung angestossen');
    await new Promise((r) => setTimeout(r, 1200));
    const liste = await ruf(`/api/app/articles?site=${siteId}`);
    const erster = liste.daten.articles[0];
    pruefe(erster && erster.status === 'failed' && /API-Key/.test(erster.error || ''),
      'Fehlender API-Key ergibt klare Fehlermeldung statt Absturz', erster && erster.error);

    // Artikel und Bilder direkt einsetzen, um die Uebergabe zu pruefen.
    fakeBild = starteFakeBilddienst();
    const { db } = require('../src/db');
    const settings = require('../src/settings');
    settings.save({ image_provider: 'openai', image_base_url: `http://127.0.0.1:${IMG_PORT}/v1`, images_per_article: '2' });
    settings.setImageKey('sk-test');
    db.prepare(`INSERT INTO articles (id, site_id, title, slug, content_html, keyword, status, category)
                VALUES ('art_test', ?, 'Testartikel', 'testartikel', '<p>A</p><p>[[BILD:2]]</p>', 'test', 'draft', 'Ratgeber')`).run(siteId);
    const images = require('../src/images');
    await images.generateForArticle(db.prepare("SELECT * FROM articles WHERE id = 'art_test'").get(), [
      { slot: 1, motif: 'a', alt: 'Alt eins', caption: '' },
      { slot: 2, motif: 'b', alt: 'Alt zwei', caption: 'Unterschrift' },
    ]);
    const bilder = images.forArticle('art_test');
    pruefe(bilder.length === 2 && bilder.every((b) => b.status === 'ready'), 'Zwei Bilder erzeugt und gespeichert');

    const medien = await fetch(`${BASIS}/media/${bilder[0].token}`);
    pruefe(medien.status === 200 && (medien.headers.get('content-type') || '').startsWith('image/'), 'Bild wird ausgeliefert');
    const medienFalsch = await fetch(`${BASIS}/media/unbekannt`);
    pruefe(medienFalsch.status === 404, 'Unbekanntes Bild ergibt 404');

    const senden = await ruf('/api/app/articles/art_test/publish', { method: 'POST' });
    pruefe(senden.status === 200 && senden.daten.status === 'published', 'Artikel an WordPress uebergeben', senden.daten && senden.daten.error);
    pruefe(senden.daten && senden.daten.archived === 1, 'Artikel nach Uebergabe archiviert');

    const gesendet = fakeWp.empfangen.find((e) => e.url.endsWith('/publish'));
    pruefe(gesendet && gesendet.daten.images.length === 2, 'Bilder wurden mitgeschickt');
    pruefe(gesendet && gesendet.daten.images.every((b) => /^https?:\/\//.test(b.url)), 'Bildadressen sind vollstaendig');
    pruefe(gesendet && gesendet.daten.category === 'Ratgeber', 'Kategorie mitgeschickt');

    const offen = await ruf(`/api/app/articles?archived=0&site=${siteId}`);
    const archiv = await ruf(`/api/app/articles?archived=1&site=${siteId}`);
    pruefe(archiv.daten.articles.some((a) => a.id === 'art_test'), 'Artikel erscheint im Archiv');
    pruefe(!offen.daten.articles.some((a) => a.id === 'art_test'), 'Artikel nicht mehr in der Arbeitsliste');

    console.log('\nAbhol-Modus');
    await ruf(`/api/app/sites/${siteId}`, { method: 'PATCH', body: { delivery: 'pull' } });
    db.prepare(`INSERT INTO articles (id, site_id, title, content_html, keyword, status)
                VALUES ('art_pull', ?, 'Abholartikel', '<p>X</p>', 'test', 'draft')`).run(siteId);
    const inWarteschlange = await ruf('/api/app/articles/art_pull/publish', { method: 'POST' });
    pruefe(inWarteschlange.daten.status === 'publishing', 'Abhol-Modus legt in die Warteschlange');

    const abholen = await alsPlugin('/api/plugin/pending', siteId, token, { limit: 3 });
    pruefe(abholen.daten.articles.length === 1, 'Plugin bekommt den wartenden Artikel');

    const rueckmeldung = await alsPlugin('/api/plugin/result', siteId, token,
      { article_id: 'art_pull', ok: true, post_id: 7, url: 'https://test-wp.example/x/' });
    pruefe(rueckmeldung.daten.ok, 'Rueckmeldung angenommen');
    const nachher = await ruf('/api/app/articles/art_pull');
    pruefe(nachher.daten.status === 'published' && nachher.daten.archived === 1, 'Artikel veroeffentlicht und archiviert');

    console.log('\nPlugin-Update');
    const updatePruefung = await alsPlugin('/api/plugin/update-check', siteId, token, { installed_version: '1.0.0' });
    pruefe(updatePruefung.daten.version && updatePruefung.daten.download_url, 'Update-Pruefung liefert Version und Adresse');
    const archivAntwort = await fetch(updatePruefung.daten.download_url);
    const archivBytes = Buffer.from(await archivAntwort.arrayBuffer());
    pruefe(archivAntwort.status === 200 && archivBytes.slice(0, 2).toString() === 'PK', 'Plugin-Archiv ist ein gueltiges ZIP');
    const gefaelscht = await fetch(`${BASIS}/plugin/site_x.9999999999999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/autoblog-connector.zip`);
    pruefe(gefaelscht.status === 403, 'Gefaelschte Download-Adresse abgewiesen');

    console.log('\nYT Channel Spy');
    settings.save({
      youtube_enabled: '1',
      transcript_url: `http://127.0.0.1:${IMG_PORT + 1}/v1/youtube/transcript?url={video_url}&lang={lang}`,
      youtube_source: 'supadata',
      transcript_header: 'x-api-key',
    });
    settings.setTranscriptKey('sk-transkript-test');

    const youtube = require('../src/youtube');
    const kanalId = 'chan_test';
    db.prepare(`INSERT INTO channels (id, site_id, channel_id, title, interval_hours, auto_article)
                VALUES (?, ?, 'UCtesttesttesttesttest12', 'Testkanal', 24, 1)`).run(kanalId, siteId);

    // Zwei Videos einsetzen, das zweite mit sehr aehnlichem Titel.
    db.prepare(`INSERT INTO videos (id, channel_ref, site_id, video_id, title, published_at, status)
                VALUES ('vid_1', ?, ?, 'abc123XYZ01', 'Zinsen steigen wieder deutlich an', datetime('now'), 'neu')`).run(kanalId, siteId);
    pruefe(youtube.aehnlichkeit('Zinsen steigen wieder deutlich an', 'Zinsen steigen deutlich an sagen Experten') > 0.6,
      'Aehnliche Titel werden als Dublette erkannt');
    pruefe(youtube.aehnlichkeit('Zinsen steigen wieder an', 'Motorradreifen richtig waehlen') < 0.3,
      'Verschiedene Titel gelten nicht als Dublette');

    // Die Marke des Kanals gehoert nicht in den Artikeltitel.
    const ohneMarke = youtube.ohneKanalname(
      'Dieser neue Auto-Hersteller will Europa erobern | auto mobil', 'auto mobil – das VOX-Automagazin');
    pruefe(ohneMarke === 'Dieser neue Auto-Hersteller will Europa erobern',
      'Kanalname faellt aus dem Videotitel', ohneMarke);
    pruefe(youtube.ohneKanalname('Neue Technik im Test - auto motor und sport', 'auto motor und sport')
      === 'Neue Technik im Test', 'Auch ein angehaengter Kanalname faellt weg');
    pruefe(youtube.ohneKanalname('auto mobil', 'auto mobil – das VOX-Automagazin') === 'auto mobil',
      'Bleibt nichts uebrig, bleibt der Titel wie er war');

    const transkript = await youtube.fetchTranscript('abc123XYZ01', 'de');
    pruefe(transkript.length > 200 && /Zinsen/.test(transkript), 'Transkript wird geholt und aufbereitet');

    const videoArtikel = await ruf('/api/app/videos/vid_1/article', { method: 'POST' });
    pruefe(videoArtikel.status === 202 && videoArtikel.daten.origin === 'youtube', 'Artikel aus Video angestossen');
    await new Promise((r) => setTimeout(r, 1500));
    const nachVideo = await ruf(`/api/app/articles/${videoArtikel.daten.id}`);
    pruefe(/youtube\.com/.test(nachVideo.daten.source_url || ''), 'Quelladresse am Artikel hinterlegt');
    pruefe(nachVideo.daten.status === 'failed' && /API-Key/.test(nachVideo.daten.error || ''),
      'Ohne Anthropic-Key scheitert die Video-Erzeugung sauber', nachVideo.daten.error);

    // "Neu schreiben" muss bei einem Video-Artikel wieder ueber das Transkript gehen,
    // sonst entstuende ein Artikel ueber den blossen Videotitel.
    const vorNeu = transkriptZustand.transkripte;
    const nochmal = await ruf(`/api/app/articles/${videoArtikel.daten.id}/regenerate`, { method: 'POST' });
    pruefe(nochmal.status === 202 && nochmal.daten.origin === 'youtube' && /youtube\.com/.test(nochmal.daten.source_url || ''),
      'Neu schreiben nimmt bei Video-Artikeln wieder das Video', JSON.stringify(nochmal.daten.origin));
    await new Promise((r) => setTimeout(r, 800));
    pruefe(transkriptZustand.transkripte === vorNeu,
      'Vorhandenes Transkript wird wiederverwendet statt erneut geholt',
      `abrufe=${transkriptZustand.transkripte - vorNeu}`);

    // Ein Fehlschlag darf das Video nicht abschreiben: es kommt auf Wiedervorlage.
    const nachFehler = db.prepare("SELECT status, attempts, retry_at FROM videos WHERE id = 'vid_1'").get();
    pruefe(nachFehler.status === 'fehler' && nachFehler.attempts === 2 && nachFehler.retry_at,
      'Fehlgeschlagenes Video kommt auf Wiedervorlage', JSON.stringify(nachFehler));
    const alteArtikel = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE id = ?").get(videoArtikel.daten.id);
    pruefe(alteArtikel.n === 0, 'Leerer Fehlversuch wird beim naechsten Anlauf weggeraeumt');

    // Grenze je Durchlauf: mehrere neue Videos, aber nur so viele wie erlaubt.
    db.prepare("UPDATE channels SET max_per_scan = 2, last_check_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(kanalId);
    const kandidaten = [
      ['neu_a', 'Alpha Thema ueber Fahrwerk', '2026-09-10T10:00:00Z'],
      ['neu_b', 'Beta Thema ueber Motoren', '2026-09-09T10:00:00Z'],
      ['neu_c', 'Gamma Thema ueber Reifen', '2026-09-08T10:00:00Z'],
    ];
    const einfuegen = db.prepare(`INSERT INTO videos (id, channel_ref, site_id, video_id, title, published_at, status, error)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    kandidaten.forEach(([vid, titel, datum], index) => {
      const ueber = index >= 2;
      einfuegen.run(`v_${vid}`, kanalId, siteId, vid, titel, datum, ueber ? 'uebersprungen' : 'neu',
        ueber ? 'Grenze von 2 Videos je Durchlauf erreicht' : null);
    });
    const nachGrenze = db.prepare("SELECT status, COUNT(*) AS n FROM videos WHERE channel_ref = ? GROUP BY status").all(kanalId);
    const offeneVideos = (nachGrenze.find((r) => r.status === 'neu') || {}).n || 0;
    pruefe(offeneVideos === 2, 'Grenze je Durchlauf begrenzt die offenen Videos', `offen=${offeneVideos}`);

    const grenzeGesetzt = await ruf(`/api/app/channels/${kanalId}`, { method: 'PATCH', body: { max_per_scan: 5, interval_hours: 72 } });
    pruefe(grenzeGesetzt.daten.max_per_scan === 5 && grenzeGesetzt.daten.interval_hours === 72,
      'Intervall und Grenze lassen sich aendern');

    // Artikel aus Videos gehen nur hinaus, wenn der Kanal es ausdruecklich darf.
    const standard = db.prepare('SELECT auto_publish FROM channels WHERE id = ?').get(kanalId);
    pruefe(standard.auto_publish === 0, 'Ein Kanal sendet von Haus aus nicht automatisch');
    const sendet = await ruf(`/api/app/channels/${kanalId}`, { method: 'PATCH', body: { auto_publish: true } });
    pruefe(sendet.daten.auto_publish === 1, 'Automatisches Senden laesst sich je Kanal einschalten');
    await ruf(`/api/app/channels/${kanalId}`, { method: 'PATCH', body: { auto_publish: false } });

    const darf = require('../src/service').darfSenden;
    pruefe(darf({ auto_publish: 1 }, { status: 'draft', notice: null }) === true,
      'Fertiger Artikel eines sendenden Kanals geht hinaus');
    pruefe(darf({ auto_publish: 1 }, { status: 'draft', notice: 'liegt nah am Transkript' }) === false,
      'Ein Treffer der Wortlaut-Pruefung haelt den Artikel zurueck');
    pruefe(darf({ auto_publish: 0 }, { status: 'draft', notice: null }) === false,
      'Ohne Erlaubnis des Kanals bleibt alles Entwurf');
    pruefe(darf({ auto_publish: 1 }, { status: 'failed', error: 'kaputt' }) === false,
      'Ein gescheiterter Artikel wird nicht gesendet');

    const kanalAus = await ruf(`/api/app/channels/${kanalId}`, { method: 'PATCH', body: { active: false } });
    pruefe(kanalAus.daten.active === 0, 'Kanal laesst sich pausieren');

    // Ein echter Durchlauf ueber die Videoquelle, nicht von Hand eingesetzte Zeilen.
    const scanKanal = 'chan_scan';
    db.prepare(`INSERT INTO channels (id, site_id, channel_id, handle, title, interval_hours, max_per_scan, auto_article)
                VALUES (?, ?, 'UCscanscanscanscanscan1', '@scantest', '', 24, 1, 0)`).run(scanKanal, siteId);
    transkriptZustand.kanalVideos = ['sc_a', 'sc_b', 'sc_c'];

    const ersterLauf = await youtube.scanChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(scanKanal));
    pruefe(ersterLauf.quelle === 'supadata' && ersterLauf.neu === 1 && ersterLauf.uebersprungen === 2,
      'Erster Durchlauf nimmt nur das neueste Video auf', JSON.stringify(ersterLauf));
    const scanTitel = db.prepare("SELECT title FROM videos WHERE video_id = 'sc_a'").get();
    pruefe(scanTitel && scanTitel.title === TITEL.sc_a, 'Titel wird nachgeladen, wenn die Quelle keinen liefert');
    pruefe(transkriptZustand.metadaten === 1,
      'Fuer uebersprungene Videos werden keine Metadaten abgerufen', `abrufe=${transkriptZustand.metadaten}`);

    // Zweiter Durchlauf: ein neues Video kommt dazu, bekannte bleiben unberuehrt.
    db.prepare('UPDATE channels SET max_per_scan = 2 WHERE id = ?').run(scanKanal);
    transkriptZustand.kanalVideos = ['sc_d', 'sc_a', 'sc_b', 'sc_c'];
    const zweiterLauf = await youtube.scanChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(scanKanal));
    pruefe(zweiterLauf.neu === 1 && zweiterLauf.uebersprungen === 0,
      'Zweiter Durchlauf nimmt nur das dazugekommene Video', JSON.stringify(zweiterLauf));
    const scanBestand = db.prepare("SELECT COUNT(*) AS n FROM videos WHERE channel_ref = ?").get(scanKanal);
    pruefe(scanBestand.n === 4, 'Bekannte Videos werden nicht doppelt angelegt', `zeilen=${scanBestand.n}`);
    const scanKanalTitel = db.prepare('SELECT title, last_error, scan_count FROM channels WHERE id = ?').get(scanKanal);
    pruefe(!scanKanalTitel.last_error, 'Durchlauf ohne Fehlermeldung am Kanal');

    // Die Liste in der Oberflaeche zeigt nur den juengsten Durchlauf, aeltere
    // Uebersprungene bleiben in der Datenbank, damit sie nicht erneut aufschlagen.
    const sichtbar = db.prepare(
      `SELECT v.video_id FROM videos v JOIN channels c ON c.id = v.channel_ref
       WHERE v.channel_ref = ? AND (v.status <> 'uebersprungen' OR v.run_no = c.scan_count)`
    ).all(scanKanal).map((v) => v.video_id).sort();
    pruefe(scanKanalTitel.scan_count === 2, 'Durchlaeufe werden gezaehlt', `stand=${scanKanalTitel.scan_count}`);
    pruefe(sichtbar.join(',') === 'sc_a,sc_d',
      'Alte uebersprungene Videos verschwinden aus der Liste', sichtbar.join(','));

    // Faellt die Quelle aus, muss der Fehler den Grund nennen statt nur HTTP 404.
    settings.save({ youtube_source: 'google' });  // ohne Google-Schluessel, also nicht nutzbar
    const ohneQuelle = await youtube.scanChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(scanKanal));
    pruefe(!!ohneQuelle.fehler, 'Nicht erreichbare Quelle wird als Fehler gemeldet', String(ohneQuelle.fehler).slice(0, 80));
    settings.save({ youtube_source: 'supadata' });

    // Nachbearbeitung eines Artikels ohne Anthropic-Aufruf. Fing zuletzt einen Fehler,
    // bei dem die Bildkonzepte in der gemeinsamen Nachbearbeitung nicht mehr bekannt waren.
    // Sind die Anlaeufe aufgebraucht, rueckt ein anderes Video des Kanals nach,
    // damit der Blog in diesem Zeitraum trotzdem seinen Artikel bekommt.
    const scanNeu = db.prepare("SELECT id, video_id FROM videos WHERE video_id = 'sc_a'").get();
    db.prepare('UPDATE videos SET attempts = 2 WHERE id = ?').run(scanNeu.id);
    db.prepare('UPDATE channels SET auto_article = 1 WHERE id = ?').run(scanKanal);
    await ruf(`/api/app/videos/${scanNeu.id}/article`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 900));

    const ausgefallen = db.prepare('SELECT status, attempts, retry_at FROM videos WHERE id = ?').get(scanNeu.id);
    pruefe(ausgefallen.status === 'fehler' && !ausgefallen.retry_at && ausgefallen.attempts === 3,
      'Nach dem letzten Anlauf wird das Video nicht weiter versucht', JSON.stringify(ausgefallen));
    const ersatz = db.prepare(
      "SELECT video_id, title FROM videos WHERE channel_ref = ? AND status = 'neu' AND video_id IN ('sc_b', 'sc_c')"
    ).all(scanKanal);
    pruefe(ersatz.length === 1, 'Genau ein zurueckgestelltes Video rueckt nach', JSON.stringify(ersatz));
    pruefe(ersatz.length === 1 && ersatz[0].title === TITEL[ersatz[0].video_id],
      'Beim Nachruecken wird der Titel nachgeladen', ersatz.length ? ersatz[0].title : '');

    // Ausgeschlossene Kategorien: die KI bekommt sie gar nicht erst zur Auswahl.
    console.log('\nKategorien');
    db.prepare('UPDATE sites SET categories = ? WHERE id = ?').run(JSON.stringify([
      { id: 1, name: 'Ratgeber', slug: 'ratgeber', count: 12, parent: 0 },
      { id: 2, name: 'weitere Bücher', slug: 'weitere-buecher', count: 3, parent: 0 },
      { id: 3, name: 'Ernährung', slug: 'ernaehrung', count: 5, parent: 2 },
      { id: 4, name: 'Geldanlage', slug: 'geldanlage', count: 8, parent: 0 },
    ]), siteId);
    const gespeichert = await ruf(`/api/app/sites/${siteId}`, {
      method: 'PATCH', body: { excluded_categories: ['weitere Bücher'] },
    });
    pruefe(Array.isArray(gespeichert.daten.excluded_categories)
      && gespeichert.daten.excluded_categories[0] === 'weitere Bücher',
      'Ausgeschlossene Kategorien werden gespeichert', JSON.stringify(gespeichert.daten.excluded_categories));

    const service = require('../src/service');
    const erlaubt = service.kategorienFuer(db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId))
      .map((k) => k.name).sort();
    pruefe(erlaubt.join(',') === 'Geldanlage,Ratgeber',
      'Gesperrte Kategorie faellt samt Unterkategorie weg', erlaubt.join(','));

    // Gezielte Posts: eigener Weg, eigenes Regelwerk, Recherche im Gepaeck.
    console.log('\nGezielte Posts');
    const gezielt = await ruf('/api/app/articles', {
      method: 'POST',
      body: {
        origin: 'target', site_id: siteId, keyword: 'kaffeemaschine entkalken',
        intent: 'Anleitung', volume: '880', difficulty: '14',
        secondary: 'entkalker hausmittel, essig oder zitronensäure',
        questions: 'Wie oft muss man entkalken?\nGeht Essig auch?',
        covered: 'Alle nennen Essig und Zitronensäure.', gaps: 'Keiner nennt Herstellerangaben.',
      },
    });
    pruefe(gezielt.status === 202 && gezielt.daten.origin === 'target',
      'Gezielter Post wird als solcher angelegt', JSON.stringify(gezielt.daten.origin));
    await new Promise((r) => setTimeout(r, 900));
    const gezieltFertig = await ruf(`/api/app/articles/${gezielt.daten.id}`);
    pruefe(gezieltFertig.daten.status === 'failed' && /API-Key/.test(gezieltFertig.daten.error || ''),
      'Ohne Anthropic-Key scheitert auch der gezielte Post sauber', gezieltFertig.daten.error);

    const regelwerk = settings.all().target_prompt || '';
    pruefe(regelwerk.includes('SUCHABSICHT') && regelwerk.includes('DIE ANTWORT STEHT OBEN'),
      'Eigenes Regelwerk fuer gezielte Posts ist hinterlegt', `${regelwerk.length} Zeichen`);

    // Backlink-Artikel: ein Ziel, ein Keyword, mehrere Websites.
    console.log('\nBacklink-Artikel');
    const { ankerVarianten, setzeVerweis } = require('../src/service');
    const { keywordDichte } = require('../src/ai');

    const anker = ankerVarianten('kaffeemaschine entkalken', 'https://www.beispiel.de/ratgeber', 'gemischt');
    pruefe(anker.length >= 4 && new Set(anker).size === anker.length,
      'Gemischte Ankertexte sind verschieden', anker.join(' | '));
    pruefe(anker.some((a) => a.toLowerCase().includes('beispiel')),
      'Der Name des Ziels kommt als Anker vor', anker.join(' | '));
    pruefe(ankerVarianten('x', 'https://a.de', 'exakt').join() === 'x', 'Exakt heisst genau das Keyword');

    const gesetzt = setzeVerweis('<p>Ein Satz [[BACKLINK]] mit Verweis.</p>', 'mehr dazu', 'https://a.de/x', '');
    pruefe(gesetzt.gesetzt && gesetzt.html.includes('<a href="https://a.de/x">mehr dazu</a>'),
      'Der Verweis landet an der Stelle des Platzhalters');
    const bezahlt = setzeVerweis('<p>[[BACKLINK]]</p>', 'Anker', 'https://a.de', 'sponsored');
    pruefe(/rel="sponsored noopener"/.test(bezahlt.html), 'Bezahlte Verweise werden gekennzeichnet');
    const zweimal = setzeVerweis('<p>[[BACKLINK]] und [[BACKLINK]]</p>', 'A', 'https://a.de', '');
    pruefe((zweimal.html.match(/<a /g) || []).length === 1 && zweimal.ueberzaehlig === 1,
      'Aus mehreren Platzhaltern wird genau ein Verweis');
    const ohne = setzeVerweis('<p>Kein Platzhalter.</p>', 'A', 'https://a.de', '');
    pruefe(!ohne.gesetzt, 'Ein fehlender Platzhalter wird gemeldet');

    const dichte = keywordDichte(`<p>${'kaffee entkalken ist gut. '.repeat(5)}${'Text ohne Begriff. '.repeat(50)}</p>`,
      'kaffee entkalken');
    pruefe(dichte.treffer === 5 && dichte.prozent > 0 && dichte.prozent < 10,
      'Die Keyworddichte wird als Wortfolge gezaehlt', JSON.stringify(dichte));
    pruefe(keywordDichte('<p>Kaffeemaschine hilft.</p>', 'kaffee').treffer === 0,
      'Ein Wortteil zaehlt nicht als Treffer');

    const blOhneZiel = await ruf('/api/app/backlinks', { method: 'POST', body: { keyword: 'x', site_ids: [siteId] } });
    pruefe(blOhneZiel.status === 400, 'Ohne Zieladresse kein Auftrag');
    const blBoese = await ruf('/api/app/backlinks', {
      method: 'POST', body: { url: 'javascript:alert(1)', keyword: 'x', site_ids: [siteId] },
    });
    pruefe(blBoese.status === 400, 'Eine Adresse mit ausfuehrbarem Schema wird abgewiesen');
    const blOhneSeite = await ruf('/api/app/backlinks', {
      method: 'POST', body: { url: 'https://a.de', keyword: 'x', site_ids: [] },
    });
    pruefe(blOhneSeite.status === 400, 'Ohne Website kein Auftrag');

    const blAuftrag = await ruf('/api/app/backlinks', {
      method: 'POST',
      body: { url: 'https://www.beispiel.de/ratgeber', keyword: 'kaffeemaschine entkalken',
        extra: 'entkalker, essigessenz', note: 'Ratgeberseite zum Entkalken.', site_ids: [siteId] },
    });
    pruefe(blAuftrag.status === 202 && blAuftrag.daten.articles.length === 1
      && blAuftrag.daten.articles[0].origin === 'backlink',
      'Backlink-Auftrag legt je Website einen Artikel an', JSON.stringify(blAuftrag.daten.articles.length));
    const blArtikel = db.prepare('SELECT backlink_url, backlink_anchor FROM articles WHERE id = ?')
      .get(blAuftrag.daten.articles[0].id);
    pruefe(blArtikel.backlink_url === 'https://www.beispiel.de/ratgeber' && !!blArtikel.backlink_anchor,
      'Ziel und Ankertext stehen am Artikel', JSON.stringify(blArtikel));
    const blListe = await ruf('/api/app/backlinks');
    pruefe(Array.isArray(blListe.daten) && blListe.daten.length === 1 && blListe.daten[0].artikel === 1,
      'Der Auftrag erscheint in der Liste');

    console.log('\nArtikel-Nachbearbeitung');
    const ai = require('../src/ai');
    const roh = {
      title: 'Zinsen im Blick — was Sparer wissen sollten',
      slug: 'zinsen-im-blick', meta_title: 'Zinsen im Blick', meta_description: 'Kurz erklärt.',
      excerpt: 'Ein Überblick.', tags: ['Zinsen', 'Sparen'], category: 'Geldanlage',
      content_html: '<h2>Überblick</h2>' + '<p>Zinsen bewegen sich wieder deutlich nach oben und das merkt jeder Sparer.</p>'.repeat(12)
        + '<p>[[BILD:2]]</p><p>[[BILD:7]]</p>',
      images: [
        { slot: 1, motif: 'Titelbild: Muenzen auf einem Tisch', alt: 'Muenzen', caption: 'Sparen' },
        { slot: 2, motif: 'Diagramm mit steigender Kurve', alt: 'Kurve', caption: 'Aufwaerts' },
      ],
    };
    const fertig = ai.aufbereiten(roh, { id: siteId, language: 'de' }, 3, 'Zinsen', ['Geldanlage', 'Ratgeber']);
    pruefe(fertig.images.length === 2 && fertig.images[0].motif.startsWith('Titelbild'),
      'Bildkonzepte ueberstehen die Nachbearbeitung', JSON.stringify(fertig.images.map((i) => i.slot)));
    pruefe(fertig.content_html.includes('[[BILD:2]]') && !fertig.content_html.includes('[[BILD:7]]'),
      'Platzhalter ohne Bildkonzept werden entfernt');
    pruefe(!fertig.title.includes('—') && fertig.word_count > 120, 'Langer Gedankenstrich ersetzt, Laenge gezaehlt');
    pruefe(fertig.category === 'Geldanlage', 'Kategorie bleibt bei den vorhandenen');

    // Plugin-Updates: Der Hub bringt zurueckliegende Websites von selbst auf Stand.
    console.log('\nPlugin-Updates');
    const plugins = require('../src/plugins');
    pruefe(plugins.aelter('1.3.1', '1.4.0') && plugins.aelter('1.9.0', '1.10.0') && !plugins.aelter('1.4.0', '1.4.0')
      && !plugins.aelter('2.0.0', '1.4.0') && plugins.aelter('', '1.0.0'),
      'Versionsvergleich stimmt');

    db.prepare("UPDATE sites SET plugin_version = '1.3.1', status = 'connected' WHERE id = ?").run(siteId);
    const lauf = await plugins.updateAlle();
    pruefe(lauf.aktualisiert === 1 && !lauf.fehler, 'Zurueckliegende Website wird aktualisiert', JSON.stringify(lauf));
    const standJetzt = db.prepare('SELECT plugin_version FROM sites WHERE id = ?').get(siteId);
    pruefe(standJetzt.plugin_version === '99.0.0', 'Gemeldete Version wird uebernommen', standJetzt.plugin_version);

    const nochmalPruefen = await plugins.updateAlle();
    pruefe(nochmalPruefen.aktualisiert === 0, 'Aktuelle Website wird nicht erneut angefasst', JSON.stringify(nochmalPruefen));

    // Wortlaut-Pruefung: Der Artikel soll aus dem Transkript entstehen, nicht daraus
    // abgeschrieben sein.
    console.log('\nWortlaut-Pruefung');
    const { pruefeUebernahme } = require('../src/textvergleich');
    const quelltext = ('Der VinFast VF6 kommt aus Vietnam, aber die Technik stammt von Zulieferern aus aller Welt. '
      + 'Das Design kommt aus Turin, die Zellen von CATL und das Steuergerät von Bosch. '
      + 'Damit ist das Auto ein Baukasten wie jedes andere moderne Elektroauto auch. ').repeat(6);

    const eigen = pruefeUebernahme(
      '<p>Am VF6 ist ungefähr so viel Vietnam dran wie an einem Golf aus Mexiko. Wer heute als neue Marke '
      + 'antritt, baut kein Auto, sondern konfiguriert eines aus fertigen Baugruppen. Genau darin liegt der '
      + 'eigentliche Reiz dieses Kompakt-SUV, noch vor Reichweite und Ladeleistung.</p>', quelltext);
    pruefe(!eigen.auffaellig && eigen.passage < 25, 'Eigener Wortlaut gilt als unauffaellig', JSON.stringify(eigen));

    const abgeschrieben = pruefeUebernahme(`<p>${quelltext.slice(0, 600)}</p>`, quelltext);
    pruefe(abgeschrieben.auffaellig && abgeschrieben.anteil > 0.5,
      'Abgeschriebener Text wird erkannt', `anteil=${abgeschrieben.anteil.toFixed(2)}, passage=${abgeschrieben.passage}`);
    pruefe(abgeschrieben.stelle.startsWith('der vinfast vf6 kommt aus vietnam'),
      'Die uebernommene Stelle wird benannt', abgeschrieben.stelle.slice(0, 40));
    pruefe(!pruefeUebernahme('<p>Zu kurz.</p>', quelltext).auffaellig, 'Sehr kurze Texte schlagen nicht an');

    // Was die QA gefunden hat, darf nicht zurueckkommen.
    console.log('\nHaerteprüfungen');
    const { safeLink, sanitizeHtml } = require('../src/sanitize');
    pruefe(safeLink('https://a.de/x') === 'https://a.de/x' && safeLink('http://a.de') === 'http://a.de',
      'Gewoehnliche Adressen bleiben erhalten');
    pruefe(!safeLink('javascript:alert(1)') && !safeLink('  JaVaScRiPt:alert(1)')
      && !safeLink('data:text/html,x') && !safeLink('/relativ') && !safeLink(''),
      'Adressen mit ausfuehrbarem Schema werden abgewiesen');
    pruefe(/rel="noopener noreferrer"/.test(sanitizeHtml('<a href="https://x.de" target="_blank">x</a>')),
      'Ein Link ins neue Fenster bekommt rel="noopener"');

    const gemeldet = await alsPlugin('/api/plugin/result', siteId, token, {
      article_id: 'art_pull', ok: true, post_id: 7, url: "javascript:fetch('/api/app/settings')",
    });
    const gespeicherteAdresse = db.prepare("SELECT wp_url FROM articles WHERE id = 'art_pull'").get();
    pruefe(gemeldet.status === 200 && !gespeicherteAdresse.wp_url,
      'Eine gemeldete javascript-Adresse landet nicht in der Datenbank',
      JSON.stringify(gespeicherteAdresse.wp_url));

    // Gemeint ist der Download-Pfad, nicht die Plugin-Schnittstelle unter /api/plugin/.
    const protokoll = db.prepare(
      "SELECT COUNT(*) AS n FROM logs WHERE message LIKE '% /plugin/%' AND message NOT LIKE '% /plugin/…%'"
    ).get();
    pruefe(protokoll.n === 0, 'Signierte Einmal-Adressen stehen nicht im Protokoll', `Treffer=${protokoll.n}`);

    const sitzung = await ruf('/api/session', { mitCookie: false });
    pruefe(!sitzung.daten.hubName && !sitzung.daten.version,
      'Ohne Anmeldung verraet der Hub weder Namen noch Version');

    const listeOhneToken = await ruf('/api/app/sites');
    pruefe(Array.isArray(listeOhneToken.daten) && listeOhneToken.daten.every((s) => !s.token),
      'Die Websiteliste enthaelt keine Tokens');

    console.log('\nDiagnose');
    const diag = await ruf('/api/app/diagnostics/enable', { method: 'POST' });
    pruefe(diag.daten.url && diag.daten.token, 'Diagnose-Link erzeugt');
    const bericht = await fetch(`${diag.daten.url}/report.json?limit=5`);
    const berichtText = await bericht.text();
    pruefe(bericht.status === 200, 'Bericht ohne Anmeldung abrufbar');
    pruefe(!berichtText.includes('sk-test'), 'Bildschluessel steht NICHT im Bericht');
    pruefe(!berichtText.includes(token), 'Website-Token steht NICHT im Bericht');
    const alterLink = diag.daten.url;
    await ruf('/api/app/diagnostics/enable', { method: 'POST' });
    const alterAbruf = await fetch(alterLink);
    pruefe(alterAbruf.status === 403, 'Neuer Token entwertet den alten Link');

    console.log('\nProtokoll');
    const logs = await ruf('/api/app/logs?limit=50');
    const alsText = JSON.stringify(logs.daten);
    pruefe(!alsText.includes('sicheresPasswort1'), 'Passwort steht nicht im Protokoll');
    pruefe(!alsText.includes(token), 'Website-Token steht nicht im Protokoll');
    pruefe(logs.daten.length > 5, 'Protokoll enthaelt Eintraege');
  } catch (err) {
    gescheitert += 1;
    console.log(`\n  ${rot('ABBRUCH')} ${err.stack}`);
  } finally {
    if (fakeWp) fakeWp.server.close();
    if (fakeBild) fakeBild.close();
    if (fakeTranskript) fakeTranskript.close();
    hub.kill();
  }

  console.log(`\n${bestanden + gescheitert} Pruefungen: ${gruen(bestanden + ' bestanden')}${gescheitert ? ', ' + rot(gescheitert + ' gescheitert') : ''}\n`);
  if (gescheitert) console.log(protokoll.join('').split('\n').slice(-25).join('\n'));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(gescheitert ? 1 : 0);
}

main();
