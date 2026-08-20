/**
 * Issue #2040 — the provider error-cause threading critic.
 *
 * The real-tree sweep below is a gate in its own right, and the `--providers-dir=`
 * seam is how every failure probe is taken, so a probe never writes to `src/`.
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
  runSelfProbes,
} from '../../../scripts/check-provider-error-cause.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-provider-error-cause.ts');
const PROVIDERS_DIR = join(REPO_ROOT, 'src/provisioning/providers');
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

/** A throwaway COPY of the real providers tree, for mutation probes. */
function copyProvidersTree(): string {
  const dest = join(scratch('cdkd-cause-probe-'), 'providers');
  cpSync(PROVIDERS_DIR, dest, { recursive: true });
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

const runCheck = (providersDir: string) => run([`--providers-dir=${providersDir}`]);

describe('provider error-cause critic — the real tree', () => {
  const report = buildReport(PROVIDERS_DIR);

  it('reports no provider site that drops its caught error', () => {
    const dropped = report.sites
      .filter((s) => s.verdict === 'dropped')
      .map((s) => `${s.file}:${s.line} (${s.errorClass})`);
    expect(dropped).toEqual([]);
  });

  // FLOORS — the defense against COLLAPSE TOWARD ZERO.
  it('sees the whole providers tree', () => {
    expect(report.filesScanned).toBeGreaterThanOrEqual(60);
    expect(report.constructions).toBeGreaterThanOrEqual(600);
  });

  it('sees a substantial population of catch-sited constructions', () => {
    expect(report.catchSited).toBeGreaterThanOrEqual(250);
  });

  it('sees the HELPER-sited constructions a purely lexical rule would miss', () => {
    // The five `wrapError` / `wrapUpdateError` helpers. Each is ONE construction
    // serving many throw sites (33 in total), and every one builds its error
    // outside any lexical catch — so a regression to the lexical-only rule shows
    // up here and nowhere else.
    expect(report.helperSited).toBeGreaterThanOrEqual(5);
    const helpers = report.sites.filter((s) => s.context === 'helper');
    expect(helpers.every((s) => s.verdict === 'threaded')).toBe(true);
    expect(new Set(helpers.map((s) => s.file.split('/').pop())).size).toBeGreaterThanOrEqual(5);
  });

  it('sees that every construction with a caught value in scope threads it', () => {
    expect(report.threaded).toBeGreaterThanOrEqual(250);
    expect(report.threaded).toBe(report.catchSited + report.helperSited);
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

describe('provider error-cause critic — probes against the REAL providers tree', () => {
  it('passes on an unmutated copy (negative control)', () => {
    const { status, stdout } = runCheck(copyProvidersTree());
    expect(status, stdout).toBe(0);
    expect(stdout).toContain('provider error-cause check OK');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real provider stops threading its cause', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'iam-role-provider.ts',
      '        roleName,\n        cause\n      );',
      '        roleName\n      );'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('iam-role-provider.ts');
    expect(stderr).toContain('NOT threaded as `cause`');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real provider passes undefined in the cause position', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'iam-role-provider.ts',
      '        roleName,\n        cause\n      );',
      '        roleName,\n        undefined\n      );'
    );
    expect(runCheck(dir).status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('FAILS when a real provider threads an unrelated error', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'ecr-provider.ts',
      '          physicalId,\n          error\n        );',
      "          physicalId,\n          new Error('unrelated')\n        );"
    );
    expect(runCheck(dir).status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  // BLOCKER 3's shape, on real code: the cause is DERIVED from the caught error.
  it('FAILS when a real provider derives a new Error from the caught one', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'sqs-queue-policy-provider.ts',
      '      const cause = error instanceof Error ? error : undefined;\n      throw new ProvisioningError(\n        `Failed to create SQS queue policy',
      '      const cause = new Error(error instanceof Error ? error.message : String(error));\n      throw new ProvisioningError(\n        `Failed to create SQS queue policy'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('sqs-queue-policy-provider.ts');
  }, SPAWN_TIMEOUT_MS);

  // BLOCKER 1's shape, on real code: one helper edit un-threads 7 throw sites.
  it('FAILS when a real wrapError HELPER stops threading its cause', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'rds-dbproxy-provider.ts',
      '      physicalId,\n      cause\n    );\n  }\n}',
      '      physicalId\n    );\n  }\n}'
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('rds-dbproxy-provider.ts');
    expect(stderr).toContain('(helper)');
  }, SPAWN_TIMEOUT_MS);

  // BLOCKER 2's shape, on real code: a file-local ProvisioningError subclass.
  it('FAILS when a provider-LOCAL error subclass drops its cause', () => {
    const dir = copyProvidersTree();
    append(
      dir,
      'route53-provider.ts',
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
    const dir = copyProvidersTree();
    append(dir, 'ecr-provider.ts', 'function broken( {{{ ');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('failed to parse');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS the floors on a tree too small to be the providers tree', () => {
    const dir = scratch('cdkd-cause-empty-');
    writeFileSync(join(dir, 'lonely.ts'), 'export const x = 1;\n');
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('provider files scanned');
  }, SPAWN_TIMEOUT_MS);

  it('FAILS loudly on a missing directory rather than stack-tracing', () => {
    const { status, stderr } = runCheck(join(scratch('cdkd-cause-gone-'), 'nope'));
    expect(status).toBe(1);
    expect(stderr).toContain('cannot read directory');
  }, SPAWN_TIMEOUT_MS);

  it('rejects an unrecognized argument instead of silently doing nothing', () => {
    const proc = run(['--providers-dirr=/tmp']);
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
    expect(proc.stdout).toContain('provider error-cause check OK');
  }, SPAWN_TIMEOUT_MS);

  it('emits COMPLETE json on a pipe', () => {
    // `process.exit()` truncates a large payload mid-write; the report is ~167 KB.
    const proc = run(['--json']);
    expect(proc.status).toBe(0);
    const jsonEnd = proc.stdout.lastIndexOf('}');
    const parsed = JSON.parse(proc.stdout.slice(0, jsonEnd + 1));
    expect(parsed.sites.length).toBe(parsed.constructions);
    expect(parsed.constructions).toBeGreaterThanOrEqual(600);
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
