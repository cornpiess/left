import { readFileSync } from 'node:fs';
import { validatePromotionConfig } from '../src/promotions.mjs';

try {
  const config = JSON.parse(readFileSync(new URL('../config/promotions.json', import.meta.url), 'utf8'));
  const errors = validatePromotionConfig(config);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Promotion configuration is valid.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
