'use strict';
const cron = require('node-cron');
const { pruneLogs, LOG_RETENTION_DAYS } = require('./db');
const { logger } = require('./logger');
const service = require('./service');
const images = require('./images');

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

  // Naechtliches Aufraeumen des Protokolls.
  cron.schedule('30 3 * * *', () => {
    const removed = pruneLogs();
    const files = images.pruneOrphans();
    logger.info('scheduler', 'prune', `Aufgeraeumt: ${removed} Protokolleintraege aelter als ${LOG_RETENTION_DAYS} Tage, ${files} verwaiste Bilddateien`);
  });

  logger.info('scheduler', 'start', 'Zeitplan aktiv: Pruefung alle 15 Minuten, Aufraeumen taeglich um 03:30 UTC');
}

module.exports = { start };
