#!/usr/bin/env ts-node
// @ts-check
/**
 * scripts/validate-prisma-references.ts
 *
 * Phase 2 — Schema-to-Code Validator
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses prisma/schema.prisma, extracts every model + its scalar fields, then
 * scans all src/**\/*.ts files for Prisma field property accesses and flags any
 * field that does not exist on the corresponding Prisma model.
 *
 * Phase 3 — Migration Impact Analysis
 * ─────────────────────────────────────────────────────────────────────────────
 * When invoked with --diff <old-schema-file> it compares the two schemas and
 * reports removed / renamed / type-changed fields with all source locations.
 *
 * Usage:
 *   npx ts-node -P tsconfig.scripts.json scripts/validate-prisma-references.ts
 *   npx ts-node -P tsconfig.scripts.json scripts/validate-prisma-references.ts --diff prisma/schema.old.prisma
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelField {
  name: string;
  typeName: string;
  isOptional: boolean;
  isArray: boolean;
}

interface PrismaModel {
  name: string;
  fields: ModelField[];
}

interface Ref {
  file: string;
  line: number;
  column: number;
  snippet: string;
  modelName: string;
  fieldName: string;
}

interface ValidationResult {
  phantoms: Ref[];
  validCount: number;
}

interface DiffReport {
  removed: Array<{ model: string; field: string; refs: Ref[] }>;
  renameCandidates: Array<{ model: string; oldField: string; likelyNewField: string }>;
  typeChanged: Array<{ model: string; field: string; oldType: string; newType: string }>;
}

// ─── Built-in JS / Prisma-client names to skip ──────────────────────────────

const BUILTIN_SKIP = new Set([
  // Array properties & methods
  'length',
  'map',
  'filter',
  'reduce',
  'find',
  'some',
  'every',
  'forEach',
  'slice',
  'reverse',
  'flatMap',
  'push',
  'pop',
  'shift',
  'unshift',
  'concat',
  'join',
  'includes',
  'indexOf',
  'lastIndexOf',
  'sort',
  'splice',
  'flat',
  'reduceRight',
  'keys',
  'values',
  'entries',
  'fill',
  'at',
  'findIndex',
  // Set / Map
  'add',
  'delete',
  'has',
  'clear',
  'size',
  'get',
  'set',
  // Object / prototype
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'toJSON',
  // Promise
  'then',
  'catch',
  'finally',
  // Prisma client query methods (appear on model accessors)
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

// ─── Schema parser ───────────────────────────────────────────────────────────

export function parsePrismaSchema(schemaPath: string): Map<string, PrismaModel> {
  const content = fs.readFileSync(schemaPath, 'utf-8');
  const models = new Map<string, PrismaModel>();

  // Each model block: model <Name> { ... }
  // Use a manual scan to handle multi-line blocks robustly
  let i = 0;
  while (i < content.length) {
    const modelKw = content.indexOf('model ', i);
    if (modelKw === -1) break;

    // Make sure 'model' is at start of line (not inside a string)
    const lineStart = content.lastIndexOf('\n', modelKw);
    const prefix = content.slice(lineStart + 1, modelKw).trim();
    if (prefix !== '' && !prefix.startsWith('//')) {
      i = modelKw + 6;
      continue;
    }

    const braceOpen = content.indexOf('{', modelKw);
    if (braceOpen === -1) break;

    const modelName = content.slice(modelKw + 6, braceOpen).trim();
    if (!modelName || !/^\w+$/.test(modelName)) {
      i = braceOpen + 1;
      continue;
    }

    // Find matching closing brace
    let depth = 1;
    let j = braceOpen + 1;
    while (j < content.length && depth > 0) {
      if (content[j] === '{') depth++;
      else if (content[j] === '}') depth--;
      j++;
    }

    const body = content.slice(braceOpen + 1, j - 1);
    const fields: ModelField[] = [];

    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;

      // Field: <fieldName> <Type>[?|[]] [modifiers...]
      const fieldMatch = line.match(/^(\w+)\s+([\w.]+)(\[\])?(\?)?/);
      if (!fieldMatch) continue;

      const name = fieldMatch[1];
      const typeName = fieldMatch[2];
      const isArray = Boolean(fieldMatch[3]);
      const isOptional = Boolean(fieldMatch[4]);

      // Skip Prisma relation keywords used as field names
      if (['@@', '//'].some((p) => name.startsWith(p))) continue;

      fields.push({ name, typeName, isOptional, isArray });
    }

    models.set(modelName, { name: modelName, fields });
    i = j;
  }

  return models;
}

// ─── Source scanner ───────────────────────────────────────────────────────────

/**
 * Heuristically map local variable names to Prisma model names by inspecting
 * `prisma.<model>.findMany/findFirst/...` call sites and `.map((varName) =>`.
 */
function inferVarModelMap(content: string): Map<string, string> {
  const map = new Map<string, string>();

  // prisma.transaction.findMany(...) → variable assigned on the left
  const callRe =
    /prisma\.(\w+)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|create|update|upsert|delete)\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = callRe.exec(content)) !== null) {
    const modelRaw = m[1];
    const modelName = modelRaw.charAt(0).toUpperCase() + modelRaw.slice(1);
    const before = content.slice(Math.max(0, m.index - 400), m.index);

    // const rows = await prisma.model...
    const simple = before.match(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?$/);
    if (simple) map.set(simple[1], modelName);

    // const [rows, total] = await Promise.all([...
    const destruct = before.match(
      /(?:const|let)\s+\[([^\]]+)\]\s*=\s*await\s+Promise\.all\s*\(\s*\[$/,
    );
    if (destruct) {
      const vars = destruct[1].split(',').map((v) => v.trim());
      if (vars[0]) map.set(vars[0], modelName);
    }
  }

  return map;
}

function posToLineCol(content: string, index: number): { line: number; col: number } {
  const before = content.slice(0, index);
  const line = (before.match(/\n/g) || []).length + 1;
  const lastNl = before.lastIndexOf('\n');
  return { line, col: index - lastNl };
}

function scanFile(
  filePath: string,
  models: Map<string, PrismaModel>,
): { phantoms: Ref[]; valid: number } {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const phantoms: Ref[] = [];
  let valid = 0;

  const varMap = inferVarModelMap(content);

  for (const [varName, modelName] of varMap) {
    const model = models.get(modelName);
    if (!model) continue;

    // Match <varName>.<identifier> with word boundaries to prevent partial matching
    const re = new RegExp(`\\b${varName}\\.(\\w+)\\b`, 'g');
    let m: RegExpExecArray | null;

    while ((m = re.exec(content)) !== null) {
      const fieldName = m[1];
      // Skip built-in JS/TS properties, methods, and Prisma client methods
      if (BUILTIN_SKIP.has(fieldName)) continue;
      // Skip method calls (identifier followed by open paren)
      const afterMatch = content.slice(m.index + m[0].length);
      if (/^\s*\(/.test(afterMatch)) continue;

      const { line, col } = posToLineCol(content, m.index);
      const snippet = (lines[line - 1] || '').trim();
      const exists = model.fields.some((f) => f.name === fieldName);

      if (exists) {
        valid++;
      } else {
        phantoms.push({ file: filePath, line, column: col, snippet, modelName, fieldName });
      }
    }
  }

  return { phantoms, valid };
}

function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTs(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ─── Phase 2: Validator ───────────────────────────────────────────────────────

export function runValidator(schemaPath: string, srcDir: string): ValidationResult {
  const models = parsePrismaSchema(schemaPath);
  console.log(
    `📋  Parsed ${models.size} Prisma models from ${path.relative(process.cwd(), schemaPath)}`,
  );

  const files = collectTs(srcDir);
  console.log(
    `🔍  Scanning ${files.length} TypeScript files in ${path.relative(process.cwd(), srcDir)}/\n`,
  );

  const phantoms: Ref[] = [];
  let validCount = 0;

  for (const file of files) {
    const r = scanFile(file, models);
    phantoms.push(...r.phantoms);
    validCount += r.valid;
  }

  return { phantoms, validCount };
}

// ─── Phase 3: Migration impact analysis ──────────────────────────────────────

export function runDiffAnalysis(
  newSchemaPath: string,
  oldSchemaPath: string,
  srcDir: string,
): DiffReport {
  const newModels = parsePrismaSchema(newSchemaPath);
  const oldModels = parsePrismaSchema(oldSchemaPath);
  const files = collectTs(srcDir);

  const removed: DiffReport['removed'] = [];
  const renameCandidates: DiffReport['renameCandidates'] = [];
  const typeChanged: DiffReport['typeChanged'] = [];

  for (const [modelName, oldModel] of oldModels) {
    const newModel = newModels.get(modelName);

    for (const oldField of oldModel.fields) {
      const newField = newModel?.fields.find((f) => f.name === oldField.name);

      if (!newField) {
        // Field removed — find every reference across src/
        const refs: Ref[] = [];
        const pattern = new RegExp(`\\.${oldField.name}\\b`, 'g');

        for (const file of files) {
          const content = fs.readFileSync(file, 'utf-8');
          const lines = content.split('\n');
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(content)) !== null) {
            const { line, col } = posToLineCol(content, m.index);
            refs.push({
              file,
              line,
              column: col,
              snippet: (lines[line - 1] || '').trim(),
              modelName,
              fieldName: oldField.name,
            });
          }
        }

        if (refs.length > 0) removed.push({ model: modelName, field: oldField.name, refs });

        // Rename candidate: similar name in new model
        if (newModel) {
          for (const nf of newModel.fields) {
            const ol = oldField.name.toLowerCase();
            const nl = nf.name.toLowerCase();
            if (
              nf.name !== oldField.name &&
              (nl.includes(ol.slice(0, 5)) || ol.includes(nl.slice(0, 5)))
            ) {
              renameCandidates.push({
                model: modelName,
                oldField: oldField.name,
                likelyNewField: nf.name,
              });
            }
          }
        }
      } else if (newField.typeName !== oldField.typeName) {
        typeChanged.push({
          model: modelName,
          field: oldField.name,
          oldType: oldField.typeName,
          newType: newField.typeName,
        });
      }
    }
  }

  return { removed, renameCandidates, typeChanged };
}

// ─── Output formatters ────────────────────────────────────────────────────────

function printValidationResult(result: ValidationResult): void {
  const { phantoms, validCount } = result;
  console.log(`✅  Valid field references found  : ${validCount}`);

  if (phantoms.length === 0) {
    console.log('✅  No phantom Prisma field references detected.\n');
    process.exit(0);
  }

  console.error(`\n❌  ${phantoms.length} phantom field reference(s) detected:\n`);
  for (const r of phantoms) {
    const rel = path.relative(process.cwd(), r.file);
    console.error(`  ${rel}:${r.line}:${r.column}`);
    console.error(`    model  → ${r.modelName}`);
    console.error(`    field  → ${r.fieldName}  (not in schema)`);
    console.error(`    source → ${r.snippet}\n`);
  }
  process.exit(1);
}

function printDiffReport(report: DiffReport): void {
  let issues = 0;

  if (report.removed.length) {
    console.error('\n🗑️   REMOVED fields still referenced in src/:');
    for (const { model, field, refs } of report.removed) {
      console.error(`\n  ${model}.${field}`);
      for (const r of refs) {
        console.error(`    ${path.relative(process.cwd(), r.file)}:${r.line}  →  ${r.snippet}`);
        issues++;
      }
    }
  }

  if (report.renameCandidates.length) {
    console.warn('\n🔄  Possible renames (manual review):');
    for (const { model, oldField, likelyNewField } of report.renameCandidates) {
      console.warn(`  ${model}.${oldField}  →  possibly  ${model}.${likelyNewField}`);
    }
  }

  if (report.typeChanged.length) {
    console.warn('\n⚠️   Type-changed fields:');
    for (const { model, field, oldType, newType } of report.typeChanged) {
      console.warn(`  ${model}.${field}  :  ${oldType}  →  ${newType}`);
    }
  }

  if (issues === 0) {
    console.log('\n✅  Migration impact analysis: no breaking references found.\n');
  } else {
    console.error(`\n❌  Migration impact analysis: ${issues} potential break(s) found.\n`);
    process.exit(1);
  }
}

// ─── CLI entry (only when run directly) ──────────────────────────────────────

if (require.main === module) {
  const ROOT = path.resolve(__dirname, '..');
  const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
  const SRC = path.join(ROOT, 'src');

  const args = process.argv.slice(2);
  const diffIdx = args.indexOf('--diff');

  if (diffIdx !== -1) {
    const oldSchema = args[diffIdx + 1];
    if (!oldSchema || !fs.existsSync(oldSchema)) {
      console.error('Usage: validate-prisma-references.ts --diff <old-schema.prisma>');
      process.exit(1);
    }
    console.log(`\n🔎  Migration impact analysis\n    old: ${oldSchema}\n    new: ${SCHEMA}\n`);
    printDiffReport(runDiffAnalysis(SCHEMA, oldSchema, SRC));
  } else {
    console.log('\n🔎  Prisma field reference validator\n');
    printValidationResult(runValidator(SCHEMA, SRC));
  }
}
