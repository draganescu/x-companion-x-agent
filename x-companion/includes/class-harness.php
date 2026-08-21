<?php
/**
 * GET /harness — the Tree IR compiler page.
 *
 * Implements CONTRACT.md §6. The page is deliberately the thinnest thing that
 * can host a faithful `wp.blocks` registry:
 *
 *   1. `get_block_editor_server_block_settings()` is printed into an inline
 *      bootstrap for `wp.blocks.unstable__bootstrapServerSideBlockDefinitions`,
 *      exactly as core's editor (and the widgets customiser) does it.
 *   2. `wp-blocks`, `wp-block-library`, `wp-element`, `wp-data`, `wp-dom-ready`
 *      and `wp-i18n` are enqueued.
 *   3. Every `WP_Block_Type`'s `editor_script_handles` are enqueued — this is
 *      how third-party blocks self-register client-side.
 *   4. `enqueue_block_editor_assets` is fired behind a shutdown guard, because
 *      plugins hooking it routinely assume a full admin page. A fatal there
 *      degrades the page instead of killing it: the response is served without
 *      that action and carries `X-Harness-Degraded: enqueue_block_editor_assets`.
 *   5. `harness/harness.js` is enqueued last.
 *
 * No theme, no admin chrome, no editor stores beyond what `wp-data` brings in
 * on its own. The page is a compiler, not an editor.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Harness page.
 */
final class X_Companion_Harness {

	/**
	 * Script handle for harness.js.
	 */
	const SCRIPT_HANDLE = 'x-companion-harness';

	/**
	 * The action that is allowed to fail.
	 */
	const GUARDED_ACTION = 'enqueue_block_editor_assets';

	/**
	 * Script handles the harness always needs, per contract §6.2.
	 *
	 * @var string[]
	 */
	const CORE_HANDLES = array(
		'wp-blocks',
		'wp-block-library',
		'wp-element',
		'wp-data',
		'wp-dom-ready',
		'wp-i18n',
	);

	/**
	 * True once the page body has been written; the shutdown guard is a no-op
	 * from then on.
	 *
	 * @var bool
	 */
	private static $rendered = false;

	/**
	 * True when the guarded action was skipped or blew up.
	 *
	 * @var bool
	 */
	private static $degraded = false;

	/**
	 * Output buffering level when the guard was armed, so the shutdown handler
	 * knows how many buffers belong to it.
	 *
	 * @var int
	 */
	private static $base_ob_level = 0;

	/**
	 * True while the guarded action is on the stack.
	 *
	 * @var bool
	 */
	private static $in_guard = false;

	/**
	 * True when this request entered the editor-side admin context.
	 *
	 * @var bool
	 */
	private static $admin_context = false;

	/**
	 * Hook the dispatched route.
	 *
	 * Runs on `plugins_loaded` (the bootstrap calls it at priority 5), which is
	 * the last moment at which the admin context can still be entered before
	 * `init` fires. See maybe_enter_admin_context().
	 *
	 * @return void
	 */
	public static function init(): void {
		add_filter( 'x_companion_route_harness', array( __CLASS__, 'route' ), 10, 2 );

		self::maybe_enter_admin_context();
	}

	/*
	 * -------------------------------------------------------------------
	 * Admin context (contract §6 deviation, deliberate)
	 * -------------------------------------------------------------------
	 */

	/**
	 * Present this request to other plugins as an editor request.
	 *
	 * Contract §6 step 3 says "for every WP_Block_Type, enqueue all handles in
	 * editor_script_handles". Measured against Kadence Blocks 3.7.9.1: those
	 * handles are declared by the block types but only *registered* from an
	 * `init` callback that starts with `if ( ! is_admin() ) return;`. A REST
	 * request is not admin, so by the time the harness route runs the handles
	 * do not exist, `wp_script_is( $handle, 'registered' )` is false, and all 63
	 * Kadence blocks are missing from `wp.blocks.getBlockTypes()`.
	 *
	 * That is not a client-side registration failure -- which is the risk §6
	 * anticipates and answers with the `__registry()` diff -- it is a
	 * server-side gate, and it is fixable server-side. Defining `WP_ADMIN` for
	 * this one request is enough: `is_admin()` becomes true, the plugin's own
	 * `init` callback registers its handles, step 3 finds them. Nothing else of
	 * the admin bootstrap happens -- `admin_init` is fired by wp-admin/admin.php,
	 * which is not in play here -- so the blast radius is exactly "plugins that
	 * ask is_admin()", on a route whose entire job is to be the editor minus the
	 * editor.
	 *
	 * Default: on in `toolchain` posture (a disposable sandbox whose only
	 * purpose is fidelity), off in `production`. Force either way with
	 *
	 *     define( 'X_COMPANION_HARNESS_ADMIN_CONTEXT', false );
	 *
	 * With it off, the harness is literal §6 and a suite like Kadence shows up
	 * as a `__registry()` gap, which is the documented, detectable outcome.
	 *
	 * @return void
	 */
	private static function maybe_enter_admin_context(): void {
		if ( defined( 'WP_ADMIN' ) ) {
			// A real admin request, or someone already decided.
			return;
		}

		if ( ! self::is_harness_request() ) {
			return;
		}

		$enabled = defined( 'X_COMPANION_HARNESS_ADMIN_CONTEXT' )
			? (bool) X_COMPANION_HARNESS_ADMIN_CONTEXT
			: x_companion_extend_enabled();

		/**
		 * Filters whether the harness request enters the editor-side admin context.
		 *
		 * Only mu-plugins and plugins loading before priority 5 on
		 * `plugins_loaded` can usefully hook this; the constant is the supported
		 * switch for everyone else.
		 *
		 * @param bool $enabled Whether to define WP_ADMIN for this request.
		 */
		if ( ! apply_filters( 'x_companion_harness_admin_context', $enabled ) ) {
			return;
		}

		define( 'WP_ADMIN', true );
		self::$admin_context = true;
	}

	/**
	 * Is this request GET /harness, on either permalink mode?
	 *
	 * @return bool
	 */
	private static function is_harness_request(): bool {
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) ) : 'GET';

		if ( 'GET' !== $method && 'HEAD' !== $method ) {
			return false;
		}

		$uri = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '';

		if ( '' === $uri ) {
			return false;
		}

		// Pretty: /wp-json/x-companion/v1/harness. Plain: /?rest_route=/x-companion/v1/harness.
		return false !== strpos( $uri, '/' . X_COMPANION_REST_NAMESPACE . '/harness' );
	}

	/**
	 * Route handler. Streams the page and exits; it never returns.
	 *
	 * @param mixed           $result  Ignored; the dispatcher's null seed.
	 * @param WP_REST_Request $request Request.
	 * @return void
	 */
	public static function route( $result, $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		self::serve();
	}

	/*
	 * -------------------------------------------------------------------
	 * The page
	 * -------------------------------------------------------------------
	 */

	/**
	 * Build the asset queue, fire the guarded action, render, exit.
	 *
	 * @return void
	 */
	public static function serve(): void {
		self::$base_ob_level = ob_get_level();
		register_shutdown_function( array( __CLASS__, 'on_shutdown' ) );

		self::enqueue_base_assets();

		/*
		 * Contract §6.4. Two layers of protection:
		 *
		 *  - try/catch handles a thrown Throwable, which is the common case
		 *    for a plugin that calls a method on null;
		 *  - the shutdown handler handles a true fatal (E_ERROR), which no
		 *    catch block can see.
		 *
		 * Output is buffered so that a fatal's own error text never lands in
		 * front of the HTML the shutdown handler is about to write.
		 */
		self::$in_guard = true;
		ob_start();

		try {
			do_action( self::GUARDED_ACTION );
			ob_end_clean();
			self::$in_guard = false;

			// Second pass: a suite may register its per-block editor handles
			// from inside that action rather than before it. Re-running step 3
			// is idempotent for handles already enqueued.
			self::enqueue_block_handles();
		} catch ( Throwable $e ) {
			ob_end_clean();
			self::$in_guard = false;
			self::degrade( get_class( $e ) . ': ' . $e->getMessage() );
		}

		self::render();
	}

	/**
	 * Fatal-error net for the guarded action.
	 *
	 * Runs only when the page never made it out. Everything the fatal echoed is
	 * discarded, the asset queue is rebuilt from scratch (so half-finished
	 * enqueues from the failing plugin are gone) and the page is served without
	 * the action.
	 *
	 * @return void
	 */
	public static function on_shutdown(): void {
		if ( self::$rendered ) {
			return;
		}

		$error = error_get_last();
		$fatal = array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR );

		if ( ! is_array( $error ) || ! in_array( (int) ( $error['type'] ?? 0 ), $fatal, true ) ) {
			return;
		}

		while ( ob_get_level() > self::$base_ob_level ) {
			ob_end_clean();
		}

		if ( ! self::$in_guard ) {
			// The fatal came from somewhere we do not own. Do not pretend to
			// have a page.
			return;
		}

		self::$in_guard = false;
		self::degrade( sprintf( '%s in %s:%s', (string) $error['message'], (string) $error['file'], (string) $error['line'] ) );
		self::render();
	}

	/**
	 * Mark the response degraded and rebuild the asset queue without the action.
	 *
	 * @param string $reason Human text for the log.
	 * @return void
	 */
	private static function degrade( string $reason ): void {
		self::$degraded = true;

		self::log(
			sprintf(
				'x-companion harness: %s fataled, serving degraded page. %s',
				self::GUARDED_ACTION,
				$reason
			)
		);

		// Drop whatever the failing plugin managed to enqueue.
		$GLOBALS['wp_scripts'] = null; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		$GLOBALS['wp_styles']  = null; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited

		self::enqueue_base_assets();
	}

	/**
	 * Contract §6 steps 1-3.
	 *
	 * @return void
	 */
	private static function enqueue_base_assets(): void {
		if ( ! function_exists( 'get_block_editor_server_block_settings' ) ) {
			// A pure function library: no top-level side effects, safe outside admin.
			require_once ABSPATH . 'wp-admin/includes/post.php';
		}

		foreach ( self::CORE_HANDLES as $handle ) {
			wp_enqueue_script( $handle );
		}

		$definitions = function_exists( 'get_block_editor_server_block_settings' )
			? get_block_editor_server_block_settings()
			: array();

		wp_add_inline_script(
			'wp-blocks',
			'wp.blocks.unstable__bootstrapServerSideBlockDefinitions(' . wp_json_encode( $definitions, JSON_HEX_TAG | JSON_UNESCAPED_SLASHES ) . ');',
			'after'
		);

		self::enqueue_block_handles();
	}

	/**
	 * Contract §6 step 3 on its own, so it can be run again after step 4.
	 *
	 * @return void
	 */
	private static function enqueue_block_handles(): void {
		foreach ( self::block_script_handles() as $handle ) {
			if ( wp_script_is( $handle, 'registered' ) ) {
				wp_enqueue_script( $handle );
			}
		}
	}

	/**
	 * Every editor script handle declared by a registered block type.
	 *
	 * @return string[] Unique handles, registry order.
	 */
	public static function block_script_handles(): array {
		$handles = array();

		if ( ! class_exists( 'WP_Block_Type_Registry' ) ) {
			return $handles;
		}

		foreach ( WP_Block_Type_Registry::get_instance()->get_all_registered() as $type ) {
			$declared = (array) ( $type->editor_script_handles ?? array() );

			/**
			 * Filters the script handles the harness enqueues for one block type.
			 *
			 * Defaults to `editor_script_handles`, which is how block.json based
			 * blocks self-register client-side. A suite that registers its blocks
			 * from some other handle can add it here.
			 *
			 * @param string[]      $declared Handles.
			 * @param WP_Block_Type $type     Block type.
			 */
			$declared = (array) apply_filters( 'x_companion_harness_block_handles', $declared, $type );

			foreach ( $declared as $handle ) {
				$handle = (string) $handle;
				if ( '' !== $handle && ! in_array( $handle, $handles, true ) ) {
					$handles[] = $handle;
				}
			}
		}

		return $handles;
	}

	/**
	 * Contract §6 step 5, then write the document and stop.
	 *
	 * @return void
	 */
	private static function render(): void {
		self::$rendered = true;

		wp_enqueue_script(
			self::SCRIPT_HANDLE,
			X_COMPANION_URL . 'harness/harness.js',
			self::CORE_HANDLES,
			X_COMPANION_VERSION,
			true
		);

		if ( ! headers_sent() ) {
			// The REST server already sent application/json; header() replaces.
			header( 'Content-Type: text/html; charset=utf-8' );
			header( 'Cache-Control: no-store, no-cache, must-revalidate, max-age=0' );
			header( 'X-Robots-Tag: noindex, nofollow' );
			header( 'X-Harness-Version: ' . X_COMPANION_INTERFACES_VERSION );
			header( 'X-Harness-Admin-Context: ' . ( self::$admin_context ? '1' : '0' ) );

			if ( self::$degraded ) {
				header( 'X-Harness-Degraded: ' . self::GUARDED_ACTION );
			}
		}

		echo "<!DOCTYPE html>\n";
		echo '<html lang="' . esc_attr( str_replace( '_', '-', get_locale() ) ) . "\">\n";
		echo "<head>\n";
		echo '<meta charset="' . esc_attr( get_bloginfo( 'charset' ) ) . "\">\n";
		echo '<meta name="viewport" content="width=device-width, initial-scale=1">' . "\n";
		echo '<meta name="robots" content="noindex, nofollow">' . "\n";
		echo "<title>x-companion harness</title>\n";
		echo "<style>body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:1rem;color:#1e1e1e;background:#fff}</style>\n";
		wp_print_styles();
		echo "</head>\n";
		echo '<body class="x-companion-harness">' . "\n";
		echo '<div id="x-companion-harness-root" hidden></div>' . "\n";
		printf(
			'<p>x-companion harness, interfaces v%1$s.%2$s</p>' . "\n",
			esc_html( X_COMPANION_INTERFACES_VERSION ),
			self::$degraded ? ' <strong>degraded: ' . esc_html( self::GUARDED_ACTION ) . ' was skipped</strong>' : ''
		);
		wp_print_scripts();
		echo "</body>\n</html>\n";

		exit;
	}

	/**
	 * Log without depending on WP_DEBUG_LOG being on.
	 *
	 * @param string $message Message.
	 * @return void
	 */
	private static function log( string $message ): void {
		if ( function_exists( 'error_log' ) ) {
			error_log( $message ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		}
	}
}
