import { useCallback, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { MOTION, settleMotion, useReducedMotion } from '../motion';

/**
 * GlassPanel — MD3 Tonal Surface
 *
 * MD3 spec: Filled/Tonal surfaces use 0dp border. Shape is defined purely by
 * background tint + elevation shadow. Never use sub-pixel (hairlineWidth) borders
 * because fractional pixel values trigger GPU anti-aliasing → "fuzzy" edges.
 *
 * iOS CALayer fix: outer View clips the shape; BlurView fills with absoluteFill
 * so it never gets its own clipping mask (which would create black corners).
 */
export function GlassPanel({
  style,
  intensity = 60,
  tint = 'systemUltraThinMaterialDark',
  radius = 24,
  children,
  border = false,   // MD3 filled surfaces: no border
  shadow = true,
}) {
  return (
    <View
      style={[
        { borderRadius: radius, overflow: 'hidden' },
        shadow && styles.shadow,
        style,
      ]}
    >
      {/* Native iOS UIBlurEffect — fills the clipping View absolutely */}
      <BlurView
        intensity={intensity}
        tint={tint}
        style={StyleSheet.absoluteFill}
      />
      {/* Optional 1dp (integer) border for "outlined" variant only */}
      {border ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: radius,
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.15)',
            },
          ]}
          pointerEvents="none"
        />
      ) : null}
      {children}
    </View>
  );
}

/**
 * JellyPressable — small, immediate compression with a quiet shared return.
 */
export function JellyPressable({
  children,
  onPress,
  onLongPress,
  style,
  scaleTo = MOTION.pressScale,
  haptic = true,
  disabled = false,
  hitSlop,
  accessibilityState,
  accessibilityLabel,
  containerStyle,
  accessibilityRole = 'button',
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReducedMotion();

  const handlePressIn = useCallback(() => {
    if (disabled) return;
    if (haptic) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    }
    settleMotion(scaleAnim, reduceMotion ? 1 : scaleTo, { reduced: reduceMotion, scale: true }).start();
  }, [disabled, haptic, scaleAnim, scaleTo, reduceMotion]);

  const handlePressOut = useCallback(() => {
    settleMotion(scaleAnim, 1, { reduced: reduceMotion, scale: true }).start();
  }, [scaleAnim, reduceMotion]);

  const isAbsolute = style?.position === 'absolute';
  const pressableStyle = isAbsolute
    ? {
        position: 'absolute',
        top: style.top,
        bottom: style.bottom,
        left: style.left,
        right: style.right,
        zIndex: style.zIndex,
      }
    : null;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      hitSlop={hitSlop}
      style={[pressableStyle, containerStyle]}
    >
      <Animated.View style={[{ transform: [{ scale: scaleAnim }] }, style]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

// Width belongs to the actual touch target, not to a percentage-sized child
// of a shrink-wrapped Pressable. Shared by first-run and replay confirmation.
export function PrimaryButton({ label, onPress, disabled = false, loading = false }) {
  return <JellyPressable
    onPress={onPress}
    disabled={disabled || loading}
    accessibilityLabel={label}
    accessibilityState={{ disabled: disabled || loading, busy: loading }}
    containerStyle={styles.primaryContainer}
    style={styles.primaryButton}
  >
    {loading ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryLabel}>{label}</Text>}
  </JellyPressable>;
}

/**
 * GlassButton
 */
export function GlassButton({
  icon,
  iconSize = 22,
  size = 48,
  color = colors.white,
  active,
  activeIcon,
  activeColor = colors.fav,
  label,
  labelColor = colors.white,
  onPress,
  disabled,
}) {
  return (
    <JellyPressable onPress={onPress} disabled={disabled} hitSlop={6} style={styles.btnWrap}>
      <GlassPanel
        style={[styles.btnCircle, { width: size, height: size, borderRadius: size / 2 }]}
        radius={size / 2}
        intensity={55}
      >
        <Ionicons
          name={active && activeIcon ? activeIcon : icon}
          size={iconSize}
          color={active && activeColor ? activeColor : color}
        />
      </GlassPanel>
      {label ? (
        <Text style={[styles.btnLabel, { color: labelColor }]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </JellyPressable>
  );
}

/**
 * GlassPill
 */
export function GlassPill({ children, style, icon, iconColor, iconSize = 13 }) {
  return (
    <GlassPanel style={[styles.pill, style]} radius={16} intensity={45} shadow={false}>
      {icon ? <Ionicons name={icon} size={iconSize} color={iconColor || '#FFFFFF'} /> : null}
      {children}
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  primaryContainer: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  primaryButton: { minHeight: 54, borderRadius: 27, backgroundColor: colors.primary,
    paddingHorizontal: 24, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  primaryLabel: { color: colors.bg, fontSize: 17, lineHeight: 24, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  btnWrap: {
    alignItems: 'center',
    gap: 6,
  },
  btnCircle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnLabel: {
    fontSize: 11,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  shadow: {
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
});
