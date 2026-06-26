import { Router, Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import { prismaWrite as prisma } from '../db';
import { requireAuth } from '../auth/middleware';
import { cacheGet, cacheSet } from '../cache';
import { issueTokens, generateSessionId, REFRESH_TOKEN_TTL } from '../auth/tokens';

export const authMultisigRouter = Router();

interface SignerStatus { address: string; weight: number; signed: boolean; signature?: string }
interface MultiSigFlow {
  flowId: string;
  multisigAddress: string;
  challenge: string;
  signers: SignerStatus[];
  threshold: number;
  expiresAt: string;
  completed: boolean;
  appId: string;
}

const FLOW_TTL = 600; // 10 minutes
const FLOW_PREFIX = 'auth:multisig:flow:';

authMultisigRouter.post('/initiate', async (req: Request, res: Response) => {
  const { multisigAddress, signers, threshold, appId = 'explorer-web' } = req.body ?? {};
  if (!multisigAddress || !signers || !threshold) {
    return res.status(400).json({ error: 'multisigAddress, signers, threshold required' });
  }

  const nonce = randomBytes(16).toString('hex');
  const flowId = `flow_${randomBytes(12).toString('hex')}`;
  const challenge = `Authenticate multi-sig wallet ${multisigAddress} [nonce: ${nonce}] [flow: ${flowId}]`;

  const flow: MultiSigFlow = {
    flowId,
    multisigAddress,
    challenge,
    signers: (signers as Array<{ address: string; weight: number }>).map((s) => ({
      address: s.address,
      weight: s.weight,
      signed: false,
    })),
    threshold,
    expiresAt: new Date(Date.now() + FLOW_TTL * 1000).toISOString(),
    completed: false,
    appId,
  };

  await cacheSet(`${FLOW_PREFIX}${flowId}`, flow, FLOW_TTL);
  return res.json({ authFlowId: flowId, challenge, expiresAt: flow.expiresAt, signers: flow.signers });
});

authMultisigRouter.post('/contribute', async (req: Request, res: Response) => {
  const { authFlowId, signerAddress, signature } = req.body ?? {};
  if (!authFlowId || !signerAddress || !signature) {
    return res.status(400).json({ error: 'authFlowId, signerAddress, signature required' });
  }

  const flow = await cacheGet<MultiSigFlow>(`${FLOW_PREFIX}${authFlowId}`);
  if (!flow) return res.status(404).json({ error: 'Auth flow not found or expired' });
  if (flow.completed) return res.status(400).json({ error: 'Flow already completed' });

  const signer = flow.signers.find((s) => s.address === signerAddress);
  if (!signer) return res.status(400).json({ error: 'Signer not in flow' });
  if (signer.signed) return res.status(400).json({ error: 'Signer already contributed' });

  try {
    const kp = Keypair.fromPublicKey(signerAddress);
    const valid = kp.verify(Buffer.from(flow.challenge), Buffer.from(signature, 'base64'));
    if (!valid) return res.status(401).json({ error: 'Invalid signature' });
  } catch {
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  signer.signed = true;
  signer.signature = signature;
  await cacheSet(`${FLOW_PREFIX}${authFlowId}`, flow, FLOW_TTL);

  const signedWeight = flow.signers.filter((s) => s.signed).reduce((sum, s) => sum + s.weight, 0);
  return res.json({ contributed: true, signedWeight, threshold: flow.threshold, ready: signedWeight >= flow.threshold });
});

authMultisigRouter.post('/complete', async (req: Request, res: Response) => {
  const { authFlowId } = req.body ?? {};
  if (!authFlowId) return res.status(400).json({ error: 'authFlowId required' });

  const flow = await cacheGet<MultiSigFlow>(`${FLOW_PREFIX}${authFlowId}`);
  if (!flow) return res.status(404).json({ error: 'Auth flow not found or expired' });
  if (flow.completed) return res.status(400).json({ error: 'Already completed' });

  const signedWeight = flow.signers.filter((s) => s.signed).reduce((sum, s) => sum + s.weight, 0);
  if (signedWeight < flow.threshold) {
    return res.status(400).json({ error: 'Threshold not met', signedWeight, required: flow.threshold });
  }

  flow.completed = true;
  await cacheSet(`${FLOW_PREFIX}${authFlowId}`, flow, 60);

  let user = await prisma.walletUser.findUnique({ where: { address: flow.multisigAddress } });
  if (!user) {
    user = await prisma.walletUser.create({
      data: { address: flow.multisigAddress, role: 'user', tier: 'developer', isMultiSig: true },
    });
  }

  const sessionId = generateSessionId();
  const tokens = await issueTokens({
    sub: flow.multisigAddress,
    userId: user.id,
    role: user.role,
    tier: user.tier,
    sessionId,
    appId: flow.appId,
  });

  await prisma.authSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: tokens.tokenHash,
      refreshTokenHash: tokens.refreshTokenHash,
      deviceInfo: { multisig: true, flow: authFlowId },
      appId: flow.appId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
    },
  });

  return res.json({ token: tokens.token, refreshToken: tokens.refreshToken, sessionId, expiresAt: tokens.expiresAt });
});

authMultisigRouter.get('/flows/:flowId', async (req: Request, res: Response) => {
  const flow = await cacheGet<MultiSigFlow>(`${FLOW_PREFIX}${req.params.flowId}`);
  if (!flow) return res.status(404).json({ error: 'Flow not found or expired' });
  const signedWeight = flow.signers.filter((s) => s.signed).reduce((sum, s) => sum + s.weight, 0);
  res.json({ ...flow, signers: flow.signers.map(({ signature: _s, ...s }) => s), signedWeight });
});

authMultisigRouter.get('/wallets', requireAuth, async (req: Request, res: Response) => {
  const wallets = await prisma.multiSigWallet.findMany({
    where: { walletAddress: req.user!.address },
  });
  res.json({ wallets });
});

authMultisigRouter.post('/wallets', requireAuth, async (req: Request, res: Response) => {
  const { walletAddress, signers, threshold, description } = req.body ?? {};
  if (!walletAddress || !signers || !threshold) {
    return res.status(400).json({ error: 'walletAddress, signers, threshold required' });
  }
  const wallet = await prisma.multiSigWallet.upsert({
    where: { walletAddress },
    create: { walletAddress, signers, threshold, description },
    update: { signers, threshold, description },
  });
  res.status(201).json(wallet);
});
