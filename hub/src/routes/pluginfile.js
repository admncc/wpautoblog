'use strict';
const express = require('express');
const pack = require('./../pluginpack');
const { logger } = require('./../logger');

const router = express.Router();

/**
 * Liefert das Plugin-Archiv aus. Die Kennung in der Adresse ist signiert und
 * kurzlebig, damit WordPress ohne Anmeldung laden kann.
 */
router.get('/:kennung/autoblog-connector.zip', (req, res) => {
  const siteId = pack.pruefeDownload(req.params.kennung);
  if (!siteId) {
    logger.warn('plugin-paket', 'download', 'Abgelehnter Download-Versuch', {
      context: { ip: req.ip, kennung: String(req.params.kennung).slice(0, 20) },
    });
    return res.status(403).type('text/plain; charset=utf-8').send('Dieser Download-Link ist ungueltig oder abgelaufen.');
  }

  try {
    const paket = pack.paket();
    logger.info('plugin-paket', 'download', `Plugin ${paket.version} ausgeliefert`, {
      siteId,
      context: { bytes: paket.buffer.length },
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="autoblog-connector.zip"');
    res.setHeader('Content-Length', paket.buffer.length);
    res.send(paket.buffer);
  } catch (err) {
    logger.error('plugin-paket', 'download', `Archiv konnte nicht erzeugt werden: ${err.message}`, { siteId });
    res.status(500).type('text/plain; charset=utf-8').send('Das Plugin-Archiv konnte nicht erzeugt werden.');
  }
});

// Alles andere unter /plugin ist kein gueltiger Download.
router.use((req, res) =>
  res.status(404).type('text/plain; charset=utf-8').send('Kein Plugin-Archiv unter dieser Adresse.')
);

module.exports = router;
