import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sandboxEngine } from '../sandbox/runtime';
import { asyncHandler } from '../middleware/asyncHandler';

export const sandboxRouter = Router();

const sessionCreateSchema = z.object({
  userId: z.string().optional().nullable(),
  ledgerSequence: z.number().int().positive().optional(),
  ledgerTimestamp: z.union([z.string(), z.date()]).optional(),
  networkPassphrase: z.string().optional(),
  maxContractSize: z.number().int().positive().optional(),
  maxCpuInsn: z.number().int().positive().optional(),
  maxMemBytes: z.number().int().positive().optional(),
  seed: z.string().optional(),
  ttlHours: z.number().int().positive().optional(),
  accountCount: z.number().int().positive().optional(),
  preFundedBalance: z.union([z.string(), z.number()]).optional(),
});

const sessionIdSchema = z.object({ sessionId: z.string().min(1) });
const snapshotSchema = z.object({ sessionId: z.string().min(1), name: z.string().min(1) });
const accountSchema = z.object({
  label: z.string().nullable().optional(),
  balance: z.union([z.string(), z.number()]).optional(),
  isPreFunded: z.boolean().optional(),
});
const fundSchema = z.object({
  publicKey: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
});
const deploySchema = z.object({
  sessionId: z.string().min(1),
  wasm: z.string().optional(),
  name: z.string().optional(),
  deployer: z.string().optional(),
  salt: z.string().optional(),
  initArgs: z.record(z.unknown()).optional(),
  templateId: z.string().optional(),
  sourceContract: z.string().optional(),
  abi: z.unknown().optional(),
});
const deployMainnetSchema = z.object({
  sessionId: z.string().min(1),
  contractAddress: z.string().min(1),
  name: z.string().optional(),
  deployer: z.string().optional(),
});
const callSchema = z.object({
  sessionId: z.string().min(1),
  contractId: z.string().min(1),
  functionName: z.string().min(1),
  args: z.unknown().optional(),
  sourceAccount: z.string().optional(),
  batchId: z.string().optional().nullable(),
});
const batchCallSchema = z.object({
  sessionId: z.string().min(1),
  calls: z.array(
    z.object({
      contractId: z.string().min(1),
      functionName: z.string().min(1),
      args: z.unknown().optional(),
      sourceAccount: z.string().optional(),
      batchId: z.string().optional().nullable(),
    }),
  ),
});
const debugSchema = z.object({
  sessionId: z.string().min(1),
  contract: z.string().min(1),
  function: z.string().min(1),
  args: z.unknown().optional(),
  source: z.string().optional(),
  traceOptions: z.record(z.unknown()).optional(),
});
const compareSchema = z.object({
  sessionId: z.string().optional(),
  left: z.string().min(1),
  right: z.string().min(1),
});
const fuzzStartSchema = z.object({
  sessionId: z.string().min(1),
  contract: z.string().min(1),
  strategies: z.array(
    z.object({
      type: z.string().min(1),
      iterations: z.number().int().positive().optional(),
      params: z.record(z.unknown()).optional(),
    }),
  ),
  timeoutSeconds: z.number().int().positive().optional(),
  stopOnFirst: z.string().optional(),
});
const ciSchema = z.object({
  sessionId: z.string().optional(),
  steps: z.array(
    z.union([
      z.object({
        action: z.literal('deploy'),
        wasm: z.string(),
        name: z.string().optional(),
        templateId: z.string().optional(),
        initArgs: z.record(z.unknown()).optional(),
      }),
      z.object({
        action: z.literal('call'),
        contract: z.string(),
        function: z.string(),
        args: z.unknown().optional(),
        source: z.string().optional(),
      }),
      z.object({
        action: z.literal('assert'),
        contract: z.string(),
        function: z.string(),
        expected: z.unknown(),
        args: z.unknown().optional(),
        source: z.string().optional(),
      }),
    ]),
  ),
  timeout: z.number().int().positive().optional(),
  onFailure: z.enum(['stop', 'continue']).optional(),
});
const shareSchema = z.object({
  sessionId: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
});
const exportSchema = z.object({
  sessionId: z.string().min(1),
  format: z.enum(['js', 'python', 'json']).optional(),
});
const importSchema = z.object({ sessionId: z.string().min(1), payload: z.unknown() });
const invariantSchema = z.object({
  sessionId: z.string().min(1),
  contract: z.string().min(1),
  invariant: z.string().min(1),
  checker: z.string().optional(),
  bound: z.record(z.unknown()).optional(),
});
const assertionSchema = z.object({
  sessionId: z.string().min(1),
  contract: z.string().min(1),
  assertion: z.string().min(1),
  checker: z.string().optional(),
});

function handleError(res: Response, error: unknown): void {
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

function getSessionId(params: unknown): string {
  return sessionIdSchema.parse(params).sessionId;
}

sandboxRouter.get('/templates', async (req: Request, res: Response) => {
  try {
    const templates = await sandboxEngine.listTemplates({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
    });
    res.json(templates);
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/templates/:id', async (req, res) => {
  try {
    const template = await sandboxEngine.getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json(template);
  } catch (error) {
    return handleError(res, error);
  }
});

sandboxRouter.post('/templates', async (req, res) => {
  try {
    const created = await sandboxEngine.submitTemplate(req.body);
    res.status(201).json(created);
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/templates/:id/params', async (req, res) => {
  try {
    const params = await sandboxEngine.getTemplateParams(req.params.id);
    if (!params) return res.status(404).json({ error: 'Template not found' });
    return res.json(params);
  } catch (error) {
    return handleError(res, error);
  }
});

sandboxRouter.post('/session', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.createSession(sessionCreateSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId', async (req, res) => {
  try {
    res.json(await sandboxEngine.getSession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.delete('/session/:sessionId', async (req, res) => {
  try {
    res.json(await sandboxEngine.destroySession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/pause', async (req, res) => {
  try {
    res.json(await sandboxEngine.pauseSession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/reset', async (req, res) => {
  try {
    res.json(await sandboxEngine.resetSession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/snapshot', async (req, res) => {
  try {
    const body = snapshotSchema.parse({ sessionId: getSessionId(req.params), ...req.body });
    res.status(201).json(await sandboxEngine.snapshotSession(body));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/snapshots', async (req, res) => {
  try {
    res.json(await sandboxEngine.listSnapshots(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/restore/:snapshotId', async (req, res) => {
  try {
    res.json(await sandboxEngine.restoreSnapshot(getSessionId(req.params), req.params.snapshotId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/advance', async (req, res) => {
  try {
    const sessionId = getSessionId(req.params);
    const ledgers = typeof req.body?.ledgers === 'number' ? req.body.ledgers : 1;
    const seconds = typeof req.body?.seconds === 'number' ? req.body.seconds : 0;
    res.json(await sandboxEngine.advanceSession(sessionId, ledgers, seconds));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/fund', async (req, res) => {
  try {
    res.json(await sandboxEngine.fundAccount(getSessionId(req.params), fundSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/accounts', async (req, res) => {
  try {
    res
      .status(201)
      .json(
        await sandboxEngine.createAccount(getSessionId(req.params), accountSchema.parse(req.body)),
      );
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/accounts', async (req, res) => {
  try {
    res.json(await sandboxEngine.listAccounts(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/register-token', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.registerToken(getSessionId(req.params), req.body));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/deploy', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.deploy(deploySchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/deploy-from-template', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.deployFromTemplate(deploySchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/deploy-from-mainnet', async (req, res) => {
  try {
    res
      .status(201)
      .json(await sandboxEngine.deployFromMainnet(deployMainnetSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/call', async (req, res) => {
  try {
    res.json(await sandboxEngine.call(callSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/call-batch', async (req, res) => {
  try {
    const body = batchCallSchema.parse(req.body);
    res.json(await sandboxEngine.callBatch(body.sessionId, body.calls));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/contracts', async (req, res) => {
  try {
    res.json(await sandboxEngine.listContracts(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/contracts/:address/state', async (req, res) => {
  try {
    res.json(await sandboxEngine.getContractState(getSessionId(req.params), req.params.address));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/contracts/:address/abi', async (req, res) => {
  try {
    res.json(await sandboxEngine.getContractAbi(getSessionId(req.params), req.params.address));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/debug', async (req, res) => {
  try {
    const body = debugSchema.parse(req.body);
    res.json(
      await sandboxEngine.debug({
        sessionId: body.sessionId,
        contractId: body.contract,
        functionName: body.function,
        args: body.args,
        sourceAccount: body.source,
        traceOptions: body.traceOptions,
      }),
    );
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/debugger-ui', async (req, res) => {
  try {
    const session = await sandboxEngine.getSession(getSessionId(req.params));
    res
      .type('html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Sandbox Debugger</title><style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e8eefc;padding:24px}pre{background:#121a33;padding:16px;border-radius:12px;overflow:auto}</style></head><body><h1>Sandbox Debugger</h1><p>Session ${session.id} is ${session.status}.</p><pre>${escapeHtml(JSON.stringify(session, null, 2))}</pre></body></html>`,
      );
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post(
  '/debug/set-breakpoint',
  asyncHandler(async (req, res) => {
    res.json({ set: true, breakpoint: req.body });
  }),
);

sandboxRouter.post(
  '/debug/continue',
  asyncHandler(async (req, res) => {
    res.json({ continued: true, breakpoint: req.body });
  }),
);

sandboxRouter.get('/session/:sessionId/calls', async (req, res) => {
  try {
    res.json(await sandboxEngine.listCalls(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/calls/:callId', async (req, res) => {
  try {
    res.json(await sandboxEngine.getCall(getSessionId(req.params), req.params.callId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/compare', async (req, res) => {
  try {
    res.json(await sandboxEngine.compare(compareSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/session/:sessionId/state-diff', async (req, res) => {
  try {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    if (!since) return res.status(400).json({ error: 'Query parameter "since" is required.' });
    res.json(await sandboxEngine.stateDiff(getSessionId(req.params), since));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/fuzz/start', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.startFuzz(fuzzStartSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/fuzz/stop/:runId', async (req, res) => {
  try {
    res.json(await sandboxEngine.stopFuzz(req.params.runId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/fuzz/run/:runId', async (req, res) => {
  try {
    const run = await sandboxEngine.getFuzzRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Fuzz run not found' });
    return res.json(run);
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/fuzz/run/:runId/findings', async (req, res) => {
  try {
    res.json(await sandboxEngine.listFuzzFindings(req.params.runId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/fuzz/runs', async (req, res) => {
  try {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    res.json(await sandboxEngine.listFuzzRuns(sessionId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/fuzz/run/:runId/replay/:findingId', async (req, res) => {
  try {
    res.json(await sandboxEngine.replayFinding(req.params.runId, req.params.findingId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/ci/execute', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.executeCi(ciSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/ci/result/:runId', async (req, res) => {
  try {
    const run = await sandboxEngine.getCiResult(req.params.runId);
    if (!run) return res.status(404).json({ error: 'CI run not found' });
    return res.json(run);
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/share', async (req, res) => {
  try {
    const body = shareSchema.parse({ sessionId: getSessionId(req.params), ...req.body });
    res
      .status(201)
      .json(
        await sandboxEngine.shareSession(
          body.sessionId,
          body.expiresAt ? new Date(body.expiresAt) : undefined,
        ),
      );
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/share/:shareId', async (req, res) => {
  try {
    res.json(await sandboxEngine.viewShare(req.params.shareId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/export', async (req, res) => {
  try {
    const body = exportSchema.parse({ sessionId: req.params.sessionId, ...req.body });
    res.json(await sandboxEngine.exportSession(body.sessionId, body.format ?? 'json'));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/session/:sessionId/import', async (req, res) => {
  try {
    const body = importSchema.parse({ sessionId: req.params.sessionId, payload: req.body });
    res.json(await sandboxEngine.importSession(body.sessionId, body.payload));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/optimize', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    res.json(
      await sandboxEngine.optimizeContract(
        sessionId,
        typeof req.body.contractId === 'string' ? req.body.contractId : undefined,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/verify/invariant', async (req, res) => {
  try {
    const body = invariantSchema.parse(req.body);
    res.json(
      await sandboxEngine.verifyInvariant(body.sessionId, {
        contract: body.contract,
        invariant: body.invariant,
        checker: body.checker,
        bound: body.bound,
      }),
    );
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/verify/assertion', async (req, res) => {
  try {
    const body = assertionSchema.parse(req.body);
    res.json(await sandboxEngine.verifyAssertion(body.sessionId, body));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/generate/sdk', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.generateSdk(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/generate/docs', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.generateDocs(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/generate/tests', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.generateTests(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/benchmark', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.benchmark(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/replay/:txHash', async (req, res) => {
  try {
    res.json(await sandboxEngine.replayMainnet(req.params.txHash));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.get('/replay/:txHash/comparison', async (req, res) => {
  try {
    res.json({
      txHash: req.params.txHash,
      comparison: await sandboxEngine.replayMainnet(req.params.txHash),
    });
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/fork/:contractAddress', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    res.status(201).json(await sandboxEngine.forkContract(sessionId, req.params.contractAddress));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/deploy-to-testnet', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.deployToTestnet(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

sandboxRouter.post('/deploy-to-mainnet', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.deployToMainnet(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
