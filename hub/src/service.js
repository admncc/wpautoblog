'use strict';
const { db } = require('./db');
const { logger } = require('./logger');
const ai = require('./ai');
const wp = require('./wp');
const images = require('./images');
const youtube = require('./youtube');
const { randomId } = require('./util');
const { PUBLIC_URL } = require('./config');
const { pruefeUebernahme } = require('./textvergleich');
const { safeLink } = require('./sanitize');

const getSite = (id) => db.prepare('SELECT * FROM sites WHERE id = ?').get(id);

/**
 * Die Kategorien, unter denen ein Artikel erscheinen darf.
 *
 * Ausgeschlossene bleiben aussen vor, damit die KI sie gar nicht erst vorschlagen
 * kann. Mit einer Kategorie fallen auch ihre Unterkategorien weg: Wer "weitere
 * Buecher" sperrt, will auch nichts unter "weitere Buecher / Ernaehrung" stehen
 * haben, denn die Adresse des Beitrags traegt den Oberbegriff mit.
 */
function kategorienFuer(site) {
  const lies = (feld) => {
    try {
      const wert = JSON.parse(site[feld] || '[]');
      return Array.isArray(wert) ? wert : [];
    } catch {
      return [];
    }
  };

  const alle = lies('categories');
  const gesperrt = new Set(lies('excluded_categories').map((n) => String(n).trim().toLowerCase()));
  if (!gesperrt.size) return alle;

  const nachId = new Map(alle.filter((k) => k && k.id).map((k) => [k.id, k]));
  const istGesperrt = (kategorie) => {
    let aktuell = kategorie;
    for (let tiefe = 0; aktuell && tiefe < 10; tiefe += 1) {
      if (gesperrt.has(String(aktuell.name || '').trim().toLowerCase())) return true;
      aktuell = aktuell.parent ? nachId.get(aktuell.parent) : null;
    }
    return false;
  };

  return alle.filter((k) => {
    const name = typeof k === 'string' ? k : (k && k.name) || '';
    if (!name) return false;
    return typeof k === 'string' ? !gesperrt.has(name.trim().toLowerCase()) : !istGesperrt(k);
  });
}

const getArticle = (id) => db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

function touchArticle(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE articles SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...patch, id });
}

/**
 * Legt einen Artikel im Status "generating" an und startet die Erzeugung im Hintergrund.
 * Die Oberflaeche pollt anschliessend den Status.
 */
function startGeneration({ siteId, keyword, angle = '', topicId = null, planId = null, origin = 'manual', briefing = null }) {
  const site = getSite(siteId);
  if (!site) throw new Error('Website nicht gefunden.');
  const cleanKeyword = String(keyword || '').trim();
  if (!cleanKeyword) throw new Error('Bitte ein Thema oder Keyword angeben.');

  const id = randomId('art');
  db.prepare(
    `INSERT INTO articles (id, site_id, topic_id, plan_id, keyword, title, status, origin)
     VALUES (?, ?, ?, ?, ?, ?, 'generating', ?)`
  ).run(id, siteId, topicId, planId, cleanKeyword, cleanKeyword, origin);

  if (topicId) db.prepare("UPDATE topics SET status = 'used' WHERE id = ?").run(topicId);
  const timer = logger.start('article', 'generate', `Artikel wird erzeugt: "${cleanKeyword}"`, {
    siteId,
    articleId: id,
    context: { keyword: cleanKeyword, angle, origin, plan_id: planId, topic_id: topicId },
  });

  const kategorien = kategorienFuer(site);

  // Gezielte Posts haben ein eigenes Regelwerk und bekommen die Recherche mit.
  const auftrag = { site, keyword: cleanKeyword, angle, imageCount: images.plannedCount(), categories: kategorien };
  const promise = (origin === 'target'
    ? ai.generateTargeted({ ...auftrag, briefing: briefing || {} })
    : ai.generateArticle(auftrag))
    .then(async (result) => {
      touchArticle(id, {
        title: result.title,
        slug: result.slug,
        excerpt: result.excerpt,
        content_html: result.content_html,
        meta_title: result.meta_title,
        meta_desc: result.meta_desc,
        tags: result.tags,
        category: site.wp_category || result.category || '',
        word_count: result.word_count,
        model: result.model,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        status: 'draft',
        error: null,
      });
      timer.ok(`Artikel fertig: "${result.title}" (${result.word_count} Woerter)`, {
        siteId,
        articleId: id,
        context: { title: result.title, words: result.word_count, model: result.model, tokens_out: result.tokens_out },
      });

      // Bilder danach: Ein Fehler hier darf den fertigen Artikel nicht entwerten.
      if (result.images && result.images.length) {
        await images.generateForArticle(getArticle(id), result.images).catch((err) =>
          logger.error('image', 'generate', `Bilder fehlgeschlagen: ${err.message || err}`, { siteId, articleId: id })
        );
      }
      return getArticle(id);
    })
    .catch((err) => {
      touchArticle(id, { status: 'failed', error: String(err.message || err) });
      timer.fail(`Artikel fehlgeschlagen ("${cleanKeyword}"): ${err.message || err}`, { siteId, articleId: id });
      return getArticle(id);
    });

  return { article: getArticle(id), promise };
}

/**
 * Macht aus einem beobachteten Video einen Artikel: Transkript holen, Artikel
 * schreiben lassen, Bilder erzeugen. Laeuft wie die normale Erzeugung im Hintergrund.
 */
function startFromVideo(video) {
  const site = getSite(video.site_id);
  if (!site) throw new Error('Website nicht gefunden.');

  const kanal = db.prepare('SELECT * FROM channels WHERE id = ?').get(video.channel_ref) || {};

  // Ein frueherer Fehlversuch zu demselben Video hat nur einen leeren roten Eintrag
  // hinterlassen. Der verschwindet, sonst sammeln sich bei mehreren Anlaeufen
  // Karteileichen in der Artikelliste.
  if (video.article_id) {
    db.prepare("DELETE FROM articles WHERE id = ? AND status = 'failed' AND (content_html IS NULL OR content_html = '')")
      .run(video.article_id);
  }

  // Der Videotitel traegt meist die Marke des Kanals mit ("... | auto mobil").
  // Fuer den Artikel faellt sie weg, in der Quellangabe bleibt der echte Titel stehen.
  const arbeitstitel = youtube.ohneKanalname(video.title, kanal.title);

  const id = randomId('art');
  db.prepare(
    `INSERT INTO articles (id, site_id, keyword, title, status, origin, source_url, source_title)
     VALUES (?, ?, ?, ?, 'generating', 'youtube', ?, ?)`
  ).run(id, site.id, arbeitstitel, arbeitstitel, youtube.videoUrl(video.video_id), video.title);
  db.prepare("UPDATE videos SET status = 'transkribiert', article_id = ?, retry_at = NULL WHERE id = ?").run(id, video.id);

  const timer = logger.start('article', 'video', `Artikel aus Video: "${video.title}"`, {
    siteId: site.id,
    articleId: id,
    context: { video_id: video.video_id, kanal: kanal.title },
  });

  const kategorien = kategorienFuer(site);

  // Beim zweiten Anlauf ist das Transkript meist schon da. Es erneut zu holen wuerde
  // beim Transkript-Dienst zaehlen, ohne dass sich am Text etwas aendert.
  const gespeichert = String(video.transcript || '').trim();
  const holen = gespeichert.length > 200
    ? Promise.resolve(gespeichert)
    : youtube.fetchTranscript(video.video_id, site.language || 'de');
  if (gespeichert.length > 200) {
    logger.debug('article', 'video', 'Vorhandenes Transkript wird wiederverwendet', {
      siteId: site.id, articleId: id, context: { video_id: video.video_id, woerter: gespeichert.split(' ').length },
    });
  }

  const promise = holen
    .then(async (transcript) => {
      db.prepare('UPDATE videos SET transcript = ?, words = ? WHERE id = ?')
        .run(transcript.slice(0, 200000), transcript.split(' ').length, video.id);

      const result = await ai.generateFromVideo({
        site,
        video: { ...video, title: arbeitstitel },
        transcript,
        imageCount: images.plannedCount(),
        categories: kategorien,
        angle: kanal.angle || '',
      });

      // Der Artikel soll aus dem Transkript entstehen, nicht daraus abgeschrieben sein.
      // Auffaelliges wird vermerkt, aber nicht verhindert: Das Urteil bleibt beim Menschen.
      const uebernahme = pruefeUebernahme(result.content_html, transcript);
      let hinweis = null;
      if (uebernahme.auffaellig) {
        hinweis = `Der Text liegt nah am Transkript: ${Math.round(uebernahme.anteil * 100)} % der Wortketten`
          + ` stimmen ueberein, die laengste gleiche Passage ist ${uebernahme.passage} Woerter lang.`
          + ' Bitte vor dem Senden pruefen oder neu schreiben lassen.';
        logger.warn('article', 'uebernahme', hinweis, {
          siteId: site.id,
          articleId: id,
          context: {
            video_id: video.video_id,
            anteil: Number(uebernahme.anteil.toFixed(3)),
            passage: uebernahme.passage,
            stelle: uebernahme.stelle,
          },
        });
      } else {
        logger.debug('article', 'uebernahme', 'Eigener Wortlaut bestaetigt', {
          siteId: site.id,
          articleId: id,
          context: { anteil: Number(uebernahme.anteil.toFixed(3)), passage: uebernahme.passage },
        });
      }

      touchArticle(id, {
        notice: hinweis,
        title: result.title,
        slug: result.slug,
        excerpt: result.excerpt,
        content_html: result.content_html,
        meta_title: result.meta_title,
        meta_desc: result.meta_desc,
        tags: result.tags,
        category: site.wp_category || result.category || '',
        word_count: result.word_count,
        model: result.model,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        status: 'draft',
        error: null,
      });
      db.prepare("UPDATE videos SET status = 'artikel' WHERE id = ?").run(video.id);
      timer.ok(`Artikel aus Video fertig: "${result.title}" (${result.word_count} Woerter)`, {
        siteId: site.id, articleId: id, context: { video_id: video.video_id },
      });

      if (result.images && result.images.length) {
        await images.generateForArticle(getArticle(id), result.images).catch((err) =>
          logger.error('image', 'generate', `Bilder fehlgeschlagen: ${err.message || err}`, { siteId: site.id, articleId: id })
        );
      }
      return getArticle(id);
    })
    .catch(async (err) => {
      const meldung = String(err.message || err);
      touchArticle(id, { status: 'failed', error: meldung });
      await nachFehlschlag(video, meldung);
      timer.fail(meldung, { siteId: site.id, articleId: id, context: { video_id: video.video_id } });
      return getArticle(id);
    });

  return { article: getArticle(id), promise };
}

/**
 * Wiedervorlage nach einem Fehlschlag.
 *
 * Untertitel stehen bei frisch veroeffentlichten Videos oft erst nach einer Weile
 * bereit, und auch ein ueberlasteter Dienst ist kein Grund, das Video abzuschreiben.
 * Nach dem letzten Anlauf rueckt ein anderes Video des Kanals nach, damit der Blog
 * in diesem Zeitraum trotzdem seinen Artikel bekommt.
 */
const WIEDERVORLAGE_MINUTEN = [30, 120];

async function nachFehlschlag(video, meldung) {
  const versuche = Number(video.attempts || 0) + 1;
  const wartezeit = WIEDERVORLAGE_MINUTEN[versuche - 1];

  if (wartezeit) {
    db.prepare(
      `UPDATE videos SET status = 'fehler', error = ?, attempts = ?,
        retry_at = datetime('now', ?) WHERE id = ?`
    ).run(meldung.slice(0, 500), versuche, `+${wartezeit} minutes`, video.id);
    logger.info('article', 'video.retry', `Neuer Anlauf in ${wartezeit} Minuten (Versuch ${versuche + 1})`, {
      siteId: video.site_id, context: { video_id: video.video_id, grund: meldung.slice(0, 200) },
    });
    return;
  }

  db.prepare("UPDATE videos SET status = 'fehler', error = ?, attempts = ?, retry_at = NULL WHERE id = ?")
    .run(meldung.slice(0, 500), versuche, video.id);
  await ersatzVideo(video);
}

/**
 * Sucht ein anderes Video desselben Kanals, das bisher nur wegen der Grenze je
 * Durchlauf oder als Altbestand liegen geblieben ist. Dubletten und von Hand
 * uebersprungene Videos bleiben aussen vor, die waren eine Entscheidung.
 */
async function ersatzVideo(video) {
  const kandidat = db
    .prepare(
      `SELECT * FROM videos WHERE channel_ref = ? AND status = 'uebersprungen'
        AND skip_reason IN ('limit', 'altbestand')
        AND attempts = 0
       ORDER BY published_at DESC, created_at DESC LIMIT 1`
    )
    .get(video.channel_ref);

  if (!kandidat) {
    logger.warn('article', 'video.ersatz', 'Kein Ersatzvideo vorhanden, dieser Zeitraum bleibt ohne Video-Artikel', {
      siteId: video.site_id, context: { video_id: video.video_id },
    });
    return null;
  }

  // Beim Ueberspringen wurden Titel und Datum nicht geladen. Fuer die Dublettenpruefung
  // und den Artikel selbst werden sie jetzt nachgetragen.
  if (!kandidat.title || /^Video [\w-]+$/.test(kandidat.title)) {
    const eintrag = { video_id: kandidat.video_id, title: '', published_at: kandidat.published_at, description: '' };
    await youtube.ergaenzeMetadaten(eintrag);
    db.prepare('UPDATE videos SET title = ?, description = ?, published_at = ? WHERE id = ?')
      .run(eintrag.title, eintrag.description, eintrag.published_at, kandidat.id);
    kandidat.title = eintrag.title;
  }

  db.prepare("UPDATE videos SET status = 'neu', error = NULL, skip_reason = NULL WHERE id = ?").run(kandidat.id);
  logger.info('article', 'video.ersatz', `Ersatzvideo rueckt nach: "${kandidat.title}"`, {
    siteId: video.site_id,
    context: { ausgefallen: video.video_id, ersatz: kandidat.video_id },
  });
  return kandidat;
}

/**
 * Arbeitet neu gefundene Videos ab. Bewusst nacheinander und begrenzt,
 * damit ein Schwung neuer Videos nicht alles blockiert.
 */
async function runVideoQueue(limit = 3) {
  if (!youtube.aktiv()) return { verarbeitet: 0 };

  const offen = db
    .prepare(
      `SELECT v.* FROM videos v
       JOIN channels c ON c.id = v.channel_ref
       WHERE c.active = 1 AND c.auto_article = 1
         AND (v.status = 'neu'
              OR (v.status = 'fehler' AND v.retry_at IS NOT NULL AND v.retry_at <= datetime('now')))
       ORDER BY v.published_at ASC LIMIT ?`
    )
    .all(Math.max(1, limit));

  let verarbeitet = 0;
  for (const video of offen) {
    try {
      const { promise } = startFromVideo(video);
      await promise;
      verarbeitet += 1;
    } catch (err) {
      logger.error('article', 'video', `Video konnte nicht verarbeitet werden: ${err.message || err}`, {
        siteId: video.site_id, context: { video_id: video.video_id },
      });
    }
  }
  return { verarbeitet };
}

/** Schiebt einen fertigen Artikel ueber das Plugin nach WordPress. */
async function publish(articleId) {
  const article = getArticle(articleId);
  if (!article) throw new Error('Artikel nicht gefunden.');
  if (article.status === 'generating') throw new Error('Der Artikel wird gerade noch erzeugt.');
  if (!article.content_html) throw new Error('Der Artikel hat noch keinen Inhalt.');

  const site = getSite(article.site_id);
  touchArticle(articleId, { status: 'publishing', error: null, notice: null });

  // Abhol-Modus: Der Artikel bleibt in der Warteschlange, bis das Plugin ihn holt.
  if (site.delivery === 'pull') {
    logger.info('article', 'queue', `Artikel in Warteschlange fuer ${site.name} (Abhol-Modus)`, {
      siteId: site.id,
      articleId,
      context: { title: article.title },
    });
    return getArticle(articleId);
  }

  try {
    const result = await wp.publishArticle(site, article);
    // Erfolgreich uebergeben: Der Artikel bleibt vollstaendig hier gespeichert,
    // verschwindet aber aus der Arbeitsliste.
    const hinweise = [];
    if (result.category_note) hinweise.push(String(result.category_note));

    // Bilder sind nicht kritisch: Der Beitrag steht, aber der Hinweis muss sichtbar sein.
    const bildFehler = Array.isArray(result.image_errors) ? result.image_errors : [];
    const erwartet = images.forArticle(articleId).filter((img) => img.status === 'ready').length;
    const uebernommen = Number(result.images_imported) || 0;
    let hinweis = null;

    if (erwartet && uebernommen < erwartet) {
      hinweis = `Nur ${uebernommen} von ${erwartet} Bildern wurden in WordPress angelegt.`
        + (bildFehler.length ? ` ${bildFehler.join(' ')}` : '')
        + ` Kann WordPress die Adresse ${PUBLIC_URL || 'des Hubs'} erreichen?`;
      logger.warn('article', 'images', hinweis, {
        siteId: site.id,
        articleId,
        context: { erwartet, uebernommen, fehler: bildFehler },
      });
      hinweise.push(hinweis);
    }
    if (result.category) {
      logger.debug('article', 'category', `Kategorie in WordPress: ${result.category}`, { siteId: site.id, articleId });
    }

    touchArticle(articleId, {
      status: 'published',
      wp_post_id: result.post_id || null,
      wp_url: safeLink(result.url),
      published_at: new Date().toISOString(),
      archived: 1,
      archived_at: new Date().toISOString(),
      error: null,
      notice: hinweise.length ? hinweise.join(' ') : null,
    });
    db.prepare("UPDATE sites SET last_seen_at = datetime('now'), status = 'connected' WHERE id = ?").run(site.id);
    logger.info('article', 'publish', `Veroeffentlicht auf ${site.name}: ${result.url || result.post_id}`, {
      siteId: site.id,
      articleId,
      context: { post_id: result.post_id, url: result.url, wp_status: result.status || site.wp_status },
    });
    return getArticle(articleId);
  } catch (err) {
    touchArticle(articleId, { status: 'failed', error: String(err.message || err) });
    logger.error('article', 'publish', `Veroeffentlichen fehlgeschlagen: ${err.message || err}`, {
      siteId: site.id,
      articleId,
      context: { site_url: site.url, delivery: site.delivery },
    });
    throw err;
  }
}

/** Naechsten Termin eines Plans aus "Artikel pro Woche" berechnen. */
function computeNextRun(plan, from = new Date()) {
  const perWeek = Math.max(1, Math.min(14, plan.per_week || 2));
  const intervalHours = (7 * 24) / perWeek;
  const next = new Date(from.getTime() + intervalHours * 3600 * 1000);
  // Auf die gewuenschte Uhrzeit legen, aber nie in die Vergangenheit rutschen.
  const hour = Math.max(0, Math.min(23, plan.publish_hour ?? 9));
  next.setMinutes(0, 0, 0);
  next.setHours(hour);
  while (next <= from) next.setTime(next.getTime() + 24 * 3600 * 1000);
  return next.toISOString();
}

function scheduleNextRun(planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) return;
  db.prepare('UPDATE plans SET next_run_at = ? WHERE id = ?').run(computeNextRun(plan), planId);
}

/** Naechstes Thema fuer einen Plan: offene Themen zuerst, sonst neue von der KI. */
async function nextTopicForPlan(plan, site) {
  const pick = () =>
    db.prepare("SELECT * FROM topics WHERE site_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1").get(site.id);

  let topic = pick();
  if (topic) return topic;

  const areas = String(plan.areas || '').split('\n').map((a) => a.trim()).filter(Boolean);
  const existing = db.prepare('SELECT keyword FROM topics WHERE site_id = ?').all(site.id).map((r) => r.keyword);
  const briefingSite = areas.length ? { ...site, topic_focus: areas.join(', ') } : site;

  const suggestions = await ai.suggestTopics({ site: briefingSite, count: 5, existing });
  const insert = db.prepare(
    "INSERT INTO topics (id, site_id, plan_id, keyword, angle, source) VALUES (?, ?, ?, ?, ?, 'ai')"
  );
  for (const item of suggestions) insert.run(randomId('top'), site.id, plan.id, item.keyword, item.angle);
  if (suggestions.length) {
    logger.info('plan', 'topics', `${suggestions.length} neue Themen fuer Plan "${plan.name}" ergaenzt`, {
      siteId: site.id,
      context: { plan: plan.name, keywords: suggestions.map((t) => t.keyword) },
    });
  }
  return pick();
}

/** Ein Durchlauf der wiederkehrenden Posts: faellige Plaene abarbeiten. */
/**
 * Ein Plan, ein Post.
 *
 * Bewusst getrennt vom Durchlauf ueber alle faelligen Plaene: Wer im Panel bei einem
 * Plan auf "Jetzt ausfuehren" drueckt, meint genau diesen Plan und keinen anderen.
 * Der Riegel verhindert, dass derselbe Plan zweimal gleichzeitig laeuft, etwa weil
 * der Zeitplan dazwischenfunkt oder jemand zweimal klickt.
 */
const laufendePlaene = new Set();

async function runPlan(plan) {
  if (laufendePlaene.has(plan.id)) {
    logger.warn('plan', 'run', `Plan "${plan.name}" laeuft bereits, dieser Aufruf wird uebersprungen`, {
      siteId: plan.site_id,
    });
    return { produced: 0, laeuft: true };
  }
  laufendePlaene.add(plan.id);

  const site = getSite(plan.site_id);
  let produced = 0;
  let article = null;
  try {
    if (!site) return { produced: 0, fehler: 'Website nicht gefunden.' };

    const topic = await nextTopicForPlan(plan, site);
    if (!topic) {
      logger.warn('plan', 'run', `Plan "${plan.name}": kein Thema verfuegbar`, { siteId: plan.site_id });
      return { produced: 0, fehler: 'Kein Thema verfuegbar.' };
    }

    const { promise } = startGeneration({
      siteId: site.id,
      keyword: topic.keyword,
      angle: topic.angle,
      topicId: topic.id,
      planId: plan.id,
      origin: 'recurring',
    });
    article = await promise;
    if (article.status === 'draft') produced += 1;

    if (article.status === 'draft' && plan.auto_publish) {
      await publish(article.id);
    }
    return { produced, article };
  } catch (err) {
    logger.error('plan', 'run', `Fehler im Plan "${plan.name}": ${err.message || err}`, {
      siteId: plan.site_id,
      context: { plan: plan.name, stack: String(err.stack || '').slice(0, 1200) },
    });
    return { produced, fehler: String(err.message || err) };
  } finally {
    laufendePlaene.delete(plan.id);
    db.prepare("UPDATE plans SET last_run_at = datetime('now') WHERE id = ?").run(plan.id);
    scheduleNextRun(plan.id);
  }
}

/** Alle faelligen Plaene der Reihe nach. Wird vom Zeitplan aufgerufen. */
async function runRecurring() {
  const runTimer = logger.start('plan', 'cycle', 'Durchlauf der wiederkehrenden Posts gestartet');
  const due = db
    .prepare("SELECT * FROM plans WHERE active = 1 AND (next_run_at IS NULL OR next_run_at <= datetime('now'))")
    .all();

  let produced = 0;
  for (const plan of due) {
    const ergebnis = await runPlan(plan);
    produced += ergebnis.produced || 0;
  }
  runTimer.ok(`Durchlauf beendet: ${due.length} Plan/Plaene geprueft, ${produced} Post(s) erzeugt`, {
    context: { due: due.length, produced },
  });
  return { plans: due.length, produced };
}

module.exports = {
  startGeneration, startFromVideo, runVideoQueue, publish, runRecurring, runPlan,
  computeNextRun, scheduleNextRun, getSite, getArticle, touchArticle, kategorienFuer,
};
