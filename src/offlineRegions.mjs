// Pure offline point-in-polygon lookup. Administrative areas are not nearest
// cities: coastlines, islands, exclaves and polygon holes retain their meaning.
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function contains(region, x, y, decodeRing) {
  const [west, south, east, north] = region[3];
  if (x < west || x > east || y < south || y > north) return false;
  return region[4].some(polygon => inRing(x, y, decodeRing(polygon[0])) && !polygon.slice(1).some(hole => inRing(x, y, decodeRing(hole))));
}

export function createOfflineRegionLookup(data) {
  const provinces = new Map(data.provinces.map(province => [province[0].slice(0, 2), province]));
  const cache = new Map();
  const arcCache = new Map();
  const decodeRing = indices => {
    const ring = [];
    for (const index of indices) {
      const id = index < 0 ? ~index : index;
      let arc = arcCache.get(id);
      if (!arc) {
        let x = 0, y = 0;
        arc = data.arcs[id].map(([dx, dy]) => {
          x += dx; y += dy;
          return [x * data.transform.scale[0] + data.transform.translate[0], y * data.transform.scale[1] + data.transform.translate[1]];
        });
        arcCache.set(id, arc);
        if (arcCache.size > 128) arcCache.delete(arcCache.keys().next().value);
      }
      const points = index < 0 ? arc.slice().reverse() : arc;
      for (let i = ring.length ? 1 : 0; i < points.length; i++) ring.push(points[i]);
    }
    return ring;
  };
  return location => {
    const { latitude, longitude } = location || {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return '';
    const key = `${latitude},${longitude}`;
    if (cache.has(key)) {
      const result = cache.get(key); cache.delete(key); cache.set(key, result); return result;
    }
    const city = data.cities.find(region => contains(region, longitude, latitude, decodeRing));
    const province = city ? provinces.get(city[0].slice(0, 2)) : data.provinces.find(region => contains(region, longitude, latitude, decodeRing));
    // Municipality/SAR names appear once. Unknown/out-of-coverage locations
    // stay empty; never invent a nearby city or expose raw GPS as a label.
    const result = [province?.[1], city?.[1]].filter((name, index, names) => name && names.indexOf(name) === index).join(' · ');
    cache.set(key, result);
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return result;
  };
}
