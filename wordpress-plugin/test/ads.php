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

echo empty($GLOBALS['schlecht']) ? "\nAlles gruen.\n" : "\nEs gab Fehler.\n";
exit(empty($GLOBALS['schlecht']) ? 0 : 1);
