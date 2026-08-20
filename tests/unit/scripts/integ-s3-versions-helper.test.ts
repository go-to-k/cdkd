import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Executable checks for `tests/integration/s3-versions.sh`, the shared version
 * sweep every secret-seeding fixture now depends on (issue #2096).
 *
 * WHY THIS FILE EXISTS, narrowly. The helper's OTHER behaviours (paging, the
 * trailing-newline iteration, the mode split) need a stand-in for the AWS CLI's
 * `--query` / `--output text` semantics to exercise, which is its own piece of
 * infrastructure and is tracked separately in issue #2106. What is pinned HERE
 * is the one class that needs no AWS at all and is the most dangerous:
 *
 *   A MALFORMED PREFIX MUST NEVER PRODUCE A PASS.
 *
 * `cdkd///` names no stack, so S3 lists nothing for it and a count of 0 is
 * TRUE — about the wrong key space. The assertion originally trusted that 0 and
 * announced a clean teardown. Combined with every caller wrapping the purge in
 * `|| true`, a mis-derived `STATE_PREFIX` printed a refusal to stderr and the
 * fixture still exited 0 with the plaintext intact: the exact vacuous green the
 * whole PR exists to remove, reintroduced inside the assertion meant to prevent
 * it. Caught in review, 2026-08-20.
 *
 * Every case asserts the guard fired BEFORE any AWS call, by putting a fake
 * `aws` on PATH that records its own invocation. "It returned non-zero" is not
 * enough: a helper that called S3 and then failed for an unrelated reason would
 * satisfy a bare exit-code check while still leaking a request per bad prefix.
 */

const HELPER = join(import.meta.dirname, '../../../tests/integration/s3-versions.sh');

let sandbox: string;
let fakeBin: string;
let marker: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cdkd-s3v-'));
  fakeBin = join(sandbox, 'bin');
  marker = join(sandbox, 'aws-was-called');
  execFileSync('mkdir', ['-p', fakeBin]);
  // A fake `aws` that RECORDS the call and then fails, so a helper that reaches
  // it is both detectable and unable to fabricate a listing.
  const fake = join(fakeBin, 'aws');
  writeFileSync(
    fake,
    ['#!/bin/sh', `echo "$@" >> "${marker}"`, 'echo "fake aws: refusing" >&2', 'exit 255', ''].join(
      '\n'
    )
  );
  chmodSync(fake, 0o755);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Run {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly awsCalled: boolean;
}

/**
 * Source the helper under bash and run one snippet against the fake `aws`.
 *
 * `spawnSync`, not `execFileSync`: the latter THROWS on a non-zero exit, so the
 * success and failure paths would be read differently and a snippet ending in
 * `echo "rc=$?"` (exit 0, stderr non-empty) would lose its stderr entirely.
 * Every case here cares about the exit code AND the message AND whether the AWS
 * CLI was reached, so all three are always captured the same way.
 */
function run(snippet: string): Run {
  if (existsSync(marker)) rmSync(marker);
  const script = [
    'set -uo pipefail',
    `. ${JSON.stringify(HELPER)}`,
    'BUCKET=cdkd-state-000000000000',
    snippet,
  ].join('\n');
  // PATH puts the fake FIRST; the real directories stay so `mktemp` / `awk`
  // remain available, which is what makes "aws was never called" meaningful
  // rather than an artefact of a stripped environment.
  const res = spawnSync('/bin/bash', ['-c', script], {
    env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    awsCalled: existsSync(marker),
  };
}

/**
 * Prefixes that must never be certified. Each is a real way `STATE_PREFIX` can
 * come out wrong: `cleanup` runs under `set +eu`, so an unset `STACK` or
 * `REGION` expands to empty rather than aborting.
 */
const MALFORMED = [
  ['', 'empty — would scope to the WHOLE bucket'],
  ['cdkd/', 'bucket-wide cdkd prefix — every stack, including other lanes'],
  ['cdkd///', 'both segments empty (unset STACK and REGION)'],
  ['cdkd//us-east-1/', 'empty stack segment (unset STACK)'],
  ['cdkd/CdkdFoo//', 'empty region segment (unset REGION)'],
  ['cdkd/CdkdFoo/us-east-1', 'no trailing slash — would also match CdkdFooBar'],
  ['/cdkd/CdkdFoo/us-east-1/', 'leading slash — not a cdkd key'],
  ['other/CdkdFoo/us-east-1/', 'not under cdkd/'],
] as const;

describe('tests/integration/s3-versions.sh prefix guard', () => {
  it('finds the helper it claims to test', () => {
    // Without this the whole suite would pass by sourcing nothing.
    expect(existsSync(HELPER)).toBe(true);
    const body = readFileSync(HELPER, 'utf8');
    expect(body).toContain('s3_assert_versions_swept()');
    expect(body).toContain('_s3v_check_prefix()');
  });

  it('the fake aws records a call when it IS reached (positive control)', () => {
    // Proves `awsCalled` can be true — otherwise every "aws was not called"
    // assertion below would hold vacuously.
    const r = run(
      's3_assert_versions_swept "$BUCKET" "cdkd/CdkdFoo/us-east-1/" "well-formed"'
    );
    expect(r.awsCalled).toBe(true);
    expect(r.status).toBe(1);
    // A listing that could not be read must FAIL, never read as "zero".
    expect(r.stderr).toContain('could not list object versions');
    expect(r.stderr).not.toContain('0 surviving object versions');
  });

  for (const [prefix, why] of MALFORMED) {
    it(`s3_assert_versions_swept REFUSES ${JSON.stringify(prefix)} (${why})`, () => {
      const r = run(
        `s3_assert_versions_swept "$BUCKET" ${JSON.stringify(prefix)} "probe"`
      );
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('OK:');
      expect(r.stderr).toContain('malformed prefix');
      expect(r.awsCalled).toBe(false);
    });

    it(`s3_count_versions REFUSES ${JSON.stringify(prefix)}`, () => {
      const r = run(
        `s3_count_versions "$BUCKET" ${JSON.stringify(prefix)}; echo "rc=$?"`
      );
      // A refusal must not print a count anyone could read as zero.
      expect(r.stdout.trim()).toBe('rc=1');
      expect(r.awsCalled).toBe(false);
    });

    it(`s3_purge_prefix_versions REFUSES ${JSON.stringify(prefix)}`, () => {
      const r = run(
        `s3_purge_prefix_versions "$BUCKET" ${JSON.stringify(prefix)} all; echo "rc=$?"`
      );
      expect(r.stdout.trim()).toBe('rc=1');
      expect(r.awsCalled).toBe(false);
    });
  }

  it('s3_stack_prefix produces a prefix the guard ACCEPTS (round trip)', () => {
    // The negative cases above are only meaningful if the shipped constructor
    // clears the same bar — a guard that rejected everything would pass them.
    const r = run('s3_stack_prefix CdkdSecretsDynamicRefExample us-east-1');
    expect(r.stdout.trim()).toBe('cdkd/CdkdSecretsDynamicRefExample/us-east-1/');
    const accepted = run(
      's3_count_versions "$BUCKET" "$(s3_stack_prefix CdkdFoo us-east-1)"; echo "rc=$?"'
    );
    // rc is still 1 — but from the FAKE AWS, not the guard, and the call happened.
    expect(accepted.awsCalled).toBe(true);
    expect(accepted.stderr).toContain('could not list versions');
  });
});
