'use strict';
const os = require('os');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const { logger, redact } = require('./logger');
const { decrypt, safeEqual } = require('./util');
const settings = require('./settings');
const config = require('./config');

const TOKEN_KEY = 'diagnostics_token';
const CREATED_KEY = 'diagnostics_created';
const VALID_HOURS = 72;

/**
 * Erzeugt einen neuen Diagnose-Token. Jede Aktivierung ersetzt den vorherigen -
 * ein alter Link funktioniert danach nicht mehr.
 */
function enable() {
  const token = crypto.randomBytes(24).toString('base64url');
  setSetting(TOKEN_KEY, token);
  setSetting(CREATED_KEY, new Date().toISOString());
  logger.warn('diagnostics', 'enable', 'Diagnose-Zugang aktiviert (neuer Token erzeugt)', {
    context: { valid_hours: VALID_HOURS },
  });
  return { token, url: buildUrl(token), created: getSetting(CREATED_KEY), validHours: VALID_HOURS };
}

function disable() {
  setSetting(TOKEN_KEY, '');
  setSetting(CREATED_KEY, '');
  logger.warn('diagnostics', 'disable', 'Diagnose-Zugang deaktiviert');
}

function buildUrl(token) {
  const base = config.PUBLIC_URL || `http://localhost:${config.PORT}`;
  return `${base}/diagnose/${token}`;
}

function status() {
  const token = getSetting(TOKEN_KEY, '');
  if (!token) return { active: false };
  const created = getSetting(CREATED_KEY, '');
  const expiresAt = new Date(new Date(created).getTime() + VALID_HOURS * 3600 * 1000);
  return {
    active: expiresAt > new Date(),
    created,
    expiresAt: expiresAt.toISOString(),
    url: buildUrl(token),
    validHours: VALID_HOURS,
  };
}

/** Prueft den Token aus der URL. Laeuft nach VALID_HOURS automatisch ab. */
function verify(token) {
  const stored = getSetting(TOKEN_KEY, '');
  if (!stored || !token) return false;
  if (!safeEqual(stored, token)) return false;
  const created = new Date(getSetting(CREATED_KEY, 0)).getTime();
  return Date.now() - created <= VALID_HOURS * 3600 * 1000;
}

/**
 * Vollstaendiger Zustandsbericht.
 * Geheimnisse (API-Key, Website-Tokens) werden bewusst nur maskiert ausgegeben.
 */
function report({ limit = 500, level = null, category = null } = {}) {
  const mask = (value) => (value ? `${String(value).slice(0, 8)}…(${String(value).length} Zeichen)` : null);

  const filters = [];
  const params = { limit: Math.min(3000, Math.max(10, Number(limit) || 500)) };
  if (level) { filters.push('level = @level'); params.level = level; }
  if (category) { filters.push('category = @category'); params.category = category; }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const logs = db
    .prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT @limit`)
    .all(params)
    .map((entry) => ({ ...entry, context: entry.context ? safeParse(entry.context) : null }));

  return {
    generated_at: new Date().toISOString(),
    hub: {
      version: config.VERSION,
      public_url: config.PUBLIC_URL || null,
      port: config.PORT,
      data_dir: config.DATA_DIR,
      db_file: config.DB_FILE,
      uptime_seconds: Math.round(process.uptime()),
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      server_time_utc: new Date().toISOString(),
    },
    system: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      free_memory_mb: Math.round(os.freemem() / 1048576),
      load_average: os.loadavg().map((n) => Number(n.toFixed(2))),
    },
    settings: {
      ...redact(settings.all()),
      api_key: settings.apiKeyInfo(),
    },
    counts: {
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      sites: db.prepare('SELECT COUNT(*) AS n FROM sites').get().n,
      sites_connected: db.prepare("SELECT COUNT(*) AS n FROM sites WHERE status = 'connected'").get().n,
      plans_active: db.prepare('SELECT COUNT(*) AS n FROM plans WHERE active = 1').get().n,
      topics_open: db.prepare("SELECT COUNT(*) AS n FROM topics WHERE status = 'open'").get().n,
      articles: db.prepare('SELECT COUNT(*) AS n FROM articles').get().n,
      logs: db.prepare('SELECT COUNT(*) AS n FROM logs').get().n,
    },
    articles_by_status: db.prepare('SELECT status, COUNT(*) AS n FROM articles GROUP BY status').all(),
    errors_24h: db
      .prepare("SELECT COUNT(*) AS n FROM logs WHERE level = 'error' AND created_at >= datetime('now','-1 day')")
      .get().n,
    token_usage: db
      .prepare(
        `SELECT COUNT(*) AS articles, COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out, model
         FROM articles WHERE model != '' GROUP BY model`
      )
      .all(),
    sites: db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all().map((site) => ({
      ...site,
      secret: mask(decrypt(site.secret)),
    })),
    plans: db.prepare('SELECT * FROM plans ORDER BY created_at DESC').all(),
    recent_articles: db
      .prepare(
        `SELECT id, site_id, plan_id, title, keyword, status, word_count, model, tokens_in, tokens_out,
                wp_post_id, wp_url, error, origin, created_at, published_at
         FROM articles ORDER BY created_at DESC LIMIT 50`
      )
      .all(),
    failures: db
      .prepare("SELECT id, site_id, title, keyword, error, updated_at FROM articles WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 25")
      .all(),
    log_summary: db
      .prepare("SELECT category, level, COUNT(*) AS n FROM logs WHERE created_at >= datetime('now','-7 days') GROUP BY category, level ORDER BY n DESC")
      .all(),
    logs,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

module.exports = { enable, disable, status, verify, report, VALID_HOURS };
