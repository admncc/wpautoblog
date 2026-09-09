'use strict';
const { getSetting, setSetting } = require('./db');
const { encrypt, decrypt } = require('./util');
const { ENV_ANTHROPIC_KEY, DEFAULT_MODEL } = require('./config');
const { DEFAULT_ARTICLE_PROMPT, DEFAULT_TOPIC_PROMPT } = require('./prompts');

const DEFAULTS = {
  hub_name: 'Autoblog Hub',
  model: DEFAULT_MODEL,
  effort: 'high',
  brand_name: '',
  brand_description: '',
  default_language: 'de',
  default_word_count: '1200',
  default_tone: 'informativ, freundlich, praxisnah',
  global_prompt: '',
  article_prompt: DEFAULT_ARTICLE_PROMPT,
  topic_prompt: DEFAULT_TOPIC_PROMPT,
  // Bilder: Anthropic erzeugt keine Bilder, daher ein eigener Dienst.
  image_provider: 'none',                       // none | openai
  image_base_url: 'https://api.openai.com/v1',  // jeder OpenAI-kompatible Endpunkt
  image_model: 'gpt-image-1',
  image_size: '1536x1024',
  image_quality: 'high',
  image_style: 'natural documentary photography, soft daylight, shallow depth of field, no text',
  images_per_article: '3',
};

function all() {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) out[key] = getSetting(key, fallback);
  return out;
}

function get(key) {
  return getSetting(key, DEFAULTS[key] ?? '');
}

function save(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULTS) setSetting(key, value);
  }
}

/** Bild-API-Key, ebenfalls verschluesselt abgelegt. */
function setImageKey(key) {
  setSetting('image_api_key', key ? encrypt(key.trim()) : '');
}

function getImageKey() {
  return decrypt(getSetting('image_api_key', '')) || process.env.IMAGE_API_KEY || '';
}

function imageKeyInfo() {
  const key = getImageKey();
  if (!key) return { configured: false, hint: '' };
  return { configured: true, hint: `${key.slice(0, 8)}…${key.slice(-4)}` };
}

/** Der API-Key wird verschluesselt abgelegt und nie im Klartext ausgeliefert. */
function setApiKey(key) {
  setSetting('anthropic_api_key', key ? encrypt(key.trim()) : '');
}

function getApiKey() {
  const stored = decrypt(getSetting('anthropic_api_key', ''));
  return stored || ENV_ANTHROPIC_KEY || '';
}

function apiKeyInfo() {
  const key = getApiKey();
  if (!key) return { configured: false, hint: '', source: null };
  return {
    configured: true,
    hint: `${key.slice(0, 10)}…${key.slice(-4)}`,
    source: decrypt(getSetting('anthropic_api_key', '')) ? 'ui' : 'env',
  };
}

/** Prompt-Framework auf die mitgelieferte Vorlage zuruecksetzen. */
function resetPrompts() {
  setSetting('article_prompt', DEFAULTS.article_prompt);
  setSetting('topic_prompt', DEFAULTS.topic_prompt);
}

module.exports = { all, get, save, setApiKey, getApiKey, apiKeyInfo, setImageKey, getImageKey, imageKeyInfo, resetPrompts, DEFAULTS };
