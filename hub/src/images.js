'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');
const { logger, excerpt } = require('./logger');
const { randomId } = require('./util');
const { DATA_DIR, PUBLIC_URL } = require('./config');
const settings = require('./settings');

const IMAGE_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGE_DIR, { recursive: true });

class ImageError extends Error {}

const enabled = () => settings.get('image_provider') !== 'none' && Boolean(settings.getImageKey());

/** Wie viele Bildkonzepte der Artikel-Prompt anfordern soll. */
function plannedCount() {
  if (!enabled()) return 0;
  return Math.max(0, Math.min(4, Number(settings.get('images_per_article')) || 0));
}

/**
 * Ruft einen OpenAI-kompatiblen Bildendpunkt auf und liefert die Bilddaten.
 * Anthropic erzeugt keine Bilder, deshalb ein eigener, frei konfigurierbarer Dienst.
 */
async function requestImage(prompt) {
  const baseUrl = String(settings.get('image_base_url') || '').replace(/\/+$/, '');
  const model = settings.get('image_model') || 'gpt-image-1';
  const apiKey = settings.getImageKey();
  if (!baseUrl || !apiKey) throw new ImageError('Bilddienst ist nicht vollstaendig eingerichtet.');

  const body = {
    model,
    prompt,
    n: 1,
    size: settings.get('image_size') || '1536x1024',
  };
  // "quality" kennt nicht jedes Modell - nur mitschicken, wenn gesetzt.
  const quality = settings.get('image_quality');
  if (quality && quality !== 'auto') body.quality = quality;

  let response;
  try {
    response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    throw new ImageError(`Bilddienst nicht erreichbar: ${err.message}`);
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ImageError(`Unerwartete Antwort des Bilddienstes (HTTP ${response.status}): ${raw.slice(0, 200)}`);
  }
  if (!response.ok) {
    const message = (data.error && data.error.message) || `HTTP ${response.status}`;
    throw new ImageError(`Bilddienst meldet einen Fehler: ${message}`);
  }

  const entry = data.data && data.data[0];
  if (!entry) throw new ImageError('Der Bilddienst hat kein Bild geliefert.');

  // Je nach Modell kommt das Bild als base64 oder als kurzlebige URL zurueck.
  if (entry.b64_json) {
    return { buffer: Buffer.from(entry.b64_json, 'base64'), mime: 'image/png' };
  }
  if (entry.url) {
    const file = await fetch(entry.url, { signal: AbortSignal.timeout(120000) });
    if (!file.ok) throw new ImageError(`Bild konnte nicht geladen werden (HTTP ${file.status}).`);
    return {
      buffer: Buffer.from(await file.arrayBuffer()),
      mime: file.headers.get('content-type') || 'image/png',
    };
  }
  throw new ImageError('Die Antwort des Bilddienstes enthielt weder Bilddaten noch eine URL.');
}

/** Baut aus dem Bildkonzept den endgueltigen Prompt fuer den Bilddienst. */
function buildPrompt(motif) {
  const style = settings.get('image_style');
  return [String(motif || '').trim(), style ? style.trim() : '']
    .filter(Boolean)
    .join('. ')
    .slice(0, 3800);
}

const extensionFor = (mime) => (mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png');

/**
 * Erzeugt die Bilder zu einem Artikel. Fehler bei einzelnen Bildern sind nicht
 * kritisch: Der Artikel bleibt nutzbar, das Bild wird als "failed" vermerkt.
 */
async function generateForArticle(article, briefs) {
  if (!enabled() || !Array.isArray(briefs) || !briefs.length) return [];

  const results = [];
  for (const brief of briefs.slice(0, 4)) {
    const id = randomId('img');
    const token = crypto.randomBytes(18).toString('base64url');
    const slot = Math.max(1, Math.min(9, Number(brief.slot) || results.length + 1));

    db.prepare(
      `INSERT INTO images (id, article_id, site_id, slot, motif, alt, caption, token, provider, model, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      id, article.id, article.site_id, slot,
      String(brief.motif || '').slice(0, 2000),
      String(brief.alt || '').slice(0, 300),
      String(brief.caption || '').slice(0, 300),
      token,
      settings.get('image_provider'),
      settings.get('image_model')
    );

    const timer = logger.start('image', 'generate', `Bild ${slot} wird erzeugt`, {
      siteId: article.site_id,
      articleId: article.id,
      context: { slot, motif: excerpt(brief.motif, 300) },
    });

    try {
      const { buffer, mime } = await requestImage(buildPrompt(brief.motif));
      const file = `${id}.${extensionFor(mime)}`;
      fs.writeFileSync(path.join(IMAGE_DIR, file), buffer);
      db.prepare("UPDATE images SET file = ?, mime = ?, bytes = ?, status = 'ready', error = NULL WHERE id = ?")
        .run(file, mime, buffer.length, id);
      timer.ok(`Bild ${slot} fertig (${Math.round(buffer.length / 1024)} kB)`, {
        siteId: article.site_id,
        articleId: article.id,
        context: { slot, bytes: buffer.length, mime },
      });
    } catch (err) {
      db.prepare("UPDATE images SET status = 'failed', error = ? WHERE id = ?")
        .run(String(err.message || err).slice(0, 500), id);
      timer.fail(err, { siteId: article.site_id, articleId: article.id, context: { slot } });
    }
    results.push(db.prepare('SELECT * FROM images WHERE id = ?').get(id));
  }
  return results;
}

const forArticle = (articleId) =>
  db.prepare('SELECT * FROM images WHERE article_id = ? ORDER BY slot ASC').all(articleId);

/**
 * Oeffentliche Adresse eines Bildes, ueber die WordPress es abholt.
 * Ohne PUBLIC_URL gibt es keine brauchbare Adresse - dann liefert die Funktion null,
 * damit WordPress niemals einen relativen Pfad erhaelt.
 */
function publicUrl(image, fallbackOrigin = '') {
  const base = (PUBLIC_URL || fallbackOrigin || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}/media/${image.token}`;
}

/** Bilder eines Artikels in der Form, die das WordPress-Plugin erwartet. */
function forDelivery(articleId) {
  const ready = forArticle(articleId).filter((img) => img.status === 'ready');
  if (!ready.length) return [];

  const payload = ready
    .map((img) => ({ slot: img.slot, url: publicUrl(img), alt: img.alt, caption: img.caption, mime: img.mime }))
    .filter((img) => img.url);

  if (ready.length && !payload.length) {
    logger.warn('image', 'deliver', 'Bilder koennen nicht uebertragen werden: PUBLIC_URL ist nicht gesetzt', {
      articleId,
      context: { images: ready.length, hinweis: 'PUBLIC_URL in der .env auf die oeffentliche Hub-Adresse setzen' },
    });
  }
  return payload;
}

function filePath(image) {
  return path.join(IMAGE_DIR, image.file);
}

/** Loescht Bilddateien, deren Artikel nicht mehr existiert. */
function pruneOrphans() {
  const known = new Set(db.prepare("SELECT file FROM images WHERE file != ''").all().map((r) => r.file));
  let removed = 0;
  for (const file of fs.readdirSync(IMAGE_DIR)) {
    if (known.has(file)) continue;
    fs.unlinkSync(path.join(IMAGE_DIR, file));
    removed += 1;
  }
  return removed;
}

module.exports = { ImageError, enabled, plannedCount, generateForArticle, forArticle, forDelivery, publicUrl, filePath, pruneOrphans, IMAGE_DIR };
