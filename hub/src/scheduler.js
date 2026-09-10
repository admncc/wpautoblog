'use strict';
const cron = require('node-cron');
const { pruneLogs, LOG_RETENTION_DAYS } = require('./db');
const { logger } = require('./logger');
const service = require('./service');
const images = require('./images');
const youtube = require('./youtube');

let running = false;

function start() {
  // Alle 15 Minuten pruefen, ob ein Redaktionsplan faellig ist.
  cron.schedule('*/15 * * * *', async () => {
    if (running) {
      logger.warn('scheduler', 'skip', 'Vorheriger Durchlauf laeuft noch - dieser Takt wird uebersprungen');
      return;
    }
    running = true;
    const timer = logger.start('scheduler', 'tick', 'Zeitgesteuerter Durchlauf gestartet');
    try {
      const result = await service.runRecurring();
      timer.ok(`Durchlauf beendet (${result.plans} Plan/Plaene, ${result.produced} Post(s))`, { context: result });
    } catch (err) {
      timer.fail(err);
    } finally {
      running = false;
    }
  });

  // Stuendlich die faelligen YouTube-Kanaele pruefen und neue Videos abarbeiten.
  let videoLaeuft = false;
  cron.schedule('7 * * * *', async () => {
    if (!youtube.aktiv() || videoLaeuft) return;
    videoLaeuft = true;
    const timer = logger.start('youtube', 'cycle', 'Kanalpruefung gestartet');
    try {
      const gescannt = await youtube.runScan();
      const verarbeitet = await service.runVideoQueue(3);
      if (gescannt.kanaele || verarbeitet.verarbeitet) {
        timer.ok(`${gescannt.kanaele} Kanal/Kanaele geprueft, ${gescannt.neu} neue Videos, ${verarbeitet.verarbeitet} Artikel erzeugt`,
          { context: { ...gescannt, ...verarbeitet } });
      }
    } catch (err) {
      timer.fail(err);
    } finally {
      videoLaeuft = false;
    }
  });

  // Naechtliches Aufraeumen des Protokolls.
  cron.schedule('30 3 * * *', () => {
    const removed = pruneLogs();
    const verwaist = images.pruneOrphans();
    const alt = images.pruneVeroeffentlichte();
    logger.info('scheduler', 'prune',
      `Aufgeraeumt: ${removed} Protokolleintraege (aelter als ${LOG_RETENTION_DAYS} Tage), `
      + `${verwaist} verwaiste Bilddateien, ${alt} Bilder veroeffentlichter Artikel (aelter als ${images.AUFBEWAHRUNG_TAGE} Tage)`);
  });

  logger.info('scheduler', 'start',
    'Zeitplan aktiv: Redaktionsplaene alle 15 Minuten, YouTube-Kanaele stuendlich, Aufraeumen taeglich um 03:30 UTC');
}

module.exports = { start };
