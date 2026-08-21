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
# Produces, next to this script:
#
#   agent-testimonial.zip      valid dynamic block, single top-level dir
#   agent-testimonial-v2.zip   same block name, different render output
#   agent-static-card.zip      no "render" entry           -> 422 block_policy
#   agent-traversal.zip        carries a ../ zip entry     -> 422 block_policy
#   wrong-namespace.zip        name is evil/testimonial    -> 422 block_policy
#   agent-testimonial-flat.zip the valid block, flat (block.json at zip root)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

command -v python3 >/dev/null 2>&1 || { echo "build.sh needs python3" >&2; exit 2; }

rm -f ./*.zip

python3 - <<'PY'
import os
import pathlib
import zipfile

HERE = pathlib.Path(__file__).parent if '__file__' in dir() else pathlib.Path('.')
HERE = pathlib.Path(os.getcwd())

# Fixed timestamp so a rebuild is byte-identical.
DATE = (2026, 1, 1, 0, 0, 0)


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


def wrapped(source_dir: str, top: str) -> list[tuple[str, bytes]]:
    source = HERE / source_dir
    return [(f'{top}/{rel}', path.read_bytes()) for path, rel in entries(source)]


def flat(source_dir: str) -> list[tuple[str, bytes]]:
    source = HERE / source_dir
    return [(rel, path.read_bytes()) for path, rel in entries(source)]


write('agent-testimonial.zip', wrapped('agent-testimonial', 'agent-testimonial'))
write('agent-testimonial-v2.zip', wrapped('agent-testimonial-v2', 'agent-testimonial'))
write('agent-testimonial-flat.zip', flat('agent-testimonial'))
write('agent-static-card.zip', wrapped('agent-static-card', 'agent-static-card'))
write('wrong-namespace.zip', wrapped('wrong-namespace', 'wrong-namespace'))

# The traversal package: a well-formed block plus one entry that tries to climb
# out of the extraction root.
traversal = wrapped('agent-traversal', 'agent-traversal')
traversal.append(('agent-traversal/../../evil.php', b"<?php // should never be written to disk\n"))
write('agent-traversal.zip', traversal)
PY
