/**
 * Script to add @map() and @@map() annotations to Prisma schema models
 * that don't already use snake_case mapping convention.
 *
 * Usage: npx tsx scripts/add-prisma-maps.ts
 */

import * as fs from 'fs';

const SCHEMA_PATH = 'prisma/schema.prisma';

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function pluralize(name: string): string {
  if (name.endsWith('s')) return name;
  if (name.endsWith('y')) return name.slice(0, -1) + 'ies';
  if (name.endsWith('ch') || name.endsWith('sh') || name.endsWith('x') || name.endsWith('ss'))
    return name + 'es';
  return name + 's';
}

// Known Prisma scalar types
const SCALARS = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Decimal', 'BigInt',
]);

function isScalarType(type: string): boolean {
  // Strip array brackets before checking
  const base = type.replace(/\[\]$/, '');
  return SCALARS.has(base);
}

const content = fs.readFileSync(SCHEMA_PATH, 'utf-8');
const lines = content.split('\n');
const output: string[] = [];

let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const modelMatch = line.match(/^model\s+(\w+)\s*\{/);

  if (!modelMatch) {
    output.push(line);
    i++;
    continue;
  }

  const modelName = modelMatch[1];
  const modelLines: string[] = [line];
  let depth = 1;
  i++;
  while (i < lines.length && depth > 0) {
    const l = lines[i];
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    modelLines.push(l);
    i++;
  }

  const block = modelLines.join('\n');
  const hasTableMap = block.includes('@@map(');

  if (hasTableMap) {
    // Already mapped, output as-is
    output.push(...modelLines);
    continue;
  }

  // Process model: add @map to scalar fields, add @@map at end
  const tableSnake = pluralize(camelToSnake(modelName));
  const processed: string[] = [];

  for (let j = 0; j < modelLines.length; j++) {
    const ml = modelLines[j];
    const trimmed = ml.trim();

    // Last line (closing brace) - add @@map before it
    if (j === modelLines.length - 1 && trimmed === '}') {
      const contentIndent =
        modelLines
          .slice(1, -1)
          .find(
            (l) =>
              l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('///'),
          )
          ?.match(/^(\s*)/)?.[1] ?? '  ';
      processed.push(`${contentIndent}@@map("${tableSnake}")`);
      processed.push(ml);
      continue;
    }

    // Skip lines that already have @map
    if (trimmed.includes('@map(')) {
      processed.push(ml);
      continue;
    }

    // Match field declaration: indent, fieldName, Type[optional []], optional ?, rest
    const fieldMatch = ml.match(/^(\s+)(\w+)\s+(\w+(?:\[\])?)(\s*\??\s*)(.*)$/);
    if (!fieldMatch) {
      processed.push(ml);
      continue;
    }

    const [, indent, fieldName, fieldType, optSpace, rest] = fieldMatch;
    const restTrimmed = rest.trim();

    // Skip relation fields (those with @relation)
    if (restTrimmed.includes('@relation(')) {
      processed.push(ml);
      continue;
    }

    // Skip fields whose type is NOT a scalar (model references, enums, etc.)
    if (!isScalarType(fieldType)) {
      processed.push(ml);
      continue;
    }

    const snake = camelToSnake(fieldName);
    const optionalMark = optSpace.includes('?') ? '?' : '';
    const mapDirective = `@map("${snake}")`;

    if (restTrimmed) {
      processed.push(
        `${indent}${fieldName} ${fieldType}${optionalMark ? '?' : ''} ${mapDirective} ${restTrimmed}`,
      );
    } else {
      processed.push(
        `${indent}${fieldName} ${fieldType}${optionalMark ? '?' : ''} ${mapDirective}`,
      );
    }
  }

  output.push(...processed);
}

fs.writeFileSync(SCHEMA_PATH, output.join('\n'), 'utf-8');
console.log('Schema updated successfully!');
