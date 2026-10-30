import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Image, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '../i18n';
import { GESTURE_HELP, SWIPE_COMMIT } from '../gestureContract.mjs';
import { demoAction, initialDemo } from '../onboardingDemo.mjs';

const LAKE = require('../../assets/onboarding/lake.jpg');
const CAFE = require('../../assets/onboarding/cafe.jpg');
const PHOTOS = [LAKE, CAFE, CAFE];
export default function OnboardingExperience({ paused = false }) {
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const cardW = Math.min(340, width - 64, Math.max(190, (height - 390) * 0.75));
  const [state, setState] = useState(initialDemo);
  const [caption, setCaption] = useState('browse');
  const [details, setDetails] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(null);
  const [foreground, setForeground] = useState(true);
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const timers = useRef([]);
  const stopped = useRef(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const current = useRef(state); current.current = state;
  const stop = () => {
    stopped.current = true;
    timers.current.forEach(clearTimeout); timers.current = [];
    x.stopAnimation(); y.stopAnimation(); x.setValue(0); y.setValue(0); busy.current = false;
  };
  const act = (action, automated = false) => {
    if (busy.current || !alive.current) return;
    if (action === 'cleanup' && current.current.pending.length >= 2) { x.setValue(0); y.setValue(0); return; }
    busy.current = true;
    setCaption(action === 'cleanup' || action === 'undo' ? 'safe' : action === 'favorite' ? 'favorite' : 'browse');
    const finish = () => {
      if (!alive.current) return;
      setState(s => demoAction(s, action)); x.setValue(0); y.setValue(0); busy.current = false;
    };
    if (reduceMotion || action === 'undo' || action === 'favorite') { finish(); return; }
    const value = action === 'cleanup' ? x : y;
    Animated.timing(value, { toValue: action === 'previous' ? cardW * 1.34 : -cardW * 1.34, duration: automated ? 320 : 240, useNativeDriver: true }).start(({ finished }) => { if (finished) finish(); });
  };
  const handlers = useRef({}); handlers.current = { stop, act };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => handlers.current.stop(),
    onPanResponderMove: (_, g) => {
      if (Math.abs(g.dx) > Math.abs(g.dy)) x.setValue(g.dx); else y.setValue(g.dy);
    },
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > SWIPE_COMMIT) handlers.current.act(g.dx < 0 ? 'cleanup' : 'favorite');
      else if (Math.abs(g.dy) > SWIPE_COMMIT) handlers.current.act(g.dy < 0 ? 'next' : 'previous');
      else { x.setValue(0); y.setValue(0); }
    },
    onPanResponderTerminate: () => handlers.current.stop(),
    onPanResponderTerminationRequest: () => false,
  })).current;
  useEffect(() => {
    alive.current = true;
    AccessibilityInfo.isReduceMotionEnabled().then(v => { if (alive.current) setReduceMotion(v); }).catch(() => {});
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const app = AppState.addEventListener('change', next => { setForeground(next === 'active'); if (next !== 'active') handlers.current.stop(); });
    return () => { alive.current = false; handlers.current.stop(); motion.remove(); app.remove(); };
  }, []);
  useEffect(() => {
    if (reduceMotion === null) return;
    if (paused || !foreground || reduceMotion || details) { handlers.current.stop(); return; }
    if (stopped.current) return;
    timers.current = [
      setTimeout(() => handlers.current.act('next', true), 1800),
      setTimeout(() => setCaption('cleanup'), 3300),
      setTimeout(() => handlers.current.act('cleanup', true), 4600),
    ];
    return () => { timers.current.forEach(clearTimeout); timers.current = []; };
  }, [paused, foreground, reduceMotion, details]);
  const manual = action => { stop(); act(action); };
  return <View style={styles.root}>
    <Text style={styles.title} accessibilityRole="header">{t('onboarding.introTitle')}</Text>
    <Text style={styles.tag}>{t('onboarding.example')}</Text>
    <View style={[styles.stage, { width: cardW, height: cardW * 1.28 }]}>
      <Image source={PHOTOS[demoAction(state, 'next').current]} style={styles.photo} resizeMode="cover" accessible={false} />
      <Animated.View {...pan.panHandlers} style={[StyleSheet.absoluteFillObject, { transform: [{ translateX: x }, { translateY: y }] }]} accessible accessibilityRole="image" accessibilityLabel={t('onboarding.example')} accessibilityHint={t('onboarding.browse')} accessibilityActions={[{ name: 'increment', label: t('onboarding.browse') }, { name: 'decrement', label: t('onboarding.help.browse.title') }, { name: 'cleanup', label: t('onboarding.cleanup') }]} onAccessibilityAction={e => manual(e.nativeEvent.actionName === 'cleanup' ? 'cleanup' : e.nativeEvent.actionName === 'decrement' ? 'previous' : 'next')}>
        <Image source={PHOTOS[state.current]} style={styles.photo} resizeMode="cover" accessible={false} />
        {state.favorites.includes(state.current) ? <View style={styles.heart}><Ionicons name="heart" size={22} color="#FFF" /></View> : null}
      </Animated.View>
    </View>
    <Text style={styles.caption} accessibilityLiveRegion="polite">{t(`onboarding.${caption}`)}</Text>
    <View style={styles.tray}>
      <View style={styles.trayLeft}>
        {state.pending.length ? <Image source={PHOTOS[state.pending[state.pending.length - 1]]} style={styles.thumb} /> : <Ionicons name="albums-outline" size={23} color="#D6D6DA" />}
        <Text style={styles.trayText}>{t('onboarding.pending')} · {state.pending.length}</Text>
      </View>
      <Pressable onPress={() => manual('undo')} disabled={state.lastRemoved === null} style={styles.smallButton} accessibilityRole="button"><Text style={[styles.link, state.lastRemoved === null && styles.disabled]}>{t('onboarding.undo')}</Text></Pressable>
    </View>
    <View style={styles.actions}>
      <Pressable style={styles.smallButton} accessibilityRole="button" onPress={() => manual('next')}><Text style={styles.link}>{t('onboarding.next')}</Text></Pressable>
      <Pressable style={styles.smallButton} accessibilityRole="button" disabled={state.pending.length >= 2} onPress={() => manual('cleanup')}><Text style={styles.link}>{t('onboarding.tryLeft')}</Text></Pressable>
      <Pressable style={styles.smallButton} accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => { stop(); setDetails(v => !v); }}><Text style={styles.link}>{t('onboarding.more')}</Text></Pressable>
    </View>
    {details ? <View style={styles.help}>{GESTURE_HELP.map(id => <View key={id} style={styles.helpRow}><Text style={styles.helpTitle}>{t(`onboarding.help.${id}.title`)}</Text><Text style={styles.helpBody}>{t(`onboarding.help.${id}.body`)}</Text></View>)}</View> : null}
  </View>;
}
const styles = StyleSheet.create({
  root: { alignItems: 'center', width: '100%' },
  title: { color: '#FFF', fontSize: 30, lineHeight: 39, fontWeight: '700', textAlign: 'center', maxWidth: 390, marginTop: 16 },
  tag: { color: '#A3A4AD', fontSize: 12, marginTop: 20, marginBottom: 10 },
  stage: { overflow: 'hidden', borderRadius: 22, backgroundColor: '#23252C' },
  photo: { width: '100%', height: '100%', borderRadius: 22 },
  heart: { position: 'absolute', right: 14, top: 14 },
  caption: { color: '#E6E6EB', fontSize: 15, lineHeight: 23, minHeight: 58, paddingTop: 15, textAlign: 'center' },
  tray: { minHeight: 56, width: '100%', maxWidth: 340, borderRadius: 18, backgroundColor: '#1C1D24', paddingLeft: 14, paddingRight: 6, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  trayLeft: { flexDirection: 'row', gap: 10, alignItems: 'center', flex: 1 },
  trayText: { color: '#E6E6EB', fontSize: 13, flexShrink: 1 },
  thumb: { width: 28, height: 36, borderRadius: 5 },
  smallButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center', alignItems: 'center' },
  link: { color: '#D6D6DA', fontSize: 12, textAlign: 'center' },
  disabled: { color: '#6A6B75' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 },
  help: { width: '100%', maxWidth: 400, marginTop: 8 },
  helpRow: { paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#34353E' },
  helpTitle: { color: '#FFF', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  helpBody: { color: '#BCBDC6', fontSize: 13, lineHeight: 20 },
});
