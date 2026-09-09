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

        self::assign_category($post_id, isset($data['category']) ? $data['category'] : '');
        self::assign_tags($post_id, isset($data['tags']) ? $data['tags'] : []);
        self::store_seo($post_id, isset($data['meta']) ? $data['meta'] : []);

        update_post_meta($post_id, '_autoblog_article_id', isset($data['article_id']) ? sanitize_text_field($data['article_id']) : '');
        update_post_meta($post_id, '_autoblog_created', current_time('mysql'));

        return [
            'post_id'  => (int) $post_id,
            'url'      => get_permalink($post_id),
            'edit_url' => get_edit_post_link($post_id, 'raw'),
            'status'   => get_post_status($post_id),
        ];
    }

    /** Kategorie zuweisen und bei Bedarf anlegen. */
    private static function assign_category($post_id, $category) {
        $category = sanitize_text_field((string) $category);
        if ($category === '') { return; }

        $term = get_term_by('name', $category, 'category');
        if (!$term) {
            $created = wp_insert_term($category, 'category');
            if (is_wp_error($created)) { return; }
            $term_id = (int) $created['term_id'];
        } else {
            $term_id = (int) $term->term_id;
        }
        wp_set_post_categories($post_id, [$term_id], false);
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
