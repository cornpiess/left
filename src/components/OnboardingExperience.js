import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useI18n } from '../i18n';
import OnboardingMotion from './OnboardingMotion';

// One passive value scene, shared by first launch and menu replay.
export default function OnboardingExperience({ paused = false }) {
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  return <View style={styles.root}>
    <Text style={[styles.title, width < 360 && styles.smallTitle]} accessibilityRole="header">{t('onboarding.introTitle')}</Text>
    <OnboardingMotion paused={paused} />
    <Text style={styles.summary}>{t('onboarding.summary')}</Text>
  </View>;
}
const styles = StyleSheet.create({
  root: { alignItems: 'center', width: '100%', paddingTop: 20 },
  title: { color: '#F6F6F7', fontSize: 29, lineHeight: 42, fontWeight: '700', textAlign: 'center', maxWidth: 420, marginBottom: 16 },
  smallTitle: { fontSize: 25, lineHeight: 37 },
  summary: { color: '#B8BBC7', fontSize: 14, lineHeight: 23, textAlign: 'center', maxWidth: 400, marginTop: 4, marginBottom: 24 },
});
