import path from 'path';
import { config } from '../config';

export class ExportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportPathError';
  }
}

function getExportDir(): string {
  return process.env.EXPORT_DIR ?? config.exportDir;
}

/**
 * Resolve a relative export filename beneath EXPORT_DIR.
 * Rejects absolute paths, null bytes, and traversal sequences.
 */
export function resolveExportFilePath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new ExportPathError('Invalid export path');
  }

  const segments = relativePath.split(/[/\\]/);
  if (segments.some((segment) => segment === '..')) {
    throw new ExportPathError('Path escapes export directory');
  }

  const base = path.resolve(getExportDir());
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new ExportPathError('Path escapes export directory');
  }

  return resolved;
}
