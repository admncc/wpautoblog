<?php
/**
 * Pruefungen fuer Autoblog_Ads. Aufruf: php wordpress-plugin/test/ads.php
 */
require __DIR__ . '/wp-attrappe.php';
$pfad = Autoblog_Ads::pfad();

function pruefe($bedingung, $text, $zusatz = '') {
    echo ($bedingung ? "  ok   " : "  FEHL ") . $text . ($zusatz ? " ($zusatz)" : '') . "\n";
    if (!$bedingung) { $GLOBALS['schlecht'] = true; }
}

$ausgang = "# Vermarkter\n"
    . "google.com, pub-1, DIRECT\n"
    . "google.com, pub-1, DIRECT, f08c47fec0942fa0\n"
    . "appnexus.com, 2, RESELLER\n"
    . "google.com, pub-1, RESELLER\n"
    . "appnexus.com, 2, RESELLER # Partner\n"
    . "CONTACT=werbung@beispiel.de\n"
    . "kaputt\n";
file_put_contents($pfad, $ausgang);

$ergebnis = Autoblog_Ads::entdoppeln();
pruefe(!is_wp_error($ergebnis), 'Entdoppeln laeuft durch', is_wp_error($ergebnis) ? $ergebnis->get_error_message() : '');
$danach = file_get_contents($pfad);
echo "--- danach ---\n$danach--------------\n";

pruefe(substr_count($danach, 'google.com, pub-1, DIRECT') === 1, 'Die doppelte DIRECT-Zeile ist weg');
pruefe(strpos($danach, 'f08c47fec0942fa0') !== false, 'Die vollstaendigere Zeile bleibt (mit Kennung)');
pruefe(strpos($danach, 'google.com, pub-1, RESELLER') !== false, 'Der Widerspruch DIRECT/RESELLER bleibt stehen');
pruefe(substr_count($danach, 'appnexus.com, 2, RESELLER') === 1
    && strpos($danach, '# Partner') !== false, 'Bei gleichem Stand gewinnt die Zeile mit Kommentar');
pruefe(strpos($danach, '# Vermarkter') !== false && strpos($danach, 'CONTACT=') !== false
    && strpos($danach, 'kaputt') !== false, 'Kommentar, Variable und unverstaendliche Zeile bleiben');

// Zweimal entdoppeln aendert nichts mehr.
Autoblog_Ads::entdoppeln();
pruefe(file_get_contents($pfad) === $danach, 'Ein zweiter Durchlauf aendert nichts');

// Und die Sicherung greift.
$zurueck = Autoblog_Ads::zurueck();
pruefe(!is_wp_error($zurueck) && file_get_contents($pfad) === $ausgang,
    'Der Stand vor dem Aufraeumen laesst sich zurueckholen');

// --- Variablen ergaenzen: OWNERDOMAIN und Verwandte -------------------------
/*
 * Der Punkt dieser Pruefungen: Eine Variable darf beim Ergaenzen nicht ein zweites
 * Mal in die Datei wandern. Der Hub traegt OWNERDOMAIN taeglich nach - stuende die
 * Zeile danach jedes Mal erneut drin, waere die Datei nach einer Woche unbrauchbar.
 */
file_put_contents($pfad, "# Vermarkter\ngoogle.com, pub-1, DIRECT\n");

$gesetzt = Autoblog_Ads::ergaenzen(['OWNERDOMAIN=maikikii.de']);
pruefe(!is_wp_error($gesetzt), 'OWNERDOMAIN laesst sich ergaenzen',
    is_wp_error($gesetzt) ? $gesetzt->get_error_message() : '');
$mitOwner = file_get_contents($pfad);
pruefe(substr_count($mitOwner, 'OWNERDOMAIN=maikikii.de') === 1, 'Die Zeile steht genau einmal drin');
pruefe(strpos($mitOwner, 'google.com, pub-1, DIRECT') !== false && strpos($mitOwner, '# Vermarkter') !== false,
    'Der bisherige Inhalt bleibt unangetastet');

Autoblog_Ads::ergaenzen(['OWNERDOMAIN=maikikii.de']);
pruefe(file_get_contents($pfad) === $mitOwner, 'Ein zweiter Durchlauf aendert nichts und haengt nichts an');

Autoblog_Ads::ergaenzen(['ownerdomain=maikikii.de']);
pruefe(substr_count(file_get_contents($pfad), 'maikikii.de') === 1,
    'Auch klein geschrieben gilt sie als dieselbe Angabe');

Autoblog_Ads::ergaenzen(['OWNERDOMAIN=andere.de']);
$geaendert = file_get_contents($pfad);
pruefe(substr_count($geaendert, 'OWNERDOMAIN=') === 1 && strpos($geaendert, 'OWNERDOMAIN=andere.de') !== false,
    'Ein anderer Wert ersetzt die vorhandene Zeile an ihrer Stelle');

// Mehrere Angaben auf einmal, dazu ein Eintrag: jede Sorte am richtigen Platz.
file_put_contents($pfad, "CONTACT=werbung@beispiel.de\ngoogle.com, pub-1, DIRECT\n");
Autoblog_Ads::ergaenzen([
    'OWNERDOMAIN=maikikii.de',
    'CONTACT=neu@beispiel.de',
    'openx.com, 5555, RESELLER',
]);
$gemischt = file_get_contents($pfad);
pruefe(substr_count($gemischt, 'CONTACT=') === 1 && strpos($gemischt, 'neu@beispiel.de') !== false,
    'Eine vorhandene Variable wird ersetzt, nicht verdoppelt');
pruefe(substr_count($gemischt, 'OWNERDOMAIN=maikikii.de') === 1 && strpos($gemischt, 'openx.com, 5555, RESELLER') !== false,
    'Neue Variablen und neue Eintraege kommen dazu');

echo empty($GLOBALS['schlecht']) ? "\nAlles gruen.\n" : "\nEs gab Fehler.\n";
exit(empty($GLOBALS['schlecht']) ? 0 : 1);
