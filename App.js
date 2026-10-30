import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as MediaLibrary from 'expo-media-library/legacy';
import { colors } from './src/theme';
import PermissionScreen from './src/screens/PermissionScreen';
import HomeScreen from './src/screens/HomeScreen';
import UnsupportedScreen from './src/screens/UnsupportedScreen';

import { I18nProvider } from './src/i18n';
import ErrorBoundary from './src/components/ErrorBoundary';
import OnboardingScreen from './src/screens/OnboardingScreen';
import { readOnboardingCompleted, completeOnboarding } from './src/onboardingState';

const Stack = createNativeStackNavigator();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.card,
    primary: colors.primary,
    text: colors.text,
    border: 'transparent',
  },
};

function Root() {
  const [permission, setPermission] = useState(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(null);

  useEffect(() => {
    readOnboardingCompleted().then(setOnboardingCompleted);
  }, []);

  const refreshPermission = async () => {
    try {
      const res = await MediaLibrary.getPermissionsAsync(false, ['photo']);
      setPermission(res);
    } catch (e) {
      setPermission({ granted: false, unsupported: true });
    }
  };

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      setPermission({ granted: true, accessPrivileges: 'all' });
      return;
    }
    refreshPermission();
  }, []);

  if (onboardingCompleted === null || permission === null) {
    return null;
  }

  if (!onboardingCompleted) {
    return (
      <OnboardingScreen
        onComplete={(grantedPermission) => {
          completeOnboarding();
          setOnboardingCompleted(true);
          if (grantedPermission) setPermission(grantedPermission);
          else if (Platform.OS === 'ios') refreshPermission();
        }}
      />
    );
  }

  if (permission.unsupported) {
    return <UnsupportedScreen />;
  }

  if (!permission.granted) {
    return (
      <PermissionScreen
        onGranted={async () => {
          try {
            const res = await MediaLibrary.getPermissionsAsync(false, ['photo']);
            setPermission(res);
          } catch {
            setPermission({ granted: false, unsupported: true });
          }
        }}
        onUnsupported={() => setPermission({ granted: false, unsupported: true })}
      />
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="回忆">
        {(props) => <HomeScreen {...props} accessPrivileges={permission.accessPrivileges || 'all'} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <ErrorBoundary>
          <NavigationContainer theme={navTheme}>
            <Root />
          </NavigationContainer>
        </ErrorBoundary>
      </SafeAreaProvider>
    </I18nProvider>
  );
}
