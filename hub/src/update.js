'use strict';
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const config = require('./config');

/**
 * System-Update.
 *
 * Der Hub laeuft im Container und darf den Server bewusst nicht selbst steuern.
 * Stattdessen tauscht er mit einem kleinen Helfer-Dienst auf dem Host Dateien aus:
 *   update-request  -> vom Hub geschrieben, "bitte aktualisieren"
 *   state.json      -> vom Helfer geschrieben, aktueller Stand und Zeitstempel
 *   version.json    -> vom Helfer nach jedem Update geschrieben
 */
const CONTROL_DIR = process.env.CONTROL_DIR || '/control';
const REQUEST_FILE = path.join(CONTROL_DIR, 'update-request');
const STATE_FILE = path.join(CONTROL_DIR, 'state.json');
const VERSION_FILE = path.join(CONTROL_DIR, 'version.json');

// Meldet sich der Helfer laenger nicht, gilt er als nicht eingerichtet.
const RUNNER_TIMEOUT_MS = 5 * 60 * 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function controlAvailable() {
  try {
    return fs.existsSync(CONTROL_DIR) && fs.statSync(CONTROL_DIR).isDirectory();
  } catch {
    return false;
  }
}

function status() {
  const state = readJson(STATE_FILE) || {};
  const version = readJson(VERSION_FILE) || {};
  const heartbeat = state.checked_at ? new Date(state.checked_at).getTime() : 0;
  const runnerAlive = Boolean(heartbeat) && Date.now() - heartbeat < RUNNER_TIMEOUT_MS;

  return {
    // Version des laufenden Codes
    version: config.VERSION,
    commit: version.commit || state.local_commit || null,
    commitShort: (version.commit || state.local_commit || '').slice(0, 7) || null,
    branch: state.branch || null,
    message: version.message || null,
    // Wann dieser Stand aufgespielt wurde
    deployedAt: version.deployed_at || null,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    // Stand des Helfer-Dienstes
    runnerInstalled: controlAvailable() && Boolean(heartbeat),
    runnerAlive,
    lastCheck: state.checked_at || null,
    updateAvailable: Boolean(state.update_available),
    remoteCommitShort: (state.remote_commit || '').slice(0, 7) || null,
    behind: Number(state.behind) || 0,
    busy: state.status === 'running',
    upToDate: state.status === 'aktuell',
    lastResult: state.status || null,
    lastError: state.error || null,
    finishedAt: state.finished_at || null,
  };
}

/** Legt die Anforderung ab. Der Helfer holt sie sich innerhalb weniger Sekunden. */
function request(user) {
  if (!controlAvailable()) {
    throw new Error(
      'Der Update-Helfer ist auf dem Server nicht eingerichtet. Einmalig ausfuehren: sudo ./ops/install-updater.sh'
    );
  }
  const current = status();
  if (current.busy) throw new Error('Es laeuft bereits ein Update.');

  fs.writeFileSync(REQUEST_FILE, JSON.stringify({ requested_at: new Date().toISOString(), by: user || '' }));
  logger.warn('update', 'request', 'System-Update angefordert', {
    context: { by: user || null, from: current.commitShort, to: current.remoteCommitShort },
  });
  return { ok: true, message: 'Update gestartet. Der Hub startet dabei neu, das dauert ein bis zwei Minuten.' };
}

module.exports = { status, request, CONTROL_DIR };
