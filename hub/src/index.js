'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { log, pruneLogs } = require('./db');
const { logger, httpLogger } = require('./logger');
const guard = require('./guard');
const auth = require('./auth');
const settings = require('./settings');
const appRoutes = require('./routes/app');
const pluginRoutes = require('./routes/plugin');
const diagnosticsRoutes = require('./routes/diagnostics');
const mediaRoutes = require('./routes/media');
const pluginFileRoutes = require('./routes/pluginfile');
const scheduler = require('./scheduler');

// Wechselt bei jedem Start. Daran erkennt die Oberflaeche zuverlaessig,
// dass der Hub nach einem Update wirklich neu gestartet ist.
const BOOT_ID = require('crypto').randomBytes(8).toString('hex');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// rawBody wird fuer die Signaturpruefung der Plugin-Aufrufe benoetigt.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(cookieParser());
app.use(guard.securityHeaders);
app.use(httpLogger); // protokolliert jede Anfrage mit Dauer und Status

// ------------------------------------------------------------------- Login

app.get('/api/session', (req, res) => {
  const userId = auth.readToken(req.cookies[auth.COOKIE]);
  res.json({
    authenticated: Boolean(userId),
    needsSetup: auth.userCount() === 0,
    hubName: settings.get('hub_name'),
    version: config.VERSION,
  });
});

app.post('/api/setup', (req, res) => {
  if (auth.userCount() > 0) return res.status(400).json({ error: 'Es existiert bereits ein Konto.' });
  const { email, password } = req.body;
  if (!email || !/.+@.+\..+/.test(String(email))) return res.status(400).json({ error: 'Bitte eine gueltige E-Mail angeben.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Das Passwort braucht mindestens 8 Zeichen.' });

  const id = auth.createUser(email, password);
  res.cookie(auth.COOKIE, auth.createToken(id), cookieOptions(req));
  logger.info('auth', 'setup', `Konto angelegt: ${email}`, { requestId: req.requestId });
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  if (guard.istGesperrt(req, res)) return;

  const user = auth.verifyLogin(req.body.email, req.body.password || '');
  if (!user) {
    logger.warn('auth', 'login', `Fehlgeschlagener Anmeldeversuch fuer ${String(req.body.email || '').slice(0, 60)}`, {
      requestId: req.requestId,
      context: { ip: req.ip },
    });
    guard.fehlversuch(req);
    return res.status(401).json({ error: 'E-Mail oder Passwort ist falsch.' });
  }
  guard.zuruecksetzen(req);
  res.cookie(auth.COOKIE, auth.createToken(user.id), cookieOptions(req));
  logger.info('auth', 'login', `Anmeldung: ${user.email}`, { requestId: req.requestId, context: { ip: req.ip } });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(auth.COOKIE);
  res.json({ ok: true });
});

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: config.SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

// ------------------------------------------------------------------ Routen

app.use('/plugin', pluginFileRoutes);         // Plugin-Archiv fuer WordPress-Updates
app.use('/media', mediaRoutes);               // erzeugte Bilder (Token in der Adresse)
app.use('/diagnose', diagnosticsRoutes);      // Diagnose per Einmal-Token (ohne Anmeldung)
app.use('/api/plugin', pluginRoutes);          // Schnittstelle fuer das WordPress-Plugin
app.use('/api/app', auth.requireAuth, appRoutes); // Oberflaeche (nur angemeldet)

app.get('/health', (req, res) =>
  res.json({ ok: true, version: config.VERSION, boot: BOOT_ID, uptime: Math.round(process.uptime()) })
);

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unbekannter Endpunkt.' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Zentrale Fehlerbehandlung: nie einen Stacktrace an den Browser geben.
app.use((err, req, res, _next) => {
  const status = err.status || (err.name === 'AiError' || err.constructor.name === 'AiError' ? 400 : 500);
  logger[status >= 500 ? 'error' : 'warn']('http', 'error', `${req.method} ${req.path}: ${err.message}`, {
    requestId: req.requestId,
    status,
    context: { stack: String(err.stack || '').slice(0, 1500) },
  });
  res.status(status).json({ error: err.message || 'Unerwarteter Fehler.' });
});

// Ein unbehandelter Fehler soll im Protokoll landen, bevor der Prozess endet.
// Docker startet den Container danach neu, die Ursache bleibt nachlesbar.
process.on('unhandledRejection', (grund) => {
  logger.error('system', 'unhandledRejection', `Unbehandelter Fehler: ${(grund && grund.message) || grund}`, {
    context: { stack: String((grund && grund.stack) || '').slice(0, 1500) },
  });
});
process.on('uncaughtException', (err) => {
  logger.error('system', 'uncaughtException', `Schwerer Fehler, der Hub beendet sich: ${err.message}`, {
    context: { stack: String(err.stack || '').slice(0, 1500) },
  });
  process.exit(1);
});

const server = app.listen(config.PORT, config.HOST, () => {
  pruneLogs();
  logger.info('system', 'start', `Autoblog Hub laeuft auf http://localhost:${config.PORT}`, {
    context: { node: process.version, public_url: config.PUBLIC_URL || null, data_dir: config.DATA_DIR },
  });
  if (!config.PUBLIC_URL) {
    console.log('Hinweis: PUBLIC_URL ist nicht gesetzt. Sie wird im WordPress-Plugin als Hub-Adresse benoetigt.');
  }
  scheduler.start();
});

// Beim Stoppen laufende Anfragen zu Ende bringen, statt sie abzuschneiden.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info('system', 'stop', `${signal} empfangen, Hub faehrt herunter`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
