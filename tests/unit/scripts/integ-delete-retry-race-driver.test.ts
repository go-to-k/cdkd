import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * `tests/integration/dynamodb-globaltable/verify.sh`'s issue #1830 race driver,
 * executed against a stub `aws`.
 *
 * The driver runs in a background subshell during a real destroy, so its only
 * channel back to the assertion step is the marker file — and until the review
 * of this PR it discarded AWS's stderr (`>/dev/null 2>&1`), which made
 * `update-rejected` the one outcome nobody could diagnose. That is a real
 * behaviour of the fixture, not a shape, so it is exercised rather than
 * grepped: the function is extracted from the committed script and run for
 * real, with a stub `aws` on PATH.
 *
 * Nothing here talks to AWS; the whole point is that the harness never leaves
 * the temp dir.
 */

const VERIFY_SH = join(
  import.meta.dirname,
  '../../../tests/integration/dynamodb-globaltable/verify.sh'
);
const TABLE = 'GsiDeleteRetryTable-abc';
const SIGNAL = `Deregistered auto-scaling target table/${TABLE} (dynamodb:table:WriteCapacityUnits)`;
const AWS_STDERR =
  'An error occurred (ResourceInUseException) when calling the UpdateTable ' +
  'operation: Table is being deleted';

/**
 * The driver function, verbatim from the committed fixture.
 *
 * Extracted by brace matching at column 0 rather than by a line range, so an
 * edit elsewhere in `verify.sh` cannot silently shift what this test runs. A
 * rename fails the extraction loudly instead of skipping the assertions.
 */
function extractDriver(): string {
  const script = readFileSync(VERIFY_SH, 'utf8');
  const start = script.indexOf('delete_retry_race_driver() {');
  expect(start).toBeGreaterThan(-1);
  const end = script.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end + 3);
}

function runDriver(opts: { awsExitCode: number }): { marker: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-delete-retry-driver-'));
  try {
    const bin = join(dir, 'bin');
    const awsStub = join(bin, 'aws');
    writeFileSync(
      join(dir, 'log'),
      // The driver polls the destroy log for its signal; pre-seeded so it
      // fires on the first iteration instead of burning its 600s budget.
      `[cdkd] some earlier line\n${SIGNAL}\n`
    );
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(
      awsStub,
      `#!/usr/bin/env bash\n` +
        // stdout noise on BOTH paths: the redirect order under test
        // (\`2>&1 >/dev/null\`) has to keep stderr and drop this.
        `echo '{"TableDescription":{"TableName":"stub"}}'\n` +
        `if [ "${opts.awsExitCode}" -ne 0 ]; then\n` +
        `  echo ${JSON.stringify(AWS_STDERR)} >&2\n` +
        `  exit ${opts.awsExitCode}\n` +
        `fi\n` +
        `exit 0\n`
    );
    chmodSync(awsStub, 0o755);

    const harness = join(dir, 'harness.sh');
    writeFileSync(
      harness,
      `#!/usr/bin/env bash\nset -euo pipefail\nREGION=us-east-1\n${extractDriver()}\n` +
        `delete_retry_race_driver "${join(dir, 'log')}" "${TABLE}" "${join(dir, 'marker')}"\n`
    );
    const run = spawnSync('bash', [harness], {
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status).toBe(0);
    return { marker: readFileSync(join(dir, 'marker'), 'utf8'), status: run.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("verify.sh delete_retry_race_driver (issue #1830 fixture's marker)", () => {
  it('records `fired` when the out-of-band UpdateTable is accepted', () => {
    expect(runDriver({ awsExitCode: 0 }).marker).toBe('fired');
  });

  it("carries AWS's own refusal text into the marker on `update-rejected`", () => {
    // Step 15b prints this text. Without it the step could only say "the
    // driver did not fire" and offered one remedy — widen the teardown window
    // — which does not address a refusal of the driver's OWN call at all.
    const { marker } = runDriver({ awsExitCode: 254 });
    expect(marker.startsWith('update-rejected: ')).toBe(true);
    expect(marker).toContain(AWS_STDERR);
    // The success payload must NOT be in there: `2>&1 >/dev/null` in that
    // order keeps stderr and drops stdout, and the reverse order would put the
    // whole JSON response into the marker step 15b echoes.
    expect(marker).not.toContain('TableDescription');
  });

  it('gives step 15b a marker it can strip the prefix off', () => {
    // `${DELETE_RETRY_OUTCOME#update-rejected: }` is how the remedy prints
    // AWS's sentence alone, so the separator has to be exactly that.
    const { marker } = runDriver({ awsExitCode: 254 });
    expect(marker.replace(/^update-rejected: /, '')).toBe(AWS_STDERR);
  });
});
