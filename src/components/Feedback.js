import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { useReducedMotion } from '../motion';

import { FEEDBACK, feedbackPosition } from '../feedbackPolicy.mjs';

// Fixed geometry is shared by button, inline and stage feedback.
export function BusyMark({ color = colors.text, visible = true, children }) {
  return <View style={styles.slot} pointerEvents="none" accessible={false}>
    {visible ? <ActivityIndicator size="small" color={color} style={styles.indicator} /> : children}
  </View>;
}

export function FeedbackAction({ label, onPress, disabled = false }) {
  return <Pressable onPress={onPress} onTouchStart={event => event.stopPropagation?.()} onTouchEnd={event => event.stopPropagation?.()} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} style={({ pressed }) => [styles.action, pressed && styles.pressed, disabled && styles.disabled]}>
    <Text style={styles.actionText}>{label}</Text>
  </Pressable>;
}

// Identity + phase are checked synchronously at render time, before effects
// reset their timers, so a previous asset's timer cannot flash on a new card.
export function useFeedbackTiming(identity, loading) {
  const [timing, setTiming] = useState(null);
  useEffect(() => {
    if (!loading) { setTiming(null); return; }
    const reveal = setTimeout(() => setTiming({ identity, detail: false }), FEEDBACK.graceMs);
    const detail = setTimeout(() => setTiming({ identity, detail: true }), FEEDBACK.detailMs);
    return () => { clearTimeout(reveal); clearTimeout(detail); };
  }, [identity, loading]);
  return { visible: loading && timing?.identity === identity, detail: loading && timing?.identity === identity && timing.detail };
}

export default function Feedback({ state = 'loading', identity = 'page', variant = 'stage', title, detail, actionLabel, onAction, hint, progress, style, children }) {
  const loading = state === 'loading';
  const timing = useFeedbackTiming(identity, loading && variant !== 'tile');
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(0)).current;
  const [viewport, setViewport] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const shown = state !== 'ready' && (!loading || timing.visible);
  useEffect(() => {
    if (!shown || variant === 'tile') return;
    if (reduced) { opacity.setValue(1); return; }
    opacity.setValue(0);
    const animation = Animated.timing(opacity, { toValue: 1, duration: FEEDBACK.fadeMs, useNativeDriver: true, isInteraction: false });
    animation.start();
    return () => animation.stop();
  }, [shown, identity, variant, reduced, opacity]);
  if (state === 'ready' || (variant === 'tile' && loading) || !shown) return null;
  if (variant === 'tile') return <View style={[styles.tile, style]} pointerEvents="none"><Text style={styles.tileText}>{title}</Text></View>;
  const caption = loading ? (timing.detail ? title : null) : title;
  const percent = loading && timing.detail && Number.isFinite(progress) && progress > 0 ? ` ${Math.round(Math.min(1, progress) * 100)}%` : '';
  const content = <>
    {loading ? <BusyMark /> : null}
    {caption ? <Text style={[styles.title, loading && styles.loadingText]}>{caption}{percent}</Text> : null}
    {!loading && detail ? <Text style={styles.detail}>{detail}</Text> : null}
    {!loading && actionLabel && onAction ? <FeedbackAction label={actionLabel} onPress={onAction} /> : null}
    {!loading && hint ? <Text style={styles.detail}>{hint}</Text> : null}
    {!loading ? children : null}
  </>;
  if (variant === 'inline') return <Animated.View style={[styles.inline, { opacity }, style]} accessibilityLiveRegion="polite" accessibilityState={{ busy: loading }}>{content}</Animated.View>;
  // The loading mark's centre is at stage centre. Content grows downwards;
  // measured short viewports clamp the whole block inside their safe bounds.
  const position = feedbackPosition(viewport, contentHeight);
  const body = <Animated.View style={[styles.content, position.scroll ? styles.flowContent : viewport ? { top: position.top } : styles.unmeasured]}
    onLayout={event => setContentHeight(event.nativeEvent.layout.height)}
    accessibilityLiveRegion="polite" accessibilityState={{ busy: loading }} pointerEvents="box-none">
    {content}
  </Animated.View>;
  return <Animated.View style={[styles.stage, { opacity }, style]} pointerEvents="box-none" onLayout={event => setViewport(event.nativeEvent.layout.height)}>
    {position.scroll ? <ScrollView style={StyleSheet.absoluteFill} contentContainerStyle={styles.scrollContent}>{body}</ScrollView> : body}
  </Animated.View>;
}

const styles = StyleSheet.create({
  slot: { width: FEEDBACK.slot, height: FEEDBACK.slot, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  indicator: { width: FEEDBACK.indicator, height: FEEDBACK.indicator },
  stage: { ...StyleSheet.absoluteFillObject, zIndex: 20, backgroundColor: 'rgba(0,0,0,0.78)' },
  content: { position: 'absolute', width: '100%', paddingHorizontal: 24, maxWidth: 360, alignSelf: 'center', alignItems: 'center', gap: 10 },
  unmeasured: { top: '50%' },
  flowContent: { position: 'relative' },
  scrollContent: { paddingVertical: 12, alignItems: 'center', flexGrow: 1 },
  title: { color: colors.text, fontSize: 15, lineHeight: 22, textAlign: 'center', flexShrink: 1 },
  loadingText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  detail: { color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center', flexShrink: 1 },
  action: { minHeight: 44, minWidth: 100, maxWidth: '100%', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  actionText: { color: colors.text, fontSize: 14, lineHeight: 20, textAlign: 'center', flexShrink: 1 },
  pressed: { opacity: 0.65 }, disabled: { opacity: 0.4 },
  inline: { backgroundColor: 'rgba(13,14,18,0.92)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' },
  tile: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 8 },
  tileText: { color: colors.textMuted, fontSize: 12, lineHeight: 16, textAlign: 'center' },
});
