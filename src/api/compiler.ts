import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

const execFileAsync = promisify(execFile);

// Pinned toolchain versions for deterministic builds
const SUPPORTED_TOOLCHAINS: Record<string, string> = {
  'soroban-cli@0.9.4': 'soroban',
  'stellar-cli@21.0.0': 'stellar',
  'cargo-contract@4.0.0': 'cargo-contract',
};

export interface CompileResult {
  wasmHash: string;
  logs: string;
}

/**
 * Extracts a .tar.gz or .zip archive into a temp directory.
 * Returns the path to the extracted directory.
 */
export async function extractArchive(archivePath: string, mimeType: string): Promise<string> {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soroban-verify-'));

  if (
    mimeType === 'application/gzip' ||
    archivePath.endsWith('.tar.gz') ||
    archivePath.endsWith('.tgz')
  ) {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', workDir]);
  } else if (mimeType === 'application/zip' || archivePath.endsWith('.zip')) {
    await execFileAsync('unzip', ['-q', archivePath, '-d', workDir]);
  } else {
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
