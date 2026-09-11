/* Laeuft vor dem Stylesheet, damit beim Laden nicht kurz die helle Fassung
   aufblitzt. Bewusst eine eigene Datei: Die Sicherheitsrichtlinie erlaubt keine
   Skripte im Seitentext. */
(function () {
  var wunsch = 'auto';
  try {
    wunsch = localStorage.getItem('hub-theme') || 'auto';
  } catch (e) { /* privater Modus */ }
  var dunkel = wunsch === 'dark'
    || (wunsch === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dunkel ? 'dark' : 'light');
})();
