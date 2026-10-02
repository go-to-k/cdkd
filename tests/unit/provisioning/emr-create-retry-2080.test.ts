/**
 * Issue #2080 (Plan C, EMR): `RunJobFlow`, `AddInstanceFleet` and
 * `AddInstanceGroups` mint their id and carry no idempotency token. A 5xx whose
 * request AWS completed used to be replayed -- inside one `send` by the SDK,
 * invisibly, or by the engine's retry -- launching a second cluster (or adding
 * a second TASK fleet / group) that no state records and that bills per
 * instance-hour. The create now goes through a client that refuses the SDK's
 * 5xx retry, and the engine's next attempt REPORTS the candidates first.
 * Detection only: nothing is adopted, terminated or scaled.
 *
 * The fakes count RESOURCES, not calls (acceptance item 2), and every retry
 * advances the clock (acceptance item 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, sentVia, baseStrategy, ctorArgs, regionFails } = vi.hoisted(
  () => ({
    mockSend: vi.fn(),
    /** How many upcoming `config.region()` reads reject, across every client. */
    regionFails: { remaining: 0 },
    /** Every `EMRClient` constructor's options, in order. */
    ctorArgs: [] as Array<{ region?: unknown }>,
    warnSpy: vi.fn(),
    debugSpy: vi.fn(),
    /** `[command name, client config]` per send, so a test can see WHICH client sent it. */
    sentVia: [] as Array<
      [string, { region: () => Promise<unknown>; retryStrategy: () => Promise<unknown> }]
    >,
    /** A stand-in for the SDK's resolved V2 retry strategy. */
    baseStrategy: {
      acquireInitialRetryToken: async (_scope: string) => 'token',
      refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
        'retry-token',
      recordSuccess: (_token: unknown) => undefined,
    },
  })
);

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation((options: { region?: unknown }) => {
      ctorArgs.push(options);
      const config = {
        region: () => {
          if (regionFails.remaining > 0) {
            regionFails.remaining--;
            return Promise.reject(new Error('Region is missing'));
          }
          return Promise.resolve(options.region ?? 'us-east-1');
        },
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
      return {
        config,
        send: (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, config]);
          return mockSend(command);
        },
      };
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  EMRClusterProvider,
  resetEMRClusterCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-cluster-provider.js';
import {
  EMRInstanceFleetConfigProvider,
  resetEMRInstanceFleetCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import {
  EMRInstanceGroupConfigProvider,
  resetEMRInstanceGroupCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { WITHHELD_AWS_COMMAND } from '../../../src/provisioning/replacement-protection-advice.js';

/** EMR's modeled 500, in the shape `isTransientServerError` / `isAmbiguousOutcomeError` classify. */
const transient500 = (): Error =>
  Object.assign(new Error('Internal server error'), {
    name: 'InternalServerError',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/** A throttle IDENTIFIED by name on a 503, so only the name exemption keeps it from arming the latch. */
const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: EMR did nothing, and the text is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error(
      'User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: elasticmapreduce:RunJobFlow'
    ),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

interface Timeline {
  CreationDateTime: Date;
}

interface FakeCluster {
  Id: string;
  Name: string;
  Status: { State: string; Timeline: Timeline };
}

interface FakeFleet {
  ClusterId: string;
  Id: string;
  Name?: string;
  InstanceFleetType: string;
  ProvisionedOnDemandCapacity: number;
  ProvisionedSpotCapacity: number;
  Status: { State: string; Timeline: Timeline };
}

interface FakeGroup {
  ClusterId: string;
  Id: string;
  Name?: string;
  InstanceGroupType: string;
  RunningInstanceCount: number;
  Status: { State: string; Timeline: Timeline };
}

/** A fake EMR. The arrays count RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeEMR {
  readonly clusters: FakeCluster[] = [];
  readonly fleets: FakeFleet[] = [];
  readonly groups: FakeGroup[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** The next create makes its resource, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Items per list page. */
  pageSize = 50;
  /** `ListClusters` ignores `CreatedAfter` / `CreatedBefore` (a coarser server filter than ours). */
  ignoreDateFilter = false;
  /** Runs on every list call, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  private nextId = 1;

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'RunJobFlowCommand': {
        const created: FakeCluster = {
          Id: `j-${this.nextId++}`,
          Name: input['Name'] as string,
          Status: { State: 'WAITING', Timeline: { CreationDateTime: new Date(Date.now()) } },
        };
        this.clusters.push(created);
        this.loseResponse();
        return { JobFlowId: created.Id };
      }
      case 'DescribeClusterCommand':
        return { Cluster: this.clusters.find((c) => c.Id === input['ClusterId']) };
      case 'ListClustersCommand': {
        this.onList?.();
        const after = input['CreatedAfter'] as Date | undefined;
        const before = input['CreatedBefore'] as Date | undefined;
        const states = input['ClusterStates'] as string[] | undefined;
        return this.page(
          'Clusters',
          this.clusters.filter(
            (c) =>
              (!states || states.includes(c.Status.State)) &&
              (this.ignoreDateFilter ||
                ((!after || c.Status.Timeline.CreationDateTime >= after) &&
                  (!before || c.Status.Timeline.CreationDateTime <= before)))
          ),
          input['Marker']
        );
      }
      case 'AddInstanceFleetCommand': {
        const fleet = input['InstanceFleet'] as Record<string, unknown>;
        const created: FakeFleet = {
          ClusterId: input['ClusterId'] as string,
          Id: `if-${this.nextId++}`,
          ...(fleet['Name'] !== undefined && { Name: fleet['Name'] as string }),
          InstanceFleetType: fleet['InstanceFleetType'] as string,
          ProvisionedOnDemandCapacity: Number(fleet['TargetOnDemandCapacity'] ?? 0),
          ProvisionedSpotCapacity: Number(fleet['TargetSpotCapacity'] ?? 0),
          Status: { State: 'RUNNING', Timeline: { CreationDateTime: new Date(Date.now()) } },
        };
        this.fleets.push(created);
        this.loseResponse();
        return { ClusterId: created.ClusterId, InstanceFleetId: created.Id };
      }
      case 'ListInstanceFleetsCommand':
        this.onList?.();
        return this.page(
          'InstanceFleets',
          this.fleets.filter((f) => f.ClusterId === input['ClusterId']),
          input['Marker']
        );
      case 'AddInstanceGroupsCommand': {
        const groups = input['InstanceGroups'] as Array<Record<string, unknown>>;
        const group = groups[0]!;
        const created: FakeGroup = {
          ClusterId: input['JobFlowId'] as string,
          Id: `ig-${this.nextId++}`,
          ...(group['Name'] !== undefined && { Name: group['Name'] as string }),
          InstanceGroupType: group['InstanceRole'] as string,
          RunningInstanceCount: Number(group['InstanceCount']),
          Status: { State: 'RUNNING', Timeline: { CreationDateTime: new Date(Date.now()) } },
        };
        this.groups.push(created);
        this.loseResponse();
        return { JobFlowId: created.ClusterId, InstanceGroupIds: [created.Id] };
      }
      case 'ListInstanceGroupsCommand':
        this.onList?.();
        return this.page(
          'InstanceGroups',
          this.groups.filter((g) => g.ClusterId === input['ClusterId']),
          input['Marker']
        );
      default:
        return {};
    }
  };

  private loseResponse(): void {
    if (this.loseNextCreateResponse) {
      const error = this.loseNextCreateResponse;
      this.loseNextCreateResponse = undefined;
      throw error;
    }
  }

  private page<T>(key: string, all: T[], marker: unknown): Record<string, unknown> {
    const start = marker === undefined ? 0 : Number(marker);
    const end = start + this.pageSize;
    return {
      [key]: all.slice(start, end).map((a) => structuredClone(a)),
      ...(end < all.length && { Marker: String(end) }),
    };
  }

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const CLUSTER_PROPS = {
  Name: 'etl-cluster',
  ReleaseLabel: 'emr-7.1.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  Instances: {
    MasterInstanceGroup: { InstanceCount: 1, InstanceType: 'm5.xlarge' },
    KeepJobFlowAliveWhenNoSteps: true,
  },
};
const FLEET_PROPS = {
  ClusterId: 'j-PARENT',
  InstanceFleetType: 'TASK',
  Name: 'task-fleet',
  TargetOnDemandCapacity: 1,
  InstanceTypeConfigs: [{ InstanceType: 'm5.xlarge' }],
};
const GROUP_PROPS = {
  JobFlowId: 'j-PARENT',
  InstanceRole: 'TASK',
  InstanceType: 'm5.xlarge',
  InstanceCount: 2,
  Name: 'task-group',
};

const CLUSTER = 'AWS::EMR::Cluster';
const FLEET = 'AWS::EMR::InstanceFleetConfig';
const GROUP = 'AWS::EMR::InstanceGroupConfig';

describe('EMR tokenless create retry safety (issue #2080, detection only)', () => {
  let aws: FakeEMR;
  let savedRegion: string | undefined;
  let cluster: EMRClusterProvider;
  let fleet: EMRInstanceFleetConfigProvider;
  let group: EMRInstanceGroupConfigProvider;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetEMRClusterCreateRetryStateForTests();
    resetEMRInstanceFleetCreateRetryStateForTests();
    resetEMRInstanceGroupCreateRetryStateForTests();
    aws = new FakeEMR();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    ctorArgs.length = 0;
    regionFails.remaining = 0;
    // Not the SDK's fallback, so a client built without the stack region is told apart.
    savedRegion = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'eu-west-3';
    cluster = new EMRClusterProvider({ pollIntervalMs: 1 });
    fleet = new EMRInstanceFleetConfigProvider({ pollIntervalMs: 1 });
    group = new EMRInstanceGroupConfigProvider({ pollIntervalMs: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  const providerFor = (type: string) =>
    type === CLUSTER ? cluster : type === FLEET ? fleet : group;

  const createWithRetry = (
    type: string,
    props: Record<string, unknown>,
    logicalId = 'Res',
    maskSecrets?: (text: string) => string
  ) =>
    withRetry(
      () =>
        providerFor(type).create(
          logicalId,
          type,
          props,
          maskSecrets !== undefined ? { maskSecrets } : undefined
        ),
      logicalId,
      { sleep: advancingSleep }
    );

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportFor = (action: string): string | undefined =>
    warnLines().find((l) => l.includes(`earlier ${action} attempt`));

  describe('RunJobFlow', () => {
    it('names the cluster a lost response launched, with a read then a conditional terminate command', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry(CLUSTER, CLUSTER_PROPS);

      // Two clusters exist -- the orphan is REPORTED, not prevented -- and the
      // recorded one is the second.
      expect(aws.clusters.map((c) => c.Id)).toEqual(['j-1', 'j-2']);
      expect(result.physicalId).toBe('j-2');
      expect(aws.calls).not.toContain('TerminateJobFlowsCommand');
      const line = reportFor('RunJobFlow')!;
      expect(line).toContain('EMR may have created a cluster named etl-cluster');
      expect(line).toContain('1 cluster(s) were created');
      const read = line.indexOf('aws emr describe-cluster --cluster-id j-1 --region eu-west-3');
      const remove = line.indexOf('aws emr terminate-clusters --cluster-ids j-1 --region eu-west-3');
      expect(read).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(read);
      expect(line).toContain('does not adopt or delete');
      expect(line).toContain('Only after confirming');
      expect(line).toContain('terminate it:');
      expect(line).not.toContain('modify-cluster-attributes');
    });

    it('asks the server for the window only, and filters the answer by it too', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(CLUSTER, CLUSTER_PROPS);

      const list = mockSend.mock.calls
        .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
        .find((c) => c.constructor.name === 'ListClustersCommand')!;
      // The failed attempt ran at 00:00:00; the window is skew-widened by 5 s.
      expect((list.input['CreatedAfter'] as Date).toISOString()).toBe('2026-09-30T23:59:55.000Z');
      expect((list.input['CreatedBefore'] as Date).toISOString()).toBe('2026-10-01T00:00:05.000Z');
    });

    it('filters by the window itself, not only through the server-side date filter', async () => {
      aws.ignoreDateFilter = true;
      aws.clusters.push({
        Id: 'j-OLDER',
        Name: 'etl-cluster',
        Status: {
          State: 'WAITING',
          Timeline: { CreationDateTime: new Date(Date.now() - 60_000) },
        },
      });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(CLUSTER, CLUSTER_PROPS);

      const line = reportFor('RunJobFlow')!;
      expect(line).toContain('1 cluster(s) were created');
      expect(line).not.toContain('j-OLDER');
    });

    it('a template with termination protection says to unprotect a protected candidate first, never chained onto the terminate', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(CLUSTER, {
        ...CLUSTER_PROPS,
        Instances: { ...CLUSTER_PROPS.Instances, TerminationProtected: true },
      });

      const line = reportFor('RunJobFlow')!;
      expect(line).toContain(
        "if describe-cluster shows it on for the candidate, first run aws emr modify-cluster-attributes --cluster-id '<id>' --no-termination-protected --region eu-west-3 with its id"
      );
      expect(line).toContain('aws emr terminate-clusters --cluster-ids j-1 --region eu-west-3');
      // The candidate may be another deploy's cluster: no pasteable unprotect for a real id.
      expect(line).not.toContain('--cluster-id j-1 --no-termination-protected');
    });

    it.each(['TERMINATING', 'TERMINATED', 'TERMINATED_WITH_ERRORS'])(
      'does not report a candidate that is already %s',
      async (state) => {
        aws.clusters.push({
          Id: 'j-GONE',
          Name: 'etl-cluster',
          Status: { State: state, Timeline: { CreationDateTime: new Date(Date.now()) } },
        });
        aws.loseNextCreateResponse = transient500();

        await createWithRetry(CLUSTER, CLUSTER_PROPS);

        const line = reportFor('RunJobFlow')!;
        expect(line).toContain('1 cluster(s) were created');
        expect(line).not.toContain('j-GONE');
      }
    );

    it('does not report a cluster created before the window, recorded, or of another name', async () => {
      const earlier = await cluster.create('Other', CLUSTER, CLUSTER_PROPS);
      aws.clusters.push(
        {
          Id: 'j-OLDER',
          Name: 'etl-cluster',
          Status: {
            State: 'WAITING',
            Timeline: { CreationDateTime: new Date(Date.now() - 60_000) },
          },
        },
        {
          Id: 'j-OTHERNAME',
          Name: 'x',
          Status: { State: 'WAITING', Timeline: { CreationDateTime: new Date(Date.now()) } },
        }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(CLUSTER, CLUSTER_PROPS);

      const line = reportFor('RunJobFlow')!;
      expect(line).toContain('1 cluster(s) were created');
      for (const id of [earlier.physicalId, 'j-OLDER', 'j-OTHERNAME']) {
        expect(line).not.toContain(`${id},`);
        expect(line).not.toContain(`${id}.`);
        expect(line).not.toContain(`--cluster-id ${id} `);
      }
    });

    it('follows ListClusters pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.clusters.push(
        {
          Id: 'j-A',
          Name: 'a',
          Status: { State: 'WAITING', Timeline: { CreationDateTime: new Date(Date.now()) } },
        },
        {
          Id: 'j-B',
          Name: 'b',
          Status: { State: 'WAITING', Timeline: { CreationDateTime: new Date(Date.now()) } },
        }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(CLUSTER, CLUSTER_PROPS);

      expect(reportFor('RunJobFlow')).toContain('--cluster-id j-1 ');
    });

    it('masks a short secret-derived cluster name as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(CLUSTER, { ...CLUSTER_PROPS, Name: 'zq' }, 'Res', (t) =>
        t === 'zq' ? '***' : t
      );

      const line = reportFor('RunJobFlow')!;
      expect(line).toContain('--cluster-id j-1 ');
      expect(line).toContain('named ***');
      expect(line).not.toContain('named zq');
    });

    it('two ambiguous attempts in a row: the second report covers the FIRST attempt too', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(() => cluster.create('Res', CLUSTER, CLUSTER_PROPS), 'Res', {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      });

      expect(aws.clusters).toHaveLength(3);
      const lines = warnLines().filter((l) => l.includes('earlier RunJobFlow attempt'));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('between 2026-09-30T23:59:55.000Z');
      expect(lines[1]).toContain('--cluster-id j-1 ');
      expect(lines[1]).toContain('--cluster-id j-2 ');
    });

    it('a failed ListClusters warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('ListClustersCommand', [propagationDenied()]);

      const result = await createWithRetry(CLUSTER, CLUSTER_PROPS);

      expect(result.physicalId).toBe('j-2');
      expect(
        warnLines().some(
          (l) =>
            l.includes('EMR may have created a cluster named etl-cluster') &&
            l.includes('could not look for it (ListClusters')
        )
      ).toBe(true);
    });

    it('a DEFINITE RunJobFlow failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('RunJobFlowCommand', [propagationDenied()]);

      await createWithRetry(CLUSTER, CLUSTER_PROPS);

      expect(aws.count('ListClustersCommand')).toBe(0);
      expect(aws.clusters).toHaveLength(1);
    });

    it('a throttled RunJobFlow triggers no lookup', async () => {
      aws.failNext.set('RunJobFlowCommand', [throttled()]);

      await createWithRetry(CLUSTER, CLUSTER_PROPS);

      expect(aws.count('ListClustersCommand')).toBe(0);
      expect(aws.clusters).toHaveLength(1);
    });

    it('a region that cannot be read drops the --region flag rather than the command', async () => {
      aws.loseNextCreateResponse = transient500();
      regionFails.remaining = 1;

      await createWithRetry(CLUSTER, CLUSTER_PROPS);

      const line = reportFor('RunJobFlow')!;
      expect(line).toContain('aws emr describe-cluster --cluster-id j-1.');
    });
  });

  describe.each([
    {
      label: 'AddInstanceFleet',
      type: FLEET,
      props: FLEET_PROPS,
      list: 'ListInstanceFleetsCommand',
      resources: (): Array<{ Id: string; Status: { Timeline: Timeline } }> => aws.fleets,
      firstId: 'if-1',
      secondId: 'if-2',
      noun: 'TASK instance fleet(s)',
      subject: 'a TASK instance fleet named task-fleet in cluster j-PARENT',
      inspect: 'aws emr list-instance-fleets --cluster-id j-PARENT --region eu-west-3',
      remove:
        'aws emr modify-instance-fleet --cluster-id j-PARENT --instance-fleet InstanceFleetId=if-1,TargetOnDemandCapacity=0,TargetSpotCapacity=0 --region eu-west-3',
      typeKey: 'InstanceFleetType',
      seed: (id: string, overrides: Record<string, unknown>) =>
        aws.fleets.push({
          ClusterId: 'j-PARENT',
          Id: id,
          Name: 'task-fleet',
          InstanceFleetType: 'TASK',
          ProvisionedOnDemandCapacity: 1,
          ProvisionedSpotCapacity: 0,
          Status: { State: 'RUNNING', Timeline: { CreationDateTime: new Date(Date.now()) } },
          ...overrides,
        } as FakeFleet),
    },
    {
      label: 'AddInstanceGroups',
      type: GROUP,
      props: GROUP_PROPS,
      list: 'ListInstanceGroupsCommand',
      resources: (): Array<{ Id: string; Status: { Timeline: Timeline } }> => aws.groups,
      firstId: 'ig-1',
      secondId: 'ig-2',
      noun: 'TASK instance group(s)',
      subject: 'a TASK instance group named task-group in cluster j-PARENT',
      inspect: 'aws emr list-instance-groups --cluster-id j-PARENT --region eu-west-3',
      remove:
        'aws emr modify-instance-groups --cluster-id j-PARENT --instance-groups InstanceGroupId=ig-1,InstanceCount=0 --region eu-west-3',
      typeKey: 'InstanceRole',
      seed: (id: string, overrides: Record<string, unknown>) =>
        aws.groups.push({
          ClusterId: 'j-PARENT',
          Id: id,
          Name: 'task-group',
          InstanceGroupType: 'TASK',
          RunningInstanceCount: 2,
          Status: { State: 'RUNNING', Timeline: { CreationDateTime: new Date(Date.now()) } },
          ...overrides,
        } as FakeGroup),
    },
  ])('$label', (c) => {
    it('names the TASK child a lost response added, with a list then a conditional scale-to-zero command', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry(c.type, c.props);

      expect(c.resources().map((r) => r.Id)).toEqual([c.firstId, c.secondId]);
      expect(result.physicalId).toBe(c.secondId);
      const line = reportFor(c.label)!;
      expect(line).toContain(`EMR may have created ${c.subject}`);
      expect(line).toContain(`1 ${c.noun} were created`);
      const read = line.indexOf(c.inspect);
      const remove = line.indexOf(c.remove);
      expect(read).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(read);
      expect(line).toContain('Only after confirming');
      expect(line).toContain('scale it to zero');
      // Reported, never scaled.
      expect(aws.calls).not.toContain('ModifyInstanceFleetCommand');
      expect(aws.calls).not.toContain('ModifyInstanceGroupsCommand');
    });

    it('two ambiguous attempts in a row: the second report covers the FIRST attempt too', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(() => providerFor(c.type).create('Res', c.type, c.props), 'Res', {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      });

      expect(c.resources()).toHaveLength(3);
      const lines = warnLines().filter((l) => l.includes(`earlier ${c.label} attempt`));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('between 2026-09-30T23:59:55.000Z');
      expect(lines[1]).toContain(`2 ${c.noun} were created`);
    });

    it('follows the list pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      c.seed('x-A', { Name: 'a' });
      c.seed('x-B', { Name: 'b' });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(c.type, c.props);

      expect(reportFor(c.label)).toContain(`1 ${c.noun} were created`);
    });

    it('a region that cannot be read drops the --region flag rather than the command', async () => {
      aws.loseNextCreateResponse = transient500();
      regionFails.remaining = 1;

      await createWithRetry(c.type, c.props);

      const line = reportFor(c.label)!;
      expect(line).toContain(c.inspect.replace(' --region eu-west-3', '.'));
    });

    it('does not report one created before the window, recorded, of another name, type or cluster', async () => {
      const earlier = await providerFor(c.type).create('Other', c.type, c.props);
      c.seed('x-OLDER', {
        Status: {
          State: 'RUNNING',
          Timeline: { CreationDateTime: new Date(Date.now() - 60_000) },
        },
      });
      c.seed('x-OTHERNAME', { Name: 'other' });
      c.seed('x-CORE', c.type === FLEET ? { InstanceFleetType: 'CORE' } : { InstanceGroupType: 'CORE' });
      c.seed('x-OTHERCLUSTER', { ClusterId: 'j-ELSEWHERE' });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(c.type, c.props);

      const line = reportFor(c.label)!;
      expect(line).toContain(`1 ${c.noun} were created`);
      for (const id of [earlier.physicalId, 'x-OLDER', 'x-OTHERNAME', 'x-CORE', 'x-OTHERCLUSTER']) {
        expect(line).not.toContain(id);
      }
    });

    it('with no Name in the template, matches on type and window alone', async () => {
      const { Name: _name, ...unnamed } = c.props;
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(c.type, unnamed);

      const line = reportFor(c.label)!;
      expect(line).toContain(`1 ${c.noun} were created`);
      expect(line).not.toContain(' named ');
    });

    it('prints the list command once even for several candidates', async () => {
      aws.loseNextCreateResponse = transient500();
      // A second candidate created inside the same window, by another deploy.
      aws.onList = () => {
        c.seed('x-SIBLING', {
          Status: {
            State: 'RUNNING',
            Timeline: { CreationDateTime: c.resources()[0]!.Status.Timeline.CreationDateTime },
          },
        });
        aws.onList = undefined;
      };

      await createWithRetry(c.type, c.props);

      const line = reportFor(c.label)!;
      expect(line).toContain(`2 ${c.noun} were created`);
      expect(line.split(c.inspect)).toHaveLength(2);
    });

    it('a non-TASK child skips the lookup: a cluster holds at most one MASTER and one CORE', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(c.type, { ...c.props, [c.typeKey]: 'CORE' });

      expect(reportFor(c.label)).toBeUndefined();
      // The poll lists too; the lookup would be the list right after the failed create.
      const failedAt = aws.calls.indexOf(c.type === FLEET ? 'AddInstanceFleetCommand' : 'AddInstanceGroupsCommand');
      expect(aws.calls[failedAt + 1]).not.toBe(c.list);
    });

    it('a failed list warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set(c.list, [propagationDenied()]);

      const result = await createWithRetry(c.type, c.props);

      expect(result.physicalId).toBe(c.secondId);
      expect(
        warnLines().some((l) =>
          l.includes(`could not look for it (${c.list.replace(/Command$/, '')}`)
        )
      ).toBe(true);
    });

    it('a DEFINITE failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set(
        c.type === FLEET ? 'AddInstanceFleetCommand' : 'AddInstanceGroupsCommand',
        [propagationDenied()]
      );

      await createWithRetry(c.type, c.props);

      expect(reportFor(c.label)).toBeUndefined();
      expect(c.resources()).toHaveLength(1);
    });

    it('masks a short secret-derived cluster id as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();
      const parentKey = c.type === FLEET ? 'ClusterId' : 'JobFlowId';

      await createWithRetry(c.type, { ...c.props, [parentKey]: 'zq' }, 'Res', (t) =>
        t === 'zq' ? '***' : t
      );

      const line = reportFor(c.label)!;
      expect(line).toContain('in cluster ***');
      expect(line).not.toContain('zq');
    });

    it('a withheld parent id prints each withheld command once, for several candidates', async () => {
      const parentKey = c.type === FLEET ? 'ClusterId' : 'JobFlowId';
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        c.seed('x-SIBLING', {
          ClusterId: 'zq',
          Status: {
            State: 'RUNNING',
            Timeline: { CreationDateTime: c.resources()[0]!.Status.Timeline.CreationDateTime },
          },
        });
        aws.onList = undefined;
      };

      await createWithRetry(c.type, { ...c.props, [parentKey]: 'zq' }, 'Res', (t) =>
        t === 'zq' ? '***' : t
      );

      const line = reportFor(c.label)!;
      expect(line).toContain(`2 ${c.noun} were created`);
      // One withheld read command and one withheld scale-to-zero command, not one per candidate.
      expect(line.split(WITHHELD_AWS_COMMAND)).toHaveLength(3);
    });
  });

  it.each([
    ['RunJobFlowCommand', 'ListClustersCommand', CLUSTER, CLUSTER_PROPS],
    ['AddInstanceFleetCommand', 'ListInstanceFleetsCommand', FLEET, FLEET_PROPS],
    ['AddInstanceGroupsCommand', 'ListInstanceGroupsCommand', GROUP, GROUP_PROPS],
  ] as const)(
    'sends %s through a client that refuses the SDK retry of a 5xx, and %s through one that does not',
    async (create, list, type, props) => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(type, props);

      const createConfig = sentVia.find(([name]) => name === create)![1];
      const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
      ).rejects.toThrow();
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
      ).resolves.toBe('retry-token');
      const listConfig = sentVia.find(([name]) => name === list)![1];
      expect(await listConfig.retryStrategy()).toBe(baseStrategy);
    }
  );

  it.each([
    ['RunJobFlowCommand', CLUSTER, CLUSTER_PROPS],
    ['AddInstanceFleetCommand', FLEET, FLEET_PROPS],
    ['AddInstanceGroupsCommand', GROUP, GROUP_PROPS],
  ] as const)('builds the %s client in the stack region, once', async (create, type, props) => {
    await providerFor(type).create('A', type, props);
    await providerFor(type).create('B', type, props);

    // The mock's region() echoes the constructor's `region`, else the SDK-like
    // fallback `us-east-1`: only a client built WITH the stack region says eu-west-3.
    const createConfig = sentVia.find(([name]) => name === create)![1];
    expect(await createConfig.region()).toBe('eu-west-3');
    // The shared client and one create client.
    expect(ctorArgs.map((o) => o.region)).toEqual(['eu-west-3', 'eu-west-3']);
  });
});
