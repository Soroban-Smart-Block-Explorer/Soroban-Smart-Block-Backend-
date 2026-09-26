import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const dir = 'docs/tutorials';
const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
const toc = readFileSync(join(dir, 'README.md'), 'utf8');
let failures = 0;
for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  if (f !== 'README.md' && !toc.includes(`(${f})`)) {
    console.error(`${f}: missing from tutorial TOC`);
    failures++;
  }
  for (const m of text.matchAll(/\]\((?!https?:|#)([^)#]+)(#[^)]*)?\)/g)) {
    if (!existsSync(resolve(dirname(join(dir, f)), m[1]))) {
      console.error(`${f}: broken link ${m[1]}`);
      failures++;
    }
  }
}
process.exit(failures ? 1 : 0);
