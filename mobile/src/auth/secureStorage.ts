import * as SecureStore from 'expo-secure-store';
import type { SecureStorageProvider } from '@soroban-explorer/mobile';

/**
 * SecureStorageProvider backed by `expo-secure-store` (iOS Keychain /
 * Android Keystore). This is where the refresh token and wallet secret live.
 */
export const secureStorage: SecureStorageProvider = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
