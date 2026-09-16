'use strict';

/**
 * Lesen, Pruefen und Zusammenfuehren von ads.txt-Dateien.
 *
 * Eine ads.txt ist eine schlichte Textdatei im Wurzelverzeichnis einer Domain.
 * Jede Zeile nennt einen Vermarkter, der Werbeplaetze dieser Seite verkaufen darf:
 *
 *   google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0
 *   ^ Vermarkter     ^ Konto-ID        ^ Art    ^ Kennung des Vermarkters
 *
 * Daneben gibt es Variablen (CONTACT=, OWNERDOMAIN=, SUBDOMAIN= und weitere),
 * Kommentare ab "#" und Leerzeilen. Alles davon bleibt hier erhalten: Der Hub
 * schreibt die Datei nicht neu, er ergaenzt und entfernt einzelne Zeilen. Was ein
 * Mensch oder ein anderes Plugin hineingeschrieben hat, bleibt stehen.
 *
 * Diese Datei kennt keine Datenbank und kein Netz. Sie rechnet nur mit Text,
 * damit sich jede Regel einzeln pruefen laesst.
 */

const ARTEN = ['DIRECT', 'RESELLER'];
const VARIABLEN = ['CONTACT', 'SUBDOMAIN', 'OWNERDOMAIN', 'MANAGERDOMAIN', 'INVENTORYPARTNERDOMAIN'];
const MAX_ZEILEN = 20000;

/** Sieht das nach einer Domain aus? Absichtlich grosszuegig, aber nicht beliebig. */
function istDomain(wert) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(wert);
}

/**
 * Zerlegt eine einzelne Zeile.
 *
 * Der Kommentar wird abgetrennt, aber mitgefuehrt: Viele ads.txt-Dateien tragen
 * hinter der Zeile den Namen des Vermarkters, und der soll beim Umschreiben nicht
 * verloren gehen.
 */
function leseZeile(roh, nummer) {
  const zeile = String(roh == null ? '' : roh).replace(/﻿/g, '');
  const trenner = zeile.indexOf('#');
  const kommentar = trenner >= 0 ? zeile.slice(trenner + 1).trim() : '';
  const inhalt = (trenner >= 0 ? zeile.slice(0, trenner) : zeile).trim();

  if (!inhalt && !kommentar) return { art: 'leer', roh: '', nummer };
  if (!inhalt) return { art: 'kommentar', roh: zeile.trim(), kommentar, nummer };

  const variable = inhalt.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (variable) {
    const name = variable[1].toUpperCase();
    return {
      art: 'variable',
      roh: zeile.trim(),
      name,
      wert: variable[2].trim(),
      kommentar,
      bekannt: VARIABLEN.includes(name),
      nummer,
    };
  }

  const felder = inhalt.split(',').map((f) => f.trim());
  if (felder.length < 3) {
    return { art: 'fehler', roh: zeile.trim(), kommentar, nummer, grund: 'Eine Zeile braucht mindestens Vermarkter, Konto-ID und Art.' };
  }

  const [domain, konto, artRoh, kennung = ''] = felder;
  const art = artRoh.toUpperCase();
  const probleme = [];
  if (!istDomain(domain)) probleme.push(`"${domain}" sieht nicht wie eine Domain aus.`);
  if (!konto) probleme.push('Die Konto-ID fehlt.');
  if (!ARTEN.includes(art)) probleme.push(`"${artRoh}" ist weder DIRECT noch RESELLER.`);
  if (felder.length > 4) probleme.push('Die Zeile hat mehr als vier Felder.');

  return {
    art: probleme.length ? 'fehler' : 'eintrag',
    roh: zeile.trim(),
    domain: domain.toLowerCase(),
    konto,
    beziehung: ARTEN.includes(art) ? art : artRoh,
    kennung,
    kommentar,
    nummer,
    grund: probleme.join(' ') || undefined,
  };
}

/** Die ganze Datei in Zeilen zerlegen. */
function parse(text) {
  const zeilen = String(text == null ? '' : text).split(/\r\n|\r|\n/).slice(0, MAX_ZEILEN);
  return zeilen.map((zeile, i) => leseZeile(zeile, i + 1));
}

/**
 * Der Schluessel, an dem zwei Zeilen als derselbe Eintrag gelten.
 *
 * Die Domain ist laut Spezifikation unabhaengig von Gross- und Kleinschreibung,
 * die Konto-ID nicht. Die Art (DIRECT/RESELLER) gehoert bewusst nicht dazu:
 * Wer "google.com, pub-123" loswerden will, meint die Zeile, nicht die Art.
 */
function schluessel(eintrag) {
  if (!eintrag || eintrag.art !== 'eintrag') return '';
  return `${eintrag.domain}|${eintrag.konto}`;
}

/**
 * Der Schluessel fuer "das ist zweimal dasselbe".
 *
 * Hier zaehlt die Art mit. Zwei Zeilen mit derselben Konto-ID, aber einmal DIRECT
 * und einmal RESELLER, sind kein Versehen zum Wegraeumen, sondern ein Widerspruch,
 * den ein Mensch ansehen muss.
 */
function vollSchluessel(eintrag) {
  if (!eintrag || eintrag.art !== 'eintrag') return '';
  return `${eintrag.domain}|${eintrag.konto}|${eintrag.beziehung}`;
}

/** Eine Zeile wieder als Text. */
function alsText(eintrag) {
  if (!eintrag) return '';
  if (eintrag.art === 'eintrag') {
    const felder = [eintrag.domain, eintrag.konto, eintrag.beziehung];
    if (eintrag.kennung) felder.push(eintrag.kennung);
    return felder.join(', ') + (eintrag.kommentar ? ` # ${eintrag.kommentar}` : '');
  }
  return eintrag.roh || '';
}

/** Zeilen zurueck in eine Datei. Immer mit Zeilenumbruch am Ende. */
function schreibe(zeilen) {
  const text = zeilen.map(alsText).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? `${text}\n` : '';
}

/**
 * Liest eingetippte Zeilen ein, wie sie jemand aus einer Mail kopiert hat.
 * Doppelte und leere Zeilen fallen weg, kaputte werden benannt.
 */
function leseEingabe(text) {
  const gute = [];
  const schlechte = [];
  const gesehen = new Set();

  for (const zeile of parse(text)) {
    if (zeile.art === 'leer' || zeile.art === 'kommentar') continue;
    if (zeile.art === 'fehler') { schlechte.push(zeile); continue; }
    if (zeile.art === 'variable') { gute.push(zeile); continue; }
    const key = schluessel(zeile);
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    gute.push(zeile);
  }
  return { eintraege: gute, fehler: schlechte };
}

/**
 * Ergaenzt Eintraege, ohne Bestehendes anzufassen.
 *
 * Neue Zeilen kommen ans Ende. Eine Zeile, die es schon gibt, wird nicht noch
 * einmal geschrieben - doppelte Eintraege sind zwar erlaubt, aber sie machen die
 * Datei nur laenger und verwirren beim naechsten Mal.
 */
function ergaenze(text, neue) {
  const bestand = parse(text);
  const vorhanden = new Map();
  for (const zeile of bestand) {
    const key = schluessel(zeile);
    if (key) vorhanden.set(key, zeile);
  }

  const hinzugefuegt = [];
  const uebersprungen = [];
  const ergebnis = [...bestand];

  for (const neu of neue) {
    if (neu.art === 'variable') {
      // Variablen gibt es je Datei nur einmal sinnvoll. Vorhandene werden ersetzt.
      const stelle = ergebnis.findIndex((z) => z.art === 'variable' && z.name === neu.name);
      if (stelle >= 0) {
        if (ergebnis[stelle].wert === neu.wert) { uebersprungen.push(neu); continue; }
        ergebnis[stelle] = neu;
      } else {
        ergebnis.push(neu);
      }
      hinzugefuegt.push(neu);
      continue;
    }
    if (neu.art !== 'eintrag') continue;

    const key = schluessel(neu);
    if (vorhanden.has(key)) { uebersprungen.push(neu); continue; }
    vorhanden.set(key, neu);
    ergebnis.push(neu);
    hinzugefuegt.push(neu);
  }

  return { text: schreibe(ergebnis), hinzugefuegt, uebersprungen };
}

/** Entfernt Eintraege. Kommentare und Variablen bleiben unangetastet. */
function entferne(text, weg) {
  const raus = new Set();
  for (const zeile of weg) {
    const key = schluessel(zeile);
    if (key) raus.add(key);
  }

  const entfernt = [];
  const bleibt = parse(text).filter((zeile) => {
    const key = schluessel(zeile);
    if (!key || !raus.has(key)) return true;
    entfernt.push(zeile);
    return false;
  });

  return { text: schreibe(bleibt), entfernt };
}

/**
 * Raeumt doppelte Zeilen weg.
 *
 * Doppelt heisst: gleicher Vermarkter, gleiche Konto-ID, gleiche Art. Bleiben darf
 * die vollstaendigste der Zeilen - eine mit Kennung des Vermarkters schlaegt eine
 * ohne, und bei sonst gleichem Stand gewinnt die mit Kommentar. So geht beim
 * Aufraeumen keine Angabe verloren.
 *
 * Nicht angetastet werden Zeilen mit derselben Konto-ID, aber anderer Art. Das ist
 * ein Widerspruch, kein Versehen, und den entscheidet ein Mensch.
 */
function entdoppele(text) {
  const zeilen = parse(text);

  // Erst festlegen, welche Zeile je Schluessel bleibt.
  const behalten = new Map();
  zeilen.forEach((zeile, i) => {
    const key = vollSchluessel(zeile);
    if (!key) return;
    if (!behalten.has(key)) { behalten.set(key, i); return; }

    const bisher = zeilen[behalten.get(key)];
    const besser = (!bisher.kennung && zeile.kennung)
      || (Boolean(bisher.kennung) === Boolean(zeile.kennung) && !bisher.kommentar && zeile.kommentar);
    if (besser) behalten.set(key, i);
  });

  const entfernt = [];
  const bleibt = zeilen.filter((zeile, i) => {
    const key = vollSchluessel(zeile);
    if (!key || behalten.get(key) === i) return true;
    entfernt.push(zeile);
    return false;
  });

  return { text: schreibe(bleibt), entfernt };
}

/**
 * Was an einer Datei auffaellt: kaputte Zeilen, dieselbe Zeile zweimal und
 * derselbe Vermarkter mit widerspruechlicher Art.
 * Nichts davon ist ein Weltuntergang, kostet aber Einnahmen, wenn es niemand sieht.
 */
function pruefe(text) {
  const zeilen = parse(text);
  const gesehen = new Map();       // exakt dieselbe Zeile
  const nachKonto = new Map();     // dasselbe Konto, egal mit welcher Art
  const doppelt = [];
  const widerspruch = [];
  const fehler = [];

  for (const zeile of zeilen) {
    if (zeile.art === 'fehler') { fehler.push(zeile); continue; }

    const voll = vollSchluessel(zeile);
    if (voll) {
      if (gesehen.has(voll)) {
        doppelt.push({ zeile, zuerst: gesehen.get(voll) });
        continue;                  // eine doppelte Zeile ist kein Widerspruch
      }
      gesehen.set(voll, zeile.nummer);
    }

    const key = schluessel(zeile);
    if (!key) continue;
    const vorher = nachKonto.get(key);
    if (vorher && vorher.beziehung !== zeile.beziehung) {
      widerspruch.push({ zeile, zuerst: vorher.nummer, andere: vorher.beziehung });
    } else if (!vorher) {
      nachKonto.set(key, { nummer: zeile.nummer, beziehung: zeile.beziehung });
    }
  }

  return {
    zeilen: zeilen.length,
    eintraege: zeilen.filter((z) => z.art === 'eintrag').length,
    variablen: zeilen.filter((z) => z.art === 'variable').length,
    direkt: zeilen.filter((z) => z.art === 'eintrag' && z.beziehung === 'DIRECT').length,
    reseller: zeilen.filter((z) => z.art === 'eintrag' && z.beziehung === 'RESELLER').length,
    fehler,
    doppelt,
    widerspruch,
  };
}

/** Die Vermarkter einer Datei, damit sich Seiten vergleichen lassen. */
function vermarkter(text) {
  const namen = new Set();
  for (const zeile of parse(text)) {
    if (zeile.art === 'eintrag') namen.add(zeile.domain);
  }
  return [...namen].sort();
}

module.exports = {
  parse, leseZeile, schluessel, vollSchluessel, alsText, schreibe, leseEingabe,
  ergaenze, entferne, entdoppele, pruefe, vermarkter, istDomain, ARTEN, VARIABLEN,
};
