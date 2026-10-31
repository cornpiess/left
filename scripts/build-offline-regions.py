"""Build the offline region index without dependencies or runtime downloads.

Input: cn-atlas 0.1.2, commit 6e83a19923e39f2c0e58a0a7ad29b349b2a71b9f
https://github.com/BarbarossaWang/cn-atlas (ISC). See THIRD_PARTY_NOTICES.md.
Usage: python3 scripts/build-offline-regions.py /path/to/cn-atlas.json
"""
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[1]).read_text())
scale = source['transform']['scale']
translate = source['transform']['translate']
arcs = []
for arc in source['arcs']:
    x = y = 0
    points = []
    for dx, dy in arc:
        x += dx
        y += dy
        points.append([x * scale[0] + translate[0], y * scale[1] + translate[1]])
    arcs.append(points)

def entry(geometry):
    props = geometry['properties']
    parts = [geometry['arcs']] if geometry['type'] == 'Polygon' else geometry['arcs']
    points = [p for polygon in parts for ring in polygon for index in ring
              for p in arcs[index if index >= 0 else ~index]]
    bounds = [round(min(p[0] for p in points), 6)-0.000001, round(min(p[1] for p in points), 6)-0.000001,
              round(max(p[0] for p in points), 6)+0.000001, round(max(p[1] for p in points), 6)+0.000001]
    return [props['id'], props['地名'], props['name'], bounds, parts]

output = {
    'version': 'cn-atlas-0.1.2-6e83a199',
    'license': 'ISC',
    'attribution': (Path(__file__).resolve().parents[1] / 'THIRD_PARTY_NOTICES.md').read_text(),
    'transform': source['transform'], 'arcs': source['arcs'],
    'provinces': [entry(g) for g in source['objects']['provinces']['geometries']],
    'cities': [entry(g) for g in source['objects']['prefectures']['geometries']],
}
path = Path(__file__).resolve().parents[1] / 'src/data/china-regions.json'
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':'))+'\n')
print(f'{len(output["provinces"])} provinces, {len(output["cities"])} cities, {path.stat().st_size} bytes')
