'use strict';
const express = require('express');
const diagnostics = require('./../diagnostics');
const { logger } = require('./../logger');

const router = express.Router();

/** Token aus der URL pruefen - dies ist der einzige Zugang ohne Anmeldung. */
function requireToken(req, res, next) {
  if (!diagnostics.verify(req.params.token)) {
    logger.warn('diagnostics', 'access', 'Diagnose-Zugriff mit ungueltigem oder abgelaufenem Token', {
      requestId: req.requestId,
      context: { ip: req.ip, user_agent: req.get('user-agent') },
    });
    return res.status(403).type('text/plain; charset=utf-8')
      .send('Dieser Diagnose-Link ist ungueltig oder abgelaufen. Im Hub unter Einstellungen einen neuen erzeugen.');
  }
  logger.info('diagnostics', 'access', 'Diagnosebericht abgerufen', {
    requestId: req.requestId,
    context: { ip: req.ip, format: req.path.endsWith('.json') ? 'json' : 'html' },
  });
  next();
}

/** Maschinenlesbarer Bericht - fuer die Auswertung durch Dritte gedacht. */
router.get('/:token/report.json', requireToken, (req, res) => {
  res.json(diagnostics.report({ limit: req.query.limit, level: req.query.level, category: req.query.category }));
});

/** Nur die Protokollzeilen als reiner Text - praktisch zum Mitlesen. */
router.get('/:token/logs.txt', requireToken, (req, res) => {
  const data = diagnostics.report({ limit: req.query.limit || 1000, level: req.query.level, category: req.query.category });
  const lines = data.logs
    .slice()
    .reverse()
    .map((entry) => {
      const parts = [
        entry.ts,
        entry.level.toUpperCase().padEnd(5),
        `${entry.category}/${entry.action || '-'}`.padEnd(22),
        entry.duration_ms != null ? `${entry.duration_ms}ms`.padStart(8) : ''.padStart(8),
        entry.message,
      ];
      if (entry.context) parts.push(`| ${JSON.stringify(entry.context)}`);
      return parts.join(' ');
    });
  res.type('text/plain; charset=utf-8').send(lines.join('\n'));
});

/** Lesbare Übersicht im Browser. */
router.get('/:token', requireToken, (req, res) => {
  const data = diagnostics.report({ limit: 300 });
  res.type('text/html; charset=utf-8').send(renderHtml(data, req.params.token));
});

const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml(data, token) {
  const rows = data.logs
    .map((entry) => `<tr class="${esc(entry.level)}">
      <td class="ts">${esc(entry.ts)}</td>
      <td><span class="lvl ${esc(entry.level)}">${esc(entry.level)}</span></td>
      <td>${esc(entry.category)}/${esc(entry.action || '-')}</td>
      <td>${entry.duration_ms != null ? esc(entry.duration_ms) + ' ms' : ''}</td>
      <td>${esc(entry.message)}${entry.context ? `<details><summary>Details</summary><pre>${esc(JSON.stringify(entry.context, null, 2))}</pre></details>` : ''}</td>
    </tr>`)
    .join('');

  const summary = data.log_summary
    .map((row) => `<span class="chip ${esc(row.level)}">${esc(row.category)}/${esc(row.level)}: ${row.n}</span>`)
    .join(' ');

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" /><title>Autoblog Diagnose</title>
<style>
  :root { color-scheme: light dark; --border:#d6d9de; --muted:#6b7480; --bg:#fff; --panel:#f7f8fa; }
  @media (prefers-color-scheme: dark) { :root { --border:#333; --muted:#98a1ad; --bg:#16181c; --panel:#1e2126; } }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; background: var(--bg); }
  h1 { margin: 0 0 4px; font-size: 20px; } h2 { font-size: 15px; margin: 26px 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 16px 0; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--panel); }
  .card b { display: block; font-size: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; text-align: left; }
  .ts { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); }
  .lvl { padding: 1px 6px; border-radius: 100px; font-size: 11px; text-transform: uppercase; background: var(--panel); border: 1px solid var(--border); }
  .lvl.error { background: #fdecea; color: #b3261e; } .lvl.warn { background: #fdf3e0; color: #9a6300; }
  tr.error td { background: rgba(179,38,30,.06); }
  pre { background: var(--panel); padding: 8px; border-radius: 6px; overflow: auto; font-size: 12px; margin: 6px 0 0; }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  .chip { display: inline-block; border: 1px solid var(--border); border-radius: 100px; padding: 1px 8px; font-size: 12px; margin: 2px 0; }
  a.btn { display: inline-block; border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; text-decoration: none; margin-right: 6px; }
</style></head><body>
  <h1>Autoblog Diagnose</h1>
  <p class="muted">Erstellt: ${esc(data.generated_at)} · Hub-Version ${esc(data.hub.version)} · Node ${esc(data.system.node)} ·
    Laufzeit ${Math.round(data.hub.uptime_seconds / 60)} Minuten</p>
  <p>
    <a class="btn" href="/diagnose/${esc(token)}/report.json">Vollständiger Bericht (JSON)</a>
    <a class="btn" href="/diagnose/${esc(token)}/logs.txt?limit=2000">Protokoll als Text</a>
    <a class="btn" href="/diagnose/${esc(token)}/report.json?level=error">Nur Fehler (JSON)</a>
  </p>

  <div class="grid">
    <div class="card"><b>${data.counts.sites_connected}/${data.counts.sites}</b>Websites verbunden</div>
    <div class="card"><b>${data.counts.plans_active}</b>aktive Pläne</div>
    <div class="card"><b>${data.counts.articles}</b>Artikel gesamt</div>
    <div class="card"><b>${data.errors_24h}</b>Fehler (24 h)</div>
    <div class="card"><b>${data.counts.logs}</b>Protokolleinträge</div>
    <div class="card"><b>${esc(data.settings.api_key.configured ? 'ja' : 'nein')}</b>API-Key hinterlegt</div>
  </div>

  <h2>Verteilung der letzten 7 Tage</h2><p>${summary || '<span class="muted">keine Daten</span>'}</p>

  <h2>Websites</h2>
  <table><thead><tr><th>Name</th><th>URL</th><th>Status</th><th>Weg</th><th>zuletzt gesehen</th><th>WP</th></tr></thead><tbody>
    ${data.sites.map((site) => `<tr><td>${esc(site.name)}</td><td>${esc(site.url)}</td><td>${esc(site.status)}</td>
      <td>${esc(site.delivery)}</td><td>${esc(site.last_seen_at || '–')}</td><td>${esc(site.wp_version || '–')}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">keine Websites</td></tr>'}
  </tbody></table>

  <h2>Fehlgeschlagene Artikel</h2>
  <table><thead><tr><th>Titel</th><th>Fehler</th><th>Zeitpunkt</th></tr></thead><tbody>
    ${data.failures.map((a) => `<tr><td>${esc(a.title || a.keyword)}</td><td>${esc(a.error)}</td><td>${esc(a.updated_at)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="muted">keine Fehler</td></tr>'}
  </tbody></table>

  <h2>Protokoll (letzte ${data.logs.length} Einträge)</h2>
  <table><thead><tr><th>Zeit</th><th>Level</th><th>Bereich</th><th>Dauer</th><th>Meldung</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

module.exports = router;
