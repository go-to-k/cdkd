/**
 * Every `secret-redaction/*.ts` module loads as the FIRST module of a fresh
 * graph (issue #4415). Two siblings read a `rules.ts` constant at module top
 * level, so a cycle through `rules.ts` makes the result depend on which module
 * an importer reaches first: through the barrel it loads, imported directly it
 * throws `Cannot access ... before initialization`.
 *
 * The load runs under NATIVE Node ESM in a child process, over a transpiled
 * copy: vitest's module runner tolerates such a cycle, so an in-process
 * `import()` stays green with the cycle in place.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript-v6';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const DIR = join(import.meta.dirname, '../../../src/deployment/secret-redaction');
const MODULES = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

/** Vitest cannot interrupt a synchronous spawn, so the spawn carries the case's timeout too. */
const LOAD_TIMEOUT_MS = 30_000;

let out = '';

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'cdkd-secret-redaction-load-'));
  writeFileSync(join(out, 'package.json'), '{"type":"module"}');
  for (const file of MODULES) {
    const { outputText } = ts.transpileModule(readFileSync(join(DIR, file), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
    });
    writeFileSync(join(out, file.replace(/\.ts$/, '.js')), outputText);
  }
}, 30_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

/** Load `file` alone in a fresh Node process; returns its export count. */
function exportCountOf(file: string): number {
  const url = pathToFileURL(join(out, file.replace(/\.ts$/, '.js'))).href;
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(Object.keys(m).length);`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: LOAD_TIMEOUT_MS }
  );
  return Number(stdout.trim());
}

describe('secret-redaction module load order', () => {
  it('finds the split modules (guards against passing by reading nothing)', () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(12);
    expect(MODULES).toContain('rules.ts');
  });

  // Each case spawns a Node process, so it declares its own timeout.
  it.each(MODULES)(
    '%s loads as the first module of a fresh graph',
    (file) => {
      expect(exportCountOf(file)).toBeGreaterThan(0);
    },
    LOAD_TIMEOUT_MS
  );
});
