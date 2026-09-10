'use strict';
const { logger } = require('./logger');

/**
 * Schutz gegen Passwort-Raten.
 *
 * Der Hub steht oeffentlich im Netz und hat genau ein Konto. Ohne Bremse waere
 * das Anmeldeformular die naheliegende Angriffsflaeche. Gezaehlt wird je IP und
 * je E-Mail; nach mehreren Fehlversuchen wird gesperrt, die Sperre waechst an.
 */
const VERSUCHE_BIS_SPERRE = 5;
const FENSTER_MS = 15 * 60 * 1000;
const MAX_SPERRE_MS = 60 * 60 * 1000;

const zaehler = new Map();

function schluessel(req) {
  const email = String((req.body && req.body.email) || '').toLowerCase().slice(0, 120);
  return `${req.ip}|${email}`;
}

function eintrag(key) {
  const jetzt = Date.now();
  const vorhanden = zaehler.get(key);
  if (!vorhanden || jetzt - vorhanden.zuletzt > FENSTER_MS) {
    const frisch = { fehlversuche: 0, zuletzt: jetzt, gesperrtBis: 0 };
    zaehler.set(key, frisch);
    return frisch;
  }
  return vorhanden;
}

/** Vor dem Passwortvergleich aufrufen. Liefert true, wenn geblockt wurde. */
function istGesperrt(req, res) {
  const daten = eintrag(schluessel(req));
  if (daten.gesperrtBis > Date.now()) {
    const sekunden = Math.ceil((daten.gesperrtBis - Date.now()) / 1000);
    logger.warn('auth', 'gesperrt', `Anmeldeversuch waehrend der Sperre abgewiesen (noch ${sekunden} s)`, {
      requestId: req.requestId,
      context: { ip: req.ip },
    });
    res.set('Retry-After', String(sekunden));
    res.status(429).json({
      error: `Zu viele Fehlversuche. Bitte ${sekunden > 90 ? `${Math.ceil(sekunden / 60)} Minuten` : `${sekunden} Sekunden`} warten.`,
    });
    return true;
  }
  return false;
}

/** Nach einem falschen Passwort aufrufen. */
function fehlversuch(req) {
  const daten = eintrag(schluessel(req));
  daten.fehlversuche += 1;
  daten.zuletzt = Date.now();

  if (daten.fehlversuche >= VERSUCHE_BIS_SPERRE) {
    // 1 Minute, 2, 4, 8 ... bis maximal eine Stunde.
    const stufe = daten.fehlversuche - VERSUCHE_BIS_SPERRE;
    const dauer = Math.min(60 * 1000 * Math.pow(2, stufe), MAX_SPERRE_MS);
    daten.gesperrtBis = Date.now() + dauer;
    logger.warn('auth', 'sperre', `Anmeldung gesperrt fuer ${Math.round(dauer / 1000)} s nach ${daten.fehlversuche} Fehlversuchen`, {
      requestId: req.requestId,
      context: { ip: req.ip },
    });
  }
}

/** Nach erfolgreicher Anmeldung aufrufen. */
function zuruecksetzen(req) {
  zaehler.delete(schluessel(req));
}

// Alte Eintraege regelmaessig entfernen, damit die Tabelle nicht waechst.
setInterval(() => {
  const grenze = Date.now() - FENSTER_MS;
  for (const [key, daten] of zaehler) {
    if (daten.zuletzt < grenze && daten.gesperrtBis < Date.now()) zaehler.delete(key);
  }
}, 10 * 60 * 1000).unref();

/**
 * Sicherheitskopfzeilen. Die Richtlinie verbietet fremde Skripte vollstaendig,
 * damit ein eingeschleustes Stueck HTML im Artikelvorschau-Bereich nichts ausrichten kann.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
}

module.exports = { istGesperrt, fehlversuch, zuruecksetzen, securityHeaders };
