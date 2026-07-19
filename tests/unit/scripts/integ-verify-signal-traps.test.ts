import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import {
  classifyVerifyScript,
  joinMultilineTraps,
} from '../../../scripts/check-integ-signal-traps.js';

/**
 * Regression guard for issue #1097 pattern 1 (signal handling in integ
 * fixtures). See `scripts/check-integ-signal-traps.ts` for why the correct
 * form is what it is.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

/**
 * Fixtures whose verify.sh is owned by an in-flight PR, so the sweep skips them
 * to avoid a cross-lane collision. Each entry is asserted to still be
 * NON-compliant below, so the exception self-expires: once the owning PR lands
 * the correct form, this test fails and forces the entry to be deleted rather
 * than silently lingering.
 *
 * Empty today. `emr-cluster` was the one entry; PR #1101 merged mid-review with
 * the un-seeded `trap 'cleanup; exit 130' INT` form, so this PR rebased onto it
 * and swept it like the rest.
 */
const PENDING_OTHER_PR: Record<string, string> = {};

function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => ({
      name: e.name,
      ...classifyVerifyScript(readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8')),
    }));
}

describe('classifyVerifyScript', () => {
  const CLEANUP = 'cleanup() {\n  echo teardown\n}\n';

  it('accepts the canonical three-trap form', () => {
    const c = classifyVerifyScript(
      `${CLEANUP}trap cleanup EXIT\ntrap '(exit 130); cleanup; exit 130' INT\ntrap '(exit 143); cleanup; exit 143' TERM\n`,
    );
    expect(c.hasCleanupExitTrap).toBe(true);
    expect(c.hasCorrectIntTrap).toBe(true);
    expect(c.hasCorrectTermTrap).toBe(true);
    expect(c.hasResumingSignalTrap).toBe(false);
  });

  // The reviewer of PR #1102 showed the first-cut regex (`^trap [a-z_]+ `)
  // matched only the single literal `trap cleanup EXIT INT TERM`. Every shape
  // below is the same bug and must be caught.
  it.each([
    ['bare function', 'trap cleanup EXIT INT TERM'],
    ['single-quoted', "trap 'cleanup' EXIT INT TERM"],
    ['double-quoted', 'trap "cleanup" EXIT INT TERM'],
    ['digit in name', 'trap cleanup2 EXIT INT TERM'],
    ['capitalized', 'trap Cleanup EXIT INT TERM'],
    ['INT only', 'trap cleanup INT'],
    ['body without exit', "trap 'cleanup; echo done' INT"],
  ])('flags the resuming form: %s', (_label, trapLine) => {
    const fns = 'cleanup() { :; }\ncleanup2() { :; }\nCleanup() { :; }\n';
    expect(classifyVerifyScript(`${fns}${trapLine}\n`).hasResumingSignalTrap).toBe(true);
  });

  it('recognizes a cleanup EXIT trap under any handler name', () => {
    // The first cut keyed on the literal name `cleanup`, so a rename would
    // have silently exempted the fixture from the INT/TERM requirement.
    for (const name of ['cleanup', 'teardown', 'cleanup_stack']) {
      const c = classifyVerifyScript(`${name}() {\n  :\n}\ntrap ${name} EXIT\n`);
      expect(c.hasCleanupExitTrap).toBe(true);
      expect(c.hasCorrectIntTrap).toBe(false);
    }
  });

  it('requires the (exit N) seed, not just a trailing exit', () => {
    // `trap 'cleanup; exit 130' INT` looks right but leaves `$?` as the
    // interrupted command's status, so an `rc=$?` cleanup can skip teardown.
    const c = classifyVerifyScript(`${CLEANUP}trap 'cleanup; exit 130' INT\n`);
    expect(c.hasCorrectIntTrap).toBe(false);
  });

  it('does not treat a disarm as an arm', () => {
    const c = classifyVerifyScript(`${CLEANUP}trap - EXIT INT TERM\n`);
    expect(c.hasCleanupExitTrap).toBe(false);
    expect(c.hasResumingSignalTrap).toBe(false);
  });

  it('joins a multi-line trap so it cannot hide from a line scan', () => {
    // local-start-api-websocket shipped exactly this shape; the line-oriented
    // first cut read it as two unrelated fragments and greenlit the fixture.
    const script = `${CLEANUP}trap '\ncleanup\necho extra\n' EXIT INT TERM\n`;
    expect(joinMultilineTraps(script).some((l) => /^trap '.*' EXIT INT TERM$/.test(l))).toBe(true);
    expect(classifyVerifyScript(script).hasResumingSignalTrap).toBe(true);
  });
});

describe('bash signal semantics the sweep relies on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-trap-'));

  /** Gates teardown on `$?` and exits -- the shape ~21 fixtures use. */
  const RC_GATED_CLEANUP =
    'cleanup() { rc=$?; if [ "${rc}" -eq 0 ]; then echo SKIPPED; exit 0; fi; echo "TEARDOWN rc=${rc}"; exit "${rc}"; }';
  /** Does not exit -- the shape that lets a handler return and resume. */
  const PLAIN_CLEANUP = 'cleanup() { echo TEARDOWN; }';

  const run = async (trapLines: string, cleanupFn = RC_GATED_CLEANUP) => {
    const path = join(dir, `t-${Math.abs(hash(trapLines + cleanupFn))}.sh`);
    writeFileSync(
      path,
      `#!/usr/bin/env bash
set -euo pipefail
${cleanupFn}
${trapLines}
echo phase1
sleep 2
echo RESUMED
`,
      { mode: 0o755 },
    );
    const child = spawn('bash', [path]);
    const out: string[] = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    await new Promise((r) => setTimeout(r, 400));
    child.kill('SIGINT');
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
    return { code, out: out.join('') };
  };

  it('the bare form resumes the interrupted phase and reports success', async () => {
    // A bash signal handler RETURNS to the interrupted point. With a cleanup
    // that does not exit on its own, the script walks straight into the next
    // phase and finishes 0 -- a leaked stack reported as PASS.
    const { code, out } = await run('trap cleanup EXIT INT TERM', PLAIN_CLEANUP);
    expect(out).toContain('RESUMED');
    expect(code).toBe(0);
  });

  it('the un-seeded form skips teardown entirely when $? happens to be 0', async () => {
    const { code, out } = await run("trap cleanup EXIT\ntrap 'cleanup; exit 130' INT");
    expect(out).toContain('SKIPPED');
    expect(out).not.toContain('TEARDOWN');
    expect(code).toBe(0);
  });

  it('the canonical form tears down with the signal code and exits 130', async () => {
    const { code, out } = await run(
      "trap cleanup EXIT\ntrap '(exit 130); cleanup; exit 130' INT",
    );
    expect(out).toContain('TEARDOWN rc=130');
    expect(out).not.toContain('RESUMED');
    expect(code).toBe(130);
  });

  it('cleans up the temp scripts', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

describe('integ fixture verify.sh signal traps (#1097 pattern 1)', () => {
  const fixtures = readFixtures();
  const inScope = fixtures.filter((f) => !(f.name in PENDING_OTHER_PR));

  it('finds the fixture tree', () => {
    expect(fixtures.length).toBeGreaterThan(100);
  });

  it('every fixture verify.sh is syntactically valid bash', () => {
    const bad = fixtures
      .map((f) => ({
        name: f.name,
        rc: spawnSync('bash', ['-n', join(INTEG_ROOT, f.name, 'verify.sh')]).status,
      }))
      .filter((r) => r.rc !== 0)
      .map((r) => r.name);
    expect(bad).toEqual([]);
  });

  it('never arms a signal trap that can resume the interrupted phase', () => {
    expect(inScope.filter((f) => f.hasResumingSignalTrap).map((f) => f.name)).toEqual([]);
  });

  it('arms a seeded, exiting INT trap wherever it arms a cleanup EXIT trap', () => {
    expect(
      inScope.filter((f) => f.hasCleanupExitTrap && !f.hasCorrectIntTrap).map((f) => f.name),
    ).toEqual([]);
  });

  it('arms a seeded, exiting TERM trap wherever it arms a cleanup EXIT trap', () => {
    expect(
      inScope.filter((f) => f.hasCleanupExitTrap && !f.hasCorrectTermTrap).map((f) => f.name),
    ).toEqual([]);
  });

  it('never leaves a bare `trap - EXIT` disarm that keeps signal handlers armed', () => {
    const offenders = inScope
      .filter((f) =>
        readFileSync(join(INTEG_ROOT, f.name, 'verify.sh'), 'utf8')
          .split('\n')
          .some((l) => /^\s*trap\s+-\s+EXIT\s*$/.test(l)),
      )
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('keeps the in-flight-PR exception list free of already-fixed fixtures', () => {
    // Self-expiring guard: an entry that has become compliant (its PR merged)
    // must be deleted from PENDING_OTHER_PR, not left to mask a future
    // regression in that same fixture.
    const stale = Object.keys(PENDING_OTHER_PR).filter((name) => {
      const f = fixtures.find((x) => x.name === name);
      if (!f) return true; // fixture gone entirely -> entry is stale
      if (f.hasResumingSignalTrap) return false; // still broken -> entry earns its keep
      return !f.hasCleanupExitTrap || (f.hasCorrectIntTrap && f.hasCorrectTermTrap);
    });
    expect(stale).toEqual([]);
  });
});
