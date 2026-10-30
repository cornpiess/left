export const DAILY_FREE_LIMIT = 100;

export const IAP_SKUS = Object.freeze({
  YEARLY: 'com.cornpiess.hairball.yearly',
  LIFETIME: 'com.cornpiess.hairball.lifetime',
});

export function getCatalogProductId(product) {
  return product?.id || product?.productId || product?.sku || null;
}

export function getPurchaseProductId(purchase) {
  return purchase?.productId || purchase?.currentPlanId || purchase?.sku || null;
}

export const IAP_REQUEST_TIMEOUT_MS = 10000;
export const IAP_RETRY_DELAYS_MS = [1000, 3000];

export function resolveCatalogStatus(productsMap) {
  const hasYearly = Boolean(productsMap?.[IAP_SKUS.YEARLY]);
  const hasLifetime = Boolean(productsMap?.[IAP_SKUS.LIFETIME]);
  if (hasYearly && hasLifetime) return 'ready';
  if (hasYearly || hasLifetime) return 'partial';
  return 'error';
}

export function indexIapProducts(products) {
  const indexed = {};
  for (const product of Array.isArray(products) ? products : []) {
    const id = getCatalogProductId(product);
    if (id === IAP_SKUS.YEARLY || id === IAP_SKUS.LIFETIME) indexed[id] = product;
  }
  return indexed;
}

export function getProductDisplayPrice(product, fallback = '') {
  return product?.displayPrice || product?.localizedPrice || fallback;
}

export function getPlanTypeForProductId(productId) {
  if (productId === IAP_SKUS.LIFETIME) return 'lifetime';
  if (productId === IAP_SKUS.YEARLY) return 'yearly';
  return null;
}

export function resolveEntitlement(purchases) {
  const planTypes = (Array.isArray(purchases) ? purchases : []).map((purchase) => getPlanTypeForProductId(getPurchaseProductId(purchase)));
  if (planTypes.includes('lifetime')) return 'lifetime';
  if (planTypes.includes('yearly')) return 'yearly';
  return null;
}
