#!/usr/bin/env bash
#
# Build the block install fixtures.
#
#   bash x-companion/fixtures/packages/build.sh
#
# Only the source directories are committed; every .zip in this directory is
# generated here. Python's zipfile is used rather than the `zip` CLI because one
# fixture needs an entry name (`../evil.php`) that no sane archiver will write.
#
# A valid package is a standard WordPress plugin zip: one top-level directory
# `agent-block-{slug}/` holding the plugin main file `agent-block-{slug}.php`
# and the block directory `{slug}/` with block.json at its root.
#
# Produces, next to this script:
#
#   agent-testimonial.zip      valid plugin package (agent-block-testimonial/)
#   agent-testimonial-v2.zip   same block name, different render output
#   agent-testimonial-flat.zip block files at the zip root  -> 422 block_policy
#   agent-static-card.zip      no "render" entry            -> 422 block_policy
#   agent-traversal.zip        carries a ../ zip entry      -> 422 block_policy
#   wrong-namespace.zip        name is evil/testimonial     -> 422 block_policy
#   agent-no-main.zip          plugin main file missing     -> 422 block_policy

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

command -v python3 >/dev/null 2>&1 || { echo "build.sh needs python3" >&2; exit 2; }

rm -f ./*.zip

python3 - <<'PY'
import os
import pathlib
import zipfile

HERE = pathlib.Path(os.getcwd())

# Fixed timestamp so a rebuild is byte-identical.
DATE = (2026, 1, 1, 0, 0, 0)

PLUGIN_MAIN = """<?php
/**
 * Plugin Name:       Agent block: {title}
 * Description:       Test fixture package for the x-companion block library.
 * Version:           {version}
 * Requires at least: 6.5
 * Requires PHP:      8.1
 * License:           GPL-2.0-or-later
 */

defined( 'ABSPATH' ) || exit;

add_action( 'init', static function () {{ register_block_type( __DIR__ . '/{slug}' ); }} );
"""


def entries(source: pathlib.Path):
    for path in sorted(source.rglob('*')):
        if path.is_file():
            yield path, str(path.relative_to(source)).replace(os.sep, '/')


def write(zip_name: str, members: list[tuple[str, bytes]]):
    target = HERE / zip_name
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members:
            info = zipfile.ZipInfo(name, DATE)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, payload)
    print(f'{zip_name}: {len(members)} entries, {target.stat().st_size} bytes')


def plugin(source_dir: str, slug: str, version: str, with_main: bool = True) -> list[tuple[str, bytes]]:
    """Canonical plugin layout: agent-block-{slug}/agent-block-{slug}.php + agent-block-{slug}/{slug}/..."""
    source = HERE / source_dir
    root = f'agent-block-{slug}'
    members = [(f'{root}/{slug}/{rel}', path.read_bytes()) for path, rel in entries(source)]
    if with_main:
        main = PLUGIN_MAIN.format(title=slug, version=version, slug=slug)
        members.insert(0, (f'{root}/{root}.php', main.encode()))
    return members


def flat(source_dir: str) -> list[tuple[str, bytes]]:
    source = HERE / source_dir
    return [(rel, path.read_bytes()) for path, rel in entries(source)]


write('agent-testimonial.zip', plugin('agent-testimonial', 'testimonial', '1.0.0'))
write('agent-testimonial-v2.zip', plugin('agent-testimonial-v2', 'testimonial', '2.0.0'))

# Flat block files at the zip root: no longer a valid package — a package is a
# plugin directory. Kept as a policy fixture.
write('agent-testimonial-flat.zip', flat('agent-testimonial'))

write('agent-static-card.zip', plugin('agent-static-card', 'static-card', '1.0.0'))

# The namespace fixture uses a canonical root so analysis reaches the
# block.json name check (the reason under test).
write('wrong-namespace.zip', plugin('wrong-namespace', 'testimonial', '1.0.0'))

# The plugin main file is required.
write('agent-no-main.zip', plugin('agent-testimonial', 'testimonial', '1.0.0', with_main=False))

# The traversal package: a well-formed package plus one entry that tries to
# climb out of the extraction root.
traversal = plugin('agent-traversal', 'traversal', '1.0.0')
traversal.append(('agent-block-traversal/../../evil.php', b"<?php // should never be written to disk\n"))
write('agent-traversal.zip', traversal)
PY
