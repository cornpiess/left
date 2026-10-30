import { useState } from 'react';
import { Modal, StyleSheet, Text, TextInput, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { GlassPanel, JellyPressable } from './Glass';
import { redeemActivationCode } from '../membership';
import { useI18n } from '../i18n';

export default function PromoCodeModal({ visible, onClose, onToast }) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { t } = useI18n();

  const handleRedeem = async () => {
    if (!code.trim()) {
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
      onToast?.(t('promo.enterValidCode'));
      return;
    }
    setSubmitting(true);
    const res = await redeemActivationCode(code);
    setSubmitting(false);

    if (res.success) {
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      onToast?.(t(res.messageKey || 'membership.promoSuccess'));
      setCode('');
      onClose?.();
    } else {
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
      onToast?.(t(res.messageKey || 'membership.promoInvalid'));
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <BlurView intensity={75} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.container}>
          <GlassPanel style={styles.card} radius={28} intensity={85}>
            {/* Top Close Button */}
            <JellyPressable style={styles.closeBtnWrap} onPress={onClose} hitSlop={10}>
              <View style={styles.closeBtn}>
                <Ionicons name="close" size={20} color="#FFFFFF" />
              </View>
            </JellyPressable>

            {/* Header */}
            <View style={styles.header}>
              <View style={styles.iconWrap}>
                <Text style={styles.brandText}>{t('common.appName')}</Text>
              </View>
              <Text style={styles.title}>{t('promo.title')}</Text>
              <Text style={styles.subtitle}>{t('promo.subtitle')}</Text>
            </View>

            {/* Input Box */}
            <View style={styles.inputWrap}>
              <Ionicons name="key-outline" size={20} color="rgba(255, 255, 255, 0.6)" style={styles.keyIcon} />
              <TextInput
                style={styles.input}
                value={code}
                onChangeText={setCode}
                placeholder={t('promo.placeholder')}
                placeholderTextColor="rgba(255, 255, 255, 0.4)"
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleRedeem}
              />
              {code.length > 0 ? (
                <JellyPressable onPress={() => setCode('')} hitSlop={6}>
                  <Ionicons name="close-circle" size={18} color="rgba(255, 255, 255, 0.5)" />
                </JellyPressable>
              ) : null}
            </View>

            {/* Full-Width MD3 / iOS Standard 52dp Pill CTA Button */}
            <JellyPressable style={styles.submitBtn} onPress={handleRedeem}>
              <View style={styles.submitInner}>
                <Ionicons name="checkmark-circle" size={20} color="#111827" />
                <Text style={styles.submitText}>{t('promo.submitBtn')}</Text>
              </View>
            </JellyPressable>

            {/* Secondary Cancel Action */}
            <JellyPressable style={styles.cancelBtn} onPress={onClose} hitSlop={8}>
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </JellyPressable>
          </GlassPanel>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.68)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  container: {
    width: '100%',
    maxWidth: 360,
  },
  card: {
    padding: 24,
    backgroundColor: 'rgba(18, 20, 26, 0.92)',
    alignItems: 'center',
    position: 'relative',
  },
  closeBtnWrap: {
    position: 'absolute',
    right: 16,
    top: 16,
    zIndex: 10,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 6,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  brandText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
    textAlign: 'center',
  },
  subtitle: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  inputWrap: {
    width: '100%',
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 20,
  },
  keyIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
  submitBtn: {
    width: '100%',
    marginBottom: 10,
  },
  submitInner: {
    width: '100%',
    height: 52,
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 28,
  },
  submitText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '800',
  },
  cancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  cancelText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 14,
    fontWeight: '600',
  },
});
