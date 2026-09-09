<?php
if (!defined('ABSPATH')) { exit; }

/** Speichert und liefert die Einstellungen des Plugins. */
class Autoblog_Settings {

    const OPTION = 'autoblog_settings';

    public static function defaults() {
        return [
            'hub_url'      => '',
            'site_token'   => '',
            'site_id'      => '',
            'site_name'    => '',
            'hub_name'     => '',
            'delivery'     => 'push',
            'connected_at' => '',
            'last_contact' => '',
            'last_error'   => '',
            'default_author' => 0,
        ];
    }

    public static function all() {
        $stored = get_option(self::OPTION, []);
        return wp_parse_args(is_array($stored) ? $stored : [], self::defaults());
    }

    public static function get($key, $fallback = '') {
        $all = self::all();
        return isset($all[$key]) ? $all[$key] : $fallback;
    }

    public static function update(array $values) {
        update_option(self::OPTION, array_merge(self::all(), $values), false);
    }

    public static function is_connected() {
        $all = self::all();
        return !empty($all['hub_url']) && !empty($all['site_token']) && !empty($all['site_id']);
    }

    /** Hub-Adresse normalisieren (ohne Schrägstrich am Ende). */
    public static function clean_url($url) {
        $url = trim((string) $url);
        if ($url === '') { return ''; }
        if (!preg_match('#^https?://#i', $url)) { $url = 'https://' . $url; }
        return untrailingslashit(esc_url_raw($url));
    }
}
