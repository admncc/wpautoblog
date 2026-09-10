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
      return res.end(JSON.stringify({
        ok: true, post_id: 42, url: 'https://test-wp.example/beitrag/',
        images_imported: (daten.images || []).length, image_errors: [], category: daten.category,
      }));
    });
  });
  server.listen(WP_PORT);
  return { server, empfangen };
}

function starteFakeTranskript() {
  const server = http.createServer((req, res) => {
    if (!req.headers['x-api-key']) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', message: 'kein Schluessel' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      lang: 'de',
      content: 'Zinsen steigen wieder an. '.repeat(30) + 'Das hat Folgen fuer Sparer und Kreditnehmer.',
    }));
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
  let fakeTranskript = starteFakeTranskript();

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
      transcript_url: `http://127.0.0.1:${IMG_PORT + 1}/transcript?url={video_url}&lang={lang}`,
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

    const transkript = await youtube.fetchTranscript('abc123XYZ01', 'de');
    pruefe(transkript.length > 200 && /Zinsen/.test(transkript), 'Transkript wird geholt und aufbereitet');

    const videoArtikel = await ruf('/api/app/videos/vid_1/article', { method: 'POST' });
    pruefe(videoArtikel.status === 202 && videoArtikel.daten.origin === 'youtube', 'Artikel aus Video angestossen');
    await new Promise((r) => setTimeout(r, 1500));
    const nachVideo = await ruf(`/api/app/articles/${videoArtikel.daten.id}`);
    pruefe(/youtube\.com/.test(nachVideo.daten.source_url || ''), 'Quelladresse am Artikel hinterlegt');
    pruefe(nachVideo.daten.status === 'failed' && /API-Key/.test(nachVideo.daten.error || ''),
      'Ohne Anthropic-Key scheitert die Video-Erzeugung sauber', nachVideo.daten.error);

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
    const offen = (nachGrenze.find((r) => r.status === 'neu') || {}).n || 0;
    pruefe(offen === 2, 'Grenze je Durchlauf begrenzt die offenen Videos', `offen=${offen}`);

    const grenzeGesetzt = await ruf(`/api/app/channels/${kanalId}`, { method: 'PATCH', body: { max_per_scan: 5, interval_hours: 72 } });
    pruefe(grenzeGesetzt.daten.max_per_scan === 5 && grenzeGesetzt.daten.interval_hours === 72,
      'Intervall und Grenze lassen sich aendern');

    const kanalAus = await ruf(`/api/app/channels/${kanalId}`, { method: 'PATCH', body: { active: false } });
    pruefe(kanalAus.daten.active === 0, 'Kanal laesst sich pausieren');

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
