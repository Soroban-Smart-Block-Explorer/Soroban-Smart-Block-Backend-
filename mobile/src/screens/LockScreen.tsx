import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthContext';

export function LockScreen() {
  const { unlock, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUnlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await unlock();
      if (!ok) setError('Biometric authentication failed.');
    } catch {
      setError('Could not unlock. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [unlock]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Soroban Explorer</Text>
      <Text style={styles.subtitle}>Locked</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.primaryButton} onPress={onUnlock} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#f8fafc" />
        ) : (
          <Text style={styles.primaryButtonText}>Unlock with biometrics</Text>
        )}
      </Pressable>

      <Pressable onPress={signOut} disabled={busy}>
        <Text style={styles.link}>Sign in with a different account</Text>
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
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 8, marginBottom: 24 },
  error: { color: '#f87171', marginBottom: 16 },
  primaryButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 10,
    minWidth: 240,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#f8fafc', fontWeight: '600', fontSize: 16 },
  link: { color: '#94a3b8', marginTop: 20 },
});
