/**
 * go-to-k/cdkd#7076: `deleteCarriedUsersOfRemovalsFirst` leaves a run whose
 * cleanup waits (a nested child, a producer held for its consumers) alone,
 * and hands the cleanup the entry a failed attempt left, even when the
 * attempt swapped it (a snapshot taken, go-to-k/cdkd#6463).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type {
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';

const retry = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../../src/deployment/deploy-engine/superseded-retry.js', () => ({
  retryCarriedSupersededResources: retry.fn,
}));

import { deleteCarriedUsersOfRemovalsFirst } from '../../../src/deployment/deploy-engine/carried-users-of-removals.js';

const record = (physicalId: string, resourceType: string, dependencies: string[] = []) =>
  ({ physicalId, resourceType, properties: {}, attributes: {}, dependencies }) as ResourceState;

describe('deleteCarriedUsersOfRemovalsFirst (#7076)', () => {
  const row: SupersededResourceRecord = {
    logicalId: 'Group',
    supersededAt: 1,
    state: record('sg-old', 'AWS::EC2::SecurityGroup', ['Vpc']),
  };
  let state: StackState;
  const runOf = (options: Record<string, unknown> = {}) => ({
    engine: { options, logger: { info: vi.fn() } } as never,
    currentState: state,
    deleteChanges: new Set(['Vpc']),
    newResources: state.resources,
  });

  beforeEach(() => {
    retry.fn.mockReset().mockResolvedValue(false);
    state = {
      version: 18,
      stackName: 'S',
      region: 'us-east-1',
      resources: { Vpc: record('vpc-1', 'AWS::EC2::VPC') },
      supersededResources: [row],
      outputs: {},
      lastModified: 0,
    } as StackState;
  });

  it('sends nothing for a nested child or a producer held for its consumers', async () => {
    for (const options of [{ parentStackInfo: {} }, { consumerCleanupQueue: {} }]) {
      expect(await deleteCarriedUsersOfRemovalsFirst(runOf(options), [row])).toEqual([row]);
    }
    expect(retry.fn).not.toHaveBeenCalled();
  });

  it('hands the cleanup the entry a failed attempt swapped in', async () => {
    const swapped = { ...row, finalSnapshotIdentifier: undefined, supersededAt: 2 };
    retry.fn.mockImplementation(async (_engine, host: StackState) => {
      host.supersededResources = [swapped];
      return true;
    });

    expect(await deleteCarriedUsersOfRemovalsFirst(runOf(), [row])).toEqual([swapped]);
    expect(retry.fn).toHaveBeenCalledTimes(1);
  });

  it('hands the cleanup nothing for a row the attempt deleted', async () => {
    retry.fn.mockImplementation(async (_engine, host: StackState) => {
      host.supersededResources = [];
      return true;
    });

    expect(await deleteCarriedUsersOfRemovalsFirst(runOf(), [row])).toEqual([]);
  });
});
