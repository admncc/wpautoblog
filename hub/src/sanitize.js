'use strict';

/**
 * HTML-Filter fuer Artikelinhalte.
 *
 * Arbeitsweise: Der Text wird in Tags und Freitext zerlegt und aus den Bestandteilen
 * neu zusammengesetzt. Nur bekannte Tags mit bekannten Attributen ueberleben, alles
 * andere faellt weg. Dadurch koennen weder unbekannte Schreibweisen (svg mit
 * angehaengtem Schraegstrich) noch unvollstaendige Tags durchrutschen.
 */

const ALLOWED = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'blockquote',
  'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'code', 'pre', 'hr', 'figure', 'figcaption', 'img', 'span', 'div',
]);
const ALLOWED_ATTRS = { a: ['href', 'title', 'rel', 'target'], img: ['src', 'alt', 'title', 'width', 'height'] };
const SELF_CLOSING = new Set(['br', 'hr', 'img']);
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|form|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi;

/** Entities aufloesen, damit eine maskierte Schreibweise nicht als harmlos durchgeht. */
function decodeEntities(value) {
  const benannt = { amp: '&', colon: ':', tab: ' ', newline: ' ', lt: '<', gt: '>', quot: '"', apos: "'", sol: '/' };
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dez) => String.fromCodePoint(parseInt(dez, 10)))
    .replace(/&([a-z]+);?/gi, (treffer, name) => {
      const wert = benannt[name.toLowerCase()];
      return wert === undefined ? treffer : wert;
    });
}

/** Adressen mit ausfuehrbarem Schema abweisen. */
function unsafeUrl(value) {
  // Leerraum und Steuerzeichen entfernen, Browser ignorieren sie vor dem Schema.
  const blank = decodeEntities(value)
    .replace(/[\s\u0000-\u001f\u007f]/g, '')
    .toLowerCase();
  return /^(?:javascript|data|vbscript|file|about):/.test(blank);
}

const escapeText = (text) => String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Baut ein einzelnes Tag neu auf oder verwirft es. */
function rebuildTag(raw) {
  const teile = raw.match(/^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)\/?\s*>$/);
  if (!teile) return '';

  const schliessend = teile[1] === '/';
  let tag = teile[2].toLowerCase();
  // h1 gehoert dem WordPress-Theme (Beitragstitel), daher herabstufen.
  if (tag === 'h1') tag = 'h2';
  if (!ALLOWED.has(tag)) return '';
  if (schliessend) return SELF_CLOSING.has(tag) ? '' : `</${tag}>`;

  const erlaubt = ALLOWED_ATTRS[tag] || [];
  const behalten = [];
  // Nur Attribute in Anfuehrungszeichen; alles ohne wird verworfen.
  const attrRegex = /([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let attr;
  while ((attr = attrRegex.exec(teile[3])) !== null) {
    const name = attr[1].toLowerCase();
    const wert = attr[2] !== undefined ? attr[2] : attr[3];
    if (!erlaubt.includes(name)) continue;
    if ((name === 'href' || name === 'src') && unsafeUrl(wert)) continue;
    behalten.push(`${name}="${wert.replace(/"/g, '&quot;')}"`);
  }

  const inhalt = behalten.length ? ` ${behalten.join(' ')}` : '';
  return SELF_CLOSING.has(tag) ? `<${tag}${inhalt} />` : `<${tag}${inhalt}>`;
}

function sanitizeHtml(input) {
  let html = String(input || '');
  html = html.replace(DROP_WITH_CONTENT, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  let ausgabe = '';
  let position = 0;
  const tagRegex = /<[^>]*>/g;
  let treffer;
  while ((treffer = tagRegex.exec(html)) !== null) {
    ausgabe += escapeText(html.slice(position, treffer.index));
    ausgabe += rebuildTag(treffer[0]);
    position = tagRegex.lastIndex;
  }
  ausgabe += escapeText(html.slice(position));

  return ausgabe.replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeText(input, maxLength = 300) {
  return String(input || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = { sanitizeHtml, sanitizeText, unsafeUrl };
