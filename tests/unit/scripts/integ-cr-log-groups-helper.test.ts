import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Checks for `tests/integration/cr-log-groups.sh`, the shared sweep of the
 * `/aws/lambda/<stack>-` log groups Lambda creates on first invoke and no
 * stack owns (issue #3885).
 *
 * The sweep DELETES what a prefix listing returns, so its dangerous failure is
 * a widened scope: an empty stack name collapses the prefix to `/aws/lambda/`,
 * every Lambda log group in the region. Every refusal case asserts the guard
 * fired BEFORE any AWS call, via a fake `aws` on PATH that records each
 * invocation; the positive control proves that recorder can see a call.
 *
 * The last block is the population check: a fixture whose CDK app sets
 * `autoDeleteObjects: true` runs CDK's auto-delete handler Lambda, so its
 * `verify.sh` must sweep that Lambda's log group.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');
const HELPER = join(INTEG_ROOT, 'cr-log-groups.sh');

let sandbox: string;
let fakeBin: string;
let calls: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cdkd-crlg-'));
  fakeBin = join(sandbox, 'bin');
  calls = join(sandbox, 'aws-calls');
  mkdirSync(fakeBin);
  // Records every call. `describe-log-groups` prints $FAKE_LIST (the listing
  // under test) or, with FAKE_LIST_FAIL=1, fails like a throttle / auth error;
  // `delete-log-group` succeeds unless its name is $FAKE_DELETE_FAIL.
  const fake = join(fakeBin, 'aws');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      `echo "$*" >> "${calls}"`,
      'case "$2" in',
      '  describe-log-groups)',
      '    [ "${FAKE_LIST_FAIL:-}" = 1 ] && { echo "fake aws: throttled" >&2; exit 255; }',
      '    printf "%s\\n" "${FAKE_LIST:-}" ;;',
      '  delete-log-group)',
      '    [ "$4" = "${FAKE_DELETE_FAIL:-}" ] && exit 255 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n')
  );
  chmodSync(fake, 0o755);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly string[];
}

/** Each case spawns bash; declared per `.claude/rules/testing.md`. */
const SPAWN_TIMEOUT_MS = 30_000;

interface FakeAws {
  readonly list?: string;
  readonly listFails?: boolean;
  readonly deleteFails?: string;
}

function run(stack: string, region: string, fake: FakeAws = {}): Run {
  if (existsSync(calls)) rmSync(calls);
  // `set -eu` in the CALLER, as in a verify.sh: the helper must neither trip
  // it nor fail its caller.
  const script = [
    'set -euo pipefail',
    `. ${JSON.stringify(HELPER)}`,
    `sweep_stack_lambda_log_groups ${JSON.stringify(stack)} ${JSON.stringify(region)}`,
    'echo "caller-continued"',
  ].join('\n');
  const res = spawnSync('/bin/bash', ['-c', script], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      FAKE_LIST: fake.list ?? '',
      FAKE_LIST_FAIL: fake.listFails ? '1' : '',
      FAKE_DELETE_FAIL: fake.deleteFails ?? '',
    },
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
  };
}

describe('tests/integration/cr-log-groups.sh', () => {
  it('finds the helper it claims to test', () => {
    expect(readFileSync(HELPER, 'utf8')).toContain('sweep_stack_lambda_log_groups()');
  });

  it(
    'lists under /aws/lambda/<stack>- with the trailing dash (positive control)',
    () => {
      const r = run('CdkdFooExample', 'us-east-1');
      expect(r.status).toBe(0);
      expect(r.calls).toEqual([
        'logs describe-log-groups --log-group-name-prefix /aws/lambda/CdkdFooExample- --region us-east-1 --query logGroups[].logGroupName --output text',
      ]);
      expect(r.stdout).toContain('swept 0 Lambda log group(s) under /aws/lambda/CdkdFooExample-');
      expect(r.stdout).toContain('caller-continued');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'accepts a two-digit region suffix',
    () => {
      expect(run('CdkdFoo', 'us-east-10').calls).toHaveLength(1);
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'deletes each listed group in scope, and never one outside the prefix',
    () => {
      const r = run('CdkdFoo', 'us-west-2', {
        list: [
          '/aws/lambda/CdkdFoo-CustomS3AutoDeleteObjectsCustomR-1a2b3c4d',
          '/aws/lambda/CdkdFoo-OnEvent74718524',
          // None of these can come back from a real prefix listing; the
          // per-name re-check is what keeps a bad listing from the delete.
          '/aws/lambda/CdkdFooBar-Handler',
          '/aws/lambda/CdkdFoo-',
          'None',
        ].join('\t'),
      });
      expect(r.status).toBe(0);
      const deletes = r.calls.filter((c) => c.startsWith('logs delete-log-group'));
      expect(deletes).toEqual([
        'logs delete-log-group --log-group-name /aws/lambda/CdkdFoo-CustomS3AutoDeleteObjectsCustomR-1a2b3c4d --region us-west-2',
        'logs delete-log-group --log-group-name /aws/lambda/CdkdFoo-OnEvent74718524 --region us-west-2',
      ]);
      expect(r.stdout).toContain('swept 2 Lambda log group(s)');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'reads a paginated listing (one tab-separated line per page)',
    () => {
      const r = run('CdkdFoo', 'us-east-1', {
        list: '/aws/lambda/CdkdFoo-A\t/aws/lambda/CdkdFoo-B\n/aws/lambda/CdkdFoo-C',
      });
      expect(r.calls.filter((c) => c.startsWith('logs delete-log-group'))).toHaveLength(3);
      expect(r.stdout).toContain('swept 3 Lambda log group(s)');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'counts only the deletes that succeeded, and keeps going past a failed one',
    () => {
      const r = run('CdkdFoo', 'us-east-1', {
        list: '/aws/lambda/CdkdFoo-A\t/aws/lambda/CdkdFoo-B',
        deleteFails: '/aws/lambda/CdkdFoo-A',
      });
      expect(r.calls.filter((c) => c.startsWith('logs delete-log-group'))).toHaveLength(2);
      expect(r.stdout).toContain('swept 1 Lambda log group(s)');
      expect(r.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'a failed listing warns, deletes nothing, and never fails a `set -euo pipefail` caller',
    () => {
      const r = run('CdkdFoo', 'us-east-1', { listFails: true });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('caller-continued');
      expect(r.stderr).toContain('could not list Lambda log groups under /aws/lambda/CdkdFoo-');
      // "nothing to sweep" must not be printed for a listing that never ran.
      expect(r.stdout).not.toContain('swept');
      expect(r.calls.filter((c) => c.startsWith('logs delete-log-group'))).toEqual([]);
    },
    SPAWN_TIMEOUT_MS
  );

  const REFUSED: readonly (readonly [string, string, string])[] = [
    ['', 'us-east-1', 'empty stack — prefix collapses to /aws/lambda/'],
    ['Cdk', 'us-east-1', 'shorter than 4 characters'],
    ['1Cdkd', 'us-east-1', 'does not start with a letter'],
    ['Cdkd*', 'us-east-1', 'glob character'],
    ['Cdkd/Foo', 'us-east-1', 'slash'],
    ['Cdkd Foo', 'us-east-1', 'space'],
    ['CdkdFoo', '', 'empty region'],
    ['CdkdFoo', 'east', 'not a region code'],
    ['CdkdFoo', 'US-east-1', 'upper-case region'],
    ['CdkdFoo', 'us-east-1abc', 'trailing garbage after the region digit'],
    ['CdkdFoo', 'us-ea;t-1', 'character outside [a-z0-9-]'],
  ];
  for (const [stack, region, why] of REFUSED) {
    it(
      `refuses stack=${JSON.stringify(stack)} region=${JSON.stringify(region)} (${why}) before any aws call`,
      () => {
        const r = run(stack, region, { list: '/aws/lambda/Anything-Else' });
        expect(r.calls).toEqual([]);
        expect(r.stderr).toContain('teardown sweep refused');
        // A refusal never fails the caller, which is usually `cleanup`.
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('caller-continued');
        expect(r.stdout).not.toContain('swept');
      },
      SPAWN_TIMEOUT_MS
    );
  }
});

/** Every `*.ts` under a fixture's `lib/`, recursively. */
function libSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : libSources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/** The real-AWS runner a fixture carries: `verify.sh`, or `run.sh` (migrate-from-cfn). */
function runnerOf(name: string): string | undefined {
  return ['verify.sh', 'run.sh']
    .map((f) => join(INTEG_ROOT, name, f))
    .find((f) => existsSync(f));
}

/** A call passing one of the fixtures' stack variables, not any argument. */
const HELPER_CALL = /^\s*sweep_stack_lambda_log_groups "\$\{(STACK|PRODUCER|stack)\}" "\$\{(AWS_)?REGION\}"\s*$/;
const HELPER_SOURCE = /^\s*\.\s+"?(\$\{TEST_DIR\}\/)?\.\.\/cr-log-groups\.sh"?\s*$/m;

describe('autoDeleteObjects fixtures sweep their Lambda log groups', () => {
  const population = readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && runnerOf(e.name) !== undefined)
    .map((e) => e.name)
    .filter((name) =>
      libSources(join(INTEG_ROOT, name, 'lib')).some((f) =>
        // Line-anchored, so a comment NAMING the prop (`// ... autoDeleteObjects:
        // true stamps`) is not read as setting it.
        /^\s*autoDeleteObjects:\s*true/m.test(readFileSync(f, 'utf8'))
      )
    );

  /** Fixtures that set the prop but never deploy, so no Lambda ever runs. */
  const NEVER_DEPLOYS: Readonly<Record<string, string>> = {
    'local-start-cloudfront': 'serves the synthesized assembly locally; no AWS call',
  };

  it('finds the population (floor), and every exemption is still in it and still never deploys', () => {
    // A drop below the population measured when this landed means the scan
    // stopped seeing fixtures, not that they stopped needing the sweep.
    expect(population.length).toBeGreaterThanOrEqual(14);
    for (const name of Object.keys(NEVER_DEPLOYS)) {
      expect(population).toContain(name);
      expect(readFileSync(runnerOf(name)!, 'utf8')).not.toMatch(/\bdeploy\b/);
    }
  });

  it('each sources the shared helper and calls it with its stack, or keeps its own /aws/lambda/ sweep', () => {
    const missing = population.filter((name) => {
      if (name in NEVER_DEPLOYS) return false;
      const body = readFileSync(runnerOf(name)!, 'utf8');
      const helper =
        HELPER_SOURCE.test(body) && body.split('\n').some((line) => HELPER_CALL.test(line));
      const ownSweep = /--log-group-name-prefix\s+"\/aws\/lambda\/\$\{STACK\}/.test(body);
      return !helper && !ownSweep;
    });
    expect(missing).toEqual([]);
  });

  it('a fixture that disarms cleanup on success sweeps AFTER the disarm too', () => {
    // `trap - EXIT INT TERM` means `cleanup` never runs on a PASS, so a sweep
    // living only there leaks on exactly the path #3885 was reported on.
    const missing = population.filter((name) => {
      const lines = readFileSync(runnerOf(name)!, 'utf8').split('\n');
      const disarm = lines.map((l) => l.trim()).lastIndexOf('trap - EXIT INT TERM');
      if (disarm < 0) return false;
      return !lines.slice(disarm + 1).some((line) => HELPER_CALL.test(line));
    });
    expect(missing).toEqual([]);
  });
});
