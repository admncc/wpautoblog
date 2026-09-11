/* Autoblog Hub - Oberflaeche. Bewusst ohne Framework, damit kein Build-Schritt noetig ist. */
'use strict';

const state = {
  session: null, route: 'dashboard', param: null, data: {}, busy: false,
  sortA: ['created', 'ab'],   /* Artikelliste: Spalte, Richtung */
  sortL: ['zeit', 'ab'],      /* Protokoll */
};
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
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'err' : ''}`;
  el.innerHTML = `${ic(type === 'err' ? 'alert' : 'check', 'sm')}<span></span>`;
  el.querySelector('span').textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3000);
}

function fmtDate(value) {
  if (!value) return '–';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* Im Protokoll zaehlt die Uhrzeit, das Datum steht ohnehin in der Zeile darueber. */
function uhrzeit(value) {
  if (!value) return '–';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Auswahl fuer das Pruefintervall, in Stunden.
const INTERVALLE = [
  [6, 'alle 6 Stunden'], [12, 'alle 12 Stunden'], [24, 'einmal täglich'],
  [48, 'alle 2 Tage'], [72, 'alle 3 Tage'], [168, 'einmal pro Woche'], [336, 'alle 2 Wochen'],
];
const intervallText = (stunden) => {
  const treffer = INTERVALLE.find(([h]) => h === Number(stunden));
  return treffer ? treffer[1] : `alle ${stunden} h`;
};

const VIDEO_STATUS = {
  neu: ['warn', 'wartet'],
  transkribiert: ['info', 'wird verarbeitet …'],
  artikel: ['ok', 'Artikel erzeugt'],
  uebersprungen: ['', 'übersprungen'],
  fehler: ['err', 'Fehler'],
};

const STATUS = {
  generating: ['info', 'clock', 'wird geschrieben'],
  draft: ['', 'doc', 'Entwurf'],
  approved: ['info', 'check', 'freigegeben'],
  publishing: ['warn', 'send', 'wird gesendet'],
  published: ['ok', 'check', 'veröffentlicht'],
  failed: ['err', 'alert', 'Fehler'],
};
const statusBadge = (status) => {
  const [cls, symbol, label] = STATUS[status] || ['', 'doc', status];
  return `<span class="badge ${cls}">${ic(symbol, 'sm')}${esc(label)}</span>`;
};
/* Die Statusspur: eine schmale Kante links an jeder Zeile. Der Zustand wird
   dadurch zu einer baulichen Eigenschaft und muss nicht gelesen werden. */
const spur = (status) => ({
  failed: 'is-err', generating: 'is-run', publishing: 'is-run',
  published: 'is-ok', draft: 'is-idle', approved: 'is-ok',
}[status] || 'is-idle');

/* Ein Symbol aus dem Satz in der index.html. Faerbt sich mit der Schriftfarbe. */
const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* Zahlen, Zeiten und Zaehlwerte stehen ruhig, wenn sie gleich breit sind. */
const zahl = (wert) => `<span class="num">${esc(wert)}</span>`;

/* Aufklappbare Bloecke ueber den Zustand fuehren, nicht ueber das <details>-Element.
   Sonst faellt jeder offene Block beim naechsten Neuzeichnen wieder zu. */
state.offen = {};
function disclose(key, kopf, inhalt, stil = '') {
  const auf = !!state.offen[key];
  return `<details class="disclose" ${auf ? 'open' : ''} style="${stil}">
    <summary data-disc="${esc(key)}">${ic('chev', 'sm')}${kopf}</summary>
    ${auf ? inhalt : ''}
  </details>`;
}

/* Sortieren. Der Rang der Zustaende ist so gewaehlt, dass "absteigend" die
   Probleme nach oben holt. Das ist die Reihenfolge, in der man sucht. */
const RANG = { failed: 6, generating: 5, publishing: 4, approved: 3, draft: 2, published: 1 };
function sortiere(liste, [spalte, richtung], schluessel) {
  const f = schluessel[spalte];
  if (!f) return liste;
  const sortiert = [...liste].sort((a, b) => {
    const x = f(a);
    const y = f(b);
    return typeof x === 'string' ? x.localeCompare(y, 'de') : (x || 0) - (y || 0);
  });
  return richtung === 'ab' ? sortiert.reverse() : sortiert;
}
const sortKopf = (key, spalte, label, cls = '') => {
  const [s, r] = state[key];
  return `<th class="${cls} ${s === spalte ? 'sorted' : ''}" data-sort="${key}:${spalte}">
    ${label}${s === spalte ? ic(r === 'ab' ? 'chev' : 'chev', 'sm') : ''}</th>`;
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

// ------------------------------------------------------------------- Thema

/* Hell, Dunkel oder dem System folgen. Der Wunsch liegt im Browser, damit ihn
   theme.js beim naechsten Laden setzen kann, bevor das erste Bild steht. */
function themaWunsch() {
  try {
    return localStorage.getItem('hub-theme') || 'auto';
  } catch {
    return 'auto';
  }
}

function markiereThema() {
  const wunsch = themaWunsch();
  root.querySelectorAll('.seg [data-th]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.th === wunsch));
  });
  const dunkel = wunsch === 'dark'
    || (wunsch === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dunkel ? 'dark' : 'light');
}

function setzeThema(wunsch) {
  try {
    localStorage.setItem('hub-theme', wunsch);
  } catch { /* privater Modus: gilt dann nur fuer diese Sitzung */ }
  markiereThema();
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

/* Aufklappbare Bloecke und sortierbare Spalten gelten ueberall. Ein einziger
   Zuhoerer am Wurzelelement, damit er auch fuer spaeter gezeichnete Teile gilt. */
root.addEventListener('click', (event) => {
  const auf = event.target.closest('[data-disc]');
  if (auf) {
    event.preventDefault();
    const key = auf.dataset.disc;
    state.offen[key] = !state.offen[key];
    return render();
  }
  const spalte = event.target.closest('[data-sort]');
  if (spalte) {
    const [key, feld] = spalte.dataset.sort.split(':');
    const [jetzt, richtung] = state[key];
    state[key] = [feld, jetzt === feld && richtung === 'ab' ? 'auf' : 'ab'];
    return render();
  }
  return undefined;
});

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

  const NAV = [
    ['dashboard', 'pulse', 'Übersicht'],
    ['sites', 'globe', 'Websites'],
    ['posts', 'pen', 'Posts'],
    ['articles', 'doc', 'Artikel'],
  ];
  const NAV2 = [['settings', 'sliders', 'Einstellungen'], ['logs', 'list', 'Protokoll']];
  const aktiv = (r) => (r === route || (r === 'sites' && route === 'site') || (r === 'articles' && route === 'article'));
  const marke = (r) => {
    const n = (state.data.marken || {})[r];
    return n ? `<span class="tag ${r === 'sites' ? 'warn' : 'err'}">${n}</span>` : '';
  };
  const link = ([r, symbol, label]) =>
    `<a href="#/${r}" class="${aktiv(r) ? 'on' : ''}">${ic(symbol)}${label}${marke(r)}</a>`;

  root.innerHTML = `
    <div class="app">
      <aside class="rail">
        <div class="brand">
          <span class="mark">AB</span>
          <span class="name">${esc(state.session.hubName || 'Autoblog Hub')}</span>
        </div>
        <nav class="nav">${NAV.map(link).join('')}</nav>
        <hr>
        <nav class="nav">${NAV2.map(link).join('')}</nav>
        <div class="foot">
          <div id="update-box"></div>
          <div class="row" style="justify-content:space-between;margin-top:10px">
            <span class="seg">
              <button data-th="light" title="Hell">${ic('sun', 'sm')}</button>
              <button data-th="auto" title="Dem System folgen">${ic('auto', 'sm')}</button>
              <button data-th="dark" title="Dunkel">${ic('moon', 'sm')}</button>
            </span>
            <button class="btn quiet sm" id="logout">${ic('out', 'sm')}Abmelden</button>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="mobilehead">
          <span class="brand" style="padding:0"><span class="mark">AB</span></span>
          <span style="font-weight:600;font-size:14px">${esc(state.session.hubName || 'Autoblog Hub')}</span>
          <span class="spacer"></span>
          <button class="btn quiet sm" data-th="${themaWunsch() === 'dark' ? 'light' : 'dark'}">
            ${ic(themaWunsch() === 'dark' ? 'sun' : 'moon', 'sm')}</button>
        </div>
        <div class="wrap" id="view"><div class="empty">Lädt …</div></div>
      </main>
      <nav class="mobilebar">
        ${[...NAV, NAV2[0]].map(([r, symbol, label]) =>
          `<a href="#/${r}" class="${aktiv(r) ? 'on' : ''}">${ic(symbol)}<span>${label}</span>${marke(r)}</a>`).join('')}
      </nav>
    </div>`;

  markiereThema();
  on('[data-th]', 'click', (event) => setzeThema(event.currentTarget.dataset.th));

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

  // Drei Zustaende: es liegt etwas bereit, es laeuft gerade, es ist schiefgegangen.
  const gescheitert = info.lastResult === 'failed';
  box.innerHTML = `
    <div class="version ${info.busy ? 'upd is-run' : gescheitert ? 'upd is-err' : info.updateAvailable ? 'upd' : ''}">
      <div class="row" style="gap:8px">
        <b>v${esc(info.version)}</b>
        ${info.busy ? `<span class="badge info">${ic('refresh', 'sm')}wird aktualisiert</span>` : ''}
        ${!info.busy && gescheitert ? `<span class="badge err">${ic('alert', 'sm')}fehlgeschlagen</span>` : ''}
        ${!info.busy && !gescheitert && info.updateAvailable
          ? `<span class="badge info">${ic('down', 'sm')}neu verfügbar</span>` : ''}
      </div>
      ${info.busy ? '<div class="progress indef" style="margin-top:8px"><i></i></div>' : ''}
      <div class="when">${info.busy
        ? 'Der Hub baut sich neu und startet durch.'
        : gescheitert
          ? `Zurückgerollt. ${esc(info.lastError || 'siehe Protokoll')}`
          : `${esc(stand)}${info.commitShort ? ` · ${esc(info.commitShort)}` : ''}`}</div>
      ${info.busy ? '' : `<div class="btnrow" style="margin-top:8px">
        <button class="btn sm ${info.updateAvailable && !gescheitert ? 'primary' : ''}" id="do-update">
          ${gescheitert ? 'Noch einmal' : 'System aktualisieren'}</button>
        ${gescheitert && info.log ? '<button class="btn sm quiet" id="show-update-log">Protokoll</button>' : ''}
      </div>`}
      ${info.runnerInstalled ? '' : `<div class="when" style="color:var(--warn);margin-top:6px">
        ${ic('alert', 'sm')}Update-Helfer nicht eingerichtet</div>`}
    </div>`;

  on('#show-update-log', 'click', (event) => {
    event.preventDefault();
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" id="log-overlay">
        <div class="modal wide" role="dialog" aria-modal="true">
          <header>${ic('list', 'lg')}<h2>Protokoll der letzten Aktualisierung</h2>
            <button class="btn quiet icon" id="log-close">${ic('x', 'sm')}</button></header>
          <div class="body">
            <div class="notice err">${ic('alert')}<div class="grow">
              <b>Die Aktualisierung ist abgebrochen.</b>
              <div>Der Hub läuft unverändert weiter, es ist nichts verloren.</div></div></div>
            <pre class="code">${esc(state.data.update.log)}</pre>
          </div>
          <footer><button class="btn" id="log-close-2">Schließen</button></footer>
        </div>
      </div>`);
    const zu = () => document.getElementById('log-overlay').remove();
    document.getElementById('log-close').addEventListener('click', zu);
    document.getElementById('log-close-2').addEventListener('click', zu);
    document.getElementById('log-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'log-overlay') zu();
    });
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

  // Vollbild, weil waehrend des Neustarts ohnehin nichts anderes bedienbar ist.
  // Kein Abbrechen: Ein halb getauschter Dienst waere schlimmer als warten.
  const SCHRITTE = [
    ['Änderungen holen', 'aus dem Git-Verzeichnis'],
    ['Abbild bauen', 'das dauert am längsten'],
    ['Dienst tauschen', 'der alte läuft, bis der neue steht'],
    ['Erreichbarkeit prüfen', 'der Hub meldet sich mit neuer Kennung'],
  ];
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop is-plain" id="update-overlay">
      <div class="modal wide" role="dialog" aria-modal="true">
        <header>${ic('refresh', 'lg')}<h2 id="update-title">Das System wird aktualisiert</h2></header>
        <div class="body">
          <div class="progress indef"><i></i></div>
          <ol class="steps" id="update-steps">${SCHRITTE.map(([titel, sub], n) => `
            <li class="${n === 0 ? 'now' : ''}" data-step="${n}">
              ${ic(n === 0 ? 'refresh' : 'clock', 'sm')}
              <span><b>${titel}</b><i style="display:block;font-size:12.5px;color:var(--ink-3)">${sub}</i></span>
            </li>`).join('')}</ol>
          <p class="sub" id="update-step" style="margin-top:14px">Neuester Stand wird geladen …</p>
          <pre id="update-log" class="code" hidden></pre>
          <p style="margin-top:14px;color:var(--ink-2);font-size:13.5px">
            Der Hub ist gleich für ein paar Sekunden nicht erreichbar, das gehört dazu.
            Du kannst dieses Fenster schließen, die Aktualisierung läuft auf dem Server weiter.
            Geht etwas schief, rollt der Hub von selbst auf die letzte Fassung zurück.</p>
        </div>
        <footer>
          <button class="btn quiet" id="update-close">Fenster schließen</button>
          <button class="btn primary" id="update-reload">Seite neu laden</button>
        </footer>
      </div>
    </div>`);

  /* Die Schrittfolge mitfuehren, damit man sieht, wie weit es ist. */
  const setzeSchritt = (n) => {
    document.querySelectorAll('#update-steps li').forEach((li) => {
      const eigen = Number(li.dataset.step);
      li.className = eigen < n ? 'done' : eigen === n ? 'now' : '';
      const symbol = li.querySelector('use');
      if (symbol) symbol.setAttribute('href', eigen < n ? '#i-check' : eigen === n ? '#i-refresh' : '#i-clock');
    });
  };

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
        setzeSchritt(4);
        titel.textContent = 'Aktualisierung abgeschlossen';
        schritt.textContent = 'Der Hub ist neu gestartet. Die Seite wird neu geladen …';
        setTimeout(() => location.reload(), 1500);
        return;
      }
    } catch {
      setzeSchritt(3);
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
        titel.textContent = 'Aktualisierung fehlgeschlagen';
        schritt.innerHTML = `<span style="color:var(--stop)">${esc(info.lastError
          || 'Unbekannter Fehler')} Der Hub läuft unverändert weiter.</span>`;
        return;
      }
      if (info.busy) {
        setzeSchritt(1);
        schritt.textContent = `Neuer Stand wird gebaut … (${sekunden} s)`;
      } else if (info.upToDate) {
        fertig = true;
        clearInterval(timer);
        setzeSchritt(4);
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
    <div class="auth">
      <form class="card" id="auth-form">
        <div class="brand"><span class="mark">AB</span><span class="name">Autoblog Hub</span></div>
        <h1>${setup ? 'Willkommen. Leg dein Konto an.' : 'Anmelden'}</h1>
        <p class="sub">${setup
          ? 'Ein Konto genügt. Danach verbindest du deine erste Website.'
          : 'Der Hub läuft auf deinem eigenen Server.'}</p>
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
        <button class="btn primary wide" type="submit">${setup ? 'Konto anlegen' : 'Anmelden'}</button>
      </form>
    </div>`;

  markiereThema();

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
  const klemmt = data.klemmt || [];

  // Die Zahl neben dem Navigationspunkt kommt aus denselben Daten.
  state.data.marken = {
    dashboard: klemmt.length || 0,
    sites: stats.sites - stats.connected || 0,
  };

  const attn = klemmt.length
    ? `<section class="attn">
        <div class="attn-head">${ic('alert')}<h2>Das klemmt gerade</h2>
          <span class="count">${klemmt.length} ${klemmt.length === 1 ? 'Punkt' : 'Punkte'}</span>
          <span class="tools"><a class="btn sm" href="#/logs">Protokoll öffnen</a></span></div>
        ${klemmt.map((k) => `<div class="attn-item ${esc(k.stufe)}">
          ${ic(k.stufe === 'err' ? 'alert' : 'clock')}
          <span class="grow"><div class="ttl">${esc(k.titel)}</div>
            <div class="why">${esc(k.grund)}</div></span>
          <a class="btn ${k.stufe === 'err' ? 'primary' : ''}" href="${esc(k.ziel)}">${esc(k.aktion)}</a>
        </div>`).join('')}
      </section>`
    : `<section class="calm">${ic('check', 'lg')}
        <div><b>Nichts klemmt.</b>
          <div class="sub">${data.naechsterLauf
            ? `Der nächste Plan läuft ${esc(fmtDate(data.naechsterLauf))}.`
            : 'Es ist kein Plan eingerichtet, der von selbst läuft.'}</div></div>
      </section>`;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Übersicht</h1><p class="sub">Was läuft, was klemmt, was als Nächstes ansteht.</p></div>
      <div class="acts"><a class="btn" href="#/sites">${ic('plus', 'sm')}Website hinzufügen</a>
        <a class="btn primary" href="#/posts">${ic('spark', 'sm')}Post erzeugen</a></div>
    </div>

    ${attn}

    <div class="stats">
      <div class="stat"><b>${stats.connected}<i>/${stats.sites}</i></b><span>Websites verbunden</span></div>
      <div class="stat"><b>${stats.published}</b><span>veröffentlicht</span></div>
      <div class="stat"><b>${stats.drafts}</b><span>Entwürfe</span></div>
      <div class="stat"><b>${stats.activePlans}</b><span>Pläne laufen</span></div>
    </div>

    <div class="grid two">
      <section class="card flat">
        <div class="card-head"><h2>Websites</h2><span class="count">${data.sites.length}</span>
          <span class="tools"><a class="btn sm quiet" href="#/sites">Alle</a></span></div>
        ${data.sites.length ? data.sites.slice(0, 6).map((site) => `
          <div class="item ${site.connected ? 'is-ok' : 'is-warn'}" data-site="${esc(site.id)}">
            <span class="dot ${site.connected ? 'ok' : 'warn'}"></span>
            <span class="grow"><span class="ttl">${esc(site.name)}</span>
              <span class="meta">${esc(site.url || 'noch keine Adresse')}</span></span>
            <span class="side">${site.connected
              ? `<span class="badge ok">${ic('check', 'sm')}verbunden</span>`
              : `<span class="badge warn">${ic('clock', 'sm')}wartet auf Plugin</span>`}
              ${ic('chev', 'sm')}</span>
          </div>`).join('')
          : `<div class="empty"><span class="ring">${ic('globe', 'lg')}</span>
              <b>Noch keine Website</b>
              <p>Leg deine erste Website an und verbinde sie mit dem Begleit-Plugin.</p>
              <a class="btn primary" href="#/sites">${ic('plus', 'sm')}Website anlegen</a></div>`}
      </section>

      <section class="card flat">
        <div class="card-head"><h2>Zuletzt erzeugt</h2>
          <span class="tools"><a class="btn sm quiet" href="#/articles">Alle</a></span></div>
        ${data.recentArticles.length ? data.recentArticles.slice(0, 6).map((a) => `
          <div class="item ${spur(a.status)}" data-article="${esc(a.id)}">
            <span class="grow"><span class="ttl">${esc(a.title || a.keyword)}</span>
              <span class="meta">${esc(a.site_name)} · ${esc(fmtDate(a.created_at))}</span></span>
            <span class="side">${statusBadge(a.status)}</span>
          </div>`).join('')
          : `<div class="empty"><span class="ring">${ic('doc', 'lg')}</span>
              <b>Noch kein Artikel</b>
              <p>Der erste Beitrag entsteht in zwei Minuten: Thema eingeben, Rest macht der Hub.</p>
              <a class="btn primary" href="#/posts">${ic('spark', 'sm')}Post erzeugen</a></div>`}
      </section>
    </div>

    <section class="card flat">
      <div class="card-head"><h2>Letzte Ereignisse</h2>
        <span class="tools"><a class="btn sm quiet" href="#/logs">Protokoll</a></span></div>
      <div style="padding:4px 0">
        ${data.logs.length ? data.logs.slice(0, 8).map((entry) => `
          <div class="logline ${esc(entry.level)}">
            <time>${esc(uhrzeit(entry.created_at))}</time>
            <span class="badge ${entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : 'plain'}">${
              entry.level === 'error' ? 'Fehler' : entry.level === 'warn' ? 'Warnung' : 'Info'}</span>
            <span class="msg">${esc(entry.message)}</span></div>`).join('')
          : '<div class="empty">Noch keine Ereignisse.</div>'}
      </div>
    </section>`;

  on('[data-site]', 'click', (e) => navigate('site', e.currentTarget.dataset.site));
  on('[data-article]', 'click', (e) => navigate('article', e.currentTarget.dataset.article));
}

// ---------------------------------------------------------------- Websites

async function renderSites(view) {
  const sites = await api('/api/app/sites');
  state.data.marken = { ...(state.data.marken || {}), sites: sites.filter((s) => !s.connected).length };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Websites</h1><p class="sub">Jede Website braucht einmalig das Begleit-Plugin und einen Token.</p></div>
      <div class="acts"><button class="btn primary" id="open-new-site">${ic('plus', 'sm')}Website anlegen</button></div>
    </div>

    ${sites.length ? `<section class="card flat">
      <div class="card-head"><h2>Angelegte Websites</h2><span class="count">${sites.length}</span></div>
      ${sites.map((site) => `<div class="item ${site.connected ? 'is-ok' : 'is-warn'}" data-site="${esc(site.id)}">
        <span class="dot ${site.connected ? 'ok' : 'warn'}"></span>
        <span class="grow"><span class="ttl">${esc(site.name)}</span>
          <span class="kv"><span>${esc(site.url || 'noch keine Adresse')}</span>
            <span>Plugin <b>${esc(site.plugin_version || '—')}</b></span>
            <span>zuletzt gesehen <b>${esc(fmtDate(site.last_seen_at))}</b></span></span></span>
        <span class="side">${site.connected
          ? `<span class="badge ok">${ic('check', 'sm')}verbunden</span>`
          : `<span class="badge warn">${ic('clock', 'sm')}wartet auf Plugin</span>`}
          ${ic('chev', 'sm')}</span>
      </div>`).join('')}
    </section>`
    : `<div class="card"><div class="empty"><span class="ring">${ic('globe', 'lg')}</span>
        <b>Noch keine Website</b>
        <p>Trag Name und Adresse ein. Den Token bekommst du danach auf der Detailseite,
          er gehört einmalig ins Connector-Plugin.</p>
        <button class="btn primary" id="open-new-site-2">${ic('plus', 'sm')}Website anlegen</button></div></div>`}`;

  const dialog = () => {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" id="site-overlay">
        <div class="modal" role="dialog" aria-modal="true">
          <header>${ic('globe', 'lg')}<h2>Neue Website anlegen</h2>
            <button class="btn quiet icon" data-zu="1">${ic('x', 'sm')}</button></header>
          <form class="body" id="new-site">
            <div class="field"><label for="site-name">Name</label>
              <input id="site-name" placeholder="z. B. Reiseblog" required />
              <div class="hint">Nur für dich im Hub. Auf der Website erscheint er nirgends.</div></div>
            <div class="field"><label for="site-url">WordPress-Adresse</label>
              <input id="site-url" placeholder="https://meinblog.de" />
              <div class="hint">Kann leer bleiben, das Plugin trägt sie beim Verbinden nach.</div></div>
            <div class="notice info">${ic('alert')}<div class="grow">
              Danach bekommst du Adresse und Token. Beides trägst du einmalig im Connector-Plugin ein,
              dann steht die Verbindung.</div></div>
            <footer><button type="button" class="btn quiet" data-zu="1">Abbrechen</button>
              <button class="btn primary" type="submit">Anlegen und Token zeigen</button></footer>
          </form>
        </div>
      </div>`);
    const zu = () => document.getElementById('site-overlay').remove();
    document.querySelectorAll('#site-overlay [data-zu]').forEach((el) => el.addEventListener('click', zu));
    document.getElementById('site-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'site-overlay') zu();
    });
    document.getElementById('site-name').focus();
    document.getElementById('new-site').addEventListener('submit', async (event) => {
      event.preventDefault();
      await guard(event.target.querySelector('button[type=submit]'), async () => {
        const site = await api('/api/app/sites', {
          method: 'POST',
          body: {
            name: document.getElementById('site-name').value,
            url: document.getElementById('site-url').value,
          },
        });
        zu();
        navigate('site', site.id);
      });
    });
  };

  on('#open-new-site', 'click', dialog);
  on('#open-new-site-2', 'click', dialog);
  on('[data-site]', 'click', (e) => navigate('site', e.currentTarget.dataset.site));
}

async function renderSite(view, siteId) {
  const { site, topics, articles, pluginVersion, pluginDownload, channels = [], videos = [], youtubeAktiv } =
    await api(`/api/app/sites/${siteId}`);
  const tab = state.data.siteTab || 'connect';
  const hubUrl = location.origin;

  const tabs = [
    ['connect', 'Verbindung'],
    ['content', 'Inhalt & Stil'],
    ['topics', 'Themen', topics.filter((t) => t.status === 'open').length],
    ['spy', 'YT Channel Spy', channels.length],
    ['articles', 'Artikel', articles.length],
  ];

  view.innerHTML = `
    <a class="back" href="#/sites">${ic('out', 'sm')}Websites</a>
    <div class="page-head">
      <div>
        <h1>${esc(site.name)}</h1>
        <p class="sub">${esc(site.url || 'noch keine Adresse')} ·
          ${site.connected
            ? `<span class="badge ok">${ic('check', 'sm')}verbunden</span>`
            : `<span class="badge warn">${ic('clock', 'sm')}wartet auf Plugin</span>`}</p>
      </div>
      <div class="acts">
        <button class="btn" id="test-connection">${ic('refresh', 'sm')}Verbindung testen</button>
        <button class="btn danger" id="delete-site">${ic('trash', 'sm')}Löschen</button>
      </div>
    </div>

    <div class="tabs" role="tablist">
      ${tabs.map(([key, label, n]) => `<button role="tab" data-tab="${key}"
        aria-selected="${tab === key}" class="${tab === key ? 'active' : ''}">${label}${
        n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}
    </div>
    <div id="tab-body"></div>`;

  const body = view.querySelector('#tab-body');

  if (tab === 'connect') {
    const kategorien = site.categories || [];
    const gesperrt = site.excluded_categories || [];
    const suche = (state.data.catQuery || '').trim().toLowerCase();
    const filter = state.data.catFilter || 'alle';
    let sichtbar = kategorien.filter((k) => !suche || k.name.toLowerCase().includes(suche));
    if (filter === 'an') sichtbar = sichtbar.filter((k) => !gesperrt.includes(k.name));
    if (filter === 'aus') sichtbar = sichtbar.filter((k) => gesperrt.includes(k.name));
    const vieleChips = sichtbar.length > 12 && !state.data.catOpen;

    body.innerHTML = `
      <div class="grid two">
        <section class="card">
          <h2>WordPress verbinden</h2>
          <div class="sub">Beide Angaben gehören in die Einstellungen des Connector-Plugins,
            zu finden unter <em>Einstellungen → Autoblog</em>.</div>
          <div class="field" style="margin-top:14px">
            <label>1 · Adresse des Hubs</label>
            <div class="pair"><span class="val" id="hub-url">${esc(hubUrl)}</span>
              <button class="btn sm quiet" data-copy="hub-url">${ic('copy', 'sm')}Kopieren</button></div>
            <div class="hint">Diese Adresse muss von deinem WordPress aus erreichbar sein.</div>
          </div>
          <div class="field">
            <label>2 · Token dieser Website</label>
            <div class="pair"><span class="val" id="site-token">${esc(site.token)}</span>
              <button class="btn sm quiet" data-copy="site-token">${ic('copy', 'sm')}Kopieren</button></div>
            <div class="hint">Wer den Token hat, darf auf dieser Website veröffentlichen.
              Wie ein Passwort behandeln.</div>
          </div>
          <div class="btnrow"><span class="spacer"></span>
            <button class="btn sm danger" id="new-token">${ic('refresh', 'sm')}Token neu erzeugen</button></div>
        </section>

        <section class="card">
          <h2>WordPress-Plugin</h2>
          <div class="sub">Der Hub hält die passende Fassung des Connectors bereit.</div>
          <div class="kv" style="margin:14px 0">
            <span>In WordPress <b>${esc(site.plugin_version || 'nicht installiert')}</b></span>
            ${pluginVersion ? `<span>Im Hub bereit <b>${esc(pluginVersion)}</b></span>` : ''}
          </div>
          ${pluginVersion && site.plugin_version && pluginVersion !== site.plugin_version
            ? `<div class="notice info">${ic('down')}<div class="grow">
                 Version ${esc(pluginVersion)} liegt bereit. Der Hub spielt sie sofort ein,
                 ohne Umweg über WordPress.</div></div>` : ''}
          <div class="btnrow">
            ${pluginVersion && site.plugin_version && pluginVersion === site.plugin_version
              ? `<span class="badge ok">${ic('check', 'sm')}aktuell</span><span class="spacer"></span>`
              : `<button class="btn primary" id="update-plugin">Plugin aktualisieren</button>`}
            ${pluginDownload ? `<a class="btn quiet" href="${esc(pluginDownload)}">
              ${ic('down', 'sm')}Paket herunterladen</a>` : ''}
          </div>
          <div class="hint" style="margin-top:8px">Das Paket brauchst du nur beim allerersten Mal
            oder wenn WordPress den Hub nicht erreicht.</div>
        </section>
      </div>

      <section class="card flat">
        <div class="card-head"><h2>Kategorien</h2>
          <span class="count">${kategorien.length} aus WordPress · ${gesperrt.length} ausgeschlossen</span></div>
        ${kategorien.length ? `
          <div class="toolbar">
            <span class="search">${ic('search')}
              <input type="text" id="cat-q" placeholder="Kategorie suchen" value="${esc(state.data.catQuery || '')}" /></span>
            <span class="seg">
              <button data-catfilter="alle" aria-pressed="${filter === 'alle'}">Alle</button>
              <button data-catfilter="an" aria-pressed="${filter === 'an'}">Erlaubt</button>
              <button data-catfilter="aus" aria-pressed="${filter === 'aus'}">Ausgeschlossen</button>
            </span>
            <span class="spacer"></span>
            <span class="count">${sichtbar.length} sichtbar</span>
          </div>
          ${sichtbar.length ? `
            <div class="chipfield ${vieleChips ? 'clipped' : ''}">
              ${sichtbar.map((k) => {
                const raus = gesperrt.includes(k.name);
                return `<span class="chip ${raus ? 'off' : ''}">
                  <span class="nm">${esc(k.name)}</span>${k.count ? `<span class="n">${k.count}</span>` : ''}
                  <button class="chip-x" data-exclude="${esc(k.name)}"
                    title="${raus ? 'Wieder zulassen' : 'Von der KI-Auswahl ausschließen'}">
                    ${ic(raus ? 'undo' : 'x', 'sm')}</button></span>`;
              }).join('')}
            </div>
            <div class="chipfoot">
              ${vieleChips
                ? `<button class="btn sm" data-catopen="1">${ic('chev', 'sm')}Alle ${sichtbar.length} anzeigen</button>`
                : (sichtbar.length > 12 ? '<button class="btn sm quiet" data-catopen="0">Zuklappen</button>' : '')}
              <span class="count" style="color:var(--ink-3);font-size:12.5px">
                Zuletzt von WordPress gemeldet ${esc(fmtDate(site.categories_at))}. Es werden nie neue angelegt.
                Mit einer Kategorie sind auch ihre Unterkategorien gesperrt, denn die Adresse des Beitrags
                trägt den Oberbegriff mit.</span>
            </div>`
            : `<div class="empty"><b>Keine Kategorie passt dazu</b>
                <p>Prüf die Schreibweise oder setz den Filter zurück.</p>
                <button class="btn sm" data-catreset="1">Filter zurücksetzen</button></div>`}`
          : `<div class="empty"><span class="ring">${ic('list', 'lg')}</span>
              <b>Noch keine Kategorien gemeldet</b>
              <p>Klick oben auf „Verbindung testen“ oder warte auf das nächste Lebenszeichen des Plugins.</p></div>`}
      </section>

      <section class="card">
        <h2>Übertragungsweg</h2>
        <div class="sub">Wie der fertige Artikel zu WordPress kommt und in welchem Zustand er dort landet.</div>
        <div class="fields-2" style="margin-top:14px">
          <div class="field">
            <label for="delivery">Weg</label>
            <select id="delivery">
              <option value="push" ${site.delivery === 'push' ? 'selected' : ''}>Der Hub sendet an WordPress</option>
              <option value="pull" ${site.delivery === 'pull' ? 'selected' : ''}>WordPress holt selbst ab</option>
            </select>
            <div class="hint">Abholen hilft bei Servern, die von außen keine Verbindung annehmen.</div>
          </div>
          <div class="field">
            <label for="wp_status">Zustand nach dem Senden</label>
            <select id="wp_status">
              <option value="draft" ${site.wp_status === 'draft' ? 'selected' : ''}>Entwurf</option>
              <option value="pending" ${site.wp_status === 'pending' ? 'selected' : ''}>Zur Prüfung ausstehend</option>
              <option value="publish" ${site.wp_status === 'publish' ? 'selected' : ''}>Sofort veröffentlichen</option>
            </select>
          </div>
        </div>
        <div class="formfoot"><button class="btn primary" data-save-site>Speichern</button></div>
      </section>`;

    on('#cat-q', 'input', (event) => {
      state.data.catQuery = event.target.value;
      render().then(() => {
        const feld = root.querySelector('#cat-q');
        if (feld) { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length); }
      });
    });
    on('[data-catfilter]', 'click', (event) => {
      state.data.catFilter = event.currentTarget.dataset.catfilter;
      render();
    });
    on('[data-catopen]', 'click', (event) => {
      state.data.catOpen = event.currentTarget.dataset.catopen === '1';
      render();
    });
    on('[data-catreset]', 'click', () => {
      state.data.catQuery = '';
      state.data.catFilter = 'alle';
      render();
    });

    on('[data-copy]', 'click', (event) => {
      navigator.clipboard.writeText(root.querySelector(`#${event.currentTarget.dataset.copy}`).textContent.trim());
      toast('In die Zwischenablage kopiert.');
    });
    on('#update-plugin', 'click', (event) => guard(event.currentTarget, async () => {
      const ergebnis = await api(`/api/app/sites/${siteId}/update-plugin`, { method: 'POST' });
      toast(ergebnis.from === ergebnis.version
        ? `Das Plugin ist bereits auf ${ergebnis.version}.`
        : `Plugin von ${ergebnis.from} auf ${ergebnis.version} aktualisiert.`);
      await render();
    }));
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
      <form class="card" id="save-site-form">
        <fieldset class="fieldset">
          <legend>So soll der Text klingen</legend>
          <span class="sub">Diese beiden Felder prägen das Ergebnis stärker als alles andere auf dieser Seite.</span>
          <div class="field lead">
            <label for="audience">Zielgruppe</label>
            <textarea id="audience" rows="3"
              placeholder="Wen sprichst du an? Schreib es so, wie du es einem neuen Autor erklären würdest.">${esc(site.audience)}</textarea>
          </div>
          <div class="field lead">
            <label for="extra_prompt">Zusätzliche Anweisungen an die KI</label>
            <textarea id="extra_prompt" rows="5"
              placeholder="z. B. Immer ein konkretes Beispiel je Abschnitt. Keine Preisangaben. Duzen.">${esc(site.extra_prompt)}</textarea>
            <div class="hint">Gilt zusätzlich zu den globalen Vorgaben aus den Einstellungen.</div>
          </div>
          <div class="fields-2">
            <div class="field"><label for="tone">Tonalität</label>
              <input id="tone" value="${esc(site.tone)}" placeholder="ruhig und erklärend" /></div>
            <div class="field"><label for="topic_focus">Themenschwerpunkte</label>
              <input id="topic_focus" value="${esc(site.topic_focus)}" placeholder="z. B. Reisen in Südostasien, Budget-Tipps" /></div>
          </div>
        </fieldset>

        <fieldset class="fieldset">
          <legend>Umfang und Sprache</legend>
          <span class="sub">Gilt für jeden Artikel dieser Website, solange nichts anderes gesetzt ist.</span>
          <div class="fields-2">
            <div class="field">
              <label for="language">Sprache</label>
              <select id="language">
                ${['de:Deutsch', 'en:Englisch', 'fr:Französisch', 'es:Spanisch'].map((entry) => {
                  const [code, label] = entry.split(':');
                  return `<option value="${code}" ${site.language === code ? 'selected' : ''}>${label}</option>`;
                }).join('')}
              </select>
              <div class="hint">Bestimmt auch die Sprache der Themenvorschläge.</div>
            </div>
            <div class="field"><label for="word_count">Artikellänge (Wörter)</label>
              <input id="word_count" type="number" min="300" max="3000" step="100" value="${site.word_count}" /></div>
          </div>
        </fieldset>

        <fieldset class="fieldset">
          <legend>Technisches</legend>
          <span class="sub">Selten zu ändern. Wenn etwas unklar ist, lass es stehen.</span>
          <div class="fields-tech">
            <div class="field"><label for="name">Name</label><input id="name" value="${esc(site.name)}" /></div>
            <div class="field"><label for="url">WordPress-Adresse</label><input id="url" value="${esc(site.url)}" /></div>
            <div class="field">
              <label for="wp_category">Kategorie in WordPress</label>
              ${site.categories && site.categories.length ? `
                <select id="wp_category">
                  <option value="" ${!site.wp_category ? 'selected' : ''}>KI wählt die passendste</option>
                  ${site.categories.map((k) => `<option value="${esc(k.name)}" ${site.wp_category === k.name ? 'selected' : ''}>${
                    esc(k.name)}${k.count ? ` (${k.count})` : ''}</option>`).join('')}
                </select>`
                : `<input id="wp_category" value="${esc(site.wp_category)}" placeholder="noch keine bekannt" />`}
            </div>
            <div class="field"><label for="wp_author_id">Autor-ID</label>
              <input id="wp_author_id" type="number" min="0" value="${site.wp_author_id || 0}" />
              <div class="hint">0 heißt: der Benutzer, mit dem das Plugin verbunden ist.</div></div>
          </div>
        </fieldset>

        <div class="formfoot">
          <button type="button" class="btn primary" data-save-site>Änderungen speichern</button>
          <span class="state">Jede Website hat ihre eigenen Vorgaben.</span>
        </div>
      </form>`;
  }

  if (tab === 'topics') {
    const offen = topics.filter((t) => t.status === 'open');
    const suche = (state.data.topicQuery || '').trim().toLowerCase();
    const liste = topics.filter((t) => !suche || t.keyword.toLowerCase().includes(suche));
    const gewaehlt = state.data.topicSel || [];

    body.innerHTML = `
      <section class="card">
        <h2>Themen sammeln</h2>
        <div class="sub">Wiederkehrende Posts arbeiten diese Liste von oben nach unten ab.
          Ist sie leer, leitet die KI neue Themen aus den Themenbereichen des Plans ab.</div>
        <div class="field" style="margin-top:14px">
          <label for="keywords">Eigene Themen, eine Zeile je Thema</label>
          <textarea id="keywords" rows="4"
            placeholder="Kaffeemaschine entkalken&#10;Espresso oder Filterkaffee"></textarea>
        </div>
        <div class="btnrow">
          <button class="btn primary" id="add-topics">${ic('plus', 'sm')}Themen hinzufügen</button>
          <button class="btn" id="suggest-topics">${ic('spark', 'sm')}Zehn von der KI vorschlagen lassen</button>
        </div>
      </section>

      <section class="card flat">
        <div class="card-head"><h2>Themen</h2><span class="count">${offen.length} offen</span></div>
        ${topics.length ? `
          <div class="toolbar">
            <span class="search">${ic('search')}
              <input type="text" id="topic-q" placeholder="Thema suchen" value="${esc(state.data.topicQuery || '')}" /></span>
            <span class="spacer"></span>
            <span class="count">${liste.length} von ${topics.length}</span>
          </div>
          ${gewaehlt.length ? `<div class="bulk">
            <b>${gewaehlt.length} ausgewählt</b>
            <span class="spacer"></span>
            <button class="btn sm" data-selnone="1">Auswahl aufheben</button>
            <button class="btn sm danger" id="del-selected">${ic('trash', 'sm')}Löschen</button>
          </div>` : ''}
          <div class="tblwrap"><table>
            <thead><tr><th style="width:34px"></th><th>Thema</th><th>Quelle</th><th>Status</th><th class="right">Aktion</th></tr></thead>
            <tbody>${liste.map((topic) => `<tr class="${topic.status === 'open' ? 'is-idle' : 'is-ok'}">
              <td><input type="checkbox" data-sel="${esc(topic.id)}" ${gewaehlt.includes(topic.id) ? 'checked' : ''} /></td>
              <td><span class="ttl">${esc(topic.keyword)}</span>
                ${topic.angle ? `<span class="meta">${esc(topic.angle)}</span>` : ''}</td>
              <td data-label="Quelle"><span class="badge">${topic.source === 'ai' ? 'KI' : 'von Hand'}</span></td>
              <td data-label="Status">${topic.status === 'open'
                ? `<span class="badge">${ic('clock', 'sm')}offen</span>`
                : `<span class="badge ok">${ic('check', 'sm')}verwendet</span>`}</td>
              <td class="right"><span class="acts">
                ${topic.status === 'open'
                  ? `<button class="btn sm" data-write="${esc(topic.id)}" data-keyword="${esc(topic.keyword)}">Artikel schreiben</button>`
                  : ''}
                <button class="btn sm quiet icon" data-del-topic="${esc(topic.id)}" title="Löschen">${ic('trash', 'sm')}</button>
              </span></td></tr>`).join('')}</tbody>
          </table></div>`
          : `<div class="empty"><span class="ring">${ic('list', 'lg')}</span>
              <b>Noch keine Themen</b>
              <p>Trag eigene ein oder lass dir zehn vorschlagen. Der Plan arbeitet sie danach
                von oben nach unten ab.</p></div>`}
      </section>`;

    on('#topic-q', 'input', (event) => {
      state.data.topicQuery = event.target.value;
      render().then(() => {
        const feld = root.querySelector('#topic-q');
        if (feld) { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length); }
      });
    });
    on('[data-sel]', 'change', (event) => {
      const id = event.currentTarget.dataset.sel;
      const aktuell = state.data.topicSel || [];
      state.data.topicSel = aktuell.includes(id) ? aktuell.filter((x) => x !== id) : [...aktuell, id];
      render();
    });
    on('[data-selnone]', 'click', () => { state.data.topicSel = []; render(); });
    on('#del-selected', 'click', (event) => guard(event.currentTarget, async () => {
      for (const id of state.data.topicSel || []) {
        await api(`/api/app/topics/${id}`, { method: 'DELETE' });
      }
      toast(`${(state.data.topicSel || []).length} Themen gelöscht.`);
      state.data.topicSel = [];
      await render();
    }));

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

  if (tab === 'spy') {
    const VST = {
      neu: ['warn', 'clock', 'wartet'],
      transkribiert: ['info', 'refresh', 'wird verarbeitet'],
      artikel: ['ok', 'check', 'Artikel erzeugt'],
      uebersprungen: ['', 'pause', 'übersprungen'],
      fehler: ['err', 'alert', 'Fehler'],
    };
    const vspur = { neu: 'is-warn', fehler: 'is-err', artikel: 'is-ok', transkribiert: 'is-run', uebersprungen: 'is-idle' };
    const offen = videos.filter((v) => v.status !== 'uebersprungen');
    const beiseite = videos.filter((v) => v.status === 'uebersprungen');

    // Warum ein Video zurueckgestellt wurde, entscheidet, ob es je wieder drankommt.
    const gruende = [
      ['limit', 'Grenze je Durchlauf erreicht', 'Kommen dran, sobald wieder Platz ist oder ein Video ausfällt.'],
      ['altbestand', 'Altbestand beim Einrichten', 'Lagen schon da, als der Kanal aufgenommen wurde.'],
      ['dublette', 'Ähnliches schon verarbeitet', 'Ein anderer Kanal hatte dasselbe Thema zuerst.'],
      ['manuell', 'Von Hand übersprungen', 'Deine Entscheidung. Rücken nie von selbst nach.'],
    ];

    const videoZeile = (v) => {
      const [cls, symbol, label] = VST[v.status] || ['', 'doc', v.status];
      return `<tr class="${vspur[v.status] || 'is-idle'}">
        <td><span class="ttl">${esc(v.title)}</span>
          <span class="meta">${esc(v.kanal || '')}${v.words ? ` · ${v.words} Wörter Transkript` : ''}</span>
          ${v.error ? `<span class="meta" style="display:block${v.status === 'fehler' ? ';color:var(--stop)' : ''}">${esc(v.error)}</span>` : ''}
          ${v.status === 'fehler' && v.retry_at
            ? `<span class="meta">Neuer Anlauf am ${esc(fmtDate(v.retry_at))} (Versuch ${Number(v.attempts) + 1}).</span>`
            : ''}
          ${v.status === 'fehler' && !v.retry_at && Number(v.attempts) > 0
            ? '<span class="meta">Aufgegeben nach mehreren Anläufen. Ein anderes Video ist nachgerückt.</span>'
            : ''}
          ${v.status === 'neu' ? `<span class="meta">${v.auto_article && v.kanal_aktiv
            ? 'Wird beim nächsten stündlichen Durchlauf von selbst zum Artikel.'
            : 'Wartet auf dich: Für diesen Kanal ist „automatisch“ ausgeschaltet.'}</span>` : ''}</td>
        <td data-label="Status"><span class="badge ${cls}">${ic(symbol, 'sm')}${label}</span></td>
        <td data-label="Veröffentlicht" class="nowrap">${esc(fmtDate(v.published_at))}</td>
        <td class="right"><span class="acts">
          ${v.article_id ? `<a class="btn sm" href="#/article/${esc(v.article_id)}">Artikel</a>` : ''}
          ${['neu', 'fehler', 'uebersprungen'].includes(v.status)
            ? `<button class="btn sm" data-make="${esc(v.id)}">Artikel erzeugen</button>` : ''}
          <a class="btn sm quiet icon" href="https://www.youtube.com/watch?v=${esc(v.video_id)}"
            target="_blank" rel="noopener" title="Auf YouTube ansehen">${ic('ext', 'sm')}</a>
          ${v.status === 'neu' ? `<button class="btn sm quiet" data-skip="${esc(v.id)}">Überspringen</button>` : ''}
        </span></td></tr>`;
    };
    const videoTabelle = (liste) => `<div class="tblwrap"><table>
      <thead><tr><th>Video</th><th>Status</th><th class="nowrap">Veröffentlicht</th><th class="right">Aktion</th></tr></thead>
      <tbody>${liste.map(videoZeile).join('')}</tbody></table></div>`;

    body.innerHTML = `
      ${youtubeAktiv ? '' : `<div class="notice err">${ic('alert')}<div class="grow">
        <b>Die Kanalbeobachtung ist noch nicht eingerichtet.</b>
        <div>Unter Einstellungen einschalten und den Schlüssel des Transkript-Dienstes hinterlegen.</div>
      </div><a class="btn sm" href="#/settings">Einstellungen</a></div>`}

      <section class="card">
        <h2>Kanal beobachten</h2>
        <div class="sub">Kanal-Adresse, @handle oder Kanal-ID. Kommt ein neues Video, liest der Hub das
          Transkript und macht daraus einen eigenständigen Artikel für diese Website.</div>
        <form id="channel-form" style="margin-top:14px">
          <div class="field"><label for="chan-input">Kanal</label>
            <input id="chan-input" required placeholder="@kanalname oder https://www.youtube.com/@kanalname" /></div>
          <div class="fields-3">
            <div class="field"><label for="chan-interval">Wie oft prüfen</label>
              <select id="chan-interval">${INTERVALLE.map(([stunden, text]) =>
                `<option value="${stunden}" ${stunden === 24 ? 'selected' : ''}>${text}</option>`).join('')}</select></div>
            <div class="field"><label for="chan-max">Videos je Durchlauf</label>
              <select id="chan-max">${[1, 2, 3, 5, 10].map((n) =>
                `<option value="${n}" ${n === 1 ? 'selected' : ''}>höchstens ${n}${n === 1 ? ' (empfohlen)' : ''}</option>`).join('')}</select></div>
            <div class="field"><label for="chan-angle">Blickwinkel</label>
              <input id="chan-angle" placeholder="ohne Vorgabe" /></div>
          </div>
          <div class="btnrow" style="margin-top:4px">
            <label class="check"><input type="checkbox" id="chan-auto" checked />
              <span><b>Automatisch Artikel erzeugen</b><i>Ohne Haken sammelt der Hub nur, du entscheidest je Video.</i></span></label>
            <label class="check"><input type="checkbox" id="chan-embed" checked />
              <span><b>Video einbetten</b><i>Erscheint im Beitrag und wird als Quelle genannt.</i></span></label>
            <span class="spacer"></span>
            <button class="btn primary" type="submit">${ic('plus', 'sm')}Kanal hinzufügen</button>
          </div>
        </form>
      </section>

      <section class="card flat">
        <div class="card-head"><h2>Beobachtete Kanäle</h2><span class="count">${channels.length}</span></div>
        ${channels.length ? channels.map((k) => {
          const auf = !!state.offen[`chan:${k.id}`];
          return `<div class="item ${k.active ? (k.last_error ? 'is-err' : 'is-ok') : 'is-idle'}" style="display:block">
            <div class="row" style="align-items:flex-start">
              <span class="grow">
                <span class="ttl">${esc(k.title || k.channel_id)}
                  ${k.active ? '' : '<span class="badge">pausiert</span>'}
                  ${k.auto_article && k.active ? '<span class="badge info">automatisch</span>' : ''}</span>
                <span class="kv">
                  <span>${esc(k.handle || k.channel_id)}</span>
                  <span>${esc(intervallText(k.interval_hours))}</span>
                  <span>je Durchlauf <b>${k.max_per_scan}</b></span>
                  <span>gefunden <b>${k.videos}</b></span>
                  <span>Artikel <b>${k.artikel}</b></span>
                  <span>nächste Prüfung <b>${k.active ? esc(fmtDate(k.next_check_at)) : '—'}</b></span>
                </span>
                ${k.last_error ? `<span class="meta" style="color:var(--stop)">${esc(k.last_error)}</span>` : ''}
                ${k.angle ? `<span class="meta">Blickwinkel: ${esc(k.angle)}</span>` : ''}
              </span>
              <span class="acts">
                <button class="btn sm" data-scan="${esc(k.id)}">${ic('refresh', 'sm')}Jetzt prüfen</button>
                <button class="btn sm quiet icon" data-toggle-chan="${esc(k.id)}" data-active="${k.active}"
                  title="${k.active ? 'Pausieren' : 'Aktivieren'}">${ic(k.active ? 'pause' : 'play', 'sm')}</button>
                <button class="btn sm quiet" data-disc="chan:${esc(k.id)}">${ic('sliders', 'sm')}Einstellungen</button>
              </span>
            </div>
            ${auf ? `<div class="row" style="margin-top:12px;align-items:flex-end;gap:12px">
              <div class="field" style="margin:0;width:190px"><label>Wie oft prüfen</label>
                <select data-int="${esc(k.id)}">${INTERVALLE.map(([stunden, text]) =>
                  `<option value="${stunden}" ${Number(k.interval_hours) === stunden ? 'selected' : ''}>${text}</option>`).join('')}</select></div>
              <div class="field" style="margin:0;width:180px"><label>Videos je Durchlauf</label>
                <select data-max="${esc(k.id)}">${[1, 2, 3, 5, 10].map((n) =>
                  `<option value="${n}" ${Number(k.max_per_scan) === n ? 'selected' : ''}>höchstens ${n}</option>`).join('')}</select></div>
              <div class="field" style="margin:0;flex:1;min-width:200px"><label>Blickwinkel</label>
                <input data-angle="${esc(k.id)}" value="${esc(k.angle)}" placeholder="optional" /></div>
              <label class="check" style="margin-bottom:6px"><input type="checkbox" data-auto="${esc(k.id)}"
                ${k.auto_article ? 'checked' : ''} /><span>automatisch</span></label>
              <button class="btn sm primary" data-save-chan="${esc(k.id)}">Speichern</button>
              <button class="btn sm danger" data-del-chan="${esc(k.id)}">${ic('trash', 'sm')}Entfernen</button>
            </div>` : ''}
          </div>`;
        }).join('')
        : `<div class="empty"><span class="ring">${ic('video', 'lg')}</span>
            <b>Noch kein Kanal in Beobachtung</b>
            <p>Trag oben einen Kanal ein. Der Hub sieht dann einmal täglich nach, ob es etwas Neues gibt.</p></div>`}
      </section>

      <section class="card flat">
        <div class="card-head"><h2>Gefundene Videos</h2>
          <span class="count">${offen.filter((v) => v.status === 'neu' || v.status === 'fehler').length} offen</span></div>
        ${videos.length
          ? `${offen.length ? videoTabelle(offen)
              : '<div class="empty">Aus dem letzten Durchlauf ist nichts offen.</div>'}
            ${beiseite.length ? disclose('skip',
              `${beiseite.length} übersprungene Video${beiseite.length === 1 ? '' : 's'} aus dem letzten Durchlauf`,
              `<div style="padding:12px 16px">
                <div class="sub" style="margin-bottom:10px">Nichts davon ist verloren. Der Grund entscheidet,
                  ob ein Video später von selbst nachrückt.</div>
                ${gruende.map(([schluessel, titel, sub]) => {
                  const n = beiseite.filter((v) => (v.skip_reason || 'limit') === schluessel).length;
                  return n ? `<div class="item is-idle" style="padding:9px 0">
                    <span class="grow"><span class="ttl">${titel}</span><span class="meta">${sub}</span></span>
                    <span class="side"><b>${n}</b></span></div>` : '';
                }).join('')}
                ${videoTabelle(beiseite)}
              </div>`, 'margin-top:10px') : ''}`
          : `<div class="empty"><span class="ring">${ic('video', 'lg')}</span>
              <b>Noch keine Videos gefunden</b>
              <p>Sobald ein beobachteter Kanal etwas Neues veröffentlicht, steht es hier.</p></div>`}
      </section>`;

    on('#channel-form', 'submit', (event) => {
      event.preventDefault();
      guard(event.target.querySelector('button'), async () => {
        await api(`/api/app/sites/${siteId}/channels`, {
          method: 'POST',
          body: {
            input: root.querySelector('#chan-input').value,
            interval_hours: root.querySelector('#chan-interval').value,
            max_per_scan: root.querySelector('#chan-max').value,
            angle: root.querySelector('#chan-angle').value,
            auto_article: root.querySelector('#chan-auto').checked,
            embed_video: root.querySelector('#chan-embed').checked,
          },
        });
        toast('Kanal wird jetzt beobachtet.');
        await render();
      });
    });
    on('[data-scan]', 'click', (event) => guard(event.currentTarget, async () => {
      const ergebnis = await api(`/api/app/channels/${event.currentTarget.dataset.scan}/scan`, { method: 'POST' });
      toast(ergebnis.neu ? `${ergebnis.neu} neue Videos gefunden.` : 'Keine neuen Videos.');
      await render();
    }));
    on('[data-save-chan]', 'click', (event) => guard(event.currentTarget, async () => {
      const id = event.currentTarget.dataset.saveChan;
      await api(`/api/app/channels/${id}`, {
        method: 'PATCH',
        body: {
          interval_hours: root.querySelector(`[data-int="${id}"]`).value,
          max_per_scan: root.querySelector(`[data-max="${id}"]`).value,
          angle: root.querySelector(`[data-angle="${id}"]`).value,
          auto_article: root.querySelector(`[data-auto="${id}"]`).checked,
        },
      });
      toast('Gespeichert.');
      await render();
    }));
    on('[data-toggle-chan]', 'click', (event) => guard(event.currentTarget, async () => {
      const { toggleChan, active } = event.currentTarget.dataset;
      await api(`/api/app/channels/${toggleChan}`, { method: 'PATCH', body: { active: active !== '1' } });
      await render();
    }));
    on('[data-del-chan]', 'click', async (event) => {
      if (!confirm('Kanal nicht mehr beobachten? Bereits erzeugte Artikel bleiben erhalten.')) return;
      await api(`/api/app/channels/${event.currentTarget.dataset.delChan}`, { method: 'DELETE' });
      await render();
    });
    on('[data-make]', 'click', (event) => guard(event.currentTarget, async () => {
      const artikel = await api(`/api/app/videos/${event.currentTarget.dataset.make}/article`, { method: 'POST' });
      navigate('article', artikel.id);
    }));
    on('[data-skip]', 'click', (event) => guard(event.currentTarget, async () => {
      await api(`/api/app/videos/${event.currentTarget.dataset.skip}/skip`, { method: 'POST' });
      await render();
    }));
  }

  if (tab === 'articles') {
    body.innerHTML = `
      <section class="card">
        <h2>Artikel schreiben</h2>
        <div class="sub">Ein einzelner Beitrag für diese Website, ohne Umweg über die Themenliste.</div>
        <form id="write-form" class="row" style="align-items:flex-end;margin-top:14px">
          <div class="field" style="flex:1;min-width:240px;margin:0">
            <label for="keyword">Thema oder Suchbegriff</label>
            <input id="keyword" required placeholder="z. B. Kaffeemaschine entkalken" /></div>
          <button class="btn primary" type="submit">${ic('spark', 'sm')}Artikel erzeugen</button>
        </form>
      </section>
      <section class="card flat">
        <div class="card-head"><h2>Artikel dieser Website</h2><span class="count">${articles.length}</span></div>
        ${articles.length ? articleTable(articles)
          : `<div class="empty"><span class="ring">${ic('doc', 'lg')}</span>
              <b>Noch kein Artikel</b>
              <p>Schreib den ersten von Hand oder lass einen Plan die Themenliste abarbeiten.</p></div>`}
      </section>`;

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
  // Kategorie aus- oder wieder einschliessen. Wird sofort gespeichert, ein extra
  // Speichern-Knopf waere bei einer Liste mit 38 Eintraegen nur laestig.
  on('[data-exclude]', 'click', (event) => guard(event.currentTarget, async () => {
    const name = event.currentTarget.dataset.exclude;
    const bisher = site.excluded_categories || [];
    const neu = bisher.includes(name) ? bisher.filter((n) => n !== name) : [...bisher, name];
    await api(`/api/app/sites/${siteId}`, { method: 'PATCH', body: { excluded_categories: neu } });
    toast(bisher.includes(name) ? `„${name}" ist wieder zugelassen.` : `„${name}" wird nicht mehr gewählt.`);
    await render();
  }));

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
  const tabs = [['generate', 'Post erzeugen'], ['recurring', 'Wiederkehrende Posts', plans.length], ['target', 'Gezielte Posts']];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Posts</h1><p class="sub">Einzelne Beiträge erzeugen oder ganze Redaktionspläne laufen lassen.</p></div>
    </div>
    <div class="tabs" role="tablist">
      ${tabs.map(([key, label, n]) => `<button role="tab" data-ptab="${key}" aria-selected="${tab === key}"
        class="${tab === key ? 'active' : ''}">${label}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}
    </div>
    <div id="posts-body"></div>`;

  const body = view.querySelector('#posts-body');
  if (!sites.length) {
    body.innerHTML = `<div class="card"><div class="empty"><span class="ring">${ic('globe', 'lg')}</span>
      <b>Noch keine Website angelegt</b>
      <p>Leg zuerst eine Website an und verbinde sie mit dem Begleit-Plugin.
        Danach entstehen hier Beiträge.</p>
      <a class="btn primary" href="#/sites">${ic('plus', 'sm')}Website anlegen</a></div></div>`;
  } else if (tab === 'generate') {
    body.innerHTML = `
      <section class="card">
        <h2>Post erzeugen</h2>
        <div class="sub">Ein Thema eingeben, der Hub schreibt daraus einen fertigen Beitrag samt Bildern.</div>
        <form id="generate-form" style="margin-top:14px">
          <div class="fields-2">
            <div class="field">
              <label for="gen-site">Website</label>
              <select id="gen-site">${sites.map((site) =>
                `<option value="${esc(site.id)}">${esc(site.name)}${site.connected ? '' : ' (nicht verbunden)'}</option>`).join('')}</select>
            </div>
            <div class="field">
              <label for="gen-keyword">Thema oder Suchbegriff</label>
              <input id="gen-keyword" required placeholder="z. B. Kaffeemaschine richtig entkalken" />
            </div>
          </div>
          <div class="field">
            <label for="gen-angle">Blickwinkel</label>
            <input id="gen-angle" placeholder="optional, z. B. Schritt für Schritt für Einsteiger" />
          </div>
          <div class="formfoot"><button class="btn primary" type="submit">${ic('spark', 'sm')}Post erzeugen</button>
            <span class="state">Dauert ein bis drei Minuten. Du kannst die Seite danach schließen.</span></div>
        </form>
      </section>`;

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
      <section class="card flat">
        <div class="card-head"><h2>Laufende Pläne</h2><span class="count">${plans.length}</span>
          <span class="tools"><button class="btn sm primary" data-disc="neuerplan">${ic('plus', 'sm')}Plan anlegen</button></span></div>
        ${plans.length ? plans.map((plan) => {
          const auf = !!state.offen[`plan:${plan.id}`];
          return `<div class="item ${plan.active ? 'is-ok' : 'is-idle'}" style="display:block">
            <div class="row" style="align-items:flex-start">
              <span class="grow">
                <span class="ttl">${esc(plan.name)}
                  ${plan.active ? '' : '<span class="badge">pausiert</span>'}
                  ${plan.auto_publish ? '<span class="badge info">sendet automatisch</span>' : ''}</span>
                <span class="kv">
                  <span>${esc(plan.site_name)}</span>
                  <span><b>${plan.per_week}×</b> pro Woche</span>
                  <span>erzeugt <b>${plan.article_count}</b></span>
                  <span>nächster Lauf <b>${plan.active ? esc(fmtDate(plan.next_run_at)) : '—'}</b></span>
                </span>
              </span>
              <span class="acts">
                <button class="btn sm" data-run-plan="${esc(plan.id)}">${ic('play', 'sm')}Jetzt ausführen</button>
                <button class="btn sm quiet icon" data-toggle-plan="${esc(plan.id)}" data-active="${plan.active}"
                  title="${plan.active ? 'Pausieren' : 'Aktivieren'}">${ic(plan.active ? 'pause' : 'play', 'sm')}</button>
                <button class="btn sm quiet" data-disc="plan:${esc(plan.id)}">${ic('sliders', 'sm')}Bearbeiten</button>
              </span>
            </div>
            ${auf ? `<div style="margin-top:12px">
              <div class="field"><label>Themenbereiche, eine Zeile je Bereich</label>
                <textarea data-areas="${esc(plan.id)}" rows="6">${esc(plan.areas)}</textarea>
                <div class="hint">Greift erst, wenn die Themenliste der Website leer ist.</div></div>
              <div class="row" style="align-items:flex-end;gap:12px">
                <div class="field" style="margin:0;width:140px"><label>Posts pro Woche</label>
                  <input type="number" min="1" max="14" data-perweek="${esc(plan.id)}" value="${plan.per_week}" /></div>
                <div class="field" style="margin:0;width:150px"><label>Uhrzeit (UTC)</label>
                  <input type="number" min="0" max="23" data-hour="${esc(plan.id)}" value="${plan.publish_hour}" /></div>
                <span class="spacer"></span>
                <button class="btn sm primary" data-save-plan="${esc(plan.id)}">Speichern</button>
                <button class="btn sm danger" data-del-plan="${esc(plan.id)}">${ic('trash', 'sm')}Löschen</button>
              </div>
            </div>` : ''}
          </div>`;
        }).join('')
        : `<div class="empty"><span class="ring">${ic('clock', 'lg')}</span>
            <b>Noch kein Plan angelegt</b>
            <p>Ein Plan arbeitet die Themenliste einer Website ab, zweimal pro Woche etwa.
              Danach läuft der Blog ohne dich.</p>
            <button class="btn primary" data-disc="neuerplan">${ic('plus', 'sm')}Plan anlegen</button></div>`}
      </section>

      ${disclose('neuerplan', 'Neuen Plan anlegen', `
        <form id="plan-form" style="padding:16px 18px">
          <div class="fields-2">
            <div class="field">
              <label for="plan-site">Website</label>
              <select id="plan-site">${sites.map((site) => `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join('')}</select>
            </div>
            <div class="field"><label for="plan-name">Name des Plans</label>
              <input id="plan-name" placeholder="z. B. Ratgeber Kaffee" /></div>
          </div>
          <div class="field">
            <label for="plan-areas">Themenbereiche, eine Zeile je Bereich</label>
            <textarea id="plan-areas" rows="6"
              placeholder="Kaffeezubereitung zu Hause&#10;Kaffeemaschinen pflegen&#10;Bohnensorten und Röstung"></textarea>
            <div class="hint">Nur die Reserve: Solange die Themenliste der Website gefüllt ist,
              arbeitet der Plan die ab.</div>
          </div>
          <div class="fields-2">
            <div class="field"><label for="plan-per-week">Posts pro Woche</label>
              <input id="plan-per-week" type="number" min="1" max="14" value="2" /></div>
            <div class="field"><label for="plan-hour">Bevorzugte Uhrzeit (UTC)</label>
              <input id="plan-hour" type="number" min="0" max="23" value="9" /></div>
          </div>
          <label class="check" style="margin:8px 0 14px">
            <input type="checkbox" id="plan-auto-publish" />
            <span><b>Fertige Posts automatisch an WordPress senden</b>
              <i>Ohne Haken bleiben sie als Entwurf im Hub und warten auf deine Freigabe.</i></span></label>
          <div class="formfoot"><button class="btn primary" type="submit">Plan anlegen</button></div>
        </form>`, 'margin-top:16px')}`;

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
      <section class="card">
        <h2>Gezielter Post</h2>
        <div class="sub">Ein Beitrag, der für einen bestimmten Suchbegriff stehen soll. Er läuft über ein
          eigenes Regelwerk, das strenger auf Suchabsicht, Antwort im ersten Absatz und Abdeckung achtet.
          Außer Website und Suchbegriff ist alles freiwillig, je mehr du einträgst, desto gezielter der Text.</div>
        <form id="target-form" style="margin-top:14px">
          <div class="fields-2">
            <div class="field">
              <label for="tgt-site">Website</label>
              <select id="tgt-site">${sites.map((site) =>
                `<option value="${esc(site.id)}">${esc(site.name)}${site.connected ? '' : ' (nicht verbunden)'}</option>`).join('')}</select>
            </div>
            <div class="field">
              <label for="tgt-keyword">Suchbegriff</label>
              <input id="tgt-keyword" required placeholder="z. B. kaffeemaschine entkalken" />
            </div>
          </div>
          <div class="fields-3">
            <div class="field"><label for="tgt-intent">Suchabsicht</label>
              <input id="tgt-intent" placeholder="Anleitung, Vergleich, Definition" /></div>
            <div class="field"><label for="tgt-volume">Suchvolumen im Monat</label>
              <input id="tgt-volume" type="number" min="0" placeholder="optional" /></div>
            <div class="field"><label for="tgt-difficulty">Schwierigkeit (0 bis 100)</label>
              <input id="tgt-difficulty" type="number" min="0" max="100" placeholder="optional" /></div>
          </div>
          <div class="field"><label for="tgt-secondary">Nebenbegriffe</label>
            <input id="tgt-secondary" placeholder="durch Komma getrennt" /></div>
          <div class="field"><label for="tgt-questions">Fragen zu dieser Suche, eine je Zeile</label>
            <textarea id="tgt-questions" rows="3" placeholder="Aus „Ähnliche Fragen“ bei Google."></textarea></div>
          <div class="fields-2">
            <div class="field"><label for="tgt-covered">Das haben die führenden Treffer schon</label>
              <textarea id="tgt-covered" rows="4" placeholder="Stichpunkte: welche Themen decken die ersten zehn ab?"></textarea></div>
            <div class="field"><label for="tgt-gaps">Das fehlt dort</label>
              <textarea id="tgt-gaps" rows="4" placeholder="Stichpunkte: was keiner beantwortet, was veraltet ist."></textarea></div>
          </div>
          <div class="field"><label for="tgt-angle">Blickwinkel</label>
            <input id="tgt-angle" placeholder="optional, z. B. für Einsteiger ohne Vorkenntnisse" /></div>
          <div class="formfoot"><button class="btn primary" type="submit">${ic('search', 'sm')}Gezielten Post erzeugen</button></div>
        </form>
      </section>

      <section class="card">
        <h2>Automatische Recherche <span class="badge">in Vorbereitung</span></h2>
        <div class="sub">Die Felder oben füllst du derzeit selbst. Als Nächstes holt der Hub sie sich:
          Suchbegriffe zu einem Saatwort sammeln, Volumen und Schwierigkeit dazu, die echten
          Suchergebnisse ansehen und daraus Abdeckung und Lücken ableiten.</div>
      </section>`;

    on('#target-form', 'submit', (event) => {
      event.preventDefault();
      guard(event.target.querySelector('button'), async () => {
        const feld = (id) => root.querySelector(`#tgt-${id}`).value;
        const article = await api('/api/app/articles', {
          method: 'POST',
          body: {
            origin: 'target',
            site_id: feld('site'),
            keyword: feld('keyword'),
            angle: feld('angle'),
            intent: feld('intent'),
            volume: feld('volume'),
            difficulty: feld('difficulty'),
            secondary: feld('secondary'),
            questions: feld('questions'),
            covered: feld('covered'),
            gaps: feld('gaps'),
          },
        });
        navigate('article', article.id);
      });
    });
  }

  on('[data-ptab]', 'click', (event) => { state.data.postsTab = event.currentTarget.dataset.ptab; render(); });
}

// ----------------------------------------------------------------- Artikel

/* Die Artikelliste. Sortierbar; absteigend holt die Probleme nach oben, denn das
   ist die Reihenfolge, in der man sucht. */
function articleTable(articles) {
  const sortiert = sortiere(articles, state.sortA, {
    titel: (a) => (a.title || a.keyword || '').toLowerCase(),
    status: (a) => RANG[a.status] || 0,
    woerter: (a) => a.word_count || 0,
    created: (a) => a.created_at || '',
  });

  return `<div class="tblwrap"><table>
    <thead><tr>
      ${sortKopf('sortA', 'titel', 'Titel')}
      ${sortKopf('sortA', 'status', 'Status')}
      ${sortKopf('sortA', 'woerter', 'Wörter', 'right')}
      ${sortKopf('sortA', 'created', 'Erstellt', 'nowrap')}
    </tr></thead>
    <tbody>${sortiert.map((a) => `<tr class="clickable ${spur(a.status)}" data-article="${esc(a.id)}">
      <td><span class="ttl">${esc(a.title || a.keyword)}</span>
        <span class="meta">${a.site_name ? esc(a.site_name) : ''}
          ${a.origin === 'recurring' ? '<span class="badge info">wiederkehrend</span>' : ''}
          ${a.origin === 'youtube' ? `<span class="badge info">${ic('video', 'sm')}Video</span>` : ''}
          ${a.origin === 'target' ? `<span class="badge info">${ic('search', 'sm')}gezielt</span>` : ''}
          ${a.archived ? '<span class="badge">archiviert</span>' : ''}</span>
        ${a.wp_url ? `<span class="meta"><a href="${esc(a.wp_url)}" target="_blank" rel="noopener"
          onclick="event.stopPropagation()">${esc(a.wp_url)} ${ic('ext', 'sm')}</a></span>` : ''}
        ${a.status === 'failed' && a.error ? `<span class="meta" style="color:var(--stop)">${esc(a.error)}</span>` : ''}</td>
      <td data-label="Status">${statusBadge(a.status)}</td>
      <td data-label="Wörter" class="right">${a.word_count || '–'}</td>
      <td data-label="Erstellt" class="nowrap">${esc(fmtDate(a.created_at))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}


async function renderArticles(view) {
  const archiv = state.data.showArchive ? '1' : '0';
  const query = new URLSearchParams({ archived: archiv });
  if (state.data.filterSite) query.set('site', state.data.filterSite);

  const [data, sites] = await Promise.all([api(`/api/app/articles?${query}`), api('/api/app/sites')]);
  const { articles, counts } = data;

  const fehler = articles.filter((a) => a.status === 'failed').length;
  state.data.marken = { ...(state.data.marken || {}), articles: fehler || 0 };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Artikel</h1><p class="sub">Alle Beiträge bleiben hier gespeichert, auch nach dem Senden an WordPress.</p></div>
      <div class="acts">
        <select id="filter-site" style="width:auto">
          <option value="">Alle Websites</option>
          ${sites.map((s) => `<option value="${esc(s.id)}" ${state.data.filterSite === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <a class="btn primary" href="#/posts">${ic('spark', 'sm')}Post erzeugen</a>
      </div>
    </div>
    <div class="tabs" role="tablist">
      <button role="tab" data-arch="0" aria-selected="${!state.data.showArchive}"
        class="${state.data.showArchive ? '' : 'active'}">In Arbeit<span class="n">${counts.offen}</span></button>
      <button role="tab" data-arch="1" aria-selected="${!!state.data.showArchive}"
        class="${state.data.showArchive ? 'active' : ''}">Archiv<span class="n">${counts.archiv}</span></button>
    </div>
    <section class="card flat">${articles.length ? articleTable(articles)
      : `<div class="empty"><span class="ring">${ic('doc', 'lg')}</span>
          <b>${state.data.showArchive ? 'Noch nichts im Archiv' : 'Keine offenen Beiträge'}</b>
          <p>${state.data.showArchive
            ? 'Beiträge landen hier, sobald du sie nach dem Senden archivierst.'
            : 'Erzeug einen Beitrag von Hand oder lass einen Plan die Themenliste abarbeiten.'}</p>
          ${state.data.showArchive ? '' : `<a class="btn primary" href="#/posts">${ic('spark', 'sm')}Post erzeugen</a>`}</div>`}</section>`;

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
  const zurueck = `<a class="back" href="#/articles">${ic('out', 'sm')}Artikel</a>`;

  // Waehrend der Erzeugung: zeigen, wie weit es ist, statt nur zu warten.
  if (article.status === 'generating') {
    const SCHRITTE = [
      ['Thema geprüft', 'Vorgaben der Website gelesen'],
      ['Text geschrieben', 'das dauert am längsten'],
      ['Bilder erzeugt', 'nur wenn ein Bilddienst eingerichtet ist'],
      ['Kategorie gewählt', 'aus den vorhandenen Kategorien'],
    ];
    const alter = (Date.now() - new Date(`${String(article.created_at).replace(' ', 'T')}Z`).getTime()) / 1000;
    const schritt = alter < 10 ? 0 : alter < 100 ? 1 : alter < 140 ? 2 : 3;

    view.innerHTML = `${zurueck}
      <div class="page-head"><div><h1>${esc(article.title || article.keyword)}</h1>
        <p class="sub">${esc(article.site_name)} · ${statusBadge(article.status)}</p></div></div>
      <section class="card">
        <h2>Der Artikel wird geschrieben</h2>
        <div class="sub">Das dauert je nach Länge ein bis drei Minuten.</div>
        <div class="progress indef" style="margin-top:14px"><i></i></div>
        <ol class="steps">${SCHRITTE.map(([titel, sub], n) => `
          <li class="${n < schritt ? 'done' : n === schritt ? 'now' : ''}">
            ${ic(n < schritt ? 'check' : n === schritt ? 'refresh' : 'clock', 'sm')}
            <span><b>${titel}</b><i style="display:block;font-size:12.5px;color:var(--ink-3)">${sub}</i></span>
          </li>`).join('')}</ol>
        <p style="margin-top:16px;color:var(--ink-2);font-size:13.5px">
          Du kannst diese Seite schließen, der Hub schreibt weiter. Fertige Beiträge stehen unter „Artikel“.</p>
      </section>`;
    setTimeout(() => { if (state.route === 'article' && state.param === articleId) render(); }, 5000);
    return;
  }

  const bilderFertig = (article.images || []).filter((i) => i.status === 'ready').length;

  view.innerHTML = `${zurueck}
    <div class="page-head">
      <div>
        <h1>${esc(article.title || article.keyword)}</h1>
        <div class="kv" style="margin-top:6px">
          <span>${esc(article.site_name)}</span>
          <span>${statusBadge(article.status)}</span>
          <span>Wörter <b>${article.word_count || 0}</b></span>
          ${article.model ? `<span>Modell <b>${esc(article.model)}</b></span>` : ''}
          ${article.origin === 'youtube' ? `<span><span class="badge info">${ic('video', 'sm')}Video</span>${
            article.source_url ? ` <a href="${esc(article.source_url)}" target="_blank" rel="noopener">Quelle ${ic('ext', 'sm')}</a>` : ''}</span>` : ''}
          ${article.origin === 'target' ? `<span class="badge info">${ic('search', 'sm')}gezielt</span>` : ''}
          ${article.archived ? `<span class="badge">archiviert ${esc(fmtDate(article.archived_at))}</span>` : ''}
        </div>
      </div>
      <div class="acts">
        ${article.status === 'published' && article.wp_url
          ? `<a class="btn primary" href="${esc(article.wp_url)}" target="_blank" rel="noopener">
               ${ic('ext', 'sm')}In WordPress ansehen</a>
             <button class="btn" id="publish">${ic('send', 'sm')}Erneut senden</button>`
          : `<button class="btn primary" id="publish">${ic('send', 'sm')}An WordPress senden</button>`}
        <button class="btn" id="regenerate">${ic('refresh', 'sm')}Neu schreiben</button>
        <button class="btn" id="toggle-archive">${article.archived ? 'Aus dem Archiv holen' : 'Archivieren'}</button>
        <button class="btn danger icon" id="delete-article" title="Löschen">${ic('trash', 'sm')}</button>
      </div>
    </div>
    ${article.error ? `<div class="notice err">${ic('alert')}<div class="grow">
      <b>Der Artikel ist nicht fertig geworden.</b><div>${esc(article.error)}</div></div></div>` : ''}
    ${article.notice ? `<div class="notice warn">${ic('alert')}<div class="grow">${esc(article.notice)}</div></div>` : ''}

    <div class="tabs" role="tablist">
      <button role="tab" data-atab="preview" aria-selected="${tab === 'preview'}" class="${tab === 'preview' ? 'active' : ''}">Vorschau</button>
      <button role="tab" data-atab="edit" aria-selected="${tab === 'edit'}" class="${tab === 'edit' ? 'active' : ''}">Bearbeiten</button>
      <button role="tab" data-atab="seo" aria-selected="${tab === 'seo'}" class="${tab === 'seo' ? 'active' : ''}">SEO</button>
      <button role="tab" data-atab="images" aria-selected="${tab === 'images'}" class="${tab === 'images' ? 'active' : ''}">Bilder${
        bilderFertig ? `<span class="n">${bilderFertig}</span>` : ''}</button>
    </div>

    <section class="card">
      ${tab === 'preview' ? (article.content_html
        ? `<div class="preview"><h1 style="margin-top:0">${esc(article.title)}</h1>${article.content_html}</div>`
        : `<div class="empty"><span class="ring">${ic('doc', 'lg')}</span><b>Kein Inhalt</b>
            <p>Der Beitrag ist nicht fertig geworden. „Neu schreiben“ startet einen neuen Versuch.</p></div>`) : ''}

      ${tab === 'edit' ? `
        <div class="field"><label for="title">Titel</label><input id="title" value="${esc(article.title)}" /></div>
        <div class="field"><label for="excerpt">Anreißer</label>
          <textarea id="excerpt" rows="3">${esc(article.excerpt)}</textarea></div>
        <div class="field"><label for="content_html">Inhalt als HTML</label>
          <textarea id="content_html" class="code">${esc(article.content_html)}</textarea></div>
        <div class="formfoot"><button class="btn primary" id="save-article">Speichern</button>
          <span class="state">Änderungen gelten erst nach dem nächsten Senden in WordPress.</span></div>` : ''}

      ${tab === 'seo' ? `
        <div class="fields-2">
          <div class="field"><label for="meta_title">SEO-Titel</label>
            <input id="meta_title" value="${esc(article.meta_title)}" maxlength="70" />
            <div class="hint">Höchstens 60 Zeichen, Suchbegriff möglichst weit vorn.</div></div>
          <div class="field"><label for="slug">Adresse (Slug)</label><input id="slug" value="${esc(article.slug)}" /></div>
          <div class="field"><label for="category">Kategorie</label><input id="category" value="${esc(article.category)}" /></div>
          <div class="field"><label for="tags">Schlagwörter</label>
            <input id="tags" value="${esc(article.tags)}" />
            <div class="hint">Durch Komma getrennt.</div></div>
        </div>
        <div class="field"><label for="meta_desc">SEO-Beschreibung</label>
          <textarea id="meta_desc" rows="3">${esc(article.meta_desc)}</textarea>
          <div class="hint">140 bis 160 Zeichen. Was der Leser bekommt, ohne Klickköder.</div></div>
        <div class="formfoot"><button class="btn primary" id="save-article">Speichern</button></div>` : ''}

      ${tab === 'images' ? ((article.images || []).length ? `
        <div class="grid two">
          ${article.images.map((img) => `
            <div class="card" style="margin:0;padding:0;overflow:hidden">
              ${img.url
                ? `<img src="${esc(img.url)}" alt="${esc(img.alt)}" style="width:100%;display:block;aspect-ratio:3/2;object-fit:cover" />`
                : `<div class="empty" style="padding:40px 10px">${img.status === 'failed'
                    ? `<span class="badge err">${ic('alert', 'sm')}fehlgeschlagen</span>
                       <p>${esc(img.error || 'Kein Grund überliefert.')}</p>`
                    : `<span class="badge warn">${ic('clock', 'sm')}wird erzeugt</span>`}</div>`}
              <div style="padding:14px">
                <span class="badge ${img.slot === 1 ? 'info' : ''}">${img.slot === 1 ? 'Beitragsbild' : `im Text: [[BILD:${img.slot}]]`}</span>
                <div class="hint" style="margin-top:8px"><b>Alt:</b> ${esc(img.alt)}</div>
                ${img.caption ? `<div class="hint"><b>Unterschrift:</b> ${esc(img.caption)}</div>` : ''}
                ${disclose(`img:${img.id || img.slot}`, 'Bildbeschreibung',
                  `<div class="hint" style="padding:8px 2px">${esc(img.motif)}</div>`, 'margin-top:6px')}
              </div>
            </div>`).join('')}
        </div>
        <div class="formfoot"><button class="btn" id="regen-images">${ic('refresh', 'sm')}Bilder neu erzeugen</button>
          <span class="state">Ersetzt alle Bilder dieses Artikels. Die Bildkonzepte bleiben gleich.</span></div>`
        : `<div class="empty"><span class="ring">${ic('image', 'lg')}</span>
            <b>Keine Bilder zu diesem Artikel</b>
            <p>${article.imagesEnabled
              ? 'Der Beitrag entstand, bevor die Bildfunktion aktiv war. „Neu schreiben“ erzeugt Bildkonzepte mit.'
              : 'Die Bildfunktion ist noch nicht eingerichtet, das geht in den Einstellungen.'}</p>
            ${article.imagesEnabled ? '' : '<a class="btn" href="#/settings">Einstellungen öffnen</a>'}</div>`) : ''}
    </section>`;

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

  const SETS = [
    ['s1', 'Anthropic-Schlüssel'], ['s2', 'Marke und Vorgaben'], ['s3', 'Bilder'],
    ['s4', 'YouTube und Transkripte'], ['s5', 'Diagnose-Zugang'], ['s6', 'Prompt-Framework'],
  ];

  view.innerHTML = `
    <div class="page-head"><div><h1>Einstellungen</h1>
      <p class="sub">Gelten für alle Websites. Jeder Abschnitt wird für sich gespeichert.</p></div></div>

    <div class="withnav"><div>
    <section class="card" id="s1">
      <h2>Anthropic-Schlüssel</h2>
      <p class="sub">Wird für die Texterzeugung gebraucht. Erhältlich unter
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
      <div class="field" style="margin-top:14px">
        <label for="anthropic_api_key">API-Key</label>
        <input id="anthropic_api_key" type="password" placeholder="${data.apiKey.configured ? `hinterlegt (${esc(data.apiKey.hint)})` : 'sk-ant-…'}" />
        <div class="hint">${data.apiKey.configured
          ? `Ein Key ist hinterlegt (Quelle: ${data.apiKey.source === 'env' ? 'Umgebungsvariable' : 'Oberfläche'}). Feld leer lassen, um ihn zu behalten.`
          : 'Noch kein Key hinterlegt. Ohne Key können keine Artikel erzeugt werden.'}</div>
      </div>
      <div class="fields-2">
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
      <div class="formfoot"><button class="btn primary" id="save-settings-5">Speichern</button></div>
    </section>

    <section class="card" id="s2">
      <h2>Marke &amp; Standardvorgaben</h2>
      <div class="fields-2">
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
      <button class="btn primary" id="save-settings">Speichern</button>
    </section>

    <section class="card" id="s3">
      <h2>Bilder</h2>
      <p class="sub">Claude erzeugt keine Bilder. Der Hub spricht dafür einen Bilddienst an,
        der die OpenAI-Bildschnittstelle versteht. Die fertigen Bilder wandern beim Veröffentlichen
        automatisch in die WordPress-Mediathek, Bild 1 wird das Beitragsbild.</p>
      <div class="fields-2" style="margin-top:14px">
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
      <div class="fields-2">
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
      <button class="btn primary" id="save-settings-3">Speichern</button>
    </section>

    <section class="card" id="s4">
      <h2>YouTube-Kanäle und Transkripte</h2>
      <p class="sub">Für den Reiter „YT Channel Spy" bei den Websites. Für die Transkripte wird ein
        Dienst gebraucht, weil YouTube dafür keine offene Schnittstelle hat. Derselbe Schlüssel
        findet auch die neuen Videos eines Kanals.</p>
      <label class="check" style="margin:14px 0">
        <input type="checkbox" id="youtube_enabled" ${data.youtube_enabled === '1' ? 'checked' : ''} />
        <span><b>Kanalbeobachtung einschalten</b>
          <i>Aus lässt alle Kanäle ruhen, ohne sie zu löschen.</i></span></label>
      <div class="field">
        <label for="transcript_api_key">Schlüssel des Transkript-Dienstes</label>
        <input id="transcript_api_key" type="password" placeholder="${data.transcriptKey.configured ? `hinterlegt (${esc(data.transcriptKey.hint)})` : 'z. B. Supadata-Schlüssel'}" />
        <div class="hint">${data.transcriptKey.configured
          ? 'Ein Schlüssel ist hinterlegt. Feld leer lassen, um ihn zu behalten.'
          : 'Voreingestellt ist Supadata (supadata.ai). Jeder Dienst mit HTTP-Schnittstelle funktioniert.'}</div>
      </div>
      <div class="fields-2">
        <div class="field"><label for="transcript_url">Abrufadresse</label>
          <input id="transcript_url" value="${esc(data.transcript_url)}" />
          <div class="hint">Platzhalter: <code>{video_url}</code>, <code>{video_id}</code>, <code>{lang}</code></div></div>
        <div class="field"><label for="transcript_header">Name des Schlüssel-Headers</label>
          <input id="transcript_header" value="${esc(data.transcript_header)}" placeholder="x-api-key" />
          <div class="hint">Bei „authorization" wird automatisch „Bearer" vorangestellt.</div></div>
      </div>
      <div class="fields-2">
        <div class="field">
          <label for="youtube_source">Woher die Videoliste kommt</label>
          <select id="youtube_source">
            ${[['auto', 'Automatisch (empfohlen)'], ['supadata', 'Nur Supadata'], ['feed', 'Nur RSS-Feed'],
               ['google', 'Nur YouTube Data API'], ['seite', 'Nur Kanalseite']]
              .map(([wert, text]) => `<option value="${wert}" ${data.youtube_source === wert ? 'selected' : ''}>${text}</option>`)
              .join('')}
          </select>
          <div class="hint">Automatisch probiert der Reihe nach: RSS-Feed, Supadata, Google, Kanalseite.
            YouTube beantwortet den RSS-Feed von Servern aus oft mit 404, dann greift Supadata.</div>
        </div>
        <div class="field">
          <label for="youtube_api_key">Google API-Schlüssel (optional)</label>
          <input id="youtube_api_key" type="password" placeholder="${data.youtubeKey.configured ? `hinterlegt (${esc(data.youtubeKey.hint)})` : 'wird normalerweise nicht gebraucht'}" />
          <div class="hint">Nur ein weiterer Rückfallweg. Ohne ihn funktioniert alles genauso.</div>
        </div>
      </div>
      <div class="hint">Die Regelwerke für Videoartikel und gezielte Posts stehen weiter unten
        unter „Prompt-Framework“.</div>
      <div class="formfoot"><button class="btn primary" id="save-settings-4">Speichern</button></div>
    </section>

    <section class="card" id="s5">
      <h2>Diagnose-Zugang</h2>
      <p class="sub">Erzeugt einen Link, über den sich der komplette Systemzustand samt Protokoll abrufen lässt –
        ohne Anmeldung, nur mit diesem Link. Jede Aktivierung erzeugt einen <strong>neuen</strong> Token,
        der vorherige Link funktioniert danach nicht mehr. Der Link bleibt gültig, bis du ihn deaktivierst.</p>
      <div id="diagnostics-box" class="hint" style="margin:14px 0">wird geladen …</div>
      <div class="btnrow">
        <button class="btn primary" id="diag-enable">Neuen Diagnose-Link erzeugen</button>
        <button class="btn danger" id="diag-disable">Zugang deaktivieren</button>
      </div>
    </section>

    <section class="card" id="s6">
      <h2>Prompt-Framework</h2>
      <p class="sub">Die Arbeitsanweisung an die KI. Der Hub ergänzt automatisch das Briefing der jeweiligen Website
        (Zielgruppe, Tonalität, Sprache, Länge) und das konkrete Thema – dieses Regelwerk bestimmt, <em>wie</em> geschrieben wird.</p>
      <div class="notice info">${ic('alert')}<div class="grow">
        Vier Regelwerke mit zusammen rund ${Math.round((String(data.article_prompt).length
          + String(data.topic_prompt).length + String(data.video_prompt).length
          + String(data.target_prompt).length) / 100) / 10} Tausend Zeichen.
        Jedes ist einzeln aufklappbar, damit die Seite bedienbar bleibt.</div></div>
      ${[['article_prompt', 'Artikel', data.article_prompt],
         ['topic_prompt', 'Themenvorschläge', data.topic_prompt],
         ['video_prompt', 'Artikel aus Videos', data.video_prompt],
         ['target_prompt', 'Gezielte Posts', data.target_prompt]].map(([feld, name, wert]) =>
        disclose(`pf:${feld}`,
          `${name}<span style="margin-left:auto;color:var(--ink-3);font-size:12.5px">${
            String(wert || '').length.toLocaleString('de-DE')} Zeichen</span>`,
          `<div style="padding:14px 18px"><textarea id="${feld}" class="code">${esc(wert)}</textarea></div>`,
          'margin:0 -18px')).join('')}
      <div class="formfoot" style="margin-top:16px">
        <button class="btn primary" id="save-settings-2">Speichern</button>
        <button class="btn quiet" id="reset-prompts">Standard wiederherstellen</button>
        <span class="state">Ein aufgeklapptes Feld bleibt offen, auch wenn die Seite neu zeichnet.</span>
      </div>
    </section>

    </div>
    <nav class="jump">${SETS.map(([id, t], i) =>
      `<a href="#${id}" class="${i === 0 ? 'on' : ''}">${esc(t)}</a>`).join('')}</nav>
    </div>`;

  const saveSettings = (event) => guard(event.currentTarget, async () => {
    const body = {};
    for (const field of ['hub_name', 'model', 'effort', 'brand_name', 'brand_description', 'default_language',
      'default_word_count', 'default_tone', 'global_prompt', 'article_prompt', 'topic_prompt',
      'image_provider', 'images_per_article', 'image_base_url', 'image_model', 'image_size',
      'image_quality', 'image_style', 'transcript_url', 'transcript_header', 'video_prompt', 'target_prompt',
      'youtube_source']) {
      const el = root.querySelector(`#${field}`);
      if (el) body[field] = el.value;
    }
    const key = root.querySelector('#anthropic_api_key').value.trim();
    if (key) body.anthropic_api_key = key;
    const imageKey = root.querySelector('#image_api_key').value.trim();
    if (imageKey) body.image_api_key = imageKey;
    const transcriptKey = root.querySelector('#transcript_api_key');
    if (transcriptKey && transcriptKey.value.trim()) body.transcript_api_key = transcriptKey.value.trim();
    const youtubeKey = root.querySelector('#youtube_api_key');
    if (youtubeKey && youtubeKey.value.trim()) body.youtube_api_key = youtubeKey.value.trim();
    const ytAn = root.querySelector('#youtube_enabled');
    if (ytAn) body.youtube_enabled = ytAn.checked ? '1' : '0';
    await api('/api/app/settings', { method: 'PUT', body });
    state.session = null; // Hub-Name in der Seitenleiste neu laden
    toast('Gespeichert.');
    await render();
  });
  on('#save-settings', 'click', saveSettings);
  on('#save-settings-5', 'click', saveSettings);
  on('#save-settings-2', 'click', saveSettings);
  on('#save-settings-3', 'click', saveSettings);
  on('#save-settings-4', 'click', saveSettings);
  const renderDiagnostics = async () => {
    const box = root.querySelector('#diagnostics-box');
    if (!box) return;
    const info = await api('/api/app/diagnostics');
    box.innerHTML = info.active
      ? `<div class="notice info" style="margin:0">
           <div><strong>Aktiv</strong> seit ${fmtDate(info.created)}. Gilt so lange, bis du ihn deaktivierst oder ersetzt.</div>
           <div class="row" style="margin-top:8px">
             <code class="pair" id="diag-url" style="font-size:13px;letter-spacing:0">${esc(info.url)}</code>
             <button class="btn sm quiet" id="diag-copy">Kopieren</button>
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

  const suche = (state.data.logQuery || '').trim().toLowerCase();
  const gefiltert = logs.filter((l) => !suche
    || String(l.message).toLowerCase().includes(suche)
    || String(l.category).toLowerCase().includes(suche)
    || String(l.action || '').toLowerCase().includes(suche));
  const RANG_L = { error: 3, warn: 2, info: 1, debug: 0 };
  const zeilen = sortiere(gefiltert, state.sortL, {
    zeit: (l) => l.id || 0,
    stufe: (l) => RANG_L[l.level] || 0,
    bereich: (l) => `${l.category}/${l.action || ''}`,
    dauer: (l) => l.duration_ms || 0,
  });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Protokoll</h1><p class="sub">Jede Zeile ist ein Vorgang. Zeiten in UTC.
        Einträge verschwinden nach 7 Tagen, Debug-Einträge nach 2 Tagen.</p></div>
      <div class="acts">
        <button class="btn" id="reload">${ic('refresh', 'sm')}Aktualisieren</button>
      </div>
    </div>

    <section class="card flat">
      <div class="toolbar">
        <span class="search">${ic('search')}
          <input type="search" id="log-q" placeholder="Meldung oder Bereich suchen" value="${esc(state.data.logQuery || '')}" /></span>
        <select id="log-level" style="width:auto">${Object.entries(levels).map(([value, label]) =>
          `<option value="${value}" ${filter.level === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <select id="log-category" style="width:auto">${Object.entries(categories).map(([value, label]) =>
          `<option value="${value}" ${filter.category === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <select id="log-limit" style="width:auto">${[100, 200, 500, 1000].map((value) =>
          `<option value="${value}" ${Number(filter.limit) === value ? 'selected' : ''}>${value} Einträge</option>`).join('')}</select>
        <span class="spacer"></span>
        <span class="count">${zeilen.length} Zeilen</span>
      </div>
      ${zeilen.length ? `<div class="tblwrap"><table>
        <thead><tr>
          ${sortKopf('sortL', 'zeit', 'Zeit', 'nowrap')}
          ${sortKopf('sortL', 'stufe', 'Stufe')}
          ${sortKopf('sortL', 'bereich', 'Bereich')}
          ${sortKopf('sortL', 'dauer', 'Dauer', 'right')}
          <th>Meldung</th>
        </tr></thead>
        <tbody>${zeilen.map((entry) => `<tr class="${entry.level === 'error' ? 'is-err' : entry.level === 'warn' ? 'is-warn' : 'is-idle'}">
          <td class="nowrap" style="color:var(--ink-3)">${esc(fmtDate(entry.ts || entry.created_at))}</td>
          <td data-label="Stufe"><span class="badge ${entry.level === 'error' ? 'err'
            : entry.level === 'warn' ? 'warn' : entry.level === 'debug' ? '' : 'info'}">${esc(entry.level)}</span></td>
          <td data-label="Bereich"><span class="num">${esc(entry.category)}${entry.action ? `/${esc(entry.action)}` : ''}</span></td>
          <td data-label="Dauer" class="right">${entry.duration_ms != null ? `${esc(entry.duration_ms)} ms` : ''}</td>
          <td>${esc(entry.message)}
            ${entry.context ? disclose(`log:${entry.id}`, 'Einzelheiten',
              `<pre class="code">${esc(JSON.stringify(JSON.parse(entry.context), null, 2))}</pre>`) : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
      : `<div class="empty"><span class="ring">${ic('list', 'lg')}</span>
          <b>${suche || filter.level || filter.category ? 'Keine Zeile passt zu diesem Filter' : 'Noch nichts passiert'}</b>
          <p>${suche || filter.level || filter.category
            ? 'Setz den Filter zurück oder such nach etwas anderem.'
            : 'Sobald der Hub arbeitet, steht hier jeder Schritt mit Zeit, Dauer und Meldung.'}</p></div>`}
    </section>`;

  on('#log-q', 'input', (event) => {
    state.data.logQuery = event.target.value;
    render().then(() => {
      const feld = root.querySelector('#log-q');
      if (feld) { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length); }
    });
  });

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
