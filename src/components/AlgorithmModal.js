import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassPanel, JellyPressable } from './Glass';
import { getRecommendMode } from '../media';

import { useI18n } from '../i18n';

const RAW_CARDS = [
  { id: 'rule2', icon: 'images-outline' },
  { id: 'rule3', icon: 'calendar-outline' },
  { id: 'rule4', icon: 'shuffle-outline' },
  { id: 'rule5', icon: 'layers-outline' },
  { id: 'rule6', icon: 'shield-checkmark-outline' },
];

export default function AlgorithmModal({ visible, onClose, onModeChange }) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [mode, setMode] = useState(getRecommendMode());

  useEffect(() => {
    if (visible) setMode(getRecommendMode());
  }, [visible]);

  const selectMode = async (nextMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    await onModeChange?.(nextMode);
  };

  const algorithmCards = RAW_CARDS.map((card) => ({
    ...card,
    title: t(`algorithm.${card.id}Title`),
    desc: t(`algorithm.${card.id}Desc`),
  }));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <BlurView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20 }]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleWrap}>
              <View style={styles.badge}>
                <Ionicons name="sparkles" size={12} color="#FFFFFF" />
                <Text style={styles.badgeText}>{t('menu.algoRules')}</Text>
              </View>
              <Text style={styles.title}>{t('algorithm.modalTitle')}</Text>
              <Text style={styles.subtitle}>{t('algorithm.modalSubtitle')}</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={10}>
              <Ionicons name="close" size={20} color="#fff" />
            </Pressable>
          </View>

          {/* Scrollable list of algorithm cards */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {algorithmCards.map((card) => (
              <GlassPanel key={card.id} style={styles.card} radius={20} intensity={45}>
                <View style={styles.cardHeader}>
                  <View style={[styles.iconWrap, { backgroundColor: 'rgba(255, 255, 255, 0.12)' }]}>
                    <Ionicons name={card.icon} size={20} color="#FFFFFF" />
                  </View>
                  <View style={styles.cardTitleWrap}>
                    <Text style={styles.cardTitle}>{card.title}</Text>
                  </View>
                </View>
                <Text style={styles.cardDesc}>{card.desc}</Text>
              </GlassPanel>
            ))}

            <View style={styles.footerNote}>
              <Ionicons name="shield-checkmark-outline" size={14} color="rgba(255,255,255,0.5)" />
              <Text style={styles.footerNoteText}>{t('algorithm.rule6Desc')}</Text>
            </View>
          </ScrollView>

          {/* Confirm Button */}
          <JellyPressable style={styles.confirmBtn} onPress={onClose}>
            <View style={styles.confirmPanel}>
              <Text style={styles.confirmText}>{t('algorithm.gotIt')}</Text>
            </View>
          </JellyPressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 12, 18, 0.88)',
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerTitleWrap: {
    flex: 1,
    paddingRight: 16,
  },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    marginBottom: 6,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  subtitle: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 13,
    marginTop: 4,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
    gap: 12,
  },
  card: {
    padding: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  modeButton: {
    width: '100%',
  },
  modePanel: {
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
  },
  modePanelSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.65)',
  },
  modeTextWrap: {
    flex: 1,
    paddingRight: 12,
  },
  modeTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  modeDesc: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
    marginTop: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  cardTag: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  cardDesc: {
    color: 'rgba(255, 255, 255, 0.80)',
    fontSize: 13,
    lineHeight: 19,
  },
  footerNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 12,
  },
  footerNoteText: {
    color: 'rgba(255, 255, 255, 0.50)',
    fontSize: 11,
    textAlign: 'center',
  },
  confirmBtn: {
    marginTop: 10,
  },
  confirmPanel: {
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  confirmText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '800',
  },
});
