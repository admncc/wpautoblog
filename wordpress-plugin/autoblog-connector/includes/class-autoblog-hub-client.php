<?php
if (!defined('ABSPATH')) { exit; }

/** Aufrufe von WordPress an den Autoblog Hub. */
class Autoblog_Hub_Client {

    /**
     * Signierter Aufruf beim Hub. Der Website-Token wird nie uebertragen,
     * sondern nur als Schluessel fuer die Signatur verwendet.
     *
     * @return array|WP_Error
     */
    public static function request($path, array $payload = [], $signed = true) {
        $settings = Autoblog_Settings::all();
        $hub_url  = $settings['hub_url'];
        if ($hub_url === '') {
            return new WP_Error('autoblog_no_hub', __('Es ist keine Hub-Adresse hinterlegt.', 'autoblog-connector'));
        }

        $body    = wp_json_encode($payload);
        $headers = ['Content-Type' => 'application/json'];

        if ($signed) {
            if ($settings['site_token'] === '' || $settings['site_id'] === '') {
                return new WP_Error('autoblog_no_token', __('Diese Website ist noch nicht mit dem Hub verbunden.', 'autoblog-connector'));
            }
            $timestamp = (string) time();
            $headers['X-WPAB-Site']      = $settings['site_id'];
            $headers['X-WPAB-Timestamp'] = $timestamp;
            $headers['X-WPAB-Signature'] = hash_hmac('sha256', $timestamp . "\n" . $body, $settings['site_token']);
        }

        $response = wp_remote_post($hub_url . '/api/plugin/' . $path, [
            'timeout'     => 30,
            'redirection' => 2,
            'headers'     => $headers,
            'body'        => $body,
            'user-agent'  => 'AutoblogConnector/' . AUTOBLOG_VERSION . '; ' . home_url('/'),
        ]);

        if (is_wp_error($response)) {
            Autoblog_Settings::update(['last_error' => $response->get_error_message()]);
            return $response;
        }

        $code = wp_remote_retrieve_response_code($response);
        $data = json_decode(wp_remote_retrieve_body($response), true);

        if (!is_array($data)) {
            $message = sprintf(
                /* translators: %d: HTTP-Statuscode */
                __('Unerwartete Antwort vom Hub (HTTP %d). Bitte die Hub-Adresse pruefen.', 'autoblog-connector'),
                $code
            );
            Autoblog_Settings::update(['last_error' => $message]);
            return new WP_Error('autoblog_bad_response', $message);
        }

        if ($code >= 400 || (isset($data['ok']) && $data['ok'] === false)) {
            $message = isset($data['message']) ? $data['message'] : __('Der Hub hat die Anfrage abgelehnt.', 'autoblog-connector');
            Autoblog_Settings::update(['last_error' => $message]);
            return new WP_Error('autoblog_hub_error', $message);
        }

        Autoblog_Settings::update(['last_contact' => current_time('mysql'), 'last_error' => '']);
        return $data;
    }

    /** Verbindung herstellen: Hub-Adresse und Website-Token pruefen. */
    public static function connect($hub_url, $token) {
        Autoblog_Settings::update([
            'hub_url'    => Autoblog_Settings::clean_url($hub_url),
            'site_token' => trim($token),
            'site_id'    => '',
        ]);

        $result = self::request('connect', [
            'token'          => trim($token),
            'site_url'       => home_url('/'),
            'wp_version'     => get_bloginfo('version'),
            'plugin_version' => AUTOBLOG_VERSION,
            'categories'     => Autoblog_Settings::categories(),
        ], false);

        if (is_wp_error($result)) {
            Autoblog_Settings::update(['site_id' => '', 'connected_at' => '']);
            return $result;
        }

        Autoblog_Settings::update([
            'site_id'      => isset($result['site_id']) ? $result['site_id'] : '',
            'site_name'    => isset($result['site_name']) ? $result['site_name'] : '',
            'hub_name'     => isset($result['hub_name']) ? $result['hub_name'] : '',
            'delivery'     => isset($result['delivery']) ? $result['delivery'] : 'push',
            'connected_at' => current_time('mysql'),
        ]);
        return $result;
    }

    /** Lebenszeichen an den Hub. */
    public static function heartbeat() {
        return self::request('heartbeat', [
            'site_url'   => home_url('/'),
            'categories' => Autoblog_Settings::categories(),
        ]);
    }

    /** Abhol-Modus: wartende Artikel holen. */
    public static function pending($limit = 3) {
        return self::request('pending', ['limit' => (int) $limit]);
    }

    /** Ergebnis einer Veroeffentlichung zurueckmelden. */
    public static function report($article_id, $result) {
        return self::request('result', array_merge(['article_id' => $article_id], $result));
    }

    public static function disconnect() {
        $result = self::request('disconnect', []);
        Autoblog_Settings::update(['site_token' => '', 'site_id' => '', 'connected_at' => '', 'site_name' => '']);
        return $result;
    }
}
