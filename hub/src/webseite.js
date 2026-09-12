'use strict';
const dns = require('dns').promises;
const net = require('net');
const { logger, excerpt } = require('./logger');
const { safeLink } = require('./sanitize');

/**
 * Liest eine fremde Seite und gibt ihren Inhalt als Fliesstext zurueck.
 *
 * Gebraucht fuer Backlink-Auftraege: Statt selbst zu beschreiben, worum es auf der
 * Zielseite geht, kann der Hub nachsehen.
 *
 * Der Hub ruft hier eine Adresse ab, die jemand ins Formular getippt hat. Damit
 * liesse sich der Server sonst als Werkzeug missbrauchen, um an Dinge zu kommen,
 * die nur von innen erreichbar sind: der Nachbardienst auf localhost, das
 * Verwaltungsnetz, die Metadaten-Schnittstelle des Rechenzentrums. Deshalb wird
 * der Name erst aufgeloest und die Adresse geprueft, bevor irgendetwas abgerufen
 * wird.
 */
const TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ZEICHEN = 4000;
const MAX_UMLEITUNGEN = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; AutoblogHub/1.0; +Leseanfrage)';

class SeitenError extends Error {}

/** Zeigt diese IP ins eigene Netz? */
function istIntern(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;          // Link-Local, auch die Metadaten-Adresse
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-NAT
    return false;
  }
  const klein = ip.toLowerCase();
  if (klein === '::1' || klein === '::') return true;
  if (klein.startsWith('fc') || klein.startsWith('fd')) return true;  // eindeutig lokal
  if (klein.startsWith('fe80')) return true;                          // Link-Local
  if (klein.startsWith('::ffff:')) return istIntern(klein.slice(7));   // IPv4 im IPv6-Kleid
  return false;
}

async function pruefeZiel(url) {
  const sauber = safeLink(url);
  if (!sauber) throw new SeitenError('Bitte eine vollständige Adresse mit https:// angeben.');

  const { hostname } = new URL(sauber);
  let adressen;
  try {
    adressen = await dns.lookup(hostname, { all: true });
  } catch {
    throw new SeitenError(`Der Name ${hostname} ließ sich nicht auflösen.`);
  }
  if (adressen.some((a) => istIntern(a.address))) {
    throw new SeitenError('Diese Adresse zeigt ins eigene Netz. Der Hub liest nur öffentliche Seiten.');
  }
  return sauber;
}

/** HTML auf den lesbaren Teil eindampfen. */
function textAusHtml(html) {
  const ohneBeiwerk = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');

  const entzerre = (text) => String(text || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .trim();

  const titel = entzerre((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const beschreibung = entzerre(
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1]
    || (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i) || [])[1]
  );

  // Ueberschriften und Absaetze tragen den Inhalt, der Rest ist meist Navigation.
  const stuecke = [];
  for (const treffer of ohneBeiwerk.matchAll(/<(h1|h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = entzerre(treffer[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
    if (text.length > 30) stuecke.push(/^h/i.test(treffer[1]) ? `\n${text}` : text);
  }

  return { titel, beschreibung, text: stuecke.join(' ').replace(/\s{2,}/g, ' ').trim() };
}

/**
 * Holt die Seite und prueft dabei jede Station einzeln.
 *
 * `redirect: 'follow'` waere bequem, aber gefaehrlich: Die Pruefung oben gilt dann
 * nur fuer die erste Adresse, und ein fremder Server kann von dort aus auf
 * 127.0.0.1 oder die Metadaten-Adresse weiterleiten. Deshalb wird jede Umleitung
 * von Hand verfolgt und vorher wieder geprueft.
 */
async function holeMitUmleitungen(url) {
  let ziel = await pruefeZiel(url);

  for (let schritt = 0; schritt <= MAX_UMLEITUNGEN; schritt += 1) {
    const antwort = await fetch(ziel, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (antwort.status < 300 || antwort.status > 399) return { antwort, ziel };

    const weiter = antwort.headers.get('location');
    if (!weiter) return { antwort, ziel };
    if (schritt === MAX_UMLEITUNGEN) {
      throw new SeitenError('Die Seite leitet zu oft weiter.');
    }
    // Relative Ziele ("/start") gegen die aktuelle Adresse aufloesen.
    let naechste;
    try {
      naechste = new URL(weiter, ziel).href;
    } catch {
      throw new SeitenError('Die Seite leitet auf eine unbrauchbare Adresse weiter.');
    }
    ziel = await pruefeZiel(naechste);
  }
  throw new SeitenError('Die Seite leitet zu oft weiter.');
}

/**
 * Liest den Inhalt, hoert aber nach MAX_BYTES auf.
 *
 * `antwort.text()` wuerde erst alles in den Speicher holen und danach kuerzen -
 * bei einer 80-MB-Antwort ist der Schaden dann schon passiert.
 */
async function liesBegrenzt(antwort) {
  if (!antwort.body || typeof antwort.body.getReader !== 'function') {
    const roh = await antwort.text();
    return roh.slice(0, MAX_BYTES);
  }
  const reader = antwort.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let gelesen = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gelesen += value.length;
      if (gelesen >= MAX_BYTES) {
        const rest = value.length - (gelesen - MAX_BYTES);
        text += decoder.decode(value.subarray(0, Math.max(rest, 0)));
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/**
 * Liest die Seite und fasst sie als kurzen Absatz zusammen, wie ihn ein Mensch
 * ins Formularfeld getippt haette.
 */
async function leseSeite(url) {
  const timer = logger.start('web', 'lesen', `Zielseite wird gelesen: ${url}`);

  let antwort;
  let ziel;
  try {
    ({ antwort, ziel } = await holeMitUmleitungen(url));
  } catch (err) {
    timer.fail(err);
    if (err instanceof SeitenError) throw err;
    throw new SeitenError(`Die Seite war nicht erreichbar: ${err.message}`);
  }

  if (!antwort.ok) {
    timer.fail(`HTTP ${antwort.status}`);
    throw new SeitenError(`Die Seite antwortete mit HTTP ${antwort.status}.`);
  }
  const typ = antwort.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(typ)) {
    timer.fail(`Inhaltstyp ${typ}`);
    throw new SeitenError(`Das ist keine Webseite, sondern ${typ.split(';')[0] || 'unbekannt'}.`);
  }

  const html = await liesBegrenzt(antwort);
  const { titel, beschreibung, text } = textAusHtml(html);

  const zusammen = [
    titel ? `Titel der Seite: ${titel}` : '',
    beschreibung ? `Kurzbeschreibung: ${beschreibung}` : '',
    text ? `Inhalt: ${text}` : '',
  ].filter(Boolean).join('\n').slice(0, MAX_ZEICHEN);

  if (zusammen.length < 80) {
    timer.fail('zu wenig Text');
    throw new SeitenError('Auf der Seite war kaum Text zu finden. Bitte kurz selbst beschreiben.');
  }

  timer.ok(`Zielseite gelesen (${zusammen.length} Zeichen)`, {
    context: { titel, url: ziel, anfang: excerpt(text, 200) },
  });
  return zusammen;
}

module.exports = { leseSeite, textAusHtml, istIntern, pruefeZiel, liesBegrenzt, MAX_BYTES, SeitenError };
