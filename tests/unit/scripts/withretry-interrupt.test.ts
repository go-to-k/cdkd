/**
 * Issue #2053 — the `withRetry` interrupt-threading critic.
 *
 * The real-tree sweep below is a gate in its own right, and the `--scan-dir=`
 * seam is how every failure probe is taken, so a probe never writes to `src/`.
 * The critic is ALSO wired as a CI step (`vp run audit:withretry-interrupt:check`),
 * which the last block here pins so the wiring cannot silently disappear.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  analyzeFile,
  auditExemptions,
  buildReport,
  runSelfProbes,
} from '../../../scripts/check-withretry-interrupt.ts';

/** The import + binding a provenance-passing fixture needs in scope. */
const SHARED_WATCH = `import { startInterruptWatch } from '../interrupt-watch.js';
const watch = startInterruptWatch('w');`;


/**
 * A threaded, disposed-in-finally site — the shape the real tree uses.
 *
 * The binding sits INSIDE the function with its `try`/`finally`, which is not
 * incidental: a watch bound in an outer scope and released from a `finally` in
 * some inner function is exactly the nested-callback shape the critic refuses,
 * because that inner function may never run.
 */
function threadedSite(): string {
  return `import { startInterruptWatch } from '../interrupt-watch.js';
export const go = async () => {
  const watch = startInterruptWatch('w');
  try {
    await withRetry(op, id, { isInterrupted: watch.isInterrupted, onInterrupted: watch.onInterrupted });
  } finally {
    watch.dispose();
  }
};
`;
}

/**
 * A tree big enough to clear the FILE floors, so a probe can trip exactly ONE
 * of the remaining floors. The 1-file tree trips all of them at once, which
 * means none of them was ever exercised alone.
 */
function padFiles(dir: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `pad-${i}.ts`), `export const pad${i} = ${i};\n`);
  }
}

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-withretry-interrupt.ts');
const SCAN_DIR = join(REPO_ROOT, 'src/provisioning');
const SPAWN_TIMEOUT_MS = 120_000;

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** A throwaway COPY of the real provisioning tree, for mutation probes. */
function copyTree(): string {
  const dest = join(scratch('cdkd-interrupt-probe-'), 'provisioning');
  cpSync(SCAN_DIR, dest, { recursive: true });
  return dest;
}

function mutate(dir: string, file: string, from: string, to: string): void {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  // A probe anchored on a non-unique string proves nothing about WHICH site
  // moved, so uniqueness is asserted rather than assumed.
  const occurrences = text.split(from).length - 1;
  expect(occurrences, `probe anchor is not unique in ${file}`).toBe(1);
  writeFileSync(path, text.replace(from, to));
}

function run(
  args: readonly string[],
  script = SCRIPT
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync('node', ['--experimental-strip-types', script, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { status: proc.status, stdout: String(proc.stdout ?? ''), stderr: String(proc.stderr ?? '') };
}

function runCheck(dir: string): { status: number | null; stderr: string; stdout: string } {
  return run([`--scan-dir=${dir}`]);
}

describe('withRetry interrupt critic — classifier', () => {
  it('passes its own self-probes', () => {
    expect(runSelfProbes()).toEqual([]);
  });

  it('accepts the reference shape', () => {
    expect(analyzeFile('p.ts', threadedSite()).sites[0]?.verdict).toBe('threaded');
  });

  it('is VALUE-aware, not merely presence-aware', () => {
    // `isInterrupted: () => false` declares both names and disables the
    // mechanism entirely — a checker that passed it would be verifying its own
    // spelling rather than its own effect.
    const disabled = analyzeFile(
      'p.ts',
      `${SHARED_WATCH}\nwithRetry(op, id, { isInterrupted: () => false, onInterrupted: () => new Error('x') });`
    ).sites[0];
    expect(disabled?.verdict).toBe('unshared');
    expect(disabled?.present).toEqual(['isInterrupted', 'onInterrupted']);

    const undef = analyzeFile(
      'p.ts',
      `${SHARED_WATCH}\nwithRetry(op, id, { isInterrupted: undefined, onInterrupted: undefined });`
    ).sites[0];
    expect(undef?.verdict).toBe('unshared');
  });

  it('requires ONE watch, from the SHARED factory', () => {
    const twoWatches = analyzeFile(
      'p.ts',
      `import { startInterruptWatch } from '../interrupt-watch.js';
const a = startInterruptWatch('a');
const b = startInterruptWatch('b');
withRetry(op, id, { isInterrupted: a.isInterrupted, onInterrupted: b.onInterrupted });`
    ).sites[0];
    expect(twoWatches?.verdict).toBe('unshared');
    expect(twoWatches?.reason).toContain('cannot agree');

    const localFactory = analyzeFile(
      'p.ts',
      `const watch = makeMyOwnWatch('x');
withRetry(op, id, { isInterrupted: watch.isInterrupted, onInterrupted: watch.onInterrupted });`
    ).sites[0];
    expect(localFactory?.verdict).toBe('unshared');
  });

  it('resolves ALIASED imports on both sides', () => {
    // The reviewer's constructed miss: `import { withRetry as retryOp }` used to
    // yield ZERO sites, silently — "found nothing" passing as "everything
    // matches", and invisible to the floors because they count per file.
    const aliasedRetry = analyzeFile(
      'p.ts',
      `import { withRetry as retryOp } from '../../deployment/retry.js';
retryOp(op, id, { logger });`
    ).sites;
    expect(aliasedRetry).toHaveLength(1);
    expect(aliasedRetry[0]?.verdict).toBe('dropped');

    const aliasedFactory = analyzeFile(
      'p.ts',
      `import { startInterruptWatch as makeWatch } from '../interrupt-watch.js';
const w = makeWatch('x');
try {
  withRetry(op, id, { isInterrupted: w.isInterrupted, onInterrupted: w.onInterrupted });
} finally {
  w.dispose();
}`
    ).sites;
    expect(aliasedFactory[0]?.verdict).toBe('threaded');
  });

  it('rejects a same-named factory imported from ELSEWHERE', () => {
    // Provenance is about the MODULE, not the identifier: a local helper called
    // `startInterruptWatch` would otherwise pose as the shared one.
    const impostor = analyzeFile(
      'p.ts',
      `import { startInterruptWatch } from './my-own-watch.js';
const watch = startInterruptWatch('x');
withRetry(op, id, { isInterrupted: watch.isInterrupted, onInterrupted: watch.onInterrupted });`
    ).sites[0];
    expect(impostor?.verdict).toBe('unshared');
  });

  it('requires dispose() in a FINALLY, not on the happy path', () => {
    const happyPathOnly = analyzeFile(
      'p.ts',
      `${SHARED_WATCH}
await withRetry(op, id, { isInterrupted: watch.isInterrupted, onInterrupted: watch.onInterrupted });
watch.dispose();`
    ).watches;
    expect(happyPathOnly).toHaveLength(1);
    expect(happyPathOnly[0]?.disposedInFinally).toBe(false);

    expect(analyzeFile('p.ts', threadedSite()).watches[0]?.disposedInFinally).toBe(true);
  });

  it('does NOT credit a CONDITIONAL dispose', () => {
    // `finally { if (flag) watch.dispose(); }` reads as a release and is not
    // one — it runs only when `flag` holds, and the throw it must survive is
    // the interrupt, which is when a guard like that tends not to hold.
    const conditional = analyzeFile(
      'p.ts',
      `${SHARED_WATCH}
export function g(flag: boolean) {
  const watch = startInterruptWatch('c');
  try { go(); } finally { if (flag) watch.dispose(); }
}`
    ).watches;
    expect(conditional.some((w) => !w.disposedInFinally)).toBe(true);
  });

  it('does NOT credit a dispose inside an unrelated NESTED CALLBACK', () => {
    // The callback may never run, so its `finally` is not a release of the
    // outer watch at all.
    const nested = analyzeFile(
      'p.ts',
      `import { startInterruptWatch } from '../interrupt-watch.js';
export function h() {
  const watch = startInterruptWatch('d');
  run(() => {
    try { go(); } finally { watch.dispose(); }
  });
}`
    ).watches;
    expect(nested).toHaveLength(1);
    expect(nested[0]?.disposedInFinally).toBe(false);
  });

  it('resolves two SAME-NAMED watches in sibling BLOCKS of one function', () => {
    // Keying on the name plus the enclosing FUNCTION merged these, so one
    // block's correct `finally` covered the other block's leak. Lexical
    // resolution is what separates them.
    const twoBlocks = analyzeFile(
      'p.ts',
      `import { startInterruptWatch } from '../interrupt-watch.js';
export function f() {
  {
    const watch = startInterruptWatch('a');
    try { go(); } finally { watch.dispose(); }
  }
  {
    const watch = startInterruptWatch('b');
    go();
    watch.dispose();
  }
}`
    ).watches;
    expect(twoBlocks).toHaveLength(2);
    expect(twoBlocks.map((w) => w.disposedInFinally)).toEqual([true, false]);
  });

  it('does NOT let a SIBLING method`s finally credit a leak', () => {
    // Found by the break-test rather than by review: a file routinely binds
    // several watches to the same identifier in different methods, and a
    // name-only match let one method's correct `finally` cover another
    // method's leak — so the leak arm reported nothing at all.
    const twoMethods = analyzeFile(
      'p.ts',
      `import { startInterruptWatch } from '../interrupt-watch.js';
class P {
  good() {
    const watch = startInterruptWatch('a');
    try {
      go();
    } finally {
      watch.dispose();
    }
  }
  leaky() {
    const watch = startInterruptWatch('b');
    go();
    watch.dispose();
  }
}`
    ).watches;
    expect(twoMethods).toHaveLength(2);
    expect(twoMethods.map((w) => w.disposedInFinally)).toEqual([true, false]);
  });

  it('reports HALF a pair as a defect, naming the missing half', () => {
    // Half is not "mostly fine": without `onInterrupted`, `withRetry` throws a
    // bare `new Error('Interrupted')` that names no resource; without
    // `isInterrupted`, the other half is never called at all.
    const [only] = analyzeFile('p.ts', 'withRetry(op, id, { isInterrupted: w.a });').sites;
    expect(only?.verdict).toBe('dropped');
    expect(only?.present).toEqual(['isInterrupted']);
  });

  it('does NOT credit a conditional spread', () => {
    // `...(w && { isInterrupted })` reads as threading to a human skimming the
    // diff while being absent whenever `w` is falsy — the exact shape a checker
    // has to be stricter than a reviewer about.
    const [site] = analyzeFile(
      'p.ts',
      'withRetry(op, id, { ...(w && { isInterrupted: w.a, onInterrupted: w.b }) });'
    ).sites;
    expect(site?.verdict).toBe('dropped');
  });

  it('reports an unreadable options bag as `opaque` rather than skipping it', () => {
    const [site] = analyzeFile('p.ts', 'withRetry(op, id, sharedOptions);').sites;
    expect(site?.verdict).toBe('opaque');
    expect(site?.reason).toContain('not an object literal');
  });
});

describe('withRetry interrupt critic — the real tree', () => {
  it('finds every site interrupt-threaded today', () => {
    const report = buildReport(SCAN_DIR);
    expect(report.dropped).toBe(0);
    expect(report.opaque).toBe(0);
    expect(report.unshared).toBe(0);
    expect(report.leakedWatches).toBe(0);
    expect(report.threaded).toBe(report.sites);
    // Issue #2053 counted 11 under `providers/**`; `dynamodb-index-busy-delete.ts`
    // (issue #1952) is the twelfth. A floor rather than an equality so a new
    // provider does not fail this test for the wrong reason.
    expect(report.sites).toBeGreaterThanOrEqual(12);
    expect(report.filesWithSites).toBeGreaterThanOrEqual(5);
    // Every site reads off a binding from the ONE shared factory.
    expect(report.watches).toBeGreaterThanOrEqual(report.sites - 1);
  });

  it('counts the exempt site as exempt rather than as clean', () => {
    // The distinction is load-bearing: an exemption that stops being counted is
    // an exemption nobody re-reads.
    expect(buildReport(SCAN_DIR).exempt).toBeGreaterThanOrEqual(1);
  });

  it('passes end to end against `src/`', () => {
    const proc = run([]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('withRetry interrupt check OK');
  }, SPAWN_TIMEOUT_MS);
});

describe('withRetry interrupt critic — failure probes', () => {
  it('FAILS when the pair is dropped from a provider site (issue #2053 regression)', () => {
    const dir = copyTree();
    mutate(
      dir,
      'providers/elbv2-provider.ts',
      `                logger: this.maskedRetryLogger(maskSecrets),
                isInterrupted: watch.isInterrupted,
                onInterrupted: watch.onInterrupted,`,
      '                logger: this.maskedRetryLogger(maskSecrets),'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('providers/elbv2-provider.ts');
    expect(stderr).toContain('is not interruptible');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when only HALF the pair is dropped (issue #1952 site)', () => {
    const dir = copyTree();
    mutate(
      dir,
      'dynamodb-index-busy-delete.ts',
      `        isInterrupted: watch.isInterrupted,
        onInterrupted: watch.onInterrupted,`,
      '        isInterrupted: watch.isInterrupted,'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('dynamodb-index-busy-delete.ts');
    expect(stderr).toContain('`onInterrupted`');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a site hides its options bag behind an identifier', () => {
    // Written as a NEW file in the copied tree rather than by rewriting an
    // existing site: the point is that a bag the critic cannot read is reported
    // rather than skipped, and that holds wherever the site lives.
    const dir = copyTree();
    writeFileSync(
      join(dir, 'providers', 'probe-opaque-provider.ts'),
      'export const go = () => withRetry(op, id, sharedRetryOptions);\n'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('probe-opaque-provider.ts');
    expect(stderr).toContain('inline the options bag');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when the exemption goes stale', () => {
    // An allow-list entry whose subject no longer has anything to exempt is
    // dead text the next reader trusts. Strip the exempt file's own `withRetry`
    // and the entry has to report itself as inert.
    const dir = copyTree();
    writeFileSync(join(dir, 'describe-type.ts'), 'export const nothing = 1;\n');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('the exemption is inert');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a scanned file no longer parses', () => {
    // A file that does not parse contributes ZERO sites, which reads exactly
    // like a file that has none — and the floors have slack enough to hide it.
    const dir = copyTree();
    const path = join(dir, 'providers/ecr-provider.ts');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nfunction broken( {{{ \n`);
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('failed to parse');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the FILE-COUNT floor on a tree too small to be the provisioning tree', () => {
    const dir = scratch('cdkd-interrupt-empty-');
    writeFileSync(join(dir, 'lonely.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'describe-type.ts'), 'withRetry(op, id, { logger });\n');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('source files scanned');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the SITE floor alone, on a tree big enough to clear the file floor', () => {
    // Each floor needs its own probe. A one-file tree trips every floor at
    // once, so passing it proves only that SOME floor fires — and the site /
    // threaded / watch floors were never exercised on their own.
    const dir = scratch('cdkd-interrupt-nosites-');
    padFiles(dir, 70);
    writeFileSync(join(dir, 'describe-type.ts'), 'withRetry(op, id, { logger });\n');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('`withRetry` call sites found');
    // ...and NOT the file floor, which this tree clears.
    expect(stderr).not.toContain('source files scanned');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the WATCH-BINDING floor alone, with the site floors cleared', () => {
    // The quiet collapse this floor exists for: if alias resolution or the
    // `interrupt-watch.js` specifier match breaks, every site reads `unshared`
    // and the run fails for a misleading reason. The binding count is what
    // names the real cause.
    const dir = scratch('cdkd-interrupt-nowatch-');
    padFiles(dir, 70);
    writeFileSync(join(dir, 'describe-type.ts'), 'withRetry(op, id, { logger });\n');
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(dir, `site-${i}.ts`), threadedSite());
    }
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(0);
    expect(stderr).toBe('');

    // Now strip the factory bindings, keeping the sites: the watch floor is the
    // only one that can still speak.
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(
        join(dir, `site-${i}.ts`),
        threadedSite().replace(
          "import { startInterruptWatch } from '../interrupt-watch.js';",
          'const startInterruptWatch = makeLocalWatch;'
        )
      );
    }
    const after = runCheck(dir);
    expect(after.status).toBe(1);
    expect(after.stderr).toContain('`startInterruptWatch` bindings found');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS a leaked watch — dispose() outside a finally', () => {
    // The highest-value shape now that the latch is STICKY: a leaked watch stays
    // live for the process, so after one Ctrl-C every later wait aborts at once.
    const dir = copyTree();
    // Written as a new file rather than by unwinding a real `try`/`finally`,
    // which cannot be done by string surgery without breaking the parse — and a
    // parse failure is a DIFFERENT check firing, so the probe would pass for
    // the wrong reason.
    writeFileSync(
      join(dir, 'providers', 'probe-leaked-watch-provider.ts'),
      `${SHARED_WATCH}
export const go = async () => {
  await withRetry(op, id, { isInterrupted: watch.isInterrupted, onInterrupted: watch.onInterrupted });
  watch.dispose();
};
`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('is never `dispose()`d from a `finally`');
    expect(stderr).toContain('probe-leaked-watch-provider.ts');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS a site whose options are present but VALUE-BLIND', () => {
    const dir = copyTree();
    mutate(
      dir,
      'providers/elbv2-provider.ts',
      `                isInterrupted: watch.isInterrupted,
                onInterrupted: watch.onInterrupted,`,
      `                isInterrupted: () => false,
                onInterrupted: () => new Error('x'),`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('both option names are present but');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS loudly on a missing directory rather than stack-tracing', () => {
    const { status, stderr } = runCheck(join(scratch('cdkd-interrupt-gone-'), 'nope'));
    expect(status).toBe(1);
    expect(stderr).toContain('exempt path');
  }, SPAWN_TIMEOUT_MS);

  it('rejects an unrecognized argument instead of silently doing nothing', () => {
    const proc = run(['--scan-dirr=/tmp']);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('Unrecognized argument');
  }, SPAWN_TIMEOUT_MS);
});

describe('withRetry interrupt critic — exemption audit', () => {
  it('reports nothing against the real tree', () => {
    expect(auditExemptions(SCAN_DIR)).toEqual([]);
  });
});

describe('withRetry interrupt critic — entrypoint mechanics', () => {
  it('still runs when invoked through a SYMLINK', () => {
    // Node resolves the main module to its realpath while `argv[1]` keeps the
    // link, so an `import.meta.url === \`file://${argv[1]}\`` guard silently
    // exits 0 having done nothing — the exact vacuous green the floors forbid.
    const link = join(scratch('cdkd-interrupt-link-'), 'link.ts');
    symlinkSync(SCRIPT, link);
    const proc = run([], link);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('withRetry interrupt check OK');
  }, SPAWN_TIMEOUT_MS);

  it('emits parseable json', () => {
    const proc = run(['--json']);
    expect(proc.status).toBe(0);
    const jsonEnd = proc.stdout.lastIndexOf('}');
    const parsed = JSON.parse(proc.stdout.slice(0, jsonEnd + 1));
    expect(parsed.siteList.length).toBe(parsed.sites);
  }, SPAWN_TIMEOUT_MS);
});

describe('withRetry interrupt critic — CI wiring', () => {
  it('is registered as a Vite+ task with the cache disabled', () => {
    const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const entry = config.slice(config.indexOf("'audit:withretry-interrupt:check'"));
    expect(entry).toContain('scripts/check-withretry-interrupt.ts');
    // A cached replay would report a stale green without having looked.
    expect(entry.slice(0, entry.indexOf('},'))).toContain('cache: false');
  });

  it('is invoked by CI, not merely registered', () => {
    // Registered-but-uninvoked is how the task's own command string (including
    // its --experimental-strip-types flag) goes unexercised everywhere.
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('vp run audit:withretry-interrupt:check');
  });
});
