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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const DIR = join(__dirname, '../../../src/deployment/secret-redaction');
const MODULES = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

let out = '';

beforeAll(() => {
  const ts = createRequire(join(__dirname, '../../../package.json'))(
    'typescript-v6'
  ) as typeof import('typescript');
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
  const url = new URL(`file://${join(out, file.replace(/\.ts$/, '.js'))}`).href;
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(Object.keys(m).length);`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
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
    30_000
  );
});
