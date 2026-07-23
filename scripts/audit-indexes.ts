/**
 * scripts/audit-indexes.ts — reports FK fields missing a @@index or @unique.
 * Usage: npx ts-node scripts/audit-indexes.ts
 * Exit 1 when missing indexes are found (usable as a CI gate).
 */
import * as fs from 'fs';
import * as path from 'path';

const schema = fs.readFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf8');

const results: { model: string; missing: string[] }[] = [];
const modelRegex = /^model\s+(\w+)\s*\{([^}]+)\}/gm;
let m: RegExpExecArray | null;

while ((m = modelRegex.exec(schema)) !== null) {
  const [, modelName, body] = m;

  const fkFields = [...body.matchAll(/^\s+(\w+Id)\s+String/gm)]
    .map((x) => x[1])
    .filter((f) => !new RegExp(`${f}\\s+.*@id`).test(body));

  if (!fkFields.length) continue;

  const indexed = new Set<string>();
  for (const x of body.matchAll(/@@(?:index|unique)\(\[([^\]]+)\]/g))
    (x[1].match(/\w+/g) ?? []).forEach((f) => indexed.add(f));
  for (const x of body.matchAll(/^\s+(\w+)\s+.*@unique/gm)) indexed.add(x[1]);

  const missing = fkFields.filter((f) => !indexed.has(f));
  if (missing.length) results.push({ model: modelName, missing });
}

if (!results.length) {
  console.log('✅  All FK fields have indexes.');
  process.exit(0);
}

console.error(`⚠️  ${results.length} model(s) with un-indexed FK fields:\n`);
for (const { model, missing } of results) {
  for (const f of missing) console.error(`  ${model}.${f}  →  add @@index([${f}])`);
}
process.exit(1);
