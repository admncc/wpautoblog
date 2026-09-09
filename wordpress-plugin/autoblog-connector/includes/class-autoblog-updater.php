<?php
if (!defined('ABSPATH')) { exit; }

/**
 * Plugin-Updates ueber den Autoblog Hub.
 *
 * Der Hub haelt immer das Archiv bereit, das zu seinem eigenen Stand passt.
 * Damit erscheint ein Update hier wie bei jedem anderen Plugin unter "Plugins",
 * laesst sich automatisch einspielen und kann zusaetzlich vom Hub angestossen werden.
 */
class Autoblog_Updater {

    const TRANSIENT = 'autoblog_update_info';
    const CACHE_STUNDEN = 6;

    public static function init() {
        add_filter('pre_set_site_transient_update_plugins', [__CLASS__, 'pruefe_update']);
        add_filter('plugins_api', [__CLASS__, 'plugin_details'], 20, 3);
        add_filter('auto_update_plugin', [__CLASS__, 'automatisch_aktualisieren'], 10, 2);
        add_filter('upgrader_source_selection', [__CLASS__, 'ordnername_korrigieren'], 10, 4);
    }

    private static function basename() {
        return plugin_basename(AUTOBLOG_FILE);
    }

    /** Fragt den Hub nach der neuesten Version, hoechstens alle sechs Stunden. */
    public static function hole_info($erzwingen = false) {
        if (!Autoblog_Settings::is_connected()) {
            return null;
        }
        if (!$erzwingen) {
            $zwischenspeicher = get_transient(self::TRANSIENT);
            if (is_array($zwischenspeicher)) {
                return $zwischenspeicher;
            }
        }

        $antwort = Autoblog_Hub_Client::request('update-check', [
            'installed_version' => AUTOBLOG_VERSION,
        ]);
        if (is_wp_error($antwort) || empty($antwort['version'])) {
            // Auch einen Fehlschlag kurz merken, damit nicht jeder Seitenaufruf fragt.
            set_transient(self::TRANSIENT, ['version' => null], 30 * MINUTE_IN_SECONDS);
            return null;
        }

        set_transient(self::TRANSIENT, $antwort, self::CACHE_STUNDEN * HOUR_IN_SECONDS);
        return $antwort;
    }

    /** Traegt ein verfuegbares Update in die Plugin-Liste von WordPress ein. */
    public static function pruefe_update($transient) {
        if (!is_object($transient)) {
            return $transient;
        }

        $info = self::hole_info();
        if (empty($info['version']) || empty($info['download_url'])) {
            return $transient;
        }

        $datei = self::basename();
        if (version_compare($info['version'], AUTOBLOG_VERSION, '>')) {
            $eintrag = (object) [
                'slug'         => 'autoblog-connector',
                'plugin'       => $datei,
                'new_version'  => $info['version'],
                'package'      => $info['download_url'],
                'url'          => Autoblog_Settings::get('hub_url'),
                'tested'       => isset($info['tested']) ? $info['tested'] : '',
                'requires'     => isset($info['requires']) ? $info['requires'] : '6.0',
                'requires_php' => isset($info['requires_php']) ? $info['requires_php'] : '7.4',
                'icons'        => [],
            ];
            $transient->response[$datei] = $eintrag;
            unset($transient->no_update[$datei]);
        } else {
            $transient->no_update[$datei] = (object) [
                'slug'        => 'autoblog-connector',
                'plugin'      => $datei,
                'new_version' => AUTOBLOG_VERSION,
                'package'     => '',
                'url'         => Autoblog_Settings::get('hub_url'),
            ];
        }

        return $transient;
    }

    /** Fuellt das Detailfenster, das WordPress beim Klick auf "Details" oeffnet. */
    public static function plugin_details($ergebnis, $aktion, $argumente) {
        if ($aktion !== 'plugin_information' || empty($argumente->slug) || $argumente->slug !== 'autoblog-connector') {
            return $ergebnis;
        }
        $info = self::hole_info();
        if (empty($info['version'])) {
            return $ergebnis;
        }

        return (object) [
            'name'          => 'Autoblog Connector',
            'slug'          => 'autoblog-connector',
            'version'       => $info['version'],
            'author'        => 'Autoblog Hub',
            'homepage'      => Autoblog_Settings::get('hub_url'),
            'download_link' => $info['download_url'],
            'requires'      => isset($info['requires']) ? $info['requires'] : '6.0',
            'requires_php'  => isset($info['requires_php']) ? $info['requires_php'] : '7.4',
            'tested'        => isset($info['tested']) ? $info['tested'] : '',
            'sections'      => [
                'description' => __('Verbindet diese Website mit dem Autoblog Hub. Die Aktualisierung kommt direkt von deinem Hub.', 'autoblog-connector'),
            ],
        ];
    }

    /** Automatische Updates, wenn in den Einstellungen aktiviert. */
    public static function automatisch_aktualisieren($aktualisieren, $element) {
        if (isset($element->plugin) && $element->plugin === self::basename()) {
            return (bool) Autoblog_Settings::get('auto_update', 1);
        }
        return $aktualisieren;
    }

    /**
     * Das Archiv enthaelt den Ordner "autoblog-connector". Sollte es einmal anders
     * heissen, wird der Ordner vor dem Einspielen passend umbenannt.
     */
    public static function ordnername_korrigieren($quelle, $entfernt, $upgrader, $extra = []) {
        if (empty($extra['plugin']) || $extra['plugin'] !== self::basename()) {
            return $quelle;
        }
        $gewuenscht = trailingslashit(dirname($quelle)) . 'autoblog-connector/';
        if ($quelle === $gewuenscht || !is_dir($quelle)) {
            return $quelle;
        }
        global $wp_filesystem;
        if ($wp_filesystem && $wp_filesystem->move($quelle, $gewuenscht)) {
            return $gewuenscht;
        }
        return $quelle;
    }

    /**
     * Spielt das Update sofort ein. Wird vom Hub angestossen.
     *
     * @return array|WP_Error
     */
    public static function jetzt_aktualisieren($download_url = '') {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';

        $vorher = AUTOBLOG_VERSION;

        if ($download_url === '') {
            $info = self::hole_info(true);
            if (empty($info['download_url'])) {
                return new WP_Error('autoblog_no_package', __('Der Hub hat kein Archiv angeboten.', 'autoblog-connector'));
            }
            $download_url = $info['download_url'];
        }

        delete_transient(self::TRANSIENT);
        delete_site_transient('update_plugins');

        $upgrader = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
        $ergebnis = $upgrader->install($download_url, ['overwrite_package' => true]);

        if (is_wp_error($ergebnis)) {
            return $ergebnis;
        }
        if ($ergebnis === false) {
            return new WP_Error('autoblog_update_failed', __('Das Update wurde nicht eingespielt.', 'autoblog-connector'));
        }

        // Das Plugin war waehrend des Austauschs aktiv und bleibt es auch.
        if (!is_plugin_active(self::basename())) {
            activate_plugin(self::basename());
        }

        $daten = get_plugin_data(AUTOBLOG_PATH . 'autoblog-connector.php', false, false);
        return [
            'from'    => $vorher,
            'version' => isset($daten['Version']) ? $daten['Version'] : $vorher,
        ];
    }
}
