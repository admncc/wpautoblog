'use strict';
const { db } = require('./db');
const { logger, excerpt } = require('./logger');
const { randomId } = require('./util');
const settings = require('./settings');

/**
 * YouTube-Kanaele beobachten.
 *
 * Welche Videos ein Kanal neu hat, laesst sich auf mehreren Wegen erfahren. Keiner
 * davon ist ueberall verfuegbar: Den oeffentlichen RSS-Feed beantwortet YouTube von
 * Rechenzentrums-Adressen aus mit 404, die Data API braucht einen Google-Schluessel.
 * Deshalb werden die Wege der Reihe nach probiert, bis einer antwortet:
 *
 *   1. RSS-Feed        kein Schluessel, liefert Titel und Datum gleich mit
 *   2. Supadata        derselbe Schluessel wie fuers Transkript, laeuft auch vom Server
 *   3. YouTube Data    nur wenn ein Google-Schluessel hinterlegt ist
 *   4. Kanalseite      letzter Ausweg, liest die Seite selbst aus
 *
 * Welcher Weg genommen wurde, steht im Log. Ueber die Einstellung youtube_source
 * laesst sich ein Weg fest vorgeben, sonst gilt die Reihenfolge oben.
 *
 * Transkripte liefert ein externer Dienst, weil YouTube dafuer keine offene
 * Schnittstelle hat. Die Adresse ist frei konfigurierbar, voreingestellt ist Supadata.
 */
const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const TIMEOUT_MS = 30000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AutoblogHub/1.0)';
// Wie viele Videos eine Quelle je Kanal meldet. Mehr braucht es nicht: gesucht wird
// nur, was seit dem letzten Durchlauf dazugekommen ist.
const LISTEN_LIMIT = 25;

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
    // Titel ist Beiwerk: Faellt der Feed aus, traegt ihn der erste Durchlauf nach.
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

// ------------------------------------------------------- Videos eines Kanals

/** Basisadresse des Transkript-Dienstes, abgeleitet aus der eingestellten Abrufadresse. */
function supadataBasis() {
  const vorlage = settings.get('transcript_url') || '';
  const treffer = vorlage.match(/^(https?:\/\/[^\s?]*?)\/youtube\//i);
  return treffer ? treffer[1] : 'https://api.supadata.ai/v1';
}

/** Ruft eine Supadata-Adresse mit dem hinterlegten Schluessel ab. */
async function supadata(pfad, parameter) {
  if (!settings.getTranscriptKey()) throw new YoutubeError('Kein Supadata-Schluessel hinterlegt.');
  const suche = new URLSearchParams(parameter).toString();
  const { status, daten } = await holeMitSchluessel(`${supadataBasis()}${pfad}?${suche}`);
  if (status === 401 || status === 403) throw new YoutubeError('Supadata weist den Schluessel ab.');
  if (status === 429) throw new YoutubeError('Supadata ist am Limit (429). Spaeter erneut versuchen.');
  if (status >= 400 || !daten) {
    throw new YoutubeError((daten && (daten.message || daten.error)) || `Supadata antwortete mit HTTP ${status}.`);
  }
  return daten;
}

/** Weg 1: der oeffentliche Feed. Liefert Titel, Datum und Beschreibung mit. */
async function quelleFeed(channel) {
  const feed = await fetchFeed(channel.channel_id);
  if (!feed.eintraege.length) throw new YoutubeError('Der Feed enthielt keine Videos.');
  return { title: feed.title, eintraege: feed.eintraege };
}

/** Weg 2: Supadata. Liefert nur Video-Kennungen, Titel werden bei Bedarf nachgeladen. */
async function quelleSupadata(channel) {
  const kennung = channel.handle || channel.channel_id;
  const daten = await supadata('/youtube/channel/videos', { id: kennung, type: 'video', limit: LISTEN_LIMIT });
  const ids = Array.isArray(daten.videoIds) ? daten.videoIds : [];
  if (!ids.length) throw new YoutubeError('Supadata meldete keine Videos fuer diesen Kanal.');
  // Die Liste kommt neueste zuerst, das erhaelt die Reihenfolge ohne Datum.
  return { title: '', eintraege: ids.map((id) => ({ video_id: id, title: '', published_at: null, description: '' })) };
}

/** Weg 3: die offizielle Data API, falls ein Google-Schluessel hinterlegt ist. */
async function quelleGoogle(channel) {
  const schluessel = settings.getYoutubeKey();
  if (!schluessel) throw new YoutubeError('Kein Google-Schluessel hinterlegt.');
  // Jeder Kanal hat eine Wiedergabeliste mit allen Uploads, ihre Kennung beginnt mit UU.
  const liste = `UU${channel.channel_id.slice(2)}`;
  const adresse = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${LISTEN_LIMIT}`
    + `&playlistId=${encodeURIComponent(liste)}&key=${encodeURIComponent(schluessel)}`;
  const antwort = await fetch(adresse, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const daten = await antwort.json().catch(() => null);
  if (!antwort.ok || !daten) {
    const meldung = (daten && daten.error && daten.error.message) || `HTTP ${antwort.status}`;
    throw new YoutubeError(`YouTube Data API: ${meldung}`);
  }
  const eintraege = (daten.items || [])
    .map((eintrag) => eintrag.snippet || {})
    .filter((s) => s.resourceId && s.resourceId.videoId)
    .map((s) => ({
      video_id: s.resourceId.videoId,
      title: entzerre(s.title || ''),
      published_at: s.publishedAt || null,
      description: String(s.description || '').slice(0, 1500),
    }));
  if (!eintraege.length) throw new YoutubeError('Die Data API meldete keine Videos.');
  return { title: entzerre((daten.items && daten.items[0] && daten.items[0].snippet.channelTitle) || ''), eintraege };
}

/** Text aus einem JSON-Schnipsel der Kanalseite lesen, ohne an Sonderzeichen zu scheitern. */
function jsonText(roh) {
  try {
    return entzerre(JSON.parse(`"${roh}"`));
  } catch {
    return entzerre(roh);
  }
}

/** Weg 4: die Kanalseite selbst auslesen. Kommt ohne jeden Schluessel aus. */
async function quelleSeite(channel) {
  const adresse = channel.handle
    ? `https://www.youtube.com/${channel.handle}/videos`
    : `https://www.youtube.com/channel/${encodeURIComponent(channel.channel_id)}/videos`;
  const antwort = await fetch(adresse, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'de,en;q=0.8',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!antwort.ok) throw new YoutubeError(`Kanalseite nicht abrufbar (HTTP ${antwort.status}).`);
  const html = await antwort.text();

  // YouTube hat den Aufbau der Seite schon mehrfach geaendert. Deshalb werden beide
  // bekannten Bausteine gelesen: der heutige "lockupViewModel" und der aeltere
  // "videoRenderer". Ein Datum steht dort nur als "vor 4 Tagen", das laesst sich nicht
  // sinnvoll umrechnen, die Reihenfolge der Seite ist ohnehin neueste zuerst.
  const gesehen = new Set();
  const eintraege = [];
  const merke = (id, titel) => {
    if (!id || gesehen.has(id)) return;
    gesehen.add(id);
    eintraege.push({ video_id: id, title: jsonText(titel || ''), published_at: null, description: '' });
  };

  for (const block of html.split('"lockupViewModel":').slice(1)) {
    // Ein Baustein ist rund 13.000 Zeichen lang, die Kennung steht weit hinten darin.
    const kopf = block.slice(0, 30000);
    const id = (kopf.match(/"contentId":"([\w-]{11})"/) || [])[1];
    const titel = (kopf.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/) || [])[1];
    merke(id, titel);
  }
  for (const treffer of html.matchAll(/"videoRenderer":\{"videoId":"([\w-]{11})"([\s\S]{0,1200}?)"navigationEndpoint"/g)) {
    merke(treffer[1], (treffer[2].match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/) || [])[1]);
  }

  if (!eintraege.length) throw new YoutubeError('Auf der Kanalseite waren keine Videos zu finden.');
  const kanaltitel = jsonText((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '');
  return { title: kanaltitel, eintraege: eintraege.slice(0, LISTEN_LIMIT) };
}

const QUELLEN = [
  { name: 'feed', beschreibung: 'RSS-Feed', laden: quelleFeed },
  { name: 'supadata', beschreibung: 'Supadata', laden: quelleSupadata },
  { name: 'google', beschreibung: 'YouTube Data API', laden: quelleGoogle },
  { name: 'seite', beschreibung: 'Kanalseite', laden: quelleSeite },
];

/**
 * Holt die Videoliste eines Kanals ueber den ersten Weg, der antwortet.
 * Scheitern alle, fasst der Fehler zusammen, woran es jeweils lag.
 */
async function listVideos(channel) {
  const wunsch = settings.get('youtube_source') || 'auto';
  const wege = wunsch === 'auto' ? QUELLEN : QUELLEN.filter((q) => q.name === wunsch);
  if (!wege.length) throw new YoutubeError(`Unbekannte Videoquelle: ${wunsch}`);

  const fehler = [];
  for (const weg of wege) {
    try {
      const ergebnis = await weg.laden(channel);
      logger.debug('youtube', 'quelle', `Videoliste ueber ${weg.beschreibung}`, {
        siteId: channel.site_id,
        context: { quelle: weg.name, videos: ergebnis.eintraege.length, channel_id: channel.channel_id },
      });
      return { ...ergebnis, quelle: weg.name };
    } catch (err) {
      fehler.push(`${weg.beschreibung}: ${excerpt(err.message || err, 120)}`);
    }
  }
  throw new YoutubeError(`Keine Videoliste erhalten. ${fehler.join(' | ')}`);
}

/**
 * Titel und Datum nachladen, wenn die Quelle nur Kennungen geliefert hat.
 * Passiert bewusst erst kurz vor der Verarbeitung, damit keine Abrufe fuer Videos
 * anfallen, die ohnehin uebersprungen werden.
 */
async function ergaenzeMetadaten(eintrag) {
  if (eintrag.title) return eintrag;
  try {
    const daten = await supadata('/youtube/video', { id: eintrag.video_id });
    eintrag.title = entzerre(daten.title || '');
    eintrag.published_at = daten.uploadDate || eintrag.published_at;
    eintrag.description = String(daten.description || '').slice(0, 1500);
  } catch (err) {
    logger.debug('youtube', 'metadaten', `Titel konnte nicht geladen werden (${eintrag.video_id})`, {
      context: { fehler: String(err.message || err) },
    });
  }
  if (!eintrag.title) eintrag.title = `Video ${eintrag.video_id}`;
  return eintrag;
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
    const quelle = await listVideos(channel);
    const bekannt = db.prepare('SELECT video_id FROM videos WHERE channel_ref = ?').all(channel.id).map((v) => v.video_id);
    // Jeder Durchlauf bekommt eine Nummer. In der Oberflaeche steht damit nur das
    // Ergebnis des juengsten Durchlaufs, aeltere Vermerke bleiben als Gedaechtnis
    // in der Datenbank, damit dieselben Videos nicht erneut verarbeitet werden.
    const lauf = Number(channel.scan_count || 0) + 1;
    const einfuegen = db.prepare(
      `INSERT OR IGNORE INTO videos (id, channel_ref, site_id, video_id, title, description, published_at, status, run_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Beim ersten Lauf nur das neueste Video aufnehmen, sonst kaeme das ganze Archiv.
    const ersterLauf = !channel.last_check_at;
    const grenze = Math.max(1, Math.min(10, Number(channel.max_per_scan) || 1));
    const grenzeJetzt = ersterLauf ? 1 : grenze;

    // Neueste zuerst: Sind mehrere Videos dazugekommen, ist das juengste das relevanteste.
    // Ohne Datum bleibt die Reihenfolge der Quelle, die ebenfalls neueste zuerst liefert.
    const kandidaten = quelle.eintraege.filter((e) => !bekannt.includes(e.video_id));
    if (kandidaten.some((e) => e.published_at)) {
      kandidaten.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
    }

    let neu = 0;
    let uebersprungen = 0;
    for (const eintrag of kandidaten) {
      let grund = null;
      if (neu >= grenzeJetzt) {
        // Alles Weitere wird trotzdem vermerkt, damit es nicht beim naechsten Durchlauf
        // erneut auftaucht. Von Hand laesst sich daraus weiter ein Artikel machen.
        grund = ersterLauf
          ? 'Altbestand beim Einrichten des Kanals'
          : `Grenze von ${grenze} Video${grenze === 1 ? '' : 's'} je Durchlauf erreicht`;
        if (!eintrag.title) eintrag.title = `Video ${eintrag.video_id}`;
      } else {
        await ergaenzeMetadaten(eintrag);
        const dublette = findeDublette(channel.site_id, eintrag.title);
        if (dublette) grund = `Aehnliches Video wurde bereits verarbeitet: "${dublette.title}"`;
      }

      if (grund) uebersprungen += 1;
      else neu += 1;

      einfuegen.run(
        randomId('vid'), channel.id, channel.site_id, eintrag.video_id,
        eintrag.title, eintrag.description, eintrag.published_at, grund ? 'uebersprungen' : 'neu', lauf
      );
      if (grund) db.prepare('UPDATE videos SET error = ? WHERE video_id = ?').run(grund, eintrag.video_id);
    }

    db.prepare(
      `UPDATE channels SET last_check_at = datetime('now'), next_check_at = ?, last_error = NULL, scan_count = ?,
        title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?`
    ).run(naechsterTermin(channel.interval_hours), lauf, quelle.title || '', channel.id);

    timer.ok(`${neu} neue Videos${uebersprungen ? `, ${uebersprungen} uebersprungen` : ''}`, {
      siteId: channel.site_id,
      context: { neu, uebersprungen, gefunden: quelle.eintraege.length, quelle: quelle.quelle, erster_lauf: ersterLauf },
    });
    return { neu, uebersprungen, quelle: quelle.quelle };
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
  YoutubeError, aktiv, resolveChannel, fetchFeed, listVideos, fetchTranscript,
  scanChannel, runScan, offeneVideos, findeDublette, aehnlichkeit,
  videoUrl,
};
