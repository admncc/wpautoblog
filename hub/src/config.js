'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// APP_SECRET verschluesselt gespeicherte API-Keys und signiert Login-Cookies.
// Wird beim ersten Start automatisch erzeugt und in data/.app_secret abgelegt.
function loadSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, '.app_secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

module.exports = {
  ROOT,
  DATA_DIR,
  PORT: Number(process.env.PORT || 4000),
  HOST: process.env.HOST || '0.0.0.0',
  DB_FILE: process.env.DB_FILE || path.join(DATA_DIR, 'autoblog.sqlite'),
  APP_SECRET: loadSecret(),
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Fallback-Key aus der Umgebung; in der Oberflaeche gesetzte Keys haben Vorrang.
  ENV_ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || '',
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || 'claude-opus-5',
  SESSION_DAYS: 30,
  VERSION: '1.0.0',
};
