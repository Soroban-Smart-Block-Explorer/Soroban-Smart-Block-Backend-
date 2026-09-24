import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';
import { Keypair } from '@stellar/stellar-sdk';
import type { WalletSigner } from '@soroban-explorer/mobile';

const WALLET_SECRET_KEY = 'soroban_wallet_secret';

/**
 * The wallet secret is kept in the OS keychain and only used to sign the
 * short-lived login challenge. It never leaves the device and is never sent to
 * the backend.
 *
 * Note: `@stellar/stellar-sdk` expects a Node `Buffer`; Metro resolves the
 * `buffer` package pulled in as a dependency (see mobile/package.json).
 */
function signerFromSecret(secret: string): WalletSigner {
  const keypair = Keypair.fromSecret(secret);
  return {
    getAddress: () => keypair.publicKey(),
    sign: async (message: string) => keypair.sign(Buffer.from(message, 'utf8')).toString('base64'),
  };
}

/** Loads the on-device wallet signer, or null when the user has no wallet yet. */
export async function loadWalletSigner(): Promise<WalletSigner | null> {
  const secret = await SecureStore.getItemAsync(WALLET_SECRET_KEY);
  return secret ? signerFromSecret(secret) : null;
}

/** Creates and persists a new wallet, returning its signer. */
export async function createWalletSigner(): Promise<WalletSigner> {
  const keypair = Keypair.random();
  await SecureStore.setItemAsync(WALLET_SECRET_KEY, keypair.secret());
  return signerFromSecret(keypair.secret());
}
