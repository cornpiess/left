// Only public merchandising data lives here. StoreKit remains the price and
// entitlement authority. No network request runs until the paywall loads prices.
export const PROMOTIONS_URL = 'https://raw.githubusercontent.com/cornpiess/left/main/config/promotions.json';
export const PROMOTIONS_TIMEOUT_MS = 15000;
export const PROMOTIONS_MAX_AGE_MS = 5 * 60 * 1000;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPrice = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isTimestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

export function validatePromotionConfig(config) {
  const errors = [];
  if (!isRecord(config) || config.version !== 1 || !isRecord(config.lifetime)) {
    return ['Expected version: 1 and a lifetime object'];
  }
  for (const key of Object.keys(config)) {
    if (!['version', 'lifetime'].includes(key)) errors.push(`Unknown field: ${key}`);
  }
  for (const [region, offer] of Object.entries(config.lifetime)) {
    const prefix = `lifetime.${region}`;
    if (!/^[A-Z]{3}$/.test(region) || !isRecord(offer)) {
      errors.push(`${prefix}: use an Apple three-letter country code and an object`);
      continue;
    }
    for (const key of Object.keys(offer)) {
      if (!['currency', 'regularPrice', 'salePrice', 'startsAt', 'endsAt'].includes(key)) errors.push(`${prefix}: unknown field ${key}`);
    }
    if (!/^[A-Z]{3}$/.test(offer.currency || '')) errors.push(`${prefix}: invalid currency`);
    if (!isPrice(offer.regularPrice) || !isPrice(offer.salePrice) || offer.salePrice >= offer.regularPrice) {
      errors.push(`${prefix}: regularPrice must be greater than salePrice, both positive numbers`);
    }
    for (const key of ['startsAt', 'endsAt']) {
      if (offer[key] !== undefined && !isTimestamp(offer[key])) errors.push(`${prefix}.${key}: include date, time and timezone`);
    }
    if (offer.startsAt && offer.endsAt && Date.parse(offer.endsAt) <= Date.parse(offer.startsAt)) errors.push(`${prefix}: endsAt must follow startsAt`);
  }
  return errors;
}

export function resolveLifetimePromotion({ config, storefront, product, receivedAt, now = Date.now() }) {
  if (validatePromotionConfig(config).length || !Number.isFinite(receivedAt)
    || now < receivedAt || now - receivedAt >= PROMOTIONS_MAX_AGE_MS) return null;
  const offer = config.lifetime[typeof storefront === 'string' ? storefront.trim().toUpperCase() : ''];
  if (!offer || !isPrice(product?.price) || !product?.displayPrice
    || product.currency !== offer.currency || Math.abs(product.price - offer.salePrice) > 0.000001) return null;
  if (offer.startsAt && now < Date.parse(offer.startsAt)) return null;
  if (offer.endsAt && now >= Date.parse(offer.endsAt)) return null;
  return { ...offer, savings: offer.regularPrice - offer.salePrice };
}

// Store price strings are never parsed or reconstructed. These derived values
// use the UI language plus the product's currency, including 0/3-decimal ones.
export function formatPromotionMoney(value, currency, locale = 'en') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

export function nextPromotionBoundary(config, receivedAt, now = Date.now()) {
  if (!Number.isFinite(receivedAt)) return null;
  const boundaries = [receivedAt + PROMOTIONS_MAX_AGE_MS];
  for (const offer of Object.values(config?.lifetime || {})) {
    if (offer.startsAt) boundaries.push(Date.parse(offer.startsAt));
    if (offer.endsAt) boundaries.push(Date.parse(offer.endsAt));
  }
  const upcoming = boundaries.filter(time => Number.isFinite(time) && time > now);
  return upcoming.length ? Math.min(...upcoming) : null;
}

export async function fetchPromotionConfig({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = PROMOTIONS_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    // A bounded request and explicit cache bust allow editing one GitHub file.
    // No disk cache: failure or a removed offer must never revive an old sale.
    const timestamp = now();
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(`${PROMOTIONS_URL}?t=${timestamp}`, { signal: controller.signal, cache: 'no-store' }))
        .then(async response => {
          if (!response.ok) throw new Error('Promotion configuration unavailable');
          const text = await response.text();
          if (text.length > 32768) throw new Error('Promotion configuration too large');
          return JSON.parse(text);
        }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Promotion configuration timed out')); }, timeoutMs); }),
    ]);
    if (validatePromotionConfig(response).length) return null;
    return { config: response, receivedAt: now() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
