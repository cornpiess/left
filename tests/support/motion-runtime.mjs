import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as core from '../../src/motionCore.mjs';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

// Run the production motion helpers against a controllable native driver.
// The default hook avoids subscribing in tests that don't mount real effects.
export function loadMotionRuntime(native, react = { useSyncExternalStore: () => false }) {
  const code = babel.transformSync(readFileSync(new URL('../../src/motion.js', import.meta.url), 'utf8'), {
    configFile: false, babelrc: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  }).code;
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: id => ({ react, 'react-native': native, './motionCore.mjs': core })[id],
    Set, Math, Number, Boolean,
  });
  return exports;
}

export function loadBurstMotionRuntime(native, react, motion) {
  const code = babel.transformSync(readFileSync(new URL('../../src/useBurstMotion.js', import.meta.url), 'utf8'), {
    configFile: false, babelrc: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  }).code;
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: id => ({ react, 'react-native': native, './motion': motion })[id],
    Array, Math,
  });
  return exports;
}
