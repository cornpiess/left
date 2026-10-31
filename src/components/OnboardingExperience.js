import { useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useI18n } from '../i18n';
import OnboardingMotion from './OnboardingMotion';

// One passive value scene, shared by first launch and menu replay.
export default function OnboardingExperience({ paused = false, viewportHeight = 0 }) {
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const [contentWidth, setContentWidth] = useState(0);
  const [titleHeight, setTitleHeight] = useState(84);
  const [summaryHeight, setSummaryHeight] = useState(46);
  const sceneHeight = Math.max(226, (viewportHeight || height * 0.7) - titleHeight - summaryHeight - 60);
  return <View style={[styles.root, { minHeight: viewportHeight }]} onLayout={({ nativeEvent: { layout } }) => setContentWidth(layout.width)}>
    <Text style={[styles.title, width < 360 && styles.smallTitle]} accessibilityRole="header" onLayout={({ nativeEvent: { layout } }) => setTitleHeight(layout.height)}>{t('onboarding.introTitle')}</Text>
    <OnboardingMotion paused={paused} availableWidth={Math.min(contentWidth || width - 48, 520)} availableHeight={sceneHeight} />
    <Text style={styles.summary} onLayout={({ nativeEvent: { layout } }) => setSummaryHeight(layout.height)}>{t('onboarding.summary')}</Text>
  </View>;
}
const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', width: '100%', paddingVertical: 16 },
  title: { color: '#F6F6F7', fontSize: 29, lineHeight: 42, fontWeight: '700', textAlign: 'center', maxWidth: 420, marginBottom: 16 },
  smallTitle: { fontSize: 25, lineHeight: 37 },
  summary: { color: '#B8BBC7', fontSize: 14, lineHeight: 23, textAlign: 'center', maxWidth: 400, marginTop: 12 },
});
