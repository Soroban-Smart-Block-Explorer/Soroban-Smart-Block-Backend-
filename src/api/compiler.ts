import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// Pinned toolchain versions for deterministic builds
export const SUPPORTED_TOOLCHAINS: Record<string, string> = {
  'soroban-cli@0.9.4': 'soroban',
  'stellar-cli@21.0.0': 'stellar',
  'cargo-contract@4.0.0': 'cargo-contract',
};

// Shared Zod enum for toolchain validation - rejects unknown identifiers
export const ToolchainEnum = z.enum(Object.keys(SUPPORTED_TOOLCHAINS) as [string, ...string[]], {
  required_error: 'toolchain field is required',
  invalid_type_error: 'Invalid toolchain identifier',
});

export interface CompileResult {
  wasmHash: string;
  logs: string;
}

// ── archive security limits ───────────────────────────────────────────────────
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MB
const MAX_FILE_COUNT = 2_000;

/**
 * Validates an archive entry path: rejects absolute paths, path traversal
 * sequences (../) and null bytes.
 */
function assertSafePath(entryPath: string): void {
  if (
    path.isAbsolute(entryPath) ||
    entryPath.split('/').some((part) => part === '..') ||
    entryPath.includes('\0')
  ) {
    throw new Error(`Unsafe archive entry rejected: ${entryPath}`);
  }
}

/**
 * Extracts a .tar.gz or .zip archive into a temp directory.
 * Rejects path traversal, symlinks, and decompression bombs.
 * Returns the path to the extracted directory.
 */
export async function extractArchive(archivePath: string, mimeType: string): Promise<string> {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soroban-verify-'));

  if (
    mimeType === 'application/gzip' ||
    archivePath.endsWith('.tar.gz') ||
    archivePath.endsWith('.tgz')
  ) {
    await extractTarGz(archivePath, workDir);
  } else if (mimeType === 'application/zip' || archivePath.endsWith('.zip')) {
    await extractZip(archivePath, workDir);
  } else {
    await cleanupDir(workDir);
    throw new Error(`Unsupported archive format. Use .tar.gz or .zip`);
  }

  // If the archive contains a single top-level directory, descend into it
  const entries = await fs.promises.readdir(workDir);
  if (entries.length === 1) {
    const single = path.join(workDir, entries[0]);
    const stat = await fs.promises.stat(single);
    if (stat.isDirectory()) return single;
  }

  return workDir;
}

/**
 * Safely extracts a .tar.gz archive using a two-pass approach:
 * 1. List all entries and validate paths + count + symlinks
 * 2. Extract only if all checks pass, then verify uncompressed sizes
 */
async function extractTarGz(archivePath: string, workDir: string): Promise<void> {
  // Pass 1: list entries (tar -tzf outputs one path per line)
  const { stdout: listing } = await execFileAsync('tar', ['-tzf', archivePath]);
  const entries = listing.split('\n').filter(Boolean);

  if (entries.length > MAX_FILE_COUNT) {
    throw new Error(`Archive contains ${entries.length} entries, limit is ${MAX_FILE_COUNT}`);
  }

  for (const entry of entries) {
    assertSafePath(entry);
  }

  // Pass 2: extract
  await execFileAsync('tar', ['-xzf', archivePath, '-C', workDir]);

  // Pass 3: check for symlinks and measure total uncompressed size
  await walkAndValidate(workDir);
}

/**
 * Safely extracts a .zip archive:
 * 1. List entries with `unzip -l` and validate paths + count
 * 2. Extract and verify no symlinks + size limits
 */
async function extractZip(archivePath: string, workDir: string): Promise<void> {
  // Pass 1: list entries (unzip -Z1 prints one name per line)
  const { stdout: listing } = await execFileAsync('unzip', ['-Z1', archivePath]);
  const entries = listing.split('\n').filter(Boolean);

  if (entries.length > MAX_FILE_COUNT) {
    throw new Error(`Archive contains ${entries.length} entries, limit is ${MAX_FILE_COUNT}`);
  }

  for (const entry of entries) {
    assertSafePath(entry);
  }

  // Pass 2: extract
  await execFileAsync('unzip', ['-q', archivePath, '-d', workDir]);

  // Pass 3: check for symlinks and measure total uncompressed size
  await walkAndValidate(workDir);
}

/**
 * Walks extracted directory tree, rejecting symlinks and enforcing
 * the total-bytes decompression bomb limit.
 */
async function walkAndValidate(dir: string, state = { bytes: 0 }): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in uploaded archives (${entry.name})`);
    }
    if (entry.isDirectory()) {
      await walkAndValidate(full, state);
    } else if (entry.isFile()) {
      const { size } = await fs.promises.stat(full);
      state.bytes += size;
      if (state.bytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error(
          `Archive exceeds maximum uncompressed size of ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB`,
        );
      }
    }
  }
}

/**
 * Runs a sandboxed soroban/stellar/cargo-contract build inside the project directory.
 * Uses a pinned toolchain version for deterministic output.
 */
export async function compileSandboxed(
  projectDir: string,
  toolchain: string,
): Promise<CompileResult> {
  const bin = SUPPORTED_TOOLCHAINS[toolchain];
  if (!bin) {
    throw new Error(
      `Unsupported toolchain "${toolchain}". Supported: ${Object.keys(SUPPORTED_TOOLCHAINS).join(', ')}`,
    );
  }

  // Validate Cargo.toml exists to prevent arbitrary directory traversal
  const cargoToml = path.join(projectDir, 'Cargo.toml');
  if (!fs.existsSync(cargoToml)) {
    throw new Error('No Cargo.toml found in uploaded project root');
  }

  // Resolve absolute path to prevent path traversal
  const safeDir = path.resolve(projectDir);
  if (!safeDir.startsWith(os.tmpdir())) {
    throw new Error('Project directory must be inside system temp directory');
  }

  let stdout = '';
  let stderr = '';

  try {
    if (bin === 'cargo-contract') {
      const result = await execFileAsync('cargo', ['contract', 'build', '--release'], {
        cwd: safeDir,
        timeout: 300_000,
        env: buildEnv(),
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } else {
      // soroban / stellar CLI
      const result = await execFileAsync(bin, ['contract', 'build'], {
        cwd: safeDir,
        timeout: 300_000,
        env: buildEnv(),
      });
      stdout = result.stdout;
      stderr = result.stderr;
    }
  } catch (err: any) {
    throw new Error(`Compilation failed:\n${err.stderr ?? err.message}`);
  }

  const wasmPath = findWasm(safeDir);
  if (!wasmPath) {
    throw new Error('Compilation succeeded but no .wasm output found');
  }

  const wasmBytes = await fs.promises.readFile(wasmPath);
  const wasmHash = crypto.createHash('sha256').update(wasmBytes).digest('hex');

  return { wasmHash, logs: [stdout, stderr].filter(Boolean).join('\n') };
}

/**
 * Hashes an arbitrary file with SHA-256.
 */
export function hashFile(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Recursively collects .rs source files from a project directory.
 * Returns at most 50 files, each capped at 64 KB.
 */
export async function extractSourceFiles(projectDir: string): Promise<SourceFile[]> {
  const results: SourceFile[] = [];
  const MAX_FILES = 50;
  const MAX_BYTES = 64 * 1024;

  async function walk(dir: string, base: string): Promise<void> {
    if (results.length >= MAX_FILES) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'target' || entry.name === '.git') continue;
        await walk(full, rel);
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        const stat = await fs.promises.stat(full);
        const size = Math.min(stat.size, MAX_BYTES);
        const buf = Buffer.alloc(size);
        const fd = await fs.promises.open(full, 'r');
        await fd.read(buf, 0, size, 0);
        await fd.close();
        results.push({ path: rel, content: buf.toString('utf8') });
      }
    }
  }

  await walk(projectDir, '');
  return results;
}

/**
 * Cleans up a temp directory, ignoring errors.
 */
export async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Disable network access during build for sandboxing
    CARGO_NET_OFFLINE: 'true',
    // Deterministic builds
    SOURCE_DATE_EPOCH: '0',
    RUSTFLAGS: '--remap-path-prefix=/=/',
  };
}

function findWasm(dir: string): string | null {
  // Look in standard cargo output locations
  const candidates = [
    path.join(dir, 'target', 'wasm32-unknown-unknown', 'release'),
    path.join(dir, 'target', 'wasm32v1-none', 'release'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const files = fs
      .readdirSync(candidate)
      .filter((f) => f.endsWith('.wasm') && !f.includes('.d.'));
    if (files.length > 0) return path.join(candidate, files[0]);
  }

  return null;
}
