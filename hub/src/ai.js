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
  } catch (err) {
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

function siteBriefing(site) {
  const global = settings.all();
  const lines = [
    `Website: ${site.name}${site.url ? ` (${site.url})` : ''}`,
    `Sprache: ${site.language || 'de'}`,
    `Zielgruppe: ${site.audience || 'allgemeines Fachpublikum'}`,
    `Tonalitaet: ${site.tone || global.default_tone}`,
  ];
  if (site.topic_focus) lines.push(`Themenschwerpunkte: ${site.topic_focus}`);
  if (global.brand_name) lines.push(`Marke: ${global.brand_name}`);
  if (global.brand_description) lines.push(`Ueber die Marke: ${global.brand_description}`);
  if (global.global_prompt) lines.push(`Grundsaetzliche Vorgaben: ${global.global_prompt}`);
  if (site.extra_prompt) lines.push(`Zusaetzliche Vorgaben fuer diese Website: ${site.extra_prompt}`);
  return lines.join('\n');
}

/**
 * Baut das Antwortschema. Kennt der Hub die Kategorien der Website, wird das Feld
 * auf genau diese Werte eingegrenzt. Dann kann Claude keine neue erfinden.
 */
function articleSchema(kategorien = []) {
  const schema = JSON.parse(JSON.stringify(ARTICLE_SCHEMA));
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

Aufgabe: Schreibe einen vollstaendigen Blogartikel.
Hauptkeyword / Thema: ${keyword}
${angle ? `Gewuenschter Blickwinkel: ${angle}\n` : ''}Ziellaenge: ca. ${wordCount} Woerter als Richtwert.
Sprache: ${site.language === 'en' ? 'Englisch' : site.language === 'fr' ? 'Franzoesisch' : site.language === 'es' ? 'Spanisch' : 'Deutsch'}.
${kategorien.length
    ? `Kategorie: Waehle GENAU EINE aus den vorhandenen Kategorien dieser Website. `
      + `Lege keine neue an und weiche nicht ab. Passt keine gut, nimm die am wenigsten unpassende.\n`
      + `Vorhandene Kategorien: ${kategorien.join(' | ')}\n`
    : ''}Bilder: ${imageCount > 0
    ? `${imageCount} Bildkonzepte. Bild 1 ist das Titelbild, die uebrigen platzierst du mit [[BILD:2]] bis [[BILD:${imageCount}]] im Text.`
    : 'keine. Gib fuer "images" eine leere Liste zurueck und setze keine Platzhalter in den Text.'}`;

  const { data, usage } = await runJson({
    system: articleSystemPrompt(),
    prompt,
    schema: articleSchema(kategorien),
    maxTokens: 32000,
    kind: 'article',
    meta: { siteId: site.id, context: { keyword, angle, target_words: wordCount } },
  });

  const images = (Array.isArray(data.images) ? data.images : [])
    .slice(0, Math.max(0, imageCount))
    .map((img, index) => ({
      slot: Number(img.slot) || index + 1,
      motif: sanitizeText(img.motif, 2000),
      alt: sanitizeText(img.alt, 300),
      caption: sanitizeText(img.caption, 300),
    }))
    .filter((img) => img.motif);

  const emDashes = countEmDash(data.content_html) + countEmDash(data.title) + countEmDash(data.meta_description);
  if (emDashes) {
    logger.warn('ai', 'emdash', `${emDashes} lange Gedankenstriche ersetzt`, {
      siteId: site.id,
      context: { keyword, count: emDashes },
    });
  }

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
    ...usage,
  };
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

Aufgabe: Schlage ${count} Themen fuer neue Blogartikel vor, die zu dieser Website passen und realistisches Suchinteresse haben.
Mische Ratgeber-, Vergleichs- und Grundlagenthemen. Jedes Thema muss sich klar von den anderen unterscheiden.
${existing.length ? `Diese Themen existieren bereits und duerfen NICHT wiederholt werden:\n- ${existing.slice(0, 60).join('\n- ')}` : ''}`;

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

module.exports = { MODELS, AiError, generateArticle, suggestTopics };
