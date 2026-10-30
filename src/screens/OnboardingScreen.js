import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, AppState, Easing, Linking, Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as MediaLibrary from 'expo-media-library/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JellyPressable } from '../components/Glass';
import { useI18n } from '../i18n';
import { colors } from '../theme';

// One value screen. The animation demonstrates the gesture; no practice gate.
export default function OnboardingScreen({ onComplete }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [requesting, setRequesting] = useState(false);
  const [denied, setDenied] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [foreground, setForeground] = useState(true);
  const busy = useRef(false);
  const completed = useRef(false);
  const swipe = useRef(new Animated.Value(0)).current;
  const cardWidth = Math.min(190, width * 0.45);
  const finish = permission => {
    if (completed.current) return;
    completed.current = true;
    onComplete?.(permission);
  };

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive) setReduceMotion(value); }).catch(() => {});
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const app = AppState.addEventListener('change', async next => {
      setForeground(next === 'active');
      if (next !== 'active' || !denied) return;
      try {
        const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        if (alive && permission.granted) finish(permission);
      } catch {}
    });
    return () => { alive = false; motion.remove(); app.remove(); };
  }, [denied, onComplete]);

  useEffect(() => {
    swipe.setValue(0);
    if (reduceMotion || !foreground) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(1100),
      Animated.timing(swipe, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(650),
      Animated.timing(swipe, { toValue: 0, duration: 450, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [swipe, reduceMotion, foreground]);

  const start = async () => {
    if (busy.current) return;
    if (denied) { try { await Linking.openSettings(); } catch {} return; }
    busy.current = true;
    setRequesting(true);
    try {
      if (Platform.OS !== 'ios') { finish(); return; }
      const permission = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      if (permission.granted) finish(permission);
      else setDenied(true);
    } catch {
      // The existing permission gate handles unsupported/retry states.
      finish();
    } finally { busy.current = false; setRequesting(false); }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 20 }]}>
      <Text style={styles.brand}>{t('common.appName')}</Text>
      <View style={styles.visual} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View style={[styles.backCard, { width: cardWidth, height: cardWidth * 1.3, transform: [{ rotate: '7deg' }, { translateX: 12 }] }]} />
        <Animated.View style={{ transform: [{ translateX: swipe.interpolate({ inputRange: [0, 1], outputRange: [0, -64] }) }, { rotate: '-6deg' }] }}>
          <LinearGradient colors={['#C4B5FD', '#6D28D9']} style={[styles.photo, { width: cardWidth, height: cardWidth * 1.3 }]}>
            <View style={styles.sun} />
            <Ionicons name="mountain-outline" size={cardWidth * 0.68} color="rgba(255,255,255,0.7)" />
            <View style={styles.swipeLabel}><Ionicons name="arrow-back" size={20} color="#FFF" /><Text style={styles.swipeText}>{t('coach.hintLeft')}</Text></View>
          </LinearGradient>
        </Animated.View>
      </View>
      <Text style={styles.title} accessibilityRole="header">{t('onboarding.introTitle')}</Text>
      <Text style={styles.subtitle}>{t('onboarding.introSub')}</Text>
      <View style={styles.footer}>
        <Text style={styles.privacy}>{t('onboarding.privacyBody')}</Text>
        {denied ? <Text style={styles.denied}>{t('onboarding.privacyDenied')}</Text> : null}
        <JellyPressable style={styles.cta} onPress={start} disabled={requesting} accessibilityLabel={t(denied ? 'onboarding.privacySettingsBtn' : 'onboarding.startBtn')} accessibilityState={{ busy: requesting }}>
          {requesting ? <ActivityIndicator color="#111827" /> : <Text style={styles.ctaText}>{t(denied ? 'onboarding.privacySettingsBtn' : 'onboarding.startBtn')}</Text>}
        </JellyPressable>
        {denied ? <JellyPressable style={styles.secondary} onPress={() => finish()}><Text style={styles.privacy}>{t('onboarding.privacyNotNow')}</Text></JellyPressable> : null}
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 28 },
  brand: { color: '#C4B5FD', fontWeight: '700', fontSize: 18 },
  visual: { flex: 1, minHeight: 310, width: '100%', justifyContent: 'center', alignItems: 'center', paddingVertical: 34 },
  photo: { borderRadius: 24, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 20, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  backCard: { position: 'absolute', borderRadius: 24, backgroundColor: '#35274D', borderWidth: 1, borderColor: '#695681' },
  sun: { position: 'absolute', width: 48, height: 48, borderRadius: 24, backgroundColor: '#EDE9FE', top: 28, right: 24 },
  swipeLabel: { flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 12 },
  swipeText: { color: '#FFF', fontSize: 12, fontWeight: '700', flexShrink: 1 },
  title: { color: colors.text, fontSize: 29, fontWeight: '800', textAlign: 'center', maxWidth: 420 },
  subtitle: { color: '#D0CADC', fontSize: 16, lineHeight: 24, textAlign: 'center', marginTop: 14, maxWidth: 420 },
  footer: { width: '100%', maxWidth: 420, paddingTop: 30, gap: 16 },
  privacy: { color: '#A9A5B3', fontSize: 12, lineHeight: 18, textAlign: 'center' },
  denied: { color: '#FFB4BD', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  cta: { minHeight: 54, borderRadius: 27, backgroundColor: '#FFF', padding: 14, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: '#111827', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
