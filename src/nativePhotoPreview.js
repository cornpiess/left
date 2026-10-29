import { Platform } from 'react-native';
import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { flightEvent } from './flightRecorder';
const nativeModule = Platform.OS === 'ios' ? requireOptionalNativeModule('MaoqiuPhotoPreview') : null;
export const supportsNativePhotoPreview = Boolean(nativeModule);
export async function addNativeBurstMetadata(items) {
  if (!nativeModule?.getBurstIdentifiers || !items.length) return items;
  // Capture grouping is enrichment. A bridge/version failure must not gate
  // the basic PhotoKit feed; ordinary time grouping still works without it.
  try {
    const bursts = await nativeModule.getBurstIdentifiers(items.map(item => item.id));
    if (!bursts || typeof bursts !== 'object') throw Error('Invalid burst metadata');
    items.forEach(item => { item.nativeBurstId = bursts[item.id] || null; });
  } catch (error) { flightEvent('burst-metadata-unavailable', error?.message || 'unknown'); }
  return items;
}
export const NativePhotoPreview = supportsNativePhotoPreview ? requireNativeViewManager('MaoqiuPhotoPreview') : null;

export function deleteAssetsWithSystemConfirmation(ids, fallback) {
  return nativeModule ? nativeModule.deleteAssets(ids) : fallback(ids);
}

export async function setNativeMediaWindow(requests, interactive, enabled) {
  if (!nativeModule?.setMediaWindow) return;
  return nativeModule.setMediaWindow(requests.map(r => r.id), requests.map(r => r.width), requests.map(r => r.height), interactive, enabled);
}
export async function getNativePerformanceSnapshot() {
  return nativeModule?.getPerformanceSnapshot ? nativeModule.getPerformanceSnapshot() : null;
}

export async function fetchNativeBurstMembers(identifier, offset = 0) {
  try {
    return nativeModule?.getBurstMembers ? await nativeModule.getBurstMembers(identifier, offset, 160) : null;
  } catch (error) { flightEvent('burst-members-unavailable', error?.message || 'unknown'); return null; }
}
export async function accessibleNativeAssetIds(ids) {
  try {
    return nativeModule?.getAccessibleAssetIds ? await nativeModule.getAccessibleAssetIds(ids) : null;
  } catch (error) { flightEvent('asset-validation-fallback', error?.message || 'unknown'); return null; }
}
