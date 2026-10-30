import { Platform } from 'react-native';
import { reviewStore } from './reviewStore.js';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import promoHashes from './promoHashes.json';
import {
  DAILY_FREE_LIMIT,
  IAP_REQUEST_TIMEOUT_MS,
  IAP_RETRY_DELAYS_MS,
  IAP_SKUS,
  getPlanTypeForProductId,
  getPurchaseProductId,
  indexIapProducts,
  resolveCatalogStatus,
  resolveEntitlement,
} from './membershipCore.mjs';

export { DAILY_FREE_LIMIT, IAP_SKUS } from './membershipCore.mjs';

const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.executionEnvironment === 'storeClient';

let RNIapModule = null;
function getRNIap() {
  if (RNIapModule) return RNIapModule;
  // Expo Go client lacks NitroModules native C++ binaries compiled into the app shell.
  // Skip require in Expo Go to avoid NitroModules ModuleNotFoundError Red Screen.
  if (isExpoGo) {
    return null;
  }
  try {
    const mod = require('react-native-iap');
    const realMod = mod?.initConnection ? mod : (mod?.default || mod);
    if (realMod && typeof realMod.initConnection === 'function') {
      RNIapModule = realMod;
      return RNIapModule;
    }
  } catch (e) {
    // Native module not linked
  }
  return null;
}

const MEMBERSHIP_FILE = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}vibe-membership.json` : null;
export const PRICING_PLANS = {
  YEARLY: {
    id: 'yearly',
    sku: IAP_SKUS.YEARLY,
    price: 28,
    title: '¥28 / 年',
    subTitle: '自动续期订阅 · 告别配额限制',
    badge: '超值推荐',
    type: 'subs',
  },
  LIFETIME: {
    id: 'lifetime',
    sku: IAP_SKUS.LIFETIME,
    price: 98,
    title: '¥98 终身',
    subTitle: '非消耗型买断 · 享受后续所有更新',
    badge: '终身尊享',
    type: 'in-app',
  },
};

let membershipState = {
  isPro: false,
  planType: null, // 'yearly' | 'lifetime' | null
  entitlementSource: null, // 'storekit' | 'promo' | 'simulated' | 'legacy' | null
  date: getTodayString(),
  usedToday: 0,
  dailyLimit: DAILY_FREE_LIMIT,
  hasSeenPaywall: false,
};

let loaded = false;
let iapConnected = false;
let purchaseUpdateSubscription = null;
let purchaseErrorSubscription = null;
let pendingPurchase = null;
const listeners = new Set();
const productListeners = new Set();

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function notify() {
  const snapshot = { ...membershipState };
  listeners.forEach((fn) => {
    try { fn(snapshot); } catch {}
  });
}

async function persist() {
  if (!MEMBERSHIP_FILE) return;
  try {
    await FileSystem.writeAsStringAsync(MEMBERSHIP_FILE, JSON.stringify(membershipState));
  } catch {}
}

let iapProductsMap = {};
let iapCatalogStatus = 'idle';
let iapCatalogError = null;

function notifyProducts() {
  const snapshot = getIapCatalogState();
  productListeners.forEach((fn) => {
    try { fn(snapshot); } catch {}
  });
}

function settlePendingPurchase(result) {
  if (!pendingPurchase) return;
  clearTimeout(pendingPurchase.timeoutId);
  const resolve = pendingPurchase.resolve;
  pendingPurchase = null;
  resolve(result);
}

function withTimeout(task, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(task), timeout]).finally(() => clearTimeout(timer));
}

async function initConnectionWithRetry(RNIap) {
  let lastError = null;
  for (let attempt = 0; attempt <= IAP_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, IAP_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const result = await withTimeout(() => RNIap.initConnection(), IAP_REQUEST_TIMEOUT_MS);
      if (result) return true;
      lastError = new Error('StoreKit connection was not established');
    } catch (err) {
      lastError = err;
    }
    console.warn(`[IAP] initConnection attempt ${attempt + 1} failed:`, lastError?.message || lastError);
  }
  if (lastError) throw lastError;
  return false;
}

export async function fetchIapProducts() {
  const RNIap = getRNIap();
  if (!RNIap || !iapConnected) {
    iapCatalogStatus = 'error';
    iapCatalogError = 'StoreKit is not connected';
    notifyProducts();
    return iapProductsMap;
  }
  iapCatalogStatus = 'loading';
  iapCatalogError = null;
  notifyProducts();

  // StoreKit catalog reads are flaky in sandbox/review environments; retry with
  // backoff and a hard timeout so the paywall never strands on a single hang.
  let products = null;
  let lastError = null;
  for (let attempt = 0; attempt <= IAP_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, IAP_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      products = await withTimeout(
        () => RNIap.fetchProducts({
          skus: [IAP_SKUS.YEARLY, IAP_SKUS.LIFETIME],
          type: 'all',
        }),
        IAP_REQUEST_TIMEOUT_MS
      );
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.warn(`[IAP] fetchProducts attempt ${attempt + 1} failed:`, err?.message || err);
    }
  }

  if (Array.isArray(products)) {
    iapProductsMap = indexIapProducts(products);
  }
  iapCatalogStatus = resolveCatalogStatus(iapProductsMap);
  if (iapCatalogStatus === 'error') {
    iapCatalogError = lastError?.message || 'One or more App Store products are unavailable';
  } else if (iapCatalogStatus === 'partial') {
    iapCatalogError = 'One or more App Store products are unavailable';
  } else {
    iapCatalogError = null;
  }
  notifyProducts();
  return iapProductsMap;
}

export function getIapProductsMap() {
  return iapProductsMap;
}

export function getIapCatalogState() {
  return { products: { ...iapProductsMap }, status: iapCatalogStatus, error: iapCatalogError };
}

export function subscribeIapProducts(listener) {
  productListeners.add(listener);
  listener(getIapCatalogState());
  return () => productListeners.delete(listener);
}

export async function refreshIapCatalog() {
  if (!iapConnected) {
    await setupIap();
    return getIapCatalogState();
  }
  await fetchIapProducts();
  return getIapCatalogState();
}

export async function setupIap() {
  const RNIap = getRNIap();
  if (!RNIap) {
    iapConnected = false;
    iapCatalogStatus = 'error';
    iapCatalogError = isExpoGo ? 'StoreKit is unavailable in Expo Go' : 'StoreKit native module is unavailable';
    notifyProducts();
    return;
  }
  try {
    const connected = await initConnectionWithRetry(RNIap);
    iapConnected = connected;

    if (iapConnected) {
      if (!purchaseUpdateSubscription) {
        purchaseUpdateSubscription = RNIap.purchaseUpdatedListener(async (purchase) => {
          const productId = getPurchaseProductId(purchase);
          const planType = getPlanTypeForProductId(productId);
          if (!planType) {
            console.warn('[IAP] Ignoring purchase update for unknown product:', productId);
            return;
          }
          setProStatus(true, planType, 'storekit');
          try {
            await RNIap.finishTransaction({ purchase, isConsumable: false });
          } catch (e) {
            console.warn('[IAP] finishTransaction warning:', e?.message || e);
          }
          if (pendingPurchase?.sku === productId) {
            settlePendingPurchase({ success: true, mode: 'real', planType });
          }
        });
      }

      if (!purchaseErrorSubscription) {
        purchaseErrorSubscription = RNIap.purchaseErrorListener((error) => {
          console.warn('[IAP] purchaseErrorListener:', error?.message || error);
          const cancelled = error?.code === 'E_USER_CANCELLED' || error?.code === 'user-cancelled' || /cancelled|canceled/i.test(error?.message || '');
          settlePendingPurchase({
            success: false,
            cancelled,
            messageKey: cancelled ? 'paywall.buyCancelled' : 'paywall.buyFailed',
          });
        });
      }

      await fetchIapProducts();

      // Automatically sync and verify StoreKit active subscriptions on launch.
      // If the yearly subscription has expired/canceled, return to the free edition.
      void syncIapSubscriptionStatus();
    } else {
      iapCatalogStatus = 'error';
      iapCatalogError = 'StoreKit connection was not established';
      notifyProducts();
    }
  } catch (err) {
    console.warn('[IAP] initConnection failed after retries:', err?.message || err);
    iapConnected = false;
    iapCatalogStatus = 'error';
    iapCatalogError = err?.message || 'StoreKit connection failed';
    notifyProducts();
  }
}

export async function syncIapSubscriptionStatus() {
  const RNIap = getRNIap();
  if (!RNIap || !iapConnected) return;
  try {
    const purchases = await RNIap.getAvailablePurchases();
    if (Array.isArray(purchases)) {
      const entitlement = resolveEntitlement(purchases);
      if (entitlement) {
        setProStatus(true, entitlement, 'storekit');
      } else if (membershipState.entitlementSource === 'storekit') {
        // A refunded, revoked, expired, or canceled StoreKit entitlement must not survive locally.
        setProStatus(false, null);
      }
    }
  } catch (err) {
    console.warn('[IAP] syncIapSubscriptionStatus warning:', err?.message || err);
  }
}

export async function initMembership() {
  if (loaded) return membershipState;
  const today = getTodayString();
  if (MEMBERSHIP_FILE) {
    try {
      const info = await FileSystem.getInfoAsync(MEMBERSHIP_FILE);
      if (info.exists) {
        const raw = await FileSystem.readAsStringAsync(MEMBERSHIP_FILE);
        const data = JSON.parse(raw);
        membershipState.isPro = Boolean(data.isPro);
        membershipState.planType = data.planType || (data.isPro ? 'yearly' : null);
        membershipState.entitlementSource = data.entitlementSource || (data.isPro ? (data.planType === 'yearly' ? 'storekit' : 'legacy') : null);
        if (data.date === today) {
          membershipState.usedToday = typeof data.usedToday === 'number' ? data.usedToday : 0;
        } else {
          membershipState.usedToday = 0;
        }
        membershipState.date = today;
      }
    } catch {}
  }
  if (Platform.OS === 'ios') membershipState.usedToday = await reviewStore.dailyUsage(today);
  loaded = true;

  // Initialize StoreKit connection in background
  void setupIap();

  notify();
  return membershipState;
}

export function getMembershipState() {
  const today = getTodayString();
  if (membershipState.date !== today) {
    membershipState.date = today;
    membershipState.usedToday = 0;
    void persist();
  }
  return { ...membershipState };
}

export function subscribeMembership(listener) {
  listeners.add(listener);
  listener({ ...membershipState });
  return () => listeners.delete(listener);
}

export function applyDailyUsage(used, date = getTodayString()) {
  if (date !== getTodayString()) return;
  membershipState.date = date;
  membershipState.usedToday = used;
  notify();
}

export function setProStatus(isPro, planType = 'yearly', entitlementSource = 'legacy') {
  membershipState.isPro = Boolean(isPro);
  membershipState.planType = isPro ? planType : null;
  membershipState.entitlementSource = isPro ? entitlementSource : null;
  void persist();
  notify();
}

export function resetDailyQuota() {
  membershipState.usedToday = 0;
  membershipState.date = getTodayString();
  if (Platform.OS === 'ios') void reviewStore.resetQuota(membershipState.date).catch(() => {});
  void persist();
  notify();
}

export async function buyIapProduct(planTypeKey) {
  const plan = planTypeKey === 'lifetime' ? PRICING_PLANS.LIFETIME : PRICING_PLANS.YEARLY;
  const RNIap = getRNIap();

  if (!RNIap) {
    if (isExpoGo) {
      console.log('[IAP] Expo Go Client: Simulating PRO unlock for local dev testing');
      setProStatus(true, plan.id, 'simulated');
      return { success: true, mode: 'simulated', planType: plan.id };
    }
    return {
      success: false,
      messageKey: 'paywall.buyNoStorekit',
    };
  }

  if (!iapConnected) {
    try {
      await setupIap();
    } catch {}
  }

  try {
    const products = await fetchIapProducts();
    if (!products[plan.sku]) {
      return {
        success: false,
        messageKey: 'paywall.buyProductUnavailable',
      };
    }
    if (pendingPurchase) {
      return { success: false, messageKey: 'paywall.buyPending' };
    }
    const outcome = new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        settlePendingPurchase({ success: false, messageKey: 'paywall.buyTimeout' });
      }, 120000);
      pendingPurchase = { resolve, timeoutId, sku: plan.sku };
    });
    await RNIap.requestPurchase({
      request: {
        apple: { sku: plan.sku },
        google: { skus: [plan.sku] },
      },
      type: plan.type,
    });
    return await outcome;
  } catch (err) {
    if (pendingPurchase?.sku === plan.sku) {
      clearTimeout(pendingPurchase.timeoutId);
      pendingPurchase = null;
    }
    if (err?.code === 'E_USER_CANCELLED' || err?.message?.includes('cancelled')) {
      return { success: false, cancelled: true, messageKey: 'paywall.buyCancelled' };
    }
    console.warn('[IAP] Native purchase request error:', err?.message || err);
    return {
      success: false,
      messageKey: 'paywall.buyNotInvoked',
    };
  }
}

export async function restoreIapPurchases() {
  const RNIap = getRNIap();
  if (RNIap && !iapConnected) {
    try {
      await setupIap();
    } catch {}
  }

  if (RNIap && iapConnected) {
    try {
      await RNIap.restorePurchases();
      const purchases = await RNIap.getAvailablePurchases();
      if (Array.isArray(purchases) && purchases.length > 0) {
        const entitlement = resolveEntitlement(purchases);
        if (entitlement) {
          setProStatus(true, entitlement, 'storekit');
          return { success: true, restored: true, planType: entitlement };
        }
      }
      return { success: true, restored: false, messageKey: 'menu.noOrdersFound' };
    } catch (err) {
      console.warn('[IAP] restorePurchases warning:', err?.message || err);
      return { success: false, restored: false, messageKey: 'paywall.restoreConnectFailed' };
    }
  }

  return {
    success: false,
    restored: false,
    messageKey: isExpoGo ? 'paywall.restoreExpoGo' : 'paywall.restoreUnavailable',
  };
}

const PROMO_HASH_SET = new Set((promoHashes || []).map((h) => h.toLowerCase()));

export async function redeemActivationCode(rawCode) {
  if (!rawCode || typeof rawCode !== 'string') {
    return { success: false, messageKey: 'membership.promoEmpty' };
  }
  const cleanCode = rawCode.trim().toUpperCase();

  try {
    const inputHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      cleanCode
    );

    if (PROMO_HASH_SET.has(inputHash.toLowerCase())) {
      setProStatus(true, 'lifetime', 'promo');
      return {
        success: true,
        messageKey: 'membership.promoSuccess',
        planType: 'lifetime',
      };
    }
  } catch (err) {
    console.warn('[Membership] SHA-256 calculation failed:', err?.message || err);
  }

  return {
    success: false,
    messageKey: 'membership.promoInvalid',
  };
}
