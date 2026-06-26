import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sandboxEngine } from '../sandbox/runtime';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Sandbox
 *   description: >
 *     In-memory Soroban sandbox for developing and testing smart contracts locally.
 *     Live VM state is kept in memory; sessions persist to the database.
 *     Note: sandbox router is not currently mounted in router.ts.
 */
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

/**
 * @swagger
 * /api/v1/sandbox/templates:
 *   get:
 *     summary: List contract templates
 *     description: Returns all built-in sandbox templates, optionally filtered by search term or category. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Substring match on id, name, description, or category
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Exact category filter (token, dex, nft, wallet, governance, auction)
 *     responses:
 *       200:
 *         description: Array of matching templates
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SandboxTemplate'
 *             example:
 *               - id: sep41-token
 *                 name: SEP-41 Token
 *                 category: token
 *                 version: "1.0.0"
 *                 author: Copilot
 */
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

/**
 * @swagger
 * /api/v1/sandbox/templates/{id}:
 *   get:
 *     summary: Get a template by ID
 *     description: Returns the full template record for the given ID. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: sep41-token
 *     responses:
 *       200:
 *         description: Template found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxTemplate'
 *       404:
 *         description: Template not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Template not found
 */
sandboxRouter.get('/templates/:id', async (req, res) => {
  try {
    const template = await sandboxEngine.getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json(template);
  } catch (error) {
    return handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/templates:
 *   post:
 *     summary: Submit a custom template
 *     description: Creates or updates a contract template in the in-memory registry and persists it to the database. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, category, wasmBase64, deploymentGuide, version, author]
 *             properties:
 *               id:
 *                 type: string
 *                 description: Optional ID (UUID generated if omitted)
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               category:
 *                 type: string
 *               wasmBase64:
 *                 type: string
 *                 description: Base64-encoded Wasm bytecode
 *               abi:
 *                 type: object
 *               defaultArgs:
 *                 type: object
 *               deploymentGuide:
 *                 type: string
 *               version:
 *                 type: string
 *               author:
 *                 type: string
 *     responses:
 *       201:
 *         description: Template created or updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxTemplate'
 */
sandboxRouter.post('/templates', async (req, res) => {
  try {
    const created = await sandboxEngine.submitTemplate(req.body);
    res.status(201).json(created);
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/templates/{id}/params:
 *   get:
 *     summary: Get template deployment parameters
 *     description: Returns the default constructor arguments, ABI, and deployment guide for a template. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: sep41-token
 *     responses:
 *       200:
 *         description: Template parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxTemplateParams'
 *       404:
 *         description: Template not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Template not found
 */
sandboxRouter.get('/templates/:id/params', async (req, res) => {
  try {
    const params = await sandboxEngine.getTemplateParams(req.params.id);
    if (!params) return res.status(404).json({ error: 'Template not found' });
    return res.json(params);
  } catch (error) {
    return handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session:
 *   post:
 *     summary: Create a sandbox session
 *     description: Creates a new in-memory Soroban sandbox session with pre-funded accounts and a configurable ledger starting state. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *                 nullable: true
 *               ledgerSequence:
 *                 type: integer
 *                 description: Starting ledger sequence (default 1)
 *               ledgerTimestamp:
 *                 type: string
 *                 description: Starting ledger timestamp (ISO string or Date; default now)
 *               networkPassphrase:
 *                 type: string
 *               maxContractSize:
 *                 type: integer
 *                 description: Max Wasm size in bytes (default 102400)
 *               maxCpuInsn:
 *                 type: integer
 *                 description: CPU instruction budget (default 10000000)
 *               maxMemBytes:
 *                 type: integer
 *                 description: Memory budget in bytes (default 1048576)
 *               seed:
 *                 type: string
 *                 description: Deterministic seed for account key generation
 *               ttlHours:
 *                 type: integer
 *                 description: Session TTL in hours (default 4)
 *               accountCount:
 *                 type: integer
 *                 description: Number of pre-funded accounts to generate (default 20)
 *               preFundedBalance:
 *                 type: string
 *                 description: Starting balance for each pre-funded account (default 10000)
 *     responses:
 *       201:
 *         description: Session created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSession'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Expected number, received string"
 */
sandboxRouter.post('/session', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.createSession(sessionCreateSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}:
 *   get:
 *     summary: Get session details
 *     description: Returns the current state summary for a sandbox session, including live ledger position, account count, and call history counts. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Session summary
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSession'
 *       400:
 *         description: Invalid session ID or session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Session not found
 */
sandboxRouter.get('/session/:sessionId', async (req, res) => {
  try {
    res.json(await sandboxEngine.getSession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}:
 *   delete:
 *     summary: Destroy a sandbox session
 *     description: Marks the session as destroyed in the database and removes it from the in-memory active sessions map. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Session destroyed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 destroyed:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid session ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "String must contain at least 1 character(s)"
 */
sandboxRouter.delete('/session/:sessionId', async (req, res) => {
  try {
    res.json(await sandboxEngine.destroySession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/pause:
 *   post:
 *     summary: Pause a session
 *     description: Sets the session status to paused and persists the current runtime state. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated session summary
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSession'
 *       400:
 *         description: Invalid session ID or session not active in memory
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.post('/session/:sessionId/pause', async (req, res) => {
  try {
    res.json(await sandboxEngine.pauseSession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/reset:
 *   post:
 *     summary: Reset session to genesis state
 *     description: Restores the runtime block to the original genesis state, clearing all contracts and account mutations. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated session summary after reset
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSession'
 *       400:
 *         description: Invalid session ID or session not active in memory
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.post('/session/:sessionId/reset', async (req, res) => {
  try {
    res.json(await sandboxEngine.resetSession(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/snapshot:
 *   post:
 *     summary: Take a named snapshot
 *     description: Saves the current runtime state as a named snapshot that can be restored later. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Human-readable snapshot label
 *                 example: after-deploy
 *     responses:
 *       201:
 *         description: Snapshot record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSnapshot'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "String must contain at least 1 character(s)"
 */
sandboxRouter.post('/session/:sessionId/snapshot', async (req, res) => {
  try {
    const body = snapshotSchema.parse({ sessionId: getSessionId(req.params), ...req.body });
    res.status(201).json(await sandboxEngine.snapshotSession(body));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/snapshots:
 *   get:
 *     summary: List snapshots for a session
 *     description: Returns all named snapshots for the session, newest first. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of snapshot records
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SandboxSnapshot'
 *       400:
 *         description: Invalid session ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "String must contain at least 1 character(s)"
 */
sandboxRouter.get('/session/:sessionId/snapshots', async (req, res) => {
  try {
    res.json(await sandboxEngine.listSnapshots(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/restore/{snapshotId}:
 *   post:
 *     summary: Restore a snapshot
 *     description: Replaces the current runtime block with the state captured in the named snapshot. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: snapshotId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated session summary after restore
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSession'
 *       400:
 *         description: Invalid session ID, snapshot not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Snapshot not found
 */
sandboxRouter.post('/session/:sessionId/restore/:snapshotId', async (req, res) => {
  try {
    res.json(await sandboxEngine.restoreSnapshot(getSessionId(req.params), req.params.snapshotId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/advance:
 *   post:
 *     summary: Advance the ledger clock
 *     description: Increments the ledger sequence and optionally moves the ledger timestamp forward. Useful for testing time-dependent logic. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ledgers:
 *                 type: integer
 *                 description: Number of ledgers to advance (default 1)
 *                 example: 5
 *               seconds:
 *                 type: integer
 *                 description: Seconds to add to the ledger timestamp (default 0)
 *                 example: 3600
 *     responses:
 *       200:
 *         description: Updated session summary
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSession'
 *       400:
 *         description: Invalid session ID or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
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

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/fund:
 *   post:
 *     summary: Fund an account
 *     description: Adds the given amount to an account's balance within the session. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey, amount]
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: Stellar public key of the account to fund
 *                 example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *               amount:
 *                 type: string
 *                 description: Amount to add (decimal string or number)
 *                 example: "5000"
 *     responses:
 *       200:
 *         description: Updated account state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxAccount'
 *       400:
 *         description: Invalid input, account not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Account not found
 */
sandboxRouter.post('/session/:sessionId/fund', async (req, res) => {
  try {
    res.json(await sandboxEngine.fundAccount(getSessionId(req.params), fundSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/accounts:
 *   post:
 *     summary: Create a new account
 *     description: Generates a new deterministic Stellar key pair and adds it to the session. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label:
 *                 type: string
 *                 nullable: true
 *                 description: Optional human-readable label
 *                 example: alice
 *               balance:
 *                 type: string
 *                 description: Starting balance (default 0)
 *                 example: "1000"
 *               isPreFunded:
 *                 type: boolean
 *                 description: Mark account as pre-funded (default false)
 *     responses:
 *       201:
 *         description: New account state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxAccount'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
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

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/accounts:
 *   get:
 *     summary: List session accounts
 *     description: Returns all accounts currently live in the session's runtime block. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of account states
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SandboxAccount'
 *       400:
 *         description: Invalid session ID or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.get('/session/:sessionId/accounts', async (req, res) => {
  try {
    res.json(await sandboxEngine.listAccounts(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/register-token:
 *   post:
 *     summary: Register a token contract
 *     description: Deploys a SEP-41 token template into the session using the provided metadata. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: Deployer account public key (defaults to first session account)
 *               name:
 *                 type: string
 *                 description: Token name (default "Registered Token")
 *               symbol:
 *                 type: string
 *                 description: Token symbol (default "TOK")
 *               decimals:
 *                 type: integer
 *                 description: Token decimals (default 7)
 *               supply:
 *                 type: string
 *                 description: Initial supply in base units (default 0)
 *     responses:
 *       201:
 *         description: Deployed token contract
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxContract'
 *       400:
 *         description: Invalid session ID or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.post('/session/:sessionId/register-token', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.registerToken(getSessionId(req.params), req.body));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/deploy:
 *   post:
 *     summary: Deploy a contract
 *     description: Deploys a Wasm contract (provided as base64) into the session's runtime state. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               wasm:
 *                 type: string
 *                 description: Base64-encoded Wasm bytecode
 *               name:
 *                 type: string
 *               deployer:
 *                 type: string
 *                 description: Deployer public key (defaults to first session account)
 *               salt:
 *                 type: string
 *                 description: Salt for deterministic contract ID generation
 *               initArgs:
 *                 type: object
 *                 description: Constructor arguments
 *               templateId:
 *                 type: string
 *                 description: Template ID to pull default ABI and state from
 *               sourceContract:
 *                 type: string
 *                 description: Mainnet contract address this was forked from
 *               abi:
 *                 type: object
 *     responses:
 *       201:
 *         description: Deployed contract state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxContract'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.post('/deploy', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.deploy(deploySchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/deploy-from-template:
 *   post:
 *     summary: Deploy from a built-in template
 *     description: Looks up a template by templateId, then deploys it with the template's Wasm and default ABI. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, templateId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               templateId:
 *                 type: string
 *                 example: sep41-token
 *               name:
 *                 type: string
 *               deployer:
 *                 type: string
 *               salt:
 *                 type: string
 *               initArgs:
 *                 type: object
 *                 description: Overrides the template's defaultArgs
 *     responses:
 *       201:
 *         description: Deployed contract state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxContract'
 *       400:
 *         description: Invalid input, template not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Template not found
 */
sandboxRouter.post('/deploy-from-template', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.deployFromTemplate(deploySchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/deploy-from-mainnet:
 *   post:
 *     summary: Fork a mainnet contract into the sandbox
 *     description: Looks up the contract by address on mainnet, copies its ABI and name, then deploys a local copy. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractAddress]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractAddress:
 *                 type: string
 *                 description: Mainnet contract address to fork
 *                 example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *               name:
 *                 type: string
 *               deployer:
 *                 type: string
 *     responses:
 *       201:
 *         description: Forked contract state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxContract'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.post('/deploy-from-mainnet', async (req, res) => {
  try {
    res
      .status(201)
      .json(await sandboxEngine.deployFromMainnet(deployMainnetSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/call:
 *   post:
 *     summary: Call a contract function
 *     description: Invokes a function on a deployed sandbox contract and returns the result, events, and execution trace. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractId, functionName]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *                 description: Contract address within the session
 *               functionName:
 *                 type: string
 *                 example: transfer
 *               args:
 *                 description: Function arguments (object or any JSON value)
 *               sourceAccount:
 *                 type: string
 *                 description: Caller public key (defaults to contract deployer)
 *               batchId:
 *                 type: string
 *                 nullable: true
 *                 description: Optional batch correlation ID
 *     responses:
 *       200:
 *         description: Call result including success flag, return value, events, trace, and resource metrics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxCallResult'
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/call', async (req, res) => {
  try {
    res.json(await sandboxEngine.call(callSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/call-batch:
 *   post:
 *     summary: Execute multiple contract calls in sequence
 *     description: Runs an ordered list of contract calls within a single session, sharing a batch ID. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, calls]
 *             properties:
 *               sessionId:
 *                 type: string
 *               calls:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [contractId, functionName]
 *                   properties:
 *                     contractId:
 *                       type: string
 *                     functionName:
 *                       type: string
 *                     args:
 *                       description: Function arguments
 *                     sourceAccount:
 *                       type: string
 *     responses:
 *       200:
 *         description: Batch result with a shared batchId and per-call results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId:
 *                   type: string
 *                   format: uuid
 *                   example: 550e8400-e29b-41d4-a716-446655440000
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SandboxCallResult'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.post('/call-batch', async (req, res) => {
  try {
    const body = batchCallSchema.parse(req.body);
    res.json(await sandboxEngine.callBatch(body.sessionId, body.calls));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/contracts:
 *   get:
 *     summary: List deployed contracts
 *     description: Returns all contracts currently live in the session's runtime block. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of contract states
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SandboxContract'
 *       400:
 *         description: Invalid session ID or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.get('/session/:sessionId/contracts', async (req, res) => {
  try {
    res.json(await sandboxEngine.listContracts(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/contracts/{address}/state:
 *   get:
 *     summary: Get contract storage state
 *     description: Returns the raw key/value storage map for the given contract. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Contract address within the session
 *     responses:
 *       200:
 *         description: Contract storage state object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *               example:
 *                 totalSupply: "0"
 *                 balances: {}
 *       400:
 *         description: Invalid session ID, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.get('/session/:sessionId/contracts/:address/state', async (req, res) => {
  try {
    res.json(await sandboxEngine.getContractState(getSessionId(req.params), req.params.address));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/contracts/{address}/abi:
 *   get:
 *     summary: Get contract ABI
 *     description: Returns the ABI (function signatures and types) for the given contract. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Contract address within the session
 *     responses:
 *       200:
 *         description: Contract ABI object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 functions:
 *                   type: array
 *                   items:
 *                     type: object
 *               example:
 *                 functions:
 *                   - name: transfer
 *                     inputs:
 *                       - name: to
 *                         type: address
 *                       - name: amount
 *                         type: i128
 *       400:
 *         description: Invalid session ID, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.get('/session/:sessionId/contracts/:address/abi', async (req, res) => {
  try {
    res.json(await sandboxEngine.getContractAbi(getSessionId(req.params), req.params.address));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/debug:
 *   post:
 *     summary: Debug a contract call
 *     description: Executes a contract function and returns the full call result extended with a debugger object containing host-function steps, a state diff, and gas metrics. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contract, function]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contract:
 *                 type: string
 *                 description: Contract address within the session
 *               function:
 *                 type: string
 *                 description: Function name to invoke
 *                 example: transfer
 *               args:
 *                 description: Function arguments
 *               source:
 *                 type: string
 *                 description: Caller account public key
 *               traceOptions:
 *                 type: object
 *                 description: Optional tracer configuration
 *     responses:
 *       200:
 *         description: Call result extended with a debugger object
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SandboxCallResult'
 *                 - type: object
 *                   properties:
 *                     debugger:
 *                       type: object
 *                       properties:
 *                         hostFunctions:
 *                           type: array
 *                           items: { type: object }
 *                         stateDiff:
 *                           type: object
 *                           properties:
 *                             equal: { type: boolean }
 *                         gas:
 *                           type: object
 *                           properties:
 *                             cpuInsnUsed: { type: integer }
 *                             memBytesUsed: { type: integer }
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
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

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/debugger-ui:
 *   get:
 *     summary: Debugger UI page
 *     description: Returns a minimal HTML page showing the live session state. Intended for browser-based debugging. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: HTML debugger page
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid session ID or session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Session not found
 */
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

/**
 * @swagger
 * /api/v1/sandbox/debug/set-breakpoint:
 *   post:
 *     summary: Set a debugger breakpoint (stub)
 *     description: Stub endpoint that echoes the breakpoint payload back. Full breakpoint support is not yet implemented. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Arbitrary breakpoint descriptor
 *     responses:
 *       200:
 *         description: Acknowledgement with the submitted breakpoint
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 set:
 *                   type: boolean
 *                   example: true
 *                 breakpoint:
 *                   type: object
 *                   description: Echo of the request body
 */
sandboxRouter.post(
  '/debug/set-breakpoint',
  asyncHandler(async (req, res) => {
    res.json({ set: true, breakpoint: req.body });
  }),
);

/**
 * @swagger
 * /api/v1/sandbox/debug/continue:
 *   post:
 *     summary: Continue from a breakpoint (stub)
 *     description: Stub endpoint that echoes the payload back. Full step-through execution is not yet implemented. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Arbitrary continuation context
 *     responses:
 *       200:
 *         description: Acknowledgement with the submitted context
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 continued:
 *                   type: boolean
 *                   example: true
 *                 breakpoint:
 *                   type: object
 *                   description: Echo of the request body
 */
sandboxRouter.post(
  '/debug/continue',
  asyncHandler(async (req, res) => {
    res.json({ continued: true, breakpoint: req.body });
  }),
);

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/calls:
 *   get:
 *     summary: List call history
 *     description: Returns all persisted call records for a session, newest first. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of call records
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   sessionId: { type: string }
 *                   contractId: { type: string }
 *                   functionName: { type: string }
 *                   args: { type: object }
 *                   sourceAccount: { type: string }
 *                   success: { type: boolean }
 *                   result: { nullable: true }
 *                   error: { type: string, nullable: true }
 *                   cpuInsnUsed: { type: integer }
 *                   memBytesUsed: { type: integer }
 *                   createdAt: { type: string, format: date-time }
 *       400:
 *         description: Invalid session ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "String must contain at least 1 character(s)"
 */
sandboxRouter.get('/session/:sessionId/calls', async (req, res) => {
  try {
    res.json(await sandboxEngine.listCalls(getSessionId(req.params)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/calls/{callId}:
 *   get:
 *     summary: Get a call record
 *     description: Returns the persisted call record for the given ID. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: callId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Call record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 sessionId: { type: string }
 *                 contractId: { type: string }
 *                 functionName: { type: string }
 *                 args: { type: object }
 *                 sourceAccount: { type: string }
 *                 success: { type: boolean }
 *                 result: { nullable: true }
 *                 error: { type: string, nullable: true }
 *                 cpuInsnUsed: { type: integer }
 *                 memBytesUsed: { type: integer }
 *                 createdAt: { type: string, format: date-time }
 *       400:
 *         description: Invalid session ID or call not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Call not found
 */
sandboxRouter.get('/session/:sessionId/calls/:callId', async (req, res) => {
  try {
    res.json(await sandboxEngine.getCall(getSessionId(req.params), req.params.callId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/compare:
 *   post:
 *     summary: Compare two contracts
 *     description: Diffs the ABI, storage state, and metadata of two contracts. Each side can be a live session contract ID, a template ID, or a mainnet contract address. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [left, right]
 *             properties:
 *               sessionId:
 *                 type: string
 *                 description: Optional session to resolve live contract IDs from
 *               left:
 *                 type: string
 *                 description: Contract ID, template ID, or mainnet address
 *               right:
 *                 type: string
 *                 description: Contract ID, template ID, or mainnet address
 *     responses:
 *       200:
 *         description: Comparison result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 left:
 *                   $ref: '#/components/schemas/SandboxContract'
 *                 right:
 *                   $ref: '#/components/schemas/SandboxContract'
 *                 diff:
 *                   type: object
 *                   properties:
 *                     abi:
 *                       type: object
 *                       properties:
 *                         equal: { type: boolean }
 *                     state:
 *                       type: object
 *                       properties:
 *                         equal: { type: boolean }
 *                     metadata:
 *                       type: object
 *                       properties:
 *                         equal: { type: boolean }
 *       400:
 *         description: Invalid input or unable to resolve a contract
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Unable to resolve comparable contract or template: unknown-id"
 */
sandboxRouter.post('/compare', async (req, res) => {
  try {
    res.json(await sandboxEngine.compare(compareSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/state-diff:
 *   get:
 *     summary: Diff current state against a snapshot
 *     description: Returns the keys that differ between the current runtime block and the state captured in the given snapshot. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: since
 *         required: true
 *         schema: { type: string }
 *         description: Snapshot ID to diff against
 *     responses:
 *       200:
 *         description: State diff result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sinceSnapshotId:
 *                   type: string
 *                   example: clz9q1x4t0000s6h2snap0001
 *                 diffKeys:
 *                   type: array
 *                   items: { type: string }
 *                   description: Top-level keys whose values changed
 *                   example: [contracts, ledgerSequence]
 *                 before:
 *                   type: object
 *                 after:
 *                   type: object
 *       400:
 *         description: Missing "since" parameter, invalid session ID, or snapshot not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Query parameter \"since\" is required."
 */
sandboxRouter.get('/session/:sessionId/state-diff', async (req, res) => {
  try {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    if (!since) return res.status(400).json({ error: 'Query parameter "since" is required.' });
    res.json(await sandboxEngine.stateDiff(getSessionId(req.params), since));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/fuzz/start:
 *   post:
 *     summary: Start a fuzz run
 *     description: Runs one or more fuzz strategies against a contract and returns findings. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contract, strategies]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contract:
 *                 type: string
 *                 description: Contract address within the session
 *               strategies:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [type]
 *                   properties:
 *                     type:
 *                       type: string
 *                       description: Strategy name (e.g. known_attack, boundary, mutation)
 *                     iterations:
 *                       type: integer
 *                       description: Number of iterations (default 100)
 *                     params:
 *                       type: object
 *               timeoutSeconds:
 *                 type: integer
 *               stopOnFirst:
 *                 type: string
 *                 description: Stop on first finding of this severity
 *     responses:
 *       201:
 *         description: Completed fuzz run with findings
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/FuzzRun'
 *                 - type: object
 *                   properties:
 *                     findings:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/FuzzFinding'
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/fuzz/start', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.startFuzz(fuzzStartSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/fuzz/stop/{runId}:
 *   post:
 *     summary: Cancel a fuzz run
 *     description: Sets the fuzz run status to cancelled. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated fuzz run record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FuzzRun'
 */
sandboxRouter.post('/fuzz/stop/:runId', async (req, res) => {
  try {
    res.json(await sandboxEngine.stopFuzz(req.params.runId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/fuzz/run/{runId}:
 *   get:
 *     summary: Get a fuzz run
 *     description: Returns the fuzz run record for the given ID. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Fuzz run record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FuzzRun'
 *       404:
 *         description: Fuzz run not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Fuzz run not found
 */
sandboxRouter.get('/fuzz/run/:runId', async (req, res) => {
  try {
    const run = await sandboxEngine.getFuzzRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Fuzz run not found' });
    return res.json(run);
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/fuzz/run/{runId}/findings:
 *   get:
 *     summary: List findings for a fuzz run
 *     description: Returns all findings for the given fuzz run, newest first. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of fuzz findings
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FuzzFinding'
 */
sandboxRouter.get('/fuzz/run/:runId/findings', async (req, res) => {
  try {
    res.json(await sandboxEngine.listFuzzFindings(req.params.runId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/fuzz/runs:
 *   get:
 *     summary: List fuzz runs
 *     description: Returns all fuzz runs, optionally filtered by session, newest first. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: query
 *         name: sessionId
 *         schema: { type: string }
 *         description: Filter runs by session ID
 *     responses:
 *       200:
 *         description: Array of fuzz run records
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FuzzRun'
 */
sandboxRouter.get('/fuzz/runs', async (req, res) => {
  try {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    res.json(await sandboxEngine.listFuzzRuns(sessionId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/fuzz/run/{runId}/replay/{findingId}:
 *   post:
 *     summary: Replay a fuzz finding
 *     description: Re-executes the call sequence from a specific finding to reproduce the issue. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: findingId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Replay result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 replayed:
 *                   type: boolean
 *                   example: true
 *                 finding:
 *                   $ref: '#/components/schemas/FuzzFinding'
 *       400:
 *         description: Finding not found or does not belong to this run
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Finding not found
 */
sandboxRouter.post('/fuzz/run/:runId/replay/:findingId', async (req, res) => {
  try {
    res.json(await sandboxEngine.replayFinding(req.params.runId, req.params.findingId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/ci/execute:
 *   post:
 *     summary: Run a CI pipeline
 *     description: Executes an ordered list of deploy, call, and assert steps in a fresh or existing session. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [steps]
 *             properties:
 *               sessionId:
 *                 type: string
 *                 description: Existing session to use (new session created if omitted)
 *               steps:
 *                 type: array
 *                 items:
 *                   oneOf:
 *                     - type: object
 *                       required: [action, wasm]
 *                       properties:
 *                         action: { type: string, enum: [deploy] }
 *                         wasm: { type: string }
 *                         name: { type: string }
 *                         templateId: { type: string }
 *                         initArgs: { type: object }
 *                     - type: object
 *                       required: [action, contract, function]
 *                       properties:
 *                         action: { type: string, enum: [call] }
 *                         contract: { type: string }
 *                         function: { type: string }
 *                         args: {}
 *                         source: { type: string }
 *                     - type: object
 *                       required: [action, contract, function, expected]
 *                       properties:
 *                         action: { type: string, enum: [assert] }
 *                         contract: { type: string }
 *                         function: { type: string }
 *                         expected: {}
 *                         args: {}
 *                         source: { type: string }
 *               timeout:
 *                 type: integer
 *                 description: Timeout in milliseconds
 *               onFailure:
 *                 type: string
 *                 enum: [stop, continue]
 *                 description: Whether to stop or continue on the first assertion failure
 *     responses:
 *       201:
 *         description: CI run result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxCiResult'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Invalid discriminator value. Expected 'deploy' | 'call' | 'assert'"
 */
sandboxRouter.post('/ci/execute', async (req, res) => {
  try {
    res.status(201).json(await sandboxEngine.executeCi(ciSchema.parse(req.body)));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/ci/result/{runId}:
 *   get:
 *     summary: Get a CI run result
 *     description: Returns the persisted CI run record for the given run ID. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: CI run record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 sessionId: { type: string, nullable: true }
 *                 status: { type: string, description: "running | passed | failed" }
 *                 steps: { type: array, items: { type: object } }
 *                 logs: { type: array, items: { type: object } }
 *                 result: { type: object, description: "Mirrors SandboxCiResult fields" }
 *                 createdAt: { type: string, format: date-time }
 *                 completedAt: { type: string, format: date-time, nullable: true }
 *       404:
 *         description: CI run not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: CI run not found
 */
sandboxRouter.get('/ci/result/:runId', async (req, res) => {
  try {
    const run = await sandboxEngine.getCiResult(req.params.runId);
    if (!run) return res.status(404).json({ error: 'CI run not found' });
    return res.json(run);
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/share:
 *   post:
 *     summary: Create a share link
 *     description: Captures the current session state as a view-only snapshot and returns a share record. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               expiresAt:
 *                 type: string
 *                 format: date-time
 *                 description: Optional expiry timestamp for the share link
 *     responses:
 *       201:
 *         description: Share record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxShare'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
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

/**
 * @swagger
 * /api/v1/sandbox/share/{shareId}:
 *   get:
 *     summary: View a shared session
 *     description: Returns the view-only share record for the given share ID. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Share record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxShare'
 *       400:
 *         description: Share not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Share not found
 */
sandboxRouter.get('/share/:shareId', async (req, res) => {
  try {
    res.json(await sandboxEngine.viewShare(req.params.shareId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/export:
 *   post:
 *     summary: Export a session
 *     description: Serialises the session's runtime state as a JSON document or generates a code scaffold in JavaScript or Python. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               format:
 *                 type: string
 *                 enum: [js, python, json]
 *                 description: Export format (default json)
 *     responses:
 *       200:
 *         description: Export result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 format:
 *                   type: string
 *                   enum: [js, python, json]
 *                   example: json
 *                 sessionId:
 *                   type: string
 *                 script:
 *                   type: string
 *                   description: Serialised runtime state (json) or code scaffold (js/python)
 *       400:
 *         description: Invalid format value or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Invalid enum value. Expected 'js' | 'python' | 'json', received 'csv'"
 */
sandboxRouter.post('/session/:sessionId/export', async (req, res) => {
  try {
    const body = exportSchema.parse({ sessionId: req.params.sessionId, ...req.body });
    res.json(await sandboxEngine.exportSession(body.sessionId, body.format ?? 'json'));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/session/{sessionId}/import:
 *   post:
 *     summary: Import session state
 *     description: Replaces the session's runtime block with the state from the given payload. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Runtime state payload, typically the output of the export endpoint
 *             properties:
 *               runtime:
 *                 type: object
 *                 description: Runtime block containing ledgerSequence, accounts, and contracts
 *     responses:
 *       200:
 *         description: Updated session summary after import
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxSession'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Session abc is not active."
 */
sandboxRouter.post('/session/:sessionId/import', async (req, res) => {
  try {
    const body = importSchema.parse({ sessionId: req.params.sessionId, payload: req.body });
    res.json(await sandboxEngine.importSession(body.sessionId, body.payload));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/optimize:
 *   post:
 *     summary: Optimize a contract
 *     description: Analyses one or all contracts in a session and returns CPU/memory optimization recommendations. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *                 description: Analyse only this contract (all contracts analysed if omitted)
 *     responses:
 *       200:
 *         description: Optimization recommendations
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxOptimizeResult'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "String must contain at least 1 character(s)"
 */
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

/**
 * @swagger
 * /api/v1/sandbox/verify/invariant:
 *   post:
 *     summary: Verify a contract invariant
 *     description: Checks whether a named invariant (e.g. "balance <= totalSupply") holds for the given contract's current state. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contract, invariant]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contract:
 *                 type: string
 *                 description: Contract address within the session
 *               invariant:
 *                 type: string
 *                 description: Invariant expression string
 *                 example: balance <= totalSupply
 *               checker:
 *                 type: string
 *                 description: Verification backend (default smt)
 *               bound:
 *                 type: object
 *                 description: Optional bound constraints
 *     responses:
 *       200:
 *         description: Verification result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxVerifyResult'
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
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

/**
 * @swagger
 * /api/v1/sandbox/verify/assertion:
 *   post:
 *     summary: Verify a contract assertion
 *     description: Checks whether an assertion holds for the given contract's current state. Delegates to the invariant checker. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contract, assertion]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contract:
 *                 type: string
 *                 description: Contract address within the session
 *               assertion:
 *                 type: string
 *                 description: Assertion expression string
 *                 example: totalSupply > 0
 *               checker:
 *                 type: string
 *                 description: Verification backend (default smt)
 *     responses:
 *       200:
 *         description: Verification result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxVerifyResult'
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/verify/assertion', async (req, res) => {
  try {
    const body = assertionSchema.parse(req.body);
    res.json(await sandboxEngine.verifyAssertion(body.sessionId, body));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/generate/sdk:
 *   post:
 *     summary: Generate a TypeScript SDK
 *     description: Returns a TypeScript client class scaffold for a deployed contract's ABI. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *                 description: Contract address within the session
 *     responses:
 *       200:
 *         description: Generated SDK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 language:
 *                   type: string
 *                   example: typescript
 *                 contractId:
 *                   type: string
 *                 code:
 *                   type: string
 *                   description: TypeScript client class source
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/generate/sdk', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.generateSdk(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/generate/docs:
 *   post:
 *     summary: Generate contract documentation
 *     description: Returns a Markdown documentation string generated from a deployed contract's ABI. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Generated documentation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 markdown:
 *                   type: string
 *                   description: Markdown documentation for the contract
 *                 abi:
 *                   type: object
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/generate/docs', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.generateDocs(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/generate/tests:
 *   post:
 *     summary: Generate test scaffolding
 *     description: Returns a TypeScript test file skeleton for a deployed contract. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Generated test skeleton
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 language:
 *                   type: string
 *                   example: typescript
 *                 skeleton:
 *                   type: string
 *                   description: TypeScript describe/it test skeleton
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/generate/tests', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.generateTests(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/benchmark:
 *   post:
 *     summary: Benchmark a contract
 *     description: Returns throughput, latency, storage-growth, and memory-profile metrics for a deployed contract's key functions. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Benchmark metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 metrics:
 *                   type: object
 *                   properties:
 *                     throughput:
 *                       type: object
 *                       properties:
 *                         function: { type: string, example: transfer }
 *                         iterations: { type: integer, example: 1000 }
 *                         opsPerSecond: { type: integer, example: 1050 }
 *                     latency:
 *                       type: object
 *                       properties:
 *                         function: { type: string, example: swap }
 *                         iterations: { type: integer, example: 100 }
 *                         p95Ms: { type: integer, example: 13 }
 *                     storageGrowth:
 *                       type: object
 *                       properties:
 *                         function: { type: string, example: mint }
 *                         iterations: { type: integer, example: 100 }
 *                         bytes: { type: integer, example: 2176 }
 *                     memoryProfile:
 *                       type: object
 *                       properties:
 *                         function: { type: string, example: processAll }
 *                         peakKb: { type: integer, example: 528 }
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/benchmark', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.benchmark(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/replay/{txHash}:
 *   post:
 *     summary: Replay a mainnet transaction
 *     description: Scaffolds a mainnet transaction replay pipeline. Full live-RPC integration is not yet wired up. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         description: Mainnet transaction hash to replay
 *     responses:
 *       200:
 *         description: Replay result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash:
 *                   type: string
 *                 steps:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       action: { type: string }
 *                   example:
 *                     - action: load_transaction
 *                     - action: simulate_execution
 *                     - action: compare_state
 *                 comparison:
 *                   type: object
 *                   properties:
 *                     equal: { type: boolean, example: false }
 *                     note: { type: string }
 */
sandboxRouter.post('/replay/:txHash', async (req, res) => {
  try {
    res.json(await sandboxEngine.replayMainnet(req.params.txHash));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/replay/{txHash}/comparison:
 *   get:
 *     summary: Compare mainnet vs sandbox replay
 *     description: Returns the replay result wrapped with the transaction hash under a comparison key. Full live-RPC integration is not yet wired up. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *         description: Mainnet transaction hash
 *     responses:
 *       200:
 *         description: Comparison result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash:
 *                   type: string
 *                 comparison:
 *                   type: object
 *                   properties:
 *                     txHash: { type: string }
 *                     steps: { type: array, items: { type: object } }
 *                     comparison:
 *                       type: object
 *                       properties:
 *                         equal: { type: boolean, example: false }
 *                         note: { type: string }
 */
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

/**
 * @swagger
 * /api/v1/sandbox/fork/{contractAddress}:
 *   post:
 *     summary: Fork a mainnet contract
 *     description: Copies the ABI and name of a mainnet contract and deploys a local fork into the session. Equivalent to deploy-from-mainnet with a generated name. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     parameters:
 *       - in: path
 *         name: contractAddress
 *         required: true
 *         schema: { type: string }
 *         description: Mainnet contract address to fork
 *         example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId]
 *             properties:
 *               sessionId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Forked contract state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SandboxContract'
 *       400:
 *         description: Invalid input or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "String must contain at least 1 character(s)"
 */
sandboxRouter.post('/fork/:contractAddress', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    res.status(201).json(await sandboxEngine.forkContract(sessionId, req.params.contractAddress));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/deploy-to-testnet:
 *   post:
 *     summary: Export a contract to testnet
 *     description: Returns the Wasm hash and a readiness flag for deploying the contract to the Stellar testnet. Actual testnet submission is not performed. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Testnet deployment readiness
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId: { type: string }
 *                 contractId: { type: string }
 *                 target: { type: string, example: testnet }
 *                 ready: { type: boolean, example: true }
 *                 wasmHash: { type: string }
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
sandboxRouter.post('/deploy-to-testnet', async (req, res) => {
  try {
    const sessionId = z.string().min(1).parse(req.body.sessionId);
    const contractId = z.string().min(1).parse(req.body.contractId);
    res.json(await sandboxEngine.deployToTestnet(sessionId, contractId));
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * @swagger
 * /api/v1/sandbox/deploy-to-mainnet:
 *   post:
 *     summary: Export a contract to mainnet
 *     description: Returns the Wasm hash and a readiness flag for deploying to mainnet. Always returns ready=false and requires manual confirmation before any real submission. Note: sandbox router is not currently mounted in router.ts.
 *     tags: [Sandbox]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, contractId]
 *             properties:
 *               sessionId:
 *                 type: string
 *               contractId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Mainnet deployment readiness (always ready=false)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId: { type: string }
 *                 contractId: { type: string }
 *                 target: { type: string, example: mainnet }
 *                 ready: { type: boolean, example: false }
 *                 reason: { type: string, example: manual confirmation required }
 *                 wasmHash: { type: string }
 *       400:
 *         description: Invalid input, contract not found, or session not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: Contract not found
 */
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
