import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JellyPressable } from './Glass';
import { useI18n } from '../i18n';
import { GESTURE_HELP } from '../gestureContract.mjs';
import OnboardingExperience from './OnboardingExperience';

// Replay the same passive scene. Optional reference belongs here, outside the feed.
export default function GestureGuideModal({ visible, onClose }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    {visible ? <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <ScrollView style={{ width: '100%', flex: 1 }} contentContainerStyle={styles.content}>
        <OnboardingExperience />
        <View style={styles.help}>{GESTURE_HELP.map(id => <View key={id} style={styles.helpRow}>
          <Text style={styles.helpTitle}>{t(`onboarding.help.${id}.title`)}</Text>
          <Text style={styles.helpBody}>{t(`onboarding.help.${id}.body`)}</Text>
        </View>)}</View>
      </ScrollView>
      <JellyPressable accessibilityRole="button" onPress={onClose} style={styles.close}><Text style={styles.closeText}>{t('guide.gotIt')}</Text></JellyPressable>
    </View> : <View />}
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0E12', alignItems: 'center' },
  content: { paddingHorizontal: 28, alignItems: 'center' },
  help: { width: '100%', maxWidth: 420 },
  helpRow: { paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#34353E' },
  helpTitle: { color: '#FFF', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  helpBody: { color: '#BCBDC6', fontSize: 13, lineHeight: 20 },
  close: { minHeight: 54, backgroundColor: '#FFF', borderRadius: 27, width: '86%', maxWidth: 420, marginTop: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#111827', fontSize: 17, fontWeight: '700' },
});
