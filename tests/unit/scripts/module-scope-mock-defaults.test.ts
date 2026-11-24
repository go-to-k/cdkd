/**
 * Enforcement for `scripts/check-module-scope-mock-defaults.ts` (issue #6928,
 * step 1): a mock default installed where `mockReset` would wipe it may not be
 * added to `tests/unit/**`, and the grandfathered files in
 * `tests/module-scope-mock-defaults-allowlist.json` may only shrink.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vite-plus/test';

import {
  type AllowList,
  type Report,
  type Site,
  ALLOW_LIST_PATH,
  analyzeSource,
  buildReport,
  readAllowList,
  reportFails,
  SETTERS,
  shrunkAllowList,
} from '../../../scripts/check-module-scope-mock-defaults.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(repoRoot, 'scripts/check-module-scope-mock-defaults.ts');

function sites(source: string): Site[] {
  const analysis = analyzeSource('fake.test.ts', source);
  expect(analysis.parseErrors).toBe(0);
  return [...analysis.sites];
}
function only(source: string): Site {
  const found = sites(source);
  expect(found).toHaveLength(1);
  return found[0]!;
}

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
/** A scan root holding `tests/unit/<name>` for each entry, plus an allow-list file. */
function scratchRoot(files: Record<string, string>, allow: AllowList): { root: string; allowPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-mock-defaults-'));
  scratchDirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const full = join(root, 'tests/unit', name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  const allowPath = join(root, 'allow.json');
  writeFileSync(allowPath, JSON.stringify(allow));
  return { root, allowPath };
}

const MODULE_DEFAULT = `const m = vi.fn();\nm.mockReturnValue(1);\n`;
const CLEAN = `const m = vi.fn(() => 1);\nbeforeEach(() => { m.mockReturnValue(2); });\n`;

describe('module-scope mock-default checker', () => {
  describe('the setter set is what mockReset wipes', () => {
    it.each([...SETTERS])('refuses %s at module scope', (setter) => {
      expect(only(`m.${setter}(x);`)).toMatchObject({ verdict: 'refused', reason: 'module-scope', setter });
    });

    it('does not count vi.fn(impl), which mockReset restores', () => {
      expect(sites(`const m = vi.fn(() => 1);\nvi.mock('x', () => ({ f: vi.fn(() => 2) }));`)).toEqual([]);
    });

    it('does not count withImplementation or mockName', () => {
      expect(sites(`m.withImplementation(() => 1, () => {});\nm.mockName('x');`)).toEqual([]);
    });

    it('reads every receiver shape: vi.fn() chain, vi.mocked, vi.spyOn', () => {
      const found = sites(
        `const a = vi.fn().mockResolvedValue(1);\n` +
          `vi.mocked(b).mockImplementation(() => 2);\n` +
          `vi.spyOn(o, 'k').mockReturnValue(3);\n`
      );
      expect(found.map((s) => s.verdict)).toEqual(['refused', 'refused', 'refused']);
    });
  });

  describe('where a setter runs', () => {
    it.each([
      ['it', `it('x', () => { m.mockReturnValue(1); });`],
      ['test', `test('x', async () => { m.mockReturnValue(1); });`],
      ['it.each(t)(...)', `it.each([1, 2])('x %s', (n) => { m.mockReturnValue(n); });`],
      ['it.only', `it.only('x', function () { m.mockReturnValue(1); });`],
      ['test.concurrent.each', `test.concurrent.each([1])('x', (n) => { m.mockReturnValue(n); });`],
      ['beforeEach', `beforeEach(() => { m.mockReturnValue(1); });`],
      ['beforeEach inside describe', `describe('d', () => { beforeEach(() => { m.mockReturnValue(1); }); });`],
      ['forEach inside a test', `it('x', () => { [a, b].forEach((x) => x.mockReturnValue(1)); });`],
    ])('accepts %s', (_shape, source) => {
      expect(only(source).verdict).toBe('safe');
    });

    it.each([
      ['describe-body', `describe('d', () => { m.mockReturnValue(1); it('x', () => {}); });`],
      ['describe-body', `describe.each([1])('d %s', () => { describe('e', () => { m.mockReturnValue(1); }); });`],
      ['vi.mock-factory', `vi.mock('x', () => ({ f: vi.fn().mockReturnValue(1) }));`],
      ['vi.mock-factory', `vi.mock('x', async (orig) => { g.mockImplementation(() => 1); return {}; });`],
      ['vi.hoisted', `const h = vi.hoisted(() => ({ f: vi.fn().mockResolvedValue(1) }));`],
      ['beforeAll', `beforeAll(() => { m.mockReturnValue(1); });`],
      ['afterAll', `afterAll(() => { m.mockReturnValue(1); });`],
      ['afterEach', `describe('d', () => { afterEach(() => { m.mockReturnValue(1); }); });`],
      ['module-scope', `[a, b].forEach((x) => x.mockReturnValue(1));`],
      ['module-scope', `(() => { m.mockReturnValue(1); })();`],
      ['describe-body', `describe('d', () => { void (async function () { m.mockReturnValue(1); })(); });`],
      ['module-scope', `vi.doMock('x', () => ({ f: vi.fn().mockReturnValue(1) }));`],
    ])('refuses %s', (reason, source) => {
      expect(only(source)).toMatchObject({ verdict: 'refused', reason });
    });

    it('a vi.doMock factory inside a test runs in the test', () => {
      expect(only(`it('x', async () => { vi.doMock('y', () => ({ f: vi.fn().mockReturnValue(1) })); });`).verdict).toBe(
        'safe'
      );
    });
  });

  describe('named helpers resolve through their in-file references', () => {
    it('a helper passed to beforeEach is safe', () => {
      expect(only(`function setup() { m.mockReturnValue(1); }\nbeforeEach(setup);`).verdict).toBe('safe');
    });

    it('a const arrow helper called from a test is safe', () => {
      expect(only(`const setup = () => { m.mockReturnValue(1); };\nit('x', () => { setup(); });`).verdict).toBe(
        'safe'
      );
    });

    it('a helper called in a describe body is refused, naming the helper', () => {
      expect(only(`function setup() { m.mockReturnValue(1); }\ndescribe('d', () => { setup(); });`)).toMatchObject({
        verdict: 'refused',
        reason: 'describe-body',
        via: ['setup'],
      });
    });

    it('a helper called from a refused helper is refused through the chain', () => {
      expect(
        only(`function inner() { m.mockReturnValue(1); }\nfunction outer() { inner(); }\nouter();`)
      ).toMatchObject({ verdict: 'refused', reason: 'module-scope', via: ['outer', 'inner'] });
    });

    it('a helper used in a vi.mock factory is refused (the asset-storage shape)', () => {
      expect(
        only(`vi.mock('x', () => { const command = (t) => vi.fn().mockImplementation(() => t); return { C: command('a') }; });`)
      ).toMatchObject({ verdict: 'refused', reason: 'vi.mock-factory', via: ['command'] });
    });

    it('refused wins over safe when a helper has both callers (fail-closed)', () => {
      expect(only(`function s() { m.mockReturnValue(1); }\nbeforeEach(s);\ns();`).verdict).toBe('refused');
    });

    it('a typeof reference is not a call', () => {
      expect(
        only(`function mk() { m.mockReturnValue(1); }\ndescribe('d', () => { let h: ReturnType<typeof mk>; });`)
          .verdict
      ).toBe('unresolved');
    });
  });

  describe('bounds are reported as unresolved, not silently passed', () => {
    it.each([
      ['an exported helper with no in-file caller', `export function setup() { m.mockReturnValue(1); }`],
      ['an implementation passed to a setter', `it('x', () => { a.mockImplementation(() => b.mockReturnValue(1)); });`],
      ['an object method', `const fake = { send() { m.mockReturnValue(1); } };`],
      ['an it.each table row callback', `it.each([[() => m.mockReturnValue(1)]])('x', (f) => f());`],
      ['a helper in a cycle', `function a() { m.mockReturnValue(1); b(); }\nfunction b() { a(); }`],
    ])('%s', (_shape, source) => {
      const found = sites(source).filter((s) => s.verdict !== 'safe');
      expect(found.map((s) => s.verdict)).toContain('unresolved');
      expect(found.every((s) => s.verdict === 'unresolved')).toBe(true);
    });
  });

  describe('allow-list semantics', () => {
    const files = { 'a.test.ts': MODULE_DEFAULT, 'b.test.ts': CLEAN };

    it('passes when the list matches exactly', () => {
      const { root } = scratchRoot(files, { files: {} });
      const report = buildReport(root, { files: { 'tests/unit/a.test.ts': 1 } });
      expect(reportFails(report)).toBe(false);
      expect(report.filesScanned).toBe(2);
    });

    it('NEW: an unlisted offending file', () => {
      const { root } = scratchRoot(files, { files: {} });
      const report = buildReport(root, { files: {} });
      expect(report.newFiles.map((f) => f.file)).toEqual(['tests/unit/a.test.ts']);
      expect(reportFails(report)).toBe(true);
    });

    it('GREW: a grandfathered file gaining a default', () => {
      const { root } = scratchRoot({ 'a.test.ts': `${MODULE_DEFAULT}m.mockResolvedValue(2);\n` }, { files: {} });
      const report = buildReport(root, { files: { 'tests/unit/a.test.ts': 1 } });
      expect(report.grew).toEqual([{ file: 'tests/unit/a.test.ts', listed: 1, actual: 2 }]);
      expect(reportFails(report)).toBe(true);
    });

    it('LOWER: a grandfathered file losing one of several', () => {
      const { root } = scratchRoot(files, { files: {} });
      const report = buildReport(root, { files: { 'tests/unit/a.test.ts': 2 } });
      expect(report.lower).toEqual([{ file: 'tests/unit/a.test.ts', listed: 2, actual: 1 }]);
      expect(reportFails(report)).toBe(true);
    });

    it('STALE: a listed file that is clean now', () => {
      const { root } = scratchRoot(files, { files: {} });
      const report = buildReport(root, { files: { 'tests/unit/a.test.ts': 1, 'tests/unit/b.test.ts': 1 } });
      expect(report.stale).toEqual(['tests/unit/b.test.ts']);
      expect(reportFails(report)).toBe(true);
    });

    it('DEAD: a listed file that does not exist', () => {
      const { root } = scratchRoot(files, { files: {} });
      const report = buildReport(root, { files: { 'tests/unit/a.test.ts': 1, 'tests/unit/gone.test.ts': 3 } });
      expect(report.dead).toEqual(['tests/unit/gone.test.ts']);
      expect(reportFails(report)).toBe(true);
    });

    it('a file that does not parse fails rather than reading clean', () => {
      const { root } = scratchRoot({ 'a.test.ts': 'const = ;\n' }, { files: {} });
      const report = buildReport(root, { files: {} });
      expect(report.parseErrors).toEqual(['tests/unit/a.test.ts']);
      expect(reportFails(report)).toBe(true);
    });

    it('an empty tree fails', () => {
      const { root } = scratchRoot({}, { files: {} });
      mkdirSync(join(root, 'tests/unit'), { recursive: true });
      expect(reportFails(buildReport(root, { files: {} }))).toBe(true);
    });

    it('--update only lowers and removes, never adds or raises', () => {
      const { root } = scratchRoot(
        { 'a.test.ts': `${MODULE_DEFAULT}m.mockResolvedValue(2);\n`, 'b.test.ts': CLEAN, 'c.test.ts': MODULE_DEFAULT },
        { files: {} }
      );
      const allow: AllowList = {
        files: { 'tests/unit/a.test.ts': 1, 'tests/unit/b.test.ts': 4, 'tests/unit/gone.test.ts': 1 },
      };
      const report = buildReport(root, allow);
      // a grew (stays 1), b is stale, gone is dead, c is new (not added).
      expect(shrunkAllowList(allow, report).files).toEqual({ 'tests/unit/a.test.ts': 1 });
    });
  });

  describe('the shipped command', () => {
    const run = (root: string, allowPath: string, extra: string[] = []) =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', script, '--check', `--root=${root}`, `--allow-list=${allowPath}`, ...extra],
        { encoding: 'utf8', timeout: CONTENDED_CASE_TIMEOUT_MS }
      );

    it('exits 1 naming the file and line of a new default, 0 once grandfathered', () => {
      const { root, allowPath } = scratchRoot({ 'a.test.ts': MODULE_DEFAULT }, { files: {} });
      const refused = run(root, allowPath);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('NEW    tests/unit/a.test.ts:2 .mockReturnValue() in module-scope');
      writeFileSync(allowPath, JSON.stringify({ files: { 'tests/unit/a.test.ts': 1 } }));
      expect(run(root, allowPath).status).toBe(0);
    }, CONTENDED_CASE_TIMEOUT_MS);

    it('--update rewrites the list shrunk', () => {
      const { root, allowPath } = scratchRoot(
        { 'a.test.ts': CLEAN },
        { $comment: 'kept', files: { 'tests/unit/a.test.ts': 2 } }
      );
      expect(run(root, allowPath).status).toBe(1);
      expect(run(root, allowPath, ['--update']).status).toBe(0);
      expect(JSON.parse(readFileSync(allowPath, 'utf8'))).toEqual({ $comment: 'kept', files: {} });
      expect(run(root, allowPath).status).toBe(0);
    }, CONTENDED_CASE_TIMEOUT_MS);
  });

  describe('the real tree', () => {
    let cached: Report | undefined;
    const real = (): Report => (cached ??= buildReport());

    it('is green', () => {
      const report = real();
      expect(report.parseErrors).toEqual([]);
      expect(report.newFiles.map((f) => `${f.file}:${f.refused.map((s) => s.line).join(',')}`)).toEqual([]);
      expect(report.grew).toEqual([]);
      expect(report.lower).toEqual([]);
      expect(report.stale).toEqual([]);
      expect(report.dead).toEqual([]);
    }, CONTENDED_CASE_TIMEOUT_MS);

    it('still sees the population: a floor per refusal reason and per verdict', () => {
      // FLOORS, as literals the checker does not read (measured on main
      // 2026-11-24: 2877 files; refused 2930 = vi.mock-factory 2789,
      // module-scope 70, describe-body 29, vi.hoisted 21, beforeAll 14,
      // afterEach 7; safe 27807; unresolved 1021). A collapsed walk reads as
      // "0 violations"; each floor sits well below its count so migration
      // (step 2) lowers counts without tripping it before the list empties.
      const report = real();
      expect(report.filesScanned).toBeGreaterThan(2000);
      expect(report.totals.safe).toBeGreaterThan(10_000);
      expect(report.totals.unresolved).toBeGreaterThan(0);
      const byReason = report.totals.byReason;
      if (Object.keys(readAllowList().files).length > 0) {
        expect(byReason['vi.mock-factory'] ?? 0).toBeGreaterThan(0);
        expect(byReason['module-scope'] ?? 0).toBeGreaterThan(0);
      }
    }, CONTENDED_CASE_TIMEOUT_MS);
  });

  describe('the allow-list file', () => {
    it('is sorted, with positive integer counts', () => {
      const allow = readAllowList(ALLOW_LIST_PATH);
      const keys = Object.keys(allow.files);
      expect(keys).toEqual([...keys].sort());
      for (const key of keys) {
        expect(key.startsWith('tests/unit/')).toBe(true);
        expect(Number.isInteger(allow.files[key]) && allow.files[key]! > 0).toBe(true);
      }
    });
  });
});
