import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JellyPressable } from '../components/Glass';
import { useI18n } from '../i18n';
import { colors } from '../theme';
import OnboardingExperience from '../components/OnboardingExperience';

// Access remains independent of the passive, replayable value animation.
export default function OnboardingScreen({ onComplete }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [requesting, setRequesting] = useState(false);
  const [denied, setDenied] = useState(false);
  const busy = useRef(false);
  const completed = useRef(false);
  const finish = permission => {
    if (completed.current) return;
    completed.current = true;
    onComplete?.(permission);
  };

  useEffect(() => {
    let alive = true;
    const app = AppState.addEventListener('change', async next => {
      if (next !== 'active' || !denied) return;
      try {
        const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        if (alive && permission.granted) finish(permission);
      } catch {}
    });
    return () => { alive = false; app.remove(); };
  }, [denied, onComplete]);

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
    <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}><ScrollView style={{ flex: 1, width: '100%' }} contentContainerStyle={styles.content}>
      <Text style={styles.brand}>{t('common.appName')}</Text>
      <OnboardingExperience paused={requesting || denied} />
      </ScrollView>
      <View style={styles.footer}>
        {denied ? <Text style={styles.denied}>{t('onboarding.privacyDenied')}</Text> : null}
        <JellyPressable style={styles.cta} onPress={start} disabled={requesting} accessibilityLabel={t(denied ? 'onboarding.privacySettingsBtn' : 'onboarding.startBtn')} accessibilityState={{ busy: requesting }}>
          {requesting ? <ActivityIndicator color="#111827" /> : <Text style={styles.ctaText}>{t(denied ? 'onboarding.privacySettingsBtn' : 'onboarding.startBtn')}</Text>}
        </JellyPressable>
        <Text style={styles.privacy}>{t('onboarding.privacyBody')}</Text>
        {denied ? <JellyPressable style={styles.secondary} onPress={() => finish()}><Text style={styles.privacy}>{t('onboarding.privacyNotNow')}</Text></JellyPressable> : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: 'center' },
  content: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 28 },
  brand: { color: '#D6D6DA', fontWeight: '700', fontSize: 18 },
  footer: { width: '100%', maxWidth: 476, paddingTop: 12, paddingHorizontal: 28, gap: 12 },
  privacy: { color: '#A9A5B3', fontSize: 12, lineHeight: 18, textAlign: 'center' },
  denied: { color: '#FFB4BD', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  cta: { minHeight: 54, borderRadius: 27, backgroundColor: '#FFF', padding: 14, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: '#111827', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
