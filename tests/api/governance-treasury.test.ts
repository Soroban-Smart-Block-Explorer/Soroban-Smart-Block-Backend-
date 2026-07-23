/**
 * Governance treasury API tests (issue #567, Phase 4).
 * Covers /api/v1/governance/treasury: registration, streams, analytics,
 * reputation-weighted voting power. Prisma mocked, signatures real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

vi.mock('../../src/db', () => {
  const model = () => ({
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  });
  const client = () => ({
    governanceContract: model(),
    governanceProposal: model(),
    governanceVote: model(),
    treasuryAccount: model(),
    treasuryAsset: model(),
    treasuryPayoutStream: model(),
    treasuryTransaction: model(),
    reputationProfile: model(),
  });
  return { prismaRead: client(), prismaWrite: client() };
});

import { prismaRead, prismaWrite } from '../../src/db';
import { governanceTreasuryRouter } from '../../src/api/governance-treasury';

const app = express();
app.use(express.json());
app.use('/api/v1/governance/treasury', governanceTreasuryRouter);
app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  res.status(err.name === 'ZodError' ? 400 : 500).json({ error: err.message });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const r = prismaRead as any;
const w = prismaWrite as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const guardian = Keypair.random();
const stranger = Keypair.random();
const recipient = Keypair.random();

function signedAuthFor(kp: Keypair, template: (signedAt: number) => string) {
  const signedAt = Math.floor(Date.now() / 1000);
  const message = template(signedAt);
  return {
    address: kp.publicKey(),
    signature: kp.sign(Buffer.from(message)).toString('base64'),
    signedAt,
  };
}

const CONTRACT = 'CGOVCONTRACT1';
const TREASURY = 'CTREASURYACC1';
const DAY = 24 * 3600 * 1000;

function treasuryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    contractAddress: CONTRACT,
    accountAddress: TREASURY,
    name: 'Main treasury',
    reputationWeight: 0.5,
    assets: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  r.treasuryPayoutStream.findMany.mockResolvedValue([]);
  r.treasuryTransaction.findMany.mockResolvedValue([]);
});

// ── Registration ──────────────────────────────────────────────────────────────

describe('POST /governance/treasury', () => {
  it('lets the guardian register a treasury', async () => {
    r.governanceContract.findUnique.mockResolvedValue({ guardian: guardian.publicKey() });
    w.treasuryAccount.upsert.mockImplementation(async ({ create }: { create: unknown }) => create);

    const auth = signedAuthFor(
      guardian,
      (t) => `governance:treasury-register:${CONTRACT}:${TREASURY}:${t}`,
    );
    const res = await request(app)
      .post('/api/v1/governance/treasury')
      .send({ contract: CONTRACT, accountAddress: TREASURY, reputationWeight: 0.25, auth });

    expect(res.status).toBe(201);
    expect(res.body.treasury.accountAddress).toBe(TREASURY);
    expect(res.body.treasury.reputationWeight).toBe(0.25);
  });

  it('rejects non-guardian registration when a guardian is configured', async () => {
    r.governanceContract.findUnique.mockResolvedValue({ guardian: guardian.publicKey() });
    const auth = signedAuthFor(
      stranger,
      (t) => `governance:treasury-register:${CONTRACT}:${TREASURY}:${t}`,
    );
    const res = await request(app)
      .post('/api/v1/governance/treasury')
      .send({ contract: CONTRACT, accountAddress: TREASURY, auth });
    expect(res.status).toBe(403);
    expect(w.treasuryAccount.upsert).not.toHaveBeenCalled();
  });

  it('404s for unknown governance contracts', async () => {
    r.governanceContract.findUnique.mockResolvedValue(null);
    const auth = signedAuthFor(
      guardian,
      (t) => `governance:treasury-register:${CONTRACT}:${TREASURY}:${t}`,
    );
    const res = await request(app)
      .post('/api/v1/governance/treasury')
      .send({ contract: CONTRACT, accountAddress: TREASURY, auth });
    expect(res.status).toBe(404);
  });
});

// ── Listing & detail ──────────────────────────────────────────────────────────

describe('GET /governance/treasury', () => {
  it('lists treasuries with USD totals and supported asset types', async () => {
    r.treasuryAccount.findMany.mockResolvedValue([
      treasuryRow({
        assets: [
          { assetCode: 'XLM', assetType: 'native', balance: '1000', valueUsd: 120.5 },
          { assetCode: 'USDC', assetType: 'sep41', balance: '500', valueUsd: 500 },
        ],
      }),
    ]);
    const res = await request(app).get('/api/v1/governance/treasury');
    expect(res.status).toBe(200);
    expect(res.body.treasuries[0].totalValueUsd).toBeCloseTo(620.5);
    expect(res.body.supportedAssetTypes).toEqual([
      'native',
      'sep41',
      'governance',
      'lp',
      'wrapped',
    ]);
  });
});

describe('GET /governance/treasury/:accountAddress', () => {
  it('returns detail with outstanding stream commitments', async () => {
    r.treasuryAccount.findUnique.mockResolvedValue(treasuryRow());
    r.treasuryPayoutStream.findMany.mockResolvedValue([
      {
        amountPerPeriod: '1000',
        periodSeconds: 7 * 24 * 3600,
        startAt: new Date(Date.now() - 21 * DAY),
        endAt: new Date(Date.now() + 49 * DAY), // 10 weeks total, 3 elapsed
        claimed: '0',
        status: 'active',
      },
    ]);
    const res = await request(app).get(`/api/v1/governance/treasury/${TREASURY}`);
    expect(res.status).toBe(200);
    expect(res.body.activeStreams).toBe(1);
    expect(res.body.outstandingStreamCommitments).toBe('7000');
  });

  it('404s for unknown treasuries', async () => {
    r.treasuryAccount.findUnique.mockResolvedValue(null);
    const res = await request(app).get(`/api/v1/governance/treasury/${TREASURY}`);
    expect(res.status).toBe(404);
  });
});

// ── Streams ───────────────────────────────────────────────────────────────────

describe('POST /governance/treasury/:accountAddress/streams', () => {
  const streamBody = {
    recipient: recipient.publicKey(),
    assetCode: 'usdc',
    assetType: 'sep41',
    amountPerPeriod: '1000',
    periodSeconds: 7 * 24 * 3600,
    startAt: new Date().toISOString(),
  };

  function mockTreasury() {
    r.treasuryAccount.findUnique.mockResolvedValue({ id: 't1', contractAddress: CONTRACT });
    r.governanceContract.findUnique.mockResolvedValue({ guardian: guardian.publicKey() });
    w.treasuryPayoutStream.create.mockImplementation(async ({ data }: { data: unknown }) => data);
  }

  it('creates a stream (asset code uppercased) with guardian auth', async () => {
    mockTreasury();
    const auth = signedAuthFor(
      guardian,
      (t) => `governance:stream-create:${TREASURY}:${recipient.publicKey()}:1000:${t}`,
    );
    const res = await request(app)
      .post(`/api/v1/governance/treasury/${TREASURY}/streams`)
      .send({ ...streamBody, auth });
    expect(res.status).toBe(201);
    expect(res.body.stream.assetCode).toBe('USDC');
  });

  it('requires the originating proposal to be executed', async () => {
    mockTreasury();
    r.governanceProposal.findUnique.mockResolvedValue({
      status: 'active',
      template: 'fund_transfer',
    });
    const auth = signedAuthFor(
      guardian,
      (t) => `governance:stream-create:${TREASURY}:${recipient.publicKey()}:1000:${t}`,
    );
    const res = await request(app)
      .post(`/api/v1/governance/treasury/${TREASURY}/streams`)
      .send({ ...streamBody, proposalId: '42', auth });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/must be executed/);
  });

  it('rejects unknown asset types and inverted date ranges', async () => {
    mockTreasury();
    const auth1 = signedAuthFor(
      guardian,
      (t) => `governance:stream-create:${TREASURY}:${recipient.publicKey()}:1000:${t}`,
    );
    const badType = await request(app)
      .post(`/api/v1/governance/treasury/${TREASURY}/streams`)
      .send({ ...streamBody, assetType: 'nft', auth: auth1 });
    expect(badType.status).toBe(400);

    const auth2 = signedAuthFor(
      guardian,
      (t) => `governance:stream-create:${TREASURY}:${recipient.publicKey()}:1000:${t}`,
    );
    const badDates = await request(app)
      .post(`/api/v1/governance/treasury/${TREASURY}/streams`)
      .send({
        ...streamBody,
        endAt: new Date(Date.now() - DAY).toISOString(),
        auth: auth2,
      });
    expect(badDates.status).toBe(400);
    expect(badDates.body.error).toMatch(/endAt/);
  });
});

describe('GET /governance/treasury/:accountAddress/streams', () => {
  it('annotates streams with claimable and outstanding amounts', async () => {
    r.treasuryAccount.findUnique.mockResolvedValue({ id: 't1' });
    r.treasuryPayoutStream.findMany.mockResolvedValue([
      {
        amountPerPeriod: '1000',
        periodSeconds: 7 * 24 * 3600,
        startAt: new Date(Date.now() - 21 * DAY),
        endAt: null,
        claimed: '1000',
        status: 'active',
      },
    ]);
    const res = await request(app).get(`/api/v1/governance/treasury/${TREASURY}/streams`);
    expect(res.status).toBe(200);
    expect(res.body.streams[0].claimable).toBe('2000'); // 3 weeks vested − 1000 claimed
    expect(res.body.streams[0].outstanding).toBe('52000'); // open-ended: 1y forward
  });
});

// ── Analytics ────────────────────────────────────────────────────────────────

describe('GET /governance/treasury/:accountAddress/analytics', () => {
  it('returns flows, allocation, liquid balance and runway', async () => {
    r.treasuryAccount.findUnique.mockResolvedValue(
      treasuryRow({
        assets: [
          { assetCode: 'XLM', assetType: 'native', balance: '10000', valueUsd: 1200 },
          { assetCode: 'POOL', assetType: 'lp', balance: '999999', valueUsd: 50 }, // not liquid
        ],
      }),
    );
    r.treasuryTransaction.findMany.mockResolvedValue([
      {
        direction: 'outflow',
        assetCode: 'XLM',
        amount: '9000',
        category: 'grants',
        timestamp: new Date(Date.now() - 10 * DAY),
      },
    ]);
    const res = await request(app)
      .get(`/api/v1/governance/treasury/${TREASURY}/analytics`)
      .query({ days: 90 });
    expect(res.status).toBe(200);
    expect(res.body.liquidBalance).toBe('10000'); // LP excluded
    expect(res.body.allocation).toEqual([{ category: 'grants', outflow: '9000' }]);
    expect(res.body.flows).toHaveLength(1);
    expect(res.body.runwayDays).toBeCloseTo(100, 1); // 10000 / (9000/90)
  });
});

// ── Reputation-weighted power ────────────────────────────────────────────────

describe('GET /governance/treasury/:accountAddress/voting-power/:address', () => {
  it('blends token power with the reputation score per treasury config', async () => {
    r.treasuryAccount.findUnique.mockResolvedValue({
      reputationWeight: 0.5,
      contractAddress: CONTRACT,
    });
    r.governanceVote.findFirst.mockResolvedValue({ weight: '500' });
    r.reputationProfile.findUnique.mockResolvedValue({ combinedScore: 80 });

    const res = await request(app).get(
      `/api/v1/governance/treasury/${TREASURY}/voting-power/${stranger.publicKey()}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.tokenPower).toBe('500');
    expect(res.body.reputationScore).toBe(80);
    // token part 250 + reputation part 500×0.8×0.5 = 200 → 450
    expect(res.body.blendedPower).toBe('450');
  });

  it('handles wallets with no votes and no profile', async () => {
    r.treasuryAccount.findUnique.mockResolvedValue({
      reputationWeight: 0.5,
      contractAddress: CONTRACT,
    });
    r.governanceVote.findFirst.mockResolvedValue(null);
    r.reputationProfile.findUnique.mockResolvedValue(null);
    const res = await request(app).get(
      `/api/v1/governance/treasury/${TREASURY}/voting-power/${stranger.publicKey()}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.blendedPower).toBe('0');
  });
});
