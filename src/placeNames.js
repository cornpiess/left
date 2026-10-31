import { createOfflineRegionLookup } from './offlineRegions.mjs';

let lookup = null;
export function getOfflinePlaceName(location) {
  if (!Number.isFinite(location?.latitude) || !Number.isFinite(location?.longitude)) return '';
  // Parse the bundled index only when a displayed photo actually has GPS.
  // No geocoding service, device-location permission or runtime downloads.
  lookup ||= createOfflineRegionLookup(require('./data/china-regions.json'));
  return lookup(location);
}
