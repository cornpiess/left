import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassPanel, JellyPressable } from './Glass';
import { useI18n } from '../i18n';
import { colors } from '../theme';

/**
 * Last-resort crash net (stability audit #1). Without this, ANY render
 * exception kills the process in a release build — a white flash and an
 * App Store 1-star. With it, the same exception degrades to this card and
 * the user can retry by re-mounting the subtree.
 */
function ErrorFallback({ error, onRetry }) {
  const { t } = useI18n();
  return (
    <View style={styles.container}>
      <GlassPanel style={styles.card} radius={28} intensity={85}>
        <View style={styles.iconWrap}>
          <Ionicons name="warning-outline" size={40} color="#FBBF24" />
        </View>
        <Text style={styles.title}>{t('error.boundaryTitle')}</Text>
        <Text style={styles.body} numberOfLines={4}>
          {t('error.boundaryBody')}
        </Text>
        {__DEV__ && error?.message ? (
          <Text style={styles.detail} numberOfLines={6}>{error.message}</Text>
        ) : null}
        <JellyPressable style={styles.button} onPress={onRetry}>
          <Text style={styles.buttonText}>{t('error.boundaryRetry')}</Text>
        </JellyPressable>
      </GlassPanel>
    </View>
  );
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // No telemetry in this app (PRD: 100% local) — console is our flight
    // recorder for device logs / Xcode console triage.
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    padding: 24,
    alignItems: 'center',
    backgroundColor: 'rgba(18, 19, 24, 0.92)',
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(251, 191, 36, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },
  body: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 18,
  },
  detail: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 18,
  },
  button: {
    width: '100%',
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '800',
  },
});
