'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const settings = require('./settings');
const { sanitizeHtml, sanitizeText } = require('./sanitize');
const { slugify, countWords } = require('./util');
const { logger, excerpt } = require('./logger');

// Modelle, die in der Oberflaeche auswaehlbar sind.
const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 - beste Qualitaet (Empfehlung)', effort: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 - schneller und guenstiger', effort: true },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 - am guenstigsten', effort: false },
];

class AiError extends Error {}

function client() {
  const apiKey = settings.getApiKey();
  if (!apiKey) {
    throw new AiError('Kein Anthropic API-Key hinterlegt. Bitte unter "Einstellungen" eintragen.');
  }
  return new Anthropic({ apiKey });
}

function modelConfig() {
  const model = settings.get('model') || 'claude-opus-5';
  const known = MODELS.find((m) => m.id === model);
  return { model, supportsEffort: known ? known.effort : true };
}

function outputConfig(schema) {
  const { supportsEffort } = modelConfig();
  const config = { format: { type: 'json_schema', schema } };
  if (supportsEffort) config.effort = settings.get('effort') || 'high';
  return config;
}

async function runJson({ system, prompt, schema, maxTokens, kind, meta = {} }) {
  const { model, supportsEffort } = modelConfig();
  const anthropic = client();
  const effort = supportsEffort ? settings.get('effort') || 'high' : null;

  const timer = logger.start('ai', kind, `Claude-Anfrage (${kind}) gestartet`, {
    ...meta,
    context: {
      model,
      effort,
      max_tokens: maxTokens,
      system_chars: system.length,
      prompt_chars: prompt.length,
      prompt: excerpt(prompt, 1200),
    },
  });

  let message;
  try {
    // Streaming, weil Artikel lang werden koennen und sonst HTTP-Timeouts drohen.
    const stream = anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: outputConfig(schema),
    });
    message = await stream.finalMessage();
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    timer.fail(err, { context: { status: err && err.status, type: err && err.type, model } });
    if (err && err.status === 401) throw new AiError('Anthropic API-Key ungueltig (401). Bitte in den Einstellungen pruefen.');
    if (err && err.status === 429) throw new AiError('Anthropic-Limit erreicht (429). Bitte spaeter erneut versuchen.');
    if (err && err.status === 400) throw new AiError(`Anfrage wurde abgelehnt (400): ${detail}`);
    throw new AiError(`Anfrage an Claude fehlgeschlagen: ${detail}`);
  }

  const usage = message.usage || {};
  const usageContext = {
    stop_reason: message.stop_reason,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
  };

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details && message.stop_details.category ? ` (${message.stop_details.category})` : '';
    timer.fail(`Claude hat die Anfrage abgelehnt${category}`, { context: usageContext });
    throw new AiError(`Claude hat die Anfrage abgelehnt${category}. Bitte Thema oder Vorgaben anpassen.`);
  }
  if (message.stop_reason === 'max_tokens') {
    timer.fail('Antwort wurde durch max_tokens abgeschnitten', { context: usageContext });
    throw new AiError('Die Antwort wurde abgeschnitten. Bitte die gewuenschte Textlaenge reduzieren.');
  }

  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    timer.fail('Antwort war kein gueltiges JSON', { context: { ...usageContext, response: excerpt(text, 1500) } });
    throw new AiError('Claude hat kein gueltiges JSON geliefert. Bitte erneut versuchen.');
  }

  timer.ok(
    `Claude-Antwort erhalten (${usageContext.output_tokens} Ausgabe-Token in ${timer.elapsed()} ms)`,
    { ...meta, context: { ...usageContext, model, response_chars: text.length } }
  );

  return {
    data,
    usage: { model, tokens_in: usageContext.input_tokens, tokens_out: usageContext.output_tokens },
  };
}

/**
 * Sicherheitsnetz fuer den langen Gedankenstrich.
 * Das Prompt-Framework verbietet ihn, Modelle setzen ihn trotzdem gelegentlich.
 * Der normale Bindestrich bleibt selbstverstaendlich unangetastet.
 */
function replaceEmDash(text) {
  return String(text || '')
    // Am Ende eines Absatzes oder vor einem Tag: ersatzlos streichen.
    .replace(/\s*—\s*(?=<|$)/g, '')
    // Am Anfang eines Absatzes: ebenfalls streichen.
    .replace(/(^|>)\s*—\s*/g, '$1')
    // Direkt zwischen zwei Woertern oder Zahlen war ein Bindestrich gemeint.
    .replace(/(\w)—(\w)/g, '$1-$2')
    // Sonst steht im Deutschen an derselben Stelle ein Komma.
    .replace(/\s*—\s*/g, ', ');
}

const countEmDash = (text) => (String(text || '').match(/—/g) || []).length;

/**
 * Sucht nach Ersatzschreibweisen wie "fuer" oder "groesste". Reparieren laesst sich das
 * nicht zuverlaessig (z. B. "Duesseldorf" gegen "Steuer"), aber es gehoert ins Protokoll.
 */
function zaehleErsatzumlaute(text) {
  const treffer = String(text || '').match(/\b(?:fuer|ueber|koennen|muessen|waehrend|naechst\w*|groess\w*|hoeh\w*|moegl\w*|zusaetzl\w*|grundsaetzl\w*|taeglich|jaehrlich|moeglichkeit\w*|beruecksicht\w*|erfuell\w*|gemaess|zunaechst)\b/gi);
  return treffer ? treffer.length : 0;
}

/**
 * Gleicht die gelieferte Kategorie gegen die vorhandenen ab.
 * Zweite Absicherung neben der Vorgabe im Schema: Es wird nie ein Wert
 * weitergereicht, den die Website nicht kennt.
 */
function waehleKategorie(gewaehlt, vorhanden) {
  const wert = sanitizeText(gewaehlt, 60);
  if (!vorhanden.length) return wert;
  if (vorhanden.includes(wert)) return wert;

  const treffer = vorhanden.find((name) => name.toLowerCase() === wert.toLowerCase());
  if (treffer) return treffer;

  logger.warn('ai', 'category', `Kategorie "${wert}" ist auf der Website unbekannt, sie bleibt offen`, {
    context: { gewaehlt: wert, vorhanden },
  });
  return '';
}

const SPRACHEN = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch' };

/**
 * Sagt dem Modell, in welcher Sprache der Beitrag steht.
 *
 * Bei nicht-deutschen Websites muss das ausdruecklich dastehen: Das Regelwerk selbst
 * ist auf Deutsch verfasst, und ohne klare Ansage schreibt das Modell in der Sprache
 * der Anweisung weiter. Die Regeln zu Umlauten und deutschen Fuellwendungen gelten
 * dann selbstverstaendlich nicht.
 */
function sprachHinweis(site) {
  const code = site.language || 'de';
  const name = SPRACHEN[code] || code;
  if (code === 'de') return `Sprache: Deutsch, mit echten Umlauten (ä, ö, ü, ß), niemals ae/oe/ue/ss.`;
  return `Sprache: ${name}. Der gesamte Beitrag steht in dieser Sprache: Titel, Zwischenüberschriften,`
    + ` Fließtext, Meta-Angaben, Schlagwörter, Bildunterschriften und Alternativtexte. Die Regeln des`
    + ` Regelwerks zu deutschen Umlauten und zu deutschen Füllwendungen gelten hier nicht, ihre Absicht`
    + ` schon: keine Floskeln, keine Aufzählungen ohne Inhalt, kein zusammenfassendes Fazit am Ende.`;
}

function siteBriefing(site) {
  const global = settings.all();
  // Bewusst mit echten Umlauten: Das Modell uebernimmt die Schreibweise der Aufgabe.
  const lines = [
    `Website: ${site.name}${site.url ? ` (${site.url})` : ''}`,
    `Sprache: ${site.language || 'de'}`,
    `Zielgruppe: ${site.audience || 'allgemeines Fachpublikum'}`,
    `Tonalität: ${site.tone || global.default_tone}`,
  ];
  if (site.topic_focus) lines.push(`Themenschwerpunkte: ${site.topic_focus}`);
  if (global.brand_name) lines.push(`Marke: ${global.brand_name}`);
  if (global.brand_description) lines.push(`Über die Marke: ${global.brand_description}`);
  if (global.global_prompt) lines.push(`Grundsätzliche Vorgaben: ${global.global_prompt}`);
  if (site.extra_prompt) lines.push(`Zusätzliche Vorgaben für diese Website: ${site.extra_prompt}`);
  return lines.join('\n');
}

/**
 * Baut das Antwortschema. Kennt der Hub die Kategorien der Website, wird das Feld
 * auf genau diese Werte eingegrenzt. Dann kann Claude keine neue erfinden.
 */
function articleSchema(kategorien = [], vorlage = null) {
  const schema = JSON.parse(JSON.stringify(vorlage || ARTICLE_SCHEMA));
  if (kategorien.length) {
    schema.properties.category = {
      type: 'string',
      enum: kategorien,
      description: 'Die am besten passende der vorhandenen Kategorien. Keine andere ist zulaessig.',
    };
  }
  return schema;
}

const ARTICLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Beitragstitel, 45-65 Zeichen, ohne Anfuehrungszeichen' },
    slug: { type: 'string', description: 'URL-Slug in Kleinbuchstaben, Woerter mit Bindestrich getrennt' },
    meta_title: { type: 'string', description: 'SEO-Titel, maximal 60 Zeichen' },
    meta_description: { type: 'string', description: 'SEO-Beschreibung, 140-155 Zeichen' },
    excerpt: { type: 'string', description: 'Anreisser fuer Uebersichtsseiten, 1-2 Saetze' },
    tags: { type: 'array', items: { type: 'string' }, description: '3-6 Schlagwoerter' },
    category: { type: 'string', description: 'Passende WordPress-Kategorie' },
    content_html: { type: 'string', description: 'Der Artikel als HTML' },
    images: {
      type: 'array',
      description: 'Bildkonzepte. Leere Liste, wenn keine Bilder angefordert wurden.',
      items: {
        type: 'object',
        properties: {
          slot: { type: 'integer', description: '1 = Titelbild, ab 2 im Text als [[BILD:n]] platziert' },
          motif: { type: 'string', description: 'Bildbeschreibung fuer das Bildmodell, auf Englisch' },
          alt: { type: 'string', description: 'Alternativtext in der Sprache des Artikels' },
          caption: { type: 'string', description: 'Bildunterschrift, ein Satz, darf leer sein' },
        },
        required: ['slot', 'motif', 'alt', 'caption'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'slug', 'meta_title', 'meta_description', 'excerpt', 'tags', 'category', 'content_html', 'images'],
  additionalProperties: false,
};

/** Das in den Einstellungen gepflegte Prompt-Framework. */
function articleSystemPrompt() {
  return (settings.get('article_prompt') || '').trim() || require('./prompts').DEFAULT_ARTICLE_PROMPT;
}

function topicSystemPrompt() {
  return (settings.get('topic_prompt') || '').trim() || require('./prompts').DEFAULT_TOPIC_PROMPT;
}

async function generateArticle({ site, keyword, angle, imageCount = 0, categories = [] }) {
  const wordCount = site.word_count || Number(settings.get('default_word_count')) || 1200;
  const kategorien = categories.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);
  const prompt = `${siteBriefing(site)}

Aufgabe: Schreibe einen vollständigen Blogartikel.
Hauptkeyword / Thema: ${keyword}
${angle ? `Gewünschter Blickwinkel: ${angle}\n` : ''}Ziellänge: ca. ${wordCount} Wörter als Richtwert.
${sprachHinweis(site)}
${kategorien.length
    ? `Kategorie: Wähle GENAU EINE aus den vorhandenen Kategorien dieser Website. `
      + `Lege keine neue an und weiche nicht ab. Passt keine gut, nimm die am wenigsten unpassende.\n`
      + `Vorhandene Kategorien: ${kategorien.join(' | ')}\n`
    : ''}Bilder: ${imageCount > 0
    ? `${imageCount} Bildkonzepte. Bild 1 ist das Titelbild, die übrigen platzierst du mit [[BILD:2]] bis [[BILD:${imageCount}]] im Text.`
    : 'keine. Gib für "images" eine leere Liste zurück und setze keine Platzhalter in den Text.'}`;

  const { data, usage } = await runJson({
    system: articleSystemPrompt(),
    prompt,
    schema: articleSchema(kategorien),
    maxTokens: 32000,
    kind: 'article',
    meta: { siteId: site.id, context: { keyword, angle, target_words: wordCount } },
  });

  return { ...aufbereiten(data, site, imageCount, keyword, kategorien), ...usage };
}

/**
 * Gemeinsame Nachbearbeitung: Umlaute pruefen, HTML saeubern, Bildkonzepte ordnen,
 * Platzhalter aufraeumen. Wird von der Artikel- und der Video-Erzeugung genutzt.
 */
function aufbereiten(data, site, imageCount, keyword, kategorien) {
  const ersatz = (site.language || 'de') === 'de' ? zaehleErsatzumlaute(data.content_html) : 0;
  if (ersatz > 2) {
    logger.warn('ai', 'umlaute', `${ersatz} Wörter in Ersatzschreibweise (fuer, ueber, groesste …) im Artikel`, {
      siteId: site.id,
      context: { keyword, treffer: ersatz, hinweis: 'Prompt-Framework auf echte Umlaute prüfen' },
    });
  }

  const emDashes = countEmDash(data.content_html) + countEmDash(data.title) + countEmDash(data.meta_description);
  if (emDashes) {
    logger.warn('ai', 'emdash', `${emDashes} lange Gedankenstriche ersetzt`, {
      siteId: site.id,
      context: { keyword, count: emDashes },
    });
  }

  const images = (Array.isArray(data.images) ? data.images : [])
    .slice(0, Math.max(0, imageCount))
    .map((img, index) => ({
      slot: Number(img.slot) || index + 1,
      motif: sanitizeText(img.motif, 2000),
      alt: sanitizeText(img.alt, 300),
      caption: sanitizeText(img.caption, 300),
    }))
    .filter((img) => img.motif);

  let contentHtml = replaceEmDash(sanitizeHtml(data.content_html));
  // Platzhalter entfernen, zu denen es kein Bildkonzept gibt - sie wuerden sonst
  // als sichtbarer Text im Beitrag landen.
  const known = new Set(images.map((img) => img.slot));
  contentHtml = contentHtml.replace(/<p>\s*(\[\[BILD:(\d+)\]\])\s*<\/p>|\[\[BILD:(\d+)\]\]/g, (match, _p, a, b) => {
    const slot = Number(a || b);
    return known.has(slot) && slot > 1 ? `<p>[[BILD:${slot}]]</p>` : '';
  });
  logger.debug('ai', 'sanitize', 'Artikel-HTML geprueft und bereinigt', {
    siteId: site.id,
    context: { raw_chars: String(data.content_html || '').length, clean_chars: contentHtml.length, words: countWords(contentHtml) },
  });
  if (countWords(contentHtml) < 120) {
    throw new AiError('Der erzeugte Artikel ist zu kurz. Bitte erneut versuchen.');
  }

  return {
    title: replaceEmDash(sanitizeText(data.title, 200)),
    slug: slugify(data.slug || data.title),
    meta_title: replaceEmDash(sanitizeText(data.meta_title, 80)),
    meta_desc: replaceEmDash(sanitizeText(data.meta_description, 200)),
    excerpt: replaceEmDash(sanitizeText(data.excerpt, 400)),
    tags: (Array.isArray(data.tags) ? data.tags : []).map((t) => sanitizeText(t, 40)).filter(Boolean).slice(0, 8).join(', '),
    category: waehleKategorie(data.category, kategorien),
    content_html: contentHtml,
    word_count: countWords(contentHtml),
    images,
  };
}

/**
 * Artikel auf einen recherchierten Suchbegriff.
 *
 * Unterschied zur gewoehnlichen Erzeugung: Hier ist der Suchbegriff gesetzt und es
 * gibt ein Briefing dazu, was in den Suchergebnissen schon steht. Das eigene Regelwerk
 * dafuer steht in den Einstellungen und laesst sich dort anpassen.
 */
function targetSystemPrompt() {
  return (settings.get('target_prompt') || '').trim() || require('./prompts').DEFAULT_TARGET_PROMPT;
}

/** Baut aus den Recherchedaten den Teil des Prompts, der die Suche beschreibt. */
function rechercheBlock(briefing = {}) {
  const zeilen = [];
  if (briefing.intent) zeilen.push(`Suchabsicht: ${briefing.intent}`);
  if (briefing.volume) zeilen.push(`Suchvolumen: ${briefing.volume} Suchanfragen im Monat`);
  if (briefing.difficulty) zeilen.push(`Schwierigkeit: ${briefing.difficulty} von 100`);
  if (briefing.secondary && briefing.secondary.length) {
    zeilen.push(`Nebenbegriffe, die vorkommen sollen: ${briefing.secondary.join(', ')}`);
  }
  if (briefing.questions && briefing.questions.length) {
    zeilen.push(`Fragen, die zu dieser Suche gestellt werden:\n- ${briefing.questions.join('\n- ')}`);
  }
  if (briefing.covered) zeilen.push(`Das decken die führenden Ergebnisse bereits ab:\n${briefing.covered}`);
  if (briefing.gaps) zeilen.push(`Dort fehlt bisher:\n${briefing.gaps}`);
  return zeilen.length ? `\nRECHERCHE\n${zeilen.join('\n')}\n` : '';
}

async function generateTargeted({ site, keyword, angle = '', briefing = {}, imageCount = 0, categories = [] }) {
  const wordCount = Number(site.word_count) || Number(settings.get('default_word_count')) || 1200;
  const kategorien = categories.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);

  const system = `${targetSystemPrompt()}

═══════════════════════════════════════════════════════════════════
REGELWERK FUER ARTIKEL
═══════════════════════════════════════════════════════════════════

${articleSystemPrompt()}`;

  const prompt = `${siteBriefing(site)}

Aufgabe: Schreibe den Beitrag, der für diese Suche stehen soll.
Suchbegriff: ${keyword}
${angle ? `Gewünschter Blickwinkel: ${angle}\n` : ''}Ziellänge: ca. ${wordCount} Wörter als Richtwert.
${sprachHinweis(site)}
${kategorien.length
    ? `Kategorie: Wähle GENAU EINE der vorhandenen Kategorien dieser Website: ${kategorien.join(' | ')}\n`
    : ''}Bilder: ${imageCount > 0
    ? `${imageCount} Bildkonzepte. Bild 1 ist das Titelbild, die übrigen platzierst du mit [[BILD:2]] bis [[BILD:${imageCount}]] im Text.`
    : 'keine. Gib für "images" eine leere Liste zurück und setze keine Platzhalter in den Text.'}
${rechercheBlock(briefing)}`;

  const { data, usage } = await runJson({
    system,
    prompt,
    schema: articleSchema(kategorien),
    maxTokens: 32000,
    kind: 'target',
    meta: { siteId: site.id, context: { keyword, angle, target_words: wordCount, recherche: Object.keys(briefing || {}) } },
  });

  return { ...aufbereiten(data, site, imageCount, keyword, kategorien), ...usage };
}

/* ------------------------------------------------------------------ Backlink */

const BACKLINK_SCHEMA = JSON.parse(JSON.stringify(ARTICLE_SCHEMA));
BACKLINK_SCHEMA.properties.longtails = {
  type: 'array',
  description: '6 bis 10 abgeleitete Suchbegriffe, die im Text tatsaechlich vorkommen',
  items: { type: 'string' },
};
BACKLINK_SCHEMA.properties.anchor_satz = {
  type: 'string',
  description: 'Der Satz, in dem der Platzhalter [[BACKLINK]] steht',
};
BACKLINK_SCHEMA.required = [...BACKLINK_SCHEMA.required, 'longtails'];

function backlinkSystemPrompt() {
  return (settings.get('backlink_prompt') || '').trim() || require('./prompts').DEFAULT_BACKLINK_PROMPT;
}

/**
 * Wie oft steht das Keyword im Text, gemessen am Gesamtumfang?
 *
 * Gezaehlt wird als Wortfolge, nicht als Zeichenkette: "kaffee entkalken" trifft
 * auch "Kaffee entkalken", aber nicht "Kaffeemaschine". Unter 0,3 Prozent ist der
 * Text am Thema vorbei, ueber 2,5 Prozent wird es Stuffing.
 */
function keywordDichte(html, keyword) {
  const worte = String(html || '').replace(/<[^>]*>/g, ' ').toLowerCase()
    .replace(/[^a-zäöüß0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const gesucht = String(keyword || '').toLowerCase()
    .replace(/[^a-zäöüß0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!worte.length || !gesucht.length) return { treffer: 0, woerter: worte.length, prozent: 0 };

  let treffer = 0;
  for (let i = 0; i + gesucht.length <= worte.length; i += 1) {
    if (gesucht.every((wort, n) => worte[i + n] === wort)) treffer += 1;
  }
  return {
    treffer,
    woerter: worte.length,
    prozent: Math.round(((treffer * gesucht.length) / worte.length) * 10000) / 100,
  };
}

/**
 * Ein Beitrag, der genau einmal auf eine bestimmte Seite verweist.
 *
 * Den Link setzt der Hub, nicht das Modell: Das Modell schreibt nur den Platzhalter,
 * damit Adresse und rel-Angabe verlaesslich stimmen und nicht mehr als ein Verweis
 * entsteht.
 */
async function generateBacklink({ site, auftrag, anchor, imageCount = 0, categories = [] }) {
  const wordCount = Number(site.word_count) || Number(settings.get('default_word_count')) || 1200;
  const kategorien = categories.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);

  const system = `${backlinkSystemPrompt()}

═══════════════════════════════════════════════════════════════════
REGELWERK FUER ARTIKEL
═══════════════════════════════════════════════════════════════════

${articleSystemPrompt()}`;

  const prompt = `${siteBriefing(site)}

Aufgabe: Schreibe einen Beitrag für diese Website, der genau einmal auf die
Zielseite verweist.
Hauptkeyword: ${auftrag.keyword}
${auftrag.extra ? `Weitere Keywords, wo sie passen: ${auftrag.extra}\n` : ''}Ankertext für den Verweis: ${anchor}
Worum es auf der Zielseite geht: ${auftrag.note || 'nicht näher beschrieben, leite es aus dem Keyword ab'}
Ziellänge: ca. ${wordCount} Wörter als Richtwert.
${sprachHinweis(site)}
${kategorien.length
    ? `Kategorie: Wähle GENAU EINE der vorhandenen Kategorien dieser Website: ${kategorien.join(' | ')}\n`
    : ''}Bilder: ${imageCount > 0
    ? `${imageCount} Bildkonzepte. Bild 1 ist das Titelbild, die übrigen platzierst du mit [[BILD:2]] bis [[BILD:${imageCount}]] im Text.`
    : 'keine. Gib für "images" eine leere Liste zurück und setze keine Platzhalter in den Text.'}

Der Platzhalter [[BACKLINK]] steht genau einmal im Fließtext, im mittleren Drittel,
mitten in einem Satz. Der Ankertext selbst gehört nicht in den Text, nur der
Platzhalter; der Satz muss so gebaut sein, dass "${anchor}" an dieser Stelle
eingesetzt werden kann und sich natürlich liest.`;

  const { data, usage } = await runJson({
    system,
    prompt,
    schema: articleSchema(kategorien, BACKLINK_SCHEMA),
    maxTokens: 32000,
    kind: 'backlink',
    meta: { siteId: site.id, context: { keyword: auftrag.keyword, ziel: auftrag.url, anchor } },
  });

  const fertig = aufbereiten(data, site, imageCount, auftrag.keyword, kategorien);
  const longtails = (Array.isArray(data.longtails) ? data.longtails : [])
    .map((t) => sanitizeText(t, 120)).filter(Boolean).slice(0, 12);

  return { ...fertig, longtails, anchor_satz: sanitizeText(data.anchor_satz, 400), ...usage };
}

const VIDEO_SCHEMA = JSON.parse(JSON.stringify(ARTICLE_SCHEMA));
VIDEO_SCHEMA.properties.verwertbar = {
  type: 'boolean',
  description: 'false, wenn das Transkript zu duenn oder inhaltsleer fuer einen Artikel ist',
};
VIDEO_SCHEMA.properties.begruendung = {
  type: 'string',
  description: 'Bei verwertbar=false ein Satz, warum daraus kein Artikel entstehen kann. Sonst leer.',
};
VIDEO_SCHEMA.required = [...ARTICLE_SCHEMA.required, 'verwertbar', 'begruendung'];

function videoSystemPrompt() {
  return (settings.get('video_prompt') || '').trim() || require('./prompts').DEFAULT_VIDEO_PROMPT;
}

/**
 * Artikel aus einem Video-Transkript.
 * Vorn steht die Anweisung fuer Videos, danach unveraendert das Regelwerk fuer Artikel.
 */
async function generateFromVideo({ site, video, transcript, imageCount = 0, categories = [], angle = '' }) {
  const wordCount = site.word_count || Number(settings.get('default_word_count')) || 1200;
  const kategorien = categories.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);

  const system = `${videoSystemPrompt()}

═══════════════════════════════════════════════════════════════════
REGELWERK FUER ARTIKEL
═══════════════════════════════════════════════════════════════════

${articleSystemPrompt()}`;

  const prompt = `${siteBriefing(site)}

Aufgabe: Schreibe einen Artikel auf Grundlage des folgenden Video-Transkripts.
Titel des Videos: ${video.title}
${angle ? `Gewünschter Blickwinkel: ${angle}\n` : ''}Ziellänge: ca. ${wordCount} Wörter als Richtwert.
${sprachHinweis(site)}
${kategorien.length
    ? `Kategorie: Wähle GENAU EINE der vorhandenen Kategorien dieser Website: ${kategorien.join(' | ')}\n`
    : ''}Bilder: ${imageCount > 0
    ? `${imageCount} Bildkonzepte. Bild 1 ist das Titelbild, die übrigen platzierst du mit [[BILD:2]] bis [[BILD:${imageCount}]] im Text.`
    : 'keine. Gib für "images" eine leere Liste zurück.'}

Gibt das Transkript keinen eigenständigen Artikel her, setze "verwertbar" auf false und
begründe es in einem Satz. Die übrigen Felder bleiben dann leer.

TRANSKRIPT
${transcript}`;

  const { data, usage } = await runJson({
    system,
    prompt,
    schema: articleSchema(kategorien, VIDEO_SCHEMA),
    maxTokens: 32000,
    kind: 'video',
    meta: {
      siteId: site.id,
      context: { video_id: video.video_id, titel: video.title, transkript_woerter: transcript.split(' ').length },
    },
  });

  if (data.verwertbar === false) {
    throw new AiError(`Aus diesem Video laesst sich kein Artikel machen: ${data.begruendung || 'kein verwertbarer Inhalt'}`);
  }
  return { ...aufbereiten(data, site, imageCount, video.title, kategorien), ...usage };
}

const TOPICS_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Suchbegriff oder Thema' },
          angle: { type: 'string', description: 'Ein Satz: welchen Blickwinkel der Artikel nimmt' },
        },
        required: ['keyword', 'angle'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

async function suggestTopics({ site, count = 10, existing = [] }) {
  const prompt = `${siteBriefing(site)}

Aufgabe: Schlage ${count} Themen für neue Blogartikel vor, die zu dieser Website passen und realistisches Suchinteresse haben.
Mische Ratgeber-, Vergleichs- und Grundlagenthemen. Jedes Thema muss sich klar von den anderen unterscheiden.
Die Themen stehen in der Sprache der Website (${SPRACHEN[site.language] || site.language || 'Deutsch'}), denn daraus werden die Artikel.
${existing.length ? `Diese Themen existieren bereits und dürfen NICHT wiederholt werden:\n- ${existing.slice(0, 60).join('\n- ')}` : ''}`;

  const { data } = await runJson({
    system: topicSystemPrompt(),
    prompt,
    schema: TOPICS_SCHEMA,
    maxTokens: 8000,
    kind: 'topics',
    meta: { siteId: site.id, context: { count, existing_count: existing.length } },
  });

  return (Array.isArray(data.topics) ? data.topics : [])
    .map((t) => ({ keyword: sanitizeText(t.keyword, 160), angle: sanitizeText(t.angle, 300) }))
    .filter((t) => t.keyword);
}

// aufbereiten wird von der Funktionspruefung direkt aufgerufen, ohne Anthropic zu behelligen.
module.exports = {
  MODELS, AiError, generateArticle, generateFromVideo, generateTargeted, generateBacklink,
  suggestTopics, aufbereiten, keywordDichte,
};
