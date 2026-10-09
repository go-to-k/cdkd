/**
 * go-to-k/cdkd#4705 (review CB-5, G4): `cdkd state orphan` of a whole stack
 * releases the stack's registry marker and clears its `retained.json`; with
 * NO record left (after a destroy that kept resources), it still clears the
 * `retained.json` -- in every region that has one, or the `--stack-region`
 * named -- and releases the marker there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ get s3() { return {}; }, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(),
}));

const backend = vi.hoisted(() => ({
  prefix: 'cdkd',
  destroyClient: vi.fn(),
  verifyBucketExists: vi.fn(async () => undefined),
  listStacks: vi.fn(async (): Promise<Array<{ stackName: string; region?: string }>> => []),
  stateExists: vi.fn(async () => true),
  deleteState: vi.fn(async () => undefined),
  deleteLegacyState: vi.fn(async () => undefined),
  listRawKeys: vi.fn(async (): Promise<string[]> => []),
  saveRetainedResources: vi.fn(async () => undefined),
  releaseRegistryMarker: vi.fn(async () => 'released' as const),
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => backend),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: vi.fn(async () => false),
    forceReleaseLock: vi.fn(async () => undefined),
    getLockInfo: vi.fn(async () => null),
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

async function orphan(args: string[]): Promise<void> {
  const cmd = createStateCommand();
  cmd.exitOverride();
  cmd.commands.forEach((sub) => sub.exitOverride());
  await cmd.parseAsync(['orphan', ...args, '--yes'], { from: 'user' });
}

let tty: boolean | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  tty = process.stdin.isTTY;
  setStdinIsTty(true);
  backend.listStacks.mockResolvedValue([]);
  backend.listRawKeys.mockResolvedValue([]);
});
afterEach(() => setStdinIsTty(tty));

describe('cdkd state orphan and the registry (go-to-k/cdkd#4705)', () => {
  it('G4: a recorded stack: the record goes, then the marker is released and retained.json cleared', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'App', region: 'us-east-1' }]);
    await orphan(['App']);
    expect(backend.deleteState).toHaveBeenCalledWith('App', 'us-east-1');
    expect(backend.releaseRegistryMarker).toHaveBeenCalledWith('App', 'us-east-1');
    expect(backend.saveRetainedResources).toHaveBeenCalledWith('App', 'us-east-1', []);
    expect(backend.releaseRegistryMarker.mock.invocationCallOrder[0]!).toBeGreaterThan(
      backend.deleteState.mock.invocationCallOrder[0]!
    );
  });

  it('CB-5: no record, but a retained.json a destroy left: cleared in each region that has one, marker released', async () => {
    backend.listRawKeys.mockResolvedValue([
      'cdkd/App/us-east-1/retained.json',
      'cdkd/App/eu-west-1/retained.json',
      'cdkd/App/us-east-1/deployments/index.json',
    ]);
    await orphan(['App']);
    expect(backend.listRawKeys).toHaveBeenCalledWith('cdkd/App/');
    expect(backend.saveRetainedResources.mock.calls).toEqual([
      ['App', 'us-east-1', []],
      ['App', 'eu-west-1', []],
    ]);
    expect(backend.releaseRegistryMarker.mock.calls).toEqual([
      ['App', 'us-east-1'],
      ['App', 'eu-west-1'],
    ]);
    expect(backend.deleteState).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/Cleared the kept-resource record of App/));
  });

  it('CB-5: --stack-region narrows that to its region', async () => {
    backend.listRawKeys.mockResolvedValue(['cdkd/App/us-east-1/retained.json', 'cdkd/App/eu-west-1/retained.json']);
    await orphan(['App', '--stack-region', 'eu-west-1']);
    expect(backend.saveRetainedResources.mock.calls).toEqual([['App', 'eu-west-1', []]]);
  });

  it("D-1: no record and no retained.json, but an older cdkd's event history: the empty tombstone ends its license", async () => {
    backend.listRawKeys.mockResolvedValue([
      'cdkd/App/us-east-1/deployments/index.json',
      'cdkd/App/us-east-1/deployments/20260901T000000Z-abc.jsonl',
    ]);
    await orphan(['App']);
    expect(backend.saveRetainedResources.mock.calls).toEqual([['App', 'us-east-1', []]]);
  });

  it('no record and nothing kept: the idempotent skip, no write', async () => {
    await orphan(['App']);
    expect(backend.saveRetainedResources).not.toHaveBeenCalled();
    expect(backend.releaseRegistryMarker).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No state found for stack: App/));
  });
});
