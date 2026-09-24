import { SorobanExplorerAuth } from '@soroban-explorer/mobile';
import { secureStorage } from './secureStorage';
import { biometricProvider } from './biometricProvider';

const network = (process.env.EXPO_PUBLIC_STELLAR_NETWORK ?? 'testnet') as
  'testnet' | 'mainnet' | 'devnet';

/**
 * Shared auth client. Reuses the backend session-cookie/JWT endpoints so mobile
 * entitlements match the web app, with tokens kept in the OS secure store.
 */
export const authClient = new SorobanExplorerAuth(
  {
    baseUrl: process.env.EXPO_PUBLIC_API_URL ?? 'https://api.soroban.network',
    network,
    appId: 'explorer-mobile',
    // The web app uses the signed session cookie; including it on mobile keeps
    // the two clients on the same backend session.
    credentials: 'include',
  },
  secureStorage,
  biometricProvider,
);
