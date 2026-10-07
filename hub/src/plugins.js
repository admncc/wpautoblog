'use strict';
const { db } = require('./db');
const { logger } = require('./logger');
const wp = require('./wp');
const pack = require('./pluginpack');
const { nacheinander } = require('./util');

const PARALLEL = 3;

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

/**
 * Bringt alle verbundenen Websites auf den Stand des Hubs.
 *
 * Angefasst wird nur, wer hinterherhinkt. Mehrere Websites laufen gleichzeitig,
 * aber nicht alle: Jede einzelne laedt dabei das Archiv beim Hub, und wenn zwanzig
 * Seiten das auf einmal tun, wartet am Ende jede auf jede.
 *
 * Eine Website, die nicht antwortet, beendet den Durchlauf nicht. Sie steht
 * hinterher in der Liste, mit dem Grund daneben.
 */
async function updateAlle(siteIds = null) {
  if (!pack.verfuegbar()) {
    return { geprueft: 0, aktualisiert: 0, fehler: 0, version: null, ergebnisse: [] };
  }

  const neueste = pack.version();
  const websites = db.prepare("SELECT * FROM sites WHERE status = 'connected'").all()
    .filter((site) => !siteIds || siteIds.includes(site.id));
  const rueckstaendig = websites.filter((site) => aelter(site.plugin_version, neueste));
  if (!rueckstaendig.length) {
    return { geprueft: websites.length, aktualisiert: 0, fehler: 0, version: neueste, ergebnisse: [] };
  }

  const reihe = nacheinander(PARALLEL);
  const ergebnisse = await Promise.all(rueckstaendig.map((site) => reihe(async () => {
    const vorher = site.plugin_version || 'unbekannt';
    try {
      const ergebnis = await wp.updatePlugin(site);
      const auf = String(ergebnis.version || neueste);
      db.prepare('UPDATE sites SET plugin_version = ? WHERE id = ?').run(auf, site.id);
      logger.info('site', 'plugin-update', `Plugin von ${vorher} auf ${auf} aktualisiert`, {
        siteId: site.id, context: { von: vorher, auf },
      });
      return { site_id: site.id, name: site.name, ok: true, von: vorher, auf };
    } catch (err) {
      logger.warn('site', 'plugin-update', `Plugin-Update fehlgeschlagen: ${err.message || err}`, {
        siteId: site.id, context: { von: vorher, auf: neueste },
      });
      return { site_id: site.id, name: site.name, ok: false, von: vorher, message: err.message || String(err) };
    }
  })));

  return {
    geprueft: websites.length,
    aktualisiert: ergebnisse.filter((e) => e.ok).length,
    fehler: ergebnisse.filter((e) => !e.ok).length,
    version: neueste,
    ergebnisse,
  };
}

module.exports = { aelter, updateAlle };
