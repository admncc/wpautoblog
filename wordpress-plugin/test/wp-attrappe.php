<?php
/**
 * Minimale WordPress-Attrappe, damit sich die ads.txt-Klasse ohne WordPress
 * pruefen laesst. Sie fasst eine Datei an, an der Werbeeinnahmen haengen -
 * das gehoert geprueft, nicht nur gelesen.
 */
define('ABSPATH', sys_get_temp_dir() . '/autoblog-ads-test/');
if (!is_dir(ABSPATH)) { mkdir(ABSPATH, 0777, true); }
$OPTIONEN = [];
function get_option($k, $f = false) { global $OPTIONEN; return array_key_exists($k, $OPTIONEN) ? $OPTIONEN[$k] : $f; }
function update_option($k, $v, $a = true) { global $OPTIONEN; $OPTIONEN[$k] = $v; return true; }
function delete_option($k) { global $OPTIONEN; unset($OPTIONEN[$k]); return true; }
function home_url($p = '/') { return 'https://beispiel.de' . $p; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function trailingslashit($s) { return rtrim($s, '/\\') . '/'; }
function untrailingslashit($s) { return rtrim($s, '/\\'); }
function current_time($t) { return date('Y-m-d H:i:s'); }
function nocache_headers() {}
function wp_unslash($v) { return $v; }
function __($t, $d = '') { return $t; }
function esc_html__($t, $d = '') { return $t; }
class WP_Error { public $m; function __construct($c, $m = '') { $this->m = $m; } function get_error_message() { return $this->m; } }
function is_wp_error($x) { return $x instanceof WP_Error; }
require __DIR__ . '/../autoblog-connector/includes/class-autoblog-ads.php';
