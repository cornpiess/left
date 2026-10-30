import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

import { useI18n } from '../i18n';

export default function UnsupportedScreen() {
  const { t } = useI18n();

  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Ionicons name="alert-circle-outline" size={44} color={colors.primarySoft} />
      </View>
      <Text style={styles.title}>{t('unsupported.title')}</Text>
      <Text style={styles.message}>{t('unsupported.subtitle')}</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>iPhone + iOS</Text>
        <Text style={styles.cardText}>· Use an iPhone with iOS for the native PhotoKit memory feed.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 14,
  },
  badge: {
    width: 84,
    height: 84,
    borderRadius: 24,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  message: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
    gap: 8,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  cardText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  code: {
    color: colors.primarySoft,
    fontFamily: 'monospace',
  },
});
