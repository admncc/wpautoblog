'use strict';
const { db } = require('./db');
const { logger, excerpt } = require('./logger');
const webseite = require('./webseite');
const ai = require('./ai');

/**
 * "Inhalt & Stil" aus der vorhandenen Website ableiten.
 *
 * Eine frisch verbundene Website ist im Hub zunaechst ein leeres Formular: keine
 * Zielgruppe, keine Tonalitaet, keine Schwerpunkte. Wer es nicht ausfuellt,
 * bekommt beliebige Artikel. Dabei steht alles, was man braucht, schon auf der
 * Website - man muss nur hinsehen.
 *
 * Das passiert hier in drei Schritten:
 *
 * 1. Material sammeln: Startseite, ein paar Beitraege ueber die offene
 *    WordPress-Schnittstelle, dazu die Kategorien, die das Plugin gemeldet hat.
 * 2. Das Modell liest es und beschreibt die Seite, wie ein neuer Redakteur sie
 *    beschreiben wuerde.
 * 3. Der Vorschlag geht ins Formular. Gespeichert wird er nur, wenn niemand
 *    zusieht - beim ersten Verbinden. Drueckt jemand den Knopf, sieht er den
 *    Vorschlag erst an und speichert selbst.
 */

const POSTS = 6;
const MAX_MATERIAL = 14000;

/** Die Grundadresse der Website, ohne Schraegstrich am Ende. */
function basis(site) {
  return String(site.url || '').replace(/\/+$/, '');
}

/** Ein WordPress-Auszug ist HTML. Fuer das Modell reicht der Text. */
function ohneTags(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&#039;|&apos;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&#8230;/g, '…')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Die Kategorien, die das Plugin gemeldet hat. */
function kategorien(site) {
  try {
    return JSON.parse(site.categories || '[]')
      .filter((k) => k && k.name)
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 25);
  } catch {
    return [];
  }
}

/**
 * Sammelt, was sich ueber die Website herausfinden laesst.
 *
 * Jede Quelle darf einzeln scheitern. Eine Startseite voller Bilder, eine
 * gesperrte Schnittstelle, ein Wartungsmodus - keiner dieser Faelle darf den
 * ganzen Versuch beenden, solange noch irgendetwas uebrig bleibt.
 */
async function sammleMaterial(site) {
  const teile = [];
  const quellen = [];

  if (!site.url) throw new Error('Für diese Website ist noch keine Adresse hinterlegt.');

  try {
    const start = await webseite.leseSeite(site.url);
    teile.push(`DIE STARTSEITE\n${start}`);
    quellen.push('Startseite');
  } catch (err) {
    logger.debug('ai', 'profil', `Startseite nicht lesbar: ${err.message}`, { siteId: site.id });
  }

  try {
    const ziel = `${basis(site)}/wp-json/wp/v2/posts?per_page=${POSTS}&_fields=title,excerpt,link,date`;
    const posts = await webseite.leseJson(ziel);
    const zeilen = (Array.isArray(posts) ? posts : [])
      .map((post) => {
        const titel = ohneTags(post.title && post.title.rendered);
        const anriss = ohneTags(post.excerpt && post.excerpt.rendered).slice(0, 600);
        return titel ? `- ${titel}${anriss ? `\n  ${anriss}` : ''}` : '';
      })
      .filter(Boolean);
    if (zeilen.length) {
      teile.push(`DIE LETZTEN ${zeilen.length} BEITRÄGE\n${zeilen.join('\n')}`);
      quellen.push(`${zeilen.length} Beiträge`);
    }
  } catch (err) {
    logger.debug('ai', 'profil', `Beiträge nicht abrufbar: ${err.message}`, { siteId: site.id });
  }

  const rubriken = kategorien(site);
  if (rubriken.length) {
    teile.push(`DIE KATEGORIEN DER WEBSITE (mit Anzahl der Beiträge)\n${
      rubriken.map((k) => `- ${k.name}${k.count ? ` (${k.count})` : ''}`).join('\n')}`);
    quellen.push(`${rubriken.length} Kategorien`);
  }

  if (!teile.length) {
    throw new Error('Von dieser Website ließ sich nichts lesen: keine Startseite, keine Beiträge,'
      + ' keine Kategorien. Bitte die Felder von Hand ausfüllen.');
  }

  return {
    text: `WEBSITE: ${site.name}\nADRESSE: ${basis(site)}\n\n${teile.join('\n\n')}`.slice(0, MAX_MATERIAL),
    quellen,
  };
}

/**
 * Liest die Website und schlaegt Werte fuer "Inhalt & Stil" vor.
 * Speichert nichts - das entscheidet der Aufrufer.
 */
async function schlageVor(siteId) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) throw new Error('Website nicht gefunden.');

  const material = await sammleMaterial(site);
  const timer = logger.start('ai', 'profil', `Inhalt & Stil für ${site.name} wird aus der Website abgeleitet`, {
    siteId: site.id,
    context: { quellen: material.quellen, zeichen: material.text.length },
  });

  try {
    const vorschlag = await ai.generateSiteProfile({ site, material: material.text });
    timer.ok(`Vorschlag steht: ${vorschlag.zusammenfassung}`, {
      siteId: site.id,
      context: { quellen: material.quellen, vorschlag: excerpt(JSON.stringify(vorschlag), 800) },
    });
    return { ...vorschlag, quellen: material.quellen };
  } catch (err) {
    timer.fail(err, { siteId: site.id });
    throw err;
  }
}

/**
 * Hat an "Inhalt & Stil" noch niemand gearbeitet?
 *
 * Nur dann wird von selbst ausgefuellt. Was ein Mensch eingetragen hat, ueber-
 * schreibt der Hub nicht - auch nicht mit einem guten Vorschlag.
 */
function istUnberuehrt(site) {
  return !String(site.audience || '').trim()
    && !String(site.topic_focus || '').trim()
    && !String(site.extra_prompt || '').trim();
}

const FELDER = ['language', 'audience', 'tone', 'topic_focus', 'extra_prompt', 'word_count'];

/** Den Vorschlag speichern. Leere Werte lassen den bisherigen Stand stehen. */
function uebernimm(siteId, vorschlag) {
  const gesetzt = FELDER.filter((feld) => vorschlag[feld] !== undefined && vorschlag[feld] !== '');
  if (!gesetzt.length) return 0;
  db.prepare(`UPDATE sites SET ${gesetzt.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...gesetzt.map((f) => vorschlag[f]), siteId);
  return gesetzt.length;
}

/**
 * Beim ersten Verbinden im Hintergrund ausfuellen.
 *
 * Laeuft absichtlich ohne Rueckmeldung an den Aufrufer: Das Plugin wartet auf die
 * Antwort des Verbindungsaufrufs, und die darf nicht davon abhaengen, ob eine
 * fremde Startseite gerade schnell antwortet.
 */
function fuelleBeimVerbinden(siteId) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site || !site.url || !istUnberuehrt(site)) return;

  // Ohne Schluessel gibt es nichts abzuleiten, und eine Fehlermeldung im
  // Protokoll waere beim Verbinden nur verwirrend.
  const settings = require('./settings');
  if (!settings.getApiKey()) {
    logger.debug('ai', 'profil', 'Kein Anthropic-Key hinterlegt, Inhalt & Stil bleibt leer', { siteId });
    return;
  }

  setTimeout(() => {
    schlageVor(siteId)
      .then((vorschlag) => {
        // In der Zwischenzeit kann jemand selbst etwas eingetragen haben.
        const jetzt = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
        if (!jetzt) return;
        if (!istUnberuehrt(jetzt)) {
          logger.info('ai', 'profil', 'Inhalt & Stil wurde inzwischen von Hand gefüllt, Vorschlag verworfen', { siteId });
          return;
        }
        const anzahl = uebernimm(siteId, vorschlag);
        logger.info('ai', 'profil',
          `Inhalt & Stil für "${jetzt.name}" automatisch ausgefüllt (${anzahl} Felder): ${vorschlag.zusammenfassung}`,
          { siteId, context: { quellen: vorschlag.quellen } });
      })
      .catch((err) => {
        logger.warn('ai', 'profil', `Inhalt & Stil konnte nicht abgeleitet werden: ${err.message || err}`, { siteId });
      });
  }, 1500);
}

module.exports = { schlageVor, uebernimm, istUnberuehrt, fuelleBeimVerbinden, sammleMaterial, ohneTags, FELDER };
