import { ParsedArg } from './xdr-parser';

export interface IdentityVerificationDecoded {
  isVerified: boolean;
  complianceMessage: string;
}

/**
 * Parses Mastercard Crypto Credential flags from transaction arguments.
 * Assuming flags are passed as a bitmask in a u32 argument.
 */
export function decodeMastercardFlags(args: ParsedArg[]): IdentityVerificationDecoded | null {
  // Find an argument that might be the compliance flags.
  // In a real-world scenario, we'd need the ABI or argument names to be certain.
  // We look for a 'u32' argument, which is common for bitmasks.
  const flagArg = args.find((a) => a.type === 'u32' || a.type === 'i32');

  if (!flagArg) return null;

  // Assume bit 0 is the compliance verification flag
  const flags = Number(flagArg.value);
  const isVerified = (flags & 1) === 1;

  return {
    isVerified,
    complianceMessage: isVerified
      ? 'Address verified through regulated enterprise compliance gate.'
      : 'Address verification failed or not provided.',
  };
}
