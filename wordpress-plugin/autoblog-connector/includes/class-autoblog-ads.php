<?php
if (!defined('ABSPATH')) { exit; }

/**
 * Die ads.txt dieser Website lesen und schreiben.
 *
 * Die Datei gehoert ins Wurzelverzeichnis der Domain und sagt, welche Vermarkter
 * Werbeplaetze dieser Seite verkaufen duerfen. Steht dort etwas Falsches oder
 * fehlt ein Eintrag, verdient die Seite weniger - es ist also eine Datei, an der
 * man nicht blind herumschreibt.
 *
 * Deshalb zwei Wege:
 *
 * 1. Gibt es die Datei schon oder laesst sich das Verzeichnis beschreiben, wird
 *    die echte Datei gepflegt. Das ist der Normalfall und ueberlebt auch, wenn
 *    WordPress einmal nicht laeuft.
 * 2. Ist das Verzeichnis gesperrt (viele Hoster machen das), liefert WordPress
 *    die Datei selbst aus. Das funktioniert, weil eine Anfrage an /ads.txt bei
 *    fehlender Datei ohnehin bei WordPress landet.
 *
 * Vor jedem Schreiben wird der bisherige Inhalt gesichert. Ein falscher Klick
 * soll sich zurueckholen lassen.
 */
class Autoblog_Ads {

    const OPTION     = 'autoblog_ads_txt';        // Inhalt, wenn WordPress selbst ausliefert
    const BACKUP     = 'autoblog_ads_backup';     // Stand vor dem letzten Schreiben
    const MAX_BYTES  = 1048576;                   // 1 MB, weit mehr als jede echte ads.txt

    public static function init() {
        // Frueh einhaengen: Die Antwort soll keine Themes und keine Weiterleitungen sehen.
        add_action('init', [__CLASS__, 'vielleicht_ausliefern'], 0);
    }

    /** Wo die Datei liegen muesste. */
    public static function pfad() {
        return trailingslashit(ABSPATH) . 'ads.txt';
    }

    /**
     * Liegt WordPress im Wurzelverzeichnis der Domain?
     * Sonst landet die Datei unter /blog/ads.txt, und dort sucht sie niemand.
     */
    public static function im_wurzelverzeichnis() {
        $pfad = wp_parse_url(home_url('/'), PHP_URL_PATH);
        return ($pfad === null || $pfad === '' || $pfad === '/');
    }

    /** Laesst sich die echte Datei schreiben? */
    public static function schreibbar() {
        $datei = self::pfad();
        if (file_exists($datei)) {
            return is_writable($datei);
        }
        return is_writable(dirname($datei));
    }

    /** Der aktuelle Inhalt und woher er stammt. */
    public static function status() {
        $datei     = self::pfad();
        $vorhanden = file_exists($datei);
        $inhalt    = '';
        $modus     = 'leer';

        if ($vorhanden) {
            $gelesen = file_get_contents($datei);
            $inhalt  = ($gelesen === false) ? '' : $gelesen;
            $modus   = 'datei';
        } else {
            $gespeichert = (string) get_option(self::OPTION, '');
            if ($gespeichert !== '') {
                $inhalt = $gespeichert;
                $modus  = 'virtuell';
            }
        }

        $sicherung = get_option(self::BACKUP, []);

        return [
            'mode'        => $modus,
            'content'     => $inhalt,
            'path'        => $datei,
            'exists'      => $vorhanden,
            'writable'    => self::schreibbar(),
            'root'        => self::im_wurzelverzeichnis(),
            'url'         => home_url('/ads.txt'),
            'bytes'       => strlen($inhalt),
            'updated'     => (string) get_option(self::OPTION . '_at', ''),
            'backup_at'   => isset($sicherung['at']) ? (string) $sicherung['at'] : '',
            'has_backup'  => !empty($sicherung['content']),
            'digest'      => hash('sha256', $inhalt),
        ];
    }

    /**
     * Schreibt den neuen Inhalt. Erst die echte Datei, sonst der Weg ueber WordPress.
     *
     * @return array|WP_Error Status nach dem Schreiben.
     */
    public static function schreiben($inhalt) {
        $inhalt = (string) $inhalt;
        if (strlen($inhalt) > self::MAX_BYTES) {
            return new WP_Error('autoblog_ads_gross', __('Die ads.txt ist größer als 1 MB. Das ist keine ads.txt mehr.', 'autoblog-connector'));
        }

        // Zeilenenden vereinheitlichen und genau einen Umbruch am Ende.
        $inhalt = str_replace(["\r\n", "\r"], "\n", $inhalt);
        $inhalt = rtrim($inhalt, "\n");
        if ($inhalt !== '') {
            $inhalt .= "\n";
        }

        $vorher = self::status();
        self::sichern($vorher['content']);

        $datei = self::pfad();
        if (self::schreibbar()) {
            $geschrieben = file_put_contents($datei, $inhalt, LOCK_EX);
            if ($geschrieben === false) {
                return new WP_Error('autoblog_ads_schreiben', sprintf(
                    /* translators: %s: Dateipfad */
                    __('Die Datei %s ließ sich nicht schreiben.', 'autoblog-connector'),
                    $datei
                ));
            }
            // Ein frueherer virtueller Inhalt wuerde jetzt nur verwirren.
            delete_option(self::OPTION);
            update_option(self::OPTION . '_at', current_time('mysql'), false);
            clearstatcache(true, $datei);
            return self::status();
        }

        if (file_exists($datei)) {
            return new WP_Error('autoblog_ads_gesperrt', sprintf(
                /* translators: %s: Dateipfad */
                __('Die vorhandene Datei %s ist schreibgeschützt. Bitte die Rechte beim Hoster prüfen.', 'autoblog-connector'),
                $datei
            ));
        }

        update_option(self::OPTION, $inhalt, false);
        update_option(self::OPTION . '_at', current_time('mysql'), false);
        return self::status();
    }

    /**
     * Ergaenzt Zeilen, ohne Bestehendes anzufassen.
     *
     * Verglichen wird ueber Vermarkter-Domain und Konto-ID. Die Domain ist laut
     * Spezifikation unabhaengig von Gross- und Kleinschreibung, die Konto-ID nicht.
     * Was schon dasteht, bleibt genau so stehen - auch mit seinem Kommentar.
     *
     * @param array $zeilen Zeilen als Text, wie sie in der Datei stehen wuerden.
     * @return array|WP_Error
     */
    public static function ergaenzen(array $zeilen) {
        $status  = self::status();
        $inhalt  = $status['content'];
        $bekannt = self::schluessel_aus_text($inhalt);

        $neu = [];
        foreach ($zeilen as $zeile) {
            $zeile = trim((string) $zeile);
            if ($zeile === '') {
                continue;
            }
            $key = self::schluessel($zeile);
            if ($key !== '' && isset($bekannt[$key])) {
                continue;
            }
            if ($key !== '') {
                $bekannt[$key] = true;
            }
            $neu[] = $zeile;
        }

        if (empty($neu)) {
            return self::status();
        }

        $inhalt = rtrim($inhalt, "\n");
        if ($inhalt !== '') {
            $inhalt .= "\n";
        }
        return self::schreiben($inhalt . implode("\n", $neu) . "\n");
    }

    /** Entfernt Zeilen. Kommentare und Variablen bleiben unangetastet. */
    public static function entfernen(array $zeilen) {
        $raus = [];
        foreach ($zeilen as $zeile) {
            $key = self::schluessel((string) $zeile);
            if ($key !== '') {
                $raus[$key] = true;
            }
        }
        if (empty($raus)) {
            return self::status();
        }

        $status = self::status();
        $bleibt = [];
        foreach (preg_split('/\r\n|\r|\n/', $status['content']) as $zeile) {
            $key = self::schluessel($zeile);
            if ($key !== '' && isset($raus[$key])) {
                continue;
            }
            $bleibt[] = $zeile;
        }
        return self::schreiben(implode("\n", $bleibt));
    }

    /**
     * Der Schluessel einer Zeile: Vermarkter und Konto-ID.
     * Leer, wenn die Zeile kein Eintrag ist (Kommentar, Variable, Leerzeile).
     */
    private static function schluessel($zeile) {
        $zeile = (string) $zeile;
        $trenner = strpos($zeile, '#');
        if ($trenner !== false) {
            $zeile = substr($zeile, 0, $trenner);
        }
        $zeile = trim($zeile);
        if ($zeile === '' || strpos($zeile, ',') === false) {
            return '';
        }
        $felder = array_map('trim', explode(',', $zeile));
        if (count($felder) < 3 || $felder[0] === '' || $felder[1] === '') {
            return '';
        }
        return strtolower($felder[0]) . '|' . $felder[1];
    }

    private static function schluessel_aus_text($inhalt) {
        $gefunden = [];
        foreach (preg_split('/\r\n|\r|\n/', (string) $inhalt) as $zeile) {
            $key = self::schluessel($zeile);
            if ($key !== '') {
                $gefunden[$key] = true;
            }
        }
        return $gefunden;
    }

    /** Fingerabdruck des aktuellen Inhalts, damit der Hub nicht blind ueberschreibt. */
    public static function fingerabdruck($inhalt = null) {
        $status = ($inhalt === null) ? self::status() : ['content' => $inhalt];
        return hash('sha256', (string) $status['content']);
    }

    /** Den Stand vor dem letzten Schreiben zurueckholen. */
    public static function zurueck() {
        $sicherung = get_option(self::BACKUP, []);
        if (empty($sicherung) || !isset($sicherung['content'])) {
            return new WP_Error('autoblog_ads_keine_sicherung', __('Es gibt keinen früheren Stand.', 'autoblog-connector'));
        }
        return self::schreiben($sicherung['content']);
    }

    private static function sichern($inhalt) {
        update_option(self::BACKUP, [
            'content' => (string) $inhalt,
            'at'      => current_time('mysql'),
        ], false);
    }

    /**
     * Liefert die ads.txt aus, wenn es keine echte Datei gibt.
     *
     * Fehlt die Datei, leitet die .htaccess von WordPress die Anfrage an
     * index.php weiter - genau hier kommt sie dann an.
     */
    public static function vielleicht_ausliefern() {
        $gespeichert = (string) get_option(self::OPTION, '');
        if ($gespeichert === '') {
            return;
        }

        $angefragt = isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '';
        $pfad      = wp_parse_url($angefragt, PHP_URL_PATH);
        if (strtolower(untrailingslashit((string) $pfad)) !== '/ads.txt') {
            return;
        }

        nocache_headers();
        header('Content-Type: text/plain; charset=utf-8');
        header('X-Robots-Tag: noindex');
        echo $gespeichert; // phpcs:ignore WordPress.Security.EscapeOutput -- reiner Text, kein HTML
        exit;
    }

    /**
     * Ein Auftrag des Hubs, den diese Website im Abhol-Modus selbst ausfuehrt.
     * Im Sende-Modus ruft der Hub direkt an, dann wird das hier nicht gebraucht.
     *
     * @return array Rueckmeldung fuer den Hub.
     */
    public static function auftrag_ausfuehren(array $auftrag) {
        $aktion = isset($auftrag['action']) ? $auftrag['action'] : 'read';

        if ($aktion === 'write') {
            $ergebnis = self::schreiben(isset($auftrag['content']) ? $auftrag['content'] : '');
        } elseif ($aktion === 'add') {
            $ergebnis = self::ergaenzen(isset($auftrag['entries']) ? (array) $auftrag['entries'] : []);
        } elseif ($aktion === 'remove') {
            $ergebnis = self::entfernen(isset($auftrag['entries']) ? (array) $auftrag['entries'] : []);
        } elseif ($aktion === 'restore') {
            $ergebnis = self::zurueck();
        } else {
            $ergebnis = self::status();
        }

        if (is_wp_error($ergebnis)) {
            return ['ok' => false, 'message' => $ergebnis->get_error_message()];
        }
        return array_merge(['ok' => true], $ergebnis);
    }
}
