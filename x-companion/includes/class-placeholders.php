<?php
/**
 * POST /placeholder — solid-colour pixel placeholder media.
 *
 * The default way an agent builds a page before real imagery exists: a 1×1
 * solid-colour GIF is created in the media library and stretched by block
 * attributes (width/aspectRatio/scale, or imageFill on media-text). The
 * layout is final from day one; only the pixels are provisional. The image
 * node in the tree carries `metadata.imageIntent` — a prose description of
 * the picture that should eventually live there — which a later
 * image-generation pass reads via POST /parse, fulfils, and swaps in.
 *
 * The route is idempotent per colour: asking twice for `#e29b2c` returns the
 * same attachment. Colours may be given as a hex value or as a palette slug
 * from the instance's global settings, so the placeholder always lands on
 * the design system.
 *
 * Extend tier on purpose: it mutates the media library, and page fabrication
 * belongs on a toolchain-posture sandbox, never a production instance.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pixel placeholder attachments.
 */
class X_Companion_Placeholders {

	/**
	 * Hook the dispatched route.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_filter( 'x_companion_route_placeholder', array( __CLASS__, 'route_placeholder' ), 10, 2 );
	}

	/**
	 * POST /placeholder.
	 *
	 * Input:  { color: "#rrggbb" | palette slug }
	 * Output: { id, url, color, slug, reused }
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function route_placeholder( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$color  = strtolower( trim( (string) $request->get_param( 'color' ) ) );
		$width  = max( 1, min( 4000, (int) ( $request->get_param( 'width' ) ?: 1 ) ) );
		$height = max( 1, min( 4000, (int) ( $request->get_param( 'height' ) ?: 1 ) ) );

		if ( ! preg_match( '/^#[0-9a-f]{6}$/', $color ) ) {
			$resolved = self::resolve_palette_slug( $color );

			if ( null === $resolved ) {
				return new WP_Error(
					'invalid_color',
					sprintf(
						/* translators: %s: the rejected colour value. */
						__( '"%s" is neither a #rrggbb value nor a palette slug on this instance.', 'x-companion' ),
						$color
					),
					array(
						'status' => 400,
						'hint'   => __( 'Pass a 6-digit hex colour, or a slug from the manifest\'s theme_tokens palette.', 'x-companion' ),
					)
				);
			}

			$color = $resolved;
		}

		$hex   = ltrim( $color, '#' );
		$sized = $width > 1 || $height > 1;
		$slug  = $sized ? sprintf( 'x-pixel-%s-%dx%d', $hex, $width, $height ) : 'x-pixel-' . $hex;

		$existing = get_posts(
			array(
				'post_type'      => 'attachment',
				'name'           => $slug,
				'post_status'    => 'inherit',
				'posts_per_page' => 1,
				'fields'         => 'ids',
			)
		);

		if ( ! empty( $existing ) ) {
			$id = (int) $existing[0];

			return array(
				'id'     => $id,
				'url'    => (string) wp_get_attachment_url( $id ),
				'color'  => '#' . $hex,
				'slug'   => $slug,
				'reused' => true,
			);
		}

		$r = (int) hexdec( substr( $hex, 0, 2 ) );
		$g = (int) hexdec( substr( $hex, 2, 2 ) );
		$b = (int) hexdec( substr( $hex, 4, 2 ) );

		// Sized placeholders are PNG (built without GD, so it works on any
		// PHP); the classic stretchable pixel stays a 1×1 GIF. A sized file
		// matters wherever the markup is not ours to stretch — e.g.
		// WooCommerce product images, which render at intrinsic size.
		$bytes  = $sized ? self::png_bytes( $width, $height, $r, $g, $b ) : self::gif_bytes( $r, $g, $b );
		$upload = wp_upload_bits( $slug . ( $sized ? '.png' : '.gif' ), null, $bytes );

		if ( ! empty( $upload['error'] ) ) {
			return new WP_Error(
				'placeholder_write_failed',
				(string) $upload['error'],
				array( 'status' => 500 )
			);
		}

		$id = wp_insert_attachment(
			array(
				'post_title'     => $slug,
				'post_name'      => $slug,
				'post_mime_type' => $sized ? 'image/png' : 'image/gif',
				'post_status'    => 'inherit',
			),
			$upload['file']
		);

		if ( is_wp_error( $id ) || 0 === $id ) {
			return new WP_Error(
				'placeholder_write_failed',
				__( 'Could not create the placeholder attachment.', 'x-companion' ),
				array( 'status' => 500 )
			);
		}

		require_once ABSPATH . 'wp-admin/includes/image.php';
		wp_update_attachment_metadata( $id, (array) wp_generate_attachment_metadata( $id, $upload['file'] ) );

		return array(
			'id'     => (int) $id,
			'url'    => (string) $upload['url'],
			'color'  => '#' . $hex,
			'slug'   => $slug,
			'reused' => false,
		);
	}

	/**
	 * Resolve a palette slug to its hex value via global settings.
	 *
	 * User-origin (custom) entries win over theme entries, which win over
	 * core defaults — the same precedence the editor shows.
	 *
	 * @param string $slug Candidate palette slug.
	 * @return string|null Lowercase #rrggbb, or null when unknown.
	 */
	private static function resolve_palette_slug( string $slug ): ?string {
		if ( '' === $slug || ! preg_match( '/^[a-z0-9-]+$/', $slug ) ) {
			return null;
		}

		$palette = wp_get_global_settings( array( 'color', 'palette' ) );

		if ( ! is_array( $palette ) ) {
			return null;
		}

		foreach ( array( 'custom', 'theme', 'default' ) as $origin ) {
			if ( empty( $palette[ $origin ] ) || ! is_array( $palette[ $origin ] ) ) {
				continue;
			}

			foreach ( $palette[ $origin ] as $entry ) {
				if ( is_array( $entry ) && isset( $entry['slug'], $entry['color'] ) && $slug === $entry['slug'] ) {
					$color = strtolower( (string) $entry['color'] );

					return preg_match( '/^#[0-9a-f]{6}$/', $color ) ? $color : null;
				}
			}
		}

		return null;
	}

	/**
	 * A solid-colour 8-bit RGB PNG of arbitrary size, built without GD.
	 *
	 * PNG needs only zlib (always compiled into PHP) and crc32: signature,
	 * IHDR, one IDAT holding every row (filter byte 0 + repeated pixel),
	 * IEND.
	 *
	 * @param int $w Width in pixels.
	 * @param int $h Height in pixels.
	 * @param int $r Red 0-255.
	 * @param int $g Green 0-255.
	 * @param int $b Blue 0-255.
	 * @return string Binary PNG bytes.
	 */
	private static function png_bytes( int $w, int $h, int $r, int $g, int $b ): string {
		$ihdr = pack( 'N2', $w, $h ) . "\x08\x02\x00\x00\x00";
		$row  = "\x00" . str_repeat( chr( $r ) . chr( $g ) . chr( $b ), $w );
		$idat = gzcompress( str_repeat( $row, $h ), 6 );

		return "\x89PNG\r\n\x1a\n"
			. self::png_chunk( 'IHDR', $ihdr )
			. self::png_chunk( 'IDAT', $idat )
			. self::png_chunk( 'IEND', '' );
	}

	/**
	 * One PNG chunk: length + type + data + CRC.
	 *
	 * @param string $type Four-byte chunk type.
	 * @param string $data Chunk payload.
	 * @return string
	 */
	private static function png_chunk( string $type, string $data ): string {
		return pack( 'N', strlen( $data ) ) . $type . $data . pack( 'N', crc32( $type . $data ) );
	}

	/**
	 * A minimal 1×1 solid-colour GIF89a.
	 *
	 * @param int $r Red 0-255.
	 * @param int $g Green 0-255.
	 * @param int $b Blue 0-255.
	 * @return string Binary GIF bytes.
	 */
	private static function gif_bytes( int $r, int $g, int $b ): string {
		return "GIF89a\x01\x00\x01\x00\x80\x00\x00"
			. chr( $r ) . chr( $g ) . chr( $b )
			. "\x00\x00\x00"
			. "\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b";
	}
}
