import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, formatBytes } from '../theme';
import { getAssetSizeBytes, getPlaceName, isVideoAsset, loadExif, loadItemBasics, isItemFavorite } from '../media';
import { GlassPanel } from './Glass';

import { useI18n } from '../i18n';

function exifValue(exif, ...keys) {
  for (const key of keys) {
    const value = exif?.[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return '';
}

function DetailLine({ icon, children }) {
  return <View style={styles.detailLine}><Ionicons name={icon} size={13} color={colors.textMuted} /><Text style={styles.detailText}>{children}</Text></View>;
}

// Memoized: HomeScreen re-renders 3-4× per swipe (scrolling/activeIndex/toast
// state flips) and this panel used to reconcile on every one of them. All
// props are stable primitives or the per-item object reference.
function MemoryInfoPanel({ item, groupIndex = 0, groupCount = 1, top }) {
  const [expanded, setExpanded] = useState(false);
  const [place, setPlace] = useState(item?.placeName || '');
  const [placeShort, setPlaceShort] = useState(item?.placeShortName || '');
  const [exif, setExif] = useState(null);
  const [size, setSize] = useState(null);
  const isVideo = isVideoAsset(item);
  const { t, formatLocalizedDate } = useI18n();

  useEffect(() => {
    setExpanded(false);
    setExif(null);
    setSize(null);
    let cancelled = false;
    (async () => {
      await loadItemBasics(item);
      const name = await getPlaceName(item);
      if (!cancelled) {
        setPlace(name);
        setPlaceShort(item?.placeShortName || name);
      }
    })();
    return () => { cancelled = true; };
  }, [item?.id]);

  useEffect(() => {
    if (!expanded) return undefined;
    let cancelled = false;
    Promise.all([loadExif(item), getAssetSizeBytes(item)]).then(([nextExif, nextSize]) => {
      if (!cancelled) {
        setExif(nextExif || {});
        setSize(nextSize > 0 ? nextSize : 0);
      }
    });
    return () => { cancelled = true; };
  }, [expanded, item?.id]);

  if (!item) return null;
  const camera = [exifValue(exif, 'Make'), exifValue(exif, 'Model')].filter((value, index, values) => value && values.indexOf(value) === index).join(' ');
  const dimensions = item.width && item.height ? `${item.width} × ${item.height}` : '';

  return (
    <View style={[styles.wrap, expanded && styles.wrapExpanded, { top }]}>
      <Pressable onPress={() => setExpanded((value) => !value)}>
        <GlassPanel style={styles.panel} radius={23} intensity={40}>
          <View style={styles.topRow}>
            {isItemFavorite(item) ? <Ionicons name="heart" size={17} color={colors.fav} /> : null}
            <Text style={styles.date} numberOfLines={1}>{formatLocalizedDate(item.creationTime) || t('common.appName')}</Text>
            {item.isLive ? <Text style={styles.badge}>{t('home.livePhotoTag')}</Text> : null}
            {isVideo ? <Text style={styles.badge}>{t('home.videoTag')}</Text> : null}
            {groupCount > 1 ? <Text style={styles.badge}>{t('home.burstTag', { current: groupIndex + 1, total: groupCount })}</Text> : null}
          </View>
          {placeShort || place ? <Text style={styles.place} numberOfLines={1}>{placeShort || place}</Text> : null}
          {expanded ? <View style={styles.details}>
            <DetailLine icon="calendar-outline">{formatLocalizedDate(item.creationTime)}</DetailLine>
            {place ? <DetailLine icon="location-outline">{place}</DetailLine> : null}
            {item.filename ? <DetailLine icon="document-outline">{item.filename}</DetailLine> : null}
            {dimensions ? <DetailLine icon="expand-outline">{dimensions}</DetailLine> : null}
            {size === null ? <DetailLine icon="hourglass-outline">{t('common.loading')}</DetailLine> : null}
            {size > 0 ? <DetailLine icon="folder-outline">{formatBytes(size)}</DetailLine> : null}
            {camera ? <DetailLine icon="camera-outline">{camera}</DetailLine> : null}
            {exifValue(exif, 'LensModel', 'LensInfo') ? <DetailLine icon="scan-outline">{exifValue(exif, 'LensModel', 'LensInfo')}</DetailLine> : null}
            {exifValue(exif, 'FNumber', 'ApertureValue') ? <DetailLine icon="aperture-outline">{`ƒ/${exifValue(exif, 'FNumber', 'ApertureValue')}`}</DetailLine> : null}
            {exifValue(exif, 'ExposureTime', 'ShutterSpeedValue') ? <DetailLine icon="timer-outline">{`${exifValue(exif, 'ExposureTime', 'ShutterSpeedValue')}s`}</DetailLine> : null}
            {exifValue(exif, 'ISOSpeedRatings', 'PhotographicSensitivity', 'ISO') ? <DetailLine icon="sunny-outline">{`ISO ${exifValue(exif, 'ISOSpeedRatings', 'PhotographicSensitivity', 'ISO')}`}</DetailLine> : null}
          </View> : null}
        </GlassPanel>
      </Pressable>
    </View>
  );
}

export default memo(MemoryInfoPanel);

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 18, maxWidth: '80%', zIndex: 20 },
  wrapExpanded: { maxWidth: '85%' },
  panel: { minHeight: 46, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center', gap: 3 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'nowrap' },
  date: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  badge: { color: colors.textMuted, fontSize: 9, fontWeight: '600', borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 6, paddingVertical: 2 },
  place: { color: colors.textMuted, fontSize: 12 },
  details: { marginTop: 7, paddingTop: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.18)', gap: 5 },
  detailLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detailText: { color: colors.textMuted, fontSize: 12, flexShrink: 1 },
});
