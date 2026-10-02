/**
 * Issue #2040 — the error-cause threading critic, scanning all of `src/` since
 * issue #2075.
 *
 * The real-tree sweep below is a gate in its own right, and the `--root=` seam
 * is how every failure probe is taken, against a scratch COPY of `src/`, so a
 * probe never writes to `src/`.
 * The critic is ALSO wired as a CI step (`vp run audit:provider-error-cause:check`),
 * which the last block here pins so the wiring cannot silently disappear.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  analyzeFile,
  buildErrorClassTable,
  buildReport,
  CAUSE_COMPOSERS,
  EXEMPTIONS,
  runSelfProbes,
} from '../../../scripts/check-provider-error-cause.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-provider-error-cause.ts');
const SRC_DIR = join(REPO_ROOT, 'src');
const PROVIDERS = 'provisioning/providers';
// Every probe below copies the whole of `src/` and spawns the critic over it.
const SPAWN_TIMEOUT_MS = CONTENDED_CASE_TIMEOUT_MS;

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

/** A throwaway COPY of the real `src/` tree, for mutation probes. */
function copySrcTree(): string {
  const dest = join(scratch('cdkd-cause-probe-'), 'src');
  cpSync(SRC_DIR, dest, { recursive: true });
  return dest;
}

function mutate(dir: string, file: string, from: string, to: string): void {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  // A probe anchored on a non-unique string proves nothing about WHICH site
  // moved, so uniqueness is asserted rather than assumed.
  expect(text.split(from).length - 1, `probe anchor must be unique in ${file}`).toBe(1);
  writeFileSync(path, text.replace(from, to));
}

function append(dir: string, file: string, text: string): void {
  const path = join(dir, file);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n${text}\n`);
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], script = SCRIPT): RunResult {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(proc.error, 'the critic must be spawnable').toBeUndefined();
  return proc;
}

const runCheck = (root: string) => run([`--root=${root}`]);

describe('provider error-cause critic — the real tree', () => {
  const report = buildReport(SRC_DIR);

  it('reports no site under src/ that drops its caught error', () => {
    const dropped = report.sites
      .filter((s) => s.verdict === 'dropped')
      .map((s) => `${s.file}:${s.line} (${s.errorClass})`);
    expect(dropped).toEqual([]);
    expect(report.exemptionMismatches).toEqual([]);
  });

  // FLOORS — the defense against COLLAPSE TOWARD ZERO.
  it('sees the whole src/ tree, the providers subtree included', () => {
    expect(report.filesScanned).toBeGreaterThanOrEqual(350);
    expect(report.providerFiles).toBeGreaterThanOrEqual(60);
    expect(report.constructions).toBeGreaterThanOrEqual(800);
  });

  it('sees sites OUTSIDE the providers subtree, which is what #2075 widened to', () => {
    const outside = report.sites.filter(
      (s) => s.context === 'catch' && !s.file.startsWith(`src/${PROVIDERS}/`)
    );
    expect(outside.length).toBeGreaterThanOrEqual(20);
    const dirs = new Set(outside.map((s) => s.file.split('/')[1]));
    for (const dir of ['assets', 'state', 'local', 'deployment']) expect(dirs).toContain(dir);
  });

  it('sees a substantial population of catch-sited constructions', () => {
    expect(report.catchSited).toBeGreaterThanOrEqual(350);
  });

  it('sees the HELPER-sited constructions a purely lexical rule would miss', () => {
    // The five `wrapError` / `wrapUpdateError` helpers. Each is ONE construction
    // serving many throw sites (33 in total), and every one builds its error
    // outside any lexical catch — so a regression to the lexical-only rule shows
    // up here and nowhere else.
    expect(report.helperSited).toBeGreaterThanOrEqual(12);
    const helpers = report.sites.filter((s) => s.context === 'helper');
    expect(helpers.every((s) => s.verdict === 'threaded')).toBe(true);
    expect(new Set(helpers.map((s) => s.file.split('/').pop())).size).toBeGreaterThanOrEqual(5);
  });

  it('sees that every construction with a caught value in scope threads it, or is exempt', () => {
    expect(report.threaded).toBeGreaterThanOrEqual(350);
    expect(report.threaded + report.exempt).toBe(report.catchSited + report.helperSited);
    // Every exemption covers exactly its declared count, and nothing else is exempt.
    expect(report.exempt).toBe(EXEMPTIONS.reduce((sum, e) => sum + e.count, 0));
  });

  it('sees the sites threaded THROUGH a registered composer, each composer in use', () => {
    expect(report.composerThreaded).toBeGreaterThanOrEqual(10);
    const composerFiles = new Set(
      report.sites.filter((s) => s.viaComposer).map((s) => s.file.replace(/^src\//, ''))
    );
    // One real consumer per composer, so no registration is dead weight.
    for (const file of [
      'assets/docker-asset-publisher.ts', // redactedDockerCause
      'state/s3-state-backend.ts', // normalizeAwsError
      'deployment/deploy-engine/provision.ts', // maskSecretsInError
    ]) {
      expect(composerFiles).toContain(file);
    }
    expect(CAUSE_COMPOSERS.size).toBe(3);
    // `viaComposer` must DISCRIMINATE: the reference site threads the caught
    // value directly, and most threaded sites do not go through a composer.
    expect(report.composerThreaded).toBeLessThan(report.threaded / 4);
    const reference = report.sites.filter(
      (s) => s.file.endsWith('sqs-queue-policy-provider.ts') && s.verdict === 'threaded'
    );
    expect(reference.length).toBeGreaterThan(0);
    expect(reference.some((s) => s.viaComposer)).toBe(false);
  });

  it('classifies the reference site (sqs-queue-policy-provider) as threaded', () => {
    const sites = report.sites.filter((s) => s.file.endsWith('sqs-queue-policy-provider.ts'));
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((s) => s.context === 'catch').every((s) => s.verdict === 'threaded')).toBe(
      true
    );
  });
});

describe('provider error-cause critic — the DERIVED error-class table', () => {
  const table = buildErrorClassTable();

  it('derives the hierarchy from error-handler.ts rather than hardcoding it', () => {
    expect(table.size).toBeGreaterThanOrEqual(20);
    expect(table.get('ProvisioningError')).toBe(4);
    expect(table.get('ResourceUpdateNotSupportedError')).toBe(3);
    expect(table.get('StateError')).toBe(1);
    expect(table.get('AssetError')).toBe(1);
  });

  it('picks up a provider-LOCAL subclass, which an allowlist silently misses', () => {
    // `HostedZoneNameNotFoundError` is declared inside route53-provider.ts and
    // extends ProvisioningError. A hardcoded class list never sees it, and — the
    // dangerous part — reports nothing about the omission.
    const sites = analyzeFile(
      'route53-like.ts',
      `class HostedZoneNameNotFoundError extends ProvisioningError {
         constructor(m: string, r: string, l: string, p?: string, cause?: Error) {
           super(m, r, l, p, cause);
         }
       }
       function f() {
         try { go(); } catch (error) {
           throw new HostedZoneNameNotFoundError('m', 'r', 'l', 'p');
         }
       }`
    );
    expect(sites.map((s) => s.verdict)).toEqual(['dropped']);
    expect(sites[0]?.errorClass).toBe('HostedZoneNameNotFoundError');
  });

  it('inherits the cause position when a subclass declares no constructor', () => {
    const sites = analyzeFile(
      'sub.ts',
      `class QuietError extends ProvisioningError {}
       function f() {
         try { go(); } catch (error) {
           throw new QuietError('m', 'r', 'l', 'p');
         }
       }`
    );
    expect(sites.map((s) => s.verdict)).toEqual(['dropped']);
  });

  it('ignores a class that does not descend from CdkdError', () => {
    const sites = analyzeFile(
      'unrelated.ts',
      `class Unrelated extends Error {}
       function f() { try { go(); } catch (error) { throw new Unrelated('m'); } }`
    );
    expect(sites).toEqual([]);
  });
});

describe('provider error-cause critic — shape classification', () => {
  const wrap = (body: string): string => `
    class P {
      async create(logicalId: string, resourceType: string): Promise<void> {
        ${body}
      }
    }
  `;
  const verdicts = (body: string): string[] =>
    analyzeFile('p.ts', wrap(body)).map((s) => s.verdict);

  it('accepts the reference shape (a const bound to the caught error)', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(String(error), resourceType, logicalId, undefined, cause);
      }`)
    ).toEqual(['threaded']);
  });

  it('accepts the inline conditional shape', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ProvisioningError(String(error), resourceType, logicalId, undefined,
          error instanceof Error ? error : undefined);
      }`)
    ).toEqual(['threaded']);
  });

  it('accepts the bare-identifier and `as`-cast shapes', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ProvisioningError('x', resourceType, logicalId, undefined, error);
      }`)
    ).toEqual(['threaded']);
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ProvisioningError('x', resourceType, logicalId, undefined, error as Error);
      }`)
    ).toEqual(['threaded']);
  });

  it('flags a catch site with the cause argument OMITTED', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ProvisioningError(String(error), resourceType, logicalId, physicalId);
      }`)
    ).toEqual(['dropped']);
  });

  it('flags a catch site whose cause argument is an explicit undefined', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ProvisioningError(String(error), resourceType, logicalId, physicalId, undefined);
      }`)
    ).toEqual(['dropped']);
  });

  // The realistic regression. It MENTIONS the binding, so a name-based check
  // credits it — and it is exactly as inert as passing nothing, because the new
  // Error carries no `$metadata` and no non-retryable marker.
  it('flags a cause DERIVED from the binding rather than being it', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        const cause = new Error(error instanceof Error ? error.message : String(error));
        throw new ProvisioningError('m', resourceType, logicalId, physicalId, cause);
      }`)
    ).toEqual(['dropped']);
  });

  it('flags a property access that merely mentions the binding', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ProvisioningError('m', resourceType, logicalId, physicalId, error.message);
      }`)
    ).toEqual(['dropped']);
    expect(
      verdicts(`try { await go(); } catch (result) {
        throw new ProvisioningError('m', resourceType, logicalId, physicalId, result.error);
      }`)
    ).toEqual(['dropped']);
  });

  it('flags a string or object standing in for the cause', () => {
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ProvisioningError('m', resourceType, logicalId, physicalId, String(error));
      }`)
    ).toEqual(['dropped']);
  });

  it('resolves an alias to the declaration NEAREST the use, not any in the file', () => {
    // A `const cause = ...` in a SIBLING block must not credit this site.
    expect(
      analyzeFile(
        'p.ts',
        `function f() {
           { const cause = new Error('x'); use(cause); }
           try { go(); } catch (error) {
             throw new ProvisioningError('m', 't', 'l', 'p', cause);
           }
         }`
      ).map((s) => s.verdict)
    ).toEqual(['dropped']);
  });

  it('does not flag a validation throw outside any catch', () => {
    const sites = analyzeFile('p.ts', wrap(`if (!resourceType) {
      throw new ProvisioningError('required', resourceType, logicalId);
    }`));
    expect(sites.map((s) => s.verdict)).toEqual(['no-cause-in-scope']);
    expect(sites[0]?.context).toBe('no-catch');
  });

  it('labels a bare `catch {` construction as catch-no-binding, not no-catch', () => {
    const sites = analyzeFile('p.ts', wrap(`try { await go(); } catch {
      throw new ProvisioningError('gone', resourceType, logicalId);
    }`));
    expect(sites.map((s) => s.verdict)).toEqual(['no-cause-in-scope']);
    expect(sites[0]?.context).toBe('catch-no-binding');
  });

  it('resolves the cause parameter position per error class', () => {
    // ResourceUpdateNotSupportedError's cause is the FOURTH parameter, not the
    // fifth — a single hardcoded index would misread every one of them.
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ResourceUpdateNotSupportedError(resourceType, logicalId, String(error),
          error instanceof Error ? error : undefined);
      }`)
    ).toEqual(['threaded']);
    expect(
      verdicts(`try { await go(); } catch (error) {
        throw new ResourceUpdateNotSupportedError(resourceType, logicalId, String(error));
      }`)
    ).toEqual(['dropped']);
  });
});

describe('provider error-cause critic — registered cause composers', () => {
  // `moduleId` places the synthetic file under the scanned root, which is what
  // a composer's import is resolved against.
  const verdicts = (source: string, moduleId = 'assets/p.ts'): string[] =>
    analyzeFile('p.ts', source, undefined, moduleId).map((s) => s.verdict);
  const site = (composerImport: string, call: string): string => `
    ${composerImport}
    export async function f(): Promise<void> {
      try { await go(); } catch (err) {
        throw new AssetError('m', ${call});
      }
    }`;

  it('accepts each registered composer imported from its own module', () => {
    expect(
      verdicts(
        site(
          "import { redactedDockerCause } from '../utils/docker-cmd.js';",
          "redactedDockerCause(err, ['tag'])"
        )
      )
    ).toEqual(['threaded']);
    expect(
      verdicts(
        site(
          "import { normalizeAwsError } from '../utils/error-handler.js';",
          'normalizeAwsError(err, { bucket: "b" })'
        )
      )
    ).toEqual(['threaded']);
    expect(
      verdicts(
        site(
          "import { maskSecretsInError } from '../deployment/secret-redaction.js';",
          'maskSecretsInError(err, bag)'
        )
      )
    ).toEqual(['threaded']);
  });

  it('accepts a composer through a const alias and an aliased import', () => {
    expect(
      verdicts(`import { normalizeAwsError as norm } from '../utils/error-handler.js';
        try { go(); } catch (error) {
          const normalized = norm(error, {});
          throw new StateError('m', normalized);
        }`)
    ).toEqual(['threaded']);
  });

  it('resolves the import RELATIVE to the file, so a deeper file needs a deeper path', () => {
    const source = site(
      "import { redactedDockerCause } from '../utils/docker-cmd.js';",
      "redactedDockerCause(err, ['tag'])"
    );
    expect(verdicts(source, 'assets/p.ts')).toEqual(['threaded']);
    // From `deployment/deploy-engine/`, `../utils/` is `deployment/utils/`.
    expect(verdicts(source, 'deployment/deploy-engine/p.ts')).toEqual(['dropped']);
  });

  it('refuses a composer imported TYPE-only, or via a namespace', () => {
    expect(
      verdicts(
        site(
          "import { type redactedDockerCause } from '../utils/docker-cmd.js';",
          "redactedDockerCause(err, ['tag'])"
        )
      )
    ).toEqual(['dropped']);
    expect(
      verdicts(
        site(
          "import type { redactedDockerCause } from '../utils/docker-cmd.js';",
          "redactedDockerCause(err, ['tag'])"
        )
      )
    ).toEqual(['dropped']);
    expect(
      verdicts(
        site("import * as d from '../utils/docker-cmd.js';", "d.redactedDockerCause(err, ['tag'])")
      )
    ).toEqual(['dropped']);
  });

  it('refuses a composer whose registered argument is not the caught value', () => {
    // The caught value in the WRONG position: `args` is not the cause source.
    expect(
      verdicts(
        site(
          "import { redactedDockerCause } from '../utils/docker-cmd.js';",
          'redactedDockerCause(undefined, [String(err)])'
        )
      )
    ).toEqual(['dropped']);
  });

  it('refuses a composer name SHADOWED by a local const', () => {
    expect(
      verdicts(`import { redactedDockerCause } from '../utils/docker-cmd.js';
        export function f(): void {
          const redactedDockerCause = (e: unknown) => new Error(String(e));
          try { go(); } catch (err) {
            throw new AssetError('m', redactedDockerCause(err));
          }
        }`)
    ).toEqual(['dropped']);
  });

  it('refuses a composer shadowed by a function, a parameter, a destructuring or a catch binding', () => {
    const imp = "import { redactedDockerCause } from '../utils/docker-cmd.js';";
    const call = "throw new AssetError('m', redactedDockerCause(err, ['tag']));";
    for (const body of [
      `export function f(): void {
        function redactedDockerCause(e: unknown, a: string[]) { return new Error(String(e)); }
        try { go(); } catch (err) { ${call} }
      }`,
      `export function f(redactedDockerCause: (e: unknown, a: string[]) => Error): void {
        try { go(); } catch (err) { ${call} }
      }`,
      `export function f(fake: any): void {
        const { redactedDockerCause } = fake;
        try { go(); } catch (err) { ${call} }
      }`,
      `export function f(): void {
        try { go(); } catch (redactedDockerCause) {
          try { go(); } catch (err) { ${call} }
        }
      }`,
    ]) {
      expect(verdicts(`${imp}\n${body}`), body).toEqual(['dropped']);
    }
  });

  it('refuses an UNREGISTERED call even when it is handed the caught value', () => {
    expect(
      verdicts(
        site("import { describeDockerFailure } from '../utils/docker-cmd.js';", 'describeDockerFailure(err)')
      )
    ).toEqual(['dropped']);
  });
});

describe('provider error-cause critic — exemptions must match EXACTLY', () => {
  const exemption = {
    file: 'x.ts',
    errorClass: 'SynthesisError',
    within: 'readIt',
    count: 1,
    reason: 'test',
  };
  const tree = (body: string): string => {
    const dir = scratch('cdkd-cause-exempt-');
    writeFileSync(join(dir, 'x.ts'), body);
    return dir;
  };
  const dropping = (n: number): string =>
    `export function readIt(): void {\n${Array.from(
      { length: n },
      () => "  try { go(); } catch (error) { throw new SynthesisError('m'); }"
    ).join('\n')}\n}\n`;

  it('turns exactly the declared number of dropped sites into `exempt`', () => {
    const report = buildReport(tree(dropping(1)), undefined, [exemption]);
    expect(report.sites.map((s) => s.verdict)).toEqual(['exempt']);
    expect(report.exemptionMismatches).toEqual([]);
  });

  it('absorbs NOTHING when a second site drops its cause in the exempted function', () => {
    const report = buildReport(tree(dropping(2)), undefined, [exemption]);
    expect(report.sites.map((s) => s.verdict)).toEqual(['dropped', 'dropped']);
    expect(report.exemptionMismatches).toEqual([{ exemption, matched: 2 }]);
  });

  it('reports a STALE exemption that no longer matches anything', () => {
    const report = buildReport(
      tree("export function readIt(): void { try { go(); } catch (error) { throw new SynthesisError('m', error as Error); } }\n"),
      undefined,
      [exemption]
    );
    expect(report.sites.map((s) => s.verdict)).toEqual(['threaded']);
    expect(report.exemptionMismatches).toEqual([{ exemption, matched: 0 }]);
  });

  it('does not exempt the same class and function in a DIFFERENT file', () => {
    const dir = tree(dropping(1));
    writeFileSync(join(dir, 'y.ts'), dropping(1));
    const report = buildReport(dir, undefined, [exemption]);
    const byFile = Object.fromEntries(report.sites.map((s) => [s.file.split('/').pop(), s.verdict]));
    expect(byFile).toEqual({ 'x.ts': 'exempt', 'y.ts': 'dropped' });
  });

  it('does not exempt the same class in a DIFFERENT function', () => {
    const report = buildReport(tree(dropping(1).replace('readIt', 'other')), undefined, [exemption]);
    expect(report.sites.map((s) => s.verdict)).toEqual(['dropped']);
  });
});

describe('provider error-cause critic — helper (non-lexical) indirection', () => {
  it('checks a helper the catch hands its binding to', () => {
    const sites = analyzeFile(
      'p.ts',
      `class P {
         run() { try { go(); } catch (error) { throw this.wrapError(error, 'op'); } }
         wrapError(err: unknown, op: string): ProvisioningError {
           return new ProvisioningError(op, 't', 'l', 'p');
         }
       }`
    );
    expect(sites.map((s) => s.verdict)).toEqual(['dropped']);
    expect(sites[0]?.context).toBe('helper');
    expect(sites[0]?.caughtBinding).toBe('err');
  });

  it('accepts a helper that threads the caught value', () => {
    const sites = analyzeFile(
      'p.ts',
      `class P {
         run() { try { go(); } catch (error) { throw this.wrapError(error, 'op'); } }
         wrapError(err: unknown, op: string): ProvisioningError {
           const cause = err instanceof Error ? err : undefined;
           return new ProvisioningError(op, 't', 'l', 'p', cause);
         }
       }`
    );
    expect(sites.map((s) => s.verdict)).toEqual(['threaded']);
  });

  it('follows a helper calling a helper (fixpoint)', () => {
    const sites = analyzeFile(
      'p.ts',
      `class P {
         run() { try { go(); } catch (error) { throw this.outer(error); } }
         outer(e: unknown): ProvisioningError { return this.inner(e); }
         inner(deep: unknown): ProvisioningError {
           return new ProvisioningError('m', 't', 'l', 'p');
         }
       }`
    );
    expect(sites.map((s) => s.verdict)).toEqual(['dropped']);
    expect(sites[0]?.caughtBinding).toBe('deep');
  });

  it('does not check a helper that is never handed a caught value', () => {
    const sites = analyzeFile(
      'p.ts',
      `class P {
         run() { throw this.build('op'); }
         build(op: string): ProvisioningError {
           return new ProvisioningError(op, 't', 'l', 'p');
         }
       }`
    );
    expect(sites.map((s) => s.verdict)).toEqual(['no-cause-in-scope']);
  });

  it('does not treat a NON-caught argument as the caught value', () => {
    // Only the argument that IS the binding seeds a helper parameter.
    const sites = analyzeFile(
      'p.ts',
      `class P {
         run() { try { go(); } catch (error) { throw this.wrapError('op', error); } }
         wrapError(op: string, err: unknown): ProvisioningError {
           const cause = err instanceof Error ? err : undefined;
           return new ProvisioningError(op, 't', 'l', 'p', cause);
         }
       }`
    );
    expect(sites.map((s) => s.verdict)).toEqual(['threaded']);
    expect(sites[0]?.caughtBinding).toBe('err');
  });
});

describe('provider error-cause critic — the SELF-PROBE (collapse toward green)', () => {
  it('passes on the healthy checker', () => {
    expect(runSelfProbes()).toEqual([]);
  });

  it('would notice a classifier that stopped discriminating', () => {
    // The self-probe is only worth anything if it contains cases whose expected
    // verdict is `dropped`; a probe set of only-threaded cases passes under
    // "everything is threaded". Guard the guard.
    const source = readFileSync(SCRIPT, 'utf8');
    const droppedExpectations = source.match(/expected: \['dropped'\]/g) ?? [];
    expect(droppedExpectations.length).toBeGreaterThanOrEqual(5);
  });
});

describe('provider error-cause critic — probes against the REAL src/ tree', () => {
  it('passes on an unmutated copy (negative control)', () => {
    const { status, stdout } = runCheck(copySrcTree());
    expect(status, stdout).toBe(0);
    expect(stdout).toContain('error-cause check OK');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real provider stops threading its cause', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      `${PROVIDERS}/iam-role-provider.ts`,
      '            roleName,\n            cause\n          )',
      '            roleName\n          )'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('iam-role-provider.ts');
    expect(stderr).toContain('NOT threaded as `cause`');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real provider passes undefined in the cause position', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      `${PROVIDERS}/iam-role-provider.ts`,
      '            roleName,\n            cause\n          )',
      '            roleName,\n            undefined\n          )'
    );
    expect(runCheck(dir).status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real provider threads an unrelated error', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      `${PROVIDERS}/ecr-provider.ts`,
      '          physicalId,\n          error\n        );',
      "          physicalId,\n          new Error('unrelated')\n        );"
    );
    expect(runCheck(dir).status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  // BLOCKER 3's shape, on real code: the cause is DERIVED from the caught error.
  it('FAILS when a real provider derives a new Error from the caught one', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      `${PROVIDERS}/sqs-queue-policy-provider.ts`,
      '      const cause = error instanceof Error ? error : undefined;\n      throw new ProvisioningError(\n        `Failed to create SQS queue policy',
      '      const cause = new Error(error instanceof Error ? error.message : String(error));\n      throw new ProvisioningError(\n        `Failed to create SQS queue policy'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('sqs-queue-policy-provider.ts');
  }, SPAWN_TIMEOUT_MS);

  // BLOCKER 1's shape, on real code: one helper edit un-threads 7 throw sites.
  it('FAILS when a real wrapError HELPER stops threading its cause', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      `${PROVIDERS}/rds-dbproxy-provider.ts`,
      // The helper builds its error inside a `wrapMaskedAwsError` callback
      // since go-to-k/cdkd#4339; the probe drops the cause from that build.
      '          physicalId,\n          cause\n        )\n    );\n  }\n}',
      '          physicalId\n        )\n    );\n  }\n}'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('rds-dbproxy-provider.ts');
    expect(stderr).toContain('(helper)');
  }, SPAWN_TIMEOUT_MS);

  // BLOCKER 2's shape, on real code: a file-local ProvisioningError subclass.
  it('FAILS when a provider-LOCAL error subclass drops its cause', () => {
    const dir = copySrcTree();
    append(
      dir,
      `${PROVIDERS}/route53-provider.ts`,
      `export function probeLocalSubclass(resourceType: string, logicalId: string): void {
         try { throw new Error('boom'); } catch (error) {
           throw new HostedZoneNameNotFoundError('probe', resourceType, logicalId, 'zid');
         }
       }`
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('HostedZoneNameNotFoundError');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS loudly when a provider file no longer parses', () => {
    // A file that does not parse contributes ZERO sites, which reads exactly
    // like a clean file — and the floors have enough slack to hide several.
    const dir = copySrcTree();
    append(dir, `${PROVIDERS}/ecr-provider.ts`, 'function broken( {{{ ');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('failed to parse');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the floors on a tree too small to be src/', () => {
    const dir = scratch('cdkd-cause-empty-');
    writeFileSync(join(dir, 'lonely.ts'), 'export const x = 1;\n');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('files scanned');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the providers-subtree floor when that subtree drops out of an otherwise large scan', () => {
    const dir = copySrcTree();
    rmSync(join(dir, PROVIDERS), { recursive: true, force: true });
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain(`files under ${PROVIDERS}/`);
  }, SPAWN_TIMEOUT_MS);

  // #2075's widening, on real code OUTSIDE the providers subtree.
  it('FAILS when a real src/local site stops threading its cause', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      'local/ecr-puller.ts',
      "        \"Verify the role exists and its trust policy permits the caller's identity to assume it.\",\n      err instanceof Error ? err : undefined\n",
      "        \"Verify the role exists and its trust policy permits the caller's identity to assume it.\"\n"
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('src/local/ecr-puller.ts');
    expect(stderr).toContain('NOT threaded as `cause`');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real composer site swaps the composer for an inert derived Error', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      'assets/docker-asset-publisher.ts',
      '        `Docker push failed: ${describeDockerFailure(err, pushArgs)}`,\n        redactedDockerCause(err, pushArgs)',
      '        `Docker push failed: ${describeDockerFailure(err, pushArgs)}`,\n        new Error(describeDockerFailure(err, pushArgs))'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('src/assets/docker-asset-publisher.ts');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real composer is imported from a module that is not its own', () => {
    const dir = copySrcTree();
    // The import no longer resolves to the registered module, so all four
    // docker sites in the file lose their composer.
    mutate(
      dir,
      'assets/docker-asset-publisher.ts',
      "} from '../utils/docker-cmd.js';",
      "} from './docker-cmd.js';"
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr.match(/src\/assets\/docker-asset-publisher\.ts:\d+: AssetError/g)).toHaveLength(4);
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real normalizeAwsError site hands the composer something else', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      'state/s3-state-backend.ts',
      "      const normalized = normalizeAwsError(error, {\n        bucket: this.config.bucket,\n        operation: 'ListObjectsV2',",
      "      const normalized = normalizeAwsError(undefined, {\n        bucket: this.config.bucket,\n        operation: 'ListObjectsV2',"
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('src/state/s3-state-backend.ts');
    expect(stderr).toContain('StateError');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a new dropped site lands in an EXEMPTED function', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      'local/docker-image-builder.ts',
      '      throw new LocalInvokeBuildError(e.message);\n',
      "      throw new LocalInvokeBuildError(e.message);\n    }\n    if (e instanceof RangeError) {\n      throw new LocalInvokeBuildError('probe');\n"
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('A NEW site dropped its cause in an exempted function');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS on a STALE exemption once its site threads the cause', () => {
    const dir = copySrcTree();
    mutate(
      dir,
      'local/docker-image-builder.ts',
      '      throw new LocalInvokeBuildError(e.message);\n',
      '      throw new LocalInvokeBuildError(e.message, e);\n'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('The exemption no longer matches');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS loudly on a missing directory rather than stack-tracing', () => {
    const { status, stderr } = runCheck(join(scratch('cdkd-cause-gone-'), 'nope'));
    expect(status).toBe(1);
    expect(stderr).toContain('cannot read directory');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the composer floor when the population drifts off composers', () => {
    const dir = copySrcTree();
    // Threading the raw value instead keeps every site `threaded` (no drop to
    // report), so only the per-shape floor can see the arm go unexercised.
    for (const [from, to] of [
      ['redactedDockerCause(err, retagArgs)', 'err as Error'],
      ['redactedDockerCause(err, loginArgs)', 'err as Error'],
      ['redactedDockerCause(err, tagArgs)', 'err as Error'],
      ['redactedDockerCause(err, pushArgs)', 'err as Error'],
    ] as const) {
      mutate(dir, 'assets/docker-asset-publisher.ts', from, to);
    }
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('constructions threaded through a registered composer');
    expect(stderr).not.toContain('NOT threaded as `cause`');
  }, SPAWN_TIMEOUT_MS);

  it('refuses an EMPTY --root= rather than walking the cwd', () => {
    const proc = run(['--root=']);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('--root= requires a value');
  }, SPAWN_TIMEOUT_MS);

  it('rejects an unrecognized argument instead of silently doing nothing', () => {
    const proc = run(['--providers-dir=/tmp']);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('Unrecognized argument');
  }, SPAWN_TIMEOUT_MS);
});

describe('provider error-cause critic — entrypoint mechanics', () => {
  it('still runs when invoked through a SYMLINK', () => {
    // Node resolves the main module to its realpath while `argv[1]` keeps the
    // link, so a `import.meta.url === \`file://${argv[1]}\`` guard silently
    // exits 0 having done nothing — the exact vacuous green the floors forbid.
    const link = join(scratch('cdkd-cause-link-'), 'link.ts');
    symlinkSync(SCRIPT, link);
    const proc = run([], link);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('error-cause check OK');
  }, SPAWN_TIMEOUT_MS);

  it('emits COMPLETE json on a pipe', () => {
    // `process.exit()` truncates a large payload mid-write; the report is ~167 KB.
    const proc = run(['--json']);
    expect(proc.status).toBe(0);
    const jsonEnd = proc.stdout.lastIndexOf('}');
    const parsed = JSON.parse(proc.stdout.slice(0, jsonEnd + 1));
    expect(parsed.sites.length).toBe(parsed.constructions);
    expect(parsed.constructions).toBeGreaterThanOrEqual(800);
  }, SPAWN_TIMEOUT_MS);
});

describe('provider error-cause critic — CI wiring', () => {
  it('is registered as a Vite+ task with the cache disabled', () => {
    const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const entry = config.slice(config.indexOf("'audit:provider-error-cause:check'"));
    expect(entry).toContain('scripts/check-provider-error-cause.ts');
    // A cached replay would report a stale green without having looked.
    expect(entry.slice(0, entry.indexOf('},'))).toContain('cache: false');
  });

  it('is invoked by CI, not merely registered', () => {
    // Registered-but-uninvoked is how the task's own command string (including
    // its --experimental-strip-types flag) goes unexercised everywhere.
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('vp run audit:provider-error-cause:check');
  });
});
