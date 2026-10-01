/**
 * Issue #2177 — the DynamoDB GlobalTable provider's masked log sinks.
 *
 * `create()` / `update()` build ONE masked sink set per operation from the
 * context's masker, extended by the table-name needle (`withDerivedNameMasks`):
 * the physical id IS the table name, and every auto-scaling resource id,
 * policy name, ARN and pasteable command embeds it. Every debug / info / warn
 * line, every wait helper's line and throw, and every wrapped AWS failure goes
 * through that set.
 *
 * Cases assert over the WHOLE transcript (every debug, info and warn line),
 * not one known line. The names are sized for the arm each case isolates:
 *
 *  - `LONG`, which the base masker catches as a substring: it fences the
 *    lines that reached no masker at all (the CreateTable / ACTIVE-wait /
 *    success debug lines, the auto-scaling upsert / deregister / probe lines);
 *  - `TINY`, three characters, below the base masker's substring floor: only
 *    the table-name needle removes it from a finished line;
 *  - `OLD`, a name the PREVIOUS side recorded as a `{{resolve:` reference and
 *    this deploy's bag does not hold: only the needle paired with the
 *    previous side removes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DescribeScalableTargetsCommand,
  DeregisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';

const { mockSend, mockAutoScalingSend, warnSpy, debugSpy, infoSpy, watchLabels } = vi.hoisted(() => ({
  watchLabels: [] as string[],
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  infoSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-application-auto-scaling')>(
      '@aws-sdk/client-application-auto-scaling'
    );
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

// Records every interrupt-watch LABEL, which reaches the user in
// `InterruptedWaitError`'s message on Ctrl-C; the real watch still runs.
vi.mock('../../../src/provisioning/interrupt-watch.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/interrupt-watch.js')>();
  return {
    ...actual,
    startInterruptWatch: (label: string) => {
      watchLabels.push(label);
      return actual.startInterruptWatch(label);
    },
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
/** Long enough for the base masker's substring arm. */
const LONG = 'gt-secret-table-name';
/** Below the base masker's substring floor: only the table-name needle removes it. */
const TINY = 'qxz';
/** A name only the previous side recorded, as a reference. */
const OLD = 'gt-rotated-table-name';
const OLD_REF = '{{resolve:secretsmanager:old-table-name}}';
/** An ordinary name, for the negative controls. */
const PLAIN = 'plain-table';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every debug, info and warn line the provider wrote, joined. */
const transcript = (): string =>
  [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls]
    .map((args) => String(args[0]))
    .join('\n');

const AS = {
  MinCapacity: 1,
  MaxCapacity: 10,
  TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
};

/** A PROVISIONED table whose write and local read dimensions are auto-scaled. */
function autoscaledProps(tableName: string | undefined): Record<string, unknown> {
  return {
    ...(tableName !== undefined && { TableName: tableName }),
    BillingMode: 'PROVISIONED',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    Replicas: [
      {
        Region: 'us-east-1',
        ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: AS },
      },
    ],
    WriteProvisionedThroughputSettings: { WriteCapacityAutoScalingSettings: AS },
  };
}

function activeTable(name: string): Record<string, unknown> {
  return {
    Table: {
      TableName: name,
      TableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${name}`,
      TableId: 'tid-1',
      TableStatus: 'ACTIVE',
      Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
    },
  };
}

/** A fake DynamoDB answering every DescribeTable with an ACTIVE `name`. */
function fakeDynamo(name: string, failing?: { command: string; error: Error }): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const n = commandName(command);
    if (failing && n === failing.command) throw failing.error;
    if (n === 'DescribeTableCommand') return activeTable(name);
    return {};
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

describe('DynamoDBGlobalTableProvider masked log sinks (issue #2177)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    infoSpy.mockReset();
    watchLabels.length = 0;
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  describe('create()', () => {
    for (const [label, name] of [
      ['a long secret name (substring arm)', LONG],
      ['a short secret name (needle only)', TINY],
    ] as const) {
      it(`${label}: no line names the table`, async () => {
        fakeDynamo(name);
        await provider.create('Gt', RESOURCE_TYPE, autoscaledProps(name), {
          maskSecrets: createSecretMasker(bagOf(name)),
        });
        const lines = transcript();
        // The sites this fix routes: each appears, masked.
        expect(lines).toContain(`CreateTable initiated for ${SECRET_MASK}, waiting for ACTIVE`);
        expect(lines).toContain(`Table ${SECRET_MASK} status: ACTIVE`);
        expect(lines).toContain(`Successfully created DynamoDB GlobalTable Gt: ${SECRET_MASK}`);
        expect(lines).toContain('Upserted auto-scaling policy');
        expect(lines).not.toContain(name);
      });
    }

    it('negative control: an ordinary name with no context is named', async () => {
      fakeDynamo(PLAIN);
      await provider.create('Gt', RESOURCE_TYPE, autoscaledProps(PLAIN));
      const lines = transcript();
      expect(lines).toContain(`CreateTable initiated for ${PLAIN}`);
      expect(lines).toContain(`Upserted auto-scaling policy`);
      expect(lines).toContain(`table/${PLAIN}`);
    });

    it('a short secret name echoed in a CreateTable failure is masked and stamped', async () => {
      fakeDynamo(TINY, {
        command: 'CreateTableCommand',
        error: new Error(`Table already exists: ${TINY}`),
      });
      const failure = await thrown(
        provider.create('Gt', RESOURCE_TYPE, autoscaledProps(TINY), {
          maskSecrets: createSecretMasker(bagOf(TINY)),
        })
      );
      expect(failure.message).toBe(
        `Failed to create DynamoDB GlobalTable Gt: Table already exists: ${SECRET_MASK}`
      );
      expect(hasRedactedCause(failure)).toBe(true);
    });

    it('a short secret name in the wiring failure (ACTIVE wait) is masked', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          return { Table: { TableName: TINY, TableStatus: 'ARCHIVED' } };
        }
        if (command instanceof CreateTableCommand) return {};
        return {};
      });
      const failure = await thrown(
        provider.create('Gt', RESOURCE_TYPE, autoscaledProps(TINY), {
          maskSecrets: createSecretMasker(bagOf(TINY)),
        })
      );
      expect(failure.message).toContain(
        `Unexpected table status while waiting for ACTIVE on ${SECRET_MASK}: ARCHIVED`
      );
      expect(failure.message).not.toContain(TINY);
      // The waiter masks its OWN throw, not only the outer wrap.
      expect((failure as { cause?: Error }).cause?.message).toBe(
        `Unexpected table status while waiting for ACTIVE on ${SECRET_MASK}: ARCHIVED`
      );
      expect(transcript()).not.toContain(TINY);
    });

    it('the ACTIVE wait timeout names the table masked', async () => {
      mockSend.mockResolvedValue({ Table: { TableStatus: 'CREATING' } });
      const direct = provider as unknown as {
        waitForTableActive: (
          table: string,
          logicalId: string,
          maxAttempts: number,
          mask: (text: string) => string
        ) => Promise<unknown>;
      };
      const failure = await thrown(
        direct.waitForTableActive(TINY, 'Gt', 0, (t) => t.split(TINY).join(SECRET_MASK))
      );
      expect(failure.message).toBe(`Table ${SECRET_MASK} did not reach ACTIVE within 0s`);
    });

    // Each secret word is in that refusal's own wording. A refusal is cdkd's
    // text, not AWS's, so no mask change may stamp it retryable.
    for (const [key, value, word] of [
      ['BillingMode', 42, 'entirely'],
      ['StreamSpecification', '', 'must'],
      ['GlobalSecondaryIndexes', 'gsi', 'must'],
    ] as const) {
      it(`a cdkd-authored ${key} refusal is masked but NOT stamped`, async () => {
        fakeDynamo(PLAIN);
        const props = autoscaledProps(PLAIN);
        props[key] = value;
        const failure = await thrown(
          provider.create('Gt', RESOURCE_TYPE, props, {
            maskSecrets: createSecretMasker(bagOf(word)),
          })
        );
        expect(failure.message).toContain(key);
        expect(failure.message).toContain(SECRET_MASK);
        expect(failure.message).not.toContain(word);
        expect(hasRedactedCause(failure)).toBe(false);
        expect(mockSend.mock.calls.some((c) => c[0] instanceof CreateTableCommand)).toBe(false);
      });
    }

    it('the partial-create cleanup threads the masker to the replica-removal wait', async () => {
      const wait = vi
        .spyOn(
          DynamoDBGlobalTableProvider.prototype as unknown as {
            waitForReplicaGone: (...args: unknown[]) => Promise<void>;
          },
          'waitForReplicaGone'
        )
        .mockResolvedValue(undefined);
      try {
        mockSend.mockImplementation(async (command: unknown) => {
          const n = commandName(command);
          if (n === 'UpdateTimeToLiveCommand') throw new Error('ttl failed');
          if (n === 'DescribeTableCommand') {
            return {
              Table: {
                ...(activeTable(TINY)['Table'] as object),
                Replicas: [
                  { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
                  { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
                ],
              },
            };
          }
          return {};
        });
        const props = autoscaledProps(TINY);
        props['TimeToLiveSpecification'] = { AttributeName: 'ttl', Enabled: true };
        await thrown(
          provider.create('Gt', RESOURCE_TYPE, props, {
            maskSecrets: createSecretMasker(bagOf(TINY)),
          })
        );
        expect(wait).toHaveBeenCalledTimes(1);
        const mask = wait.mock.calls[0]![5] as (text: string) => string;
        expect(mask(`table ${TINY}`)).toBe(`table ${SECRET_MASK}`);
        expect(transcript()).not.toContain(TINY);
      } finally {
        wait.mockRestore();
      }
    });

    it('a failure the mask left unchanged is not stamped', async () => {
      fakeDynamo(PLAIN, {
        command: 'CreateTableCommand',
        error: new Error('Bad request parameter'),
      });
      const failure = await thrown(
        provider.create('Gt', RESOURCE_TYPE, autoscaledProps(PLAIN), {
          maskSecrets: createSecretMasker(bagOf(TINY)),
        })
      );
      expect(failure.message).toBe(
        'Failed to create DynamoDB GlobalTable Gt: Bad request parameter'
      );
      expect(hasRedactedCause(failure)).toBe(false);
    });

    it('the replica-add wait gets the masker, and its timeout names the table masked', async () => {
      const wait = vi
        .spyOn(
          DynamoDBGlobalTableProvider.prototype as unknown as {
            waitForReplicaActive: (...args: unknown[]) => Promise<void>;
          },
          'waitForReplicaActive'
        )
        .mockResolvedValue(undefined);
      try {
        fakeDynamo(TINY);
        const props = autoscaledProps(TINY);
        props['Replicas'] = [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }];
        await provider.create('Gt', RESOURCE_TYPE, props, {
          maskSecrets: createSecretMasker(bagOf(TINY)),
        });
        expect(wait).toHaveBeenCalledTimes(1);
        const mask = wait.mock.calls[0]![4] as (text: string) => string;
        expect(mask(`table ${TINY}`)).toBe(`table ${SECRET_MASK}`);
      } finally {
        wait.mockRestore();
      }

      mockSend.mockImplementation(async () => ({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'CREATING' }] },
      }));
      const direct = provider as unknown as {
        waitForReplicaActive: (
          table: string,
          region: string,
          logicalId: string,
          maxAttempts: number,
          mask: (text: string) => string
        ) => Promise<void>;
      };
      const failure = await thrown(
        direct.waitForReplicaActive(TINY, 'eu-west-1', 'Gt', 0, (t) =>
          t.split(TINY).join(SECRET_MASK)
        )
      );
      expect(failure.message).toBe(
        `Replica eu-west-1 for table ${SECRET_MASK} did not reach ACTIVE within 0s`
      );
    });
  });

  describe('update()', () => {
    it('the auto-scaling probe failure and upsert lines name a rotated table masked', async () => {
      fakeDynamo(OLD);
      mockAutoScalingSend.mockImplementation(async (command: unknown) => {
        if (command instanceof DescribeScalableTargetsCommand) {
          throw new Error(`AccessDenied on table/${OLD}`);
        }
        return { ScalableTargets: [], ScalingPolicies: [] };
      });
      await provider.update(
        'Gt',
        OLD,
        RESOURCE_TYPE,
        autoscaledProps(OLD),
        autoscaledProps(OLD_REF),
        // An EMPTY bag: the old name's plaintext is in no bag of this deploy.
        { maskSecrets: createSecretMasker(new Map()) }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Could not probe existing auto-scaling targets on ${SECRET_MASK} in us-east-1`
      );
      expect(lines).toContain('Upserted auto-scaling policy');
      expect(lines).toContain(`Updating DynamoDB GlobalTable Gt: ${SECRET_MASK}`);
      expect(lines).not.toContain(OLD);
    });

    it('negative control: an ordinary recorded name stays named', async () => {
      fakeDynamo(PLAIN);
      mockAutoScalingSend.mockImplementation(async (command: unknown) => {
        if (command instanceof DescribeScalableTargetsCommand) throw new Error('AccessDenied');
        return { ScalableTargets: [], ScalingPolicies: [] };
      });
      await provider.update(
        'Gt',
        PLAIN,
        RESOURCE_TYPE,
        autoscaledProps(PLAIN),
        autoscaledProps(PLAIN),
        { maskSecrets: createSecretMasker(new Map()) }
      );
      expect(transcript()).toContain(
        `Could not probe existing auto-scaling targets on ${PLAIN} in us-east-1`
      );
    });

    it('the deregister line names a short secret table masked', async () => {
      fakeDynamo(TINY);
      const desired = autoscaledProps(TINY);
      desired['WriteProvisionedThroughputSettings'] = {};
      await provider.update('Gt', TINY, RESOURCE_TYPE, desired, autoscaledProps(TINY), {
        maskSecrets: createSecretMasker(bagOf(TINY)),
      });
      const deregistered = mockAutoScalingSend.mock.calls.filter(
        (c) => c[0] instanceof DeregisterScalableTargetCommand
      );
      expect(deregistered.length).toBeGreaterThan(0);
      const lines = transcript();
      expect(lines).toContain(`Deregistered auto-scaling target table/${SECRET_MASK}`);
      expect(lines).not.toContain(TINY);
    });

    it('the failure wrap masks a rotated name and stamps the cause', async () => {
      fakeDynamo(OLD, {
        command: 'UpdateTableCommand',
        error: new Error(`Cannot update table ${OLD}`),
      });
      const desired = autoscaledProps(OLD);
      desired['DeletionProtectionEnabled'] = true;
      const failure = await thrown(
        provider.update('Gt', OLD, RESOURCE_TYPE, desired, autoscaledProps(OLD_REF), {
          maskSecrets: createSecretMasker(new Map()),
        })
      );
      expect(mockSend.mock.calls.some((c) => c[0] instanceof UpdateTableCommand)).toBe(true);
      expect(failure.message).toBe(
        `Failed to update DynamoDB GlobalTable Gt: Cannot update table ${SECRET_MASK}`
      );
      expect(hasRedactedCause(failure)).toBe(true);
      expect(transcript()).not.toContain(OLD);
    });

    it('a masked transient failure stays retryable', async () => {
      // A secret spelling part of the retry table's `does not exist` wording.
      fakeDynamo(PLAIN, {
        command: 'UpdateTableCommand',
        error: new Error('Resource xyz does not exist'),
      });
      const desired = autoscaledProps(PLAIN);
      desired['DeletionProtectionEnabled'] = true;
      const failure = await thrown(
        provider.update('Gt', PLAIN, RESOURCE_TYPE, desired, autoscaledProps(PLAIN), {
          maskSecrets: createSecretMasker(bagOf('exist')),
        })
      );
      expect(failure.message).not.toContain('does not exist');
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    });

    it('the TTL rate-limit refusal masks a short secret table', async () => {
      fakeDynamo(TINY, {
        command: 'UpdateTimeToLiveCommand',
        error: new Error(`Time to live has been modified multiple times on ${TINY}`),
      });
      const desired = autoscaledProps(TINY);
      desired['TimeToLiveSpecification'] = { AttributeName: 'ttl', Enabled: true };
      const failure = await thrown(
        provider.update('Gt', TINY, RESOURCE_TYPE, desired, autoscaledProps(TINY), {
          maskSecrets: createSecretMasker(bagOf(TINY)),
        })
      );
      expect(failure.message).toContain(`AWS rejected TimeToLive update on ${SECRET_MASK}:`);
      expect(failure.message).not.toContain(TINY);
      expect(hasRedactedCause(failure)).toBe(true);
    });

    it('the replica-removal wait gets the masker, and its timeout names the table masked', async () => {
      const wait = vi
        .spyOn(
          DynamoDBGlobalTableProvider.prototype as unknown as {
            waitForReplicaGone: (...args: unknown[]) => Promise<void>;
          },
          'waitForReplicaGone'
        )
        .mockResolvedValue(undefined);
      try {
        fakeDynamo(OLD);
        const previous = autoscaledProps(OLD_REF);
        previous['Replicas'] = [
          ...(previous['Replicas'] as unknown[]),
          { Region: 'eu-west-1' },
        ];
        await provider.update('Gt', OLD, RESOURCE_TYPE, autoscaledProps(OLD), previous, {
          maskSecrets: createSecretMasker(new Map()),
        });
        expect(wait).toHaveBeenCalledTimes(1);
        const mask = wait.mock.calls[0]![5] as (text: string) => string;
        expect(mask(`table ${OLD}`)).toBe(`table ${SECRET_MASK}`);
        expect(transcript()).not.toContain(OLD);
      } finally {
        wait.mockRestore();
      }

      mockSend.mockImplementation(async () => ({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'DELETING' }] },
      }));
      const direct = provider as unknown as {
        waitForReplicaGone: (
          table: string,
          region: string,
          logicalId: string,
          maxAttempts: number,
          budget: undefined,
          mask: (text: string) => string
        ) => Promise<void>;
      };
      const failure = await thrown(
        direct.waitForReplicaGone(TINY, 'eu-west-1', 'Gt', 0, undefined, (t) =>
          t.split(TINY).join(SECRET_MASK)
        )
      );
      expect(failure.message).toContain(`Replica eu-west-1 for table ${SECRET_MASK} did not`);
      expect(failure.message).not.toContain(TINY);
      expect(watchLabels).toContain(`DynamoDB replica eu-west-1 teardown on ${SECRET_MASK}`);
      expect(watchLabels.join('\n')).not.toContain(TINY);
    });

    it('the template-path refusal routes its text through the mask', async () => {
      fakeDynamo(PLAIN);
      const desired = autoscaledProps(PLAIN);
      desired['BillingMode'] = 42;
      const failure = await thrown(
        provider.update('Gt', PLAIN, RESOURCE_TYPE, desired, autoscaledProps(PLAIN), {
          maskSecrets: createSecretMasker(bagOf('entirely')),
        })
      );
      expect(failure.message).toContain('Nothing was applied to the table');
      expect(failure.message).not.toContain('entirely');
      expect(failure.message).toContain(SECRET_MASK);
    });

    it('the AttributeDefinitions refusal names a short secret attribute masked', async () => {
      fakeDynamo(PLAIN);
      const previous = autoscaledProps(PLAIN);
      previous['AttributeDefinitions'] = [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: TINY, AttributeType: 'S' },
      ];
      const desired = autoscaledProps(PLAIN);
      desired['GlobalSecondaryIndexes'] = [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: TINY, KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ];
      const failure = await thrown(
        provider.update('Gt', PLAIN, RESOURCE_TYPE, desired, previous, {
          maskSecrets: createSecretMasker(bagOf(TINY)),
        })
      );
      expect(failure.message).toContain(`(offenders: ${SECRET_MASK})`);
    });

    it('the protected-replacement refusal withholds a command naming a rotated table', async () => {
      fakeDynamo(OLD);
      const previous = autoscaledProps(OLD_REF);
      previous['DeletionProtectionEnabled'] = true;
      const desired = autoscaledProps(OLD);
      desired['KeySchema'] = [{ AttributeName: 'other', KeyType: 'HASH' }];
      const failure = await thrown(
        provider.update('Gt', OLD, RESOURCE_TYPE, desired, previous, {
          maskSecrets: createSecretMasker(new Map()),
        })
      );
      expect(failure.message).toContain('KeySchema is immutable');
      expect(failure.message).not.toContain(OLD);
      expect(failure.message).not.toContain('--no-deletion-protection-enabled');
    });

    it('negative control: the refusal names an ordinary table in its command', async () => {
      fakeDynamo(PLAIN);
      const previous = autoscaledProps(PLAIN);
      previous['DeletionProtectionEnabled'] = true;
      const desired = autoscaledProps(PLAIN);
      desired['KeySchema'] = [{ AttributeName: 'other', KeyType: 'HASH' }];
      const failure = await thrown(
        provider.update('Gt', PLAIN, RESOURCE_TYPE, desired, previous, {
          maskSecrets: createSecretMasker(new Map()),
        })
      );
      expect(failure.message).toContain(
        `aws dynamodb update-table --table-name ${PLAIN} --no-deletion-protection-enabled`
      );
    });
  });
});
