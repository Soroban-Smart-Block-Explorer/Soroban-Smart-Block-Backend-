#!/usr/bin/env ts-node
/**
 * JSDoc Documentation Generator for API Route Handlers
 *
 * This script scans route handler files and generates JSDoc templates
 * for undocumented routes based on their implementation patterns.
 *
 * Usage:
 *   npx ts-node scripts/generate-jsdoc.ts [file-pattern]
 *   npx ts-node scripts/generate-jsdoc.ts src/api/dex.ts
 *   npx ts-node scripts/generate-jsdoc.ts src/api/*.ts
 */

import * as fs from 'fs';
import * as glob from 'glob';

interface RouteHandler {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  hasJSDoc: boolean;
  parameters: string[];
  queryParams: string[];
  bodyParam?: string;
  lineNumber: number;
}

/**
 * Extract route handlers from a TypeScript file
 */
function extractRouteHandlers(content: string, filePath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  const lines = content.split('\n');

  // Pattern to match route definitions like: router.get('/path/:id', ...)
  const routePattern = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]\s*,/gi;
  let match;

  while ((match = routePattern.exec(content)) !== null) {
    const method = match[1].toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    const routePath = match[2];
    const matchIndex = match.index;

    // Find line number
    const precedingText = content.substring(0, matchIndex);
    const lineNumber = precedingText.split('\n').length;

    // Check if there's JSDoc above this route (look back max 10 lines)
    let hasJSDoc = false;
    for (let i = Math.max(0, lineNumber - 15); i < lineNumber; i++) {
      if (lines[i] && lines[i].includes('/**') && lines[i].includes('@route')) {
        hasJSDoc = true;
        break;
      }
    }

    // Extract path parameters (e.g., :id, :address)
    const paramPattern = /:(\w+)/g;
    const parameters: string[] = [];
    let paramMatch;
    while ((paramMatch = paramPattern.exec(routePath)) !== null) {
      parameters.push(paramMatch[1]);
    }

    // Extract query params from schema definitions nearby
    const queryParams: string[] = [];
    const contextStart = Math.max(0, matchIndex - 500);
    const contextEnd = Math.min(content.length, matchIndex + 500);
    const context = content.substring(contextStart, contextEnd);

    const queryPattern = /(?:queryParam|query).*?(\w+).*?z\.(string|number|boolean)/gi;
    let queryMatch;
    while ((queryMatch = queryPattern.exec(context)) !== null) {
      queryParams.push(queryMatch[1]);
    }

    handlers.push({
      method,
      path: routePath,
      hasJSDoc,
      parameters,
      queryParams: [...new Set(queryParams)],
      lineNumber,
    });
  }

  return handlers;
}

/**
 * Generate JSDoc template for a route handler
 */
function generateJSDocTemplate(handler: RouteHandler, methodPath: string): string {
  const pathParams = handler.parameters
    .map((p) => ` * @param {string} ${p} - [Add description for ${p} parameter]`)
    .join('\n');

  const queryParams = handler.queryParams
    .map((q) => ` * @queryparam {type} [${q}] - [Add description for ${q} parameter]`)
    .join('\n');

  const template = `/**
 * [Add route description here]
 *
 * @route {${handler.method}} ${methodPath}
${pathParams ? `${pathParams}\n` : ''}${queryParams ? `${queryParams}\n` : ''} * @returns {object} 200 - Success
 * @returns {object} 400 - Bad request
 * @returns {object} 404 - Not found
 * @returns {object} 500 - Internal server error
 * @example
 * // Request
 * ${handler.method} ${methodPath}
 *
 * // Response (200)
 * { }
 */`;

  return template;
}

/**
 * Analyze a file and report documentation status
 */
function analyzeFile(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const handlers = extractRouteHandlers(content, filePath);

  if (handlers.length === 0) {
    console.log(`\n✓ ${filePath} - No route handlers found`);
    return;
  }

  console.log(`\n📄 ${filePath}`);
  console.log(`   Total handlers: ${handlers.length}`);

  const documented = handlers.filter((h) => h.hasJSDoc).length;
  const undocumented = handlers.length - documented;

  console.log(`   Documented: ${documented}/${handlers.length}`);

  if (undocumented > 0) {
    console.log(`   ⚠️  Missing JSDoc: ${undocumented} handlers\n`);

    handlers.forEach((handler) => {
      if (!handler.hasJSDoc) {
        const baseRoute = handler.path.replace(/:[a-z0-9_]+/gi, ':param');
        const fullPath = `/api/v1${handler.path}`;

        console.log(`\n   Line ${handler.lineNumber}: ${handler.method} ${fullPath}`);
        console.log(`   Parameters: ${handler.parameters.join(', ') || 'none'}`);
        console.log(`   Query params: ${handler.queryParams.join(', ') || 'none'}`);

        // Show generated template
        const template = generateJSDocTemplate(handler, fullPath);
        console.log('\n   Generated template:');
        template.split('\n').forEach((line) => console.log(`   ${line}`));
      }
    });
  } else {
    console.log(`   ✓ All handlers documented`);
  }
}

/**
 * Generate a report for all API files
 */
function generateReport(pattern: string): void {
  const files = glob.sync(pattern, { ignore: 'node_modules/**' });

  if (files.length === 0) {
    console.log(`No files found matching pattern: ${pattern}`);
    return;
  }

  console.log(`\n📊 JSDoc Coverage Report`);
  console.log(`================================\n`);
  console.log(`Analyzing ${files.length} files...\n`);

  let totalHandlers = 0;
  let totalDocumented = 0;
  const fileStats: Array<{
    file: string;
    total: number;
    documented: number;
    coverage: number;
  }> = [];

  files.forEach((file) => {
    const content = fs.readFileSync(file, 'utf-8');
    const handlers = extractRouteHandlers(content, file);

    if (handlers.length > 0) {
      const documented = handlers.filter((h) => h.hasJSDoc).length;
      const coverage = Math.round((documented / handlers.length) * 100);

      totalHandlers += handlers.length;
      totalDocumented += documented;

      fileStats.push({
        file: file.replace(process.cwd(), '.'),
        total: handlers.length,
        documented,
        coverage,
      });
    }
  });

  // Sort by coverage (lowest first)
  fileStats.sort((a, b) => a.coverage - b.coverage);

  // Print table
  console.log('File\t\t\t\t\tHandlers\tDocumented\tCoverage');
  console.log('─'.repeat(100));

  fileStats.forEach((stat) => {
    const coverage_str = `${stat.coverage}%`.padEnd(8);
    const file_display = stat.file.substring(0, 40).padEnd(42);
    const handlers_str = `${stat.total}`.padEnd(12);
    const documented_str = `${stat.documented}`.padEnd(12);

    const symbol = stat.coverage === 100 ? '✓' : stat.coverage >= 50 ? '~' : '✗';
    console.log(`${symbol} ${file_display}\t${handlers_str}\t${documented_str}\t${coverage_str}`);
  });

  console.log('─'.repeat(100));

  const totalCoverage = Math.round((totalDocumented / totalHandlers) * 100);
  console.log(`\nSummary:`);
  console.log(`  Total handlers: ${totalHandlers}`);
  console.log(`  Documented: ${totalDocumented}`);
  console.log(`  Coverage: ${totalCoverage}%`);
  console.log(`  Missing JSDoc: ${totalHandlers - totalDocumented} handlers`);

  // Recommendations
  console.log(`\n📋 Recommendations:`);
  const lowCoverageFiles = fileStats.filter((s) => s.coverage < 50);
  if (lowCoverageFiles.length > 0) {
    console.log(`  - ${lowCoverageFiles.length} files have <50% coverage`);
    console.log(`    ${lowCoverageFiles.map((f) => f.file).join(', ')}`);
  }

  const fullyDocumented = fileStats.filter((s) => s.coverage === 100);
  if (fullyDocumented.length > 0) {
    console.log(`  ✓ ${fullyDocumented.length} files are fully documented`);
  }
}

// Main execution
const pattern = process.argv[2] || 'src/api/**/*.ts';

if (pattern.includes('*')) {
  generateReport(pattern);
} else {
  analyzeFile(pattern);
}
