import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveExportFilePath, ExportPathError } from '../../src/exports/resolve-path';

describe('resolveExportFilePath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-path-test-'));
    process.env.EXPORT_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.EXPORT_DIR;
  });

  it('resolves a relative filename beneath EXPORT_DIR', () => {
    const resolved = resolveExportFilePath('transactions-job-1.csv');
    expect(resolved).toBe(path.join(tmpDir, 'transactions-job-1.csv'));
  });

  it('rejects absolute paths', () => {
    expect(() => resolveExportFilePath('/etc/passwd')).toThrow(ExportPathError);
  });

  it('rejects traversal sequences', () => {
    expect(() => resolveExportFilePath('../../../etc/passwd')).toThrow(ExportPathError);
    expect(() => resolveExportFilePath('subdir/../../outside.csv')).toThrow(ExportPathError);
  });

  it('rejects empty paths', () => {
    expect(() => resolveExportFilePath('')).toThrow(ExportPathError);
  });
});
