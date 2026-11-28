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
const naming = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../../src/deployment/deploy-engine/consumer-held-superseded.js', () => ({
  consumersNaming: naming.fn,
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
    naming.fn.mockReset().mockResolvedValue(new Map());
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

  describe('a row a consumer still names keeps the removal it uses unsent (go-to-k/cdkd#7204)', () => {
    const consumerStacks = [{ stackName: 'C', region: 'us-east-1' }];
    const namedBy = (target: SupersededResourceRecord) =>
      naming.fn.mockImplementation(async (_e, _s, rows: SupersededResourceRecord[]) =>
        new Map(rows.filter((r) => r === target).map((r) => [r, ['C']]))
      );

    it('under a consumer hold, asks the run consumers and holds what a named row uses', async () => {
      namedBy(row);
      const held = new Map<string, string>();
      const run = runOf({ consumerCleanupQueue: {}, consumerStacks });

      expect(await deleteCarriedUsersOfRemovalsFirst(run, [row], held)).toEqual([row]);
      expect([...held]).toEqual([['Vpc', 'Group']]);
      expect(naming.fn).toHaveBeenCalledWith(run.engine, 'S', [row], state.resources, consumerStacks);
      expect(retry.fn).not.toHaveBeenCalled();
    });

    it('under a consumer hold, holds nothing for a row no consumer names', async () => {
      const held = new Map<string, string>();
      await deleteCarriedUsersOfRemovalsFirst(
        runOf({ consumerCleanupQueue: {}, consumerStacks }),
        [row],
        held
      );
      expect(held.size).toBe(0);
    });

    it('a nested child under a hold asks for its top-level stack', async () => {
      state.stackName = 'S~Child';
      await deleteCarriedUsersOfRemovalsFirst(
        runOf({ consumerCleanupQueue: {}, consumerStacks, parentStackInfo: {} }),
        [row],
        new Map()
      );
      expect(naming.fn.mock.calls[0]?.[1]).toBe('S');
    });

    it('without a hold, asks every stack only for a row held for consumers', async () => {
      const marked = { ...row, heldForConsumers: true as const };
      namedBy(marked);
      const held = new Map<string, string>();

      expect(await deleteCarriedUsersOfRemovalsFirst(runOf(), [marked], held)).toEqual([marked]);
      expect([...held]).toEqual([['Vpc', 'Group']]);
      expect(naming.fn.mock.calls[0]?.[4]).toBeUndefined();
      expect(retry.fn).not.toHaveBeenCalled();
    });

    it('without a hold, a held row no consumer names is deleted first, keeping its mark', async () => {
      const marked: SupersededResourceRecord = { ...row, heldForConsumers: true };
      const held = new Map<string, string>();
      state.supersededResources = [marked];

      await deleteCarriedUsersOfRemovalsFirst(runOf(), [marked], held);
      expect(held.size).toBe(0);
      expect(marked.heldForConsumers).toBe(true);
      expect(retry.fn.mock.calls[0]?.[2]).toEqual([marked]);
    });

    it('reads nothing for an unmarked row without a hold, or a nested child without one', async () => {
      await deleteCarriedUsersOfRemovalsFirst(runOf(), [row], new Map());
      await deleteCarriedUsersOfRemovalsFirst(runOf({ parentStackInfo: {} }), [row], new Map());
      expect(naming.fn).not.toHaveBeenCalled();
    });

    it('holds the removal a named row uses by type when its record names none', async () => {
      const untyped: SupersededResourceRecord = {
        logicalId: 'Group',
        supersededAt: 1,
        state: record('sg-old', 'AWS::EC2::SecurityGroup'),
      };
      namedBy(untyped);
      const held = new Map<string, string>();
      await deleteCarriedUsersOfRemovalsFirst(
        runOf({ consumerCleanupQueue: {}, consumerStacks }),
        [untyped],
        held
      );
      expect([...held]).toEqual([['Vpc', 'Group']]);
    });
  });
});
