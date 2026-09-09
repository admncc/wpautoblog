<?php
if (!defined('ABSPATH')) { exit; }

/**
 * Regelmaessige Aufgaben:
 * - Lebenszeichen an den Hub
 * - im Abhol-Modus: wartende Artikel holen und veroeffentlichen
 */
class Autoblog_Cron {

    const HOOK = 'autoblog_poll_event';

    public static function init() {
        add_filter('cron_schedules', [__CLASS__, 'add_schedule']);
        add_action(self::HOOK, [__CLASS__, 'run']);

        // Falls das Ereignis fehlt (z. B. nach einem Import), neu einplanen.
        if (Autoblog_Settings::is_connected() && !wp_next_scheduled(self::HOOK)) {
            wp_schedule_event(time() + 60, 'autoblog_fifteen_minutes', self::HOOK);
        }
    }

    public static function add_schedule($schedules) {
        $schedules['autoblog_fifteen_minutes'] = [
            'interval' => 15 * MINUTE_IN_SECONDS,
            'display'  => __('Alle 15 Minuten (Autoblog)', 'autoblog-connector'),
        ];
        return $schedules;
    }

    public static function activate() {
        if (!wp_next_scheduled(self::HOOK)) {
            wp_schedule_event(time() + 60, 'autoblog_fifteen_minutes', self::HOOK);
        }
    }

    public static function deactivate() {
        $timestamp = wp_next_scheduled(self::HOOK);
        if ($timestamp) {
            wp_unschedule_event($timestamp, self::HOOK);
        }
    }

    public static function run() {
        if (!Autoblog_Settings::is_connected()) {
            return;
        }

        $heartbeat = Autoblog_Hub_Client::heartbeat();
        if (is_wp_error($heartbeat)) {
            return;
        }
        if (isset($heartbeat['delivery'])) {
            Autoblog_Settings::update(['delivery' => $heartbeat['delivery']]);
        }

        // Im Sende-Modus ruft der Hub selbst an - dann ist hier nichts zu tun.
        if (Autoblog_Settings::get('delivery', 'push') !== 'pull') {
            return;
        }

        $pending = Autoblog_Hub_Client::pending(3);
        if (is_wp_error($pending) || empty($pending['articles'])) {
            return;
        }

        foreach ($pending['articles'] as $article) {
            $result = Autoblog_Publisher::publish((array) $article);
            if (is_wp_error($result)) {
                Autoblog_Hub_Client::report($article['article_id'], ['ok' => false, 'message' => $result->get_error_message()]);
                continue;
            }
            Autoblog_Hub_Client::report($article['article_id'], [
                'ok'      => true,
                'post_id' => $result['post_id'],
                'url'     => $result['url'],
            ]);
        }
    }
}
