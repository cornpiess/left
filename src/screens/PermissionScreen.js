import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Haptics from 'expo-haptics';
import { GlassPanel, JellyPressable } from '../components/Glass';
import MaoQiuIcon from '../components/MaoQiuIcon';
import { useI18n } from '../i18n';

export default function PermissionScreen({ onGranted, onUnsupported }) {
  const [status, setStatus] = useState('idle');
  const { t } = useI18n();

  const handlePress = async () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    if (status === 'denied') {
      // After an explicit denial the system prompt never reappears; the only
      // way forward is the Settings deep link.
      try { await Linking.openSettings(); } catch {}
      return;
    }
    setStatus('requesting');
    try {
      const res = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      if (res.granted) {
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
        onGranted();
      } else {
        setStatus('denied');
      }
    } catch (e) {
      onUnsupported();
    }
  };

  useEffect(() => {
    // The user may enable the permission in Settings and come straight back;
    // re-check on foreground so they are never stranded on this screen.
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active') return;
      try {
        const res = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        if (res.granted) onGranted();
      } catch {}
    });
    return () => sub.remove();
  }, [onGranted]);

  return (
    <View style={styles.container}>
      <View style={styles.contentCard}>
        <GlassPanel style={styles.glassInner} radius={28} intensity={85}>
          {/* Brand Icon */}
          <View style={styles.logoBadge}>
            <MaoQiuIcon size={56} color="#FFFFFF" />
          </View>

          <Text style={styles.title}>{t('common.appName')}</Text>
          <Text style={styles.subtitle}>{t('permission.tagline')}</Text>

          {/* 2 Ultra-Clean Bullet Cards */}
          <View style={styles.featureList}>
            {/* Point 1: Need Permission */}
            <View style={styles.featureItem}>
              <View style={styles.iconWrapBlue}>
                <Ionicons name="images-outline" size={20} color="#60A5FA" />
              </View>
              <View style={styles.featureTextWrap}>
                <Text style={styles.featureTitle}>{t('permission.feature1Title')}</Text>
                <Text style={styles.featureSub}>{t('permission.feature1Sub')}</Text>
              </View>
            </View>

            {/* Point 2: Local Processing */}
            <View style={styles.featureItem}>
              <View style={styles.iconWrapGreen}>
                <Ionicons name="shield-checkmark-outline" size={20} color="#34D399" />
              </View>
              <View style={styles.featureTextWrap}>
                <Text style={styles.featureTitle}>{t('permission.feature2Title')}</Text>
                <Text style={styles.featureSub}>{t('permission.feature2Sub')}</Text>
              </View>
            </View>
          </View>

          {/* High-Contrast Clear CTA Button */}
          <JellyPressable
            style={styles.button}
            onPress={handlePress}
            disabled={status === 'requesting'}
          >
            {status === 'requesting' ? (
              <ActivityIndicator color="#111827" />
            ) : (
              <View style={styles.btnRow}>
                <Text style={styles.buttonText}>
                  {status === 'denied' ? t('permission.settingsBtn') : t('permission.grantBtn')}
                </Text>
                <Ionicons name="arrow-forward" size={18} color="#111827" />
              </View>
            )}
          </JellyPressable>

          {status === 'denied' && (
            <Text style={styles.deniedTip}>{t('permission.deniedTip')}</Text>
          )}
        </GlassPanel>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0E12',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  contentCard: {
    width: '100%',
    maxWidth: 360,
  },
  glassInner: {
    width: '100%',
    padding: 24,
    alignItems: 'center',
    backgroundColor: 'rgba(18, 19, 24, 0.92)',
    borderColor: 'rgba(255, 255, 255, 0.36)',
  },
  logoBadge: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(255, 245, 234, 0.18)',
    borderColor: 'rgba(255, 245, 234, 0.45)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 18,
  },
  featureList: {
    width: '100%',
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    marginBottom: 20,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconWrapBlue: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(96, 165, 250, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapGreen: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(52, 211, 153, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(52, 211, 153, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureTextWrap: {
    flex: 1,
  },
  featureTitle: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '700',
    marginBottom: 2,
  },
  featureSub: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 12,
  },
  button: {
    width: '100%',
    height: 50,
    borderRadius: 25,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '800',
  },
  deniedTip: {
    color: '#EF4444',
    fontSize: 12.5,
    marginTop: 12,
    textAlign: 'center',
  },
});
