import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import PhotoKitPreview from './PhotoKitPreview';
import Feedback from './Feedback';
import { supportsNativePhotoPreview } from '../nativePhotoPreview';
import { useI18n } from '../i18n';

// A receipt belongs to one asset and retry cycle. The renderer stays mounted
// while status changes; retryVersion reaches PhotoKit without clearing its image.
export default function MediaPreview({ assetId, uri, style, purpose, active = true, variant = 'stage', feedback = true, priority = 0, networkAccess = false, resizeMode = 'contain' }) {
  const { t } = useI18n();
  const identity = assetId || uri || 'missing';
  const [receipt, setReceipt] = useState(null);
  const current = useRef(identity); current.current = identity;
  const value = receipt?.identity === identity ? receipt : { identity, state: 'loading', hasImage: false, retry: 0, reason: null, progress: null };
  const cycle = useRef(value.retry); cycle.current = value.retry;
  const retry = value.retry;
  const update = useCallback(change => {
    if (current.current !== identity || cycle.current !== retry) return;
    setReceipt(previous => {
      const base = previous?.identity === identity ? previous : { identity, state: 'loading', hasImage: false, retry, reason: null, progress: null };
      return change(base);
    });
  }, [identity, retry]);
  const matches = useCallback(event => {
    const id = event?.nativeEvent?.assetId;
    return !id || id.replace(/^ph:\/\//, '') === identity.replace(/^ph:\/\//, '');
  }, [identity]);
  const onLoad = useCallback(event => { if (matches(event)) update(base => ({ ...base, state: 'ready', hasImage: true, reason: null })); }, [update, matches]);
  const onError = useCallback(event => { if (matches(event)) update(base => base.hasImage || event?.nativeEvent?.hasImage ? base : { ...base, state: 'error', reason: event?.nativeEvent?.reason || 'unavailable' }); }, [update, matches]);
  const onProgress = useCallback(event => { if (matches(event)) update(base => base.hasImage ? base : { ...base, state: 'loading', reason: null, progress: event?.nativeEvent?.phase === 'cloud' ? event.nativeEvent.progress : null }); }, [update, matches]);
  const retryLoad = useCallback(() => setReceipt(base => ({ identity, state: 'loading', hasImage: base?.identity === identity && base.hasImage, retry: retry + 1, reason: null, progress: null })), [identity, retry]);
  const title = value.reason === 'offline' ? t('home.mediaOffline') : ['permission', 'asset-missing'].includes(value.reason) ? t('home.mediaUnavailable') : t('home.imageLoadFailed');
  const native = supportsNativePhotoPreview && (assetId || uri?.startsWith('ph://'));
  const state = !native && !uri ? 'error' : value.state;
  return <View style={[styles.root, style]}>
    {native ? <PhotoKitPreview assetId={assetId} uri={uri} priority={priority} networkAccess={networkAccess} purpose={purpose}
      retryVersion={retry} style={StyleSheet.absoluteFill} resizeMode={resizeMode} onLoad={onLoad} onError={onError} onProgress={onProgress} />
      : uri ? <ExpoImage key={`${identity}:${retry}`} source={{ uri }} style={StyleSheet.absoluteFill} contentFit={resizeMode === 'cover' ? 'cover' : 'contain'} onLoad={onLoad} onError={onError} cachePolicy="memory-disk" /> : null}
    {active && feedback ? <Feedback identity={`${identity}:${retry}`} variant={variant} state={state}
      title={variant === 'tile' ? t('feedback.unavailable') : state === 'loading' ? t(value.progress === null ? 'home.loadingHint' : 'home.cloudLoading') : title}
      progress={value.progress} actionLabel={t('home.retryBtn')} onAction={retryLoad} /> : null}
  </View>;
}
const styles = StyleSheet.create({ root: { backgroundColor: '#16171D', overflow: 'hidden' } });
