<?php
/**
 * Dependency manifest for edit.js. WordPress reads this file natively beside
 * the script block.json names — no build step generates or updates it. The
 * handles below are the wp.* globals edit.js destructures.
 */
return array(
	'dependencies' => array(
		'wp-blocks',
		'wp-element',
		'wp-i18n',
		'wp-block-editor',
		'wp-components',
		'wp-server-side-render',
	),
	'version'      => '{{version}}',
);
