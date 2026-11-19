import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', '..', '..', 'dist');

/**
 * The entry chunks `vite.config.ts` `pack.entry` names. Loading `cli.js` runs
 * the CLI's top-level `main()`, which parses the importing process's argv.
 */
const ENTRY_CHUNKS = ['cli.js', 'index.js'];

// Same skip contract as `tests/unit/cli/version.test.ts`: a skip without a
// build, a failure when CI built first and set CDKD_EXPECT_DIST.
const distMissing = !existsSync(join(distDir, 'cli.js'));
const skipUnbuilt = distMissing && !process.env['CDKD_EXPECT_DIST'];

/** A static, side-effect or dynamic import of an entry chunk. */
const ENTRY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.\/(cli|index)\.js["']/g;

describe('dist chunk graph (issue #6601)', () => {
  it.skipIf(skipUnbuilt)('no non-entry chunk imports an entry chunk', () => {
    expect(distMissing, 'CDKD_EXPECT_DIST is set but dist/cli.js is absent').toBe(false);
    const files = readdirSync(distDir).filter((name) => name.endsWith('.js'));
    for (const entry of ENTRY_CHUNKS) expect(files).toContain(entry);
    const chunks = files.filter((name) => !ENTRY_CHUNKS.includes(name));
    // The build splits into dozens of chunks; a near-empty list means the scan
    // is reading the wrong directory, not that the graph is clean.
    expect(chunks.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const chunk of chunks) {
      const source = readFileSync(join(distDir, chunk), 'utf8');
      for (const match of source.matchAll(ENTRY_IMPORT)) {
        offenders.push(`${chunk} imports ./${match[1]}.js`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
