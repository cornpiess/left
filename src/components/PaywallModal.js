import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassPanel, JellyPressable } from './Glass';
import { buyIapProduct, getIapCatalogState, getMembershipState, DAILY_FREE_LIMIT, IAP_SKUS, refreshIapCatalog, restoreIapPurchases, subscribeIapProducts } from '../membership';
import { getProductDisplayPrice } from '../membershipCore.mjs';
import { formatPromotionMoney, nextPromotionBoundary, resolveLifetimePromotion } from '../promotions.mjs';
import { useI18n } from '../i18n';
import { openLegalPage } from '../legalNavigation';
import { flightEvent } from '../flightRecorder';

export default function PaywallModal({ visible, reason = 'menu', onClose, onToast }) {
  const insets = useSafeAreaInsets();
  const { t, currentLocale } = useI18n();

  const [catalog, setCatalog] = useState(getIapCatalogState);
  const [pendingAction, setPendingAction] = useState(null);
  const [promotionClock, setPromotionClock] = useState(Date.now);
  const actionRef = useRef(false);
  const settingsReturnRef = useRef(false);
  const requestClose = () => { if (!actionRef.current) onClose?.(); };

  useEffect(() => subscribeIapProducts(setCatalog), []);
  useEffect(() => {
    if (visible && reason === 'menu') void refreshIapCatalog();
  }, [visible, reason]);

  useEffect(() => {
    if (!visible || !catalog.promotionContext) return undefined;
    const { config, receivedAt } = catalog.promotionContext;
    const boundary = nextPromotionBoundary(config, receivedAt, Date.now());
    if (boundary === null) return undefined;
    // Re-evaluate even if the paywall stays open across an end date or expiry.
    const timer = setTimeout(() => setPromotionClock(Date.now()), Math.min(boundary - Date.now() + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [visible, catalog.promotionContext, promotionClock]);

  useEffect(() => {
    if (!visible) { settingsReturnRef.current = false; return undefined; }
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      const returned = next === 'active' && previous !== 'active';
      previous = next;
      if (!returned || !settingsReturnRef.current) return;
      settingsReturnRef.current = false;
      if (!actionRef.current) void refreshIapCatalog();
    });
    return () => { settingsReturnRef.current = false; subscription.remove(); };
  }, [visible]);

  const openNetworkSettings = async () => {
    if (actionRef.current || settingsReturnRef.current) return;
    // Retrying prices cannot force a system authorization alert. Use Apple's
    // supported app-settings route, then refresh once on the explicit return.
    settingsReturnRef.current = true;
    try { await Linking.openSettings(); }
    catch {
      settingsReturnRef.current = false;
      onToast?.(t('paywall.networkSettingsFailed'));
    }
  };

  const membership = getMembershipState();
  const productsMap = catalog.products;
  const yearlyProduct = productsMap[IAP_SKUS.YEARLY];
  const lifetimeProduct = productsMap[IAP_SKUS.LIFETIME];

  // A Chinese fallback amount is misleading for other storefronts. No numeric
  // price or promotion is shown until StoreKit supplies that product's price.
  const yearlyPriceText = getProductDisplayPrice(yearlyProduct, t('paywall.pricePending'));
  const lifetimePriceText = getProductDisplayPrice(lifetimeProduct, t('paywall.pricePending'));
  const usingFallbackPrice = !yearlyProduct || !lifetimeProduct;
  const lifetimePromotion = visible && ['ready', 'partial'].includes(catalog.status)
    ? resolveLifetimePromotion({ ...catalog.promotionContext, product: lifetimeProduct, now: Date.now() }) : null;

  // All purchase paths share this layout, including a subscriber's upgrade.
  // Labels and badges wrap independently; no fixed card heights or text clips.
  const renderPlanContent = (plan, upgrading = false) => {
    const yearly = plan === 'yearly';
    const promotion = yearly ? null : lifetimePromotion;
    const color = yearly ? '#111827' : '#FFFFFF';
    const label = t(upgrading ? 'paywall.planUpgrade' : yearly ? 'paywall.planYearly' : 'paywall.planLifetime');
    const price = yearly ? yearlyPriceText : lifetimePriceText;
    return <View style={styles.planContent}>
      <View style={styles.planLabelRow}>
        <View style={styles.planLabelGroup}>
          {pendingAction === plan ? <ActivityIndicator color={color} /> : <Ionicons name={yearly ? 'sparkles' : 'infinite'} size={18} color={color} />}
          <Text style={[styles.planLabel, { color }]}>{label}</Text>
        </View>
        {promotion ? <View style={styles.saleBadge}>
          <Text style={styles.saleBadgeText}>{t('paywall.saleLimited')}</Text>
        </View> : null}
      </View>
      <View style={styles.planPriceRow}>
        <Text style={[styles.planPrice, { color }]} adjustsFontSizeToFit minimumFontScale={0.65} numberOfLines={1}>{price}</Text>
        {promotion ? <Text style={styles.originalPrice} accessibilityLabel={t('paywall.saleOriginal', { price: formatPromotionMoney(promotion.regularPrice, promotion.currency, currentLocale) })}>
          {formatPromotionMoney(promotion.regularPrice, promotion.currency, currentLocale)}
        </Text> : null}
      </View>
      {promotion ? <Text style={styles.saleSavings}>
        {t('paywall.saleSavings', { amount: formatPromotionMoney(promotion.savings, promotion.currency, currentLocale) })}
      </Text> : null}
    </View>;
  };

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
                {membership.isPro ? `${t('common.appName')} PRO` : t(reason === 'quota' ? 'paywall.limitTitle' : 'paywall.modalTitle', { limit: DAILY_FREE_LIMIT })}
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

              {catalog.status === 'error' || catalog.status === 'idle' ? (
                <View style={styles.catalogErrorRow}>
                  <Text style={styles.catalogErrorText}>{t(catalog.status === 'idle' ? 'paywall.loadPricesHint' : 'paywall.catalogUnavailable')}</Text>
                  {catalog.status === 'error' ? <Text style={styles.catalogErrorText}>{t('paywall.networkSettingsHint')}</Text> : null}
                  <View style={styles.catalogActions}>
                    <JellyPressable style={styles.catalogRetryBtn} disabled={Boolean(pendingAction)} onPress={() => void refreshIapCatalog()}>
                      <Text style={styles.catalogRetryText}>{t(catalog.status === 'idle' ? 'paywall.loadPrices' : 'paywall.retryCatalog')}</Text>
                    </JellyPressable>
                    {catalog.status === 'error' ? <JellyPressable style={styles.catalogRetryBtn} disabled={Boolean(pendingAction)} onPress={openNetworkSettings}>
                      <Text style={styles.catalogRetryText}>{t('paywall.openNetworkSettings')}</Text>
                    </JellyPressable> : null}
                  </View>
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
                    <JellyPressable containerStyle={styles.planTouchTarget} disabled={!lifetimeProduct || Boolean(pendingAction)} style={[styles.paywallPlanCtaLifetime, lifetimePromotion && styles.saleCard, (!lifetimeProduct || pendingAction) && { opacity: 0.55 }]} onPress={() => handleBuy('lifetime')}>
                      {renderPlanContent('lifetime', true)}
                    </JellyPressable>
                  ) : null}
                </View>
              ) : (
                <View style={styles.paywallPlanContainer}>
                  {/* Plan 1: Yearly Subscription (Solid White Pill) */}
                  <JellyPressable containerStyle={styles.planTouchTarget} disabled={!yearlyProduct || Boolean(pendingAction)} style={[styles.paywallPlanCtaYearly, (!yearlyProduct || pendingAction) && { opacity: 0.55 }]} onPress={() => handleBuy('yearly')}>
                    {renderPlanContent('yearly')}
                  </JellyPressable>

                  {/* Plan 2: Lifetime Buyout (Frosted Glass Pill) */}
                  <JellyPressable containerStyle={styles.planTouchTarget} disabled={!lifetimeProduct || Boolean(pendingAction)} style={[styles.paywallPlanCtaLifetime, lifetimePromotion && styles.saleCard, (!lifetimeProduct || pendingAction) && { opacity: 0.55 }]} onPress={() => handleBuy('lifetime')}>
                    {renderPlanContent('lifetime')}
                  </JellyPressable>
                </View>
              )}

              <Text style={styles.freePolicy}>{t('paywall.freePolicy', { limit: DAILY_FREE_LIMIT })}</Text>

              {/* 3.1.2: auto-renewal terms must be disclosed in the purchase UI */}
              <Text style={styles.autoRenewText}>{t('paywall.autoRenewDisclosure')}</Text>

              {/* Adaptive Flow Footer Actions */}
              <View style={styles.paywallActions}>
                <JellyPressable containerStyle={styles.footerTouchTarget} disabled={Boolean(pendingAction)} style={[styles.paywallActionBtn, pendingAction && { opacity: 0.55 }]} onPress={handleRestore}>
                  {pendingAction === 'restore' ? <ActivityIndicator size="small" color="#A6E1FF" /> : <Ionicons name="cart-outline" size={14} color="#A6E1FF" />}
                  <Text style={styles.paywallActionText}>{t('paywall.restoreBtn')}</Text>
                </JellyPressable>

                <View style={styles.legalLinksRow}>
                  <JellyPressable containerStyle={styles.footerTouchTarget} style={styles.paywallActionBtn} onPress={() => void openLegal('privacy')}>
                    <Text style={styles.paywallActionTextSub}>{t('menu.privacyPolicy')}</Text>
                  </JellyPressable>

                  <JellyPressable containerStyle={styles.footerTouchTarget} style={styles.paywallActionBtn} onPress={() => void openLegal('terms')}>
                    <Text style={styles.paywallActionTextSub}>{t('legal.termsTitle')}</Text>
                  </JellyPressable>
                </View>
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
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
  catalogActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
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
    paddingTop: 36,
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
    flexShrink: 1,
    textAlign: 'center',
  },
  paywallPlanCtaYearly: {
    width: '100%',
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
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
    paddingVertical: 14,
  },
  planTouchTarget: { width: '100%' },
  planContent: { width: '100%', gap: 7 },
  planLabelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  planLabelGroup: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: 120, minWidth: 0, gap: 7 },
  planLabel: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  planPriceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
  planPrice: { fontSize: 25, fontWeight: '800', flexShrink: 1, maxWidth: '100%', fontVariant: ['tabular-nums'] },
  originalPrice: { color: '#C9C5CE', fontSize: 14, textDecorationLine: 'line-through', flexShrink: 1 },
  saleCard: { backgroundColor: 'rgba(245, 185, 88, 0.10)', borderColor: '#CFA665' },
  saleBadge: { alignSelf: 'flex-start', maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: '#F6D79C' },
  saleBadgeText: { color: '#3B2810', fontSize: 11, fontWeight: '700', flexShrink: 1 },
  saleSavings: { color: '#F6D79C', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  paywallActions: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  legalLinksRow: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', columnGap: 12 },
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
    maxWidth: '100%',
  },
  footerTouchTarget: { maxWidth: '100%' },
  paywallActionText: {
    color: '#A6E1FF',
    fontSize: 12.5,
    fontWeight: '600',
    flexShrink: 1,
  },
  paywallActionTextSub: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
});
