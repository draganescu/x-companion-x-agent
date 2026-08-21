/**
 * GET /harness — the Tree IR compiler page. CONTRACT.md §6, milestone M4.
 *
 *   node --test x-companion/tests/harness.spec.ts
 *
 * Attaches to instances that tools/playground/boot.mjs has already booted; it
 * does not boot anything itself, so it can be pointed at a warm sandbox while
 * iterating. tests/run-all.sh boots what this needs.
 *
 *   X_RUNTIME_CORE_ONLY        default tools/.runtime/core-only-toolchain.json
 *   X_RUNTIME_CORE_PLUS_SUITE  default tools/.runtime/core-plus-suite-toolchain.json
 *
 * Uses node's built-in test runner and node's native TypeScript stripping, so
 * the only dependency is Playwright, which env.mjs resolves out of
 * tools/node_modules. See tests/package.json.
 *
 * The Playwright trap this file deliberately does not re-discover: `httpCredentials`
 * alone does NOT authenticate a page navigation against WordPress, because Chromium
 * only replays Basic auth after a 401 carrying `WWW-Authenticate`, which
 * `rest_forbidden` does not send. `env.harnessPage()` sets an explicit
 * `Authorization` header as well; that is why this file goes through it rather
 * than driving Playwright directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withRunningInstance, runtimePath } from '../../proof/lib/env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

/**
 * Core blocks that exist server-side but are never registered client-side by
 * `registerCoreBlocks()`: the widget-bridge pair and the deprecated comments
 * alias. Pinned exactly rather than tolerated loosely — if this set grows, the
 * harness has lost blocks and the assertion must fail.
 */
const SERVER_ONLY_CORE_BLOCKS = ['core/legacy-widget', 'core/post-comments', 'core/widget-group'];

/** Resolve a runtime descriptor, failing loudly rather than skipping. */
function runtimeFor(profile: string, envVar: string): string {
	const file = process.env[envVar] ?? runtimePath(profile, 'toolchain');

	if (!fs.existsSync(file)) {
		throw new Error(
			`No runtime descriptor at ${file}.\n` +
			`Boot the instance first:\n` +
			`  node tools/playground/boot.mjs --profile ${profile} --posture toolchain --plugin ./x-companion\n` +
			`or run the whole suite with: bash x-companion/tests/run-all.sh`,
		);
	}

	return file;
}

/** The compiler's contract-shaped output, or its error envelope. */
async function compile(page, blocks) {
	return page.evaluate((tree) => (window as any).__compile(tree), blocks);
}

test('harness on core-only', async (t) => {
	const runtime = runtimeFor('core-only', 'X_RUNTIME_CORE_ONLY');

	await withRunningInstance({ profile: 'core-only', posture: 'toolchain', runtime }, async (env) => {
		const manifest = (await env.call('GET', '/x-companion/v1/manifest')).json;
		const page = await env.harnessPage();
		const registry = await page.evaluate(() => (window as any).__registry());

		await t.test('the page loads over Basic auth and is not degraded', async () => {
			assert.equal(page.__degradedHeader, null, 'X-Harness-Degraded must be absent on a healthy instance');
			assert.deepEqual(page.__pageErrors, [], 'the harness page must load without console errors');
		});

		await t.test('window.__version is the interfaces version', async () => {
			assert.equal(await page.evaluate(() => (window as any).__version), '1');
		});

		await t.test('window.__ready resolves and __registry() returns names', async () => {
			assert.ok(Array.isArray(registry), '__registry() must return an array');
			assert.ok(registry.length > 100, `expected a full core registry, got ${registry.length} blocks`);
			assert.ok(registry.includes('core/paragraph'), 'core/paragraph must be registered client-side');
		});

		await t.test('__registry() is a superset of manifest.blocks, bar the server-only trio', async () => {
			// agent/* is excluded on purpose: an installed agent block only reaches
			// wp.blocks when it opts in with supports.autoRegister, which is the very
			// registry gap the next case is about (and which another suite sharing
			// this instance may be exercising right now).
			const declared = Object.keys(manifest.blocks).filter((name) => !name.startsWith('agent/'));
			const missing = declared.filter((name) => !registry.includes(name)).sort();

			assert.deepEqual(
				missing,
				[...SERVER_ONLY_CORE_BLOCKS].sort(),
				`blocks in the manifest that failed to register client-side: ${JSON.stringify(missing)}`,
			);
		});

		await t.test('an installed agent block auto-registers and compiles', async () => {
			// A dynamic block ships no editor script, so nothing calls
			// registerBlockType() for it client-side. WordPress 7.0 added the opt-in:
			// `supports.autoRegister: true` on a block with a render callback makes
			// _wp_enqueue_auto_register_blocks() list it in
			// window.__unstableAutoRegisterBlocks, and registerCoreBlocks() then
			// registers it from the server-side bootstrap with a ServerSideRender edit.
			// That hook hangs off enqueue_block_editor_assets, which the harness fires.
			const zip = path.join(FIXTURES, 'packages', 'agent-testimonial.zip');
			assert.ok(fs.existsSync(zip), 'run x-companion/fixtures/packages/build.sh first');

			const installed = await env.call('POST', '/x-companion/v1/blocks/install', {
				multipart: [{ name: 'package', filePath: zip }],
			});
			assert.equal(installed.status, 200, `install failed: ${JSON.stringify(installed.json)}`);

			try {
				const fresh = await env.harnessPage();
				const names = await fresh.evaluate(() => (window as any).__registry());

				assert.ok(
					names.includes('agent/testimonial'),
					'a block declaring supports.autoRegister must reach wp.blocks; without it the harness cannot compile it',
				);

				const out = await compile(fresh, [
					{ name: 'agent/testimonial', attributes: { quote: 'Compiled by the harness' } },
				]);

				assert.equal(out.error, undefined, `__compile threw: ${out.error}`);
				assert.equal(out.all_valid, true, `invalid blocks: ${JSON.stringify(out.invalid)}`);
				assert.match(
					out.markup,
					/<!-- wp:agent\/testimonial \{"quote":"Compiled by the harness"\} \/-->/,
					`a dynamic block serializes as a self-closing delimiter, got: ${out.markup}`,
				);
			} finally {
				await env.call('DELETE', '/x-companion/v1/blocks/library/testimonial');
			}
		});

		await t.test('__compile(valid-core.blocks) round-trips to fully valid markup', async () => {
			const tree = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'trees', 'valid-core.json'), 'utf8'));
			const out = await compile(page, tree.blocks);

			assert.equal(out.error, undefined, `__compile threw: ${out.error}`);
			assert.equal(out.all_valid, true, `invalid blocks: ${JSON.stringify(out.invalid)}`);
			assert.deepEqual(out.invalid, []);
			assert.match(out.markup, /<!-- wp:/, 'markup must carry block delimiters');
			assert.match(out.markup, /<!-- wp:group/, 'the root block of the fixture is a group');
			assert.match(out.markup, /<p>Three projects, one year\.<\/p>/, 'attributes reached the save output');
		});

		await t.test('a deliberately broken tree comes back with a non-empty invalid[]', async () => {
			// Derived from the live registry, not from memory: core/heading declares
			// `level` as a number, so a string level survives createBlock (which does
			// not type-check) but is discarded by parse (which does), and the two
			// save outputs no longer agree.
			assert.equal(manifest.blocks['core/heading'].attributes.level.type, 'number');

			const out = await compile(page, [
				{ name: 'core/heading', attributes: { level: 'two', content: 'Broken' } },
			]);

			assert.equal(out.error, undefined, `__compile threw: ${out.error}`);
			assert.equal(out.all_valid, false);
			assert.equal(out.invalid.length, 1, JSON.stringify(out.invalid));
			assert.equal(out.invalid[0].path, '/0', 'the path is an RFC 6901 pointer rooted at the passed array');
			assert.equal(out.invalid[0].name, 'core/heading');
			assert.ok(out.invalid[0].validation_issues.length > 0, 'validation_issues must survive serialization');
		});

		await t.test('a nested broken block reports its full pointer', async () => {
			const out = await compile(page, [
				{
					name: 'core/group',
					attributes: {},
					innerBlocks: [
						{ name: 'core/paragraph', attributes: { content: 'fine' } },
						{ name: 'core/heading', attributes: { level: 'nine', content: 'Broken' } },
					],
				},
			]);

			assert.equal(out.all_valid, false);
			assert.deepEqual(out.invalid.map((entry) => entry.path), ['/0/innerBlocks/1']);
		});

		await t.test('__compile never leaves the caller hanging', async () => {
			const notAnArray = await page.evaluate(() => (window as any).__compile('nope'));
			assert.match(notAnArray.error, /array/i);

			const malformed = await compile(page, [{ attributes: {} }]);
			assert.match(malformed.error, /name/i);
		});

		await t.test('a plugin that fatals in enqueue_block_editor_assets degrades the page', async () => {
			// Contract §6.4. The failure has to come from a real plugin on a real
			// request, so one is dropped into the instance's live mu-plugin mount
			// (documented in tools/README.md) for the length of this case.
			const muDir = path.join(HERE, '..', '..', 'tools', '.runtime', 'work', 'core-only-toolchain', 'mu-plugins');
			assert.ok(fs.existsSync(muDir), `expected the live mu-plugin mount at ${muDir}`);

			const file = path.join(muDir, '910-x-harness-fatal.php');

			fs.writeFileSync(
				file,
				[
					'<?php',
					'// Written by x-companion/tests/harness.spec.ts, removed again in the same test.',
					"add_action( 'enqueue_block_editor_assets', function () {",
					"\twp_enqueue_script( 'x-half-enqueued-before-the-fatal', 'https://example.invalid/a.js', array(), '1', true );",
					"\t$screen = get_current_screen();  // null outside admin",
					"\t$screen->is_block_editor();      // fatal: method call on null",
					'} );',
					'',
				].join('\n'),
			);

			try {
				const broken = await env.harnessPage();
				const html = await broken.content();

				assert.equal(
					broken.__degradedHeader,
					'enqueue_block_editor_assets',
					'the response must name the action it skipped',
				);
				assert.doesNotMatch(html, /x-half-enqueued-before-the-fatal/, 'the half-finished enqueue was rolled back');
				assert.doesNotMatch(html, /Fatal error/, 'no PHP error text leaked into the document');
				assert.match(html, /harness\/harness\.js/, 'harness.js is still enqueued last');

				const stillWorks = await broken.evaluate(() => (window as any).__registry());
				assert.ok(stillWorks.includes('core/paragraph'), 'the degraded page is still a working compiler');

				const tree = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'trees', 'valid-core.json'), 'utf8'));
				const out = await compile(broken, tree.blocks);
				assert.equal(out.all_valid, true, `invalid blocks: ${JSON.stringify(out.invalid)}`);
			} finally {
				fs.rmSync(file, { force: true });
			}
		});

		await t.test('an unregistered block is refused, not silently dropped', async () => {
			// wp.blocks.createBlock() accepts an unknown name and serialize() then
			// emits nothing for that subtree — all_valid:true with the content gone.
			// harness.js refuses instead, at any depth.
			const top = await compile(page, [{ name: 'agent/does-not-exist', attributes: {} }]);
			assert.match(top.error, /not registered/, 'an unknown top-level block must be an error');

			const nested = await compile(page, [
				{
					name: 'core/group',
					attributes: {},
					innerBlocks: [{ name: 'agent/does-not-exist', attributes: {} }],
				},
			]);
			assert.match(nested.error, /not registered/, 'an unknown nested block must be an error too');
		});
	});
});

test('harness on core-plus-suite', async (t) => {
	const runtime = runtimeFor('core-plus-suite', 'X_RUNTIME_CORE_PLUS_SUITE');

	await withRunningInstance({ profile: 'core-plus-suite', posture: 'toolchain', runtime }, async (env) => {
		const manifest = (await env.call('GET', '/x-companion/v1/manifest')).json;
		const page = await env.harnessPage();
		const registry = await page.evaluate(() => (window as any).__registry());

		const declared = Object.keys(manifest.blocks);
		const kadenceDeclared = declared.filter((name) => name.startsWith('kadence/'));
		const kadenceMissing = kadenceDeclared.filter((name) => !registry.includes(name));
		const registered = kadenceMissing.length === 0 && kadenceDeclared.length > 0;

		console.log(
			`\n[harness] KADENCE PATH: ${registered ? 'REGISTERED' : 'DEGRADED'} — ` +
			`${kadenceDeclared.length - kadenceMissing.length}/${kadenceDeclared.length} kadence/* blocks reached wp.blocks` +
			(registered ? '' : `\n[harness] registry gap: ${JSON.stringify(kadenceMissing)}`) +
			`\n[harness] X-Harness-Admin-Context: ${page.__degradedHeader === null ? 'page healthy' : 'degraded'}\n`,
		);

		await t.test('the suite is actually installed', async () => {
			assert.ok(
				manifest.suites.some((suite) => suite.slug === 'kadence-blocks'),
				'this instance is not core-plus-suite',
			);
			assert.ok(kadenceDeclared.length > 50, `expected the full Kadence registry, got ${kadenceDeclared.length}`);
		});

		await t.test('either the Kadence blocks compile, or the registry gap is detected', async () => {
			if (!registered) {
				// The documented fallback case: detection is what the contract
				// requires here, so assert the gap is real and reported.
				assert.ok(kadenceMissing.length > 0, 'a degraded run must produce a non-empty registry diff');
				assert.ok(
					kadenceMissing.includes('kadence/rowlayout'),
					`unexpected partial gap: ${JSON.stringify(kadenceMissing)}`,
				);
				return;
			}

			// Attributes come from the live manifest, never from memory.
			const row = manifest.blocks['kadence/rowlayout'];
			const column = manifest.blocks['kadence/column'];

			assert.equal(row.attributes.uniqueID.type, 'string', 'kadence/rowlayout still declares uniqueID');
			assert.equal(row.attributes.columns.type, 'number', 'kadence/rowlayout still declares columns');
			assert.equal(column.attributes.uniqueID.type, 'string', 'kadence/column still declares uniqueID');

			const tree = [
				{
					name: 'kadence/rowlayout',
					attributes: { uniqueID: 'xc-row-1', columns: 2 },
					innerBlocks: [
						{
							name: 'kadence/column',
							attributes: { uniqueID: 'xc-col-1' },
							innerBlocks: [{ name: 'core/paragraph', attributes: { content: 'Left' } }],
						},
						{
							name: 'kadence/column',
							attributes: { uniqueID: 'xc-col-2' },
							innerBlocks: [{ name: 'core/paragraph', attributes: { content: 'Right' } }],
						},
					],
				},
			];

			const out = await compile(page, tree);

			assert.equal(out.error, undefined, `__compile threw: ${out.error}`);
			assert.equal(out.all_valid, true, `invalid blocks: ${JSON.stringify(out.invalid)}`);
			assert.match(out.markup, /<!-- wp:kadence\/rowlayout/, 'the suite block serialized under its own name');
			assert.match(out.markup, /<!-- wp:kadence\/column/, 'the nested suite block serialized too');
			assert.match(out.markup, /<p>Left<\/p>/, 'core blocks nest inside suite blocks');
		});

		await t.test('core blocks still compile with the suite loaded', async () => {
			const tree = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'trees', 'valid-core.json'), 'utf8'));
			const out = await compile(page, tree.blocks);

			assert.equal(out.all_valid, true, `invalid blocks: ${JSON.stringify(out.invalid)}`);
		});
	});
});
