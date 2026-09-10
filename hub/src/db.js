'use strict';
const Database = require('better-sqlite3');
const { DB_FILE } = require('./config');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | connected | error
  secret         TEXT,                              -- Website-Token, verschluesselt (AES-GCM)
  language       TEXT NOT NULL DEFAULT 'de',
  audience       TEXT NOT NULL DEFAULT '',
  tone           TEXT NOT NULL DEFAULT 'informativ, freundlich, praxisnah',
  topic_focus    TEXT NOT NULL DEFAULT '',
  word_count     INTEGER NOT NULL DEFAULT 1200,
  extra_prompt   TEXT NOT NULL DEFAULT '',
  wp_status      TEXT NOT NULL DEFAULT 'draft',     -- draft | publish | pending | future
  wp_category    TEXT NOT NULL DEFAULT '',
  wp_author_id   INTEGER,
  delivery       TEXT NOT NULL DEFAULT 'push',      -- push: Hub ruft WordPress | pull: WordPress holt ab
  categories     TEXT,                              -- von WordPress gemeldet, als JSON
  categories_at  TEXT,                              -- wann zuletzt gemeldet
  wp_version     TEXT,
  plugin_version TEXT,
  last_seen_at   TEXT,
  connected_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL,
  angle      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',          -- open | used | archived
  source     TEXT NOT NULL DEFAULT 'manual',        -- manual | ai
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Wiederkehrende Posts: Themenbereiche + Takt je Website
CREATE TABLE IF NOT EXISTS plans (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'Redaktionsplan',
  areas        TEXT NOT NULL DEFAULT '',            -- Themenbereiche, eine Zeile je Bereich
  per_week     INTEGER NOT NULL DEFAULT 2,
  publish_hour INTEGER NOT NULL DEFAULT 9,
  auto_publish INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  next_run_at  TEXT,
  last_run_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  topic_id      TEXT REFERENCES topics(id) ON DELETE SET NULL,
  title         TEXT NOT NULL DEFAULT '',
  slug          TEXT NOT NULL DEFAULT '',
  excerpt       TEXT NOT NULL DEFAULT '',
  content_html  TEXT NOT NULL DEFAULT '',
  meta_title    TEXT NOT NULL DEFAULT '',
  meta_desc     TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',           -- kommagetrennt
  category      TEXT NOT NULL DEFAULT '',
  keyword       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',      -- generating | draft | approved | publishing | published | failed
  word_count    INTEGER NOT NULL DEFAULT 0,
  model         TEXT NOT NULL DEFAULT '',
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  wp_post_id    INTEGER,
  wp_url        TEXT,
  error         TEXT,
  origin        TEXT NOT NULL DEFAULT 'manual',
  notice        TEXT,                               -- nicht kritischer Hinweis, z. B. zu Bildern
  archived      INTEGER NOT NULL DEFAULT 0,         -- 1 = erledigt, aus der Arbeitsliste geraeumt
  archived_at   TEXT,
  published_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Beobachtete YouTube-Kanaele je Website
CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  channel_id     TEXT NOT NULL,                     -- UC...
  handle         TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL DEFAULT '',
  active         INTEGER NOT NULL DEFAULT 1,
  auto_article   INTEGER NOT NULL DEFAULT 1,        -- Artikel automatisch erzeugen
  embed_video    INTEGER NOT NULL DEFAULT 1,        -- Video im Beitrag einbetten
  interval_hours INTEGER NOT NULL DEFAULT 24,       -- wie oft geprueft wird
  max_per_scan   INTEGER NOT NULL DEFAULT 1,        -- wie viele Videos je Durchlauf
  angle          TEXT NOT NULL DEFAULT '',          -- fester Blickwinkel fuer diesen Kanal
  last_check_at  TEXT,
  last_error     TEXT,
  next_check_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, channel_id)
);

-- Gefundene Videos und was daraus wurde
CREATE TABLE IF NOT EXISTS videos (
  id           TEXT PRIMARY KEY,
  channel_ref  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  site_id      TEXT NOT NULL,
  video_id     TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  status       TEXT NOT NULL DEFAULT 'neu',         -- neu | transkribiert | artikel | uebersprungen | fehler
  transcript   TEXT,
  words        INTEGER NOT NULL DEFAULT 0,
  article_id   TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Erzeugte Bilder. Die Datei liegt unter DATA_DIR/images, der Token macht sie
-- ueber eine nicht erratbare URL fuer WordPress abrufbar.
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  site_id    TEXT,
  slot       INTEGER NOT NULL DEFAULT 1,          -- 1 = Titelbild, ab 2 im Text
  motif      TEXT NOT NULL DEFAULT '',
  alt        TEXT NOT NULL DEFAULT '',
  caption    TEXT NOT NULL DEFAULT '',
  token      TEXT NOT NULL UNIQUE,
  file       TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'image/png',
  bytes      INTEGER NOT NULL DEFAULT 0,
  provider   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending',     -- pending | ready | failed
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  level       TEXT NOT NULL DEFAULT 'info',         -- debug | info | warn | error
  category    TEXT NOT NULL DEFAULT 'app',          -- http | ai | wordpress | plugin | plan | auth | system
  action      TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL,
  site_id     TEXT,
  article_id  TEXT,
  request_id  TEXT,
  duration_ms INTEGER,
  http_status INTEGER,
  context     TEXT,                                 -- JSON mit Details
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plans_site   ON plans(site_id, active);
CREATE INDEX IF NOT EXISTS idx_articles_site ON articles(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topics_site   ON topics(site_id, status);
CREATE INDEX IF NOT EXISTS idx_channels_site  ON channels(site_id, active);
CREATE INDEX IF NOT EXISTS idx_videos_channel  ON videos(channel_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_article ON images(article_id, slot);
CREATE INDEX IF NOT EXISTS idx_logs_created  ON logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level    ON logs(level, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_request  ON logs(request_id);
`);

// Nachtraeglich ergaenzte Spalten fuer bestehende Installationen anlegen.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('sites', 'delivery', "TEXT NOT NULL DEFAULT 'push'");
ensureColumn('sites', 'categories', 'TEXT');
ensureColumn('sites', 'categories_at', 'TEXT');
ensureColumn('topics', 'plan_id', 'TEXT');
ensureColumn('articles', 'plan_id', 'TEXT');
ensureColumn('articles', 'archived', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('articles', 'archived_at', 'TEXT');
ensureColumn('articles', 'notice', 'TEXT');
ensureColumn('articles', 'source_url', 'TEXT');
ensureColumn('articles', 'source_title', 'TEXT');
ensureColumn('channels', 'max_per_scan', 'INTEGER NOT NULL DEFAULT 1');
// Zaehler des Durchlaufs: Die Videoliste zeigt nur, was der letzte Durchlauf gemeldet hat.
ensureColumn('channels', 'scan_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('videos', 'run_no', 'INTEGER NOT NULL DEFAULT 0');
// Fehlgeschlagene Videos bekommen mehrere Anlaeufe, bevor ein anderes nachrueckt.
ensureColumn('videos', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('videos', 'retry_at', 'TEXT');
ensureColumn('videos', 'skip_reason', 'TEXT');

const setSettingStmt = db.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
);
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');

function setSetting(key, value) {
  setSettingStmt.run(key, value == null ? null : String(value));
}
function getSetting(key, fallback = '') {
  const row = getSettingStmt.get(key);
  return row && row.value != null ? row.value : fallback;
}

const insertLog = db.prepare(
  `INSERT INTO logs (level, category, action, message, site_id, article_id, request_id, duration_ms, http_status, context)
   VALUES (@level, @category, @action, @message, @site_id, @article_id, @request_id, @duration_ms, @http_status, @context)`
);

/**
 * Schreibt einen Eintrag ins Protokoll. Absichtlich sehr gespraechig:
 * jede Anfrage, jeder KI-Aufruf und jede WordPress-Uebertragung landet hier,
 * damit sich Probleme spaeter ueber die Diagnose-Seite nachvollziehen lassen.
 */
function log(level, message, meta = {}) {
  const entry = {
    level,
    category: meta.category || 'app',
    action: meta.action || '',
    message: String(message).slice(0, 4000),
    site_id: meta.siteId || null,
    article_id: meta.articleId || null,
    request_id: meta.requestId || null,
    duration_ms: Number.isFinite(meta.durationMs) ? Math.round(meta.durationMs) : null,
    http_status: Number.isFinite(meta.status) ? meta.status : null,
    context: meta.context ? JSON.stringify(meta.context).slice(0, 20000) : null,
  };
  try {
    insertLog.run(entry);
  } catch (err) {
    console.error('Protokoll konnte nicht geschrieben werden:', err.message);
  }

  if (level === 'debug') return; // Debug nur in der Datenbank, nicht auf der Konsole
  const stamp = new Date().toISOString();
  const prefix = `[${stamp}] ${entry.category}${entry.action ? '/' + entry.action : ''}:`;
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);
}

/** Aeltere Protokolleintraege ausduennen, damit die Datei nicht endlos waechst. */
const LOG_RETENTION_DAYS = 7;

function pruneLogs(days = LOG_RETENTION_DAYS) {
  const kept = Math.max(1, Number(days) || LOG_RETENTION_DAYS);
  const result = db.prepare(`DELETE FROM logs WHERE created_at < datetime('now', '-${kept} days')`).run();
  // Debug-Eintraege sind die mit Abstand groesste Gruppe und leben kuerzer.
  const debug = db.prepare("DELETE FROM logs WHERE level = 'debug' AND created_at < datetime('now', '-2 days')").run();
  return result.changes + debug.changes;
}

module.exports = { db, setSetting, getSetting, log, pruneLogs, LOG_RETENTION_DAYS };
