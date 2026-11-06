import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Feedback from './Feedback';
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
      <Feedback variant="page" state="error" title={t('error.boundaryTitle')} detail={t('error.boundaryBody')} actionLabel={t('error.boundaryRetry')} onAction={onRetry} />
      {__DEV__ && error?.message ? <Text style={styles.detail}>{error.message}</Text> : null}
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
  detail: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 18,
  },

});
