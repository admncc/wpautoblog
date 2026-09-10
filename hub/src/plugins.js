'use strict';
const { db } = require('./db');
const { logger } = require('./logger');
const wp = require('./wp');
const pack = require('./pluginpack');

/**
 * Plugin-Updates fuer alle verbundenen Websites.
 *
 * Der Hub kennt die Version, die er im Archiv bereithaelt, und die Version, die
 * jede Website zuletzt gemeldet hat. Ist eine Website hinterher, stoesst der Hub
 * das Update dort an. Das Plugin laedt das Archiv beim Hub und tauscht sich selbst
 * aus. Geprueft wird einmal am Tag, oefter waere sinnlos: Eine neue Version gibt
 * es nur, wenn hier eine neue aufgespielt wurde.
 */

/** Vergleicht Versionsangaben wie 1.4.0 stellenweise. */
function aelter(vorhanden, neueste) {
  const zerlegen = (wert) => String(wert || '0').trim().split(/[.\-+]/).map((t) => parseInt(t, 10) || 0);
  const a = zerlegen(vorhanden);
  const b = zerlegen(neueste);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const links = a[i] || 0;
    const rechts = b[i] || 0;
    if (links !== rechts) return links < rechts;
  }
  return false;
}

async function updateAlle() {
  if (!pack.verfuegbar()) return { geprueft: 0, aktualisiert: 0, fehler: 0 };

  const neueste = pack.version();
  const websites = db.prepare("SELECT * FROM sites WHERE status = 'connected'").all();
  const rueckstaendig = websites.filter((site) => aelter(site.plugin_version, neueste));
  if (!rueckstaendig.length) return { geprueft: websites.length, aktualisiert: 0, fehler: 0, version: neueste };

  let aktualisiert = 0;
  let fehler = 0;
  for (const site of rueckstaendig) {
    const vorher = site.plugin_version || 'unbekannt';
    try {
      const ergebnis = await wp.updatePlugin(site);
      db.prepare('UPDATE sites SET plugin_version = ? WHERE id = ?').run(String(ergebnis.version || ''), site.id);
      aktualisiert += 1;
      logger.info('site', 'plugin-update', `Plugin von ${vorher} auf ${ergebnis.version || neueste} aktualisiert`, {
        siteId: site.id, context: { von: vorher, auf: ergebnis.version || neueste },
      });
    } catch (err) {
      fehler += 1;
      logger.warn('site', 'plugin-update', `Plugin-Update fehlgeschlagen: ${err.message || err}`, {
        siteId: site.id, context: { von: vorher, auf: neueste },
      });
    }
  }
  return { geprueft: websites.length, aktualisiert, fehler, version: neueste };
}

module.exports = { aelter, updateAlle };
