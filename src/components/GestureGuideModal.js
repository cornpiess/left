import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { GlassPanel, JellyPressable } from './Glass';
import MaoQiuIcon from './MaoQiuIcon';

import { useI18n } from '../i18n';

const RAW_GESTURES = [
  { id: 'g2', icon: 'arrow-back-outline', iconColor: '#FF526F', badgeBg: 'rgba(255, 82, 111, 0.22)' },
  { id: 'g1', icon: 'swap-vertical-outline', iconColor: '#70C5FF', badgeBg: 'rgba(112, 197, 255, 0.22)' },
];

export default function GestureGuideModal({ visible, onClose }) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  const gestureItems = RAW_GESTURES.map((item) => ({
    ...item,
    title: t(`guide.${item.id}Title`),
    badge: t(`guide.${item.id}Badge`),
    desc: t(`guide.${item.id}Desc`),
  }));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <BlurView intensity={75} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
          {/* Header Row */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.headerTitleRow}>
                <MaoQiuIcon size={48} color="#FFFFFF" />
                <Text style={styles.headerTitle}>{t('guide.modalTitle')}</Text>
              </View>
              <Text style={styles.headerSubtitle}>{t('guide.modalSubtitle')}</Text>
            </View>
            <JellyPressable onPress={onClose} style={styles.closeBtnWrap} hitSlop={10}>
              <View style={styles.closeBtn}>
                <Ionicons name="close" size={20} color="#FFFFFF" />
              </View>
            </JellyPressable>
          </View>

          {/* Cards List */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {gestureItems.map((item) => (
              <GlassPanel key={item.id} style={styles.card} radius={24} intensity={60}>
                <View style={styles.cardRow}>
                  {/* Left MD3 Leading Tonal Icon Avatar Container */}
                  <View style={[styles.iconAvatar, { backgroundColor: item.badgeBg }]}>
                    <Ionicons name={item.icon} size={22} color={item.iconColor} />
                  </View>

                  {/* Right Content */}
                  <View style={styles.cardBody}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.cardTitle}>{item.title}</Text>
                      <View style={[styles.badge, { backgroundColor: item.badgeBg }]}>
                        <Text style={styles.badgeText}>{item.badge}</Text>
                      </View>
                    </View>
                    <Text style={styles.cardDesc}>{item.desc}</Text>
                  </View>
                </View>
              </GlassPanel>
            ))}

            <View style={styles.bottomPad} />
          </ScrollView>

          {/* Bottom Confirmation Button */}
          <View style={styles.footerWrap}>
            <JellyPressable style={styles.confirmBtn} onPress={onClose}>
              <View style={styles.confirmBtnInner}>
                <Ionicons name="checkmark-circle" size={22} color="#111827" />
                <Text style={styles.confirmText}>{t('guide.gotIt')}</Text>
              </View>
            </JellyPressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingHorizontal: 4,
    zIndex: 20,
  },
  headerLeft: {
    flex: 1,
    paddingRight: 12,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  headerTitle: {
    flexShrink: 1,
    color: colors.white,
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  headerSubtitle: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 13,
    fontWeight: '400',
  },
  closeBtnWrap: {
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
    width: '100%',
  },
  scrollContent: {
    gap: 10,
    paddingBottom: 16,
  },
  card: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: 'rgba(20, 22, 28, 0.65)',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  iconAvatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  cardBody: {
    flex: 1,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    columnGap: 8,
    rowGap: 6,
    marginBottom: 4,
  },
  cardTitle: {
    flexShrink: 1,
    minWidth: 0,
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  badge: {
    flexShrink: 0,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 12,
  },
  badgeText: {
    color: colors.white,
    fontSize: 11.5,
    fontWeight: '600',
  },
  cardDesc: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 13.5,
    lineHeight: 19,
  },
  bottomPad: {
    height: 12,
  },
  footerWrap: {
    paddingTop: 12,
    alignItems: 'center',
    width: '100%',
  },
  confirmBtn: {
    width: '100%',
  },
  confirmBtnInner: {
    height: 52,
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  confirmText: {
    color: '#111827',
    fontSize: 16.5,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
