#!/usr/bin/env node
/**
 * Generates a Postman v2.1 collection from the routers mounted in
 * src/api/router.ts so the artifact cannot drift from the live routes.
 *
 * Usage:
 *   node scripts/generate-postman.js           # (re)write docs/postman/collection.json
 *   node scripts/generate-postman.js --check   # exit 1 if the committed file is stale
 *   node scripts/generate-postman.js --out dir # write to another directory (CI bundle)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ROUTER = path.join(ROOT, 'src/api/router.ts');
const TARGET = path.join(ROOT, 'docs/postman/collection.json');

function mountedPrefixes(source) {
  const prefixes = new Set();
  const re = /^router\.use\(\s*'(\/[^']*)'/gm;
  let m;
  while ((m = re.exec(source)) !== null) prefixes.add(m[1]);
  return [...prefixes].sort();
}

function buildCollection(prefixes) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return {
    info: {
      name: 'Soroban Smart Block Explorer API',
      description: 'Generated from src/api/router.ts. Do not edit by hand.',
      version: pkg.version,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:3000' },
      { key: 'apiKey', value: '' },
    ],
    item: prefixes.map((prefix) => ({
      name: prefix,
      request: {
        method: 'GET',
        header: [
          { key: 'Accept-Version', value: 'v1' },
          { key: 'X-API-Key', value: '{{apiKey}}' },
        ],
        url: {
          raw: `{{baseUrl}}/api/v1${prefix}`,
          host: ['{{baseUrl}}'],
          path: ['api', 'v1', ...prefix.split('/').filter(Boolean)],
        },
      },
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outIdx = args.indexOf('--out');
  const target = outIdx >= 0 ? path.join(path.resolve(args[outIdx + 1]), 'collection.json') : TARGET;
  const prefixes = mountedPrefixes(fs.readFileSync(ROUTER, 'utf8'));
  const output = JSON.stringify(buildCollection(prefixes), null, 2) + '\n';

  if (check) {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    if (current !== output) {
      console.error('Postman collection drift detected. Run: npm run postman:generate');
      process.exit(1);
    }
    console.log(`Postman collection is up to date (${prefixes.length} mounted routers).`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output);
  console.log(`Wrote ${target} (${prefixes.length} mounted routers).`);
}

main();
