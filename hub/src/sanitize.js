'use strict';

// Erlaubte Tags fuer Artikel-HTML. Alles andere wird entfernt, damit niemals
// Skripte oder eingebettete Fremdinhalte in einen WordPress-Beitrag wandern.
const ALLOWED = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'blockquote',
  'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'code', 'pre', 'hr', 'figure', 'figcaption', 'img', 'span', 'div',
]);
const ALLOWED_ATTRS = { a: ['href', 'title', 'rel', 'target'], img: ['src', 'alt', 'title', 'width', 'height'] };
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|form|svg|noscript)\b[\s\S]*?<\/\1>/gi;

function sanitizeHtml(input) {
  let html = String(input || '');
  html = html.replace(DROP_WITH_CONTENT, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // <h1> gehoert dem WordPress-Theme (Beitragstitel) - auf <h2> herabstufen.
  html = html.replace(/<(\/?)h1\b([^>]*)>/gi, '<$1h2$2>');

  html = html.replace(/<\/?([a-zA-Z0-9-]+)((?:\s[^>]*)?)\/?>/g, (match, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED.has(tag)) return '';
    if (match.startsWith('</')) return `</${tag}>`;

    const allowedForTag = ALLOWED_ATTRS[tag] || [];
    const kept = [];
    const attrPattern = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr;
    while ((attr = attrPattern.exec(rawAttrs)) !== null) {
      const name = attr[1].toLowerCase();
      const value = attr[3] !== undefined ? attr[3] : attr[4];
      if (!allowedForTag.includes(name)) continue;
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(value)) continue;
      kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
    }
    const selfClosing = tag === 'br' || tag === 'hr' || tag === 'img';
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${selfClosing ? ' /' : ''}>`;
  });

  return html.replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeText(input, maxLength = 300) {
  return String(input || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = { sanitizeHtml, sanitizeText };
