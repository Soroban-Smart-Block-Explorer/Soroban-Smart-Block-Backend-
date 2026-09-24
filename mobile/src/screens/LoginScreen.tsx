import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthContext';

export function LoginScreen() {
  const { signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }, [signIn]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Soroban Explorer</Text>
      <Text style={styles.subtitle}>
        Sign in with your Stellar wallet to sync your tier and premium features.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.primaryButton} onPress={onSignIn} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#f8fafc" />
        ) : (
          <Text style={styles.primaryButtonText}>Continue with wallet</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f8fafc' },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 8,
    marginBottom: 24,
    textAlign: 'center',
  },
  error: { color: '#f87171', marginBottom: 16, textAlign: 'center' },
  primaryButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 10,
    minWidth: 240,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#f8fafc', fontWeight: '600', fontSize: 16 },
});
