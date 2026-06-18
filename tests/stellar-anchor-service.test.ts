import { describe, it, expect } from 'vitest';

function parseTomlLocal(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section = 'main';
  const sections: Record<string, Record<string, unknown>> = { main: result };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      sections[section] = {};
      if (section === 'DOCUMENTATION' || section === 'CURRENCIES') {
        result[section] = sections[section];
      }
      continue;
    }

    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].trim();
    let value: unknown = kvMatch[2].trim().replace(/^"|"$/g, '');

    if (value === 'true') value = true;
    else if (value === 'false') value = false;

    if (section === 'main') {
      result[key] = value;
    } else {
      sections[section][key] = value;
    }
  }

  return result;
}

describe('anchor TOML parsing', () => {
  it('parses basic stellar.toml fields', () => {
    const toml = `
ORG_NAME = "AnchorUSD"
ORG_DBA = "Anchor USD"
HOME_DOMAIN = "anchorusd.com"
ACCOUNTS = "GCKFBEIYTKP6QXIZZ4LF5CM2WC6QHNEACV3EX2ZJOXZJD6FQX2QZJOXZ"
TRANSFER_SERVER = "https://anchorusd.com/sep6"
TRANSFER_SERVER_SEP0024 = "https://anchorusd.com/sep24"
KYC_SERVER = "https://anchorusd.com/kyc"
`;
    const parsed = parseTomlLocal(toml);
    expect(parsed.ORG_NAME).toBe('AnchorUSD');
    expect(parsed.ACCOUNTS).toContain('GCKF');
    expect(parsed.TRANSFER_SERVER).toBe('https://anchorusd.com/sep6');
    expect(parsed.KYC_SERVER).toBe('https://anchorusd.com/kyc');
  });
});

describe('SEP detection', () => {
  function detectSupportedSeps(toml: Record<string, unknown>): string[] {
    const seps: string[] = ['SEP-1'];
    if (toml.TRANSFER_SERVER || toml.TRANSFER_SERVER_SEP0024) seps.push('SEP-6');
    if (toml.TRANSFER_SERVER_SEP0024) seps.push('SEP-24');
    if (toml.DIRECT_PAYMENT_SERVER) seps.push('SEP-31');
    if (toml.PRICE_SERVER) seps.push('SEP-38');
    return seps;
  }

  it('detects SEP-6 and SEP-24 support', () => {
    const seps = detectSupportedSeps({
      TRANSFER_SERVER: 'https://example.com/sep6',
      TRANSFER_SERVER_SEP0024: 'https://example.com/sep24',
    });
    expect(seps).toContain('SEP-1');
    expect(seps).toContain('SEP-6');
    expect(seps).toContain('SEP-24');
  });

  it('detects SEP-31 and SEP-38', () => {
    const seps = detectSupportedSeps({
      DIRECT_PAYMENT_SERVER: 'https://example.com/sep31',
      PRICE_SERVER: 'https://example.com/sep38',
    });
    expect(seps).toContain('SEP-31');
    expect(seps).toContain('SEP-38');
  });
});
