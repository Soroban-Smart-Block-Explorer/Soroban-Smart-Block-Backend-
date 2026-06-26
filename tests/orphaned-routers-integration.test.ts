/**
 * Integration tests for all 18+ newly mounted API routers (Issue #240)
 *
 * Tests that every previously-orphaned endpoint is reachable (returns
 * non-404 HTTP status) and validates basic response structure.
 *
 * Run: npm run test:routes
 */

import { describe, it, expect } from 'vitest';

// Base URL for the running API server
const BASE_URL = process.env.TEST_API_URL ?? 'http://localhost:3000';
const API_BASE = `${BASE_URL}/api/v1`;

/** Simple HTTP GET helper */
async function get(path: string): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    return { status: res.status, body };
  } catch (err: any) {
    throw new Error(`GET ${API_BASE}${path} failed: ${err.message}`);
  }
}

/** Simple HTTP POST helper */
async function post(path: string, data: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    return { status: res.status, body };
  } catch (err: any) {
    throw new Error(`POST ${API_BASE}${path} failed: ${err.message}`);
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────────

function assertNotFound(status: number, path: string): void {
  if (status === 404) {
    throw new Error(`Route ${path} returned 404 — it is not mounted!`);
  }
}

const integrationTest = process.env.TEST_API_URL ? describe : describe.skip;

integrationTest('orphaned routers (requires TEST_API_URL)', () => {
  // ═══════════════════════════════════════════════════════════════════════════════
  // 1. i18n (previously imported but not mounted)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('i18n Router (previously unmounted)', () => {
    it('GET /i18n/languages returns 200', async () => {
      const { status, body } = await get('/i18n/languages');
      assertNotFound(status, '/i18n/languages');
      expect(status).toBe(200);
      expect(body).toHaveProperty('supported');
    });

    it('GET /i18n/keys returns 200', async () => {
      const { status } = await get('/i18n/keys');
      assertNotFound(status, '/i18n/keys');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 2. Checked Arithmetic
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Checked Arithmetic Router', () => {
    it('GET /checked-arithmetic returns 200', async () => {
      const { status, body } = await get('/checked-arithmetic');
      assertNotFound(status, '/checked-arithmetic');
      expect(status).toBe(200);
      expect(body).toHaveProperty('service', 'Checked Arithmetic API');
    });

    it('GET /checked-arithmetic/limits returns 200', async () => {
      const { status, body } = await get('/checked-arithmetic/limits');
      assertNotFound(status, '/checked-arithmetic/limits');
      expect(status).toBe(200);
      expect(body).toHaveProperty('limits');
    });

    it('POST /checked-arithmetic/compute returns 200 for valid input', async () => {
      const { status, body } = await post('/checked-arithmetic/compute', {
        a: 100,
        b: 200,
        operation: 'add',
        bitWidth: 64,
      });
      assertNotFound(status, '/checked-arithmetic/compute');
      expect(status).toBe(200);
      expect(body).toHaveProperty('result', 300);
      expect(body).toHaveProperty('overflow', false);
    });

    it('POST /checked-arithmetic/compute returns 400 for invalid operation', async () => {
      const { status } = await post('/checked-arithmetic/compute', {
        a: 5,
        b: 3,
        operation: 'invalid_op',
      });
      expect(status).toBe(400);
    });

    it('POST /checked-arithmetic/compute/batch returns 200', async () => {
      const { status, body } = await post('/checked-arithmetic/compute/batch', {
        operations: [
          { a: 10, b: 5, operation: 'add', bitWidth: 64 },
          { a: 100, b: 0, operation: 'div', bitWidth: 64 },
        ],
      });
      assertNotFound(status, '/checked-arithmetic/compute/batch');
      expect(status).toBe(200);
      expect(body).toHaveProperty('total', 2);
      expect(body).toHaveProperty('results');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 3. Protocol 26
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Protocol 26 Router', () => {
    it('GET /protocol26 returns 200', async () => {
      const { status, body } = await get('/protocol26');
      assertNotFound(status, '/protocol26');
      expect(status).toBe(200);
      expect(body).toHaveProperty('protocol', 26);
    });

    it('GET /protocol26/archive/stats returns 200', async () => {
      const { status } = await get('/protocol26/archive/stats');
      assertNotFound(status, '/protocol26/archive/stats');
      expect(status).toBe(200);
    });

    it('GET /protocol26/expiring returns 200', async () => {
      const { status } = await get('/protocol26/expiring');
      assertNotFound(status, '/protocol26/expiring');
      expect(status).toBe(200);
    });

    it('GET /protocol26/contracts/:contractId/ttl returns 200', async () => {
      const { status } = await get('/protocol26/contracts/CTEST123/ttl');
      assertNotFound(status, '/protocol26/contracts/CTEST123/ttl');
      expect(status).toBe(200);
    });

    it('POST /protocol26/footprint/optimize returns 200', async () => {
      const { status } = await post('/protocol26/footprint/optimize', {
        contractId: 'CTEST123',
        readOnly: ['key1', 'key2'],
        readWrite: ['key2', 'key3'],
      });
      assertNotFound(status, '/protocol26/footprint/optimize');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 4. Advanced Events
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Advanced Events Router', () => {
    it('GET /advanced-events returns 200', async () => {
      const { status } = await get('/advanced-events');
      assertNotFound(status, '/advanced-events');
      expect(status).toBe(200);
    });

    it('POST /advanced-events/query returns 200', async () => {
      const { status } = await post('/advanced-events/query', { limit: 10 });
      assertNotFound(status, '/advanced-events/query');
      expect(status).toBe(200);
    });

    it('GET /advanced-events/aggregations returns 200', async () => {
      const { status } = await get('/advanced-events/aggregations?period=24h');
      assertNotFound(status, '/advanced-events/aggregations');
      expect(status).toBe(200);
    });

    it('GET /advanced-events/subscriptions returns 200', async () => {
      const { status } = await get('/advanced-events/subscriptions');
      assertNotFound(status, '/advanced-events/subscriptions');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 5. Resource Audit
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Resource Audit Router', () => {
    it('GET /resource-audit returns 200', async () => {
      const { status } = await get('/resource-audit');
      assertNotFound(status, '/resource-audit');
      expect(status).toBe(200);
    });

    it('GET /resource-audit/network/summary returns 200', async () => {
      const { status } = await get('/resource-audit/network/summary');
      assertNotFound(status, '/resource-audit/network/summary');
      expect(status).toBe(200);
    });

    it('GET /resource-audit/top-consumers returns 200', async () => {
      const { status } = await get('/resource-audit/top-consumers');
      assertNotFound(status, '/resource-audit/top-consumers');
      expect(status).toBe(200);
    });

    it('POST /resource-audit/simulate returns 200', async () => {
      const { status } = await post('/resource-audit/simulate', {
        contractId: 'CTEST123',
        functionName: 'transfer',
      });
      assertNotFound(status, '/resource-audit/simulate');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 6. Factory Tracker
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Factory Tracker Router', () => {
    it('GET /factory-tracker returns 200', async () => {
      const { status } = await get('/factory-tracker');
      assertNotFound(status, '/factory-tracker');
      expect(status).toBe(200);
    });

    it('GET /factory-tracker/factories returns 200', async () => {
      const { status } = await get('/factory-tracker/factories');
      assertNotFound(status, '/factory-tracker/factories');
      expect(status).toBe(200);
    });

    it('GET /factory-tracker/stats returns 200', async () => {
      const { status } = await get('/factory-tracker/stats');
      assertNotFound(status, '/factory-tracker/stats');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 7. Upgrade Trace
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Upgrade Trace Router', () => {
    it('GET /upgrade-trace returns 200', async () => {
      const { status } = await get('/upgrade-trace');
      assertNotFound(status, '/upgrade-trace');
      expect(status).toBe(200);
    });

    it('GET /upgrade-trace/recent returns 200', async () => {
      const { status } = await get('/upgrade-trace/recent');
      assertNotFound(status, '/upgrade-trace/recent');
      expect(status).toBe(200);
    });

    it('GET /upgrade-trace/stats returns 200', async () => {
      const { status } = await get('/upgrade-trace/stats');
      assertNotFound(status, '/upgrade-trace/stats');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 8. Oracle Audit — mounted at /oracles/audit (conflict-safe prefix)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Oracle Audit Router', () => {
    it('GET /oracles/audit returns 200', async () => {
      const { status } = await get('/oracles/audit');
      assertNotFound(status, '/oracles/audit');
      expect(status).toBe(200);
    });

    it('GET /oracles/audit/requests returns 200', async () => {
      const { status } = await get('/oracles/audit/requests');
      assertNotFound(status, '/oracles/audit/requests');
      expect(status).toBe(200);
    });

    it('GET /oracles/audit/stats returns 200', async () => {
      const { status } = await get('/oracles/audit/stats');
      assertNotFound(status, '/oracles/audit/stats');
      expect(status).toBe(200);
    });

    it('GET /oracles/audit/requests/:hash returns 200 (not 404)', async () => {
      const { status } = await get('/oracles/audit/requests/abc123txhash');
      assertNotFound(status, '/oracles/audit/requests/abc123txhash');
      // Returns 200 with "not_found" status in body (route IS mounted and handled)
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 9. Oracle Feeds
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Oracle Feeds Router', () => {
    it('GET /oracle-feeds returns 200', async () => {
      const { status } = await get('/oracle-feeds');
      assertNotFound(status, '/oracle-feeds');
      expect(status).toBe(200);
    });

    it('GET /oracle-feeds/assets returns 200', async () => {
      const { status, body } = await get('/oracle-feeds/assets');
      assertNotFound(status, '/oracle-feeds/assets');
      expect(status).toBe(200);
      expect(body).toHaveProperty('assets');
    });

    it('GET /oracle-feeds/assets/XLM-USD/price returns 200', async () => {
      const { status, body } = await get('/oracle-feeds/assets/XLM-USD/price');
      assertNotFound(status, '/oracle-feeds/assets/XLM-USD/price');
      expect(status).toBe(200);
      expect(body).toHaveProperty('price');
    });

    it('GET /oracle-feeds/providers returns 200', async () => {
      const { status } = await get('/oracle-feeds/providers');
      assertNotFound(status, '/oracle-feeds/providers');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 10. RWA Compliance
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('RWA Compliance Router', () => {
    it('GET /rwa-compliance returns 200', async () => {
      const { status } = await get('/rwa-compliance');
      assertNotFound(status, '/rwa-compliance');
      expect(status).toBe(200);
    });

    it('GET /rwa-compliance/jurisdictions returns 200', async () => {
      const { status, body } = await get('/rwa-compliance/jurisdictions');
      assertNotFound(status, '/rwa-compliance/jurisdictions');
      expect(status).toBe(200);
      expect(body).toHaveProperty('jurisdictions');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 11. Treasury
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Treasury Router', () => {
    it('GET /treasury returns 200', async () => {
      const { status } = await get('/treasury');
      assertNotFound(status, '/treasury');
      expect(status).toBe(200);
    });

    it('GET /treasury/balances returns 200', async () => {
      const { status } = await get('/treasury/balances');
      assertNotFound(status, '/treasury/balances');
      expect(status).toBe(200);
    });

    it('GET /treasury/proposals returns 200', async () => {
      const { status } = await get('/treasury/proposals');
      assertNotFound(status, '/treasury/proposals');
      expect(status).toBe(200);
    });

    it('GET /treasury/stats returns 200', async () => {
      const { status } = await get('/treasury/stats');
      assertNotFound(status, '/treasury/stats');
      expect(status).toBe(200);
    });

    it('POST /treasury/proposals returns 201 for valid input', async () => {
      const { status } = await post('/treasury/proposals', {
        title: 'Fund Developer Grants',
        description: 'Allocate 10000 XLM for developer grants in Q3 2024',
        amount: 10000,
        assetCode: 'XLM',
        recipient: 'GTEST123',
        category: 'grants',
      });
      assertNotFound(status, '/treasury/proposals');
      expect(status).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 12. Signers
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Signers Router', () => {
    it('GET /signers returns 200', async () => {
      const { status } = await get('/signers');
      assertNotFound(status, '/signers');
      expect(status).toBe(200);
    });

    it('GET /signers/accounts/:address returns 200', async () => {
      const { status } = await get('/signers/accounts/GTEST123');
      assertNotFound(status, '/signers/accounts/GTEST123');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 13. Tax
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Tax Router', () => {
    it('GET /tax returns 200', async () => {
      const { status } = await get('/tax');
      assertNotFound(status, '/tax');
      expect(status).toBe(200);
    });

    it('GET /tax/rates returns 200', async () => {
      const { status } = await get('/tax/rates');
      assertNotFound(status, '/tax/rates');
      expect(status).toBe(200);
    });

    it('GET /tax/accounts/:address/summary returns 200', async () => {
      const { status } = await get('/tax/accounts/GTEST123/summary');
      assertNotFound(status, '/tax/accounts/GTEST123/summary');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 14. Compliance
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Compliance Router', () => {
    it('GET /compliance returns 200', async () => {
      const { status } = await get('/compliance');
      assertNotFound(status, '/compliance');
      expect(status).toBe(200);
    });

    it('POST /compliance/screen returns 200', async () => {
      const { status, body } = await post('/compliance/screen', {
        address: 'GTEST123',
        context: 'test-screening',
      });
      assertNotFound(status, '/compliance/screen');
      expect(status).toBe(200);
      expect(body).toHaveProperty('screened', true);
      expect(body).toHaveProperty('sanctioned', false);
    });

    it('GET /compliance/watchlist returns 200', async () => {
      const { status } = await get('/compliance/watchlist');
      assertNotFound(status, '/compliance/watchlist');
      expect(status).toBe(200);
    });

    it('GET /compliance/stats returns 200', async () => {
      const { status } = await get('/compliance/stats');
      assertNotFound(status, '/compliance/stats');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 15. Freeze
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Freeze Router', () => {
    it('GET /freeze returns 200', async () => {
      const { status } = await get('/freeze');
      assertNotFound(status, '/freeze');
      expect(status).toBe(200);
    });

    it('GET /freeze/keys returns 200 (acceptance criterion)', async () => {
      const { status, body } = await get('/freeze/keys');
      assertNotFound(status, '/freeze/keys');
      expect(status).toBe(200);
      expect(body).toHaveProperty('freezeOrders');
    });

    it('GET /freeze/accounts/:address returns 200', async () => {
      const { status } = await get('/freeze/accounts/GTEST123');
      assertNotFound(status, '/freeze/accounts/GTEST123');
      expect(status).toBe(200);
    });

    it('GET /freeze/stats returns 200', async () => {
      const { status } = await get('/freeze/stats');
      assertNotFound(status, '/freeze/stats');
      expect(status).toBe(200);
    });

    it('GET /freeze/history returns 200', async () => {
      const { status } = await get('/freeze/history');
      assertNotFound(status, '/freeze/history');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 16. SAC Trustlines
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('SAC Trustlines Router', () => {
    it('GET /sac-trustlines returns 200', async () => {
      const { status } = await get('/sac-trustlines');
      assertNotFound(status, '/sac-trustlines');
      expect(status).toBe(200);
    });

    it('GET /sac-trustlines/stats returns 200', async () => {
      const { status } = await get('/sac-trustlines/stats');
      assertNotFound(status, '/sac-trustlines/stats');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 17. Storage
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Storage Router', () => {
    it('GET /storage returns 200', async () => {
      const { status } = await get('/storage');
      assertNotFound(status, '/storage');
      expect(status).toBe(200);
    });

    it('GET /storage/network/stats returns 200', async () => {
      const { status } = await get('/storage/network/stats');
      assertNotFound(status, '/storage/network/stats');
      expect(status).toBe(200);
    });

    it('GET /storage/network/top-users returns 200', async () => {
      const { status } = await get('/storage/network/top-users');
      assertNotFound(status, '/storage/network/top-users');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 18. Storage Trap
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Storage Trap Router', () => {
    it('GET /storage-trap returns 200', async () => {
      const { status } = await get('/storage-trap');
      assertNotFound(status, '/storage-trap');
      expect(status).toBe(200);
    });

    it('GET /storage-trap/detected returns 200', async () => {
      const { status } = await get('/storage-trap/detected');
      assertNotFound(status, '/storage-trap/detected');
      expect(status).toBe(200);
    });

    it('POST /storage-trap/analyze returns 200', async () => {
      const { status } = await post('/storage-trap/analyze', {
        contractId: 'CTEST123',
      });
      assertNotFound(status, '/storage-trap/analyze');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 19. BN254
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('BN254 Router', () => {
    it('GET /bn254 returns 200', async () => {
      const { status } = await get('/bn254');
      assertNotFound(status, '/bn254');
      expect(status).toBe(200);
    });

    it('GET /bn254/params returns 200', async () => {
      const { status, body } = await get('/bn254/params');
      assertNotFound(status, '/bn254/params');
      expect(status).toBe(200);
      expect(body).toHaveProperty('curve', 'BN254');
    });

    it('POST /bn254/point-add returns 200', async () => {
      const { status } = await post('/bn254/point-add', {
        p1: { x: '1', y: '2' },
        p2: { x: '1', y: '2' },
      });
      assertNotFound(status, '/bn254/point-add');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 20. Compiler
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Compiler Router', () => {
    it('GET /compiler returns 200', async () => {
      const { status } = await get('/compiler');
      assertNotFound(status, '/compiler');
      expect(status).toBe(200);
    });

    it('GET /compiler/toolchains returns 200', async () => {
      const { status, body } = await get('/compiler/toolchains');
      assertNotFound(status, '/compiler/toolchains');
      expect(status).toBe(200);
      expect(body).toHaveProperty('toolchains');
    });

    it('POST /compiler/compile returns 400 without file (not 404)', async () => {
      const { status } = await post('/compiler/compile', {});
      // Should return 400 (missing file) or 415 (wrong content type), not 404
      assertNotFound(status, '/compiler/compile');
      expect(status).not.toBe(404);
      expect(status).not.toBe(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 21. Composability (previously defined but unmounted)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Composability Router (previously unmounted)', () => {
    it('GET /composability/patterns returns 200', async () => {
      const { status } = await get('/composability/patterns');
      assertNotFound(status, '/composability/patterns');
      expect(status).toBe(200);
    });

    it('GET /composability/circular-dependencies returns 200', async () => {
      const { status } = await get('/composability/circular-dependencies');
      assertNotFound(status, '/composability/circular-dependencies');
      expect(status).toBe(200);
    });

    it('GET /composability/leaderboard returns 200', async () => {
      const { status } = await get('/composability/leaderboard');
      assertNotFound(status, '/composability/leaderboard');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 22. Reputation (previously defined but unmounted)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Reputation Router (previously unmounted)', () => {
    it('GET /reputation/leaderboard returns 200', async () => {
      const { status } = await get('/reputation/leaderboard');
      assertNotFound(status, '/reputation/leaderboard');
      expect(status).toBe(200);
    });

    it('GET /reputation/search returns 400 without query (not 404)', async () => {
      const { status } = await get('/reputation/search');
      assertNotFound(status, '/reputation/search');
      expect(status).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 23. TIP — Threat Intelligence Platform (previously unmounted)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('TIP Router (previously unmounted)', () => {
    it('GET /tip/advisories returns 200', async () => {
      const { status } = await get('/tip/advisories');
      assertNotFound(status, '/tip/advisories');
      expect(status).toBe(200);
    });

    it('GET /tip/sources returns 200', async () => {
      const { status } = await get('/tip/sources');
      assertNotFound(status, '/tip/sources');
      expect(status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Negative tests — invalid params / unauthorized
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('Negative tests — invalid inputs', () => {
    it('POST /checked-arithmetic/compute with division by zero returns error field', async () => {
      const { status, body } = await post('/checked-arithmetic/compute', {
        a: 10,
        b: 0,
        operation: 'div',
        bitWidth: 64,
      });
      expect(status).toBe(200);
      expect(body).toHaveProperty('error', 'Division by zero');
    });

    it('POST /compliance/screen with missing address returns 400', async () => {
      const { status } = await post('/compliance/screen', {});
      expect(status).toBe(400);
    });

    it('POST /treasury/proposals with missing fields returns 400', async () => {
      const { status } = await post('/treasury/proposals', { title: 'short' });
      expect(status).toBe(400);
    });

    it('GET /oracle-feeds/assets/INVALID-PAIR/price returns 404', async () => {
      const { status } = await get('/oracle-feeds/assets/INVALID-PAIR/price');
      expect(status).toBe(404);
    });

    it('POST /advanced-events/subscriptions with invalid URL returns 400', async () => {
      const { status } = await post('/advanced-events/subscriptions', {
        webhookUrl: 'not-a-url',
      });
      expect(status).toBe(400);
    });
  });
});
