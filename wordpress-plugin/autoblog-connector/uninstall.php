<?php
/** Wird beim Loeschen des Plugins ausgefuehrt: Einstellungen entfernen. */
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}
delete_option('autoblog_settings');

$timestamp = wp_next_scheduled('autoblog_poll_event');
if ($timestamp) {
    wp_unschedule_event($timestamp, 'autoblog_poll_event');
}
