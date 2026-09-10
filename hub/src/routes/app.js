'use strict';
const express = require('express');
const { db } = require('./../db');
const { logger } = require('./../logger');
const { randomId, siteToken, encrypt, decrypt, normalizeUrl, countWords, slugify } = require('./../util');
const { sanitizeHtml, sanitizeText } = require('./../sanitize');
const settings = require('./../settings');
const service = require('./../service');
const ai = require('./../ai');
const wp = require('./../wp');
const { PUBLIC_URL, VERSION } = require('./../config');
const diagnostics = require('./../diagnostics');
const images = require('./../images');
const pack = require('./../pluginpack');
const update = require('./../update');
const youtube = require('./../youtube');

const router = express.Router();

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * Aufbereitung fuer die Oberflaeche: Das verschluesselte Geheimnis wird durch den
 * lesbaren Website-Token ersetzt, den der Nutzer ins WordPress-Plugin kopiert.
 */
function publicSite(site) {
  if (!site) return null;
  const { secret, pair_code, categories, ...rest } = site;
  let liste = [];
  try {
    liste = JSON.parse(categories || '[]');
  } catch { /* noch nichts gemeldet */ }
  return { ...rest, token: decrypt(secret), connected: site.status === 'connected', categories: liste };
}

// ---------------------------------------------------------------- Uebersicht

router.get(
  '/overview',
  wrap((req, res) => {
    const stats = {
      sites: db.prepare('SELECT COUNT(*) AS n FROM sites').get().n,
      connected: db.prepare("SELECT COUNT(*) AS n FROM sites WHERE status = 'connected'").get().n,
      articles: db.prepare('SELECT COUNT(*) AS n FROM articles').get().n,
      published: db.prepare("SELECT COUNT(*) AS n FROM articles WHERE status = 'published'").get().n,
      drafts: db.prepare("SELECT COUNT(*) AS n FROM articles WHERE status IN ('draft','approved')").get().n,
      openTopics: db.prepare("SELECT COUNT(*) AS n FROM topics WHERE status = 'open'").get().n,
      activePlans: db.prepare('SELECT COUNT(*) AS n FROM plans WHERE active = 1').get().n,
      published30d: db.prepare(
        "SELECT COUNT(*) AS n FROM articles WHERE status = 'published' AND published_at >= datetime('now','-30 days')"
      ).get().n,
    };
    res.json({
      stats,
      sites: db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all().map(publicSite),
      recentArticles: db
        .prepare(
          `SELECT a.*, s.name AS site_name FROM articles a
           JOIN sites s ON s.id = a.site_id ORDER BY a.created_at DESC LIMIT 8`
        )
        .all()
        .map(({ content_html, ...rest }) => rest),
      logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 15').all(),
      apiKey: settings.apiKeyInfo(),
      hubUrl: PUBLIC_URL,
      version: VERSION,
      pluginVersion: pack.verfuegbar() ? pack.version() : null,
    });
  })
);

// -------------------------------------------------------------------- Sites

router.get(
  '/sites',
  wrap((req, res) => {
    res.json(db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all().map(publicSite));
  })
);

router.get(
  '/sites/:id',
  wrap((req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Website nicht gefunden.' });
    res.json({
      pluginVersion: pack.verfuegbar() ? pack.version() : null,
      site: publicSite(site),
      topics: db.prepare('SELECT * FROM topics WHERE site_id = ? ORDER BY created_at DESC').all(site.id),
      plans: db.prepare('SELECT * FROM plans WHERE site_id = ? ORDER BY created_at DESC').all(site.id),
      channels: db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_ref = c.id) AS videos,
                  (SELECT COUNT(*) FROM videos v WHERE v.channel_ref = c.id AND v.status = 'artikel') AS artikel
           FROM channels c WHERE c.site_id = ? ORDER BY c.created_at DESC`
        )
        .all(site.id),
      videos: db
        .prepare(
          `SELECT v.id, v.video_id, v.title, v.status, v.published_at, v.article_id, v.error, v.words,
                  c.title AS kanal, c.auto_article, c.active AS kanal_aktiv
           FROM videos v JOIN channels c ON c.id = v.channel_ref
           WHERE v.site_id = ? ORDER BY v.published_at DESC LIMIT 40`
        )
        .all(site.id),
      youtubeAktiv: youtube.aktiv(),
      articles: db
        .prepare(`SELECT id, title, keyword, status, word_count, wp_url, created_at, published_at, origin,
                         archived, archived_at
                  FROM articles WHERE site_id = ? ORDER BY archived ASC, created_at DESC LIMIT 60`)
        .all(site.id),
    });
  })
);

router.post(
  '/sites',
  wrap((req, res) => {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Bitte einen Namen angeben.' });
    const id = randomId('site');
    db.prepare(
      `INSERT INTO sites (id, name, url, secret, language, tone, word_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      normalizeUrl(req.body.url),
      encrypt(siteToken()),
      settings.get('default_language'),
      settings.get('default_tone'),
      Number(settings.get('default_word_count')) || 1200
    );
    logger.info('site', 'create', `Website angelegt: ${name}`, { siteId: id, requestId: req.requestId, context: { name } });
    res.status(201).json(publicSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(id)));
  })
);

const SITE_FIELDS = [
  'name', 'url', 'language', 'audience', 'tone', 'topic_focus', 'word_count', 'extra_prompt',
  'wp_status', 'wp_category', 'wp_author_id', 'delivery',
];

router.patch(
  '/sites/:id',
  wrap((req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Website nicht gefunden.' });

    const patch = {};
    for (const field of SITE_FIELDS) {
      if (!(field in req.body)) continue;
      const value = req.body[field];
      if (field === 'url') patch.url = normalizeUrl(value);
      else if (['word_count', 'wp_author_id'].includes(field)) patch[field] = Number(value) || 0;
      else if (field === 'delivery') patch.delivery = value === 'pull' ? 'pull' : 'push';
      else patch[field] = sanitizeText(value, 2000);
    }
    if (Object.keys(patch).length) {
      const setClause = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE sites SET ${setClause} WHERE id = @id`).run({ ...patch, id: site.id });
    }

    res.json(publicSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id)));
  })
);

router.delete(
  '/sites/:id',
  wrap((req, res) => {
    db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
    logger.warn('site', 'delete', `Website geloescht (${req.params.id})`, { siteId: req.params.id, requestId: req.requestId });
    res.json({ ok: true });
  })
);

/**
 * Token neu erzeugen. Die alte Verbindung wird damit sofort ungueltig -
 * im WordPress-Plugin muss danach der neue Token eingetragen werden.
 */
router.post(
  '/sites/:id/token',
  wrap((req, res) => {
    const token = siteToken();
    const result = db
      .prepare("UPDATE sites SET secret = ?, status = 'pending' WHERE id = ?")
      .run(encrypt(token), req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Website nicht gefunden.' });
    logger.warn('site', 'token', 'Website-Token neu erzeugt - alte Verbindung ist ungueltig', { siteId: req.params.id, requestId: req.requestId });
    res.json({ token, hub_url: PUBLIC_URL });
  })
);

/** Stoesst das Plugin-Update auf einer Website an. */
router.post(
  '/sites/:id/update-plugin',
  wrap(async (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Website nicht gefunden.' });
    if (!pack.verfuegbar()) return res.status(400).json({ error: 'Der Hub haelt kein Plugin-Archiv bereit.' });

    try {
      const ergebnis = await wp.updatePlugin(site);
      db.prepare('UPDATE sites SET plugin_version = ? WHERE id = ?').run(String(ergebnis.version || ''), site.id);
      logger.info('site', 'plugin-update', `Plugin aktualisiert: ${ergebnis.from || '?'} auf ${ergebnis.version || '?'}`, {
        siteId: site.id,
        requestId: req.requestId,
      });
      res.json({ ok: true, ...ergebnis });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

/** Verbindungstest: Der Hub ruft das Plugin auf der WordPress-Seite auf. */
router.post(
  '/sites/:id/test',
  wrap(async (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Website nicht gefunden.' });
    if (site.delivery === 'pull') {
      return res.json({
        ok: Boolean(site.last_seen_at),
        message: site.last_seen_at
          ? `Abhol-Modus aktiv. Letztes Lebenszeichen: ${site.last_seen_at} UTC.`
          : 'Abhol-Modus: bisher kein Lebenszeichen aus WordPress erhalten.',
      });
    }
    try {
      const result = await wp.ping(site);
      db.prepare("UPDATE sites SET status = 'connected', last_seen_at = datetime('now'), wp_version = ? WHERE id = ?")
        .run(String(result.wp_version || ''), site.id);

      let kategorien = 0;
      if (Array.isArray(result.categories)) {
        kategorien = result.categories.length;
        db.prepare("UPDATE sites SET categories = ?, categories_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(result.categories.slice(0, 200)), site.id);
      }
      res.json({
        ok: true,
        message: `Verbunden mit WordPress ${result.wp_version || ''} (${result.site_name || site.url}).`
          + (kategorien ? ` ${kategorien} Kategorien uebernommen.` : ''),
        details: result,
      });
    } catch (err) {
      db.prepare("UPDATE sites SET status = 'error' WHERE id = ?").run(site.id);
      // Der signierte Aufruf ist gescheitert - jetzt herausfinden, woran es liegt.
      const schritte = await wp.diagnose(site).catch(() => []);
      logger.warn('site', 'test', `Verbindungstest fehlgeschlagen: ${err.message}`, {
        siteId: site.id,
        requestId: req.requestId,
        context: { schritte },
      });
      res.status(400).json({ ok: false, error: err.message, schritte });
    }
  })
);

// ------------------------------------------------------------------- Themen

router.post(
  '/sites/:id/topics',
  wrap((req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Website nicht gefunden.' });

    const raw = Array.isArray(req.body.keywords)
      ? req.body.keywords
      : String(req.body.keywords || '').split('\n');
    const insert = db.prepare("INSERT INTO topics (id, site_id, keyword, angle, source) VALUES (?, ?, ?, ?, 'manual')");
    let added = 0;
    for (const line of raw) {
      const keyword = sanitizeText(line, 160);
      if (!keyword) continue;
      insert.run(randomId('top'), site.id, keyword, sanitizeText(req.body.angle, 300));
      added += 1;
    }
    res.json({ added, topics: db.prepare('SELECT * FROM topics WHERE site_id = ? ORDER BY created_at DESC').all(site.id) });
  })
);

router.post(
  '/sites/:id/topics/suggest',
  wrap(async (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Website nicht gefunden.' });

    const existing = db.prepare('SELECT keyword FROM topics WHERE site_id = ?').all(site.id).map((r) => r.keyword);
    const count = Math.max(3, Math.min(20, Number(req.body.count) || 10));
    const suggestions = await ai.suggestTopics({ site, count, existing });

    const insert = db.prepare("INSERT INTO topics (id, site_id, keyword, angle, source) VALUES (?, ?, ?, ?, 'ai')");
    for (const item of suggestions) insert.run(randomId('top'), site.id, item.keyword, item.angle);
    logger.info('topics', 'suggest', `${suggestions.length} Themenvorschlaege erzeugt`, { siteId: site.id, requestId: req.requestId, context: { keywords: suggestions.map((t) => t.keyword) } });

    res.json({
      added: suggestions.length,
      topics: db.prepare('SELECT * FROM topics WHERE site_id = ? ORDER BY created_at DESC').all(site.id),
      plans: db.prepare('SELECT * FROM plans WHERE site_id = ? ORDER BY created_at DESC').all(site.id),
      channels: db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_ref = c.id) AS videos,
                  (SELECT COUNT(*) FROM videos v WHERE v.channel_ref = c.id AND v.status = 'artikel') AS artikel
           FROM channels c WHERE c.site_id = ? ORDER BY c.created_at DESC`
        )
        .all(site.id),
      videos: db
        .prepare(
          `SELECT v.id, v.video_id, v.title, v.status, v.published_at, v.article_id, v.error, v.words,
                  c.title AS kanal, c.auto_article, c.active AS kanal_aktiv
           FROM videos v JOIN channels c ON c.id = v.channel_ref
           WHERE v.site_id = ? ORDER BY v.published_at DESC LIMIT 40`
        )
        .all(site.id),
      youtubeAktiv: youtube.aktiv(),
    });
  })
);

router.delete(
  '/topics/:id',
  wrap((req, res) => {
    db.prepare('DELETE FROM topics WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

// ----------------------------------------------------------------- Artikel

router.get(
  '/articles',
  wrap((req, res) => {
    const filters = [];
    const params = {};
    if (req.query.site) { filters.push('a.site_id = @site'); params.site = req.query.site; }
    if (req.query.status) { filters.push('a.status = @status'); params.status = req.query.status; }
    // Standardmaessig zeigt die Liste die offene Arbeit; das Archiv ist eine eigene Ansicht.
    if (req.query.archived === '1') filters.push('a.archived = 1');
    else if (req.query.archived !== 'all') filters.push('a.archived = 0');
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    res.json({
      articles: db.prepare(
        `SELECT a.id, a.site_id, a.title, a.keyword, a.status, a.word_count, a.wp_url, a.origin,
                a.created_at, a.published_at, a.error, a.archived, a.archived_at, s.name AS site_name
         FROM articles a JOIN sites s ON s.id = a.site_id
         ${where} ORDER BY a.created_at DESC LIMIT 200`
      ).all(params),
      counts: {
        offen: db.prepare('SELECT COUNT(*) AS n FROM articles WHERE archived = 0').get().n,
        archiv: db.prepare('SELECT COUNT(*) AS n FROM articles WHERE archived = 1').get().n,
      },
    });
  })
);

router.get(
  '/articles/:id',
  wrap((req, res) => {
    const article = db
      .prepare('SELECT a.*, s.name AS site_name, s.wp_status FROM articles a JOIN sites s ON s.id = a.site_id WHERE a.id = ?')
      .get(req.params.id);
    if (!article) return res.status(404).json({ error: 'Artikel nicht gefunden.' });
    res.json({
      ...article,
      images: images.forArticle(article.id).map((img) => ({
        id: img.id, slot: img.slot, alt: img.alt, caption: img.caption, motif: img.motif,
        status: img.status, error: img.error, bytes: img.bytes,
        url: img.status === 'ready' ? `/media/${img.token}` : null,
      })),
      imagesEnabled: images.enabled(),
    });
  })
);

/** Bilder zu einem Artikel neu erzeugen (alte werden ersetzt). */
router.post(
  '/articles/:id/images',
  wrap(async (req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!article) return res.status(404).json({ error: 'Artikel nicht gefunden.' });
    if (!images.enabled()) {
      return res.status(400).json({ error: 'Die Bildfunktion ist nicht eingerichtet. Bitte in den Einstellungen konfigurieren.' });
    }

    const briefs = db
      .prepare('SELECT slot, motif, alt, caption FROM images WHERE article_id = ? ORDER BY slot ASC')
      .all(article.id);
    if (!briefs.length) {
      return res.status(400).json({ error: 'Zu diesem Artikel gibt es keine Bildkonzepte. Bitte den Artikel neu schreiben lassen.' });
    }

    db.prepare('DELETE FROM images WHERE article_id = ?').run(article.id);
    images.pruneOrphans();
    await images.generateForArticle(article, briefs);
    res.json({ ok: true, images: images.forArticle(article.id).length });
  })
);

/** Artikel erzeugen - laeuft im Hintergrund weiter, die Oberflaeche pollt den Status. */
router.post(
  '/articles',
  wrap((req, res) => {
    const { article } = service.startGeneration({
      siteId: req.body.site_id,
      keyword: req.body.keyword,
      angle: req.body.angle || '',
      topicId: req.body.topic_id || null,
    });
    res.status(202).json(article);
  })
);

router.patch(
  '/articles/:id',
  wrap((req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!article) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

    const patch = {};
    if ('title' in req.body) patch.title = sanitizeText(req.body.title, 200);
    if ('slug' in req.body) patch.slug = slugify(req.body.slug);
    if ('excerpt' in req.body) patch.excerpt = sanitizeText(req.body.excerpt, 400);
    if ('meta_title' in req.body) patch.meta_title = sanitizeText(req.body.meta_title, 80);
    if ('meta_desc' in req.body) patch.meta_desc = sanitizeText(req.body.meta_desc, 200);
    if ('tags' in req.body) patch.tags = sanitizeText(req.body.tags, 300);
    if ('category' in req.body) patch.category = sanitizeText(req.body.category, 60);
    if ('content_html' in req.body) {
      patch.content_html = sanitizeHtml(req.body.content_html);
      patch.word_count = countWords(patch.content_html);
    }
    if ('status' in req.body && ['draft', 'approved'].includes(req.body.status)) patch.status = req.body.status;

    service.touchArticle(article.id, patch);
    res.json(db.prepare('SELECT * FROM articles WHERE id = ?').get(article.id));
  })
);

/** Von Hand archivieren oder zurueckholen. Der Inhalt bleibt in beiden Faellen erhalten. */
router.post(
  '/articles/:id/archive',
  wrap((req, res) => {
    const archived = req.body.archived === false ? 0 : 1;
    const result = db
      .prepare("UPDATE articles SET archived = ?, archived_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?")
      .run(archived, archived, req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Artikel nicht gefunden.' });
    res.json(db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id));
  })
);

router.post(
  '/articles/:id/publish',
  wrap(async (req, res) => {
    try {
      res.json(await service.publish(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

router.post(
  '/articles/:id/regenerate',
  wrap((req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!article) return res.status(404).json({ error: 'Artikel nicht gefunden.' });
    const { article: created } = service.startGeneration({
      siteId: article.site_id,
      keyword: article.keyword || article.title,
      angle: req.body.angle || '',
    });
    res.status(202).json(created);
  })
);

router.delete(
  '/articles/:id',
  wrap((req, res) => {
    db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

// -------------------------------------------------------- YT Channel Spy

router.post(
  '/sites/:id/channels',
  wrap(async (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Website nicht gefunden.' });

    try {
      const gefunden = await youtube.resolveChannel(req.body.input);
      const id = randomId('chan');
      db.prepare(
        `INSERT INTO channels (id, site_id, channel_id, handle, title, interval_hours, max_per_scan, angle, auto_article, embed_video)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, site.id, gefunden.channel_id, gefunden.handle, sanitizeText(req.body.title || gefunden.title, 160),
        Math.max(1, Math.min(720, Number(req.body.interval_hours) || 24)),
        Math.max(1, Math.min(10, Number(req.body.max_per_scan) || 1)),
        sanitizeText(req.body.angle, 300),
        req.body.auto_article === false ? 0 : 1,
        req.body.embed_video === false ? 0 : 1
      );
      logger.info('youtube', 'channel', `Kanal aufgenommen: ${gefunden.title || gefunden.channel_id}`, {
        siteId: site.id, requestId: req.requestId, context: { channel_id: gefunden.channel_id },
      });
      res.status(201).json(db.prepare('SELECT * FROM channels WHERE id = ?').get(id));
    } catch (err) {
      const schonDa = /UNIQUE constraint/.test(String(err.message));
      res.status(400).json({ error: schonDa ? 'Dieser Kanal wird fuer diese Website bereits beobachtet.' : err.message });
    }
  })
);

router.patch(
  '/channels/:id',
  wrap((req, res) => {
    const kanal = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!kanal) return res.status(404).json({ error: 'Kanal nicht gefunden.' });

    const patch = {};
    if ('title' in req.body) patch.title = sanitizeText(req.body.title, 160);
    if ('angle' in req.body) patch.angle = sanitizeText(req.body.angle, 300);
    if ('interval_hours' in req.body) patch.interval_hours = Math.max(1, Math.min(720, Number(req.body.interval_hours) || 24));
    if ('max_per_scan' in req.body) patch.max_per_scan = Math.max(1, Math.min(10, Number(req.body.max_per_scan) || 1));
    if ('active' in req.body) patch.active = req.body.active ? 1 : 0;
    if ('auto_article' in req.body) patch.auto_article = req.body.auto_article ? 1 : 0;
    if ('embed_video' in req.body) patch.embed_video = req.body.embed_video ? 1 : 0;

    if (Object.keys(patch).length) {
      const setClause = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE channels SET ${setClause} WHERE id = @id`).run({ ...patch, id: kanal.id });
    }
    // Neues Intervall gilt ab dem letzten Durchlauf, nicht erst nach dem alten Termin.
    if ('interval_hours' in patch && kanal.last_check_at) {
      db.prepare("UPDATE channels SET next_check_at = datetime(last_check_at, ?) WHERE id = ?")
        .run(`+${patch.interval_hours} hours`, kanal.id);
    }
    res.json(db.prepare('SELECT * FROM channels WHERE id = ?').get(kanal.id));
  })
);

router.delete(
  '/channels/:id',
  wrap((req, res) => {
    db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

/** Kanal sofort pruefen, ohne auf den Termin zu warten. */
router.post(
  '/channels/:id/scan',
  wrap(async (req, res) => {
    const kanal = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!kanal) return res.status(404).json({ error: 'Kanal nicht gefunden.' });
    const ergebnis = await youtube.scanChannel(kanal);
    if (ergebnis.fehler) return res.status(400).json({ error: ergebnis.fehler });
    res.json({ ok: true, ...ergebnis });
  })
);

/** Aus einem einzelnen Video jetzt einen Artikel machen. */
router.post(
  '/videos/:id/article',
  wrap((req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video nicht gefunden.' });
    if (video.status === 'artikel' && video.article_id) {
      return res.status(400).json({ error: 'Aus diesem Video wurde bereits ein Artikel erzeugt.' });
    }
    const { article } = service.startFromVideo(video);
    res.status(202).json(article);
  })
);

router.post(
  '/videos/:id/skip',
  wrap((req, res) => {
    db.prepare("UPDATE videos SET status = 'uebersprungen', error = 'von Hand uebersprungen' WHERE id = ?")
      .run(req.params.id);
    res.json({ ok: true });
  })
);

// ------------------------------------------- Wiederkehrende Posts (Plaene)

router.get(
  '/plans',
  wrap((req, res) => {
    res.json(
      db.prepare(
        `SELECT p.*, s.name AS site_name, s.status AS site_status,
                (SELECT COUNT(*) FROM articles a WHERE a.plan_id = p.id) AS article_count
         FROM plans p JOIN sites s ON s.id = p.site_id ORDER BY p.created_at DESC`
      ).all()
    );
  })
);

router.post(
  '/plans',
  wrap((req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.body.site_id);
    if (!site) return res.status(400).json({ error: 'Bitte eine Website waehlen.' });

    const id = randomId('plan');
    db.prepare(
      `INSERT INTO plans (id, site_id, name, areas, per_week, publish_hour, auto_publish, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      site.id,
      sanitizeText(req.body.name, 120) || 'Redaktionsplan',
      String(req.body.areas || '').slice(0, 4000),
      Math.max(1, Math.min(14, Number(req.body.per_week) || 2)),
      Math.max(0, Math.min(23, Number(req.body.publish_hour) || 9)),
      req.body.auto_publish ? 1 : 0
    );
    service.scheduleNextRun(id);
    logger.info('plan', 'create', `Wiederkehrende Posts eingerichtet fuer ${site.name}`, { siteId: site.id, requestId: req.requestId });
    res.status(201).json(db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
  })
);

router.patch(
  '/plans/:id',
  wrap((req, res) => {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan nicht gefunden.' });

    const patch = {};
    if ('name' in req.body) patch.name = sanitizeText(req.body.name, 120) || 'Redaktionsplan';
    if ('areas' in req.body) patch.areas = String(req.body.areas || '').slice(0, 4000);
    if ('per_week' in req.body) patch.per_week = Math.max(1, Math.min(14, Number(req.body.per_week) || 2));
    if ('publish_hour' in req.body) patch.publish_hour = Math.max(0, Math.min(23, Number(req.body.publish_hour) || 0));
    if ('auto_publish' in req.body) patch.auto_publish = req.body.auto_publish ? 1 : 0;
    if ('active' in req.body) patch.active = req.body.active ? 1 : 0;

    if (Object.keys(patch).length) {
      const setClause = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE plans SET ${setClause} WHERE id = @id`).run({ ...patch, id: plan.id });
    }
    // Takt oder Uhrzeit geaendert -> naechsten Termin neu berechnen.
    if ('per_week' in patch || 'publish_hour' in patch || patch.active === 1) service.scheduleNextRun(plan.id);
    if (patch.active === 0) db.prepare('UPDATE plans SET next_run_at = NULL WHERE id = ?').run(plan.id);

    res.json(db.prepare('SELECT * FROM plans WHERE id = ?').get(plan.id));
  })
);

router.delete(
  '/plans/:id',
  wrap((req, res) => {
    db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

/** Einen einzelnen Plan sofort ausfuehren (Testlauf). */
router.post(
  '/plans/:id/run',
  wrap(async (req, res) => {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan nicht gefunden.' });
    db.prepare('UPDATE plans SET next_run_at = NULL WHERE id = ?').run(plan.id);
    const result = await service.runRecurring();
    res.json({ ok: true, ...result });
  })
);

// ------------------------------------------------------------ Einstellungen

router.get(
  '/settings',
  wrap((req, res) => {
    res.json({
      ...settings.all(),
      apiKey: settings.apiKeyInfo(),
      imageKey: settings.imageKeyInfo(),
      transcriptKey: settings.transcriptKeyInfo(),
      youtubeKey: settings.youtubeKeyInfo(),
      imagesEnabled: images.enabled(),
      models: ai.MODELS,
      hubUrl: PUBLIC_URL,
      version: VERSION,
    });
  })
);

router.put(
  '/settings',
  wrap((req, res) => {
    settings.save(req.body);
    if (typeof req.body.anthropic_api_key === 'string' && req.body.anthropic_api_key.trim()) {
      settings.setApiKey(req.body.anthropic_api_key);
    }
    if (req.body.anthropic_api_key === '') settings.setApiKey('');
    if (typeof req.body.image_api_key === 'string' && req.body.image_api_key.trim()) {
      settings.setImageKey(req.body.image_api_key);
    }
    if (req.body.image_api_key === '') settings.setImageKey('');
    if (typeof req.body.transcript_api_key === 'string' && req.body.transcript_api_key.trim()) {
      settings.setTranscriptKey(req.body.transcript_api_key);
    }
    if (req.body.transcript_api_key === '') settings.setTranscriptKey('');
    if (typeof req.body.youtube_api_key === 'string' && req.body.youtube_api_key.trim()) {
      settings.setYoutubeKey(req.body.youtube_api_key);
    }
    if (req.body.youtube_api_key === '') settings.setYoutubeKey('');
    res.json({
      ...settings.all(),
      apiKey: settings.apiKeyInfo(),
      imageKey: settings.imageKeyInfo(),
      transcriptKey: settings.transcriptKeyInfo(),
      youtubeKey: settings.youtubeKeyInfo(),
      imagesEnabled: images.enabled(),
    });
  })
);

router.post(
  '/settings/reset-prompts',
  wrap((req, res) => {
    settings.resetPrompts();
    logger.info('settings', 'reset', 'Prompt-Framework auf Standard zurueckgesetzt', { requestId: req.requestId });
    res.json(settings.all());
  })
);

// ----------------------------------------------------------- System-Update

router.get(
  '/update',
  wrap((req, res) => {
    res.json(update.status());
  })
);

/** Stoesst das Update an. Der Hub startet dabei neu. */
router.post(
  '/update',
  wrap((req, res) => {
    try {
      res.json({ ...update.request(req.user && req.user.email), status: update.status() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

// ---------------------------------------------------------------- Diagnose

router.get(
  '/diagnostics',
  wrap((req, res) => {
    res.json(diagnostics.status());
  })
);

/** Jede Aktivierung erzeugt einen neuen Token; der vorherige Link wird ungueltig. */
router.post(
  '/diagnostics/enable',
  wrap((req, res) => {
    res.json(diagnostics.enable());
  })
);

router.post(
  '/diagnostics/disable',
  wrap((req, res) => {
    diagnostics.disable();
    res.json(diagnostics.status());
  })
);

router.get(
  '/logs',
  wrap((req, res) => {
    const filters = [];
    const params = { limit: Math.min(1000, Math.max(20, Number(req.query.limit) || 200)) };
    if (req.query.level) { filters.push('level = @level'); params.level = req.query.level; }
    if (req.query.category) { filters.push('category = @category'); params.category = req.query.category; }
    if (req.query.site) { filters.push('site_id = @site'); params.site = req.query.site; }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT @limit`).all(params));
  })
);

router.post(
  '/recurring/run',
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await service.runRecurring()) });
  })
);

module.exports = router;
