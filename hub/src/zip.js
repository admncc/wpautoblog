'use strict';
const zlib = require('zlib');

/**
 * Kleiner ZIP-Schreiber ohne Fremdbibliothek.
 * Reicht genau fuer den Zweck: ein Plugin-Archiv erzeugen, das WordPress
 * einspielen kann. Erzeugt ein Standard-ZIP mit Deflate-Komprimierung.
 */

// CRC32, wie es die ZIP-Struktur je Datei verlangt.
const CRC_TABELLE = (() => {
  const tabelle = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabelle[i] = c;
  }
  return tabelle;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABELLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Zeitstempel im MS-DOS-Format, das ZIP erwartet. */
function dosZeit(datum) {
  const jahr = Math.max(1980, datum.getFullYear());
  return {
    zeit: (datum.getHours() << 11) | (datum.getMinutes() << 5) | (Math.floor(datum.getSeconds() / 2) & 0x1f),
    datum: ((jahr - 1980) << 9) | ((datum.getMonth() + 1) << 5) | datum.getDate(),
  };
}

/**
 * @param {Array<{name: string, data: Buffer, date?: Date}>} dateien
 *        name ist der Pfad im Archiv, mit Schraegstrichen.
 * @returns {Buffer}
 */
function erzeuge(dateien) {
  const lokal = [];
  const zentral = [];
  let offset = 0;

  for (const datei of dateien) {
    const name = Buffer.from(datei.name, 'utf8');
    const roh = datei.data;
    const komprimiert = zlib.deflateRawSync(roh, { level: 9 });
    const pruefsumme = crc32(roh);
    const { zeit, datum } = dosZeit(datei.date || new Date());

    const kopf = Buffer.alloc(30);
    kopf.writeUInt32LE(0x04034b50, 0);   // Signatur
    kopf.writeUInt16LE(20, 4);           // benoetigte Version
    kopf.writeUInt16LE(0x0800, 6);       // Flags: Dateinamen in UTF-8
    kopf.writeUInt16LE(8, 8);            // Verfahren: Deflate
    kopf.writeUInt16LE(zeit, 10);
    kopf.writeUInt16LE(datum, 12);
    kopf.writeUInt32LE(pruefsumme, 14);
    kopf.writeUInt32LE(komprimiert.length, 18);
    kopf.writeUInt32LE(roh.length, 22);
    kopf.writeUInt16LE(name.length, 26);
    kopf.writeUInt16LE(0, 28);           // keine Zusatzfelder

    lokal.push(kopf, name, komprimiert);

    const eintrag = Buffer.alloc(46);
    eintrag.writeUInt32LE(0x02014b50, 0);
    eintrag.writeUInt16LE(0x031e, 4);    // erzeugt unter Unix
    eintrag.writeUInt16LE(20, 6);
    eintrag.writeUInt16LE(0x0800, 8);
    eintrag.writeUInt16LE(8, 10);
    eintrag.writeUInt16LE(zeit, 12);
    eintrag.writeUInt16LE(datum, 14);
    eintrag.writeUInt32LE(pruefsumme, 16);
    eintrag.writeUInt32LE(komprimiert.length, 20);
    eintrag.writeUInt32LE(roh.length, 24);
    eintrag.writeUInt16LE(name.length, 28);
    eintrag.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);  // Dateirechte (Verschiebung ohne Vorzeichenfehler)
    eintrag.writeUInt32LE(offset, 42);
    zentral.push(eintrag, name);

    offset += kopf.length + name.length + komprimiert.length;
  }

  const verzeichnis = Buffer.concat(zentral);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0);
  ende.writeUInt16LE(dateien.length, 8);
  ende.writeUInt16LE(dateien.length, 10);
  ende.writeUInt32LE(verzeichnis.length, 12);
  ende.writeUInt32LE(offset, 16);

  return Buffer.concat([...lokal, verzeichnis, ende]);
}

module.exports = { erzeuge, crc32 };
