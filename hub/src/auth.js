'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { APP_SECRET, SESSION_DAYS } = require('./config');
const { randomId, safeEqual } = require('./util');

const COOKIE = 'autoblog_session';

function createToken(userId) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${expires}`;
  const mac = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

function readToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts;
  const expected = crypto.createHmac('sha256', APP_SECRET).update(`${userId}.${expires}`).digest('hex');
  if (!safeEqual(mac, expected)) return null;
  if (Number(expires) < Date.now()) return null;
  return userId;
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function createUser(email, password) {
  const id = randomId('usr');
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(id, String(email).trim().toLowerCase(), bcrypt.hashSync(password, 12));
  return id;
}

function verifyLogin(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user) return null;
  return bcrypt.compareSync(password, user.password_hash) ? user : null;
}

function setPassword(email, password) {
  return db.prepare('UPDATE users SET password_hash = ? WHERE email = ?')
    .run(bcrypt.hashSync(password, 12), String(email).trim().toLowerCase()).changes;
}

/** Schuetzt alle /api/app/* Routen und das Frontend. */
function requireAuth(req, res, next) {
  const userId = readToken(req.cookies[COOKIE]);
  if (!userId) return res.status(401).json({ error: 'Nicht angemeldet' });
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet' });
  req.user = user;
  next();
}

module.exports = { COOKIE, createToken, readToken, requireAuth, userCount, createUser, verifyLogin, setPassword };
