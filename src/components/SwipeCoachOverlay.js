import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { JellyPressable } from './Glass';
import { useI18n } from '../i18n';

// One contextual hint. The rest of the photo remains fully interactive.
export default function SwipeCoachOverlay({ visible, variant = 'browse', onDismiss, style }) {
  const { t } = useI18n();
  const opacity = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: 160, useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false); });
    return () => animation.stop();
  }, [visible, opacity]);
  if (!mounted) return null;
  return (
    <View style={[styles.wrap, style]} pointerEvents="box-none">
      <Animated.View style={[styles.pill, { opacity }]} pointerEvents={visible ? 'auto' : 'none'}>
        <Ionicons name={variant === 'cleanup' ? 'arrow-back' : 'arrow-up'} size={18} color="#C4B5FD" />
        <Text style={styles.text}>{t(variant === 'cleanup' ? 'coach.hintLeft' : 'coach.hintBrowse')}</Text>
        <JellyPressable style={styles.close} onPress={onDismiss} accessibilityLabel={t('coach.gotIt')}>
          <Ionicons name="close" size={18} color="#DAD5E5" />
        </JellyPressable>
      </Animated.View>
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', alignItems: 'center', zIndex: 80, paddingHorizontal: 20, paddingBottom: 118 },
  pill: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, gap: 8, borderRadius: 22, backgroundColor: 'rgba(20,21,30,0.94)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)', maxWidth: 400 },
  text: { color: '#FFF', fontSize: 13, lineHeight: 19, flexShrink: 1, paddingVertical: 10 },
  close: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
