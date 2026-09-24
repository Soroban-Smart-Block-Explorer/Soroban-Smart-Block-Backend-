import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthContext';

/** Premium-only features unlocked with biometrics, mirroring the web tiers. */
const PREMIUM_FEATURE_COPY: Record<string, string> = {
  webhooks: 'Real-time webhooks for wallet and contract activity',
  multi_sig_auth: 'Multi-signature approvals for sensitive actions',
  data_export: 'CSV / JSON data export',
  custom_branding: 'Custom branding for shared dashboards',
  priority_rate_limit: 'Priority rate limits (10x headroom)',
};

export function PremiumScreen() {
  const { entitlements, unlockPremium } = useAuth();
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUnlock = useCallback(async () => {
    setError(null);
    const ok = await unlockPremium();
    if (ok) {
      setUnlocked(true);
    } else {
      setError('Biometric check failed or your tier does not include premium features.');
    }
  }, [unlockPremium]);

  const features = entitlements?.features ?? [];
  const isPremium = entitlements?.isPremium ?? false;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Premium Features</Text>
      <Text style={styles.subtitle}>Current tier: {entitlements?.tier ?? 'unknown'}</Text>

      {isPremium ? (
        unlocked ? (
          <View style={styles.card}>
            {features.map((feature) => (
              <Text key={feature} style={styles.feature}>
                • {PREMIUM_FEATURE_COPY[feature] ?? feature}
              </Text>
            ))}
          </View>
        ) : (
          <Pressable style={styles.primaryButton} onPress={onUnlock}>
            <Text style={styles.primaryButtonText}>Unlock with biometrics</Text>
          </Pressable>
        )
      ) : (
        <Text style={styles.hint}>
          Your account tier does not include premium features yet. Upgrade on the web to bring
          your entitlements to mobile.
        </Text>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 24 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#f8fafc' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 8, marginBottom: 24 },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  feature: { color: '#e2e8f0', fontSize: 15 },
  hint: { color: '#94a3b8', fontSize: 15, lineHeight: 22 },
  error: { color: '#f87171', marginTop: 16 },
  primaryButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#f8fafc', fontWeight: '600', fontSize: 16 },
});
