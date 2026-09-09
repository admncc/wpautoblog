/* Autoblog Hub - Oberflaeche. Bewusst ohne Framework, damit kein Build-Schritt noetig ist. */
'use strict';

const state = { session: null, route: 'dashboard', param: null, data: {}, busy: false };
const root = document.getElementById('root');

// ------------------------------------------------------------------ Helfer

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fehler = new Error(data.error || data.message || `Fehler ${response.status}`);
    fehler.data = data;     // Zusatzangaben des Servers, etwa die Prüfschritte
    fehler.status = response.status;
    throw fehler;
  }
  return data;
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `notice ${type}`;
  el.textContent = message;
  Object.assign(el.style, { position: 'fixed', right: '20px', bottom: '20px', zIndex: 99, maxWidth: '420px', boxShadow: 'var(--shadow)' });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function fmtDate(value) {
  if (!value) return '–';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const STATUS = {
  generating: ['info', 'wird erzeugt …'],
  draft: ['', 'Entwurf'],
  approved: ['info', 'freigegeben'],
  publishing: ['warn', 'wird übertragen …'],
  published: ['ok', 'veröffentlicht'],
  failed: ['err', 'Fehler'],
};
const statusBadge = (status) => {
  const [cls, label] = STATUS[status] || ['', status];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};

function on(selector, event, handler) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(event, handler));
}

async function guard(button, action) {
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Bitte warten …'; }
  try {
    await action();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

// ------------------------------------------------------------------ Router

const ROUTES = {
  dashboard: { title: 'Übersicht', render: renderDashboard },
  sites: { title: 'Websites', render: renderSites },
  site: { title: 'Website', render: renderSite },
  posts: { title: 'Posts', render: renderPosts },
  articles: { title: 'Artikel', render: renderArticles },
  article: { title: 'Artikel', render: renderArticle },
  settings: { title: 'Einstellungen', render: renderSettings },
  logs: { title: 'Protokoll', render: renderLogs },
};

function navigate(route, param) {
  location.hash = param ? `#/${route}/${param}` : `#/${route}`;
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const route = parts[0] || 'dashboard';
  return { route: ROUTES[route] ? route : 'dashboard', param: parts[1] || null };
}

window.addEventListener('hashchange', render);

// ------------------------------------------------------------------- Start

async function boot() {
  state.session = await api('/api/session');
  await render();
}

async function render() {
  if (!state.session) state.session = await api('/api/session');
  if (!state.session.authenticated) return renderAuth();

  const { route, param } = parseHash();
  state.route = route;
  state.param = param;

  root.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">AB</span> ${esc(state.session.hubName || 'Autoblog Hub')}</div>
        <nav class="nav">
          <a href="#/dashboard" class="${route === 'dashboard' ? 'active' : ''}">Übersicht</a>
          <a href="#/sites" class="${route === 'sites' || route === 'site' ? 'active' : ''}">Websites</a>
          <a href="#/posts" class="${route === 'posts' ? 'active' : ''}">Posts</a>
          <a href="#/articles" class="${route === 'articles' || route === 'article' ? 'active' : ''}">Artikel</a>
          <a href="#/settings" class="${route === 'settings' ? 'active' : ''}">Einstellungen</a>
          <a href="#/logs" class="${route === 'logs' ? 'active' : ''}">Protokoll</a>
        </nav>
        <div class="sidebar-foot">
          <div id="update-box"></div>
          <button class="small" id="logout" style="margin-top:10px">Abmelden</button>
        </div>
      </aside>
      <main class="main" id="view"><div class="empty">Lädt …</div></main>
    </div>`;

  on('#logout', 'click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.session = null;
    location.hash = '';
    await render();
  });

  renderUpdateBox();

  try {
    await ROUTES[route].render(document.getElementById('view'), param);
  } catch (err) {
    document.getElementById('view').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
  }
}

// ----------------------------------------------------------- System-Update

async function renderUpdateBox() {
  const box = document.getElementById('update-box');
  if (!box) return;

  let info;
  try {
    info = await api('/api/app/update');
  } catch {
    return;
  }
  state.data.update = info;

  const stand = info.deployedAt
    ? `aufgespielt ${fmtDate(info.deployedAt)}`
    : `gestartet ${fmtDate(info.startedAt)}`;

  box.innerHTML = `
    <div style="border-top:1px solid var(--border);padding-top:10px">
      <button class="small ${info.updateAvailable ? 'primary' : ''}" id="do-update" style="width:100%"
        ${info.busy ? 'disabled' : ''}>
        ${info.busy ? 'Update läuft …' : 'System-Update'}
      </button>
      ${info.updateAvailable
        ? `<div class="hint" style="margin-top:6px;color:var(--accent)">Neue Version verfügbar${
            info.behind ? ` (${info.behind} Änderung${info.behind === 1 ? '' : 'en'})` : ''}</div>`
        : ''}
      ${info.lastResult === 'failed'
        ? `<div class="hint" style="margin-top:6px;color:var(--red)">Letztes Update fehlgeschlagen:
             ${esc(info.lastError || 'siehe Protokoll')}
             ${info.log ? '<a href="#" id="show-update-log" style="display:block;margin-top:4px">Protokoll ansehen</a>' : ''}</div>`
        : ''}
      <div class="hint" style="margin-top:8px;line-height:1.45">
        Version ${esc(info.version)}${info.commitShort ? ` · ${esc(info.commitShort)}` : ''}<br />
        ${esc(stand)}
        ${info.runnerInstalled ? '' : '<br /><span style="color:var(--amber)">Update-Helfer nicht eingerichtet</span>'}
      </div>
    </div>`;

  on('#show-update-log', 'click', (event) => {
    event.preventDefault();
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" id="log-overlay">
        <div class="modal" style="max-width:760px">
          <h2>Protokoll des letzten Updates</h2>
          <pre style="background:var(--panel-2);padding:10px;border-radius:8px;font-size:12px;
            max-height:60vh;overflow:auto;white-space:pre-wrap">${esc(state.data.update.log)}</pre>
          <button id="log-close" style="margin-top:12px">Schließen</button>
        </div>
      </div>`);
    document.getElementById('log-close').addEventListener('click', () =>
      document.getElementById('log-overlay').remove());
  });

  on('#do-update', 'click', async () => {
    if (!confirm(
      'System jetzt aktualisieren?\n\nDer Hub lädt den neuesten Stand aus dem Repository und startet neu. ' +
      'Das dauert ein bis zwei Minuten, in denen die Oberfläche nicht erreichbar ist. ' +
      'Deine Daten bleiben erhalten.'
    )) return;

    try {
      await api('/api/app/update', { method: 'POST' });
      waitForRestart();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/**
 * Begleitet das Update.
 * Der Neustart wird an der Kennung aus /health erkannt, nicht daran, dass der Hub
 * kurz nicht antwortet. Fehler des Update-Helfers werden angezeigt statt verschluckt.
 */
async function waitForRestart() {
  let bootVorher = null;
  try {
    bootVorher = (await (await fetch('/health', { cache: 'no-store' })).json()).boot;
  } catch { /* nicht schlimm, dann zaehlt allein der Status des Helfers */ }

  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="update-overlay">
      <div class="modal">
        <h2 id="update-title">System wird aktualisiert</h2>
        <p class="sub" id="update-step">Neuester Stand wird geladen …</p>
        <pre id="update-log" hidden style="background:var(--panel-2);padding:10px;border-radius:8px;
          font-size:12px;max-height:220px;overflow:auto;white-space:pre-wrap"></pre>
        <div class="row" style="margin-top:14px">
          <button id="update-close">Fenster schließen</button>
          <button class="primary" id="update-reload">Seite neu laden</button>
        </div>
      </div>
    </div>`);

  const schritt = document.getElementById('update-step');
  const titel = document.getElementById('update-title');
  const protokoll = document.getElementById('update-log');
  const gestartet = Date.now();
  let fertig = false;

  const beenden = () => {
    fertig = true;
    clearInterval(timer);
    const overlay = document.getElementById('update-overlay');
    if (overlay) overlay.remove();
  };
  document.getElementById('update-close').addEventListener('click', beenden);
  document.getElementById('update-reload').addEventListener('click', () => location.reload());

  const timer = setInterval(async () => {
    if (fertig) return;
    const sekunden = Math.round((Date.now() - gestartet) / 1000);

    // 1. Ist der Hub schon mit einer neuen Kennung zurück? Dann ist das Update durch.
    try {
      const health = await (await fetch('/health', { cache: 'no-store' })).json();
      if (bootVorher && health.boot && health.boot !== bootVorher) {
        fertig = true;
        clearInterval(timer);
        titel.textContent = 'Update abgeschlossen';
        schritt.textContent = 'Der Hub ist neu gestartet. Die Seite wird neu geladen …';
        setTimeout(() => location.reload(), 1500);
        return;
      }
    } catch {
      schritt.textContent = `Der Hub startet neu … (${sekunden} s)`;
      return; // Solange er weg ist, gibt es auch keinen Status abzufragen.
    }

    // 2. Was meldet der Update-Helfer?
    try {
      const info = await api('/api/app/update');
      if (info.log) { protokoll.hidden = false; protokoll.textContent = info.log; protokoll.scrollTop = protokoll.scrollHeight; }

      if (info.lastResult === 'failed') {
        fertig = true;
        clearInterval(timer);
        titel.textContent = 'Update fehlgeschlagen';
        schritt.innerHTML = `<span style="color:var(--red)">${esc(info.lastError || 'Unbekannter Fehler')}</span>`;
        return;
      }
      if (info.busy) {
        schritt.textContent = `Neuer Stand wird gebaut … (${sekunden} s)`;
      } else if (info.upToDate) {
        fertig = true;
        clearInterval(timer);
        titel.textContent = 'Bereits aktuell';
        schritt.textContent = 'Es gab nichts Neues zu holen, der Hub läuft unverändert weiter.';
        return;
      } else {
        schritt.textContent = `Update wird vorbereitet … (${sekunden} s)`;
      }
    } catch {
      schritt.textContent = `Der Hub startet neu … (${sekunden} s)`;
    }

    // 3. Notbremse: nach zehn Minuten nicht weiter warten.
    if (sekunden > 600) {
      fertig = true;
      clearInterval(timer);
      titel.textContent = 'Dauert länger als erwartet';
      schritt.innerHTML = 'Der Hub hat sich nicht zurückgemeldet. Auf dem Server nachsehen:<br />' +
        '<code>journalctl -u autoblog-updater -n 50</code>';
    }
  }, 3000);
}

// -------------------------------------------------------------- Anmeldung

function renderAuth() {
  const setup = state.session.needsSetup;
  root.innerHTML = `
    <div class="auth-wrap">
      <form class="auth-card" id="auth-form">
        <div class="brand"><span class="brand-mark">AB</span> Autoblog Hub</div>
        <p class="sub" style="text-align:center;margin-bottom:20px">
          ${setup ? 'Willkommen! Lege dein Konto an.' : 'Bitte anmelden.'}
        </p>
        <div id="auth-error"></div>
        <div class="field">
          <label for="email">E-Mail</label>
          <input id="email" type="email" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="password">Passwort</label>
          <input id="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required />
          ${setup ? '<div class="hint">Mindestens 8 Zeichen.</div>' : ''}
        </div>
        <button class="primary" style="width:100%" type="submit">${setup ? 'Konto anlegen' : 'Anmelden'}</button>
      </form>
    </div>`;

  on('#auth-form', 'submit', async (event) => {
    event.preventDefault();
    const button = root.querySelector('button[type=submit]');
    const body = { email: root.querySelector('#email').value, password: root.querySelector('#password').value };
    try {
      button.disabled = true;
      await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body });
      state.session = null;
      location.hash = '#/dashboard';
      await render();
    } catch (err) {
      root.querySelector('#auth-error').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
      button.disabled = false;
    }
  });
}

// --------------------------------------------------------------- Übersicht

async function renderDashboard(view) {
  const data = await api('/api/app/overview');
  const { stats } = data;

  const keyWarning = data.apiKey.configured
    ? ''
    : `<div class="notice err">Es ist kein Anthropic API-Key hinterlegt. Ohne Key können keine Artikel erzeugt werden.
       <a href="#/settings">Jetzt eintragen</a></div>`;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Übersicht</h1><p class="sub">Dein Redaktionsstand auf einen Blick.</p></div>
      <div class="row"><a class="btn" href="#/sites">Website hinzufügen</a><a class="btn primary" href="#/posts">Post erzeugen</a></div>
    </div>
    ${keyWarning}
    <div class="grid cols-4" style="margin-bottom:18px">
      <div class="stat"><div class="value">${stats.connected}/${stats.sites}</div><div class="label">Websites verbunden</div></div>
      <div class="stat"><div class="value">${stats.published}</div><div class="label">veröffentlicht</div></div>
      <div class="stat"><div class="value">${stats.drafts}</div><div class="label">Entwürfe</div></div>
      <div class="stat"><div class="value">${stats.activePlans}</div><div class="label">aktive Pläne</div></div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h2>Websites</h2>
        ${data.sites.length ? `<table><tbody>${data.sites.map((site) => `
          <tr class="clickable" data-site="${esc(site.id)}">
            <td><strong>${esc(site.name)}</strong><div class="hint">${esc(site.url || 'noch keine URL')}</div></td>
            <td style="text-align:right">
              ${site.connected ? '<span class="badge ok">verbunden</span>' : '<span class="badge warn">nicht verbunden</span>'}
              </td>
          </tr>`).join('')}</tbody></table>`
          : '<div class="empty">Noch keine Website angelegt.</div>'}
      </div>
      <div class="card">
        <h2>Zuletzt erzeugt</h2>
        ${data.recentArticles.length ? `<table><tbody>${data.recentArticles.map((a) => `
          <tr class="clickable" data-article="${esc(a.id)}">
            <td><strong>${esc(a.title || a.keyword)}</strong><div class="hint">${esc(a.site_name)} · ${fmtDate(a.created_at)}</div></td>
            <td style="text-align:right">${statusBadge(a.status)}</td>
          </tr>`).join('')}</tbody></table>`
          : '<div class="empty">Noch keine Artikel erzeugt.</div>'}
      </div>
    </div>

    <div class="card">
      <h2>Letzte Ereignisse</h2>
      ${data.logs.map((entry) => `
        <div class="logline ${esc(entry.level)}"><time>${fmtDate(entry.created_at)}</time><span>${esc(entry.message)}</span></div>
      `).join('') || '<div class="empty">Noch keine Ereignisse.</div>'}
    </div>`;

  on('[data-site]', 'click', (e) => navigate('site', e.currentTarget.dataset.site));
  on('[data-article]', 'click', (e) => navigate('article', e.currentTarget.dataset.article));
}

// ---------------------------------------------------------------- Websites

async function renderSites(view) {
  const sites = await api('/api/app/sites');

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Websites</h1><p class="sub">Jede WordPress-Seite bekommt hier einen eigenen Token für das Plugin.</p></div>
    </div>

    <div class="card">
      <h2>Neue Website anlegen</h2>
      <form id="new-site" class="row" style="align-items:flex-end">
        <div style="flex:2;min-width:200px"><label for="site-name">Name</label><input id="site-name" placeholder="z. B. Reiseblog" required /></div>
        <div style="flex:3;min-width:220px"><label for="site-url">WordPress-Adresse (optional)</label><input id="site-url" placeholder="https://meinblog.de" /></div>
        <button class="primary" type="submit">Anlegen</button>
      </form>
      <div class="hint">Die Adresse trägt das Plugin beim Verbinden automatisch nach.</div>
    </div>

    ${sites.length ? sites.map((site) => `
      <div class="card">
        <div class="row">
          <div style="flex:1">
            <h2 style="margin-bottom:2px">${esc(site.name)}
              ${site.connected ? '<span class="badge ok">verbunden</span>' : '<span class="badge warn">wartet auf Plugin</span>'}
            </h2>
            <p class="sub">${esc(site.url || 'noch keine Adresse')} · zuletzt gesehen: ${fmtDate(site.last_seen_at)}</p>
          </div>
          <a class="btn" href="#/site/${esc(site.id)}">Öffnen</a>
        </div>
      </div>`).join('')
      : '<div class="card"><div class="empty">Noch keine Website angelegt.</div></div>'}`;

  on('#new-site', 'submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    await guard(button, async () => {
      const site = await api('/api/app/sites', {
        method: 'POST',
        body: { name: root.querySelector('#site-name').value, url: root.querySelector('#site-url').value },
      });
      navigate('site', site.id);
    });
  });
}

async function renderSite(view, siteId) {
  const { site, topics, articles, plans } = await api(`/api/app/sites/${siteId}`);
  const tab = state.data.siteTab || 'connect';
  const hubUrl = location.origin;

  const tabs = { connect: 'Verbindung', content: 'Inhalt & Stil', topics: 'Themen', articles: 'Artikel' };

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(site.name)}</h1>
        <p class="sub">${esc(site.url || 'noch keine Adresse')} ·
          ${site.connected ? '<span class="badge ok">verbunden</span>' : '<span class="badge warn">wartet auf Plugin</span>'}</p>
      </div>
      <div class="row">
        <button id="test-connection">Verbindung testen</button>
        <button class="danger" id="delete-site">Löschen</button>
      </div>
    </div>

    <div class="tabs">
      ${Object.entries(tabs).map(([key, label]) => `<button data-tab="${key}" class="${tab === key ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="tab-body"></div>`;

  const body = view.querySelector('#tab-body');

  if (tab === 'connect') {
    body.innerHTML = `
      <div class="card">
        <h2>WordPress verbinden</h2>
        <p class="sub">Plugin <strong>Autoblog Connector</strong> in WordPress installieren, aktivieren und unter
          <em>Einstellungen → Autoblog</em> diese beiden Angaben eintragen.</p>
        <div class="field" style="margin-top:16px">
          <label>1. Hub-Adresse</label>
          <div class="row"><code class="pair" id="hub-url">${esc(hubUrl)}</code>
            <button class="small" data-copy="hub-url">Kopieren</button></div>
          <div class="hint">Diese Adresse muss von deinem WordPress aus erreichbar sein.</div>
        </div>
        <div class="field">
          <label>2. Website-Token</label>
          <div class="row"><code class="pair" id="site-token">${esc(site.token)}</code>
            <button class="small" data-copy="site-token">Kopieren</button>
            <button class="small danger" id="new-token">Neu erzeugen</button></div>
          <div class="hint">Gilt nur für diese Website. Wie ein Passwort behandeln und nicht weitergeben.</div>
        </div>
      </div>

      <div class="card">
        <h2>Übertragungsweg</h2>
        <div class="grid cols-2">
          <div class="field">
            <label for="delivery">Wie kommen Artikel nach WordPress?</label>
            <select id="delivery">
              <option value="push" ${site.delivery === 'push' ? 'selected' : ''}>Hub sendet an WordPress (Standard)</option>
              <option value="pull" ${site.delivery === 'pull' ? 'selected' : ''}>WordPress holt selbst ab (für nicht erreichbare Seiten)</option>
            </select>
            <div class="hint">„Abholen“ hilft bei lokalen Installationen oder wenn WordPress hinter einer Firewall liegt.</div>
          </div>
          <div class="field">
            <label for="wp_status">Beitragsstatus in WordPress</label>
            <select id="wp_status">
              <option value="draft" ${site.wp_status === 'draft' ? 'selected' : ''}>Entwurf (empfohlen zum Start)</option>
              <option value="pending" ${site.wp_status === 'pending' ? 'selected' : ''}>Zur Prüfung ausstehend</option>
              <option value="publish" ${site.wp_status === 'publish' ? 'selected' : ''}>Sofort veröffentlichen</option>
            </select>
          </div>
        </div>
        <button class="primary" data-save-site>Speichern</button>
      </div>`;

    on('[data-copy]', 'click', (event) => {
      navigator.clipboard.writeText(root.querySelector(`#${event.currentTarget.dataset.copy}`).textContent.trim());
      toast('In die Zwischenablage kopiert.');
    });
    on('#new-token', 'click', async (event) => {
      if (!confirm('Neuen Token erzeugen? Die bestehende Verbindung wird sofort ungültig.')) return;
      await guard(event.currentTarget, async () => {
        await api(`/api/app/sites/${siteId}/token`, { method: 'POST' });
        toast('Neuer Token erzeugt. Bitte im WordPress-Plugin eintragen.');
        await render();
      });
    });
  }

  if (tab === 'content') {
    body.innerHTML = `
      <div class="card">
        <h2>Redaktionelle Vorgaben</h2>
        <p class="sub">Diese Angaben fließen in jeden Artikel dieser Website ein.</p>
        <div class="grid cols-2" style="margin-top:14px">
          <div class="field"><label for="name">Name</label><input id="name" value="${esc(site.name)}" /></div>
          <div class="field"><label for="url">WordPress-Adresse</label><input id="url" value="${esc(site.url)}" /></div>
          <div class="field">
            <label for="language">Sprache</label>
            <select id="language">
              ${['de:Deutsch', 'en:Englisch', 'fr:Französisch', 'es:Spanisch'].map((entry) => {
                const [code, label] = entry.split(':');
                return `<option value="${code}" ${site.language === code ? 'selected' : ''}>${label}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="field"><label for="word_count">Artikellänge (Wörter)</label><input id="word_count" type="number" min="300" max="3000" step="100" value="${site.word_count}" /></div>
          <div class="field"><label for="audience">Zielgruppe</label><input id="audience" value="${esc(site.audience)}" placeholder="z. B. Einsteiger im Bereich Fotografie" /></div>
          <div class="field"><label for="tone">Tonalität</label><input id="tone" value="${esc(site.tone)}" /></div>
        </div>
        <div class="field"><label for="topic_focus">Themenschwerpunkte</label><input id="topic_focus" value="${esc(site.topic_focus)}" placeholder="z. B. Reisen in Südostasien, Budget-Tipps" /></div>
        <div class="field">
          <label for="extra_prompt">Zusätzliche Anweisungen an die KI</label>
          <textarea id="extra_prompt" placeholder="z. B. Immer eine Checkliste am Ende ergänzen. Keine Preisangaben nennen.">${esc(site.extra_prompt)}</textarea>
        </div>
        <div class="grid cols-2">
          <div class="field"><label for="wp_category">Standard-Kategorie in WordPress</label><input id="wp_category" value="${esc(site.wp_category)}" placeholder="wird bei Bedarf angelegt" /></div>
          <div class="field"><label for="wp_author_id">Autor-ID in WordPress (optional)</label><input id="wp_author_id" type="number" min="0" value="${site.wp_author_id || 0}" /></div>
        </div>
        <button class="primary" data-save-site>Speichern</button>
      </div>`;
  }

  if (tab === 'topics') {
    const open = topics.filter((t) => t.status === 'open');
    body.innerHTML = `
      <div class="card">
        <h2>Themen sammeln</h2>
        <p class="sub">Wiederkehrende Posts arbeiten diese Liste von oben nach unten ab.
          Ist sie leer, erzeugt die KI neue Themen aus den Themenbereichen des Plans.</p>
        <div class="field" style="margin-top:14px">
          <label for="keywords">Eigene Themen (eine Zeile pro Thema)</label>
          <textarea id="keywords" placeholder="Kaffeemaschine entkalken&#10;Espresso vs. Filterkaffee"></textarea>
        </div>
        <div class="row">
          <button class="primary" id="add-topics">Themen hinzufügen</button>
          <button id="suggest-topics">10 Themen von der KI vorschlagen lassen</button>
        </div>
      </div>
      <div class="card">
        <h2>Offene Themen (${open.length})</h2>
        ${topics.length ? `<table><thead><tr><th>Thema</th><th>Quelle</th><th>Status</th><th></th></tr></thead><tbody>
          ${topics.map((topic) => `<tr>
            <td><strong>${esc(topic.keyword)}</strong>${topic.angle ? `<div class="hint">${esc(topic.angle)}</div>` : ''}</td>
            <td><span class="badge">${topic.source === 'ai' ? 'KI' : 'manuell'}</span></td>
            <td>${topic.status === 'open' ? '<span class="badge info">offen</span>' : '<span class="badge ok">verwendet</span>'}</td>
            <td style="text-align:right;white-space:nowrap">
              ${topic.status === 'open' ? `<button class="small primary" data-write="${esc(topic.id)}" data-keyword="${esc(topic.keyword)}">Artikel schreiben</button>` : ''}
              <button class="small danger" data-del-topic="${esc(topic.id)}">Löschen</button>
            </td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Noch keine Themen.</div>'}
      </div>`;

    on('#add-topics', 'click', (event) => guard(event.currentTarget, async () => {
      await api(`/api/app/sites/${siteId}/topics`, { method: 'POST', body: { keywords: root.querySelector('#keywords').value } });
      await render();
    }));
    on('#suggest-topics', 'click', (event) => guard(event.currentTarget, async () => {
      const result = await api(`/api/app/sites/${siteId}/topics/suggest`, { method: 'POST', body: { count: 10 } });
      toast(`${result.added} Themen ergänzt.`);
      await render();
    }));
    on('[data-del-topic]', 'click', (event) => guard(null, async () => {
      await api(`/api/app/topics/${event.currentTarget.dataset.delTopic}`, { method: 'DELETE' });
      await render();
    }));
    on('[data-write]', 'click', (event) => guard(event.currentTarget, async () => {
      const { keyword, write } = event.currentTarget.dataset;
      const article = await api('/api/app/articles', { method: 'POST', body: { site_id: siteId, keyword, topic_id: write } });
      navigate('article', article.id);
    }));
  }

  if (tab === 'articles') {
    body.innerHTML = `
      <div class="card">
        <h2>Artikel schreiben</h2>
        <form id="write-form" class="row" style="align-items:flex-end">
          <div style="flex:1;min-width:240px"><label for="keyword">Thema oder Keyword</label><input id="keyword" required placeholder="z. B. Kaffeemaschine entkalken" /></div>
          <button class="primary" type="submit">Artikel erzeugen</button>
        </form>
      </div>
      <div class="card">
        <h2>Artikel dieser Website</h2>
        <p class="sub">Offene zuerst, darunter das Archiv.</p>
        ${articles.length ? articleTable(articles) : '<div class="empty">Noch keine Artikel.</div>'}
      </div>`;

    on('#write-form', 'submit', (event) => {
      event.preventDefault();
      guard(event.target.querySelector('button'), async () => {
        const article = await api('/api/app/articles', {
          method: 'POST',
          body: { site_id: siteId, keyword: root.querySelector('#keyword').value },
        });
        navigate('article', article.id);
      });
    });
    on('[data-article]', 'click', (event) => navigate('article', event.currentTarget.dataset.article));
  }

  on('.tabs button', 'click', (event) => {
    state.data.siteTab = event.currentTarget.dataset.tab;
    render();
  });
  on('#test-connection', 'click', async (event) => {
    const knopf = event.currentTarget;
    const beschriftung = knopf.textContent;
    knopf.disabled = true;
    knopf.textContent = 'Wird geprüft …';
    try {
      const result = await api(`/api/app/sites/${siteId}/test`, { method: 'POST' });
      toast(result.message || 'Verbindung steht.', 'ok');
      await render();
    } catch (err) {
      // Der Server liefert die einzelnen Prüfschritte am Fehler mit.
      const schritte = (err.data && err.data.schritte) || [];

      document.body.insertAdjacentHTML('beforeend', `
        <div class="modal-backdrop" id="test-overlay">
          <div class="modal">
            <h2>Verbindung konnte nicht aufgebaut werden</h2>
            <div class="notice err">${esc(err.message)}</div>
            ${schritte.length ? `<h3 style="margin-top:16px">Was der Hub geprüft hat</h3>
              <div>${schritte.map((s) => `<div class="logline">
                <span>${s.ok ? '<span class="badge ok">ok</span>' : '<span class="badge err">Problem</span>'}</span>
                <span>${esc(s.text)}</span></div>`).join('')}</div>` : ''}
            <button id="test-close" style="margin-top:16px">Schließen</button>
          </div>
        </div>`);
      document.getElementById('test-close').addEventListener('click', () =>
        document.getElementById('test-overlay').remove());
    } finally {
      knopf.disabled = false;
      knopf.textContent = beschriftung;
    }
  });
  on('#delete-site', 'click', async () => {
    if (!confirm(`„${site.name}“ mit allen Artikeln löschen?`)) return;
    await api(`/api/app/sites/${siteId}`, { method: 'DELETE' });
    navigate('sites');
  });
  on('[data-save-site]', 'click', (event) => guard(event.currentTarget, async () => {
    const body = {};
    const fields = ['name', 'url', 'language', 'word_count', 'audience', 'tone', 'topic_focus', 'extra_prompt',
      'wp_category', 'wp_author_id', 'wp_status', 'delivery'];
    for (const field of fields) {
      const el = root.querySelector(`#${field}`);
      if (el) body[field] = el.value;
    }
    await api(`/api/app/sites/${siteId}`, { method: 'PATCH', body });
    toast('Gespeichert.');
    await render();
  }));
}

// ------------------------------------------------------------------- Posts

async function renderPosts(view) {
  const tab = state.data.postsTab || 'generate';
  const [sites, plans] = await Promise.all([api('/api/app/sites'), api('/api/app/plans')]);
  const tabs = { generate: 'Post erzeugen', recurring: 'Wiederkehrende Posts', target: 'Gezielte Posts' };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Posts</h1><p class="sub">Einzelne Beiträge erzeugen oder ganze Redaktionspläne laufen lassen.</p></div>
    </div>
    <div class="tabs">
      ${Object.entries(tabs).map(([key, label]) =>
        `<button data-ptab="${key}" class="${tab === key ? 'active' : ''}">${label}${key === 'target' ? ' <span class="badge">bald</span>' : ''}</button>`).join('')}
    </div>
    <div id="posts-body"></div>`;

  const body = view.querySelector('#posts-body');
  if (!sites.length) {
    body.innerHTML = `<div class="card"><div class="empty">
      <p><strong>Noch keine Website angelegt.</strong></p>
      <p class="sub">Lege zuerst eine Website an und verbinde sie mit dem WordPress-Plugin.</p>
      <a class="btn primary" href="#/sites">Website anlegen</a></div></div>`;
  } else if (tab === 'generate') {
    body.innerHTML = `
      <div class="card">
        <h2>Post erzeugen</h2>
        <p class="sub">Ein Thema eingeben – der Hub schreibt daraus einen fertigen Beitrag.</p>
        <form id="generate-form" style="margin-top:14px">
          <div class="grid cols-2">
            <div class="field">
              <label for="gen-site">Website</label>
              <select id="gen-site">${sites.map((site) =>
                `<option value="${esc(site.id)}">${esc(site.name)}${site.connected ? '' : ' (nicht verbunden)'}</option>`).join('')}</select>
            </div>
            <div class="field">
              <label for="gen-keyword">Thema oder Keyword</label>
              <input id="gen-keyword" required placeholder="z. B. Kaffeemaschine richtig entkalken" />
            </div>
          </div>
          <div class="field">
            <label for="gen-angle">Blickwinkel (optional)</label>
            <input id="gen-angle" placeholder="z. B. Schritt-für-Schritt-Anleitung für Einsteiger" />
          </div>
          <button class="primary" type="submit">Post erzeugen</button>
        </form>
      </div>`;

    on('#generate-form', 'submit', (event) => {
      event.preventDefault();
      guard(event.target.querySelector('button'), async () => {
        const article = await api('/api/app/articles', {
          method: 'POST',
          body: {
            site_id: root.querySelector('#gen-site').value,
            keyword: root.querySelector('#gen-keyword').value,
            angle: root.querySelector('#gen-angle').value,
          },
        });
        navigate('article', article.id);
      });
    });
  } else if (tab === 'recurring') {
    body.innerHTML = `
      <div class="card">
        <h2>Neuen Plan anlegen</h2>
        <p class="sub">Themenbereiche festlegen und wie oft gepostet wird – der Rest läuft automatisch.</p>
        <form id="plan-form" style="margin-top:14px">
          <div class="grid cols-2">
            <div class="field">
              <label for="plan-site">Website</label>
              <select id="plan-site">${sites.map((site) => `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join('')}</select>
            </div>
            <div class="field"><label for="plan-name">Name des Plans</label><input id="plan-name" placeholder="z. B. Ratgeber Kaffee" /></div>
          </div>
          <div class="field">
            <label for="plan-areas">Themenbereiche (eine Zeile je Bereich)</label>
            <textarea id="plan-areas" placeholder="Kaffeezubereitung zu Hause&#10;Kaffeemaschinen pflegen&#10;Bohnensorten und Röstung"></textarea>
            <div class="hint">Daraus leitet die KI konkrete Artikelthemen ab, sobald die Themenliste der Website leer ist.</div>
          </div>
          <div class="grid cols-2">
            <div class="field"><label for="plan-per-week">Posts pro Woche</label><input id="plan-per-week" type="number" min="1" max="14" value="2" /></div>
            <div class="field"><label for="plan-hour">Bevorzugte Uhrzeit (UTC)</label><input id="plan-hour" type="number" min="0" max="23" value="9" /></div>
          </div>
          <div class="field">
            <label><input type="checkbox" id="plan-auto-publish" style="width:auto;margin-right:8px" />
              Fertige Posts automatisch an WordPress senden</label>
            <div class="hint">Ohne Haken bleiben sie als Entwurf im Hub und warten auf deine Freigabe.</div>
          </div>
          <button class="primary" type="submit">Plan anlegen</button>
        </form>
      </div>

      <div class="card">
        <h2>Laufende Pläne (${plans.length})</h2>
        ${plans.length ? plans.map((plan) => `
          <div style="border-top:1px solid var(--border);padding:14px 0" data-plan="${esc(plan.id)}">
            <div class="row">
              <div style="flex:1">
                <strong>${esc(plan.name)}</strong>
                ${plan.active ? '<span class="badge ok">aktiv</span>' : '<span class="badge">pausiert</span>'}
                ${plan.auto_publish ? '<span class="badge info">sendet automatisch</span>' : ''}
                <div class="hint">${esc(plan.site_name)} · ${plan.per_week}× pro Woche ·
                  ${plan.article_count} Posts erzeugt · nächster Lauf: ${plan.active ? fmtDate(plan.next_run_at) : '–'}</div>
              </div>
              <div class="row">
                <button class="small" data-toggle-plan="${esc(plan.id)}" data-active="${plan.active}">${plan.active ? 'Pausieren' : 'Aktivieren'}</button>
                <button class="small" data-run-plan="${esc(plan.id)}">Jetzt ausführen</button>
                <button class="small danger" data-del-plan="${esc(plan.id)}">Löschen</button>
              </div>
            </div>
            <div class="grid cols-2" style="margin-top:10px">
              <div class="field" style="margin:0">
                <label>Themenbereiche</label>
                <textarea data-areas="${esc(plan.id)}" style="min-height:70px">${esc(plan.areas)}</textarea>
              </div>
              <div class="row" style="align-items:flex-end">
                <div class="field" style="margin:0;width:130px"><label>pro Woche</label>
                  <input type="number" min="1" max="14" data-perweek="${esc(plan.id)}" value="${plan.per_week}" /></div>
                <div class="field" style="margin:0;width:130px"><label>Uhrzeit (UTC)</label>
                  <input type="number" min="0" max="23" data-hour="${esc(plan.id)}" value="${plan.publish_hour}" /></div>
                <button class="small primary" data-save-plan="${esc(plan.id)}">Speichern</button>
              </div>
            </div>
          </div>`).join('')
          : '<div class="empty">Noch kein Plan angelegt.</div>'}
      </div>`;

    on('#plan-form', 'submit', (event) => {
      event.preventDefault();
      guard(event.target.querySelector('button'), async () => {
        await api('/api/app/plans', {
          method: 'POST',
          body: {
            site_id: root.querySelector('#plan-site').value,
            name: root.querySelector('#plan-name').value,
            areas: root.querySelector('#plan-areas').value,
            per_week: root.querySelector('#plan-per-week').value,
            publish_hour: root.querySelector('#plan-hour').value,
            auto_publish: root.querySelector('#plan-auto-publish').checked,
          },
        });
        toast('Plan angelegt.');
        await render();
      });
    });
    on('[data-save-plan]', 'click', (event) => guard(event.currentTarget, async () => {
      const id = event.currentTarget.dataset.savePlan;
      await api(`/api/app/plans/${id}`, {
        method: 'PATCH',
        body: {
          areas: root.querySelector(`[data-areas="${id}"]`).value,
          per_week: root.querySelector(`[data-perweek="${id}"]`).value,
          publish_hour: root.querySelector(`[data-hour="${id}"]`).value,
        },
      });
      toast('Gespeichert.');
      await render();
    }));
    on('[data-toggle-plan]', 'click', (event) => guard(event.currentTarget, async () => {
      const { togglePlan, active } = event.currentTarget.dataset;
      await api(`/api/app/plans/${togglePlan}`, { method: 'PATCH', body: { active: active !== '1' } });
      await render();
    }));
    on('[data-run-plan]', 'click', (event) => guard(event.currentTarget, async () => {
      const result = await api(`/api/app/plans/${event.currentTarget.dataset.runPlan}/run`, { method: 'POST' });
      toast(result.produced ? `${result.produced} Post(s) erzeugt.` : 'Durchlauf beendet – siehe Protokoll.');
      await render();
    }));
    on('[data-del-plan]', 'click', async (event) => {
      if (!confirm('Diesen Plan löschen? Bereits erzeugte Posts bleiben erhalten.')) return;
      await api(`/api/app/plans/${event.currentTarget.dataset.delPlan}`, { method: 'DELETE' });
      await render();
    });
  } else {
    body.innerHTML = `
      <div class="card">
        <h2>Gezielte Posts <span class="badge">in Vorbereitung</span></h2>
        <p class="sub">Geplant für die nächste Ausbaustufe.</p>
        <p>Hier wirst du Posts gezielt auf recherchierte Suchbegriffe ansetzen können:</p>
        <ul>
          <li>Keyword mit Suchvolumen, Wettbewerb und Suchintention recherchieren</li>
          <li>Die aktuell führenden Ergebnisse analysieren und inhaltliche Lücken finden</li>
          <li>Daraus eine Gliederung ableiten, die diese Lücken gezielt schließt</li>
          <li>Interne Verlinkung auf bereits veröffentlichte Beiträge vorschlagen</li>
        </ul>
        <p class="sub">Die Struktur dafür steht bereits: Posts werden mit Thema und Blickwinkel erzeugt –
          die Recherche liefert später genau diese beiden Angaben automatisch.</p>
      </div>`;
  }

  on('[data-ptab]', 'click', (event) => { state.data.postsTab = event.currentTarget.dataset.ptab; render(); });
}

// ----------------------------------------------------------------- Artikel

function articleTable(articles) {
  return `<table><thead><tr><th>Titel</th><th>Status</th><th>Wörter</th><th>Erstellt</th></tr></thead><tbody>
    ${articles.map((a) => `<tr class="clickable" data-article="${esc(a.id)}">
      <td><strong>${esc(a.title || a.keyword)}</strong>
        ${a.site_name ? `<div class="hint">${esc(a.site_name)}</div>` : ''}
        ${a.origin === 'recurring' ? '<span class="badge info">wiederkehrend</span>' : ''}
        ${a.archived ? '<span class="badge">archiviert</span>' : ''}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${a.word_count || '–'}</td>
      <td>${fmtDate(a.created_at)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

async function renderArticles(view) {
  const archiv = state.data.showArchive ? '1' : '0';
  const query = new URLSearchParams({ archived: archiv });
  if (state.data.filterSite) query.set('site', state.data.filterSite);

  const [data, sites] = await Promise.all([api(`/api/app/articles?${query}`), api('/api/app/sites')]);
  const { articles, counts } = data;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Artikel</h1><p class="sub">Alle Beiträge bleiben hier gespeichert, auch nach dem Senden an WordPress.</p></div>
      <div class="row">
        <select id="filter-site" style="width:auto">
          <option value="">Alle Websites</option>
          ${sites.map((s) => `<option value="${esc(s.id)}" ${state.data.filterSite === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="tabs">
      <button data-arch="0" class="${state.data.showArchive ? '' : 'active'}">In Arbeit (${counts.offen})</button>
      <button data-arch="1" class="${state.data.showArchive ? 'active' : ''}">Archiv (${counts.archiv})</button>
    </div>
    <div class="card">${articles.length ? articleTable(articles) : `<div class="empty">${
      state.data.showArchive
        ? 'Noch nichts im Archiv. Beiträge landen hier, sobald sie erfolgreich an WordPress übergeben wurden.'
        : 'Keine offenen Beiträge.'}</div>`}</div>`;

  on('[data-arch]', 'click', (event) => {
    state.data.showArchive = event.currentTarget.dataset.arch === '1';
    render();
  });

  on('#filter-site', 'change', (event) => { state.data.filterSite = event.target.value; render(); });
  on('[data-article]', 'click', (event) => navigate('article', event.currentTarget.dataset.article));
}

async function renderArticle(view, articleId) {
  const article = await api(`/api/app/articles/${articleId}`);
  const tab = state.data.articleTab || 'preview';

  if (article.status === 'generating') {
    view.innerHTML = `
      <div class="page-head"><div><h1>${esc(article.title || article.keyword)}</h1>
        <p class="sub">${esc(article.site_name)}</p></div></div>
      <div class="card"><div class="empty">
        <p><strong>Der Artikel wird gerade geschrieben.</strong></p>
        <p class="sub">Das dauert je nach Länge etwa 1–3 Minuten. Diese Seite aktualisiert sich automatisch.</p>
      </div></div>`;
    setTimeout(() => { if (state.route === 'article' && state.param === articleId) render(); }, 5000);
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(article.title || article.keyword)}</h1>
        <p class="sub">${esc(article.site_name)} · ${statusBadge(article.status)} · ${article.word_count} Wörter ·
          ${esc(article.model || '')} ${article.wp_url ? `· <a href="${esc(article.wp_url)}" target="_blank" rel="noopener">in WordPress ansehen</a>` : ''}
          ${article.archived ? `· <span class="badge">archiviert ${fmtDate(article.archived_at)}</span>` : ''}</p>
      </div>
      <div class="row">
        ${article.status !== 'published' ? '<button class="primary" id="publish">An WordPress senden</button>' : '<button id="publish">Erneut senden</button>'}
        <button id="regenerate">Neu schreiben</button>
        <button id="toggle-archive">${article.archived ? 'Aus dem Archiv holen' : 'Archivieren'}</button>
        <button class="danger" id="delete-article">Löschen</button>
      </div>
    </div>
    ${article.error ? `<div class="notice err">${esc(article.error)}</div>` : ''}

    <div class="tabs">
      <button data-atab="preview" class="${tab === 'preview' ? 'active' : ''}">Vorschau</button>
      <button data-atab="edit" class="${tab === 'edit' ? 'active' : ''}">Bearbeiten</button>
      <button data-atab="seo" class="${tab === 'seo' ? 'active' : ''}">SEO</button>
      <button data-atab="images" class="${tab === 'images' ? 'active' : ''}">Bilder${
        article.images && article.images.length ? ` (${article.images.filter((i) => i.status === 'ready').length})` : ''}</button>
    </div>
    <div class="card">
      ${tab === 'preview' ? `<div class="preview"><h1 style="margin-top:0">${esc(article.title)}</h1>${article.content_html}</div>` : ''}
      ${tab === 'edit' ? `
        <div class="field"><label for="title">Titel</label><input id="title" value="${esc(article.title)}" /></div>
        <div class="field"><label for="excerpt">Anreißer</label><textarea id="excerpt" style="min-height:60px">${esc(article.excerpt)}</textarea></div>
        <div class="field"><label for="content_html">Inhalt (HTML)</label><textarea id="content_html" class="code">${esc(article.content_html)}</textarea></div>
        <button class="primary" id="save-article">Speichern</button>` : ''}
      ${tab === 'images' ? (article.images && article.images.length ? `
        <div class="grid cols-2">
          ${article.images.map((img) => `
            <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
              ${img.url
                ? `<img src="${esc(img.url)}" alt="${esc(img.alt)}" style="width:100%;display:block;aspect-ratio:3/2;object-fit:cover" />`
                : `<div class="empty" style="padding:40px 10px">${img.status === 'failed'
                    ? `<span class="badge err">fehlgeschlagen</span><div class="hint" style="margin-top:8px">${esc(img.error || '')}</div>`
                    : '<span class="badge warn">wird erzeugt …</span>'}</div>`}
              <div style="padding:12px">
                <div><span class="badge ${img.slot === 1 ? 'info' : ''}">${img.slot === 1 ? 'Beitragsbild' : `im Text: [[BILD:${img.slot}]]`}</span></div>
                <div class="hint" style="margin-top:8px"><strong>Alt:</strong> ${esc(img.alt)}</div>
                ${img.caption ? `<div class="hint"><strong>Unterschrift:</strong> ${esc(img.caption)}</div>` : ''}
                <details style="margin-top:6px"><summary class="hint">Bildbeschreibung</summary>
                  <div class="hint" style="margin-top:4px">${esc(img.motif)}</div></details>
              </div>
            </div>`).join('')}
        </div>
        <div class="row" style="margin-top:14px">
          <button id="regen-images">Bilder neu erzeugen</button>
          <span class="hint">Ersetzt alle Bilder dieses Artikels. Die Bildkonzepte bleiben gleich.</span>
        </div>` : `<div class="empty">
          <p>Zu diesem Artikel gibt es keine Bilder.</p>
          <p class="sub">${article.imagesEnabled
            ? 'Der Artikel wurde erzeugt, bevor die Bildfunktion aktiv war. Schreibe ihn neu, dann entstehen Bildkonzepte.'
            : 'Die Bildfunktion ist noch nicht eingerichtet. Das geht unter Einstellungen → Bilder.'}</p>
        </div>`) : ''}
      ${tab === 'seo' ? `
        <div class="grid cols-2">
          <div class="field"><label for="slug">URL-Slug</label><input id="slug" value="${esc(article.slug)}" /></div>
          <div class="field"><label for="category">Kategorie</label><input id="category" value="${esc(article.category)}" /></div>
          <div class="field"><label for="meta_title">SEO-Titel</label><input id="meta_title" value="${esc(article.meta_title)}" /></div>
          <div class="field"><label for="tags">Schlagwörter (kommagetrennt)</label><input id="tags" value="${esc(article.tags)}" /></div>
        </div>
        <div class="field"><label for="meta_desc">SEO-Beschreibung</label><textarea id="meta_desc" style="min-height:60px">${esc(article.meta_desc)}</textarea></div>
        <button class="primary" id="save-article">Speichern</button>` : ''}
    </div>`;

  on('[data-atab]', 'click', (event) => { state.data.articleTab = event.currentTarget.dataset.atab; render(); });
  on('#regen-images', 'click', (event) => guard(event.currentTarget, async () => {
    const result = await api(`/api/app/articles/${articleId}/images`, { method: 'POST' });
    toast(`${result.images} Bild(er) erzeugt.`);
    await render();
  }));
  on('#save-article', 'click', (event) => guard(event.currentTarget, async () => {
    const body = {};
    for (const field of ['title', 'excerpt', 'content_html', 'slug', 'category', 'meta_title', 'meta_desc', 'tags']) {
      const el = root.querySelector(`#${field}`);
      if (el) body[field] = el.value;
    }
    await api(`/api/app/articles/${articleId}`, { method: 'PATCH', body });
    toast('Gespeichert.');
    await render();
  }));
  on('#publish', 'click', (event) => guard(event.currentTarget, async () => {
    const result = await api(`/api/app/articles/${articleId}/publish`, { method: 'POST' });
    toast(result.status === 'published'
      ? 'An WordPress übertragen und hier ins Archiv gelegt.'
      : 'In die Warteschlange gelegt, WordPress holt den Artikel ab.');
    await render();
  }));
  on('#toggle-archive', 'click', (event) => guard(event.currentTarget, async () => {
    await api(`/api/app/articles/${articleId}/archive`, { method: 'POST', body: { archived: !article.archived } });
    toast(article.archived ? 'Zurück in die Arbeitsliste.' : 'Archiviert. Der Beitrag bleibt vollständig gespeichert.');
    await render();
  }));
  on('#regenerate', 'click', (event) => guard(event.currentTarget, async () => {
    const created = await api(`/api/app/articles/${articleId}/regenerate`, { method: 'POST' });
    navigate('article', created.id);
  }));
  on('#delete-article', 'click', async () => {
    if (!confirm('Diesen Artikel löschen?')) return;
    await api(`/api/app/articles/${articleId}`, { method: 'DELETE' });
    navigate('articles');
  });
}

// ----------------------------------------------------------- Einstellungen

async function renderSettings(view) {
  const data = await api('/api/app/settings');

  view.innerHTML = `
    <div class="page-head"><div><h1>Einstellungen</h1><p class="sub">Gelten für alle Websites.</p></div></div>

    <div class="card">
      <h2>Anthropic API-Key</h2>
      <p class="sub">Wird für die Texterzeugung gebraucht. Erhältlich unter
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
      <div class="field" style="margin-top:14px">
        <label for="anthropic_api_key">API-Key</label>
        <input id="anthropic_api_key" type="password" placeholder="${data.apiKey.configured ? `hinterlegt (${esc(data.apiKey.hint)})` : 'sk-ant-…'}" />
        <div class="hint">${data.apiKey.configured
          ? `Ein Key ist hinterlegt (Quelle: ${data.apiKey.source === 'env' ? 'Umgebungsvariable' : 'Oberfläche'}). Feld leer lassen, um ihn zu behalten.`
          : 'Noch kein Key hinterlegt. Ohne Key können keine Artikel erzeugt werden.'}</div>
      </div>
      <div class="grid cols-2">
        <div class="field">
          <label for="model">Modell</label>
          <select id="model">${data.models.map((m) => `<option value="${esc(m.id)}" ${data.model === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="effort">Sorgfalt</label>
          <select id="effort">
            ${['low:niedrig – schnell und günstig', 'medium:mittel', 'high:hoch – Standard', 'xhigh:sehr hoch – beste Qualität'].map((entry) => {
              const [value, label] = entry.split(':');
              return `<option value="${value}" ${data.effort === value ? 'selected' : ''}>${label}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Marke &amp; Standardvorgaben</h2>
      <div class="grid cols-2">
        <div class="field"><label for="hub_name">Name dieses Hubs</label><input id="hub_name" value="${esc(data.hub_name)}" /></div>
        <div class="field"><label for="brand_name">Markenname</label><input id="brand_name" value="${esc(data.brand_name)}" /></div>
        <div class="field"><label for="default_language">Standardsprache</label>
          <select id="default_language">
            ${['de:Deutsch', 'en:Englisch', 'fr:Französisch', 'es:Spanisch'].map((entry) => {
              const [code, label] = entry.split(':');
              return `<option value="${code}" ${data.default_language === code ? 'selected' : ''}>${label}</option>`;
            }).join('')}
          </select></div>
        <div class="field"><label for="default_word_count">Standardlänge (Wörter)</label><input id="default_word_count" type="number" min="300" max="3000" step="100" value="${esc(data.default_word_count)}" /></div>
      </div>
      <div class="field"><label for="default_tone">Standard-Tonalität</label><input id="default_tone" value="${esc(data.default_tone)}" /></div>
      <div class="field"><label for="brand_description">Über die Marke</label><textarea id="brand_description" placeholder="Was macht ihr, was ist euch wichtig?">${esc(data.brand_description)}</textarea></div>
      <div class="field"><label for="global_prompt">Grundsätzliche Anweisungen an die KI</label>
        <textarea id="global_prompt" placeholder="z. B. Niemals Heilversprechen. Immer gendern. Immer eine Quellenangabe am Ende.">${esc(data.global_prompt)}</textarea>
        <div class="hint">Kurze Regeln, die zu jedem Auftrag ergänzt werden. Das ausführliche Regelwerk steht unten im Prompt-Framework.</div></div>
      <button class="primary" id="save-settings">Speichern</button>
    </div>

    <div class="card">
      <h2>Bilder</h2>
      <p class="sub">Claude erzeugt keine Bilder. Der Hub spricht dafür einen Bilddienst an,
        der die OpenAI-Bildschnittstelle versteht. Die fertigen Bilder wandern beim Veröffentlichen
        automatisch in die WordPress-Mediathek, Bild 1 wird das Beitragsbild.</p>
      <div class="grid cols-2" style="margin-top:14px">
        <div class="field">
          <label for="image_provider">Bildquelle</label>
          <select id="image_provider">
            <option value="none" ${data.image_provider === 'none' ? 'selected' : ''}>aus, keine Bilder</option>
            <option value="openai" ${data.image_provider === 'openai' ? 'selected' : ''}>Bild-API (OpenAI-kompatibel)</option>
          </select>
          <div class="hint">${data.imagesEnabled
            ? '<span class="badge ok">aktiv</span>'
            : 'Noch nicht aktiv. Es fehlt die Quelle oder der Schlüssel.'}</div>
        </div>
        <div class="field">
          <label for="images_per_article">Bilder pro Artikel</label>
          <select id="images_per_article">
            ${[0, 1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(data.images_per_article) === n ? 'selected' : ''}>${
              n === 0 ? 'keine' : n === 1 ? '1 (nur Beitragsbild)' : `${n} (Beitragsbild + ${n - 1} im Text)`}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="image_api_key">Schlüssel des Bilddienstes</label>
        <input id="image_api_key" type="password" placeholder="${data.imageKey.configured ? `hinterlegt (${esc(data.imageKey.hint)})` : 'sk-…'}" />
        <div class="hint">${data.imageKey.configured
          ? 'Ein Schlüssel ist hinterlegt. Feld leer lassen, um ihn zu behalten.'
          : 'Bei OpenAI unter platform.openai.com → API keys.'}</div>
      </div>
      <div class="grid cols-2">
        <div class="field"><label for="image_base_url">Adresse der Bild-API</label>
          <input id="image_base_url" value="${esc(data.image_base_url)}" placeholder="https://api.openai.com/v1" />
          <div class="hint">Jeder Dienst mit dem Endpunkt /images/generations funktioniert.</div></div>
        <div class="field"><label for="image_model">Bildmodell</label>
          <input id="image_model" value="${esc(data.image_model)}" placeholder="gpt-image-1" /></div>
        <div class="field">
          <label for="image_size">Bildformat</label>
          <select id="image_size">
            ${['1536x1024:quer (empfohlen für Beiträge)', '1024x1024:quadratisch', '1024x1536:hoch'].map((entry) => {
              const [value, label] = entry.split(':');
              return `<option value="${value}" ${data.image_size === value ? 'selected' : ''}>${label}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="field">
          <label for="image_quality">Bildqualität</label>
          <select id="image_quality">
            ${['high:hoch', 'medium:mittel', 'low:niedrig (günstig)', 'auto:automatisch'].map((entry) => {
              const [value, label] = entry.split(':');
              return `<option value="${value}" ${data.image_quality === value ? 'selected' : ''}>${label}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="image_style">Bildstil</label>
        <textarea id="image_style" style="min-height:70px">${esc(data.image_style)}</textarea>
        <div class="hint">Wird an jede Bildbeschreibung angehängt, auf Englisch. Hält den Look über alle Artikel gleich.</div>
      </div>
      <button class="primary" id="save-settings-3">Speichern</button>
    </div>

    <div class="card">
      <h2>Diagnose-Zugang</h2>
      <p class="sub">Erzeugt einen Link, über den sich der komplette Systemzustand samt Protokoll abrufen lässt –
        ohne Anmeldung, nur mit diesem Link. Jede Aktivierung erzeugt einen <strong>neuen</strong> Token,
        der vorherige Link funktioniert danach nicht mehr. Der Link bleibt gültig, bis du ihn deaktivierst.</p>
      <div id="diagnostics-box" class="hint" style="margin:14px 0">wird geladen …</div>
      <div class="row">
        <button class="primary" id="diag-enable">Neuen Diagnose-Link erzeugen</button>
        <button class="danger" id="diag-disable">Zugang deaktivieren</button>
      </div>
    </div>

    <div class="card">
      <h2>Prompt-Framework</h2>
      <p class="sub">Die Arbeitsanweisung an die KI. Der Hub ergänzt automatisch das Briefing der jeweiligen Website
        (Zielgruppe, Tonalität, Sprache, Länge) und das konkrete Thema – dieses Regelwerk bestimmt, <em>wie</em> geschrieben wird.</p>
      <div class="field" style="margin-top:14px">
        <label for="article_prompt">Anweisung für Artikel</label>
        <textarea id="article_prompt" class="code" style="min-height:340px">${esc(data.article_prompt)}</textarea>
      </div>
      <div class="field">
        <label for="topic_prompt">Anweisung für Themenvorschläge</label>
        <textarea id="topic_prompt" style="min-height:110px">${esc(data.topic_prompt)}</textarea>
      </div>
      <div class="row">
        <button class="primary" id="save-settings-2">Speichern</button>
        <button id="reset-prompts">Standard wiederherstellen</button>
      </div>
    </div>`;

  const saveSettings = (event) => guard(event.currentTarget, async () => {
    const body = {};
    for (const field of ['hub_name', 'model', 'effort', 'brand_name', 'brand_description', 'default_language',
      'default_word_count', 'default_tone', 'global_prompt', 'article_prompt', 'topic_prompt',
      'image_provider', 'images_per_article', 'image_base_url', 'image_model', 'image_size',
      'image_quality', 'image_style']) {
      const el = root.querySelector(`#${field}`);
      if (el) body[field] = el.value;
    }
    const key = root.querySelector('#anthropic_api_key').value.trim();
    if (key) body.anthropic_api_key = key;
    const imageKey = root.querySelector('#image_api_key').value.trim();
    if (imageKey) body.image_api_key = imageKey;
    await api('/api/app/settings', { method: 'PUT', body });
    state.session = null; // Hub-Name in der Seitenleiste neu laden
    toast('Gespeichert.');
    await render();
  });
  on('#save-settings', 'click', saveSettings);
  on('#save-settings-2', 'click', saveSettings);
  on('#save-settings-3', 'click', saveSettings);
  const renderDiagnostics = async () => {
    const box = root.querySelector('#diagnostics-box');
    if (!box) return;
    const info = await api('/api/app/diagnostics');
    box.innerHTML = info.active
      ? `<div class="notice info" style="margin:0">
           <div><strong>Aktiv</strong> seit ${fmtDate(info.created)}. Gilt so lange, bis du ihn deaktivierst oder ersetzt.</div>
           <div class="row" style="margin-top:8px">
             <code class="pair" id="diag-url" style="font-size:13px;letter-spacing:0">${esc(info.url)}</code>
             <button class="small" id="diag-copy">Kopieren</button>
             <a class="btn small" href="${esc(info.url)}" target="_blank" rel="noopener">Öffnen</a>
           </div>
         </div>`
      : 'Kein Diagnose-Zugang aktiv.';
    on('#diag-copy', 'click', () => {
      navigator.clipboard.writeText(root.querySelector('#diag-url').textContent.trim());
      toast('Diagnose-Link kopiert.');
    });
  };
  renderDiagnostics();

  on('#diag-enable', 'click', (event) => guard(event.currentTarget, async () => {
    await api('/api/app/diagnostics/enable', { method: 'POST' });
    toast('Neuer Diagnose-Link erzeugt. Der vorherige ist jetzt ungültig.');
    await renderDiagnostics();
  }));
  on('#diag-disable', 'click', (event) => guard(event.currentTarget, async () => {
    await api('/api/app/diagnostics/disable', { method: 'POST' });
    toast('Diagnose-Zugang deaktiviert.');
    await renderDiagnostics();
  }));

  on('#reset-prompts', 'click', async (event) => {
    if (!confirm('Prompt-Framework auf die mitgelieferte Vorlage zurücksetzen?')) return;
    await guard(event.currentTarget, async () => {
      await api('/api/app/settings/reset-prompts', { method: 'POST' });
      toast('Standard wiederhergestellt.');
      await render();
    });
  });
}

// ---------------------------------------------------------------- Protokoll

async function renderLogs(view) {
  const filter = state.data.logFilter || { level: '', category: '', limit: 200 };
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const logs = await api(`/api/app/logs?${query}`);

  const levels = { '': 'alle Stufen', debug: 'Debug', info: 'Info', warn: 'Warnung', error: 'Fehler' };
  const categories = { '': 'alle Bereiche', http: 'HTTP-Anfragen', ai: 'KI', article: 'Artikel', wordpress: 'WordPress',
    plugin: 'Plugin', plan: 'Pläne', scheduler: 'Zeitplan', auth: 'Anmeldung', site: 'Websites',
    settings: 'Einstellungen', diagnostics: 'Diagnose', system: 'System' };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Protokoll</h1><p class="sub">Jede Anfrage und jede Aktion wird mitgeschrieben (Zeiten in UTC).
        Einträge werden nach 7 Tagen automatisch gelöscht, Debug-Einträge nach 2 Tagen.</p></div>
      <div class="row">
        <select id="log-level" style="width:auto">${Object.entries(levels).map(([value, label]) =>
          `<option value="${value}" ${filter.level === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <select id="log-category" style="width:auto">${Object.entries(categories).map(([value, label]) =>
          `<option value="${value}" ${filter.category === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <select id="log-limit" style="width:auto">${[100, 200, 500, 1000].map((value) =>
          `<option value="${value}" ${Number(filter.limit) === value ? 'selected' : ''}>${value} Einträge</option>`).join('')}</select>
        <button id="reload">Aktualisieren</button>
      </div>
    </div>
    <div class="card">
      ${logs.length ? `<table><thead><tr><th>Zeit</th><th>Stufe</th><th>Bereich</th><th>Dauer</th><th>Meldung</th></tr></thead><tbody>
        ${logs.map((entry) => `<tr>
          <td style="white-space:nowrap;color:var(--muted)">${fmtDate(entry.ts || entry.created_at)}</td>
          <td><span class="badge ${entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : entry.level === 'debug' ? '' : 'info'}">${esc(entry.level)}</span></td>
          <td>${esc(entry.category)}${entry.action ? '/' + esc(entry.action) : ''}</td>
          <td>${entry.duration_ms != null ? esc(entry.duration_ms) + ' ms' : ''}</td>
          <td>${esc(entry.message)}
            ${entry.context ? `<details><summary class="hint">Details</summary><pre style="font-size:12px;overflow:auto">${esc(
              JSON.stringify(JSON.parse(entry.context), null, 2))}</pre></details>` : ''}</td>
        </tr>`).join('')}
      </tbody></table>` : '<div class="empty">Keine Einträge für diesen Filter.</div>'}
    </div>`;

  const update = (key) => (event) => {
    state.data.logFilter = { ...filter, [key]: event.target.value };
    render();
  };
  on('#log-level', 'change', update('level'));
  on('#log-category', 'change', update('category'));
  on('#log-limit', 'change', update('limit'));
  on('#reload', 'click', () => render());
}

boot().catch((err) => {
  root.innerHTML = `<div class="auth-wrap"><div class="auth-card"><div class="notice err">${esc(err.message)}</div></div></div>`;
});
