#!/usr/bin/env python3
"""Rewrite ONLY the plugin header comment of a gated block package zip.

The functional entries (block.json, render.php, style.css, view.js, build/)
are copied through byte-for-byte; the loader's register_block_type line is
kept verbatim. Writes <zip>-named.zip next to the input.
"""
import re
import sys
import zipfile

zip_path, slug, name, desc = sys.argv[1:5]
loader = f"agent-block-{slug}/agent-block-{slug}.php"
out_path = zip_path.replace(".zip", "-named.zip")

with zipfile.ZipFile(zip_path) as src, zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as dst:
    for info in src.infolist():
        data = src.read(info.filename)
        if info.filename == loader:
            text = data.decode("utf-8")
            text = re.sub(r"\* Plugin Name:\s+.*", f"* Plugin Name:       {name}", text)
            text = re.sub(r"\* Description:\s+.*", f"* Description:       {desc}", text)
            text = re.sub(
                r"(\* License:\s+GPL-2\.0-or-later)",
                r"\1\n * Update URI:        false",
                text,
            )
            data = text.encode("utf-8")
        dst.writestr(info, data)
print(out_path)
