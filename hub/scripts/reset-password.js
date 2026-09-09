'use strict';
// Passwort zuruecksetzen, falls die Anmeldung nicht mehr moeglich ist:
//   npm run reset-password -- meine@mail.de neuesPasswort
const auth = require('../src/auth');
const { db } = require('../src/db');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Aufruf: npm run reset-password -- <e-mail> <neues-passwort>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Das Passwort braucht mindestens 8 Zeichen.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  auth.setPassword(email, password);
  console.log(`Passwort fuer ${email} wurde geaendert.`);
} else {
  auth.createUser(email, password);
  console.log(`Konto ${email} wurde angelegt.`);
}
