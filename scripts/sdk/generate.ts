/**
 * SDK generator (DX01, DX02).
 *
 * Source of truth: the OpenAPI document built by src/indexer/swaggerSpec.ts
 * (the same object served at /api/v1/openapi.json). Everything below is a
 * pure function of that document:
 *
 *   packages/client/src/generated/models.ts        TypeScript models
 *   packages/client/src/generated/operations.ts    TypeScript operation map
 *   packages/client/api-surface.json               surface manifest (semver checks)
 *   docs/sdk/parity-matrix.md                      route parity matrix
 *   + any emitters registered in EMITTERS
 *
 * Usage:
 *   npm run sdk:generate            write files
 *   npm run sdk:generate -- --check exit 1 if any file would change (CI drift gate)
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { normalizeOperations, type OpenApiDocument } from '../../src/lib/openapi/normalize';
import { emitModels, emitOperations } from './emit-typescript';
import { buildSurface } from './surface';
import { emitParityMatrix } from './parity';
import { EXTRA_EMITTERS } from './emitters';

const ROOT = path.join(__dirname, '..', '..');

export interface GeneratedFile {
  path: string;
  content: string;
}

export function generateAll(doc: OpenApiDocument): GeneratedFile[] {
  const ops = normalizeOperations(doc);
  const specVersion = doc.info?.version ?? '0.0.0';
  const surface = buildSurface(specVersion, ops);
  const surfaceJson = `${JSON.stringify(surface, null, 2)}\n`;
  const fingerprint = createHash('sha256').update(surfaceJson).digest('hex').slice(0, 16);
  const files: GeneratedFile[] = [
    { path: 'packages/client/src/generated/models.ts', content: emitModels(doc) },
    {
      path: 'packages/client/src/generated/operations.ts',
      content: emitOperations(doc, ops, fingerprint),
    },
    { path: 'packages/client/api-surface.json', content: surfaceJson },
  ];
  for (const emitter of EXTRA_EMITTERS) files.push(...emitter({ doc, ops, fingerprint }));
  files.push({ path: 'docs/sdk/parity-matrix.md', content: emitParityMatrix(ops, files) });
  return files;
}

function main(): void {
  const check = process.argv.includes('--check');
  // Imported lazily so unit tests can call generateAll() with fixtures.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { swaggerSpec } = require('../../src/indexer/swaggerSpec') as {
    swaggerSpec: OpenApiDocument;
  };
  const files = generateAll(swaggerSpec);
  const drift: string[] = [];
  for (const file of files) {
    const abs = path.join(ROOT, file.path);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current === file.content) continue;
    if (check) {
      drift.push(file.path);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.content);
      process.stdout.write(`wrote ${file.path}\n`);
    }
  }
  if (check) {
    if (drift.length > 0) {
      process.stderr.write(
        `SDK drift: generated files are out of date with the OpenAPI spec:\n  - ${drift.join('\n  - ')}\nRun \`npm run sdk:generate\` and commit the result.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`SDK up to date (${files.length} generated files)\n`);
  }
}

if (require.main === module) main();
