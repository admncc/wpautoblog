'use strict';
const { db } = require('./db');
const { logger, excerpt } = require('./logger');
const { randomId } = require('./util');
const settings = require('./settings');

/**
 * YouTube-Kanaele beobachten.
 *
 * Die Ueberwachung laeuft ueber den oeffentlichen RSS-Feed eines Kanals. Der braucht
 * keinen Google-Schluessel und meldet neue Videos innerhalb weniger Minuten. Ein
 * Schluessel fuer die YouTube Data API ist nur ein Rueckfallweg, falls der Feed einmal
 * nicht erreichbar ist.
 *
 * Transkripte liefert ein externer Dienst, weil YouTube dafuer keine offene
 * Schnittstelle hat. Die Adresse ist frei konfigurierbar, voreingestellt ist Supadata.
 */
const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const TIMEOUT_MS = 30000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AutoblogHub/1.0)';

class YoutubeError extends Error {}

const aktiv = () => settings.get('youtube_enabled') === '1';

// ------------------------------------------------------------------ Kanaele

/** Findet die Kanal-ID aus Adresse, @handle oder der ID selbst. */
async function resolveChannel(eingabe) {
  const roh = String(eingabe || '').trim();
  if (!roh) throw new YoutubeError('Bitte einen Kanal angeben.');

  // Schon eine Kanal-ID?
  const direkt = roh.match(/(UC[\w-]{22})/);
  if (direkt) {
    const feed = await fetchFeed(direkt[1]).catch(() => null);
    return { channel_id: direkt[1], title: (feed && feed.title) || '', handle: '' };
  }

  // Aus einer Adresse oder einem Handle die Kanalseite bauen und auslesen.
  let seite;
  const handleTreffer = roh.match(/@([A-Za-z0-9._-]+)/);
  if (/youtube\.com|youtu\.be/i.test(roh)) seite = roh.startsWith('http') ? roh : `https://${roh}`;
  else if (handleTreffer) seite = `https://www.youtube.com/@${handleTreffer[1]}`;
  else seite = `https://www.youtube.com/@${encodeURIComponent(roh.replace(/^@/, ''))}`;

  let html;
  try {
    const antwort = await fetch(seite, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!antwort.ok) throw new YoutubeError(`Kanalseite nicht erreichbar (HTTP ${antwort.status}).`);
    html = await antwort.text();
  } catch (err) {
    throw new YoutubeError(`Kanal konnte nicht geladen werden: ${err.message}`);
  }

  const id = (html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/) || [])[1];
  if (!id) throw new YoutubeError('Auf dieser Seite war keine Kanal-ID zu finden. Bitte die Adresse pruefen.');

  const titel = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '';
  return { channel_id: id, title: entzerre(titel), handle: handleTreffer ? `@${handleTreffer[1]}` : '' };
}

const entzerre = (text) =>
  String(text || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .trim();

/** Liest den oeffentlichen Feed eines Kanals. */
async function fetchFeed(channelId) {
  let antwort;
  try {
    antwort = await fetch(`${FEED_URL}${encodeURIComponent(channelId)}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new YoutubeError(`Feed nicht erreichbar: ${err.message}`);
  }
  if (!antwort.ok) throw new YoutubeError(`Feed nicht abrufbar (HTTP ${antwort.status}). Stimmt die Kanal-ID?`);

  const xml = await antwort.text();
  const titel = entzerre((xml.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  const eintraege = [];
  for (const treffer of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const teil = treffer[1];
    const videoId = (teil.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    if (!videoId) continue;
    eintraege.push({
      video_id: videoId,
      title: entzerre((teil.match(/<title>([^<]*)<\/title>/) || [])[1] || ''),
      published_at: (teil.match(/<published>([^<]+)<\/published>/) || [])[1] || null,
      description: entzerre((teil.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || '').slice(0, 1500),
    });
  }
  return { title: titel, eintraege };
}

// --------------------------------------------------------------- Transkript

/** Baut die Abrufadresse aus der Vorlage in den Einstellungen. */
function transcriptUrl(videoId, sprache) {
  const vorlage = settings.get('transcript_url') || '';
  return vorlage
    .replace(/\{video_id\}/g, encodeURIComponent(videoId))
    .replace(/\{video_url\}/g, encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`))
    .replace(/\{lang\}/g, encodeURIComponent(sprache || 'de'));
}

/** Sucht den Transkripttext in einer beliebig aufgebauten Antwort. */
function textAusAntwort(daten) {
  if (!daten) return '';
  if (typeof daten === 'string') return daten;
  for (const feld of ['content', 'text', 'transcript', 'result']) {
    const wert = daten[feld];
    if (typeof wert === 'string' && wert.trim()) return wert;
    if (Array.isArray(wert)) {
      const zusammen = wert.map((t) => (typeof t === 'string' ? t : t && (t.text || t.content) || '')).join(' ').trim();
      if (zusammen) return zusammen;
    }
  }
  if (Array.isArray(daten.segments)) {
    return daten.segments.map((s) => (s && (s.text || s.content)) || '').join(' ').trim();
  }
  return '';
}

async function holeMitSchluessel(url) {
  const kopf = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  const name = settings.get('transcript_header') || 'x-api-key';
  const schluessel = settings.getTranscriptKey();
  if (schluessel) kopf[name] = name.toLowerCase() === 'authorization' ? `Bearer ${schluessel}` : schluessel;

  const antwort = await fetch(url, { headers: kopf, signal: AbortSignal.timeout(120000) });
  const roh = await antwort.text();
  let daten = null;
  try {
    daten = JSON.parse(roh);
  } catch { /* kein JSON */ }
  return { status: antwort.status, daten, roh };
}

/**
 * Holt das Transkript eines Videos.
 * Lange Videos beantwortet der Dienst mit einer Auftragsnummer, die nachgefragt wird.
 */
async function fetchTranscript(videoId, sprache = 'de') {
  if (!settings.getTranscriptKey()) {
    throw new YoutubeError('Kein Schluessel fuer den Transkript-Dienst hinterlegt. Bitte unter Einstellungen eintragen.');
  }

  const timer = logger.start('youtube', 'transcript', `Transkript wird geholt (${videoId})`, { context: { videoId, sprache } });
  try {
    let { status, daten, roh } = await holeMitSchluessel(transcriptUrl(videoId, sprache));

    // 206 kommt bei langen Videos vor und enthaelt trotzdem ein brauchbares Transkript.
    if (status === 206) logger.debug('youtube', 'transcript', 'Teilantwort (HTTP 206), Transkript wird trotzdem verwendet', { context: { videoId } });
    if (status === 401 || status === 403) throw new YoutubeError('Der Transkript-Dienst weist den Schluessel ab.');
    if (status === 429) throw new YoutubeError('Der Transkript-Dienst ist am Limit (429). Spaeter erneut versuchen.');
    if (status >= 400 && !(daten && daten.jobId)) {
      const meldung = (daten && (daten.message || daten.error)) || `HTTP ${status}`;
      throw new YoutubeError(`Transkript nicht verfuegbar: ${meldung}`);
    }

    // Auftragsnummer: der Dienst arbeitet im Hintergrund weiter.
    const jobId = daten && (daten.jobId || daten.job_id || daten.id);
    if (jobId && !textAusAntwort(daten)) {
      const basis = (settings.get('transcript_url') || '').split('?')[0].replace(/\/[^/]*$/, '');
      for (let versuch = 0; versuch < 20; versuch += 1) {
        await new Promise((r) => setTimeout(r, 6000));
        const ergebnis = await holeMitSchluessel(`${basis}/transcript/${encodeURIComponent(jobId)}`);
        const zwischenstand = ergebnis.daten && (ergebnis.daten.status || '');
        if (textAusAntwort(ergebnis.daten)) { daten = ergebnis.daten; break; }
        if (/failed|error/i.test(String(zwischenstand))) {
          throw new YoutubeError(`Der Transkript-Auftrag ist fehlgeschlagen (${zwischenstand}).`);
        }
      }
    }

    const text = textAusAntwort(daten) || (!daten ? roh : '');
    if (!text || text.trim().length < 200) {
      throw new YoutubeError('Es kam kein brauchbares Transkript zurueck. Hat das Video Untertitel?');
    }

    const sauber = text.replace(/\s+/g, ' ').trim();
    timer.ok(`Transkript erhalten (${sauber.split(' ').length} Woerter)`, { context: { videoId, zeichen: sauber.length } });
    return sauber;
  } catch (err) {
    timer.fail(err, { context: { videoId } });
    throw err instanceof YoutubeError ? err : new YoutubeError(`Transkript fehlgeschlagen: ${err.message}`);
  }
}

// ------------------------------------------------------- Duplikaterkennung

/** Grobe Aehnlichkeit zweier Titel, 0 bis 1, ueber gemeinsame Woerter. */
function aehnlichkeit(a, b) {
  const worte = (t) =>
    new Set(
      String(t || '').toLowerCase()
        .replace(/[^a-zäöüß0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
  const A = worte(a);
  const B = worte(b);
  if (!A.size || !B.size) return 0;
  let gemeinsam = 0;
  for (const wort of A) if (B.has(wort)) gemeinsam += 1;
  return gemeinsam / Math.min(A.size, B.size);
}

/**
 * Berichten mehrere Kanaele ueber dasselbe, soll daraus nur ein Artikel entstehen.
 * Verglichen wird mit den Videos derselben Website aus den letzten Tagen.
 */
function findeDublette(siteId, titel, tage = 3, schwelle = 0.6) {
  const zeitraum = db
    .prepare(
      `SELECT video_id, title, article_id FROM videos
       WHERE site_id = ? AND created_at >= datetime('now', ?) AND status IN ('artikel', 'transkribiert')`
    )
    .all(siteId, `-${tage} days`);

  for (const vorhanden of zeitraum) {
    if (aehnlichkeit(titel, vorhanden.title) >= schwelle) return vorhanden;
  }
  return null;
}

// -------------------------------------------------------------- Durchlaeufe

const naechsterTermin = (stunden) =>
  new Date(Date.now() + Math.max(1, Number(stunden) || 24) * 3600 * 1000).toISOString();

/** Prueft einen Kanal auf neue Videos und legt sie an. */
async function scanChannel(channel) {
  const timer = logger.start('youtube', 'scan', `Kanal wird geprueft: ${channel.title || channel.channel_id}`, {
    siteId: channel.site_id,
    context: { channel_id: channel.channel_id },
  });

  try {
    const feed = await fetchFeed(channel.channel_id);
    const bekannt = db.prepare('SELECT video_id FROM videos WHERE channel_ref = ?').all(channel.id).map((v) => v.video_id);
    const einfuegen = db.prepare(
      `INSERT OR IGNORE INTO videos (id, channel_ref, site_id, video_id, title, description, published_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Beim ersten Lauf nur das neueste Video aufnehmen, sonst kaeme das ganze Archiv.
    const ersterLauf = !channel.last_check_at;
    const kandidaten = ersterLauf ? feed.eintraege.slice(0, 1) : feed.eintraege;

    let neu = 0;
    let uebersprungen = 0;
    for (const eintrag of kandidaten) {
      if (bekannt.includes(eintrag.video_id)) continue;

      const dublette = findeDublette(channel.site_id, eintrag.title);
      const status = dublette ? 'uebersprungen' : 'neu';
      if (dublette) uebersprungen += 1;
      else neu += 1;

      einfuegen.run(
        randomId('vid'), channel.id, channel.site_id, eintrag.video_id,
        eintrag.title, eintrag.description, eintrag.published_at, status
      );
      if (dublette) {
        db.prepare('UPDATE videos SET error = ? WHERE video_id = ?')
          .run(`Aehnliches Video wurde bereits verarbeitet: "${dublette.title}"`, eintrag.video_id);
      }
    }

    db.prepare(
      `UPDATE channels SET last_check_at = datetime('now'), next_check_at = ?, last_error = NULL,
        title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?`
    ).run(naechsterTermin(channel.interval_hours), feed.title || '', channel.id);

    timer.ok(`${neu} neue Videos${uebersprungen ? `, ${uebersprungen} als Dublette uebersprungen` : ''}`, {
      siteId: channel.site_id,
      context: { neu, uebersprungen, im_feed: feed.eintraege.length, erster_lauf: ersterLauf },
    });
    return { neu, uebersprungen };
  } catch (err) {
    db.prepare("UPDATE channels SET last_check_at = datetime('now'), next_check_at = ?, last_error = ? WHERE id = ?")
      .run(naechsterTermin(channel.interval_hours), String(err.message || err).slice(0, 400), channel.id);
    timer.fail(err, { siteId: channel.site_id });
    return { neu: 0, uebersprungen: 0, fehler: String(err.message || err) };
  }
}

/** Alle faelligen Kanaele pruefen. Wird vom Zeitplan aufgerufen. */
async function runScan() {
  if (!aktiv()) return { kanaele: 0, neu: 0 };

  const faellig = db
    .prepare("SELECT * FROM channels WHERE active = 1 AND (next_check_at IS NULL OR next_check_at <= datetime('now'))")
    .all();
  if (!faellig.length) return { kanaele: 0, neu: 0 };

  let neu = 0;
  for (const kanal of faellig) {
    const ergebnis = await scanChannel(kanal);
    neu += ergebnis.neu || 0;
  }
  return { kanaele: faellig.length, neu };
}

const offeneVideos = (limit = 5) =>
  db.prepare("SELECT * FROM videos WHERE status = 'neu' ORDER BY published_at ASC LIMIT ?").all(limit);

// Bewusst kein YouTube-Thumbnail: Das ist fremdes Bildmaterial. Videoartikel
// bekommen eigene Bilder wie jeder andere Artikel auch.
const videoUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

module.exports = {
  YoutubeError, aktiv, resolveChannel, fetchFeed, fetchTranscript,
  scanChannel, runScan, offeneVideos, findeDublette, aehnlichkeit,
  videoUrl,
};
