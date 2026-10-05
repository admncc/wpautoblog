'use strict';

/**
 * Prueft, wie viel Wortlaut ein Artikel aus seiner Quelle uebernommen hat.
 *
 * Verglichen werden Wortketten fester Laenge. Taucht eine Kette aus dem Artikel
 * genauso im Transkript auf, gilt sie als uebernommen. Einzelne Treffer sind normal
 * und unvermeidbar: Fachbegriffe, Modellnamen und gaengige Wendungen stehen in beiden
 * Texten. Auffaellig wird es erst, wenn viele Ketten treffen oder eine lange Passage
 * am Stueck uebereinstimmt. Genau dann ist es keine eigene Formulierung mehr.
 */
const KETTE = 8;              // Wortlaenge einer verglichenen Kette
const GRENZE_ANTEIL = 0.04;   // ab 4 Prozent uebereinstimmender Ketten wird gewarnt
const GRENZE_PASSAGE = 25;    // oder wenn 25 Woerter am Stueck gleich sind

/** Text auf reine Kleinbuchstaben-Woerter herunterbrechen. */
function woerter(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .replace(/[^a-zäöüß0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/*
 * Woerter, die ein Thema nicht unterscheiden. Ohne sie waeren
 * "Kaffeemaschine entkalken" und "Wasserkocher entkalken" zu aehnlich, weil beide
 * aus zwei Woertern bestehen und eines davon gleich ist.
 */
const FUELLWOERTER = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'auch', 'als', 'wie', 'was', 'wer', 'wo', 'wann', 'warum', 'wieso',
  'fuer', 'für', 'mit', 'ohne', 'von', 'vom', 'zu', 'zum', 'zur', 'im', 'in', 'am', 'an', 'auf',
  'bei', 'aus', 'nach', 'ueber', 'über', 'unter', 'vor', 'ist', 'sind', 'war', 'wird', 'werden',
  'man', 'sich', 'so', 'nicht', 'kein', 'keine', 'mehr', 'alle', 'alles', 'beim', 'ins',
  'the', 'and', 'for', 'with', 'how', 'what', 'your', 'you',
]);

/**
 * Wie nah sind sich zwei Themen?
 *
 * Verglichen werden die bedeutungstragenden Woerter, nicht die Zeichenfolge:
 * "Kaffeemaschine richtig entkalken" und "So entkalkst du die Kaffeemaschine" sind
 * dasselbe Thema in anderen Worten, und genau das soll auffallen. Gemessen wird der
 * Anteil gemeinsamer Woerter am kuerzeren der beiden - sonst wuerde ein langer Titel
 * jeden kurzen schlucken.
 *
 * @returns {number} 0 (nichts gemeinsam) bis 1 (dieselben Woerter)
 */
function themenNaehe(a, b) {
  const kern = (text) => [...new Set(woerter(text).filter((w) => w.length > 2 && !FUELLWOERTER.has(w)))];
  const x = kern(a);
  const y = kern(b);
  if (!x.length || !y.length) return 0;

  let gemeinsam = 0;
  for (const wort of x) if (y.some((anderes) => gleichesWort(wort, anderes))) gemeinsam += 1;
  return gemeinsam / Math.min(x.length, y.length);
}

/**
 * Zwei Woerter, die dasselbe meinen.
 *
 * Deutsch beugt kraeftig: "entkalken", "entkalkst", "entkalkt". Ein Vergleich auf
 * Gleichheit wuerde diese drei fuer drei verschiedene Themen halten. Zwei grobe
 * Regeln genuegen hier - die ersten fuenf Buchstaben, und ein Wort, das im anderen steckt
 * ("drucken" in "ausdrucken"). Keine Sprachwissenschaft, aber es haelt
 * Wiederholungen auseinander, und nur darum geht es.
 */
function gleichesWort(a, b) {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)) return true;
  if (a.length >= 5 && b.includes(a)) return true;
  if (b.length >= 5 && a.includes(b)) return true;
  return false;
}

/**
 * Gibt es dieses Thema schon?
 * Liefert den aehnlichsten Treffer samt Wert, oder null.
 */
function schonDagewesen(thema, bisherige, grenze = 0.7) {
  let bester = null;
  for (const alt of bisherige) {
    const naehe = themenNaehe(thema, alt);
    if (naehe >= grenze && (!bester || naehe > bester.naehe)) bester = { thema: alt, naehe };
  }
  return bester;
}

function pruefeUebernahme(artikel, quelle) {
  const a = woerter(artikel);
  const q = woerter(quelle);
  const leer = { anteil: 0, passage: 0, stelle: '', auffaellig: false, woerter: a.length };
  if (a.length < KETTE || q.length < KETTE) return leer;

  const ausQuelle = new Set();
  for (let i = 0; i + KETTE <= q.length; i += 1) ausQuelle.add(q.slice(i, i + KETTE).join(' '));

  let treffer = 0;
  let laufend = 0;
  let laengste = 0;
  let endeDerLaengsten = -1;
  for (let i = 0; i + KETTE <= a.length; i += 1) {
    if (ausQuelle.has(a.slice(i, i + KETTE).join(' '))) {
      treffer += 1;
      laufend += 1;
      if (laufend > laengste) {
        laengste = laufend;
        endeDerLaengsten = i;
      }
    } else {
      laufend = 0;
    }
  }

  const ketten = a.length - KETTE + 1;
  const anteil = treffer / ketten;
  // Eine Kette deckt KETTE Woerter ab, jede weitere im Lauf genau eines mehr.
  const passage = laengste ? laengste + KETTE - 1 : 0;
  const stelle = laengste
    ? a.slice(endeDerLaengsten - laengste + 1, endeDerLaengsten + KETTE).join(' ').slice(0, 240)
    : '';

  return {
    anteil,
    passage,
    stelle,
    woerter: a.length,
    auffaellig: anteil >= GRENZE_ANTEIL || passage >= GRENZE_PASSAGE,
  };
}

module.exports = {
  pruefeUebernahme, woerter, themenNaehe, schonDagewesen,
  KETTE, GRENZE_ANTEIL, GRENZE_PASSAGE,
};
