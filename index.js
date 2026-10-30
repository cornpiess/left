import { registerRootComponent } from 'expo';

import App from './App';

// Global JS error flight recorder: release crashes at least leave a trace in
// device console / Xcode logs for triage (no telemetry — PRD 100% local).
try {
  if (typeof global.ErrorUtils !== 'undefined' && global.ErrorUtils?.setGlobalHandler) {
    global.ErrorUtils.setGlobalHandler((error, isFatal) => {
      console.error(`[GlobalError] fatal=${isFatal}`, error);
    });
  }
} catch {}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
