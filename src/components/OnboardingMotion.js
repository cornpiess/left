import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { useI18n } from '../i18n';
import { ONBOARDING_CYCLE_MS, motionConfig } from '../onboardingMotion.mjs';

// Decorative vectors only. There are no asset IDs, media requests or touch handlers.
function MemoryOutline({ kind }) {
  const ink = '#E8E8ED';
  return <Svg width={152} height={186} viewBox="0 0 152 186" fill="none">
    <Rect x={1} y={1} width={150} height={184} rx={17} fill="#181A21" stroke="#8C909E" strokeWidth={1.5} />
    <Circle cx={133} cy={18} r={2.5} fill="#8C909E" />
    <Line x1={18} y1={168} x2={40} y2={168} stroke="#535663" strokeWidth={2} strokeLinecap="round" />
    {kind === 'sun' ? <>
      <Circle cx={76} cy={73} r={11} stroke={ink} strokeWidth={1.5} />
      <Path d="M76 51v-5m0 54v-5M54 73h-5m54 0h-5M60 57l-4-4m40 40-4-4M60 89l-4 4m40-40-4 4" stroke={ink} strokeWidth={1.5} strokeLinecap="round" />
    </> : kind === 'copy' ? <>
      <Rect x={67} y={63} width={26} height={31} rx={4} stroke={ink} strokeWidth={1.5} />
      <Path d="M82 58v-4H60a4 4 0 0 0-4 4v23h5" stroke={ink} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </> : <>
      <Path d="M57 67h33v17a9 9 0 0 1-9 9H66a9 9 0 0 1-9-9V67Zm33 3h3a7 7 0 0 1 0 14h-3M62 57v-6m11 6v-6m11 6v-6M55 100h39" stroke={ink} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </>}
  </Svg>;
}

export default function OnboardingMotion({ paused = false }) {
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const sceneWidth = Math.min(340, Math.max(220, width - 56));
  const sceneScale = height < 700 ? 0.86 : 1;
  const progress = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(null);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive) setReduceMotion(value); }).catch(() => { if (alive) setReduceMotion(true); });
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const app = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => { alive = false; motion.remove(); app.remove(); };
  }, []);

  useEffect(() => {
    progress.setValue(0);
    if (reduceMotion !== false || paused || !foreground) return;
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: ONBOARDING_CYCLE_MS, easing: Easing.linear, useNativeDriver: true }), { resetBeforeIteration: true });
    loop.start();
    return () => { loop.stop(); progress.stopAnimation(); progress.setValue(0); };
  }, [progress, reduceMotion, paused, foreground]);

  const track = name => progress.interpolate(motionConfig(name, sceneWidth + 152));
  const firstStyle = { transform: [{ translateY: track('firstY') }] };
  const selectedStyle = {
    transform: [{ translateX: track('selectedX') }, { translateY: track('selectedY') }, { rotate: track('selectedAngle') }],
  };
  const nextStyle = { transform: [{ translateY: track('nextY') }] };

  return <View style={[styles.scene, { width: sceneWidth, height: 266 * sceneScale }]} pointerEvents="none" accessible accessibilityRole="image" accessibilityLabel={t('onboarding.motionLabel')}>
    <View style={[styles.canvas, { width: sceneWidth, transform: [{ scale: sceneScale }] }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.receipt, { left: sceneWidth / 2 - 86, opacity: track('receipt') }]}>
        <Svg width={20} height={22} viewBox="0 0 38 44" fill="none">
          <Rect x={.75} y={.75} width={36.5} height={42.5} rx={8} fill="#111218" stroke="#9DA0AC" />
          <Path d="M10 16h18v4H10zM12 20v10h14V20m-10 4h6" stroke="#CBCDD5" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
        <Text style={styles.receiptLabel}>{t('onboarding.pendingShort')} +1</Text>
      </Animated.View>
      <View style={[styles.frames, { left: 0 }]}>
        <Animated.View style={[styles.memory, nextStyle]}><MemoryOutline kind="coffee" /><Animated.Text style={[styles.cardLabel, { opacity: track('nextMemory') }]}>{t('onboarding.memoryLabel')}</Animated.Text><Animated.Text style={[styles.cardLabel, { opacity: track('nextKeep') }]}>{t('onboarding.keepLabel')}</Animated.Text></Animated.View>
        <Animated.View style={[styles.memory, firstStyle]}><MemoryOutline kind="sun" /><Animated.Text style={[styles.cardLabel, { opacity: track('firstMemory') }]}>{t('onboarding.memoryLabel')}</Animated.Text><Animated.Text style={[styles.cardLabel, { opacity: track('firstKeep') }]}>{t('onboarding.keepLabel')}</Animated.Text></Animated.View>
        <Animated.View style={[styles.memory, selectedStyle]}>
          <MemoryOutline kind="copy" />
          <Animated.Text style={[styles.cardLabel, { opacity: track('neutralLabel') }]}>{t('onboarding.memoryLabel')}</Animated.Text>
          <Animated.Text style={[styles.cardLabel, { opacity: track('decisionLabel') }]}>{t('onboarding.skipLabel')}</Animated.Text>
          <Animated.View style={[styles.leftArrow, { opacity: track('leftArrow') }]}><Svg width={24} height={24} viewBox="0 0 24 24" fill="none"><Path d="M19 12H5m6-6-6 6 6 6" stroke="#E8E8ED" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></Svg></Animated.View>
        </Animated.View>
      </View>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  scene: { alignSelf: 'center', maxWidth: '100%', overflow: 'hidden' },
  canvas: { position: 'absolute', height: 266, top: 0 },
  frames: { position: 'absolute', top: 16, width: '100%', height: 218, overflow: 'hidden' },
  memory: { position: 'absolute', left: '50%', marginLeft: -76, top: 16, width: 152, height: 186 },
  cardLabel: { position: 'absolute', top: 119, left: 10, right: 10, textAlign: 'center', color: '#C3C5CF', fontSize: 12, lineHeight: 18 },
  receipt: { position: 'absolute', top: 238, width: 172, minHeight: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  receiptLabel: { color: '#C3C5CF', fontSize: 12, lineHeight: 18, textAlign: 'center' },
  leftArrow: { position: 'absolute', top: 74, left: 12 },
});
