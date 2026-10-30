import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
  DescribeScalableTargetsCommand,
} from '@aws-sdk/client-application-auto-scaling';

/**
 * go-to-k/cdkd#5581: adding a replica to an autoscaled PROVISIONED global
 * table makes DynamoDB register application-autoscaling targets for that
 * replica's table in the replica's region (CloudTrail:
 * `replication.dynamodb.amazonaws.com` registering both the read AND the write
 * dimension). Removing the replica deregistered only the READ target, so the
 * WRITE target outlived the replica, the replica-removal update and the
 * destroy, and a later table of the same name in that region inherited it.
 *
 * Every send is logged as `<region>:<command>` in one list, so a case can
 * assert both WHICH targets go and that they go only AFTER the replica's drop.
 */

const { localSend, regionalSend, autoScalingSend, callLog, warnSpy, debugSpy } = vi.hoisted(() => ({
  localSend: vi.fn(),
  regionalSend: vi.fn(),
  autoScalingSend: vi.fn(),
  callLog: [] as string[],
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

const LOCAL = 'us-east-1';
const REMOTE = 'eu-west-1';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: {
      send: (command: { constructor: { name: string } }) => {
        callLog.push(`${'us-east-1'}:${command.constructor.name}`);
        return localSend(command);
      },
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  const { getAwsClients } = await import('../../../src/utils/aws-clients.js');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) =>
      cfg?.region === 'us-east-1'
        ? getAwsClients().dynamoDB
        : {
            send: (command: { constructor: { name: string } }) => {
              callLog.push(`${cfg?.region}:${command.constructor.name}`);
              return regionalSend(command);
            },
            config: { region: () => Promise.resolve(cfg?.region ?? '') },
          }
    ),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@aws-sdk/client-application-auto-scaling')>();
  return {
    ...actual,
    ApplicationAutoScalingClient: vi
      .fn()
      .mockImplementation((cfg: { region?: string } | undefined) => ({
        send: (command: { constructor: { name: string } }) => {
          callLog.push(`${cfg?.region}:${command.constructor.name}`);
          return autoScalingSend(command, cfg?.region);
        },
      })),
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
  DynamoDBGlobalTableProvider,
  autoScalingRetryDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const SECRET = 'qxzsecret';
const TABLE = `gt-${SECRET}-tbl`;
const TABLE_ARN = `arn:aws:dynamodb:${LOCAL}:123456789012:table/${TABLE}`;

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
type Target = { ResourceId: string; ScalableDimension: string };

const rnf = (): ResourceNotFoundException =>
  new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} });
const objectNotFound = (): Error =>
  Object.assign(new Error('No scaling policy found for service namespace: dynamodb'), {
    name: 'ObjectNotFoundException',
  });

/** The targets DynamoDB registered for the replica, plus look-alikes that are NOT its. */
const REPLICA_TARGETS: Target[] = [
  { ResourceId: `table/${TABLE}`, ScalableDimension: 'dynamodb:table:WriteCapacityUnits' },
  { ResourceId: `table/${TABLE}/index/gsi1`, ScalableDimension: 'dynamodb:index:WriteCapacityUnits' },
  { ResourceId: `table/${TABLE}/index/gsi1`, ScalableDimension: 'dynamodb:index:ReadCapacityUnits' },
];
const FOREIGN_TARGETS: Target[] = [
  // A sibling table whose name merely STARTS with this one's.
  { ResourceId: `table/${TABLE}-other`, ScalableDimension: 'dynamodb:table:WriteCapacityUnits' },
  { ResourceId: `table/${TABLE}-other/index/gsi1`, ScalableDimension: 'dynamodb:index:WriteCapacityUnits' },
  // A dimension that does not match the resource-id level.
  { ResourceId: `table/${TABLE}`, ScalableDimension: 'dynamodb:index:WriteCapacityUnits' },
  // Not a dimension cdkd knows.
  { ResourceId: `table/${TABLE}`, ScalableDimension: 'dynamodb:table:SomethingElse' },
  // The index prefix with NO index name after it.
  { ResourceId: `table/${TABLE}/index/`, ScalableDimension: 'dynamodb:index:WriteCapacityUnits' },
];

let replicaRemoved = false;
let tableDeleted = false;

/** The source table: two replicas until the replica's `Delete` lands. */
function sourceTable(): void {
  localSend.mockImplementation(async (command: Sent) => {
    const name = command.constructor.name;
    if (name === UpdateTableCommand.name) {
      const updates = command.input['ReplicaUpdates'] as Array<{ Delete?: unknown }> | undefined;
      if (updates?.[0]?.Delete) replicaRemoved = true;
      return {};
    }
    if (name === DeleteTableCommand.name) {
      tableDeleted = true;
      return {};
    }
    if (name === DescribeTableCommand.name) {
      if (tableDeleted) throw rnf();
      return {
        Table: {
          TableName: TABLE,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          Replicas: replicaRemoved
            ? [{ RegionName: LOCAL, ReplicaStatus: 'ACTIVE' }]
            : [
                { RegionName: LOCAL, ReplicaStatus: 'ACTIVE' },
                { RegionName: REMOTE, ReplicaStatus: 'ACTIVE' },
              ],
        },
      };
    }
    return {};
  });
}

/** The replica's own table as its region reads it. */
function replicaTable(state: 'gone' | 'DELETING' | 'ACTIVE' | Error): void {
  regionalSend.mockImplementation(async (command: Sent) => {
    if (command.constructor.name !== DescribeTableCommand.name) return {};
    if (state === 'gone') throw rnf();
    if (state instanceof Error) throw state;
    return { Table: { TableName: TABLE, TableStatus: state } };
  });
}

/** What the replica's region lists, in pages. */
function registered(pages: Target[][], opts: { listError?: Error } = {}): void {
  autoScalingSend.mockImplementation(async (command: Sent) => {
    const name = command.constructor.name;
    if (name === DescribeScalableTargetsCommand.name) {
      if (opts.listError) throw opts.listError;
      const token = command.input['NextToken'] as string | undefined;
      const page = token === undefined ? 0 : Number(token);
      return {
        ScalableTargets: pages[page] ?? [],
        ...(page + 1 < pages.length ? { NextToken: String(page + 1) } : {}),
      };
    }
    // AWS's own targets carry no cdkd-named policy.
    if (name === DeleteScalingPolicyCommand.name) throw objectNotFound();
    return {};
  });
}

const deregistered = (region: string): string[] =>
  autoScalingSend.mock.calls
    .filter(([c, r]) => (c as Sent).constructor.name === DeregisterScalableTargetCommand.name && r === region)
    .map(([c]) => {
      const input = (c as Sent).input;
      return `${String(input['ResourceId'])}|${String(input['ScalableDimension'])}`;
    });

const listed = (): unknown[] =>
  autoScalingSend.mock.calls.filter(
    ([c]) => (c as Sent).constructor.name === DescribeScalableTargetsCommand.name
  );

const indexOfReplicaDrop = (): number =>
  callLog.findIndex((entry) => entry === `${LOCAL}:UpdateTableCommand`);

const warned = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
const debugged = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join('\n');

const PROVISIONED = {
  BillingMode: 'PROVISIONED',
  WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
};

const masker = () => {
  const bag: RecordedSecretValues = new Map([[SECRET, `{{resolve:secretsmanager:${SECRET}}}`]]);
  return createSecretMasker(bag);
};

describe('a removed replica leaves no scalable target behind (go-to-k/cdkd#5581)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    localSend.mockReset();
    regionalSend.mockReset();
    autoScalingSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    callLog.length = 0;
    replicaRemoved = false;
    tableDeleted = false;
    sourceTable();
    provider = new DynamoDBGlobalTableProvider();
  });

  const removeReplica = (opts: { mask?: boolean } = {}) =>
    provider.update(
      'Gt',
      TABLE,
      RESOURCE_TYPE,
      { ...PROVISIONED, Replicas: [{ Region: LOCAL }] },
      { ...PROVISIONED, Replicas: [{ Region: LOCAL }, { Region: REMOTE }] },
      opts.mask ? { maskSecrets: masker() } : undefined
    );

  describe('update: a replica the template no longer declares', () => {
    it('deregisters every target of the replica table in its region, and only those', async () => {
      replicaTable('gone');
      registered([[...REPLICA_TARGETS, ...FOREIGN_TARGETS]]);

      await removeReplica();

      expect(deregistered(REMOTE)).toEqual(
        REPLICA_TARGETS.map((t) => `${t.ResourceId}|${t.ScalableDimension}`)
      );
      expect(deregistered(LOCAL)).toEqual([]);
      expect(warned()).toBe('');
    });

    it('lists and deregisters only AFTER the replica drop, and after its table reads gone', async () => {
      replicaTable('gone');
      registered([REPLICA_TARGETS]);

      await removeReplica();

      const drop = indexOfReplicaDrop();
      const regionalRead = callLog.indexOf(`${REMOTE}:DescribeTableCommand`);
      const list = callLog.indexOf(`${REMOTE}:DescribeScalableTargetsCommand`);
      const firstDeregister = callLog.indexOf(`${REMOTE}:DeregisterScalableTargetCommand`);
      expect(drop).toBeGreaterThan(-1);
      expect(regionalRead).toBeGreaterThan(drop);
      expect(list).toBeGreaterThan(regionalRead);
      expect(firstDeregister).toBeGreaterThan(list);
    });

    it('deregisters on a replica table that reads DELETING', async () => {
      replicaTable('DELETING');
      registered([REPLICA_TARGETS]);

      await removeReplica();

      expect(deregistered(REMOTE)).toHaveLength(REPLICA_TARGETS.length);
    });

    it('follows NextToken across pages', async () => {
      replicaTable('gone');
      registered([[FOREIGN_TARGETS[0]!], [REPLICA_TARGETS[0]!], [REPLICA_TARGETS[1]!]]);

      await removeReplica();

      expect(listed()).toHaveLength(3);
      expect(deregistered(REMOTE)).toEqual([
        `table/${TABLE}|dynamodb:table:WriteCapacityUnits`,
        `table/${TABLE}/index/gsi1|dynamodb:index:WriteCapacityUnits`,
      ]);
    });

    it('leaves a still-ACTIVE replica table alone, with a masked warning naming the command', async () => {
      replicaTable('ACTIVE');
      registered([REPLICA_TARGETS]);

      await removeReplica({ mask: true });

      expect(listed()).toEqual([]);
      expect(deregistered(REMOTE)).toEqual([]);
      const text = warned();
      expect(text).toContain('still reads ACTIVE');
      expect(text).toContain(
        `aws application-autoscaling describe-scalable-targets --service-namespace dynamodb --region ${REMOTE}`
      );
      expect(text).not.toContain(SECRET);
    });

    it('leaves the targets, with a masked warning, when the regional read fails', async () => {
      replicaTable(
        Object.assign(new Error(`AccessDenied on table/${TABLE}`), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 400 },
        })
      );
      registered([REPLICA_TARGETS]);

      await expect(removeReplica({ mask: true })).resolves.toBeDefined();

      expect(listed()).toEqual([]);
      expect(warned()).toContain('reading the table there failed (AccessDeniedException');
      // AWS's own text is debug-only (go-to-k/cdkd#2319).
      expect(warned()).not.toContain('AccessDenied on table');
      expect(warned()).not.toContain(SECRET);
      // ...and the debug line carrying it is masked too.
      expect(debugged()).toContain('AccessDenied on table');
      expect(debugged()).not.toContain(SECRET);
    });

    it('retries a throttled regional read, then deregisters', async () => {
      autoScalingRetryDelays.sleep = async () => undefined;
      try {
        let reads = 0;
        regionalSend.mockImplementation(async (command: Sent) => {
          if (command.constructor.name !== DescribeTableCommand.name) return {};
          reads += 1;
          if (reads === 1) {
            throw Object.assign(new Error('Rate exceeded'), {
              name: 'ThrottlingException',
              $metadata: { httpStatusCode: 400 },
            });
          }
          throw rnf();
        });
        registered([REPLICA_TARGETS]);

        await removeReplica();

        expect(reads).toBe(2);
        expect(deregistered(REMOTE)).toHaveLength(REPLICA_TARGETS.length);
      } finally {
        delete autoScalingRetryDelays.sleep;
      }
    });

    it('warns, masked, and still completes the update when the listing fails', async () => {
      replicaTable('gone');
      registered([REPLICA_TARGETS], {
        listError: Object.assign(new Error(`not authorized on table/${TABLE}`), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 400 },
        }),
      });

      await expect(removeReplica({ mask: true })).resolves.toBeDefined();

      expect(deregistered(REMOTE)).toEqual([]);
      const text = warned();
      expect(text).toContain('listing them failed (AccessDeniedException');
      expect(text).not.toContain('not authorized on');
      expect(text).toContain('describe-scalable-targets');
      expect(text).not.toContain(SECRET);
      expect(debugged()).toContain('not authorized on');
      expect(debugged()).not.toContain(SECRET);
    });

    it('masks a deregister failure warning', async () => {
      replicaTable('gone');
      autoScalingSend.mockImplementation(async (command: Sent) => {
        const name = command.constructor.name;
        if (name === DescribeScalableTargetsCommand.name) {
          return { ScalableTargets: [REPLICA_TARGETS[0]] };
        }
        if (name === DeleteScalingPolicyCommand.name) throw objectNotFound();
        if (name === DeregisterScalableTargetCommand.name) {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return {};
      });

      await removeReplica({ mask: true });

      const text = warned();
      expect(text).toContain('Could not deregister auto-scaling target');
      expect(text).toContain('dynamodb:table:WriteCapacityUnits');
      expect(text).not.toContain(SECRET);
    });
  });

  describe('delete: the destroy drops every non-local replica first', () => {
    const destroy = () =>
      provider.delete('Gt', TABLE, RESOURCE_TYPE, undefined, {
        expectedRegion: LOCAL,
        maskSecrets: masker(),
      });

    it("deregisters the replica's write and index targets after its drop, then deletes the table", async () => {
      replicaTable('gone');
      registered([[...REPLICA_TARGETS, ...FOREIGN_TARGETS]]);

      await destroy();

      // The pre-existing pre-drop READ teardown deregisters by name before the
      // drop; the #5581 sweep removes what is still listed after it.
      const drop = indexOfReplicaDrop();
      const list = callLog.indexOf(`${REMOTE}:DescribeScalableTargetsCommand`);
      expect(list).toBeGreaterThan(drop);
      const afterDrop = autoScalingSend.mock.calls
        .map(([c, r], i) => ({ c: c as Sent, r, i }))
        .filter(
          ({ c, r }) => r === REMOTE && c.constructor.name === DeregisterScalableTargetCommand.name
        )
        .slice(-REPLICA_TARGETS.length)
        .map(({ c }) => `${String(c.input['ResourceId'])}|${String(c.input['ScalableDimension'])}`);
      expect(afterDrop).toEqual(REPLICA_TARGETS.map((t) => `${t.ResourceId}|${t.ScalableDimension}`));
      expect(deregistered(REMOTE)).not.toContain(
        `table/${TABLE}-other|dynamodb:table:WriteCapacityUnits`
      );
      // The regional ResourceNotFound is the REPLICA's table, never this
      // resource's: the DeleteTable still goes out.
      expect(callLog).toContain(`${LOCAL}:DeleteTableCommand`);
      expect(callLog.indexOf(`${LOCAL}:DeleteTableCommand`)).toBeGreaterThan(list);
    });

    it("masks the delete path's by-name teardown warnings too (local and pre-drop)", async () => {
      replicaTable('gone');
      autoScalingSend.mockImplementation(async (command: Sent) => {
        const name = command.constructor.name;
        if (name === DescribeScalableTargetsCommand.name) return { ScalableTargets: [] };
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      });

      await destroy();

      const lines = warnSpy.mock.calls.map((c) => String(c[0]));
      // The pre-drop read teardown in eu-west-1, and the local read + write.
      const teardown = lines.filter((l) => l.startsWith('Could not'));
      expect(teardown.length).toBeGreaterThanOrEqual(6);
      for (const line of teardown) expect(line).not.toContain(SECRET);
      expect(callLog).toContain(`${LOCAL}:DeleteTableCommand`);
    });

    it('masks the warning when the listing fails, and still deletes the table', async () => {
      replicaTable('gone');
      registered([REPLICA_TARGETS], {
        listError: Object.assign(new Error(`not authorized on table/${TABLE}`), {
          name: 'AccessDeniedException',
        }),
      });

      await destroy();

      expect(warned()).toContain('listing them failed');
      expect(warned()).not.toContain(SECRET);
      expect(callLog).toContain(`${LOCAL}:DeleteTableCommand`);
    });
  });
});
