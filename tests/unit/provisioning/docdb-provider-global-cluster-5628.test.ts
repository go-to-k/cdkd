// go-to-k/cdkd#5628: `AWS::DocDB::DBCluster.GlobalClusterIdentifier` on the SDK
// route. CreateDBCluster sends it; ModifyDBCluster has no member for it, so an
// update refuses a change the live cluster does not already show (a state-borne
// one warns and keeps the membership); and a member is detached
// (RemoveFromGlobalCluster) before its delete, which AWS refuses otherwise.
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const debug = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug, info, warn, error: vi.fn(), child: () => logger };
  return { getLogger: () => logger };
});

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CLUSTER = 'AWS::DocDB::DBCluster';
const ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:c';
const GLOBAL = 'my-global';

type Bag = Record<string, unknown>;

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

function names(): string[] {
  return mockSend.mock.calls.map((c) => String((c[0] as object).constructor.name));
}

function sent(command: string): Bag[] {
  return mockSend.mock.calls
    .filter(([cmd]) => (cmd as object).constructor.name === command)
    .map(([cmd]) => (cmd as { input: Bag }).input);
}

/** Global clusters as DescribeGlobalClusters pages: `[id, memberArns]` per cluster, one array per page. */
type Pages = Array<Array<[string, string[]]>>;

/** An available cluster; `pages` answers an unfiltered DescribeGlobalClusters. */
function armUpdate(pages: Pages | Error = [[]]): void {
  mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) => {
    switch (cmd.constructor.name) {
      case 'DescribeDBClustersCommand':
        return Promise.resolve({
          DBClusters: [{ DBClusterIdentifier: 'c', Status: 'available', DBClusterArn: ARN }],
        });
      case 'DescribeGlobalClustersCommand': {
        if (pages instanceof Error) return Promise.reject(pages);
        const index = cmd.input['Marker'] === undefined ? 0 : Number(cmd.input['Marker']);
        const page = pages[index] ?? [];
        return Promise.resolve({
          GlobalClusters: page.map(([id, members]) => ({
            GlobalClusterIdentifier: id,
            GlobalClusterMembers: members.map((DBClusterArn) => ({ DBClusterArn })),
          })),
          ...(index + 1 < pages.length && { Marker: String(index + 1) }),
        });
      }
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DbClusterResourceId: 'r' } });
      default:
        return Promise.resolve({ TagList: [] });
    }
  });
}

interface DeleteScript {
  /** Results of RemoveFromGlobalCluster, one per call: undefined = success. */
  remove?: Error | Array<Error | undefined>;
  /** DeletionProtection the describe reports, one per read (the last repeats). */
  protection?: boolean[];
  /**
   * Member-list answers, one per DescribeGlobalClusters read (the last
   * repeats): the pre-detach read first, then the wait's polls. Default: a
   * member, then gone.
   */
  memberPolls?: Array<string[] | Error>;
  /** Cluster status after the detach (default `available`). */
  statusAfter?: string;
  /** Whether this cluster is the global cluster's writer (its primary). */
  writer?: boolean;
  /**
   * DescribeDBClusters answers taken in order before the default one: a
   * cluster bag (`DBClusters: [bag]`), `null` (`DBClusters: []`) or an error.
   */
  clusterReads?: Array<Bag | null | Error>;
}

function armDelete(s: DeleteScript): void {
  const polls = [...(s.memberPolls ?? [[ARN], []])];
  const removes = Array.isArray(s.remove) ? [...s.remove] : [s.remove];
  const protection = [...(s.protection ?? [false])];
  const clusterReads = [...(s.clusterReads ?? [])];
  let deleted = false;
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'DescribeDBClustersCommand': {
        if (deleted) return Promise.reject(awsError('DBClusterNotFoundFault', 'gone'));
        if (clusterReads.length > 0) {
          const read = clusterReads.shift()!;
          if (read instanceof Error) return Promise.reject(read);
          return Promise.resolve({ DBClusters: read === null ? [] : [read] });
        }
        const guard = protection.length > 1 ? protection.shift()! : protection[0]!;
        return Promise.resolve({
          DBClusters: [
            { DBClusterArn: ARN, Status: s.statusAfter ?? 'available', DeletionProtection: guard },
          ],
        });
      }
      case 'RemoveFromGlobalClusterCommand': {
        const next = removes.length > 1 ? removes.shift() : removes[0];
        return next ? Promise.reject(next) : Promise.resolve({});
      }
      case 'DescribeGlobalClustersCommand': {
        const next = polls.length > 1 ? polls.shift()! : polls[0]!;
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve({
          GlobalClusters: [
            {
              GlobalClusterMembers: next.map((a) => ({
                DBClusterArn: a,
                IsWriter: a === ARN ? (s.writer ?? true) : false,
              })),
            },
          ],
        });
      }
      case 'DeleteDBClusterCommand':
        deleted = true;
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

describe('DocDBProvider GlobalClusterIdentifier (go-to-k/cdkd#5628)', () => {
  let provider: DocDBProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    debug.mockReset();
    info.mockReset();
    provider = new DocDBProvider();
    (provider as unknown as { sleep: () => Promise<void> }).sleep = () => Promise.resolve();
  });

  it('is handled on the SDK route, its removal by update(), and unknown to drift', () => {
    expect(provider.handledProperties.get(CLUSTER)?.has('GlobalClusterIdentifier')).toBe(true);
    expect(provider.removalHandledInUpdate.get(CLUSTER)?.has('GlobalClusterIdentifier')).toBe(true);
    expect(provider.getDriftUnknownPaths(CLUSTER)).toContain('GlobalClusterIdentifier');
  });

  describe('create', () => {
    it('sends the declared global cluster on CreateDBCluster', async () => {
      armUpdate();
      await provider.create('L', CLUSTER, { DBClusterIdentifier: 'c', GlobalClusterIdentifier: GLOBAL });
      expect(sent('CreateDBClusterCommand')[0]).toMatchObject({ GlobalClusterIdentifier: GLOBAL });
    });

    it.each([
      ['absent', {}],
      ['null', { GlobalClusterIdentifier: null }],
      ['blank', { GlobalClusterIdentifier: '  ' }],
    ])('%s: no GlobalClusterIdentifier on the wire', async (_label, extra) => {
      armUpdate();
      await provider.create('L', CLUSTER, { DBClusterIdentifier: 'c', ...extra });
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty('GlobalClusterIdentifier');
    });

    it('a non-string is refused before any call, non-retryable', async () => {
      armUpdate();
      const error = await provider
        .create('L', CLUSTER, { DBClusterIdentifier: 'c', GlobalClusterIdentifier: { Ref: 'G' } })
        .then(() => undefined, (e: unknown) => e as Error);
      expect(error?.message).toContain('GlobalClusterIdentifier is not a string');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a non-string from a state replay is warned about and left out', async () => {
      armUpdate();
      await provider.create(
        'L',
        CLUSTER,
        { DBClusterIdentifier: 'c', GlobalClusterIdentifier: 42 },
        { replayingState: true }
      );
      expect(sent('CreateDBClusterCommand')[0]).not.toHaveProperty('GlobalClusterIdentifier');
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'the recorded GlobalClusterIdentifier is unusable, so it is not sent'
      );
    });
  });

  describe('update', () => {
    const update = (next: Bag, previous: Bag, context?: Bag) =>
      provider.update('L', 'c', CLUSTER, next, previous, context as never);

    // AWS refuses any EngineVersion on a cluster with no healthy primary
    // instance, its own included: the live run's second update failed on it.
    it.each<[string, Bag, Bag, Bag | undefined, string | undefined]>([
      ['unchanged', { EngineVersion: '5.0.0' }, { EngineVersion: '5.0.0' }, undefined, undefined],
      ['changed', { EngineVersion: '5.0.1' }, { EngineVersion: '5.0.0' }, undefined, '5.0.1'],
      ['newly declared', { EngineVersion: '5.0.0' }, {}, undefined, '5.0.0'],
      ['changed, in a rollback replay', { EngineVersion: '5.0.0' }, { EngineVersion: '5.0.1' }, { replayingState: true }, undefined],
    ])('EngineVersion %s: ModifyDBCluster sends %s', async (_l, next, previous, context, expected) => {
      armUpdate();
      await update(
        { ...next, GlobalClusterIdentifier: GLOBAL },
        { ...previous, GlobalClusterIdentifier: GLOBAL },
        context
      );
      expect(sent('ModifyDBClusterCommand')[0]?.['EngineVersion']).toBe(expected);
    });

    it('an unchanged value reads no membership and records the template', async () => {
      armUpdate();
      const result = await update(
        { GlobalClusterIdentifier: GLOBAL, BackupRetentionPeriod: 2 },
        { GlobalClusterIdentifier: GLOBAL, BackupRetentionPeriod: 1 }
      );
      expect(names()).not.toContain('DescribeGlobalClustersCommand');
      expect(sent('ModifyDBClusterCommand')[0]).not.toHaveProperty('GlobalClusterIdentifier');
      expect(result.effectiveProperties).toBeUndefined();
    });

    it.each<[string, Bag, Bag]>([
      ['an added', {}, { GlobalClusterIdentifier: GLOBAL }],
      ['a changed', { GlobalClusterIdentifier: GLOBAL }, { GlobalClusterIdentifier: 'other' }],
      ['a non-string', { GlobalClusterIdentifier: GLOBAL }, { GlobalClusterIdentifier: ['x'] }],
    ])('%s value the live cluster does not show is refused before any write', async (_l, previous, next) => {
      // Live: the cluster sits where the previous record says, so the desired
      // membership differs from what AWS shows.
      armUpdate(previous['GlobalClusterIdentifier'] === GLOBAL ? [[[GLOBAL, [ARN]]]] : [[]]);
      const error = await update(next, previous).then(
        () => undefined,
        (e: unknown) => e as Error
      );
      expect(error?.message).toContain('GlobalClusterIdentifier');
      expect(error?.message).toContain('nothing was changed');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names()).not.toContain('ModifyDBClusterCommand');
    });

    it('words the refusal as CloudFormation does and names replacement as the way', async () => {
      armUpdate([[[GLOBAL, [ARN]]]]);
      const error = await update({ GlobalClusterIdentifier: 'other' }, { GlobalClusterIdentifier: GLOBAL }).then(
        () => undefined,
        (e: unknown) => e as Error
      );
      expect(error?.message).toContain(
        'Changing GlobalClusterIdentifier to a different global cluster is not supported unless the cluster is already part of the target global cluster'
      );
      expect(error?.message).toContain('replace the cluster');
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    });

    describe('a removal detaches in place (CloudFormation A/B)', () => {
      /** A cluster in GLOBAL until RemoveFromGlobalCluster takes it out. */
      function armRemoval(opts: { member?: boolean; protection?: boolean; remove?: Error } = {}): void {
        let member = opts.member ?? true;
        mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) => {
          switch (cmd.constructor.name) {
            case 'DescribeDBClustersCommand':
              return Promise.resolve({
                DBClusters: [
                  {
                    DBClusterIdentifier: 'c',
                    Status: 'available',
                    DBClusterArn: ARN,
                    DeletionProtection: opts.protection ?? false,
                  },
                ],
              });
            case 'DescribeGlobalClustersCommand':
              return Promise.resolve({
                GlobalClusters: [
                  {
                    GlobalClusterIdentifier: GLOBAL,
                    GlobalClusterMembers: member ? [{ DBClusterArn: ARN, IsWriter: true }] : [],
                  },
                ],
              });
            case 'RemoveFromGlobalClusterCommand':
              if (opts.remove) return Promise.reject(opts.remove);
              member = false;
              return Promise.resolve({});
            default:
              return Promise.resolve({ TagList: [] });
          }
        });
      }

      it('detaches by ARN before the ModifyDBCluster, and records the template (no key)', async () => {
        armRemoval();
        const result = await update({ BackupRetentionPeriod: 2 }, { GlobalClusterIdentifier: GLOBAL });
        expect(sent('RemoveFromGlobalClusterCommand')).toEqual([
          { GlobalClusterIdentifier: GLOBAL, DbClusterIdentifier: ARN },
        ]);
        const order = names();
        expect(order.indexOf('RemoveFromGlobalClusterCommand')).toBeLessThan(
          order.indexOf('ModifyDBClusterCommand')
        );
        expect(result.effectiveProperties).toBeUndefined();
      });

      it('a cluster no longer in the global cluster (detached outside cdkd): no detach', async () => {
        armRemoval({ member: false });
        await update({}, { GlobalClusterIdentifier: GLOBAL });
        expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
        expect(names()).toContain('ModifyDBClusterCommand');
      });

      it('deletion protection does not stop it: it guards a delete, not this change', async () => {
        armRemoval({ protection: true });
        await update({}, { GlobalClusterIdentifier: GLOBAL });
        expect(names()).toContain('RemoveFromGlobalClusterCommand');
      });

      it('says why it detaches, without the delete wording', async () => {
        armRemoval();
        await update({}, { GlobalClusterIdentifier: GLOBAL });
        const lines = info.mock.calls.map((c) => String(c[0])).join('\n');
        expect(lines).toContain(
          'Detaching DocDB DBCluster L from global cluster my-global: GlobalClusterIdentifier was removed'
        );
        expect(lines).not.toContain('before the delete');
      });

      it('a rollback replay restoring a record without one never detaches: cdkd did not add it', async () => {
        armRemoval();
        const result = await update(
          { BackupRetentionPeriod: 1 },
          { GlobalClusterIdentifier: GLOBAL, BackupRetentionPeriod: 2 },
          { replayingState: true }
        );
        expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'cdkd did not add the cluster to global cluster my-global (it was already a member), so it leaves it there'
        );
        // The record keeps the membership AWS still holds.
        expect(result.effectiveProperties).toStrictEqual({
          BackupRetentionPeriod: 1,
          GlobalClusterIdentifier: GLOBAL,
        });
      });

      it('a refused add restored by --revert-failed (live not a member) records no membership', async () => {
        // previous = the attempted bag (G1), desired = the old record (none).
        armRemoval({ member: false });
        const result = await update(
          { BackupRetentionPeriod: 1 },
          { GlobalClusterIdentifier: GLOBAL, BackupRetentionPeriod: 1 },
          { replayingState: true }
        );
        expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
        expect(warn).not.toHaveBeenCalled();
        expect(result.effectiveProperties).toBeUndefined();
      });

      it('a state-borne removal whose membership cannot be read records none, never a false one', async () => {
        armUpdate(awsError('AccessDenied', 'not authorized'));
        const result = await update({}, { GlobalClusterIdentifier: GLOBAL }, { replayingState: true });
        expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
        expect(result.effectiveProperties).toBeUndefined();
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'membership of global cluster my-global could not be read, so the record treats it as absent'
        );
      });

      it('`""` on a member detaches like a removal (CloudFormation A/B)', async () => {
        armRemoval();
        await update({ GlobalClusterIdentifier: '' }, { GlobalClusterIdentifier: GLOBAL });
        expect(sent('RemoveFromGlobalClusterCommand')).toEqual([
          { GlobalClusterIdentifier: GLOBAL, DbClusterIdentifier: ARN },
        ]);
      });

      it('a ModifyDBCluster failing after the detach says the cluster is already standalone', async () => {
        armRemoval();
        const base = mockSend.getMockImplementation()!;
        mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) =>
          cmd.constructor.name === 'ModifyDBClusterCommand'
            ? Promise.reject(awsError('InvalidDBClusterStateFault', 'busy'))
            : base(cmd)
        );
        const error = await update({}, { GlobalClusterIdentifier: GLOBAL }).then(
          () => undefined,
          (e: unknown) => e as Error
        );
        expect(error?.message).toContain('already detached from its global cluster');
      });

      it('a ModifyDBCluster failing with no detach (not listed) does not claim one', async () => {
        armRemoval({ member: false });
        const base = mockSend.getMockImplementation()!;
        mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Bag }) =>
          cmd.constructor.name === 'ModifyDBClusterCommand'
            ? Promise.reject(awsError('InvalidDBClusterStateFault', 'busy'))
            : base(cmd)
        );
        const error = await update({}, { GlobalClusterIdentifier: GLOBAL }).then(
          () => undefined,
          (e: unknown) => e as Error
        );
        expect(error?.message).not.toContain('already detached');
      });

      it('a failed detach fails the update before any ModifyDBCluster, non-retryable', async () => {
        armRemoval({ remove: awsError('InvalidParameterValue', 'nope') });
        const error = await update({}, { GlobalClusterIdentifier: GLOBAL }).then(
          () => undefined,
          (e: unknown) => e as Error
        );
        expect(error?.message).toContain(
          'Failed to update DocDB DBCluster L: detaching c from global cluster my-global failed'
        );
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(names()).not.toContain('ModifyDBClusterCommand');
      });
    });

    it('an addition the live cluster already shows is accepted, found on a later page', async () => {
      armUpdate([[['someone-else', ['arn:other']]], [[GLOBAL, [ARN]]]]);
      await update({ GlobalClusterIdentifier: GLOBAL }, {});
      expect(sent('DescribeGlobalClustersCommand')).toEqual([{}, { Marker: '1' }]);
      expect(names()).toContain('ModifyDBClusterCommand');
    });

    it('an unreadable membership keeps the refusal', async () => {
      armUpdate(awsError('AccessDenied', 'not authorized'));
      await expect(update({ GlobalClusterIdentifier: GLOBAL }, {})).rejects.toThrow(
        'Changing GlobalClusterIdentifier to a different global cluster is not supported'
      );
      expect(names()).not.toContain('ModifyDBClusterCommand');
    });

    it.each<[Bag, Bag]>([
      [{ replayingState: true }, { GlobalClusterIdentifier: 'other' }],
      [{ desiredFromAwsReadback: true }, { GlobalClusterIdentifier: 'other' }],
    ])(
      'a state-borne change (%o) warns, keeps the membership and records it',
      async (context, desired) => {
        armUpdate([[[GLOBAL, [ARN]]]]);
        const result = await update(
          { BackupRetentionPeriod: 2, ...desired },
          { GlobalClusterIdentifier: GLOBAL, BackupRetentionPeriod: 1 },
          context
        );
        expect(names()).toContain('ModifyDBClusterCommand');
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          'the cluster keeps its current global cluster membership'
        );
        expect(result.effectiveProperties).toEqual({
          BackupRetentionPeriod: 2,
          GlobalClusterIdentifier: GLOBAL,
        });
      }
    );

    it('a rollback of a forward detach (re-join) warns and never claims the re-join', async () => {
      armUpdate();
      const result = await update({ GlobalClusterIdentifier: GLOBAL }, {}, { replayingState: true });
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'the cluster keeps its current global cluster membership'
      );
      expect(result.effectiveProperties).toStrictEqual({});
    });

    it('a kept membership is recorded on top of the password arm\'s own record', async () => {
      armUpdate([[[GLOBAL, [ARN]]]]);
      // A replay turning a managed password off with none to send keeps it on,
      // and records ManageMasterUserPassword: true; the membership rides that.
      const result = await update(
        { ManageMasterUserPassword: false, GlobalClusterIdentifier: 'other' },
        { GlobalClusterIdentifier: GLOBAL, ManageMasterUserPassword: true },
        { replayingState: true }
      );
      expect(result.effectiveProperties).toStrictEqual({
        ManageMasterUserPassword: true,
        GlobalClusterIdentifier: GLOBAL,
      });
    });

    it('a drift --revert readback without the key (drift-unknown) is no change: kept silently', async () => {
      armUpdate([[[GLOBAL, [ARN]]]]);
      const result = await update(
        { BackupRetentionPeriod: 2 },
        { GlobalClusterIdentifier: GLOBAL, BackupRetentionPeriod: 1 },
        { desiredFromAwsReadback: true }
      );
      expect(names()).not.toContain('DescribeGlobalClustersCommand');
      expect(warn).not.toHaveBeenCalled();
      expect(result.effectiveProperties).toStrictEqual({
        BackupRetentionPeriod: 2,
        GlobalClusterIdentifier: GLOBAL,
      });
    });
  });

  describe('delete', () => {
    const del = (properties: Bag | undefined, context?: Bag) =>
      provider.delete('L', 'c', CLUSTER, properties, context as never);
    const failure = (properties: Bag | undefined, context?: Bag) =>
      del(properties, context).then(
        () => undefined,
        (e: unknown) => e as Error
      );

    it('detaches by ARN, waits until it left the member list, then deletes', async () => {
      armDelete({ memberPolls: [[ARN], [ARN], []] });
      await del({ GlobalClusterIdentifier: GLOBAL });
      expect(sent('RemoveFromGlobalClusterCommand')).toEqual([
        { GlobalClusterIdentifier: GLOBAL, DbClusterIdentifier: ARN },
      ]);
      const order = names();
      expect(order.indexOf('RemoveFromGlobalClusterCommand')).toBeLessThan(
        order.indexOf('DeleteDBClusterCommand')
      );
      expect(order.filter((n) => n === 'DescribeGlobalClustersCommand')).toHaveLength(3);
    });

    it('waits for the cluster to be available again before the delete', async () => {
      const modifying = { DBClusterArn: ARN, Status: 'modifying' };
      // The pre-detach read (available, by default), then two `modifying`.
      armDelete({
        clusterReads: [
          { DBClusterArn: ARN, Status: 'available', DeletionProtection: false },
          modifying,
          modifying,
        ],
      });
      await del({ GlobalClusterIdentifier: GLOBAL });
      // The pre-detach read, then one poll per post-detach status read.
      expect(names().filter((n) => n === 'DescribeGlobalClustersCommand')).toHaveLength(4);
      // The read right before the delete is the first `available` one.
      const order = names();
      const before = order.lastIndexOf('DescribeDBClustersCommand', order.indexOf('DeleteDBClusterCommand'));
      expect(order.slice(0, before + 1).filter((n) => n === 'DescribeDBClustersCommand')).toHaveLength(4);
    });

    it('a cluster gone after the detach ends the wait, and the detach is claimed', async () => {
      armDelete({
        clusterReads: [{ DBClusterArn: ARN, Status: 'available', DeletionProtection: false }, null],
      });
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DeleteDBClusterCommand'
          ? Promise.reject(awsError('InvalidDBClusterStateFault', 'cluster busy'))
          : base(cmd)
      );
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('already detached from its global cluster');
      expect(names().filter((n) => n === 'DescribeGlobalClustersCommand')).toHaveLength(2);
    });

    it('a throttled cluster read after the detach is waited through', async () => {
      armDelete({
        clusterReads: [
          { DBClusterArn: ARN, Status: 'available', DeletionProtection: false },
          awsError('ThrottlingException', 'Rate exceeded'),
        ],
      });
      await del({ GlobalClusterIdentifier: GLOBAL });
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('a cluster read without an ARN fails before any detach, non-retryable', async () => {
      armDelete({ clusterReads: [{ Status: 'available', DeletionProtection: false }] });
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('could not read the ARN of c to detach it from global cluster my-global');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).not.toContain('DeleteDBClusterCommand');
    });

    it('a primary whose global cluster still has other members fails at once, naming them', async () => {
      const other = 'arn:aws:rds:eu-west-1:123456789012:cluster:secondary-1';
      // A second read without it keeps a mutant that detaches anyway finite.
      armDelete({ memberPolls: [[ARN, other], [other]] });
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('is the primary of global cluster my-global');
      expect(error?.message).toContain('(secondary-1)');
      expect(error?.message).not.toContain('123456789012');
      expect(isDeleteStarted(error)).toBe(false);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    });

    it('an other member whose ARN has an unexpected shape is named without the ARN', async () => {
      const odd = 'arn:aws-weird:docdb:us-east-1:123456789012:db-cluster/x';
      armDelete({ memberPolls: [[ARN, odd], [odd]] });
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('((unnamed))');
      expect(error?.message).not.toContain('123456789012');
    });

    it('a secondary is detached even though the global cluster has other members', async () => {
      const primary = 'arn:aws:rds:eu-west-1:123456789012:cluster:primary-1';
      armDelete({ writer: false, memberPolls: [[ARN, primary], [primary]] });
      await del({ GlobalClusterIdentifier: GLOBAL });
      expect(names()).toContain('RemoveFromGlobalClusterCommand');
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('a detach that stays throttled fails at the whole budget', async () => {
      let clock = 0;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 400_000));
      try {
        // Throttled well past the budget, then accepted: a missing budget check
        // reaches the delete instead of looping forever.
        armDelete({
          remove: [...Array.from({ length: 20 }, () => awsError('ThrottlingException', 'Rate exceeded')), undefined],
        });
        const error = await failure({ GlobalClusterIdentifier: GLOBAL });
        expect(error?.message).toContain('timed out waiting for c to leave global cluster my-global');
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(names()).not.toContain('DeleteDBClusterCommand');
      } finally {
        now.mockRestore();
      }
    });

    it.each<[string, string[] | Error]>([
      ['not listing the cluster', []],
      ['gone', awsError('GlobalClusterNotFoundFault')],
    ])('a global cluster %s before the detach: no detach, none claimed', async (_l, first) => {
      armDelete({ memberPolls: [first] });
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DeleteDBClusterCommand'
          ? Promise.reject(awsError('InvalidDBClusterStateFault', 'cluster busy'))
          : base(cmd)
      );
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).toContain('DeleteDBClusterCommand');
      expect(error?.message).not.toContain('already detached');
      expect(isDeleteStarted(error)).toBe(false);
    });

    it('a throttled read before the detach is waited through, then the detach runs', async () => {
      armDelete({ memberPolls: [awsError('ThrottlingException', 'Rate exceeded'), [ARN], []] });
      await del({ GlobalClusterIdentifier: GLOBAL });
      expect(names()).toContain('RemoveFromGlobalClusterCommand');
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('an unreadable membership before the detach fails the delete, nothing changed', async () => {
      armDelete({ memberPolls: [awsError('AccessDenied', 'not authorized')] });
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('could not read whether c is a member of global cluster my-global');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isDeleteStarted(error)).toBe(false);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    });

    it('a GlobalClusterNotFoundFault from the detach: no detach claimed, the delete still runs', async () => {
      armDelete({ remove: awsError('GlobalClusterNotFoundFault', 'x not found') });
      await del({ GlobalClusterIdentifier: GLOBAL });
      expect(names()).toContain('DeleteDBClusterCommand');
      // Only the pre-detach read: no wait for a detach that did not happen.
      expect(names().filter((n) => n === 'DescribeGlobalClustersCommand')).toHaveLength(1);
    });

    it('a DBClusterNotFoundFault from the detach of a listed member is an earlier send that landed: waited on, claimed', async () => {
      armDelete({ remove: awsError('DBClusterNotFoundFault', 'not a member'), memberPolls: [[ARN], [ARN], []] });
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DeleteDBClusterCommand'
          ? Promise.reject(awsError('AccessDenied', 'denied'))
          : base(cmd)
      );
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(names().filter((n) => n === 'DescribeGlobalClustersCommand')).toHaveLength(3);
      expect(error?.message).toContain('already detached from its global cluster');
      expect(isDeleteStarted(error)).toBe(true);
    });

    it('a global cluster that keeps refusing the detach as busy fails before the whole budget', async () => {
      let clock = 0;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 120_000));
      try {
        armDelete({ remove: awsError('InvalidGlobalClusterStateFault', 'secondaries attached') });
        const error = await failure({ GlobalClusterIdentifier: GLOBAL });
        expect(error?.message).toContain('detaching c from global cluster my-global failed');
        expect(isDeleteStarted(error)).toBe(false);
        // 600 s at 120 s a read: a handful of attempts, not the 30-minute budget.
        expect(names().filter((n) => n === 'RemoveFromGlobalClusterCommand').length).toBeLessThan(8);
        expect(names()).not.toContain('DeleteDBClusterCommand');
      } finally {
        now.mockRestore();
      }
    });

    it('a global cluster that vanished during the wait ends the wait', async () => {
      armDelete({ memberPolls: [[ARN], awsError('GlobalClusterNotFoundFault')] });
      await del({ GlobalClusterIdentifier: GLOBAL });
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('a busy or throttled detach is waited through, then the delete runs', async () => {
      armDelete({
        remove: [awsError('InvalidDBClusterStateFault'), awsError('InvalidGlobalClusterStateFault'), undefined],
        memberPolls: [[ARN], awsError('ThrottlingException', 'Rate exceeded'), [ARN], []],
      });
      await del({ GlobalClusterIdentifier: GLOBAL });
      expect(names().filter((n) => n === 'RemoveFromGlobalClusterCommand')).toHaveLength(3);
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('any other detach failure fails the delete, non-retryable and not gone, even when AWS says "not found"', async () => {
      armDelete({ remove: awsError('InvalidParameterValue', 'member not found in a ready state') });
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('detaching c from global cluster my-global failed');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isMarkedNotGone(error)).toBe(true);
      expect(isDeleteStarted(error)).toBe(false);
      expect(names()).not.toContain('DeleteDBClusterCommand');
    });

    it('an unreadable member list after the detach fails the delete, marked as started', async () => {
      armDelete({ memberPolls: [[ARN], awsError('AccessDenied', 'not authorized')] });
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('could not confirm c left global cluster my-global');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isDeleteStarted(error)).toBe(true);
      expect(names()).not.toContain('DeleteDBClusterCommand');
    });

    it('an AWS-authored failure is named by its class; the text goes to debug through the masker', async () => {
      const text = 'User: arn:aws:sts::111122223333:assumed-role/deployer/s3cr3t is not authorized';
      armDelete({
        remove: Object.assign(new Error(text), {
          name: 'AccessDenied',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        }),
      });
      const error = await failure(
        { GlobalClusterIdentifier: GLOBAL },
        { maskSecrets: (t: string) => t.replaceAll('s3cr3t', '***') }
      );
      expect(error?.message).toBe(
        `Failed to delete DocDB DBCluster L: detaching c from global cluster my-global failed (AccessDenied. ${VERBOSE_POINTER})`
      );
      const lines = debug.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).toContain('assumed-role/deployer/*** is not authorized');
      expect(lines).not.toContain('s3cr3t');
    });

    it('a protected cluster is NOT detached: the detach is irreversible and the delete would fail', async () => {
      armDelete({ protection: [true] });
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('deletion protection on');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).not.toContain('DeleteDBClusterCommand');
    });

    it('under --remove-protection the flip gets a grace to show before the detach', async () => {
      // Reads: the flip's observe (true), then the detach's reads: true, false.
      armDelete({ protection: [true, true, false] });
      await del({ GlobalClusterIdentifier: GLOBAL }, { removeProtection: true });
      expect(names()).toContain('RemoveFromGlobalClusterCommand');
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('a delete failing after the detach says the cluster is already standalone', async () => {
      armDelete({});
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DeleteDBClusterCommand'
          ? Promise.reject(awsError('InvalidDBClusterStateFault', 'cluster busy'))
          : base(cmd)
      );
      const error = await failure({ GlobalClusterIdentifier: GLOBAL });
      expect(error?.message).toContain('already detached from its global cluster');
      expect(isDeleteStarted(error)).toBe(true);
    });

    it.each([
      ['no bag', undefined],
      ['absent', {}],
      ['null', { GlobalClusterIdentifier: null }],
      ['blank', { GlobalClusterIdentifier: '  ' }],
      ['non-string', { GlobalClusterIdentifier: { Ref: 'Global' } }],
    ])('%s GlobalClusterIdentifier: no detach, a plain delete', async (_label, properties) => {
      armDelete({});
      await del(properties as Bag | undefined);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).not.toContain('DescribeGlobalClustersCommand');
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('a cluster already gone: the region-checked not-found arm, no detach, no delete', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.reject(awsError('DBClusterNotFoundFault', 'DBCluster c not found'))
          : Promise.resolve({})
      );
      await expect(del({ GlobalClusterIdentifier: GLOBAL })).resolves.toBeUndefined();
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).not.toContain('DeleteDBClusterCommand');
    });
  });
});
