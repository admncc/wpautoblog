'use strict';
const crypto = require('crypto');
const { APP_SECRET } = require('./config');

const KEY = crypto.createHash('sha256').update(String(APP_SECRET)).digest();

function randomId(prefix, bytes = 12) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

/** Token einer Website - wird im Hub angezeigt und ins WordPress-Plugin kopiert. */
function siteToken() {
  return `wpab_${crypto.randomBytes(24).toString('base64url')}`;
}

function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Signatur, mit der sich Hub und Plugin gegenseitig ausweisen. */
function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret)).update(`${timestamp}\n${body}`).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'artikel';
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function countWords(html) {
  const text = stripHtml(html);
  return text ? text.split(' ').length : 0;
}

function normalizeUrl(url) {
  let value = String(url || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, '');
}

module.exports = { randomId, siteToken, encrypt, decrypt, sign, safeEqual, slugify, stripHtml, countWords, normalizeUrl };
