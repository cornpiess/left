import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JellyPressable } from './Glass';
import { useI18n } from '../i18n';
import OnboardingExperience from './OnboardingExperience';

// The menu replays the very same tutorial; it never requests library access.
export default function GestureGuideModal({ visible, onClose }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    {visible ? <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20, paddingHorizontal: 24, alignItems: 'center' }}>
      <OnboardingExperience />
      <JellyPressable accessibilityRole="button" onPress={onClose} style={styles.close}><Text style={styles.closeText}>{t('guide.gotIt')}</Text></JellyPressable>
    </ScrollView> : <View />}
  </Modal>;
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0E12' },
  close: { minHeight: 54, backgroundColor: '#FFF', borderRadius: 27, width: '100%', maxWidth: 420, marginTop: 16, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#111827', fontSize: 17, fontWeight: '700' },
});
