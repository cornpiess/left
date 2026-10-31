# Offline administrative-area data

`src/data/china-regions.json` is an indexed derivative of **cn-atlas 0.1.2**
by Amll / BarbarossaWang, which declares the **ISC** license in its package
metadata. Source commit: `6e83a19923e39f2c0e58a0a7ad29b349b2a71b9f`.

Source: https://github.com/BarbarossaWang/cn-atlas
Upstream credits: https://github.com/ruiduobao/shengshixian.com (2023 edition).
The original source describes the data as unprojected geographic coordinates.

Copyright (c) Amll

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

Rebuild with `python3 scripts/build-offline-regions.py /path/to/cn-atlas.json`.
The index contains 34 province-level and 372 prefecture-level features; it is
only for coarse photo location labels, not navigation or current legal boundaries.
The original quantized, shared arcs are retained without further simplification;
only bounding boxes and labels are indexed. Decoded geometry and result caches
are bounded. No nearest-city fallback is applied. Outside the bundled
coverage, or when no polygon contains the GPS point, the label is omitted.
