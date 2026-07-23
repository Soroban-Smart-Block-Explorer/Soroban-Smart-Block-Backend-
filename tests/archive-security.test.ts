/**
 * Tests for #490: Prevent archive extraction traversal and decompression bombs.
 *
 * Builds real malicious ZIP and tar.gz files in a temp directory and verifies
 * that extractArchive rejects them with appropriate error messages.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-sec-test-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a .tar.gz from a staging directory */
function makeTarGz(stageDir: string, outName: string): string {
  const out = path.join(tmpRoot, outName);
  execFileSync('tar', ['-czf', out, '-C', stageDir, '.']);
  return out;
}

/** Build a .zip from a staging directory, preserving symlinks with -y */
function makeZip(stageDir: string, outName: string, extraFlags = ''): string {
  const out = path.join(tmpRoot, outName);
  execSync(`cd "${stageDir}" && zip ${extraFlags} -r "${out}" .`);
  return out;
}

/** Create a fresh unique staging directory under tmpRoot */
function makeStage(name: string): string {
  const dir = path.join(tmpRoot, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── import subject under test ─────────────────────────────────────────────────

async function extract(archivePath: string, mime: string): Promise<string> {
  const { extractArchive } = await import('../src/api/compiler');
  return extractArchive(archivePath, mime);
}

// ── path traversal — tar.gz ───────────────────────────────────────────────────

describe('tar.gz — path traversal rejection', () => {
  it('rejects an entry with .. segments', async () => {
    // Create a tar with a traversal path using --transform
    const out = path.join(tmpRoot, 'traversal.tar.gz');
    const stage = makeStage('traversal-stage');
    fs.writeFileSync(path.join(stage, 'evil.rs'), 'malicious');
    // Use tar --transform to rename to a traversal path
    execFileSync('tar', [
      '-czf',
      out,
      '--transform',
      's|evil.rs|../evil.rs|',
      '-C',
      stage,
      'evil.rs',
    ]);

    await expect(extract(out, 'application/gzip')).rejects.toThrow(/Unsafe archive entry/);
  });

  it('rejects an entry with an absolute path', async () => {
    const out = path.join(tmpRoot, 'absolute.tar.gz');
    const stage = makeStage('absolute-stage');
    fs.writeFileSync(path.join(stage, 'safe.rs'), 'code');
    // Use --transform to add a leading slash
    execFileSync('tar', [
      '-czf',
      out,
      '--transform',
      's|safe.rs|/tmp/safe.rs|',
      '-C',
      stage,
      'safe.rs',
    ]);

    await expect(extract(out, 'application/gzip')).rejects.toThrow(/Unsafe archive entry/);
  });
});

// ── path traversal — zip ─────────────────────────────────────────────────────

describe('zip — path traversal rejection', () => {
  it('rejects a zip entry with .. segments', async () => {
    // python3 can create a zip with arbitrary entry names
    const out = path.join(tmpRoot, 'traversal.zip');
    execSync(
      `python3 -c "
import zipfile, os
with zipfile.ZipFile('${out}', 'w') as z:
    zi = zipfile.ZipInfo('../evil.rs')
    z.writestr(zi, 'malicious')
"`,
    );

    await expect(extract(out, 'application/zip')).rejects.toThrow(/Unsafe archive entry/);
  });

  it('rejects a zip entry with an absolute path', async () => {
    const out = path.join(tmpRoot, 'absolute.zip');
    execSync(
      `python3 -c "
import zipfile
with zipfile.ZipFile('${out}', 'w') as z:
    zi = zipfile.ZipInfo('/tmp/evil.rs')
    z.writestr(zi, 'malicious')
"`,
    );

    await expect(extract(out, 'application/zip')).rejects.toThrow(/Unsafe archive entry/);
  });
});

// ── symlink rejection ─────────────────────────────────────────────────────────

describe('tar.gz — symlink rejection', () => {
  it('rejects an archive containing a symlink', async () => {
    const stage = makeStage('symlink-stage');
    fs.writeFileSync(path.join(stage, 'real.rs'), 'real');
    fs.symlinkSync('/etc/passwd', path.join(stage, 'link.rs'));
    const out = makeTarGz(stage, 'symlink.tar.gz');

    await expect(extract(out, 'application/gzip')).rejects.toThrow(/Symlinks are not allowed/);
  });
});

describe('zip — symlink rejection', () => {
  it('rejects a zip archive containing a symlink entry', async () => {
    // Create a zip with a symlink stored as a symlink (type 0xA)
    const stage = makeStage('symlink-zip-stage');
    fs.writeFileSync(path.join(stage, 'real.rs'), 'real');
    fs.symlinkSync('/etc/passwd', path.join(stage, 'link.rs'));
    const out = makeZip(stage, `symlink-${Date.now()}.zip`, '-y');

    await expect(extract(out, 'application/zip')).rejects.toThrow(/Symlinks are not allowed/);
  });
});

// ── decompression bomb — file count ──────────────────────────────────────────

describe('decompression bomb — file count limit', () => {
  it('rejects a tar.gz with more than 2000 entries', async () => {
    const stage = makeStage('bomb-count-stage');
    // Create 2001 tiny files
    for (let i = 0; i < 2001; i++) {
      fs.writeFileSync(path.join(stage, `f${i}.rs`), 'x');
    }
    const out = makeTarGz(stage, 'bomb-count.tar.gz');

    await expect(extract(out, 'application/gzip')).rejects.toThrow(/limit is 2000/);
  });

  it('rejects a zip with more than 2000 entries', async () => {
    const stage = makeStage('bomb-count-zip-stage');
    for (let i = 0; i < 2001; i++) {
      fs.writeFileSync(path.join(stage, `f${i}.rs`), 'x');
    }
    const out = makeZip(stage, 'bomb-count.zip');

    await expect(extract(out, 'application/zip')).rejects.toThrow(/limit is 2000/);
  });
});

// ── decompression bomb — uncompressed size ───────────────────────────────────

describe('decompression bomb — uncompressed size limit', () => {
  it('rejects a tar.gz whose uncompressed content exceeds 512 MB', async () => {
    const stage = makeStage('bomb-size-stage');
    // Write a single sparse 600 MB file
    const fd = fs.openSync(path.join(stage, 'big.bin'), 'w');
    // Seek to 600 MB - 1 and write one byte to create a sparse file
    fs.writeSync(fd, Buffer.alloc(1), 0, 1, 600 * 1024 * 1024 - 1);
    fs.closeSync(fd);
    const out = makeTarGz(stage, 'bomb-size.tar.gz');

    await expect(extract(out, 'application/gzip')).rejects.toThrow(
      /exceeds maximum uncompressed size/,
    );
  });

  it('rejects a zip whose uncompressed content exceeds 512 MB', async () => {
    const stage = makeStage('bomb-size-zip-stage');
    const fd = fs.openSync(path.join(stage, 'big.bin'), 'w');
    fs.writeSync(fd, Buffer.alloc(1), 0, 1, 600 * 1024 * 1024 - 1);
    fs.closeSync(fd);
    const out = makeZip(stage, 'bomb-size.zip');

    await expect(extract(out, 'application/zip')).rejects.toThrow(
      /exceeds maximum uncompressed size/,
    );
  });
});

// ── happy path ────────────────────────────────────────────────────────────────

describe('happy path — valid archives pass through', () => {
  it('accepts a clean tar.gz with a Cargo project', async () => {
    const { cleanupDir } = await import('../src/api/compiler');
    const stage = makeStage('happy-tar-stage');
    fs.writeFileSync(path.join(stage, 'Cargo.toml'), '[package]\nname = "test"');
    fs.mkdirSync(path.join(stage, 'src'));
    fs.writeFileSync(path.join(stage, 'src', 'lib.rs'), '#![no_std]');
    const out = makeTarGz(stage, 'clean.tar.gz');

    const workDir = await extract(out, 'application/gzip');
    expect(fs.existsSync(workDir)).toBe(true);
    await cleanupDir(workDir);
  });

  it('accepts a clean zip with a Cargo project', async () => {
    const { cleanupDir } = await import('../src/api/compiler');
    const stage = makeStage('happy-zip-stage');
    fs.writeFileSync(path.join(stage, 'Cargo.toml'), '[package]\nname = "test"');
    fs.mkdirSync(path.join(stage, 'src'));
    fs.writeFileSync(path.join(stage, 'src', 'lib.rs'), '#![no_std]');
    const out = makeZip(stage, 'clean.zip');

    const workDir = await extract(out, 'application/zip');
    expect(fs.existsSync(workDir)).toBe(true);
    await cleanupDir(workDir);
  });
});
