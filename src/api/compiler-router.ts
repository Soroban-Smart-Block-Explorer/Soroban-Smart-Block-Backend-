/**
 * Compiler API Router
 *
 * Endpoints for on-demand Soroban smart contract compilation, source
 * verification, and WASM hash comparison. Wraps the compiler utilities
 * from compiler.ts and exposes them via REST.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import multer from 'multer';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { z } from 'zod';
import {
  extractArchive,
  compileSandboxed,
  extractSourceFiles,
  cleanupDir,
  ToolchainEnum,
} from './compiler';
import { getActiveBuildCount, getConcurrencyLimit, getQueueMetrics } from './build-queue';
import type { RateLimitTier } from '../middleware/tokenBucket';

export const compilerRouter = Router();

// Middleware to check build quota before processing compile/verify
/**
 * Middleware that validates build quota availability for the request's API tier.
 * Adds X-Compiler-Quota headers and rejects with 429 if limit exceeded.
 */
function buildQuotaMiddleware(req: Request, res: Response, next: (err?: any) => void) {
  const tier = (req.apiKey?.tier ?? 'unauthenticated') as RateLimitTier;
  const rateLimitTier = (req as Request & { rateLimitResult?: { tier?: string } }).rateLimitResult
    ?.tier;
  const active = rateLimitTier ? getActiveBuildCount(rateLimitTier) : 0;
  const limit = getConcurrencyLimit(tier);

  // Set quota headers for visibility
  res.setHeader('X-Compiler-Quota-Limit', String(limit));
  res.setHeader('X-Compiler-Quota-Active', String(active));

  // Check if there's capacity available
  if (active >= limit && limit > 0) {
    res.status(429).json({
      error: 'Concurrent build limit exceeded for tier',
      tier,
      limit,
      active,
      retryAfter: 10,
    });
    return;
  }

  next();
}

// Multer for archive uploads (max 50 MB)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (
      ['.gz', '.tgz', '.zip'].includes(ext) ||
      file.mimetype === 'application/gzip' ||
      file.mimetype === 'application/zip'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only .tar.gz and .zip archives are allowed'));
    }
  },
});

// ── Periodic stale temp-file cleanup ─────────────────────────────────────────
// Remove Multer-uploaded files older than 1 hour that were never processed
// (e.g. process crashed after upload but before the finally block ran).
const STALE_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // run every 15 minutes

export function startTempFileCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    const tmpDir = os.tmpdir();
    const cutoff = Date.now() - STALE_AGE_MS;
    fs.readdir(tmpDir, (err, files) => {
      if (err) return;
      for (const file of files) {
        // Multer writes files with a random hex name (no extension)
        if (!/^[0-9a-f]{32}$/.test(file)) continue;
        const filePath = path.join(tmpDir, file);
        fs.stat(filePath, (statErr, stat) => {
          if (statErr || !stat.isFile()) return;
          if (stat.mtimeMs < cutoff) {
            fs.unlink(filePath, () => {}); // best-effort
          }
        });
      }
    });
  }, CLEANUP_INTERVAL_MS);
}

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compiler:
 *   get:
 *     summary: Compiler service overview
 *     tags: [Compiler]
 *     responses:
 *       200:
 *         description: Service info
 */
compilerRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Compiler API',
    description: 'On-demand Soroban smart contract compilation and source verification',
    supportedToolchains: ['soroban-cli@0.9.4', 'stellar-cli@21.0.0', 'cargo-contract@4.0.0'],
    maxArchiveSizeMB: 50,
    endpoints: [
      'GET  /compiler',
      'POST /compiler/compile',
      'POST /compiler/verify',
      'GET  /compiler/toolchains',
    ],
  });
});

// ── POST /compile ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compiler/compile:
 *   post:
 *     summary: Compile a Soroban contract from uploaded source archive
 *     tags: [Compiler]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [source, toolchain]
 *             properties:
 *               source:
 *                 type: string
 *                 format: binary
 *                 description: .tar.gz or .zip of the Cargo project
 *               toolchain:
 *                 type: string
 *                 enum: ['soroban-cli@0.9.4', 'stellar-cli@21.0.0', 'cargo-contract@4.0.0']
 *     responses:
 *       200:
 *         description: Compilation result including WASM hash
 *       400:
 *         description: Validation error or compilation failure
 */
compilerRouter.post(
  '/compile',
  buildQuotaMiddleware,
  upload.single('source'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'Source archive is required (multipart field: source)' });
    }

    const schema = z.object({
      toolchain: ToolchainEnum,
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      await cleanupDir(req.file.path);
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { toolchain } = parsed.data;
    let workDir: string | null = null;

    try {
      workDir = await extractArchive(req.file.path, req.file.mimetype);
      const result = await compileSandboxed(workDir, toolchain);

      res.json({
        wasmHash: result.wasmHash,
        logs: result.logs,
        toolchain,
        compiledAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    } finally {
      if (workDir) await cleanupDir(workDir);
      await cleanupDir(req.file.path);
    }
  }),
);

// ── POST /verify ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compiler/verify:
 *   post:
 *     summary: Verify source code matches a deployed contract's WASM hash
 *     tags: [Compiler]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [source, toolchain, expectedHash]
 *             properties:
 *               source:
 *                 type: string
 *                 format: binary
 *               toolchain:
 *                 type: string
 *               expectedHash:
 *                 type: string
 *                 description: Expected SHA-256 of the deployed WASM
 *     responses:
 *       200:
 *         description: Verification result
 *       400:
 *         description: Error
 */
compilerRouter.post(
  '/verify',
  buildQuotaMiddleware,
  upload.single('source'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Source archive is required' });
    }

    const archivePath = req.file.path;

    const schema = z.object({
      toolchain: ToolchainEnum,
      expectedHash: z.string().length(64, 'Expected SHA-256 hash (64 hex chars)'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      await cleanupDir(archivePath);
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { toolchain, expectedHash } = parsed.data;
    let workDir: string | null = null;

    try {
      workDir = await extractArchive(archivePath, req.file.mimetype);
      const [sourceFiles, compileResult] = await Promise.all([
        extractSourceFiles(workDir),
        compileSandboxed(workDir, toolchain),
      ]);

      const matches = compileResult.wasmHash === expectedHash;

      res.json({
        verified: matches,
        compiledHash: compileResult.wasmHash,
        expectedHash,
        toolchain,
        sourceFiles: sourceFiles.length,
        logs: compileResult.logs,
        verifiedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    } finally {
      if (workDir) await cleanupDir(workDir);
      await cleanupDir(archivePath);
    }
  }),
);

// ── GET /toolchains ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compiler/toolchains:
 *   get:
 *     summary: List supported compiler toolchains
 *     tags: [Compiler]
 *     responses:
 *       200:
 *         description: Toolchains list
 */
compilerRouter.get('/toolchains', (_req: Request, res: Response) => {
  res.json({
    toolchains: [
      {
        id: 'soroban-cli@0.9.4',
        name: 'Soroban CLI',
        version: '0.9.4',
        binary: 'soroban',
        command: 'soroban contract build',
      },
      {
        id: 'stellar-cli@21.0.0',
        name: 'Stellar CLI',
        version: '21.0.0',
        binary: 'stellar',
        command: 'stellar contract build',
      },
      {
        id: 'cargo-contract@4.0.0',
        name: 'Cargo Contract',
        version: '4.0.0',
        binary: 'cargo-contract',
        command: 'cargo contract build --release',
      },
    ],
    notes: [
      'All toolchains must be pre-installed in the server environment',
      'Builds run in sandboxed temp directories',
      'Network access disabled during compilation (CARGO_NET_OFFLINE=true)',
    ],
  });
});

// ── GET /metrics ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /compiler/metrics:
 *   get:
 *     summary: Build queue metrics and resource usage
 *     tags: [Compiler]
 *     responses:
 *       200:
 *         description: Build queue metrics by tier
 */
compilerRouter.get('/metrics', (_req: Request, res: Response) => {
  res.json({
    queueMetrics: getQueueMetrics(),
    quotas: {
      developer: { concurrency: 2, memoryMb: 1024, timeoutSec: 120 },
      pro: { concurrency: 5, memoryMb: 2048, timeoutSec: 180 },
      enterprise: { concurrency: 10, memoryMb: 4096, timeoutSec: 240 },
    },
  });
});
