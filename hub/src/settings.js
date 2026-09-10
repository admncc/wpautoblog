'use strict';
const { getSetting, setSetting } = require('./db');
const { encrypt, decrypt } = require('./util');
const { ENV_ANTHROPIC_KEY, DEFAULT_MODEL } = require('./config');
const { DEFAULT_ARTICLE_PROMPT, DEFAULT_TOPIC_PROMPT, DEFAULT_VIDEO_PROMPT } = require('./prompts');

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
  // YouTube-Beobachtung. Voreingestellt probiert der Hub alle Wege der Reihe nach,
  // weil der RSS-Feed von Servern aus oft nicht erreichbar ist.
  youtube_enabled: '0',
  youtube_source: 'auto',                       // auto | feed | supadata | google | seite
  transcript_provider: 'supadata',              // supadata | custom
  transcript_url: 'https://api.supadata.ai/v1/youtube/transcript?url={video_url}&lang={lang}&text=true',
  transcript_header: 'x-api-key',
  video_prompt: DEFAULT_VIDEO_PROMPT,
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

/** Schluessel des Transkript-Dienstes und optionaler Google-Schluessel. */
function setTranscriptKey(key) {
  setSetting('transcript_api_key', key ? encrypt(key.trim()) : '');
}
function getTranscriptKey() {
  return decrypt(getSetting('transcript_api_key', '')) || process.env.TRANSCRIPT_API_KEY || '';
}
function transcriptKeyInfo() {
  const key = getTranscriptKey();
  return key ? { configured: true, hint: `${key.slice(0, 6)}…${key.slice(-4)}` } : { configured: false, hint: '' };
}

function setYoutubeKey(key) {
  setSetting('youtube_api_key', key ? encrypt(key.trim()) : '');
}
function getYoutubeKey() {
  return decrypt(getSetting('youtube_api_key', '')) || process.env.YOUTUBE_API_KEY || '';
}
function youtubeKeyInfo() {
  const key = getYoutubeKey();
  return key ? { configured: true, hint: `${key.slice(0, 6)}…${key.slice(-4)}` } : { configured: false, hint: '' };
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
  setSetting('video_prompt', DEFAULTS.video_prompt);
}

module.exports = {
  all, get, save, resetPrompts, DEFAULTS,
  setApiKey, getApiKey, apiKeyInfo,
  setImageKey, getImageKey, imageKeyInfo,
  setTranscriptKey, getTranscriptKey, transcriptKeyInfo,
  setYoutubeKey, getYoutubeKey, youtubeKeyInfo,
};
