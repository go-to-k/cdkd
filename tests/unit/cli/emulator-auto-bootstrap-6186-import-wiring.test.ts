import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const order: string[] = [];
const bag = { s3: { tag: 'bag-s3' }, sts: { tag: 'bag-sts' }, destroy: vi.fn() };

vi.mock('../../../src/provisioning/register-providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/register-providers.js')>()),
  loadProviderClasses: vi.fn(async () => ({})),
}));
vi.mock('../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn(async () => {}) }));
vi.mock('../../../src/cli/region-options.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/cli/region-options.js')>()),
  resolveEffectiveRegion: vi.fn(async () => ({ region: 'eu-west-1', source: 'flag' })),
  exportInferredRegionForSdk: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/aws-clients.js')>()),
  AwsClients: vi.fn(function () {
    order.push('new AwsClients');
    return bag;
  }),
  setAwsClients: vi.fn(() => {
    order.push('setAwsClients');
  }),
}));
vi.mock('../../../src/cli/commands/emulator-auto-bootstrap.js', () => ({
  ensureAwsEmulatorStateBucket: vi.fn(async () => {
    order.push('ensure');
    return undefined;
  }),
}));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/cli/config-loader.js')>()),
  resolveStateBucketWithDefault: vi.fn(async () => {
    order.push('resolve');
    // Stop the command here: the wiring under test is what ran before.
    throw new Error('stop after resolve');
  }),
}));

import { importCommand } from '../../../src/cli/commands/import/command.js';
import { ensureAwsEmulatorStateBucket } from '../../../src/cli/commands/emulator-auto-bootstrap.js';

/**
 * go-to-k/cdkd#6186: `cdkd import` calls the AWS Emulator auto-bootstrap
 * through its OWN clients (after they are set), before it resolves the state
 * bucket — and never under `--dry-run`.
 */
describe('importCommand wiring of the AWS Emulator auto-bootstrap', () => {
  const run = (dryRun: boolean) =>
    importCommand('MyStack', {
      stateBucket: 'my-state',
      statePrefix: 'cdkd',
      region: 'eu-west-1',
      dryRun,
      verbose: false,
    } as never);

  beforeEach(() => {
    order.length = 0;
    vi.mocked(ensureAwsEmulatorStateBucket).mockClear();
  });

  it('calls it after the command sets its clients, before the resolution, with those clients', async () => {
    await expect(run(false)).rejects.toThrow('stop after resolve');
    expect(order).toEqual(['new AwsClients', 'setAwsClients', 'ensure', 'resolve']);
    expect(ensureAwsEmulatorStateBucket).toHaveBeenCalledWith({
      cliBucket: 'my-state',
      region: 'eu-west-1',
      s3: bag.s3,
      sts: bag.sts,
    });
  });

  it('skips it under --dry-run', async () => {
    await expect(run(true)).rejects.toThrow('stop after resolve');
    expect(order).toEqual(['new AwsClients', 'setAwsClients', 'resolve']);
    expect(ensureAwsEmulatorStateBucket).not.toHaveBeenCalled();
  });
});
