<?php
if (!defined('ABSPATH')) { exit; }

/** Einstellungsseite unter "Einstellungen -> Autoblog". */
class Autoblog_Admin {

    const PAGE  = 'autoblog-connector';
    const NONCE = 'autoblog_save';

    public static function init() {
        add_action('admin_menu', [__CLASS__, 'add_page']);
        add_action('admin_post_autoblog_save', [__CLASS__, 'handle_save']);
        add_filter('plugin_action_links_' . plugin_basename(AUTOBLOG_FILE), [__CLASS__, 'action_links']);
    }

    public static function add_page() {
        add_options_page(
            __('Autoblog', 'autoblog-connector'),
            __('Autoblog', 'autoblog-connector'),
            'manage_options',
            self::PAGE,
            [__CLASS__, 'render']
        );
    }

    public static function action_links($links) {
        $url = admin_url('options-general.php?page=' . self::PAGE);
        array_unshift($links, '<a href="' . esc_url($url) . '">' . esc_html__('Einstellungen', 'autoblog-connector') . '</a>');
        return $links;
    }

    /** Formular verarbeiten: verbinden, trennen oder testen. */
    public static function handle_save() {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('Keine Berechtigung.', 'autoblog-connector'));
        }
        check_admin_referer(self::NONCE);

        $action = isset($_POST['autoblog_action']) ? sanitize_key(wp_unslash($_POST['autoblog_action'])) : '';
        $notice = '';
        $type   = 'success';

        if ($action === 'connect') {
            $hub_url = isset($_POST['hub_url']) ? sanitize_text_field(wp_unslash($_POST['hub_url'])) : '';
            $token   = isset($_POST['site_token']) ? sanitize_text_field(wp_unslash($_POST['site_token'])) : '';
            $author  = isset($_POST['default_author']) ? (int) $_POST['default_author'] : 0;
            Autoblog_Settings::update([
                'default_author' => $author,
                'auto_update'    => isset($_POST['auto_update']) ? 1 : 0,
            ]);

            $result = Autoblog_Hub_Client::connect($hub_url, $token);
            if (is_wp_error($result)) {
                $notice = $result->get_error_message();
                $type   = 'error';
            } else {
                $notice = sprintf(
                    /* translators: %s: Name der Website im Hub */
                    __('Verbunden. Diese Website ist im Hub als "%s" eingerichtet.', 'autoblog-connector'),
                    isset($result['site_name']) ? $result['site_name'] : ''
                );
                Autoblog_Cron::activate();
            }
        } elseif ($action === 'test') {
            $result = Autoblog_Hub_Client::heartbeat();
            if (is_wp_error($result)) {
                $notice = $result->get_error_message();
                $type   = 'error';
            } else {
                $notice = __('Verbindung zum Hub steht.', 'autoblog-connector');
                if (!empty($result['pending'])) {
                    $notice .= ' ' . sprintf(
                        /* translators: %d: Anzahl wartender Artikel */
                        __('%d Artikel warten auf Veroeffentlichung.', 'autoblog-connector'),
                        (int) $result['pending']
                    );
                }
            }
        } elseif ($action === 'update') {
            $ergebnis = Autoblog_Updater::jetzt_aktualisieren();
            if (is_wp_error($ergebnis)) {
                $notice = $ergebnis->get_error_message();
                $type   = 'error';
            } else {
                $notice = $ergebnis['from'] === $ergebnis['version']
                    ? __('Das Plugin ist bereits auf dem neuesten Stand.', 'autoblog-connector')
                    : sprintf(
                        /* translators: 1: alte Version, 2: neue Version */
                        __('Plugin von %1$s auf %2$s aktualisiert.', 'autoblog-connector'),
                        $ergebnis['from'],
                        $ergebnis['version']
                    );
            }
        } elseif ($action === 'poll') {
            Autoblog_Cron::run();
            $notice = __('Wartende Artikel wurden abgerufen.', 'autoblog-connector');
        } elseif ($action === 'disconnect') {
            Autoblog_Hub_Client::disconnect();
            Autoblog_Cron::deactivate();
            $notice = __('Verbindung getrennt.', 'autoblog-connector');
        }

        $redirect = add_query_arg(
            ['page' => self::PAGE, 'autoblog_notice' => rawurlencode($notice), 'autoblog_type' => $type],
            admin_url('options-general.php')
        );
        wp_safe_redirect($redirect);
        exit;
    }

    public static function render() {
        if (!current_user_can('manage_options')) { return; }

        $settings  = Autoblog_Settings::all();
        $connected = Autoblog_Settings::is_connected();

        // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- reine Anzeige nach Redirect
        $notice = isset($_GET['autoblog_notice']) ? sanitize_text_field(rawurldecode(wp_unslash($_GET['autoblog_notice']))) : '';
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $type = isset($_GET['autoblog_type']) ? sanitize_key(wp_unslash($_GET['autoblog_type'])) : 'success';
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('Autoblog Connector', 'autoblog-connector'); ?></h1>

            <?php if ($notice) : ?>
                <div class="notice notice-<?php echo esc_attr($type === 'error' ? 'error' : 'success'); ?> is-dismissible">
                    <p><?php echo esc_html($notice); ?></p>
                </div>
            <?php endif; ?>

            <?php if ($connected) : ?>
                <div class="notice notice-success inline"><p>
                    <strong><?php esc_html_e('Verbunden.', 'autoblog-connector'); ?></strong>
                    <?php
                    printf(
                        /* translators: 1: Name im Hub, 2: Name des Hubs */
                        esc_html__('Diese Website laeuft im Hub als "%1$s" (%2$s).', 'autoblog-connector'),
                        esc_html($settings['site_name']),
                        esc_html($settings['hub_name'] ? $settings['hub_name'] : $settings['hub_url'])
                    );
                    ?>
                </p></div>
            <?php else : ?>
                <div class="notice notice-warning inline"><p>
                    <?php esc_html_e('Noch nicht verbunden. Trage die Hub-Adresse und den Website-Token aus dem Autoblog Hub ein.', 'autoblog-connector'); ?>
                </p></div>
            <?php endif; ?>

            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <?php wp_nonce_field(self::NONCE); ?>
                <input type="hidden" name="action" value="autoblog_save" />
                <input type="hidden" name="autoblog_action" value="connect" />

                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="hub_url"><?php esc_html_e('Hub-Adresse', 'autoblog-connector'); ?></label></th>
                        <td>
                            <input name="hub_url" id="hub_url" type="url" class="regular-text"
                                   value="<?php echo esc_attr($settings['hub_url']); ?>" placeholder="https://autoblog.meinedomain.de" required />
                            <p class="description"><?php esc_html_e('Die Adresse deines Autoblog Hubs, ohne Schraegstrich am Ende.', 'autoblog-connector'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="site_token"><?php esc_html_e('Website-Token', 'autoblog-connector'); ?></label></th>
                        <td>
                            <input name="site_token" id="site_token" type="text" class="regular-text code"
                                   value="<?php echo esc_attr($settings['site_token']); ?>" placeholder="wpab_…" required />
                            <p class="description"><?php esc_html_e('Im Hub unter der jeweiligen Website im Reiter "Verbindung" zu finden.', 'autoblog-connector'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="default_author"><?php esc_html_e('Beitraege anlegen als', 'autoblog-connector'); ?></label></th>
                        <td>
                            <?php
                            wp_dropdown_users([
                                'name'              => 'default_author',
                                'id'                => 'default_author',
                                'selected'          => (int) $settings['default_author'],
                                'show_option_none'  => __('— Standard —', 'autoblog-connector'),
                                'option_none_value' => 0,
                                'capability'        => ['edit_posts'],
                            ]);
                            ?>
                            <p class="description"><?php esc_html_e('Autor, dem automatisch erstellte Beitraege zugeordnet werden.', 'autoblog-connector'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><?php esc_html_e('Automatische Updates', 'autoblog-connector'); ?></th>
                        <td>
                            <label>
                                <input type="checkbox" name="auto_update" value="1" <?php checked((int) $settings['auto_update'], 1); ?> />
                                <?php esc_html_e('Plugin automatisch aktualisieren, sobald der Hub eine neuere Fassung bereithaelt', 'autoblog-connector'); ?>
                            </label>
                            <p class="description">
                                <?php
                                printf(
                                    /* translators: %s: installierte Version */
                                    esc_html__('Installiert ist Version %s. Das Archiv kommt von deinem Hub, nicht aus dem WordPress-Verzeichnis.', 'autoblog-connector'),
                                    esc_html(AUTOBLOG_VERSION)
                                );
                                ?>
                            </p>
                        </td>
                    </tr>
                </table>

                <?php submit_button($connected ? __('Verbindung aktualisieren', 'autoblog-connector') : __('Verbinden', 'autoblog-connector')); ?>
            </form>

            <?php if ($connected) : ?>
                <h2><?php esc_html_e('Status', 'autoblog-connector'); ?></h2>
                <table class="widefat striped" style="max-width:760px">
                    <tbody>
                        <tr><td><?php esc_html_e('Verbunden seit', 'autoblog-connector'); ?></td>
                            <td><?php echo esc_html($settings['connected_at'] ? $settings['connected_at'] : '—'); ?></td></tr>
                        <tr><td><?php esc_html_e('Letzter Kontakt', 'autoblog-connector'); ?></td>
                            <td><?php echo esc_html($settings['last_contact'] ? $settings['last_contact'] : '—'); ?></td></tr>
                        <tr><td><?php esc_html_e('Uebertragungsweg', 'autoblog-connector'); ?></td>
                            <td><?php echo esc_html($settings['delivery'] === 'pull'
                                ? __('WordPress holt die Artikel selbst ab', 'autoblog-connector')
                                : __('Der Hub sendet an diese Website', 'autoblog-connector')); ?></td></tr>
                        <tr><td><?php esc_html_e('Empfangsadresse', 'autoblog-connector'); ?></td>
                            <td><code><?php echo esc_html(rest_url('wp-autoblog/v1/publish')); ?></code></td></tr>
                        <?php if ($settings['last_error']) : ?>
                            <tr><td><?php esc_html_e('Letzter Fehler', 'autoblog-connector'); ?></td>
                                <td style="color:#b32d2e"><?php echo esc_html($settings['last_error']); ?></td></tr>
                        <?php endif; ?>
                    </tbody>
                </table>

                <p style="margin-top:16px">
                    <?php foreach ([
                        'test'       => __('Verbindung testen', 'autoblog-connector'),
                        'update'     => __('Jetzt nach Plugin-Update suchen', 'autoblog-connector'),
                        'poll'       => __('Wartende Artikel jetzt abrufen', 'autoblog-connector'),
                        'disconnect' => __('Verbindung trennen', 'autoblog-connector'),
                    ] as $value => $label) : ?>
                        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="display:inline-block;margin-right:8px">
                            <?php wp_nonce_field(self::NONCE); ?>
                            <input type="hidden" name="action" value="autoblog_save" />
                            <input type="hidden" name="autoblog_action" value="<?php echo esc_attr($value); ?>" />
                            <button type="submit" class="button<?php echo $value === 'disconnect' ? ' button-link-delete' : ''; ?>">
                                <?php echo esc_html($label); ?>
                            </button>
                        </form>
                    <?php endforeach; ?>
                </p>
            <?php endif; ?>
        </div>
        <?php
    }
}
