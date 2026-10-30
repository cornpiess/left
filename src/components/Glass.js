import { useCallback, useRef } from 'react';
import {
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
 * JellyPressable — MD3 Expressive Spring Physics
 * Press In:  tension=340, friction=35 (tight snap)
 * Press Out: tension=200, friction=22 (organic overshoot rebound)
 */
export function JellyPressable({
  children,
  onPress,
  onLongPress,
  style,
  scaleTo = 0.94,
  haptic = true,
  disabled = false,
  hitSlop,
  accessibilityState,
  accessibilityLabel,
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    if (disabled) return;
    if (haptic) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    }
    Animated.spring(scaleAnim, {
      toValue: scaleTo,
      tension: 340,
      friction: 35,
      useNativeDriver: true,
    }).start();
  }, [disabled, haptic, scaleAnim, scaleTo]);

  const handlePressOut = useCallback(() => {
    if (disabled) return;
    Animated.spring(scaleAnim, {
      toValue: 1,
      tension: 200,
      friction: 22,
      useNativeDriver: true,
    }).start();
  }, [disabled, scaleAnim]);

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
      hitSlop={hitSlop}
      style={pressableStyle}
    >
      <Animated.View style={[{ transform: [{ scale: scaleAnim }] }, style]}>
        {children}
      </Animated.View>
    </Pressable>
  );
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
