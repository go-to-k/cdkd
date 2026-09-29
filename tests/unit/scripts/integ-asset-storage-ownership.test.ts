import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The integ fixtures that create AND delete a region's default-named cdkd asset
 * storage (marker `cdkd-bootstrap/<region>.json`, bucket
 * `cdkd-assets-<acct>-<region>`, repo `cdkd-container-assets-<acct>-<region>`)
 * may delete it only after their ownership guard has PASSED (issue #4063). Any
 * earlier exit — the guard's own refusal, an unset STATE_BUCKET, an
 * undetermined probe — must clean stack-scoped leftovers only, or the EXIT trap
 * deletes storage the run never created.
 *
 * Each case runs a COPY of the real `verify.sh` (its relative `dist/cli.js` and
 * committed files then resolve inside the sandbox) under `/bin/bash`, with fake
 * `aws` / `node` / `pnpm` / `npx` / `docker` first on a PATH that holds no real
 * AWS CLI. The fake `aws` records every call and answers the guard's probes per
 * case; the positive control proves the recorder sees the destructive calls
 * once the guard has passed.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');
const FIXTURES = ['asset-bootstrap', 'asset-auto-create', 'asset-migration', 'bootstrap-free-region'] as const;

const STATE_BUCKET = 'cdkd-state-fake-4063';
const SPAWN_TIMEOUT_MS = 30_000;

let sandbox: string;
let fakeBin: string;
let calls: string;

/** A probe answer: exists, not found, or a non-not-found failure (throttle). */
type Probe = 'present' | 'absent' | 'throttled';

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cdkd-4063-'));
  fakeBin = join(sandbox, 'bin');
  calls = join(sandbox, 'calls');
  mkdirSync(fakeBin);
  const fakeAws = [
    '#!/bin/sh',
    `echo "aws $*" >> "${calls}"`,
    'nf() { echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254; }',
    'probe() {',
    '  case "$1" in',
    '    present) exit 0 ;;',
    '    throttled) echo "An error occurred (Throttling): Rate exceeded" >&2; exit 255 ;;',
    '    *) nf ;;',
    '  esac',
    '}',
    'case "$1 $2" in',
    '  "sts get-caller-identity") echo 123456789012; exit 0 ;;',
    '  "s3api head-object") case "$*" in *cdkd-bootstrap/*) probe "${FAKE_MARKER}" ;; *) nf ;; esac ;;',
    '  "s3 cp") case "$*" in *cdkd-bootstrap/*) [ "${FAKE_MARKER}" = present ] && { echo "{}"; exit 0; }; nf ;; *) nf ;; esac ;;',
    '  "s3api head-bucket") case "$*" in *cdkd-assets-*) probe "${FAKE_BUCKET}" ;; *) nf ;; esac ;;',
    '  "ecr describe-repositories")',
    '    [ "${FAKE_REPO}" = absent ] && { echo "An error occurred (RepositoryNotFoundException) when calling the DescribeRepositories operation: The repository with name \'x\' does not exist in the registry" >&2; exit 254; }',
    '    probe "${FAKE_REPO}" ;;',
    '  "ssm get-parameter") echo "An error occurred (ParameterNotFound)" >&2; exit 254 ;;',
    '  "s3api get-bucket-location") echo None; exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(fakeBin, 'aws'), fakeAws);
  chmodSync(join(fakeBin, 'aws'), 0o755);
  // Everything else a fixture launches records itself and succeeds silently,
  // so the first real assertion after the guard fails the run and exits.
  for (const tool of ['node', 'pnpm', 'npx', 'docker']) {
    writeFileSync(join(fakeBin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 0\n`);
    chmodSync(join(fakeBin, tool), 0o755);
  }
  for (const name of FIXTURES) {
    const dir = join(sandbox, name, 'tests', 'integration', name);
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'cdk'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'node_modules', '.bin', 'cdk'), 0o755);
    copyFileSync(join(INTEG_ROOT, name, 'verify.sh'), join(dir, 'verify.sh'));
    mkdirSync(join(sandbox, name, 'dist'));
    writeFileSync(join(sandbox, name, 'dist', 'cli.js'), '');
    chmodSync(join(sandbox, name, 'dist', 'cli.js'), 0o755);
  }
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Case {
  readonly marker?: Probe;
  readonly bucket?: Probe;
  readonly repo?: Probe;
  readonly stateBucket?: string;
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly string[];
}

function run(fixture: string, c: Case = {}): Run {
  if (existsSync(calls)) rmSync(calls);
  const env: Record<string, string> = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    HOME: sandbox,
    AWS_REGION: 'us-west-2',
    FAKE_MARKER: c.marker ?? 'absent',
    FAKE_BUCKET: c.bucket ?? 'absent',
    FAKE_REPO: c.repo ?? 'absent',
  };
  if (c.stateBucket !== '') env.STATE_BUCKET = c.stateBucket ?? STATE_BUCKET;
  const res = spawnSync('/bin/bash', [join(sandbox, fixture, 'tests', 'integration', fixture, 'verify.sh')], {
    env,
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

/** Every call that deletes the region's default-named asset storage. */
function storageDeletes(r: Run): string[] {
  return r.calls.filter(
    (c) =>
      c.startsWith('aws s3 rb s3://cdkd-assets-') ||
      c.startsWith('aws ecr delete-repository --repository-name cdkd-container-assets-') ||
      c.startsWith(`aws s3 rm s3://${STATE_BUCKET}/cdkd-bootstrap/`)
  );
}

const MARKER_PROBE = `aws s3api head-object --bucket ${STATE_BUCKET} --key cdkd-bootstrap/`;
const BUCKET_PROBE = 'aws s3api head-bucket --bucket cdkd-assets-';
const REPO_PROBE = 'aws ecr describe-repositories --repository-names cdkd-container-assets-';

for (const fixture of FIXTURES) {
  describe(`tests/integration/${fixture}/verify.sh asset-storage ownership`, () => {
    it(
      'deletes the storage on exit once the guard has passed (positive control)',
      () => {
        const r = run(fixture);
        expect(r.status).not.toBe(0);
        const deletes = storageDeletes(r);
        // Exactly one of each: the EXIT trap. The pre-run pass stays stack-scoped
        // even where it runs after the guard.
        expect(deletes.filter((c) => c.startsWith('aws s3 rb '))).toHaveLength(1);
        expect(deletes.filter((c) => c.startsWith('aws ecr delete-repository '))).toHaveLength(1);
        expect(deletes.filter((c) => c.startsWith('aws s3 rm '))).toHaveLength(1);
      },
      SPAWN_TIMEOUT_MS
    );

    // [why, case, refusal message, the probe that must have refused]
    const REFUSALS: readonly (readonly [string, Case, string, string])[] = [
      ['a marker already exists', { marker: 'present' }, 'already has a cdkd bootstrap marker', MARKER_PROBE],
      ['the asset bucket already exists without a marker', { bucket: 'present' }, 'FAIL: asset bucket', BUCKET_PROBE],
      ['the container repo already exists without a marker', { repo: 'present' }, 'FAIL: container repo', REPO_PROBE],
      ['the marker probe fails with a non-not-found error', { marker: 'throttled' }, 'gone-probe undetermined', MARKER_PROBE],
      ['the bucket probe fails with a non-not-found error', { bucket: 'throttled' }, 'gone-probe undetermined', BUCKET_PROBE],
      ['the repo probe fails with a non-not-found error', { repo: 'throttled' }, 'gone-probe undetermined', REPO_PROBE],
    ];
    for (const [why, c, message, probe] of REFUSALS) {
      it(
        `refuses when ${why}, and deletes no asset storage`,
        () => {
          const r = run(fixture, c);
          expect(storageDeletes(r)).toEqual([]);
          expect(r.status).not.toBe(0);
          expect(r.stderr).toContain(message);
          // The run reached the refusing probe and no later guard probe ran (a
          // later phase would already have shown up in storageDeletes).
          const at = r.calls.findIndex((call) => call.startsWith(probe));
          expect(at).toBeGreaterThanOrEqual(0);
          expect(r.calls.slice(at + 1).some((call) => /head-(object|bucket) .*cdkd-(bootstrap|assets)|describe-repositories/.test(call))).toBe(false);
        },
        SPAWN_TIMEOUT_MS
      );
    }

    it(
      'an exit before the guard (STATE_BUCKET unset) deletes no asset storage',
      () => {
        const r = run(fixture, { stateBucket: '' });
        expect(r.calls.filter((c) => /^aws s3 rb |^aws ecr delete-repository /.test(c))).toEqual([]);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('STATE_BUCKET env var is required');
      },
      SPAWN_TIMEOUT_MS
    );
  });
}
