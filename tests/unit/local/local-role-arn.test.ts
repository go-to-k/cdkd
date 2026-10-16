import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  applyRoleArnIfSet: vi.fn(),
  recordAssumedRole: vi.fn(),
}));

vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/role-arn.js')>();
  return { ...actual, applyRoleArnIfSet: mocks.applyRoleArnIfSet };
});

// Wrap the real recorder: the spy sees the argument, the real write-once state
// is still exercised and reset between cases.
vi.mock('cdk-local/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cdk-local/internal')>();
  mocks.recordAssumedRole.mockImplementation(actual.recordAssumedRole);
  return { ...actual, recordAssumedRole: mocks.recordAssumedRole };
});

import { assumedRoleRecorded, resetWorkloadIdentity } from 'cdk-local/internal';
import { applyRoleArnForLocal } from '../../../src/local/local-role-arn.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';

/**
 * go-to-k/cdkd#3240: the four cdkd-owned `local` commands assume `--role-arn`
 * through cdkd's `applyRoleArnIfSet`, which cdk-local never sees. Its workload
 * sites resolve as the caller only once the assume is RECORDED with it, with the
 * caller's pre-assume snapshot.
 */

const ROLE = { accessKeyId: 'ASIAROLEROLEROLE000', secretAccessKey: 'role-secret', sessionToken: 'role-token' };
const CALLER = { accessKeyId: 'AKIACALLERCALLER000', secretAccessKey: 'caller-secret' };

/** What the real `applyRoleArnIfSet` leaves behind: the snapshot, then the role. */
function assume(snapshot: typeof CALLER | undefined): void {
  mocks.applyRoleArnIfSet.mockImplementation(async () => {
    setPreAssumeEnvCredentials(snapshot);
    setAssumedRoleCredentials(ROLE);
  });
}

beforeEach(() => {
  mocks.applyRoleArnIfSet.mockReset();
  mocks.recordAssumedRole.mockClear();
  resetAwsClientDefaults();
  resetWorkloadIdentity();
});

afterEach(() => {
  resetAwsClientDefaults();
  resetWorkloadIdentity();
});

describe('applyRoleArnForLocal', () => {
  const opts = { roleArn: 'arn:aws:iam::222222222222:role/deploy', region: 'us-east-1' };

  it('forwards its options to applyRoleArnIfSet', async () => {
    await applyRoleArnForLocal(opts);
    expect(mocks.applyRoleArnIfSet).toHaveBeenCalledExactlyOnceWith(opts);
  });

  it("records the assume with the caller's pre-assume snapshot", async () => {
    assume(CALLER);
    await applyRoleArnForLocal(opts);
    expect(mocks.recordAssumedRole).toHaveBeenCalledExactlyOnceWith(CALLER);
    expect(assumedRoleRecorded()).toBe(true);
  });

  it('records undefined when there was no caller triple to snapshot', async () => {
    assume(undefined);
    await applyRoleArnForLocal(opts);
    expect(mocks.recordAssumedRole).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(assumedRoleRecorded()).toBe(true);
  });

  it('records nothing when no role was assumed', async () => {
    await applyRoleArnForLocal({ roleArn: undefined, region: 'us-east-1' });
    expect(mocks.recordAssumedRole).not.toHaveBeenCalled();
    expect(assumedRoleRecorded()).toBe(false);
  });

  it('does not record when applyRoleArnIfSet throws', async () => {
    mocks.applyRoleArnIfSet.mockRejectedValue(new Error('refused'));
    await expect(applyRoleArnForLocal(opts)).rejects.toThrow('refused');
    expect(mocks.recordAssumedRole).not.toHaveBeenCalled();
  });
});

describe('the four cdkd-owned local commands publish through applyRoleArnForLocal', () => {
  // The handlers are not reachable from a unit test past their first await, so
  // the wiring is pinned at the source: a command calling cdkd's bare
  // `applyRoleArnIfSet` assumes the role without telling cdk-local.
  const strip = (src: string): string[] =>
    src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

  it.each([
    'local-invoke.ts',
    'local-start-api.ts',
    'local-run-task.ts',
    'local-invoke-agentcore.ts',
  ])('%s', (file) => {
    const lines = strip(readFileSync(join(__dirname, '../../../src/cli/commands', file), 'utf8'));
    expect(lines.filter((l) => l.includes('await applyRoleArnForLocal('))).toHaveLength(1);
    expect(lines.filter((l) => /\bapplyRoleArnIfSet\b/.test(l))).toEqual([]);
  });
});
