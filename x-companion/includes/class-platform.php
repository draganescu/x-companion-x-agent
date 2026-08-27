<?php
/**
 * Platform introspection: the LSP surface beyond blocks + theme tokens.
 *
 * Serves the interfaces v2 manifest sections — block styles, block
 * variations, merged global styles (including per-block custom css), block
 * bindings (sources, bindable attributes, registered meta), the data model
 * (post types, taxonomies, statuses) and the feature matrix — every one of
 * them READ from the running instance, never inferred from version tables.
 *
 * Layering mirrors class-manifest.php: the live readers touch WordPress; the
 * stamp builder (platform_stamp_inputs / compute helpers) is a pure function
 * of injected arrays so the offline suite can pin it.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Platform introspection provider.
 */
final class X_Companion_Platform {

	/**
	 * Option mapping registered names to the agent schema package that
	 * provides them: { post_types: {slug: package}, taxonomies: {slug: package} }.
	 * Written by the schema library installer; read here for source labels.
	 */
	const PROVIDES_OPTION = 'x_companion_schema_provides';

	/**
	 * Core's block-bindings attribute allowlist, keyed by block name.
	 *
	 * This mirrors the array WordPress core hardcodes inside
	 * WP_Block::process_block_bindings() (a local variable, deliberately not
	 * reflectable). It is canon, not invention; the
	 * `x_companion_bindable_attributes` filter exists so a future core
	 * expansion can be adopted without a plugin release.
	 *
	 * @return array<string,string[]>
	 */
	public static function core_bindable_attributes(): array {
		$map = array(
			'core/paragraph' => array( 'content' ),
			'core/heading'   => array( 'content' ),
			'core/image'     => array( 'id', 'url', 'title', 'alt' ),
			'core/button'    => array( 'url', 'text', 'linkTarget', 'rel' ),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'x_companion_bindable_attributes', $map );
			if ( is_array( $filtered ) ) {
				$map = $filtered;
			}
		}

		return $map;
	}

	/*
	 * -------------------------------------------------------------------
	 * Block styles
	 * -------------------------------------------------------------------
	 */

	/**
	 * Registered block styles, keyed by block name.
	 *
	 * Source labeling is best effort: a style whose name appears in the
	 * theme-origin theme.json variations for that block is 'theme'; styles
	 * provided by an installed agent artifact are 'agent' (tracked via the
	 * provides option); everything else is 'plugin' — register_block_style()
	 * does not record its caller.
	 *
	 * @return array<string, array<int, array{name:string,label:string,source:string}>>
	 */
	public static function styles_map(): array {
		if ( ! class_exists( 'WP_Block_Styles_Registry' ) ) {
			return array();
		}

		$theme_styles = self::theme_json_style_names();
		$provides     = self::provides();
		$agent_styles = (array) ( $provides['block_styles'] ?? array() );

		$out = array();

		foreach ( WP_Block_Styles_Registry::get_instance()->get_all_registered() as $block_name => $styles ) {
			$entries = array();

			foreach ( (array) $styles as $style_name => $style ) {
				$name = (string) ( $style['name'] ?? $style_name );

				$source = 'plugin';
				if ( isset( $agent_styles[ $block_name ] ) && in_array( $name, (array) $agent_styles[ $block_name ], true ) ) {
					$source = 'agent';
				} elseif ( isset( $theme_styles[ $block_name ] ) && in_array( $name, $theme_styles[ $block_name ], true ) ) {
					$source = 'theme';
				}

				$entries[] = array(
					'name'   => $name,
					'label'  => (string) ( $style['label'] ?? $name ),
					'source' => $source,
				);
			}

			if ( ! empty( $entries ) ) {
				usort(
					$entries,
					static function ( $a, $b ) {
						return strcmp( $a['name'], $b['name'] );
					}
				);
				$out[ (string) $block_name ] = $entries;
			}
		}

		ksort( $out, SORT_STRING );

		return $out;
	}

	/**
	 * Style variation names declared by the active theme's theme.json, keyed
	 * by block name.
	 *
	 * @return array<string,string[]>
	 */
	private static function theme_json_style_names(): array {
		if ( ! class_exists( 'WP_Theme_JSON_Resolver' ) || ! method_exists( 'WP_Theme_JSON_Resolver', 'get_theme_data' ) ) {
			return array();
		}

		$data = WP_Theme_JSON_Resolver::get_theme_data();
		if ( ! is_object( $data ) || ! method_exists( $data, 'get_raw_data' ) ) {
			return array();
		}

		$raw    = (array) $data->get_raw_data();
		$blocks = (array) ( $raw['styles']['blocks'] ?? array() );
		$out    = array();

		foreach ( $blocks as $block_name => $node ) {
			$variations = array_keys( (array) ( $node['variations'] ?? array() ) );
			if ( ! empty( $variations ) ) {
				$out[ (string) $block_name ] = array_map( 'strval', $variations );
			}
		}

		return $out;
	}

	/*
	 * -------------------------------------------------------------------
	 * Global styles
	 * -------------------------------------------------------------------
	 */

	/**
	 * Merged global styles: settings, styles, and the custom css surface.
	 *
	 * @return array{settings:mixed,styles:mixed,custom_css:array{global:string,blocks:array<string,string>}}
	 */
	public static function global_styles(): array {
		$settings = function_exists( 'wp_get_global_settings' ) ? wp_get_global_settings() : array();
		$styles   = function_exists( 'wp_get_global_styles' ) ? wp_get_global_styles() : array();

		$custom = array(
			'global' => '',
			'blocks' => array(),
		);

		if ( class_exists( 'WP_Theme_JSON_Resolver' ) && method_exists( 'WP_Theme_JSON_Resolver', 'get_merged_data' ) ) {
			$merged = WP_Theme_JSON_Resolver::get_merged_data();
			if ( is_object( $merged ) && method_exists( $merged, 'get_raw_data' ) ) {
				$raw              = (array) $merged->get_raw_data();
				$custom['global'] = (string) ( $raw['styles']['css'] ?? '' );

				foreach ( (array) ( $raw['styles']['blocks'] ?? array() ) as $block_name => $node ) {
					$css = (string) ( $node['css'] ?? '' );
					if ( '' !== $css ) {
						$custom['blocks'][ (string) $block_name ] = $css;
					}
				}
				ksort( $custom['blocks'], SORT_STRING );
			}
		}

		return array(
			'settings'   => is_array( $settings ) ? $settings : array(),
			'styles'     => is_array( $styles ) ? $styles : array(),
			'custom_css' => $custom,
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * Bindings
	 * -------------------------------------------------------------------
	 */

	/**
	 * Block bindings: registered sources, bindable attributes, registered meta.
	 *
	 * @return array{sources:array,bindable_attributes:array<string,string[]>,registered_meta:array}
	 */
	public static function bindings(): array {
		$sources = array();

		if ( class_exists( 'WP_Block_Bindings_Registry' ) ) {
			foreach ( WP_Block_Bindings_Registry::get_instance()->get_all_registered() as $name => $source ) {
				$sources[] = array(
					'name'         => (string) $name,
					'label'        => (string) ( $source->label ?? $name ),
					'uses_context' => array_values( array_map( 'strval', (array) ( $source->uses_context ?? array() ) ) ),
				);
			}

			usort(
				$sources,
				static function ( $a, $b ) {
					return strcmp( $a['name'], $b['name'] );
				}
			);
		}

		$bindable = array();
		if ( ! empty( $sources ) && class_exists( 'WP_Block_Type_Registry' ) ) {
			$registry = WP_Block_Type_Registry::get_instance();
			foreach ( self::core_bindable_attributes() as $block_name => $attrs ) {
				if ( $registry->is_registered( $block_name ) ) {
					$bindable[ $block_name ] = array_values( array_map( 'strval', (array) $attrs ) );
				}
			}
			ksort( $bindable, SORT_STRING );
		}

		return array(
			'sources'             => $sources,
			'bindable_attributes' => $bindable,
			'registered_meta'     => self::registered_meta(),
		);
	}

	/**
	 * Registered meta keys by object type, subtype-aware.
	 *
	 * @return array<string, array<int, array>>
	 */
	public static function registered_meta(): array {
		if ( ! function_exists( 'get_registered_meta_keys' ) ) {
			return array();
		}

		$out = array();

		$object_types = array(
			'post'    => function_exists( 'get_post_types' ) ? array_keys( get_post_types( array(), 'names' ) ) : array(),
			'term'    => function_exists( 'get_taxonomies' ) ? array_keys( get_taxonomies( array(), 'names' ) ) : array(),
			'user'    => array(),
			'comment' => array(),
		);

		foreach ( $object_types as $type => $subtypes ) {
			$entries = array();

			foreach ( array_merge( array( '' ), $subtypes ) as $subtype ) {
				foreach ( get_registered_meta_keys( $type, (string) $subtype ) as $key => $args ) {
					$show = $args['show_in_rest'] ?? false;

					$entry = array(
						'key'          => (string) $key,
						'type'         => (string) ( $args['type'] ?? 'string' ),
						'single'       => (bool) ( $args['single'] ?? false ),
						'show_in_rest' => (bool) $show,
					);

					if ( '' !== $subtype ) {
						$entry['subtype'] = (string) $subtype;
					}

					if ( is_array( $show ) && isset( $show['schema'] ) ) {
						$entry['show_in_rest_schema'] = $show['schema'];
					}

					$entries[] = $entry;
				}
			}

			if ( ! empty( $entries ) ) {
				usort(
					$entries,
					static function ( $a, $b ) {
						return strcmp( $a['key'] . '|' . ( $a['subtype'] ?? '' ), $b['key'] . '|' . ( $b['subtype'] ?? '' ) );
					}
				);
				$out[ $type ] = $entries;
			}
		}

		return $out;
	}

	/*
	 * -------------------------------------------------------------------
	 * Data model
	 * -------------------------------------------------------------------
	 */

	/**
	 * The instance's content model: post types, taxonomies, statuses.
	 *
	 * @return array{post_types:array,taxonomies:array,statuses:array}
	 */
	public static function data_model(): array {
		$provides = self::provides();

		$post_types = array();
		if ( function_exists( 'get_post_types' ) ) {
			foreach ( get_post_types( array(), 'objects' ) as $slug => $type ) {
				if ( empty( $type->public ) && empty( $type->show_in_rest ) ) {
					continue;
				}

				$meta_keys = array();
				if ( function_exists( 'get_registered_meta_keys' ) ) {
					$meta_keys = array_values(
						array_unique(
							array_merge(
								array_keys( get_registered_meta_keys( 'post', (string) $slug ) ),
								array()
							)
						)
					);
					sort( $meta_keys, SORT_STRING );
				}

				$post_types[] = array(
					'slug'         => (string) $slug,
					'label'        => (string) ( $type->label ?? $slug ),
					'public'       => (bool) ( $type->public ?? false ),
					'show_in_rest' => (bool) ( $type->show_in_rest ?? false ),
					'rest_base'    => (string) ( ! empty( $type->rest_base ) ? $type->rest_base : $slug ),
					'supports'     => function_exists( 'get_all_post_type_supports' ) ? array_keys( get_all_post_type_supports( (string) $slug ) ) : array(),
					'taxonomies'   => function_exists( 'get_object_taxonomies' ) ? array_values( get_object_taxonomies( (string) $slug ) ) : array(),
					'meta_keys'    => $meta_keys,
					'source'       => self::source_label( (string) $slug, (array) ( $provides['post_types'] ?? array() ), ! empty( $type->_builtin ) ),
				);
			}

			usort(
				$post_types,
				static function ( $a, $b ) {
					return strcmp( $a['slug'], $b['slug'] );
				}
			);
		}

		$taxonomies = array();
		if ( function_exists( 'get_taxonomies' ) ) {
			foreach ( get_taxonomies( array(), 'objects' ) as $slug => $tax ) {
				if ( empty( $tax->public ) && empty( $tax->show_in_rest ) ) {
					continue;
				}

				$taxonomies[] = array(
					'slug'         => (string) $slug,
					'object_types' => array_values( array_map( 'strval', (array) ( $tax->object_type ?? array() ) ) ),
					'hierarchical' => (bool) ( $tax->hierarchical ?? false ),
					'show_in_rest' => (bool) ( $tax->show_in_rest ?? false ),
					'rest_base'    => (string) ( ! empty( $tax->rest_base ) ? $tax->rest_base : $slug ),
					'source'       => self::source_label( (string) $slug, (array) ( $provides['taxonomies'] ?? array() ), ! empty( $tax->_builtin ) ),
				);
			}

			usort(
				$taxonomies,
				static function ( $a, $b ) {
					return strcmp( $a['slug'], $b['slug'] );
				}
			);
		}

		$statuses = array();
		if ( function_exists( 'get_post_stati' ) ) {
			foreach ( get_post_stati( array( 'internal' => false ), 'objects' ) as $slug => $status ) {
				$statuses[] = array(
					'slug'      => (string) $slug,
					'label'     => (string) ( $status->label ?? $slug ),
					'public'    => (bool) ( $status->public ?? false ),
					'private'   => (bool) ( $status->private ?? false ),
					'protected' => (bool) ( $status->protected ?? false ),
				);
			}

			usort(
				$statuses,
				static function ( $a, $b ) {
					return strcmp( $a['slug'], $b['slug'] );
				}
			);
		}

		return array(
			'post_types' => $post_types,
			'taxonomies' => $taxonomies,
			'statuses'   => $statuses,
		);
	}

	/**
	 * core | plugin | agent label for a registered name.
	 *
	 * @param string $slug     Registered slug.
	 * @param array  $provides Provides map slug => package for this kind.
	 * @param bool   $builtin  Whether WP marks it _builtin.
	 * @return string
	 */
	private static function source_label( string $slug, array $provides, bool $builtin ): string {
		if ( isset( $provides[ $slug ] ) ) {
			return 'agent';
		}

		return $builtin ? 'core' : 'plugin';
	}

	/*
	 * -------------------------------------------------------------------
	 * Features
	 * -------------------------------------------------------------------
	 */

	/**
	 * Capability matrix, detected from the running instance.
	 *
	 * @return array<string, array{available:bool,detail:string}>
	 */
	public static function features(): array {
		$per_block_css     = false;
		$styles_background = false;
		if ( class_exists( 'WP_Theme_JSON' ) ) {
			// styles.css entered VALID_STYLES in 6.2; styles.background in 6.6.
			// Detect the constant's contents rather than the version number.
			$valid             = (array) ( defined( 'WP_Theme_JSON::VALID_STYLES' ) ? constant( 'WP_Theme_JSON::VALID_STYLES' ) : array() );
			$per_block_css     = array_key_exists( 'css', $valid );
			$styles_background = array_key_exists( 'background', $valid );
		}

		return array(
			'global_styles_background' => array(
				'available' => $styles_background,
				'detail'    => 'WP_Theme_JSON::VALID_STYLES[background]',
			),
			'block_bindings'    => array(
				'available' => class_exists( 'WP_Block_Bindings_Registry' ),
				'detail'    => 'WP_Block_Bindings_Registry',
			),
			'per_block_css'     => array(
				'available' => $per_block_css,
				'detail'    => 'WP_Theme_JSON::VALID_STYLES[css]',
			),
			'interactivity_api' => array(
				'available' => class_exists( 'WP_Interactivity_API' ) || function_exists( 'wp_interactivity_state' ),
				'detail'    => 'WP_Interactivity_API',
			),
			'block_hooks'       => array(
				'available' => function_exists( 'get_hooked_blocks' ),
				'detail'    => 'get_hooked_blocks',
			),
			'pattern_overrides' => array(
				'available' => class_exists( 'WP_Block_Bindings_Registry' ) && function_exists( 'wp_interactivity_state' ),
				'detail'    => 'bindings + interactivity present',
			),
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * Fingerprint stamp
	 * -------------------------------------------------------------------
	 */

	/**
	 * The pure inputs of the platform stamp, assembled from injected pieces.
	 *
	 * @param array $styles_map  block name => [style names].
	 * @param array $sources     binding source names.
	 * @param array $post_types  [{slug, meta_keys}].
	 * @param array $taxonomies  taxonomy slugs.
	 * @param array $variations  block name => [variation names].
	 * @return array
	 */
	public static function platform_stamp_inputs( array $styles_map, array $sources, array $post_types, array $taxonomies, array $variations ): array {
		ksort( $styles_map, SORT_STRING );
		sort( $sources, SORT_STRING );
		sort( $taxonomies, SORT_STRING );
		ksort( $variations, SORT_STRING );

		usort(
			$post_types,
			static function ( $a, $b ) {
				return strcmp( (string) ( $a['slug'] ?? '' ), (string) ( $b['slug'] ?? '' ) );
			}
		);

		return array(
			'block_styles'    => $styles_map,
			'binding_sources' => array_values( $sources ),
			'post_types'      => $post_types,
			'taxonomies'      => array_values( $taxonomies ),
			'variations'      => $variations,
		);
	}

	/**
	 * The platform stamp: sha256 of the canonical platform inputs. A new
	 * post type, taxonomy, meta key, binding source, block style or server
	 * variation moves the fingerprint through this input.
	 *
	 * @return string 64 hex characters.
	 */
	public static function stamp(): string {
		$styles = array();
		foreach ( self::styles_map() as $block_name => $entries ) {
			$styles[ $block_name ] = array_map(
				static function ( $entry ) {
					return (string) $entry['name'];
				},
				$entries
			);
		}

		$sources = array();
		if ( class_exists( 'WP_Block_Bindings_Registry' ) ) {
			$sources = array_map( 'strval', array_keys( WP_Block_Bindings_Registry::get_instance()->get_all_registered() ) );
		}

		$post_types = array();
		if ( function_exists( 'get_post_types' ) ) {
			foreach ( array_keys( get_post_types( array(), 'names' ) ) as $slug ) {
				$meta = function_exists( 'get_registered_meta_keys' ) ? array_keys( get_registered_meta_keys( 'post', (string) $slug ) ) : array();
				sort( $meta, SORT_STRING );
				$post_types[] = array(
					'slug'      => (string) $slug,
					'meta_keys' => array_map( 'strval', $meta ),
				);
			}
		}

		$taxonomies = function_exists( 'get_taxonomies' ) ? array_map( 'strval', array_keys( get_taxonomies( array(), 'names' ) ) ) : array();

		$variations = array();
		if ( class_exists( 'X_Companion_Manifest' ) ) {
			foreach ( X_Companion_Manifest::snapshot_registry() as $name => $block ) {
				$names = array();
				foreach ( (array) ( $block['variations'] ?? array() ) as $variation ) {
					$names[] = (string) ( $variation['name'] ?? '' );
				}
				if ( ! empty( $names ) ) {
					sort( $names, SORT_STRING );
					$variations[ (string) $name ] = $names;
				}
			}
		}

		$inputs = self::platform_stamp_inputs( $styles, $sources, $post_types, $taxonomies, $variations );

		return hash( 'sha256', X_Companion_Manifest::canonical_json( $inputs ) );
	}

	/*
	 * -------------------------------------------------------------------
	 * Helpers
	 * -------------------------------------------------------------------
	 */

	/**
	 * The provides map written by the schema library installer.
	 *
	 * @return array
	 */
	public static function provides(): array {
		if ( ! function_exists( 'get_option' ) ) {
			return array();
		}

		$value = get_option( self::PROVIDES_OPTION, array() );

		return is_array( $value ) ? $value : array();
	}
}
