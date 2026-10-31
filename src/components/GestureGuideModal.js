import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PrimaryButton } from './Glass';
import { useI18n } from '../i18n';
import { GESTURE_HELP } from '../gestureContract.mjs';
import OnboardingExperience from './OnboardingExperience';

// Replay the same passive scene. Optional reference belongs here, outside the feed.
export default function GestureGuideModal({ visible, onClose }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [viewportHeight, setViewportHeight] = useState(0);
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    {visible ? <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <ScrollView style={{ width: '100%', flex: 1 }} contentContainerStyle={styles.content} onLayout={({ nativeEvent: { layout } }) => setViewportHeight(layout.height)}>
        <OnboardingExperience viewportHeight={viewportHeight} />
        <View style={styles.help}>{GESTURE_HELP.map(id => <View key={id} style={styles.helpRow}>
          <Text style={styles.helpTitle}>{t(`onboarding.help.${id}.title`)}</Text>
          <Text style={styles.helpBody}>{t(`onboarding.help.${id}.body`)}</Text>
        </View>)}</View>
      </ScrollView>
      <View style={styles.footer}><PrimaryButton label={t('guide.gotIt')} onPress={onClose} /></View>
    </View> : <View />}
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0E12', alignItems: 'center' },
  content: { paddingHorizontal: 24, alignItems: 'center' },
  help: { width: '100%', maxWidth: 420 },
  helpRow: { paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#34353E' },
  helpTitle: { color: '#FFF', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  helpBody: { color: '#BCBDC6', fontSize: 13, lineHeight: 20 },
  footer: { width: '100%', paddingHorizontal: 28, paddingTop: 12 },
});
