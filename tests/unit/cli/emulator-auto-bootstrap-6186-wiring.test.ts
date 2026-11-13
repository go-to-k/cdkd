import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const order: string[] = [];

vi.mock('../../../src/cli/commands/emulator-auto-bootstrap.js', () => ({
  ensureAwsEmulatorStateBucket: vi.fn(async () => {
    order.push('ensure');
    return undefined;
  }),
}));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefaultAndSource: vi.fn(async () => {
    order.push('resolve');
    // Stop the prep here: the wiring under test is what ran before.
    throw new Error('stop after resolve');
  }),
  stateBucketExistenceConfirmed: vi.fn(() => false),
}));

import { prepareStateInfra } from '../../../src/cli/commands/deploy/prep.js';
import { ensureAwsEmulatorStateBucket } from '../../../src/cli/commands/emulator-auto-bootstrap.js';

/**
 * go-to-k/cdkd#6186: `cdkd deploy`'s state prep calls the AWS Emulator
 * auto-bootstrap BEFORE it resolves the state bucket, with the run's bucket
 * option, region and clients — and never under `--dry-run`.
 */
describe('prepareStateInfra wiring of the AWS Emulator auto-bootstrap', () => {
  const awsClients = { s3: { tag: 's3' }, sts: { tag: 'sts' } };
  const run = (dryRun: boolean) =>
    prepareStateInfra({
      options: { stateBucket: 'my-state', statePrefix: 'cdkd', dryRun } as never,
      region: 'eu-west-1',
      effectiveRegion: { region: 'eu-west-1' } as never,
      awsClients: awsClients as never,
      logger: {} as never,
    });

  beforeEach(() => {
    order.length = 0;
    vi.mocked(ensureAwsEmulatorStateBucket).mockClear();
  });

  it('calls it before the state-bucket resolution, with the run values', async () => {
    await expect(run(false)).rejects.toThrow('stop after resolve');
    expect(order).toEqual(['ensure', 'resolve']);
    expect(ensureAwsEmulatorStateBucket).toHaveBeenCalledWith({
      cliBucket: 'my-state',
      region: 'eu-west-1',
      s3: awsClients.s3,
      sts: awsClients.sts,
    });
  });

  it('skips it under --dry-run', async () => {
    await expect(run(true)).rejects.toThrow('stop after resolve');
    expect(order).toEqual(['resolve']);
  });
});
