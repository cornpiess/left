import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';

function GlassTabItem({ route, focused, onPress }) {
  const bounce = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(bounce, {
      toValue: focused ? 1 : 0,
      useNativeDriver: true,
      friction: 4,
      tension: 190,
    }).start();
  }, [focused, bounce]);

  const focusedIcon = route.name === '回忆' ? 'time' : 'trash';
  const outlineIcon = route.name === '回忆' ? 'time-outline' : 'trash-outline';

  const pillOpacity = bounce.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const lift = bounce.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });
  const pillScale = bounce.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });
  const iconScale = bounce.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const textScale = bounce.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });

  return (
    <Pressable style={styles.item} onPress={onPress} hitSlop={6}>
      <Animated.View
        style={[
          styles.itemPill,
          {
            opacity: pillOpacity,
            transform: [{ translateY: lift }, { scale: pillScale }],
          },
        ]}
      >
        <LinearGradient
          colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.04)']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
        />
      </Animated.View>
      <Animated.View style={{ transform: [{ scale: iconScale }] }}>
        <Ionicons
          name={focused ? focusedIcon : outlineIcon}
          size={22}
          color={focused ? colors.primarySoft : colors.textMuted}
        />
      </Animated.View>
      <Animated.Text
        style={[styles.label, { color: focused ? colors.text : colors.textMuted, transform: [{ scale: textScale }] }]}
      >
        {route.name}
      </Animated.Text>
    </Pressable>
  );
}

export default function GlassTabBar({ state, descriptors, navigation }) {
  const insets = useSafeAreaInsets();
  return (
    <BlurView
      intensity={64}
      tint="systemUltraThinMaterialDark"
      style={[styles.container, { bottom: insets.bottom + 12 }]}
    >
      <LinearGradient
        colors={['rgba(255,255,255,0.24)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0)']}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };
        return <GlassTabItem key={route.key} route={route} focused={focused} onPress={onPress} />;
      })}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 14,
    right: 14,
    height: 62,
    borderRadius: 31,
    flexDirection: 'row',
    padding: 6,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    shadowColor: 'rgba(0,0,0,0.45)',
    shadowOpacity: 1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: 25,
    overflow: 'hidden',
  },
  itemPill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 25,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
  },
});
