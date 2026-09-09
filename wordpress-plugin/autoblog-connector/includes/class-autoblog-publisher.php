<?php
if (!defined('ABSPATH')) { exit; }

/** Legt Beitraege aus den Daten des Hubs an oder aktualisiert sie. */
class Autoblog_Publisher {

    /**
     * @param array $data Artikeldaten des Hubs.
     * @return array|WP_Error ['post_id' => int, 'url' => string, 'edit_url' => string]
     */
    public static function publish(array $data) {
        $title   = isset($data['title']) ? sanitize_text_field($data['title']) : '';
        $content = isset($data['content']) ? (string) $data['content'] : '';

        if ($title === '' || trim($content) === '') {
            return new WP_Error('autoblog_empty', __('Titel oder Inhalt fehlt.', 'autoblog-connector'));
        }

        $status = isset($data['status']) ? $data['status'] : 'draft';
        if (!in_array($status, ['draft', 'pending', 'publish', 'private'], true)) {
            $status = 'draft';
        }

        // wp_kses_post entfernt alles, was ein Redakteur auch nicht speichern duerfte.
        $postarr = [
            'post_title'   => $title,
            'post_content' => wp_kses_post($content),
            'post_excerpt' => isset($data['excerpt']) ? sanitize_textarea_field($data['excerpt']) : '',
            'post_status'  => $status,
            'post_type'    => 'post',
        ];

        if (!empty($data['slug'])) {
            $postarr['post_name'] = sanitize_title($data['slug']);
        }

        $author = isset($data['author_id']) ? (int) $data['author_id'] : 0;
        if ($author <= 0) {
            $author = (int) Autoblog_Settings::get('default_author', 0);
        }
        if ($author > 0 && get_userdata($author)) {
            $postarr['post_author'] = $author;
        }

        $existing = isset($data['post_id']) ? (int) $data['post_id'] : 0;
        if ($existing > 0 && get_post($existing)) {
            $postarr['ID'] = $existing;
            $post_id = wp_update_post($postarr, true);
        } else {
            $post_id = wp_insert_post($postarr, true);
        }

        if (is_wp_error($post_id)) {
            return $post_id;
        }

        // Bilder zuerst: Sie muessen in der Mediathek liegen, bevor der Inhalt
        // mit den fertigen Adressen gespeichert wird.
        $import = self::import_images(
            $post_id,
            isset($data['images']) ? $data['images'] : [],
            isset($data['slug']) ? sanitize_title($data['slug']) : ''
        );
        $inhalt = self::apply_images($postarr['post_content'], $import['bilder'], $post_id);
        if ($inhalt !== $postarr['post_content']) {
            wp_update_post(['ID' => $post_id, 'post_content' => $inhalt]);
        }

        $kategorie = self::assign_category($post_id, isset($data['category']) ? $data['category'] : '');
        self::assign_tags($post_id, isset($data['tags']) ? $data['tags'] : []);
        self::store_seo($post_id, isset($data['meta']) ? $data['meta'] : []);

        update_post_meta($post_id, '_autoblog_article_id', isset($data['article_id']) ? sanitize_text_field($data['article_id']) : '');
        update_post_meta($post_id, '_autoblog_created', current_time('mysql'));

        return [
            'post_id'         => (int) $post_id,
            'url'             => get_permalink($post_id),
            'edit_url'        => get_edit_post_link($post_id, 'raw'),
            'status'          => get_post_status($post_id),
            'images_imported' => count($import['bilder']),
            'image_errors'    => $import['fehler'],
            'category'        => $kategorie['name'],
            'category_note'   => $kategorie['hinweis'],
        ];
    }

    /**
     * Laedt die Bilder des Hubs in die Mediathek.
     *
     * Bewusst ohne media_sideload_image: Jenes laedt ueber download_url, und das
     * prueft die Adresse mit wp_http_validate_url, die nur die Ports 80, 443 und
     * 8080 zulaesst. Ein Hub auf einem eigenen Port waere damit nicht erreichbar.
     * Fehler werden gesammelt und an den Hub zurueckgemeldet, nicht verschluckt.
     *
     * @return array ['bilder' => slot => [...], 'fehler' => string[]]
     */
    private static function import_images($post_id, $images, $slug = '') {
        if (!is_array($images) || empty($images)) {
            return ['bilder' => [], 'fehler' => []];
        }

        require_once ABSPATH . 'wp-admin/includes/image.php';

        $bilder = [];
        $fehler = [];

        foreach ($images as $bild) {
            $url = isset($bild['url']) ? esc_url_raw($bild['url']) : '';
            if ($url === '') {
                continue;
            }
            $slot    = isset($bild['slot']) ? (int) $bild['slot'] : count($bilder) + 1;
            $alt     = isset($bild['alt']) ? sanitize_text_field($bild['alt']) : '';
            $caption = isset($bild['caption']) ? sanitize_text_field($bild['caption']) : '';

            // Wurde dasselbe Bild schon einmal importiert, wird es wiederverwendet.
            // Sonst entstuenden bei jedem erneuten Senden Dubletten in der Mediathek.
            $vorhanden = get_posts([
                'post_type'      => 'attachment',
                'post_status'    => 'inherit',
                'posts_per_page' => 1,
                'fields'         => 'ids',
                'meta_key'       => '_autoblog_source',
                'meta_value'     => $url,
            ]);
            if (!empty($vorhanden[0])) {
                $bilder[$slot] = ['id' => (int) $vorhanden[0], 'alt' => $alt, 'caption' => $caption];
                continue;
            }

            $antwort = wp_remote_get($url, [
                'timeout'     => 60,
                'redirection' => 3,
                'user-agent'  => 'AutoblogConnector/' . AUTOBLOG_VERSION,
            ]);

            if (is_wp_error($antwort)) {
                /* translators: 1: Bildnummer, 2: Fehlermeldung */
                $fehler[] = sprintf(__('Bild %1$d: Hub nicht erreichbar (%2$s)', 'autoblog-connector'), $slot, $antwort->get_error_message());
                continue;
            }

            $code = (int) wp_remote_retrieve_response_code($antwort);
            if ($code !== 200) {
                /* translators: 1: Bildnummer, 2: HTTP-Statuscode */
                $fehler[] = sprintf(__('Bild %1$d: Hub antwortete mit HTTP %2$d', 'autoblog-connector'), $slot, $code);
                continue;
            }

            $daten = wp_remote_retrieve_body($antwort);
            if ($daten === '') {
                /* translators: %d: Bildnummer */
                $fehler[] = sprintf(__('Bild %d: leere Antwort vom Hub', 'autoblog-connector'), $slot);
                continue;
            }

            $typ  = strtok((string) wp_remote_retrieve_header($antwort, 'content-type'), ';');
            $typ  = $typ ? trim($typ) : 'image/png';
            $name = sanitize_file_name(($slug !== '' ? $slug : 'beitrag') . '-' . $slot . '.' . self::extension_for($typ));

            $datei = wp_upload_bits($name, null, $daten);
            if (!empty($datei['error'])) {
                /* translators: 1: Bildnummer, 2: Fehlermeldung */
                $fehler[] = sprintf(__('Bild %1$d: konnte nicht gespeichert werden (%2$s)', 'autoblog-connector'), $slot, $datei['error']);
                continue;
            }

            $attachment_id = wp_insert_attachment([
                'post_mime_type' => $typ,
                'post_title'     => $alt !== '' ? $alt : $name,
                'post_excerpt'   => $caption,   // wird in WordPress zur Bildunterschrift
                'post_content'   => '',
                'post_status'    => 'inherit',
            ], $datei['file'], $post_id, true);

            if (is_wp_error($attachment_id) || !$attachment_id) {
                $meldung = is_wp_error($attachment_id) ? $attachment_id->get_error_message() : __('unbekannter Fehler', 'autoblog-connector');
                /* translators: 1: Bildnummer, 2: Fehlermeldung */
                $fehler[] = sprintf(__('Bild %1$d: nicht in die Mediathek eingetragen (%2$s)', 'autoblog-connector'), $slot, $meldung);
                continue;
            }

            // Erzeugt die Bildgroessen, die das Theme spaeter ausliefert.
            wp_update_attachment_metadata($attachment_id, wp_generate_attachment_metadata($attachment_id, $datei['file']));
            update_post_meta($attachment_id, '_wp_attachment_image_alt', $alt);
            update_post_meta($attachment_id, '_autoblog_source', $url);

            $bilder[$slot] = ['id' => (int) $attachment_id, 'alt' => $alt, 'caption' => $caption];
        }

        // Bild 1 ist das Beitragsbild.
        if (isset($bilder[1]) && !has_post_thumbnail($post_id)) {
            set_post_thumbnail($post_id, $bilder[1]['id']);
        }

        return ['bilder' => $bilder, 'fehler' => $fehler];
    }

    /** Dateiendung zum gelieferten Bildtyp. */
    private static function extension_for($mime) {
        $karte = [
            'image/jpeg' => 'jpg',
            'image/jpg'  => 'jpg',
            'image/png'  => 'png',
            'image/webp' => 'webp',
            'image/avif' => 'avif',
            'image/gif'  => 'gif',
        ];
        return isset($karte[$mime]) ? $karte[$mime] : 'png';
    }

    /**
     * Ersetzt die Platzhalter [[BILD:n]] durch das jeweilige Bild.
     * Platzhalter ohne Bild werden entfernt, damit nie Klammertext im Beitrag steht.
     */
    private static function apply_images($content, $bilder, $post_id) {
        return preg_replace_callback(
            '/(?:<p>\s*)?\[\[BILD:(\d+)\]\](?:\s*<\/p>)?/i',
            function ($treffer) use ($bilder) {
                $slot = (int) $treffer[1];
                if (empty($bilder[$slot])) {
                    return '';
                }
                $bild = $bilder[$slot];
                $img = wp_get_attachment_image($bild['id'], 'large', false, [
                    'alt'      => $bild['alt'],
                    'loading'  => 'lazy',
                    'decoding' => 'async',
                ]);
                if (!$img) {
                    return '';
                }
                $caption = $bild['caption'] !== ''
                    ? '<figcaption>' . esc_html($bild['caption']) . '</figcaption>'
                    : '';
                return '<figure class="wp-block-image size-large">' . $img . $caption . '</figure>';
            },
            (string) $content
        );
    }

    /**
     * Ordnet den Beitrag einer BESTEHENDEN Kategorie zu.
     * Es wird bewusst keine neue Kategorie angelegt: Passt nichts, bleibt es bei
     * der Standardkategorie von WordPress, und der Hub bekommt einen Hinweis.
     *
     * @return array ['name' => string, 'hinweis' => string]
     */
    private static function assign_category($post_id, $category) {
        $gesucht = trim(sanitize_text_field((string) $category));
        if ($gesucht === '') {
            return ['name' => '', 'hinweis' => ''];
        }

        // Erst exakt ueber Name oder Slug, dann ohne Ruecksicht auf Gross- und Kleinschreibung.
        $begriff = get_term_by('name', $gesucht, 'category');
        if (!$begriff) {
            $begriff = get_term_by('slug', sanitize_title($gesucht), 'category');
        }
        if (!$begriff) {
            foreach (get_categories(['hide_empty' => false, 'number' => 200]) as $vorhanden) {
                if (function_exists('mb_strtolower')
                    ? mb_strtolower($vorhanden->name) === mb_strtolower($gesucht)
                    : strtolower($vorhanden->name) === strtolower($gesucht)) {
                    $begriff = $vorhanden;
                    break;
                }
            }
        }

        if (!$begriff) {
            return [
                'name'    => '',
                /* translators: %s: gewuenschte Kategorie */
                'hinweis' => sprintf(
                    __('Die Kategorie "%s" gibt es auf dieser Website nicht. Der Beitrag liegt in der Standardkategorie.', 'autoblog-connector'),
                    $gesucht
                ),
            ];
        }

        wp_set_post_categories($post_id, [(int) $begriff->term_id], false);
        return ['name' => $begriff->name, 'hinweis' => ''];
    }

    private static function assign_tags($post_id, $tags) {
        if (!is_array($tags) || empty($tags)) { return; }
        $clean = array_filter(array_map('sanitize_text_field', $tags));
        if ($clean) {
            wp_set_post_tags($post_id, $clean, false);
        }
    }

    /**
     * SEO-Angaben ablegen. Yoast und Rank Math lesen ihre eigenen Felder,
     * zusaetzlich wird eine neutrale Kopie gespeichert.
     */
    private static function store_seo($post_id, $meta) {
        if (!is_array($meta)) { return; }
        $seo_title = isset($meta['title']) ? sanitize_text_field($meta['title']) : '';
        $seo_desc  = isset($meta['description']) ? sanitize_text_field($meta['description']) : '';
        if ($seo_title === '' && $seo_desc === '') { return; }

        update_post_meta($post_id, '_autoblog_seo_title', $seo_title);
        update_post_meta($post_id, '_autoblog_seo_description', $seo_desc);

        if (defined('WPSEO_VERSION') || is_plugin_active_safe('wordpress-seo/wp-seo.php')) {
            if ($seo_title !== '') { update_post_meta($post_id, '_yoast_wpseo_title', $seo_title); }
            if ($seo_desc !== '')  { update_post_meta($post_id, '_yoast_wpseo_metadesc', $seo_desc); }
        }
        if (class_exists('RankMath') || is_plugin_active_safe('seo-by-rank-math/rank-math.php')) {
            if ($seo_title !== '') { update_post_meta($post_id, 'rank_math_title', $seo_title); }
            if ($seo_desc !== '')  { update_post_meta($post_id, 'rank_math_description', $seo_desc); }
        }
    }
}

/** is_plugin_active() steht im Frontend nicht zur Verfuegung. */
function is_plugin_active_safe($plugin) {
    return in_array($plugin, (array) get_option('active_plugins', []), true);
}
