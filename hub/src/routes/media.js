'use strict';
const fs = require('fs');
const express = require('express');
const { db } = require('./../db');
const images = require('./../images');
const { logger } = require('./../logger');

const router = express.Router();

/**
 * Liefert ein erzeugtes Bild aus. Der Zugang laeuft ueber einen nicht erratbaren
 * Token in der Adresse, damit WordPress das Bild ohne Anmeldung abholen kann.
 */
router.get('/:token', (req, res) => {
  const image = db.prepare("SELECT * FROM images WHERE token = ? AND status = 'ready'").get(req.params.token);
  if (!image || !image.file) {
    return res.status(404).type('text/plain; charset=utf-8').send('Bild nicht gefunden.');
  }

  const file = images.filePath(image);
  if (!fs.existsSync(file)) {
    logger.warn('image', 'serve', 'Bilddatei fehlt auf der Festplatte', {
      articleId: image.article_id,
      context: { file: image.file },
    });
    return res.status(404).type('text/plain; charset=utf-8').send('Bilddatei fehlt.');
  }

  res.setHeader('Content-Type', image.mime || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', `inline; filename="${image.id}.${(image.mime || 'image/png').split('/')[1]}"`);
  fs.createReadStream(file).pipe(res);
});

module.exports = router;
