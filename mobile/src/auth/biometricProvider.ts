import * as LocalAuthentication from 'expo-local-authentication';
import type { BiometricProvider, BiometricType } from '@soroban/sdk';

function mapType(types: LocalAuthentication.AuthenticationType[]): BiometricType {
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'faceid';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'fingerprint';
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'iris';
  return 'none';
}

/**
 * BiometricProvider backed by `expo-local-authentication` (Face ID / Touch ID /
 * Android BiometricPrompt). Biometrics gate session unlock and premium-access
 * step-up, not the wallet secret itself.
 */
export const biometricProvider: BiometricProvider = {
  async authenticate(reason: string) {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return { success: true, biometricType: 'none' as const };

    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!enrolled) return { success: true, biometricType: 'none' as const };

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });

    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return {
      success: result.success,
      error: result.success ? undefined : result.error,
      biometricType: mapType(types),
    };
  },

  async getBiometricType() {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return mapType(types);
  },

  async isAvailable() {
    return (
      (await LocalAuthentication.hasHardwareAsync()) &&
      (await LocalAuthentication.isEnrolledAsync())
    );
  },
};
