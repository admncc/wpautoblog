'use strict';
const crypto = require('crypto');
const { log } = require('./db');

/**
 * Komfortschicht ueber dem Protokoll.
 * Ziel: Jede Aktion im System hinterlaesst eine Spur mit Dauer, Ergebnis und Kontext,
 * damit die Diagnose-Seite spaeter ein vollstaendiges Bild liefert.
 */
const make = (level) => (category, action, message, meta = {}) =>
  log(level, message, { ...meta, category, action });

const logger = {
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error'),
};

/**
 * Misst die Dauer eines Vorgangs.
 * const done = logger.start('ai', 'article', 'Artikel wird erzeugt', { siteId });
 * done.ok('fertig', { words: 900 })  |  done.fail(err)
 */
logger.start = (category, action, message, meta = {}) => {
  const started = Date.now();
  logger.debug(category, `${action}.start`, message, meta);
  const finish = (level, text, extra = {}) =>
    log(level, text, {
      ...meta,
      ...extra,
      category,
      action,
      durationMs: Date.now() - started,
      context: { ...(meta.context || {}), ...(extra.context || {}) },
    });
  return {
    ok: (text, extra) => finish('info', text, extra),
    warn: (text, extra) => finish('warn', text, extra),
    fail: (err, extra) =>
      finish('error', typeof err === 'string' ? err : `${err.message || err}`, {
        ...extra,
        context: { ...(extra && extra.context ? extra.context : {}), stack: err && err.stack ? String(err.stack).slice(0, 1500) : undefined },
      }),
    elapsed: () => Date.now() - started,
  };
};

const newRequestId = () => crypto.randomBytes(6).toString('hex');

/** Verkuerzt lange Texte fuer das Protokoll. */
const excerpt = (value, max = 600) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text && text.length > max ? `${text.slice(0, max)}…[${text.length} Zeichen]` : text;
};

/** Entfernt Geheimnisse aus Objekten, bevor sie ins Protokoll wandern. */
const SECRET_KEYS = /token|secret|password|api_key|apikey|signature|authorization|cookie/i;
function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) {
      const text = String(val ?? '');
      out[key] = text ? `${text.slice(0, 4)}…(${text.length} Zeichen)` : '';
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

/**
 * Adressen, die selbst ein Geheimnis tragen, gehoeren nicht ins Protokoll.
 *
 * Der Diagnose-Bericht gibt das Protokoll an Dritte weiter. Stuenden dort die
 * signierten Einmal-Adressen im Klartext, haette der Helfer damit gueltige Links
 * fuer Plugin-Paket, Bilder und den Diagnose-Zugang selbst in der Hand.
 */
const GEHEIME_PFADE = /^\/(plugin|media|diagnose)\/[^/]+/;
const pfadKuerzen = (adresse) =>
  String(adresse || '').replace(GEHEIME_PFADE, (treffer) => `${treffer.split('/').slice(0, 2).join('/')}/…`);

/** Express-Middleware: protokolliert jede HTTP-Anfrage samt Dauer und Status. */
function httpLogger(req, res, next) {
  req.requestId = newRequestId();
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.requestId);

  res.on('finish', () => {
    const durationMs = Date.now() - req.startedAt;
    const isAsset = /\.(css|js|ico|png|svg|woff2?)$/i.test(req.path);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : isAsset ? 'debug' : 'info';

    log(level, `${req.method} ${pfadKuerzen(req.originalUrl)} → ${res.statusCode} (${durationMs} ms)`, {
      category: 'http',
      action: 'request',
      requestId: req.requestId,
      durationMs,
      status: res.statusCode,
      siteId: (req.site && req.site.id) || null,
      context: {
        ip: req.ip,
        user: req.user ? req.user.email : null,
        query: Object.keys(req.query || {}).length ? redact(req.query) : undefined,
        body: req.method !== 'GET' && req.body ? excerpt(JSON.stringify(redact(req.body)), 1500) : undefined,
        userAgent: req.get('user-agent') ? String(req.get('user-agent')).slice(0, 120) : undefined,
      },
    });
  });

  next();
}

module.exports = { logger, httpLogger, newRequestId, excerpt, redact };
