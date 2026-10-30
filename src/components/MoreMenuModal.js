import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassPanel, JellyPressable } from './Glass';
import { colors } from '../theme';
import { setProStatus, resetDailyQuota, DAILY_FREE_LIMIT } from '../membership';
import AlgorithmModal from './AlgorithmModal';
import GestureGuideModal from './GestureGuideModal';
import PromoCodeModal from './PromoCodeModal';
import { getTotalCleanedBytes, getRecommendMode } from '../media';
import { openLegalPage } from '../legalNavigation';
import { openAppStoreReview } from '../ratingStore';
import { getFlightLogText } from '../flightRecorder';

import { useI18n } from '../i18n';

const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.executionEnvironment === 'storeClient';

export default function MoreMenuModal({
  visible,
  onClose,
  membership,
  trashSummary,
  onManagePermissions,
  onResetViewedHistory,
  onToast,
  onOpenPaywall,
  onRecommendModeChange,
}) {
  const insets = useSafeAreaInsets();
  const { t, languageSetting, setLanguage } = useI18n();

  const [algoModalVisible, setAlgoModalVisible] = useState(false);
  const [guideModalVisible, setGuideModalVisible] = useState(false);
  const [promoModalVisible, setPromoModalVisible] = useState(false);
  const [diagVisible, setDiagVisible] = useState(false);
  const [diagText, setDiagText] = useState('');
  const [langExpand, setLangExpand] = useState(false);
  const [algoExpand, setAlgoExpand] = useState(false);
  const [recommendMode, setRecommendMode] = useState(getRecommendMode());

  useEffect(() => {
    if (visible) setRecommendMode(getRecommendMode());
  }, [visible]);

  const popAnim = useRef(new Animated.Value(0)).current;
  const versionTapCountRef = useRef(0);
  const versionTapTimerRef = useRef(null);

  useEffect(() => {
    if (visible) {
      popAnim.setValue(0);
      Animated.spring(popAnim, {
        toValue: 1,
        tension: 280,
        friction: 28,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, popAnim]);

  const { isPro, planType, usedToday, dailyLimit = DAILY_FREE_LIMIT } = membership || { isPro: false, planType: null, usedToday: 0, dailyLimit: DAILY_FREE_LIMIT };

  const handleOpenLegal = async (tab) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    const opened = await openLegalPage(tab);
    if (!opened) onToast?.(t('legal.openFailed'));
  };

  const handleOpenAlgo = () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    setAlgoModalVisible(true);
  };

  const handleOpenGuide = () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    setGuideModalVisible(true);
  };

  const handleOpenRate = async () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    const opened = await openAppStoreReview();
    if (!opened) onToast?.(t('rating.toastFailed'));
  };

  const handleVersionTap = () => {
    // Silent 7-tap easter egg; no progressive hint, no toast, no sound.
    clearTimeout(versionTapTimerRef.current);
    versionTapCountRef.current += 1;
    if (versionTapCountRef.current >= 7) {
      versionTapCountRef.current = 0;
      setPromoModalVisible(true);
      return;
    }
    versionTapTimerRef.current = setTimeout(() => {
      versionTapCountRef.current = 0;
    }, 2500);
  };

  // Local-only diagnostics (flight recorder). Long-press avoids colliding
  // with the 7-tap easter egg on the same row.
  const handleVersionLongPress = () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    getFlightLogText().then((text) => {
      setDiagText(text || t('menu.diagnosticsEmpty'));
      setDiagVisible(true);
    }).catch(() => {});
  };

  const handleCloseAll = () => {
    Animated.spring(popAnim, {
      toValue: 0,
      tension: 400,
      friction: 38,
      useNativeDriver: true,
    }).start(() => {
      onClose?.();
    });
  };

  const handleOpenPaywall = () => {
    Animated.spring(popAnim, {
      toValue: 0,
      tension: 400,
      friction: 38,
      useNativeDriver: true,
    }).start(() => {
      onClose?.();
      requestAnimationFrame(() => onOpenPaywall?.());
    });
  };

  const LANGUAGES = [
    { id: 'auto', label: t('menu.langSystem') },
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Español' },
    { id: 'ko', label: '한국어' },
    { id: 'ja', label: '日本語' },
    { id: 'zh-Hans', label: '简体中文' },
    { id: 'zh-Hant', label: '繁体中文' },
  ];

  const scale = popAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.7, 1],
  });

  const translateX = popAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [60, 0],
  });

  const translateY = popAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-40, 0],
  });

  const opacity = popAnim.interpolate({
    inputRange: [0, 0.2, 1],
    outputRange: [0, 1, 1],
  });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleCloseAll}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleCloseAll}>
          <BlurView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
        </Pressable>

        <Animated.View
          style={[
            styles.popoverWrap,
            {
              top: insets.top + 58,
              opacity,
              transform: [
                { translateX },
                { translateY },
                { scale },
              ],
            },
          ]}
        >
          <GlassPanel style={styles.popoverCard} radius={24} intensity={70} shadow={true}>
            {/* Header: MaoQiu Title + PRO Pill Button */}
            <View style={styles.proSection}>
              <View style={styles.proHeaderRow}>
                <View style={styles.brandBadge}>
                  <Text style={styles.brandTitleText}>{t('common.appName')}</Text>
                </View>

                <JellyPressable
                  style={isPro ? styles.proPillActiveBtn : styles.proPillBtn}
                  onPress={() => {
                    if (isPro && (__DEV__ || isExpoGo)) {
                      setProStatus(false, null);
                      resetDailyQuota();
                      onToast?.(t('menu.resetQuotaSuccess', { limit: DAILY_FREE_LIMIT }));
                    } else {
                      handleOpenPaywall();
                    }
                  }}
                  hitSlop={6}
                >
                  <Ionicons name="sparkles" size={13} color={isPro ? '#FFFFFF' : '#111827'} />
                  <Text style={isPro ? styles.proPillActiveText : styles.proPillText}>
                    {isPro ? t('menu.proUnlocked') : 'PRO'}
                  </Text>
                </JellyPressable>
              </View>

              <Text style={styles.quotaText}>
                {isPro ? `✨ ${t('menu.quotaUnlimited')}` : t('menu.quotaUsed', { used: usedToday, limit: dailyLimit })}
              </Text>
            </View>

            <View style={styles.divider} />

            {/* Cleaned Space Stats */}
            {(() => {
              const cleanedBytes = getTotalCleanedBytes();
              const mbVal = (cleanedBytes / (1024 * 1024)).toFixed(1);
              const gbVal = (cleanedBytes / (1024 * 1024 * 1024)).toFixed(2);
              return (
                <View style={styles.menuRow}>
                  <View style={styles.menuIconWrap}>
                    <Ionicons name="pie-chart-outline" size={16} color="#34C759" />
                  </View>
                  <View style={styles.menuTextWrap}>
                    <Text style={styles.menuTitle}>{t('menu.cleanedSpace')}</Text>
                    <Text style={styles.menuSubtitle}>{`≈ ${mbVal} MB (${gbVal} GB)`}</Text>
                  </View>
                </View>
              );
            })()}

            <View style={styles.divider} />

            {/* Menu Row 1: Language Switcher */}
            <JellyPressable style={styles.menuRow} onPress={() => setLangExpand((v) => !v)} hitSlop={6}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="language-outline" size={16} color="#FFFFFF" />
              </View>
              <View style={styles.menuTextWrap}>
                <Text style={styles.menuTitle}>{t('menu.languageTitle')}</Text>
                <Text style={styles.menuSubtitle}>
                  {LANGUAGES.find((l) => l.id === languageSetting)?.label || t('menu.langSystem')}
                </Text>
              </View>
              <Ionicons name={langExpand ? 'chevron-up' : 'chevron-down'} size={16} color="rgba(255,255,255,0.4)" />
            </JellyPressable>

            {langExpand ? (
              <View style={styles.langListWrap}>
                {LANGUAGES.map((language) => (
                  <Pressable
                    key={language.id}
                    style={styles.langItemRow}
                    onPress={() => {
                      void setLanguage(language.id);
                      setLangExpand(false);
                      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
                    }}
                  >
                    <Text style={[styles.langItemText, languageSetting === language.id && styles.langItemTextActive]}>
                      {language.label}
                    </Text>
                    {languageSetting === language.id ? <Ionicons name="checkmark" size={16} color="#FFFFFF" /> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}

            <View style={styles.divider} />

            {/* Menu Row 1.5: Photo Selection Algorithm Mode Switcher */}
            {(() => {
              const ALGO_MODES = [
                { id: 'default', label: t('menu.recommendDefault'), sub: t('menu.recommendDefaultSub') },
                { id: 'storage', label: t('menu.recommendStorage'), sub: t('menu.recommendStorageSub') },
              ];
              const currentAlgo = ALGO_MODES.find((m) => m.id === recommendMode) || ALGO_MODES[0];
              return (
                <>
                  <JellyPressable style={styles.menuRow} onPress={() => setAlgoExpand((v) => !v)} hitSlop={6}>
                    <View style={styles.menuIconWrap}>
                      <Ionicons name="options-outline" size={16} color="#FFFFFF" />
                    </View>
                    <View style={styles.menuTextWrap}>
                      <Text style={styles.menuTitle}>{t('menu.recommendTitle')}</Text>
                      <Text style={styles.menuSubtitle}>{currentAlgo.label}</Text>
                    </View>
                    <Ionicons name={algoExpand ? 'chevron-up' : 'chevron-down'} size={16} color="rgba(255,255,255,0.4)" />
                  </JellyPressable>

                  {algoExpand ? (
                    <View style={styles.langListWrap}>
                      {ALGO_MODES.map((modeItem) => (
                        <Pressable
                          key={modeItem.id}
                          style={styles.langItemRow}
                          onPress={async () => {
                            setRecommendMode(modeItem.id);
                            setAlgoExpand(false);
                            try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
                            await onRecommendModeChange?.(modeItem.id);
                          }}
                        >
                          <View style={{ flex: 1, paddingRight: 8 }}>
                            <Text style={[styles.langItemText, recommendMode === modeItem.id && styles.langItemTextActive]}>
                              {modeItem.label}
                            </Text>
                            <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginTop: 2 }}>
                              {modeItem.sub}
                            </Text>
                          </View>
                          {recommendMode === modeItem.id ? <Ionicons name="checkmark" size={16} color="#FFFFFF" /> : null}
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </>
              );
            })()}

            <View style={styles.divider} />

            {/* Menu Row 2: Gesture Guide */}
            <JellyPressable style={styles.menuRow} onPress={handleOpenGuide} hitSlop={6}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="hand-left-outline" size={16} color="#FFFFFF" />
              </View>
              <View style={styles.menuTextWrap}>
                <Text style={styles.menuTitle}>{t('menu.gestureGuide')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.4)" />
            </JellyPressable>

            <View style={styles.divider} />

            {/* Menu Row 3: Algorithm Rules */}
            <JellyPressable style={styles.menuRow} onPress={handleOpenAlgo} hitSlop={6}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="sparkles" size={16} color="#FFFFFF" />
              </View>
              <View style={styles.menuTextWrap}>
                <Text style={styles.menuTitle}>{t('menu.algoRules')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.4)" />
            </JellyPressable>

            {/* Menu Row 3.5: Privacy Policy */}
            <JellyPressable
              style={styles.menuRow}
              onPress={() => void handleOpenLegal('privacy')}
              hitSlop={6}
            >
              <View style={styles.menuIconWrap}>
                <Ionicons name="shield-checkmark-outline" size={16} color="#FFFFFF" />
              </View>
              <View style={styles.menuTextWrap}>
                <Text style={styles.menuTitle}>{t('menu.privacyPolicy')}</Text>
              </View>
              <Ionicons name="open-outline" size={16} color="rgba(255,255,255,0.4)" />
            </JellyPressable>

            <View style={styles.divider} />

            {/* Menu Row 3.6: Terms of Service */}
            <JellyPressable
              style={styles.menuRow}
              onPress={() => void handleOpenLegal('terms')}
              hitSlop={6}
            >
              <View style={styles.menuIconWrap}>
                <Ionicons name="document-text-outline" size={16} color="#FFFFFF" />
              </View>
              <View style={styles.menuTextWrap}>
                <Text style={styles.menuTitle}>{t('menu.termsOfService')}</Text>
              </View>
              <Ionicons name="open-outline" size={16} color="rgba(255,255,255,0.4)" />
            </JellyPressable>

            <View style={styles.divider} />

            {/* Menu Row 3.7: App Store rating (user-initiated, always available) */}
            <JellyPressable
              style={styles.menuRow}
              onPress={() => void handleOpenRate()}
              hitSlop={6}
            >
              <View style={styles.menuIconWrap}>
                <Ionicons name="star-outline" size={16} color="#FFE3A8" />
              </View>
              <View style={styles.menuTextWrap}>
                <Text style={styles.menuTitle}>{t('menu.rateApp')}</Text>
              </View>
              <Ionicons name="open-outline" size={16} color="rgba(255,255,255,0.4)" />
            </JellyPressable>

            <View style={styles.divider} />

            {/* Menu Row 4: Reset Viewed History */}
            {onResetViewedHistory ? (
              <JellyPressable
                style={styles.menuRow}
                onPress={() => {
                  onResetViewedHistory();
                  onToast?.(t('menu.resetHistorySuccess'));
                  handleCloseAll();
                }}
                hitSlop={6}
              >
                <View style={styles.menuIconWrap}>
                  <Ionicons name="trash-bin-outline" size={16} color={colors.catPaw} />
                </View>
                <View style={styles.menuTextWrap}>
                  <Text style={[styles.menuTitle, { color: colors.catPaw }]}>{t('menu.resetHistory')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.4)" />
              </JellyPressable>
            ) : null}

            <View style={styles.divider} />

            {/* Footer: 7 taps unlock the activation code modal; long-press opens
                the local diagnostics flight log (no telemetry, PRD 3.10). */}
            <Pressable style={styles.versionFooter} onPress={handleVersionTap} onLongPress={handleVersionLongPress} hitSlop={8}>
              <Ionicons name="information-circle-outline" size={14} color="rgba(255,255,255,0.55)" />
              <Text style={styles.versionText}>{t('menu.version')} {Constants.expoConfig?.version ?? ''} ({Constants.expoConfig?.ios?.buildNumber ?? '?'})</Text>
            </Pressable>
          </GlassPanel>
        </Animated.View>
      </View>

      <AlgorithmModal visible={algoModalVisible} onClose={() => setAlgoModalVisible(false)} onModeChange={onRecommendModeChange} />
      <GestureGuideModal visible={guideModalVisible} onClose={() => setGuideModalVisible(false)} />
      <PromoCodeModal visible={promoModalVisible} onClose={() => setPromoModalVisible(false)} onToast={onToast} />

      {/* Local diagnostics: session lifecycle milestones from the flight
          recorder — the tail to read after a native-side crash. */}
      <Modal visible={diagVisible} transparent animationType="fade" onRequestClose={() => setDiagVisible(false)}>
        <Pressable style={styles.diagOverlay} onPress={() => setDiagVisible(false)}>
          <Pressable style={styles.diagCard} onPress={() => {}}>
            <View style={styles.diagHead}>
              <Ionicons name="pulse-outline" size={15} color={colors.text} />
              <Text style={styles.diagTitle}>{t('menu.diagnosticsTitle')}</Text>
            </View>
            <ScrollView style={styles.diagScroll} indicatorStyle="white">
              <Text style={styles.diagText} selectable>{diagText}</Text>
            </ScrollView>
            <JellyPressable style={styles.diagClose} onPress={() => setDiagVisible(false)}>
              <Text style={styles.diagCloseText}>{t('menu.diagnosticsClose')}</Text>
            </JellyPressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  popoverWrap: {
    position: 'absolute',
    right: 16,
    width: 300,
    zIndex: 100,
  },
  popoverCard: {
    padding: 16,
    backgroundColor: 'rgba(24, 26, 32, 0.94)',
  },
  proSection: {
    paddingBottom: 10,
  },
  proHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  brandBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandTitleText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  proPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  proPillText: {
    color: '#111827',
    fontSize: 12.5,
    fontWeight: '800',
  },
  proPillActiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.20)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.40)',
  },
  proPillActiveText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '700',
  },
  toggleFreeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
  },
  toggleFreeText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 11,
  },
  quotaText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 12,
    lineHeight: 16,
  },
  promoNoticeText: {
    color: '#FFD700',
    fontSize: 11.5,
    fontWeight: '700',
    marginTop: 5,
  },
  freeActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  resetQuotaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  resetQuotaText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 11,
  },
  planDetailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 3,
  },
  planDetailText: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 11,
  },
  privilegeWrap: {
    marginTop: 8,
    padding: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    gap: 3,
  },
  privilegeLine: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 11,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginVertical: 10,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  menuIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuTextWrap: {
    flex: 1,
  },
  menuTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  menuSubtitle: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 11,
    marginTop: 2,
  },
  versionFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 4,
  },
  versionText: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 11,
    fontWeight: '500',
  },
  diagOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  diagCard: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '72%',
    borderRadius: 22,
    backgroundColor: 'rgba(28, 28, 30, 0.96)',
    padding: 16,
  },
  diagHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 10,
  },
  diagTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  diagScroll: {
    flexGrow: 0,
  },
  diagText: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 10,
    lineHeight: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  diagClose: {
    marginTop: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  diagCloseText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  langListWrap: {
    marginTop: 4,
    marginBottom: 4,
    paddingLeft: 42,
    gap: 6,
  },
  langItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingRight: 8,
  },
  langItemText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 13,
    fontWeight: '500',
  },
  langItemTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
});

