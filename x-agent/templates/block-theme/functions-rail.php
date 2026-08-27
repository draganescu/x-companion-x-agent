<?php
/**
 * Registers the 'rail' template part area. Core's default allowed areas are
 * exactly uncategorized/header/footer; an unknown area value silently coerces
 * to uncategorized (with a wp_trigger_error), so the third pane the rail
 * skeleton declares must be registered here. This file ships ONLY with the
 * rail skeleton; stacked and split themes contain no PHP at all.
 */

add_filter( 'default_wp_template_part_areas', function ( $areas ) {
    $areas[] = array(
        'area'        => 'rail',
        'label'       => __( 'Rail', '{{textdomain}}' ),
        'description' => __( 'A persistent side rail beside the content column.', '{{textdomain}}' ),
        'icon'        => 'sidebar',
        'area_tag'    => 'aside',
    );
    return $areas;
} );
