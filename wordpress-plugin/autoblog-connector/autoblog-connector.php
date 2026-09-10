<?php
/**
 * Plugin Name:       Autoblog Connector
 * Plugin URI:        https://github.com/admncc/wpautoblog
 * Description:       Verbindet diese WordPress-Seite mit dem Autoblog Hub. Der Hub erzeugt Blogartikel und legt sie hier als Beitrag an.
 * Version:           1.4.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Autoblog
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       autoblog-connector
 */

if (!defined('ABSPATH')) {
    exit; // Direkter Aufruf nicht erlaubt.
}

define('AUTOBLOG_VERSION', '1.4.0');
define('AUTOBLOG_FILE', __FILE__);
define('AUTOBLOG_PATH', plugin_dir_path(__FILE__));

require_once AUTOBLOG_PATH . 'includes/class-autoblog-settings.php';
require_once AUTOBLOG_PATH . 'includes/class-autoblog-hub-client.php';
require_once AUTOBLOG_PATH . 'includes/class-autoblog-publisher.php';
require_once AUTOBLOG_PATH . 'includes/class-autoblog-rest.php';
require_once AUTOBLOG_PATH . 'includes/class-autoblog-admin.php';
require_once AUTOBLOG_PATH . 'includes/class-autoblog-cron.php';
require_once AUTOBLOG_PATH . 'includes/class-autoblog-updater.php';

/** Startet alle Bestandteile des Plugins. */
function autoblog_boot() {
    Autoblog_Rest::init();
    Autoblog_Admin::init();
    Autoblog_Cron::init();
    Autoblog_Updater::init();
}
add_action('plugins_loaded', 'autoblog_boot');

register_activation_hook(__FILE__, ['Autoblog_Cron', 'activate']);
register_deactivation_hook(__FILE__, ['Autoblog_Cron', 'deactivate']);
