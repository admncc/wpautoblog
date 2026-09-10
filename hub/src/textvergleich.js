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

module.exports = { pruefeUebernahme, woerter, KETTE, GRENZE_ANTEIL, GRENZE_PASSAGE };
