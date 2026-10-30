import { useCallback, useEffect, useState } from 'react';
import { Image as RNImage, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import PhotoKitPreview from './PhotoKitPreview';
import { supportsNativePhotoPreview } from '../nativePhotoPreview';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * Liquid Glass 环境光背景（v141 · 双缓冲无闪烁）：
 *
 * 双图层缓冲：frontUri（已加载的前台图层）+ nextUri（后台预加载的下一张）。
 * 切换源时旧图保持可见，新图 onLoad 后才替换前台 → 永远不会出现黑闪。
 * 渐变遮罩只在 frontUri 有效时渲染，跟随前台图层，不随加载状态抖动。
 *
 * 取色原理：1/4 屏 RN Image + blurRadius 40 + scale 放大铺满
 * （等效全屏 blurRadius 160，细节全丢只留色域；解码成本 1/16）。
 * Liquid Glass 层：对角渐变暗化 + 斜向镜面高光 + 底部深度阴影。
 */
const BLUR_RADIUS = Platform.OS === 'ios' ? 40 : 28;

function isAllowedUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return false;
  if (uri.startsWith('ph://')) return supportsNativePhotoPreview;
  if (uri.startsWith('assets-library://')) return false;
  return (uri.startsWith('file://') && !/\.(mov|mp4|m4v)(#|$)/i.test(uri)) || uri.startsWith('http://') || uri.startsWith('https://');
}

function BackdropImage({ source, ...props }) {
  // Native path renders the small PhotoKit bitmap and blurs it in Core Image
  // (blurRadius plumbed through PhotoKitPreview); the file/http path lets
  // RN Image blur the bitmap itself.
  return supportsNativePhotoPreview && source.uri.startsWith('ph://')
    ? <PhotoKitPreview uri={source.uri} {...props} priority={2} maxPixelSize={512} purpose="ambient" />
    : <RNImage source={source} {...props} />;
}

export default function AmbientBackdrop({ source, style }) {
  // Double-buffer: frontUri = last successfully loaded image (always visible);
  // nextUri = new source currently loading in the background layer.
  const [frontUri, setFrontUri] = useState(null);
  const [nextUri, setNextUri] = useState(null);
  const { width: winW, height: winH } = useWindowDimensions();

  // Normalize source URI.
  let uri = null;
  if (typeof source === 'string' && source.trim()) {
    uri = source.trim();
  } else if (source && typeof source === 'object') {
    uri = source.displayUri || source.imageUri || source.localUri || source.uri || null;
  }
  const valid = isAllowedUri(uri);

  // When the incoming source changes, queue it as nextUri.
  // The old frontUri stays visible until nextUri finishes loading.
  useEffect(() => {
    const target = valid ? uri : null;
    if (target === frontUri) {
      // Same as currently displayed — clear the pending layer.
      setNextUri(null);
    } else if (target !== nextUri) {
      setNextUri(target);
    }
  }, [uri, valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Liveness retry: a pending layer whose request the native scheduler
  // dropped (memory pressure / window toggle) fires neither onLoad nor
  // onError. Requeue once after a beat so the backdrop heals instead of
  // freezing black forever.
  useEffect(() => {
    if (!valid || !uri || uri === frontUri || nextUri) return;
    const timer = setTimeout(() => {
      setNextUri(current => (current === null ? uri : current));
    }, 1200);
    return () => clearTimeout(timer);
  }, [uri, valid, frontUri, nextUri]);

  // Quarter-screen decode tile (1/16 cost, ~160 effective blur at full screen).
  const tileW = Math.max(1, Math.round(winW / 4));
  const tileH = Math.max(1, Math.round(winH / 4));
  const coverScale = Math.max(winW / tileW, winH / tileH) * 1.15;

  const tileStyle = {
    position: 'absolute',
    top: (winH - tileH) / 2,
    left: (winW - tileW) / 2,
    width: tileW,
    height: tileH,
    transform: [{ scale: coverScale }],
  };

  // Promote nextUri → frontUri once it finishes loading.
  const handleNextLoad = useCallback(() => {
    setFrontUri(nextUri);
    setNextUri(null);
  }, [nextUri]);

  return (
    <View style={[styles.root, style]} pointerEvents="none">
      {/* Back layer: loading the NEXT image; hidden behind front until ready */}
      {nextUri && nextUri !== frontUri ? (
        <BackdropImage
          source={{ uri: nextUri }}
          style={tileStyle}
          resizeMode="cover"
          blurRadius={BLUR_RADIUS}
          onLoad={handleNextLoad}
          onError={() => setNextUri(null)}
        />
      ) : null}

      {/* Front layer: the currently displayed image (stable, never flashes) */}
      {frontUri ? (
        <BackdropImage
          source={{ uri: frontUri }}
          style={tileStyle}
          resizeMode="cover"
          blurRadius={BLUR_RADIUS}
        />
      ) : null}

      {/* Liquid Glass overlays — gated to frontUri, never flicker on load */}
      {frontUri ? (
        <>
          <LinearGradient
            colors={['rgba(0,0,0,0.30)', 'rgba(0,0,0,0.48)', 'rgba(0,0,0,0.62)']}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.02)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.85, y: 0.55 }}
            style={styles.topSheen}
          />
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.30)']}
            style={styles.bottomShade}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  topSheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '50%',
  },
  bottomShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '42%',
  },
});
