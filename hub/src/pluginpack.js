'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');
const { logger } = require('./logger');
const { safeEqual } = require('./util');
const { ROOT, APP_SECRET, PUBLIC_URL } = require('./config');

/**
 * Packt das WordPress-Plugin aus dem Repository zu einem Archiv.
 * Damit kann der Hub den Plugin-Update-Dienst fuer alle verbundenen Websites
 * spielen: Wird der Hub aktualisiert, ist auch das Plugin auf dem neuen Stand.
 */
const PLUGIN_DIR = process.env.PLUGIN_DIR || path.join(ROOT, '..', 'wordpress-plugin', 'autoblog-connector');
const ORDNERNAME = 'autoblog-connector';
const DOWNLOAD_GUELTIG_MINUTEN = 30;

let zwischenspeicher = null;   // { signatur, buffer, version }

const verfuegbar = () => fs.existsSync(path.join(PLUGIN_DIR, `${ORDNERNAME}.php`));

/** Alle Dateien des Plugins einsammeln. */
function dateienSammeln(verzeichnis = PLUGIN_DIR, praefix = ORDNERNAME) {
  const gefunden = [];
  for (const eintrag of fs.readdirSync(verzeichnis, { withFileTypes: true })) {
    if (eintrag.name.startsWith('.')) continue;
    const voll = path.join(verzeichnis, eintrag.name);
    const imArchiv = `${praefix}/${eintrag.name}`;
    if (eintrag.isDirectory()) gefunden.push(...dateienSammeln(voll, imArchiv));
    else gefunden.push({ name: imArchiv, data: fs.readFileSync(voll), date: fs.statSync(voll).mtime });
  }
  return gefunden;
}

/** Version aus dem Kopf der Haupt-PHP-Datei. */
function version() {
  if (!verfuegbar()) return null;
  const kopf = fs.readFileSync(path.join(PLUGIN_DIR, `${ORDNERNAME}.php`), 'utf8').slice(0, 4000);
  const treffer = kopf.match(/^\s*\*\s*Version:\s*(.+)$/mi);
  return treffer ? treffer[1].trim() : null;
}

/** Archiv erzeugen, solange sich nichts geaendert hat aus dem Zwischenspeicher. */
function paket() {
  if (!verfuegbar()) throw new Error('Die Plugin-Dateien liegen nicht neben dem Hub.');

  const dateien = dateienSammeln();
  const signatur = crypto
    .createHash('sha256')
    .update(dateien.map((d) => `${d.name}:${d.data.length}:${d.date.getTime()}`).join('|'))
    .digest('hex');

  if (zwischenspeicher && zwischenspeicher.signatur === signatur) return zwischenspeicher;

  const buffer = zip.erzeuge(dateien);
  zwischenspeicher = { signatur, buffer, version: version(), dateien: dateien.length };
  logger.info('plugin-paket', 'build', `Plugin-Archiv erzeugt: Version ${zwischenspeicher.version}, ${dateien.length} Dateien, ${Math.round(buffer.length / 1024)} kB`);
  return zwischenspeicher;
}

/**
 * Kurzlebige Download-Adresse. WordPress laedt das Archiv damit ohne Anmeldung,
 * der Link gilt aber nur eine halbe Stunde und nur fuer diese eine Website.
 */
function downloadUrl(siteId, basis = '') {
  const ablauf = Date.now() + DOWNLOAD_GUELTIG_MINUTEN * 60 * 1000;
  const nutzlast = `${siteId}.${ablauf}`;
  const mac = crypto.createHmac('sha256', APP_SECRET).update(`plugin:${nutzlast}`).digest('hex').slice(0, 32);
  const wurzel = (PUBLIC_URL || basis || '').replace(/\/+$/, '');
  return `${wurzel}/plugin/${nutzlast}.${mac}/${ORDNERNAME}.zip`;
}

function pruefeDownload(kennung) {
  const teile = String(kennung || '').split('.');
  if (teile.length !== 3) return false;
  const [siteId, ablauf, mac] = teile;
  if (Number(ablauf) < Date.now()) return false;
  const erwartet = crypto.createHmac('sha256', APP_SECRET).update(`plugin:${siteId}.${ablauf}`).digest('hex').slice(0, 32);
  // safeEqual faengt abweichende Laengen ab; timingSafeEqual wuerde dabei werfen.
  return safeEqual(mac, erwartet) ? siteId : false;
}

module.exports = { verfuegbar, version, paket, downloadUrl, pruefeDownload, PLUGIN_DIR, ORDNERNAME };
