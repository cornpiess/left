import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassPanel, JellyPressable } from './Glass';
import { buyIapProduct, getIapCatalogState, getMembershipState, DAILY_FREE_LIMIT, IAP_SKUS, PRICING_PLANS, refreshIapCatalog, restoreIapPurchases, subscribeIapProducts } from '../membership';
import { getProductDisplayPrice } from '../membershipCore.mjs';
import { useI18n } from '../i18n';
import { openLegalPage } from '../legalNavigation';
import { flightEvent } from '../flightRecorder';

export default function PaywallModal({ visible, reason = 'menu', onClose, onToast }) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  const [catalog, setCatalog] = useState(getIapCatalogState);
  const [pendingAction, setPendingAction] = useState(null);
  const actionRef = useRef(false);
  const requestClose = () => { if (!actionRef.current) onClose?.(); };

  useEffect(() => subscribeIapProducts(setCatalog), []);
  useEffect(() => {
    if (visible) void refreshIapCatalog();
  }, [visible]);

  const membership = getMembershipState();
  const productsMap = catalog.products;
  const yearlyProduct = productsMap[IAP_SKUS.YEARLY];
  const lifetimeProduct = productsMap[IAP_SKUS.LIFETIME];

  // When StoreKit has not returned a product yet, show the configured ¥ price as a
  // complete-looking fallback instead of "Loading..." (App Completeness).
  const yearlyPriceText = getProductDisplayPrice(yearlyProduct, PRICING_PLANS.YEARLY.title);
  const lifetimePriceText = getProductDisplayPrice(lifetimeProduct, PRICING_PLANS.LIFETIME.title);
  const usingFallbackPrice = !yearlyProduct || !lifetimeProduct;

  const handleBuy = async (planType) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction(planType);
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}

    // Reassurance for yearly subscribers upgrading to lifetime buyout
    if (membership.isPro && membership.planType === 'yearly' && planType === 'lifetime') {
      onToast?.(t('paywall.yearlyNotice') || '购买终身买断后，请前往 iOS「设置-订阅」关闭包年续订');
    } else {
      onToast?.(planType === 'yearly' ? t('paywall.buyingYearly') : t('paywall.buyingLifetime'));
    }

    try {
      const res = await buyIapProduct(planType);
      if (res.success) {
        flightEvent('purchase-success', planType);
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
        onToast?.(planType === 'yearly' ? t('paywall.buySuccessYearly') : t('paywall.buySuccessLifetime'));
        onClose?.();
      } else if (!res.cancelled) {
        onToast?.(t(res.messageKey || 'paywall.restoreFailed'));
      }
    } catch (error) {
      onToast?.(error?.message || 'Error');
    } finally {
      actionRef.current = false;
      setPendingAction(null);
    }
  };

  const handleRestore = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction('restore');
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    onToast?.(t('paywall.restoring'));
    try {
      const res = await restoreIapPurchases();
      if (res.restored) {
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
        onToast?.(t('paywall.restoreSuccess'));
        onClose?.();
      } else {
        onToast?.(t(res.messageKey || 'paywall.restoreFailed'));
      }
    } catch (error) {
      onToast?.(error?.message || t('paywall.restoreFailed'));
    } finally {
      actionRef.current = false;
      setPendingAction(null);
    }
  };

  const openLegal = async (tab) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    const opened = await openLegalPage(tab);
    if (!opened) onToast?.(t('legal.openFailed'));
  };

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={requestClose}>
        <View style={styles.backdrop}>
          <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
          <ScrollView style={styles.scroll} contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]} showsVerticalScrollIndicator={false}>
            <GlassPanel style={styles.paywallCard} radius={28} intensity={85}>
              {/* Top Right Corner Close Button */}
              <View style={styles.closeBtnWrap}>
                <JellyPressable onPress={requestClose} disabled={Boolean(pendingAction)} accessibilityLabel={t('common.close')}>
                  <View style={styles.closeBtn}>
                    <Ionicons name="close" size={20} color="#FFFFFF" />
                  </View>
                </JellyPressable>
              </View>

              {/* Headline */}
              <Text style={styles.paywallTitle} accessibilityRole="header">
                {membership.isPro ? t('paywall.proTitle') || `${t('common.appName')} PRO` : t(reason === 'quota' ? 'paywall.limitTitle' : 'paywall.modalTitle', { limit: DAILY_FREE_LIMIT })}
              </Text>
              <Text style={styles.paywallSubtitle}>
                {membership.isPro
                  ? membership.planType === 'lifetime'
                    ? `🎉 ${t('menu.planLifetime')} · ${t('paywall.modalSub')}`
                    : `🎉 ${t('menu.planYearly')} · ${t('paywall.modalSub')}`
                  : t('paywall.modalSub')}
              </Text>

              <View style={styles.paywallPrivilegeList}>
                <View style={styles.paywallPrivilegeItem}>
                  <Ionicons name="infinite" size={20} color="#C4B5FD" />
                  <Text style={styles.paywallPrivilegeText}>{t('paywall.privilege1')}</Text>
                </View>
              </View>
              <Text style={styles.freePolicy}>{t('paywall.freePolicy', { limit: DAILY_FREE_LIMIT })}</Text>

              {catalog.status === 'error' ? (
                <View style={styles.catalogErrorRow}>
                  <Text style={styles.catalogErrorText}>{t('paywall.catalogUnavailable')}</Text>
                  <JellyPressable style={styles.catalogRetryBtn} onPress={() => void refreshIapCatalog()}>
                    <Text style={styles.catalogRetryText}>{t('paywall.retryCatalog')}</Text>
                  </JellyPressable>
                </View>
              ) : null}

              {catalog.status !== 'error' && usingFallbackPrice ? (
                <Text style={[styles.catalogErrorText, styles.catalogFallbackNote]}>{t('paywall.priceFallbackNote')}</Text>
              ) : null}

              {/* Purchasing Cards or PRO Active Card */}
              {membership.isPro ? (
                <View style={styles.paywallPlanContainer}>
                  {/* Active PRO Status Card */}
                  <View style={styles.proActiveCard}>
                    <Ionicons name="shield-checkmark" size={20} color="#10B981" />
                    <Text style={styles.proActiveText}>
                      {membership.planType === 'lifetime'
                        ? t('paywall.lifetimeBadge')
                        : t('paywall.yearlyBadge')}
                    </Text>
                  </View>

                  {/* If user is Yearly Subscriber, allow upgrading to Lifetime Buyout */}
                  {membership.planType === 'yearly' ? (
                    <JellyPressable disabled={!lifetimeProduct || Boolean(pendingAction)} style={[styles.paywallPlanCtaLifetime, (!lifetimeProduct || pendingAction) && { opacity: 0.55 }]} onPress={() => handleBuy('lifetime')}>
                      <View style={styles.paywallPlanRow}>
                        <View style={styles.paywallPlanHeader}>
                          {pendingAction === 'lifetime' ? <ActivityIndicator color="#FFD700" /> : <Ionicons name="sparkles" size={20} color="#FFD700" />}
                          <Text style={styles.paywallPlanTitleLifetime}>
                            {t('paywall.upgradeToLifetime', { price: lifetimePriceText })}
                          </Text>
                        </View>
                        <View style={styles.paywallPlanBadgeWrapLifetime}>
                          <Text style={styles.paywallPlanBadgeTextLifetime}>
                            {t('paywall.lifetimeBadge')}
                          </Text>
                        </View>
                      </View>
                    </JellyPressable>
                  ) : null}
                </View>
              ) : (
                <View style={styles.paywallPlanContainer}>
                  {/* Plan 1: Yearly Subscription (Solid White Pill) */}
                  <JellyPressable disabled={!yearlyProduct || Boolean(pendingAction)} style={[styles.paywallPlanCtaYearly, (!yearlyProduct || pendingAction) && { opacity: 0.55 }]} onPress={() => handleBuy('yearly')}>
                    <View style={styles.paywallPlanRow}>
                      <View style={styles.paywallPlanHeader}>
                        {pendingAction === 'yearly' ? <ActivityIndicator color="#111827" /> : <Ionicons name="sparkles" size={20} color="#111827" />}
                        <Text style={styles.paywallPlanTitleYearly}>
                          {yearlyPriceText}
                        </Text>
                      </View>
                      <View style={styles.paywallPlanBadgeWrapYearly}>
                        <Text style={styles.paywallPlanBadgeTextYearly}>
                          {t('paywall.yearlyBadge')}
                        </Text>
                      </View>
                    </View>
                  </JellyPressable>

                  {/* Plan 2: Lifetime Buyout (Frosted Glass Pill) */}
                  <JellyPressable disabled={!lifetimeProduct || Boolean(pendingAction)} style={[styles.paywallPlanCtaLifetime, (!lifetimeProduct || pendingAction) && { opacity: 0.55 }]} onPress={() => handleBuy('lifetime')}>
                    <View style={styles.paywallPlanRow}>
                      <View style={styles.paywallPlanHeader}>
                        {pendingAction === 'lifetime' ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="infinite" size={20} color="#FFFFFF" />}
                        <Text style={styles.paywallPlanTitleLifetime}>
                          {lifetimePriceText}
                        </Text>
                      </View>
                      <View style={styles.paywallPlanBadgeWrapLifetime}>
                        <Text style={styles.paywallPlanBadgeTextLifetime}>
                          {t('paywall.lifetimeBadge')}
                        </Text>
                      </View>
                    </View>
                  </JellyPressable>
                </View>
              )}

              {/* 3.1.2: auto-renewal terms must be disclosed in the purchase UI */}
              <Text style={styles.autoRenewText}>{t('paywall.autoRenewDisclosure')}</Text>

              {/* Adaptive Flow Footer Actions */}
              <View style={styles.paywallActions}>
                <JellyPressable disabled={Boolean(pendingAction)} style={[styles.paywallActionBtn, pendingAction && { opacity: 0.55 }]} onPress={handleRestore}>
                  {pendingAction === 'restore' ? <ActivityIndicator size="small" color="#A6E1FF" /> : <Ionicons name="cart-outline" size={14} color="#A6E1FF" />}
                  <Text style={styles.paywallActionText}>{t('paywall.restoreBtn')}</Text>
                </JellyPressable>

                <Text style={styles.legalDot}>·</Text>

                <JellyPressable style={styles.paywallActionBtn} onPress={() => void openLegal('privacy')}>
                  <Text style={styles.paywallActionTextSub}>{t('legal.privacyTitle')}</Text>
                </JellyPressable>

                <Text style={styles.legalDot}>·</Text>

                <JellyPressable style={styles.paywallActionBtn} onPress={() => void openLegal('terms')}>
                  <Text style={styles.paywallActionTextSub}>{t('legal.termsTitle')}</Text>
                </JellyPressable>
              </View>
            </GlassPanel>
          </ScrollView>
        </View>
      </Modal>

    </>
  );
}

const styles = StyleSheet.create({
  catalogErrorRow: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  catalogErrorText: {
    color: '#FFD2D2',
    fontSize: 12,
    textAlign: 'center',
  },
  catalogFallbackNote: {
    marginBottom: 12,
  },
  catalogRetryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  catalogRetryText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  scroll: { width: '100%', maxWidth: 380 },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    width: '100%',
    maxWidth: 380,
  },
  paywallCard: {
    width: '100%',
    padding: 24,
    alignItems: 'center',
    backgroundColor: 'rgba(18, 19, 24, 0.92)',
    borderColor: 'rgba(255, 255, 255, 0.36)',
    position: 'relative',
  },
  closeBtnWrap: {
    position: 'absolute',
    right: 14,
    top: 14,
    zIndex: 30,
  },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  paywallBadge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 245, 234, 0.18)',
    borderColor: 'rgba(255, 245, 234, 0.45)',
    borderWidth: 1,
    marginBottom: 12,
    marginTop: 6,
  },
  paywallBrandText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  paywallBadgePro: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  freePolicy: { color: '#BEB8CA', fontSize: 12, lineHeight: 18, textAlign: 'center', marginBottom: 18 },
  paywallTitle: {
    paddingTop: 18,
    paddingHorizontal: 12,
    color: '#FFFFFF',
    fontSize: 21,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },
  paywallSubtitle: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  paywallPrivilegeList: {
    width: '100%',
    gap: 10,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    marginBottom: 20,
  },
  paywallPrivilegeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  paywallPrivilegeText: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '600',
    flexShrink: 1,
  },
  paywallPlanContainer: {
    width: '100%',
    gap: 12,
    marginBottom: 18,
  },
  proActiveCard: {
    width: '100%',
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.45)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  proActiveText: {
    color: '#10B981',
    fontSize: 15,
    fontWeight: '800',
  },
  paywallPlanCtaYearly: {
    width: '100%',
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  paywallPlanCtaLifetime: {
    width: '100%',
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  paywallPlanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  paywallPlanHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  paywallPlanTitleYearly: {
    color: '#111827',
    fontSize: 17.5,
    fontWeight: '800',
    flexShrink: 0,
  },
  paywallPlanBadgeWrapYearly: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(17, 24, 39, 0.08)',
    flexShrink: 0,
  },
  paywallPlanBadgeTextYearly: {
    color: 'rgba(17, 24, 39, 0.85)',
    fontSize: 11.5,
    fontWeight: '600',
  },
  paywallPlanTitleLifetime: {
    color: '#FFFFFF',
    fontSize: 17.5,
    fontWeight: '800',
    flexShrink: 1,
  },
  paywallPlanBadgeWrapLifetime: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    flexShrink: 1,
  },
  paywallPlanBadgeTextLifetime: {
    color: 'rgba(255, 255, 255, 0.90)',
    fontSize: 11.5,
    fontWeight: '600',
    flexShrink: 1,
  },
  paywallActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  autoRenewText: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
    marginBottom: 14,
  },
  paywallActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  paywallActionText: {
    color: '#A6E1FF',
    fontSize: 12.5,
    fontWeight: '600',
  },
  paywallActionTextSub: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 12,
    fontWeight: '500',
  },
  legalDot: {
    color: 'rgba(255, 255, 255, 0.30)',
    fontSize: 12,
  },
});
