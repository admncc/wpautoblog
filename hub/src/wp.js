'use strict';
const { sign, decrypt } = require('./util');
const { PUBLIC_URL, VERSION } = require('./config');
const { logger, excerpt } = require('./logger');

const TIMEOUT_MS = 45000;

class WpError extends Error {}

/**
 * Signierter Aufruf an das WordPress-Plugin.
 * Das Plugin prueft Zeitstempel und HMAC-Signatur, ein Passwort wird nie uebertragen.
 */
async function callSite(site, path, payload) {
  const secret = decrypt(site.secret);
  if (!secret) throw new WpError('Fuer diese Website existiert kein Token. Bitte im Hub neu erzeugen.');
  if (!site.url) {
    throw new WpError('Fuer diese Website ist keine URL hinterlegt. Sie wird gesetzt, sobald sich das WordPress-Plugin meldet.');
  }

  const body = JSON.stringify(payload || {});
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `${site.url}/wp-json/wp-autoblog/v1/${path}`;
  const timer = logger.start('wordpress', path, `WordPress-Aufruf ${path} an ${site.url}`, {
    siteId: site.id,
    context: { url, body_bytes: body.length },
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WPAB-Site': site.id,
        'X-WPAB-Timestamp': String(timestamp),
        'X-WPAB-Signature': sign(secret, timestamp, body),
        'X-WPAB-Hub': PUBLIC_URL || '',
        'User-Agent': `WPAutoblogHub/${VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    timer.fail(err, { context: { url, hint: 'Netzwerk, DNS, TLS oder Zeitueberschreitung' } });
    throw new WpError(`WordPress nicht erreichbar (${url}): ${err.message}`);
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    timer.fail('Antwort war kein JSON', {
      status: response.status,
      context: { url, response: excerpt(raw, 800), content_type: response.headers.get('content-type') },
    });
    throw new WpError(
      `Unerwartete Antwort von WordPress (HTTP ${response.status}). Ist das Plugin aktiviert und die URL korrekt? Antwort: ${raw.slice(0, 200)}`
    );
  }
  if (!response.ok || data.ok === false) {
    timer.fail(data.message || `HTTP ${response.status}`, { status: response.status, context: { url, response: excerpt(raw, 800) } });
    throw new WpError(data.message || `WordPress meldet einen Fehler (HTTP ${response.status}).`);
  }

  timer.ok(`WordPress-Aufruf ${path} erfolgreich (HTTP ${response.status})`, {
    status: response.status,
    context: { url, response: excerpt(raw, 500) },
  });
  return data;
}

async function ping(site) {
  return callSite(site, 'ping', { hub_version: VERSION });
}

async function publishArticle(site, article) {
  return callSite(site, 'publish', {
    article_id: article.id,
    post_id: article.wp_post_id || 0,
    title: article.title,
    slug: article.slug,
    content: article.content_html,
    excerpt: article.excerpt,
    status: site.wp_status || 'draft',
    category: article.category || site.wp_category || '',
    tags: article.tags ? article.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    author_id: site.wp_author_id || 0,
    meta: { title: article.meta_title, description: article.meta_desc },
  });
}

module.exports = { WpError, ping, publishArticle, callSite };
