'use strict';
const express = require('express');
const { db } = require('./../db');
const { logger } = require('./../logger');
const images = require('./../images');
const pack = require('./../pluginpack');
const { sign, safeEqual, decrypt, normalizeUrl } = require('./../util');
const { safeLink } = require('./../sanitize');
const settings = require('./../settings');
const { VERSION } = require('./../config');

const router = express.Router();

/** Uebernimmt die von WordPress gemeldeten Kategorien. */
function speichereKategorien(siteId, kategorien) {
  if (!Array.isArray(kategorien)) return;
  const sauber = kategorien
    .filter((k) => k && k.name)
    .map((k) => ({
      id: Number(k.id) || 0,
      name: String(k.name).slice(0, 120),
      slug: String(k.slug || '').slice(0, 140),
      count: Number(k.count) || 0,
    }))
    .slice(0, 200);
  db.prepare("UPDATE sites SET categories = ?, categories_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(sauber), siteId);
}

/** Sucht die Website zu einem Token (Tokens liegen verschluesselt in der Datenbank). */
function findSiteByToken(token) {
  for (const site of db.prepare("SELECT * FROM sites WHERE secret IS NOT NULL AND secret != ''").all()) {
    if (safeEqual(decrypt(site.secret), token)) return site;
  }
  return null;
}

/** Prueft Zeitstempel und Signatur eines Plugin-Aufrufs. */
function verifySignature(req, res, next) {
  const siteId = req.get('X-WPAB-Site');
  const timestamp = req.get('X-WPAB-Timestamp');
  const signature = req.get('X-WPAB-Signature');
  if (!siteId || !timestamp || !signature) {
    logger.warn('plugin', 'auth', 'Aufruf ohne Signatur abgewiesen', {
      requestId: req.requestId,
      context: { path: req.path, ip: req.ip, has_site: Boolean(siteId), has_timestamp: Boolean(timestamp) },
    });
    return res.status(401).json({ ok: false, message: 'Signatur fehlt.' });
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > 300) {
    logger.warn('plugin', 'auth', `Zeitstempel abgewiesen (Abweichung ${skew} s)`, {
      siteId,
      requestId: req.requestId,
      context: { path: req.path, skew_seconds: skew, hint: 'Uhrzeit von WordPress-Server und Hub vergleichen' },
    });
    return res.status(401).json({ ok: false, message: 'Zeitstempel abgelaufen. Bitte Serverzeit pruefen.' });
  }
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  const secret = site ? decrypt(site.secret) : '';
  if (!site || !secret) {
    logger.warn('plugin', 'auth', 'Unbekannte Website-ID im Aufruf', {
      requestId: req.requestId,
      context: { path: req.path, site_id: siteId, ip: req.ip },
    });
    return res.status(401).json({ ok: false, message: 'Website unbekannt oder nicht verbunden.' });
  }
  if (!safeEqual(signature, sign(secret, timestamp, req.rawBody || ''))) {
    logger.warn('plugin', 'auth', 'Signatur stimmt nicht - vermutlich falscher Token im Plugin', {
      siteId: site.id,
      requestId: req.requestId,
      context: { path: req.path, body_bytes: (req.rawBody || '').length },
    });
    return res.status(401).json({ ok: false, message: 'Signatur ungueltig.' });
  }
  db.prepare("UPDATE sites SET last_seen_at = datetime('now') WHERE id = ?").run(site.id);
  req.site = site;
  logger.debug('plugin', 'auth', `Signatur geprueft fuer ${site.name}`, {
    siteId: site.id,
    requestId: req.requestId,
    context: { path: req.path },
  });
  next();
}

/**
 * Verbindungsaufbau: Das Plugin meldet sich mit dem Website-Token aus dem Hub.
 * Der Token ist zugleich das gemeinsame Geheimnis fuer alle spaeteren Aufrufe.
 */
router.post('/connect', (req, res) => {
  const token = String(req.body.token || '').trim();
  const siteUrl = normalizeUrl(req.body.site_url);
  if (!token) return res.status(400).json({ ok: false, message: 'Token fehlt.' });

  const site = findSiteByToken(token);
  if (!site) {
    logger.warn('plugin', 'connect', 'Verbindungsversuch mit unbekanntem Token', {
      requestId: req.requestId,
      context: { site_url: siteUrl, ip: req.ip, token_length: token.length, token_prefix: token.slice(0, 9) },
    });
    return res.status(404).json({ ok: false, message: 'Token unbekannt. Bitte im Hub kopieren und erneut einfuegen.' });
  }

  db.prepare(
    `UPDATE sites SET url = COALESCE(NULLIF(?, ''), url), status = 'connected',
       connected_at = COALESCE(connected_at, datetime('now')), last_seen_at = datetime('now'),
       wp_version = ?, plugin_version = ? WHERE id = ?`
  ).run(
    siteUrl,
    String(req.body.wp_version || '').slice(0, 40),
    String(req.body.plugin_version || '').slice(0, 40),
    site.id
  );

  speichereKategorien(site.id, req.body.categories);
  logger.info('plugin', 'connect', `WordPress verbunden: ${siteUrl || site.url}`, {
    siteId: site.id,
    requestId: req.requestId,
    context: { site_url: siteUrl, wp_version: req.body.wp_version, plugin_version: req.body.plugin_version },
  });
  res.json({
    ok: true,
    site_id: site.id,
    site_name: site.name,
    hub_name: settings.get('hub_name'),
    hub_version: VERSION,
    delivery: site.delivery,
  });
});

/** Regelmaessiger Lebenszeichen-Aufruf des Plugins. */
router.post('/heartbeat', verifySignature, (req, res) => {
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM articles WHERE site_id = ? AND status = 'publishing'")
    .get(req.site.id).n;
  if (req.body.site_url) {
    db.prepare("UPDATE sites SET url = ? WHERE id = ?").run(normalizeUrl(req.body.site_url), req.site.id);
  }
  speichereKategorien(req.site.id, req.body.categories);
  logger.debug('plugin', 'heartbeat', `Lebenszeichen von ${req.site.name}`, {
    siteId: req.site.id,
    requestId: req.requestId,
    context: { pending, delivery: req.site.delivery },
  });
  res.json({
    ok: true,
    site_name: req.site.name,
    hub_name: settings.get('hub_name'),
    delivery: req.site.delivery,
    pending,
  });
});

/**
 * Update-Pruefung des Plugins. WordPress fragt hier regelmaessig nach und
 * bekommt Version und Download-Adresse des Archivs zurueck, das der Hub baut.
 */
router.post('/update-check', verifySignature, (req, res) => {
  if (!pack.verfuegbar()) {
    return res.json({ ok: true, version: null, message: 'Der Hub haelt kein Plugin-Archiv bereit.' });
  }
  const version = pack.version();
  logger.debug('plugin-paket', 'check', `Update-Pruefung von ${req.site.name}`, {
    siteId: req.site.id,
    requestId: req.requestId,
    context: { installiert: req.body.installed_version, verfuegbar: version },
  });
  res.json({
    ok: true,
    version,
    download_url: pack.downloadUrl(req.site.id),
    requires: '6.0',
    requires_php: '7.4',
    tested: '6.9',
    slug: 'autoblog-connector',
  });
});

/** Abhol-Modus: Artikel, die auf Veroeffentlichung warten. */
router.post('/pending', verifySignature, (req, res) => {
  const limit = Math.max(1, Math.min(5, Number(req.body.limit) || 3));
  const rows = db
    .prepare("SELECT * FROM articles WHERE site_id = ? AND status = 'publishing' ORDER BY created_at ASC LIMIT ?")
    .all(req.site.id, limit);

  if (rows.length) {
    logger.info('plugin', 'pending', `${rows.length} Artikel zur Abholung uebergeben`, {
      siteId: req.site.id,
      requestId: req.requestId,
      context: { article_ids: rows.map((a) => a.id) },
    });
  }
  res.json({
    ok: true,
    articles: rows.map((a) => ({
      article_id: a.id,
      post_id: a.wp_post_id || 0,
      title: a.title,
      slug: a.slug,
      content: a.content_html,
      excerpt: a.excerpt,
      status: req.site.wp_status || 'draft',
      category: a.category || req.site.wp_category || '',
      tags: a.tags ? a.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      author_id: req.site.wp_author_id || 0,
      meta: { title: a.meta_title, description: a.meta_desc },
      images: images.forDelivery(a.id),
    })),
  });
});

/** Rueckmeldung des Plugins nach dem Anlegen eines Beitrags. */
router.post('/result', verifySignature, (req, res) => {
  const article = db
    .prepare('SELECT * FROM articles WHERE id = ? AND site_id = ?')
    .get(String(req.body.article_id || ''), req.site.id);
  if (!article) return res.status(404).json({ ok: false, message: 'Artikel nicht gefunden.' });

  if (req.body.ok === false) {
    db.prepare("UPDATE articles SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(String(req.body.message || 'Fehler in WordPress').slice(0, 500), article.id);
    logger.error('plugin', 'result', `WordPress meldet Fehler: ${req.body.message}`, {
      siteId: req.site.id,
      articleId: article.id,
      requestId: req.requestId,
    });
    return res.json({ ok: true });
  }

  const bildFehler = Array.isArray(req.body.image_errors) ? req.body.image_errors : [];
  db.prepare(
    `UPDATE articles SET status = 'published', wp_post_id = ?, wp_url = ?, error = NULL,
       notice = ?, published_at = datetime('now'), archived = 1, archived_at = datetime('now'),
       updated_at = datetime('now') WHERE id = ?`
  ).run(
    Number(req.body.post_id) || null,
    safeLink(req.body.url),
    bildFehler.length ? bildFehler.join(' ') : null,
    article.id
  );
  logger.info('plugin', 'result', `Veroeffentlicht (Abhol-Modus): ${req.body.url || req.body.post_id}`, {
    siteId: req.site.id,
    articleId: article.id,
    requestId: req.requestId,
    context: { post_id: req.body.post_id, url: req.body.url },
  });
  res.json({ ok: true });
});

/** Das Plugin wurde in WordPress getrennt. */
router.post('/disconnect', verifySignature, (req, res) => {
  db.prepare("UPDATE sites SET status = 'pending' WHERE id = ?").run(req.site.id);
  logger.warn('plugin', 'disconnect', 'Verbindung durch WordPress getrennt', { siteId: req.site.id, requestId: req.requestId });
  res.json({ ok: true });
});

module.exports = router;
