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
import { z } from 'zod';
import { extractArchive, compileSandboxed, extractSourceFiles, cleanupDir } from './compiler';

export const compilerRouter = Router();

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
  upload.single('source'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'Source archive is required (multipart field: source)' });
    }

    const toolchain = req.body.toolchain as string;
    if (!toolchain) {
      return res.status(400).json({ error: 'toolchain field is required' });
    }

    const archivePath = req.file.path;
    let workDir: string | null = null;

    try {
      workDir = await extractArchive(archivePath, req.file.mimetype);
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
      await cleanupDir(archivePath);
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
  upload.single('source'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Source archive is required' });
    }

    const schema = z.object({
      toolchain: z.string().min(1),
      expectedHash: z.string().length(64, 'Expected SHA-256 hash (64 hex chars)'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { toolchain, expectedHash } = parsed.data;
    const archivePath = req.file.path;
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
