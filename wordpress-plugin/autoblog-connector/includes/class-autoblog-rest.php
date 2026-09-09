<?php
if (!defined('ABSPATH')) { exit; }

/** REST-Endpunkte, ueber die der Hub Beitraege an diese Website sendet. */
class Autoblog_Rest {

    const NAMESPACE_ = 'wp-autoblog/v1';
    const MAX_SKEW   = 300; // Sekunden

    public static function init() {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
    }

    public static function register_routes() {
        $args = [
            'methods'             => 'POST',
            'permission_callback' => [__CLASS__, 'verify_request'],
        ];

        register_rest_route(self::NAMESPACE_, '/ping', array_merge($args, [
            'callback' => [__CLASS__, 'handle_ping'],
        ]));
        register_rest_route(self::NAMESPACE_, '/publish', array_merge($args, [
            'callback' => [__CLASS__, 'handle_publish'],
        ]));
    }

    /**
     * Prueft Zeitstempel und HMAC-Signatur des Hubs.
     * Ohne gueltige Signatur wird die Anfrage abgewiesen - es gibt keinen anderen Zugang.
     */
    public static function verify_request(WP_REST_Request $request) {
        $settings = Autoblog_Settings::all();
        if (!Autoblog_Settings::is_connected()) {
            return new WP_Error('autoblog_not_connected', __('Diese Website ist nicht mit einem Hub verbunden.', 'autoblog-connector'), ['status' => 403]);
        }

        $site      = $request->get_header('x_wpab_site');
        $timestamp = $request->get_header('x_wpab_timestamp');
        $signature = $request->get_header('x_wpab_signature');

        if (!$site || !$timestamp || !$signature) {
            return new WP_Error('autoblog_no_signature', __('Signatur fehlt.', 'autoblog-connector'), ['status' => 401]);
        }
        if (!hash_equals((string) $settings['site_id'], (string) $site)) {
            return new WP_Error('autoblog_wrong_site', __('Die Anfrage gehoert zu einer anderen Website.', 'autoblog-connector'), ['status' => 401]);
        }
        if (abs(time() - (int) $timestamp) > self::MAX_SKEW) {
            return new WP_Error('autoblog_expired', __('Zeitstempel abgelaufen. Bitte die Serverzeit pruefen.', 'autoblog-connector'), ['status' => 401]);
        }

        $expected = hash_hmac('sha256', $timestamp . "\n" . $request->get_body(), $settings['site_token']);
        if (!hash_equals($expected, (string) $signature)) {
            return new WP_Error('autoblog_bad_signature', __('Signatur ungueltig.', 'autoblog-connector'), ['status' => 401]);
        }

        Autoblog_Settings::update(['last_contact' => current_time('mysql')]);
        return true;
    }

    public static function handle_ping(WP_REST_Request $request) {
        return rest_ensure_response([
            'ok'             => true,
            'site_name'      => get_bloginfo('name'),
            'site_url'       => home_url('/'),
            'wp_version'     => get_bloginfo('version'),
            'plugin_version' => AUTOBLOG_VERSION,
            'delivery'       => Autoblog_Settings::get('delivery', 'push'),
        ]);
    }

    public static function handle_publish(WP_REST_Request $request) {
        $result = Autoblog_Publisher::publish((array) $request->get_json_params());

        if (is_wp_error($result)) {
            return new WP_REST_Response(['ok' => false, 'message' => $result->get_error_message()], 400);
        }
        return rest_ensure_response(array_merge(['ok' => true], $result));
    }
}
