import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteResourcePolicyCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PolicyNotFoundException,
  PutResourcePolicyCommand,
  ResourceNotFoundException,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const streamArnOf = (generation: number): string => `${TABLE_ARN}/stream/2026-09-20T00:00:0${generation}.000`;

const DOC = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::111111111111:root' },
      Action: 'dynamodb:DescribeStream',
      Resource: '*',
    },
  ],
};
const OTHER_DOC = { ...DOC, Statement: [{ ...DOC.Statement[0], Action: 'dynamodb:GetRecords' }] };

function streamBlock(viewType: string, members: Record<string, unknown> = {}): unknown {
  return { StreamViewType: viewType, ...members };
}
const MEMBERS = {
  ResourcePolicy: { PolicyDocument: DOC },
  Tags: [{ Key: 'team', Value: 'data' }],
};

function tableProps(streamSpecification?: unknown): Record<string, unknown> {
  return {
    TableName: TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    ...(streamSpecification === undefined ? {} : { StreamSpecification: streamSpecification }),
  };
}

/**
 * A stateful DynamoDB double. Dispatch is by COMMAND, never `*Once`.
 *
 * The stream lifecycle follows the service: enabling a stream mints a NEW arn,
 * and a DISABLED stream's arn keeps being reported as `LatestStreamArn` (the
 * stream stays readable for 24 hours) — which is exactly why the provider must
 * not trust an arn it read before a re-enable.
 */
interface Aws {
  generation: number;
  streamEnabled: boolean;
  viewType?: string;
  /** Per-arn live policy / tags. */
  policies: Map<string, string>;
  tags: Map<string, Map<string, string>>;
  /** What the re-enabling `UpdateTable` echoes as `LatestStreamArn`. */
  echo: 'new' | 'stale' | 'none';
  failures: Map<unknown, Error[]>;
}

function primeAws(initial: Partial<Aws> = {}): Aws {
  const aws: Aws = {
    generation: 0,
    streamEnabled: false,
    policies: new Map(),
    tags: new Map(),
    echo: 'new',
    failures: new Map(),
    ...initial,
  };
  const latest = (): string | undefined =>
    aws.generation === 0 ? undefined : streamArnOf(aws.generation);
  const describe = (): Record<string, unknown> => ({
    TableName: TABLE_NAME,
    TableArn: TABLE_ARN,
    TableId: 'tid',
    TableStatus: 'ACTIVE',
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    LatestStreamArn: latest(),
    StreamSpecification: aws.streamEnabled
      ? { StreamEnabled: true, StreamViewType: aws.viewType }
      : aws.generation === 0
        ? undefined
        : { StreamEnabled: false },
  });
  const enable = (viewType: string | undefined): void => {
    aws.generation += 1;
    aws.streamEnabled = true;
    aws.viewType = viewType;
  };
  mockSend.mockImplementation((cmd: unknown) => {
    const queued = aws.failures.get((cmd as { constructor: unknown }).constructor);
    if (queued !== undefined && queued.length > 0) return Promise.reject(queued.shift());
    if (cmd instanceof CreateTableCommand) {
      if (cmd.input.StreamSpecification?.StreamEnabled === true) {
        enable(cmd.input.StreamSpecification.StreamViewType);
      }
      return Promise.resolve({});
    }
    if (cmd instanceof UpdateTableCommand) {
      const spec = cmd.input.StreamSpecification;
      const before = latest();
      if (spec?.StreamEnabled === true) enable(spec.StreamViewType);
      if (spec?.StreamEnabled === false) aws.streamEnabled = false;
      const echoed = aws.echo === 'new' ? latest() : aws.echo === 'stale' ? before : undefined;
      return Promise.resolve({ TableDescription: { LatestStreamArn: echoed } });
    }
    if (cmd instanceof DescribeTableCommand) return Promise.resolve({ Table: describe() });
    if (cmd instanceof PutResourcePolicyCommand) {
      aws.policies.set(cmd.input.ResourceArn!, cmd.input.Policy!);
      return Promise.resolve({ RevisionId: '1' });
    }
    if (cmd instanceof DeleteResourcePolicyCommand) {
      aws.policies.delete(cmd.input.ResourceArn!);
      return Promise.resolve({});
    }
    if (cmd instanceof GetResourcePolicyCommand) {
      const live = aws.policies.get(cmd.input.ResourceArn!);
      return live === undefined
        ? Promise.reject(
            new PolicyNotFoundException({ message: 'Resource-based policy not found', $metadata: {} })
          )
        : Promise.resolve({ Policy: live, RevisionId: '1' });
    }
    if (cmd instanceof TagResourceCommand) {
      const bag = aws.tags.get(cmd.input.ResourceArn!) ?? new Map<string, string>();
      for (const tag of cmd.input.Tags ?? []) bag.set(tag.Key!, tag.Value!);
      aws.tags.set(cmd.input.ResourceArn!, bag);
      return Promise.resolve({});
    }
    if (cmd instanceof UntagResourceCommand) {
      const bag = aws.tags.get(cmd.input.ResourceArn!);
      for (const key of cmd.input.TagKeys ?? []) bag?.delete(key);
      return Promise.resolve({});
    }
    if (cmd instanceof ListTagsOfResourceCommand) {
      const bag = aws.tags.get(cmd.input.ResourceArn!) ?? new Map<string, string>();
      return Promise.resolve({ Tags: [...bag].map(([Key, Value]) => ({ Key, Value })) });
    }
    return Promise.resolve({});
  });
  return aws;
}

/** Every command of one class the provider sent, in order. */
function sent<T>(commandClass: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map(([cmd]) => cmd as unknown).filter((cmd): cmd is T => cmd instanceof commandClass);
}
/** Every arn a policy / tag WRITE addressed. */
function writeTargets(): string[] {
  return mockSend.mock.calls
    .map(([cmd]) => cmd as unknown)
    .filter(
      (cmd) =>
        cmd instanceof PutResourcePolicyCommand ||
        cmd instanceof DeleteResourcePolicyCommand ||
        cmd instanceof TagResourceCommand ||
        cmd instanceof UntagResourceCommand
    )
    .map((cmd) => (cmd as { input: { ResourceArn?: string } }).input.ResourceArn ?? '<none>');
}

describe('DynamoDBTableProvider StreamSpecification.ResourcePolicy / Tags (issue #3458)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    childLogger.child.mockReturnValue(childLogger);
    provider = new DynamoDBTableProvider();
    // The absence re-ask exists for real-AWS read lag; one case below puts it back.
    setRereadDelays([]);
  });

  function setRereadDelays(delays: number[]): void {
    (
      provider as unknown as { streamMemberRereadDelaysMs: number[] }
    ).streamMemberRereadDelaysMs = delays;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create()', () => {
    it('applies both members to the STREAM arn, never the table arn, and keeps them off CreateTable', async () => {
      const aws = primeAws();
      const result = await provider.create(
        'T',
        RESOURCE_TYPE,
        tableProps(streamBlock('NEW_IMAGE', MEMBERS))
      );

      const [createTable] = sent(CreateTableCommand);
      expect(createTable!.input.StreamSpecification).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_IMAGE',
      });
      // The TABLE-level policy / tags are untouched by the stream members.
      expect(createTable!.input.ResourcePolicy).toBeUndefined();
      expect(createTable!.input.Tags).toBeUndefined();

      expect(writeTargets()).toEqual([streamArnOf(1), streamArnOf(1)]);
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
      expect([...aws.tags.get(streamArnOf(1))!]).toEqual([['team', 'data']]);
      expect(aws.policies.has(TABLE_ARN)).toBe(false);
      expect(result.attributes?.['StreamArn']).toBe(streamArnOf(1));
      // Tags BEFORE the policy: the grant never exists without its tag set.
      const order = mockSend.mock.calls.map(([cmd]) => (cmd as object).constructor.name);
      expect(order.indexOf('TagResourceCommand')).toBeLessThan(
        order.indexOf('PutResourcePolicyCommand')
      );
    });

    it('issues no stream call for a block declaring neither member', async () => {
      primeAws();
      await provider.create('T', RESOURCE_TYPE, tableProps(streamBlock('NEW_IMAGE')));
      expect(writeTargets()).toEqual([]);
    });

    it.each([
      ['an unresolved-intrinsic policy', { ResourcePolicy: { Ref: 'Param' } }, 'ResourcePolicy'],
      ['an unreadable tag entry', { Tags: [{ Key: 'ok-key', Value: { Ref: 'V' } }] }, 'Tags[0]'],
    ])('refuses %s BEFORE CreateTable, by position and without resolved names', async (_n, members, needle) => {
      primeAws();
      await expect(
        provider.create('T', RESOURCE_TYPE, tableProps(streamBlock('NEW_IMAGE', members)))
      ).rejects.toThrow(`StreamSpecification.${needle}`);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names no resolved tag key or value in the create refusal', async () => {
      primeAws();
      const error = (await provider
        .create(
          'T',
          RESOURCE_TYPE,
          tableProps(
            streamBlock('NEW_IMAGE', {
              Tags: [
                { Key: 'ok-key', Value: 'ok-value' },
                { Key: 'bad-key', Value: { Ref: 'V' } },
              ],
            })
          )
        )
        .catch((caught: unknown) => caught)) as Error;
      expect(error.message).toContain('StreamSpecification.Tags[1]');
      for (const resolved of ['ok-key', 'ok-value', 'bad-key']) {
        expect(error.message).not.toContain(resolved);
      }
    });

    it('stands the refusal down on a state replay, warns through the masker and creates the table', async () => {
      primeAws();
      const maskSecrets = vi.fn((text: string) => text.replaceAll(TABLE_NAME, '***'));
      await provider.create(
        'T',
        RESOURCE_TYPE,
        tableProps(streamBlock('NEW_IMAGE', { ResourcePolicy: 'junk', ...{ Tags: MEMBERS.Tags } })),
        { replayingState: true, maskSecrets }
      );
      expect(sent(CreateTableCommand)).toHaveLength(1);
      expect(sent(PutResourcePolicyCommand)).toHaveLength(0);
      // The readable member is still applied.
      expect(sent(TagResourceCommand)).toHaveLength(1);
      const warnings = childLogger.warn.mock.calls.map(([message]) => String(message));
      expect(warnings.some((w) => w.includes('StreamSpecification.ResourcePolicy'))).toBe(true);
      expect(warnings.some((w) => w.includes(TABLE_NAME))).toBe(false);
    });

    it('rolls the table back when the policy is rejected, so no table survives without its grant', async () => {
      const aws = primeAws();
      aws.failures.set(PutResourcePolicyCommand, [
        Object.assign(new Error('Invalid policy'), { name: 'ValidationException' }),
      ]);
      await expect(
        provider.create('T', RESOURCE_TYPE, tableProps(streamBlock('NEW_IMAGE', MEMBERS)))
      ).rejects.toThrow('Invalid policy');
      expect(sent(DeleteTableCommand)).toHaveLength(1);
    });

    it('retries a not-found on the arn it just minted, for the tag AND the policy call, masking the retry line', async () => {
      vi.useFakeTimers();
      const aws = primeAws();
      const notFound = (): Error =>
        new ResourceNotFoundException({
          message: `Requested resource not found: ${streamArnOf(1)}`,
          $metadata: {},
        });
      aws.failures.set(TagResourceCommand, [notFound()]);
      aws.failures.set(PutResourcePolicyCommand, [notFound()]);
      const maskSecrets = (text: string): string => text.replaceAll(TABLE_NAME, '***');
      const pending = provider.create(
        'T',
        RESOURCE_TYPE,
        tableProps(streamBlock('NEW_IMAGE', MEMBERS)),
        { maskSecrets }
      );
      await vi.runAllTimersAsync();
      await pending;
      expect(sent(TagResourceCommand)).toHaveLength(2);
      expect(sent(PutResourcePolicyCommand)).toHaveLength(2);
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
      const retryLines = childLogger.debug.mock.calls
        .map(([message]) => String(message))
        .filter((line) => line.includes('Transient error'));
      expect(retryLines).toHaveLength(2);
      for (const line of retryLines) expect(line).not.toContain(TABLE_NAME);
    });

    it('fails LOUDLY when the created table reports no stream arn to apply the members to', async () => {
      primeAws();
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof DescribeTableCommand
          ? Promise.resolve({
              Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
            })
          : inner(cmd)
      );
      await expect(
        provider.create('T', RESOURCE_TYPE, tableProps(streamBlock('NEW_IMAGE', MEMBERS)))
      ).rejects.toThrow('returned no LatestStreamArn');
      expect(writeTargets()).toEqual([]);
    });
  });

  describe('update()', () => {
    const update = (
      desired: unknown,
      previous: unknown,
      context?: Parameters<DynamoDBTableProvider['update']>[5]
    ) =>
      provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        tableProps(desired),
        tableProps(previous),
        context
      );

    it('applies both members to the arn an update-time ENABLE mints', async () => {
      const aws = primeAws();
      const result = await update(streamBlock('NEW_IMAGE', MEMBERS), undefined);
      expect(writeTargets()).toEqual([streamArnOf(1), streamArnOf(1)]);
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
      expect(result.attributes?.['StreamArn']).toBe(streamArnOf(1));
    });

    it.each(['new', 'stale', 'none'] as const)(
      'RE-APPLIES both to the NEW arn after a StreamViewType change (UpdateTable echo: %s)',
      async (echo) => {
        const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE', echo });
        aws.policies.set(streamArnOf(1), JSON.stringify(DOC));
        const result = await update(
          streamBlock('KEYS_ONLY', MEMBERS),
          streamBlock('NEW_IMAGE', MEMBERS)
        );
        // Every write addresses the arn the re-enable minted, never the recorded one.
        expect(writeTargets()).toEqual([streamArnOf(2), streamArnOf(2)]);
        expect(aws.policies.get(streamArnOf(2))).toBe(JSON.stringify(DOC));
        expect([...aws.tags.get(streamArnOf(2))!]).toEqual([['team', 'data']]);
        expect(result.attributes?.['StreamArn']).toBe(streamArnOf(2));
        // The members never ride UpdateTable.
        for (const cmd of sent(UpdateTableCommand)) {
          expect(Object.keys(cmd.input.StreamSpecification ?? {}).sort()).not.toContain(
            'ResourcePolicy'
          );
          expect(cmd.input.StreamSpecification).not.toHaveProperty('Tags');
        }
      }
    );

    it('fails LOUDLY when no new arn can be read after a view-type change', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      // A double that never mints: DescribeTable keeps answering the dead arn.
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof UpdateTableCommand) return Promise.resolve({});
        return inner(cmd);
      });
      await expect(
        update(streamBlock('KEYS_ONLY', MEMBERS), streamBlock('NEW_IMAGE', MEMBERS))
      ).rejects.toThrow('no new LatestStreamArn');
      expect(writeTargets()).toEqual([]);
      expect(aws.policies.size).toBe(0);
    });

    it('reconciles a member-only change on the stream that STAYS, with no UpdateTable', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.tags.set(streamArnOf(1), new Map([['team', 'data']]));
      await update(
        streamBlock('NEW_IMAGE', {
          ResourcePolicy: { PolicyDocument: OTHER_DOC },
          Tags: [{ Key: 'env', Value: 'prod' }],
        }),
        streamBlock('NEW_IMAGE', MEMBERS)
      );
      expect(sent(UpdateTableCommand)).toHaveLength(0);
      expect(new Set(writeTargets())).toEqual(new Set([streamArnOf(1)]));
      // The old policy is gone BEFORE the first tag call and the new one lands
      // AFTER the last: neither is ever evaluated against the other's tag set.
      expect(
        mockSend.mock.calls
          .map(([cmd]) => (cmd as object).constructor.name)
          .filter((name) => /Policy|[Tt]ag/.test(name) && !name.startsWith('Get'))
      ).toEqual([
        'DeleteResourcePolicyCommand',
        'UntagResourceCommand',
        'TagResourceCommand',
        'PutResourcePolicyCommand',
      ]);
      expect(sent(UntagResourceCommand)[0]!.input.TagKeys).toEqual(['team']);
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(OTHER_DOC));
      expect([...aws.tags.get(streamArnOf(1))!]).toEqual([['env', 'prod']]);
    });

    it('issues nothing at all for an unchanged block', async () => {
      primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      await update(streamBlock('NEW_IMAGE', MEMBERS), streamBlock('NEW_IMAGE', MEMBERS));
      expect(writeTargets()).toEqual([]);
      expect(sent(UpdateTableCommand)).toHaveLength(0);
    });

    it('REMOVES both when they leave a block whose stream stays, and a rollback restores them', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.policies.set(streamArnOf(1), JSON.stringify(DOC));
      aws.tags.set(streamArnOf(1), new Map([['team', 'data']]));

      await update(streamBlock('NEW_IMAGE'), streamBlock('NEW_IMAGE', MEMBERS));
      expect(sent(DeleteResourcePolicyCommand)[0]!.input.ResourceArn).toBe(streamArnOf(1));
      expect(sent(UntagResourceCommand)[0]!.input).toEqual({
        ResourceArn: streamArnOf(1),
        TagKeys: ['team'],
      });
      expect(aws.policies.size).toBe(0);
      expect(aws.tags.get(streamArnOf(1))!.size).toBe(0);

      // The rollback executor replays update() with the sides SWAPPED.
      await update(streamBlock('NEW_IMAGE', MEMBERS), streamBlock('NEW_IMAGE'), {
        replayingState: true,
      });
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
      expect([...aws.tags.get(streamArnOf(1))!]).toEqual([['team', 'data']]);
    });

    it('rolls a view-type change back onto yet another arn, with the OLD members', async () => {
      const aws = primeAws({ generation: 2, streamEnabled: true, viewType: 'KEYS_ONLY' });
      await update(
        streamBlock('NEW_IMAGE', MEMBERS),
        streamBlock('KEYS_ONLY', { ResourcePolicy: { PolicyDocument: OTHER_DOC } }),
        { replayingState: true }
      );
      expect(new Set(writeTargets())).toEqual(new Set([streamArnOf(3)]));
      expect(aws.policies.get(streamArnOf(3))).toBe(JSON.stringify(DOC));
      expect(sent(DeleteResourcePolicyCommand)).toHaveLength(0);
    });

    it('tolerates a policy that is already gone on removal', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.failures.set(DeleteResourcePolicyCommand, [
        new PolicyNotFoundException({ message: 'not there', $metadata: {} }),
      ]);
      await expect(
        update(streamBlock('NEW_IMAGE'), streamBlock('NEW_IMAGE', { ResourcePolicy: MEMBERS.ResourcePolicy }))
      ).resolves.toBeDefined();
    });

    it('does NOT retry or tolerate a not-found on a stream that STAYS: there it is an answer', async () => {
      const notFound = (): Error =>
        new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} });
      async function expectOneAttempt<T>(
        command: new (...args: never[]) => T,
        desired: unknown,
        previous: unknown
      ): Promise<void> {
        mockSend.mockReset();
        const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
        aws.failures.set(command, [notFound()]);
        await expect(update(desired, previous)).rejects.toThrow('Requested resource not found');
        expect(sent(command)).toHaveLength(1);
      }
      const withPolicy = streamBlock('NEW_IMAGE', { ResourcePolicy: MEMBERS.ResourcePolicy });
      await expectOneAttempt(PutResourcePolicyCommand, withPolicy, streamBlock('NEW_IMAGE'));
      await expectOneAttempt(DeleteResourcePolicyCommand, streamBlock('NEW_IMAGE'), withPolicy);
    });

    it.each(['new', 'stale', 'none'] as const)(
      'enables a stream AGAIN after an earlier disable and writes to the NEW arn (UpdateTable echo: %s)',
      async (echo) => {
        // Generation 1 was disabled by an earlier deploy; its arn is still reported.
        const aws = primeAws({ generation: 1, streamEnabled: false, echo });
        const result = await update(streamBlock('NEW_IMAGE', MEMBERS), undefined);
        expect(writeTargets()).toEqual([streamArnOf(2), streamArnOf(2)]);
        expect(aws.policies.get(streamArnOf(2))).toBe(JSON.stringify(DOC));
        expect(aws.policies.has(streamArnOf(1))).toBe(false);
        expect(result.attributes?.['StreamArn']).toBe(streamArnOf(2));
      }
    );

    it('fails LOUDLY when an enable after an earlier disable yields only the dead arn', async () => {
      primeAws({ generation: 1, streamEnabled: false });
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof UpdateTableCommand ? Promise.resolve({}) : inner(cmd)
      );
      await expect(update(streamBlock('NEW_IMAGE', MEMBERS), undefined)).rejects.toThrow(
        'no new LatestStreamArn'
      );
      expect(writeTargets()).toEqual([]);
    });

    it('retries a not-found on the arn an update-time enable minted', async () => {
      vi.useFakeTimers();
      const aws = primeAws();
      aws.failures.set(PutResourcePolicyCommand, [
        new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} }),
      ]);
      const pending = update(
        streamBlock('NEW_IMAGE', { ResourcePolicy: MEMBERS.ResourcePolicy }),
        undefined
      );
      await vi.runAllTimersAsync();
      await pending;
      expect(sent(PutResourcePolicyCommand)).toHaveLength(2);
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
    });

    it('re-runs after a deploy that enabled the stream and then failed: no second enable, everything applied', async () => {
      // State never recorded the stream, AWS has it (with the tag the failed run got to).
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.tags.set(streamArnOf(1), new Map([['team', 'data']]));
      await update(streamBlock('NEW_IMAGE', MEMBERS), undefined);
      expect(sent(UpdateTableCommand)).toHaveLength(0);
      expect(new Set(writeTargets())).toEqual(new Set([streamArnOf(1)]));
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
      expect(sent(DeleteResourcePolicyCommand)).toHaveLength(0);
    });

    it('re-enables a recorded stream that was disabled out of band, and writes to the arn it mints', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: false });
      await update(
        streamBlock('NEW_IMAGE', MEMBERS),
        streamBlock('NEW_IMAGE', { Tags: MEMBERS.Tags })
      );
      expect(sent(UpdateTableCommand)[0]!.input.StreamSpecification).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_IMAGE',
      });
      expect(writeTargets()).toEqual([streamArnOf(2), streamArnOf(2)]);
      expect([...aws.tags.get(streamArnOf(2))!]).toEqual([['team', 'data']]);
    });

    it('makes NO call against a dead arn when the stream is disabled or the block removed', async () => {
      primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      const result = await update(undefined, streamBlock('NEW_IMAGE', MEMBERS));
      expect(sent(UpdateTableCommand)[0]!.input.StreamSpecification).toEqual({
        StreamEnabled: false,
      });
      expect(writeTargets()).toEqual([]);
      expect(result.attributes?.['StreamArn']).toBeUndefined();
    });

    it('REFUSES an unreadable member on the template path before ANY call, so a narrowing is never silently skipped', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.policies.set(streamArnOf(1), JSON.stringify(DOC));
      await expect(
        update(
          // A view-type change rides along: it must not be half applied either.
          streamBlock('KEYS_ONLY', { ResourcePolicy: { PolicyDocumnt: OTHER_DOC } }),
          streamBlock('NEW_IMAGE', { ResourcePolicy: MEMBERS.ResourcePolicy })
        )
      ).rejects.toThrow('StreamSpecification.ResourcePolicy.PolicyDocument is required');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not refuse an unreadable block that did not change', async () => {
      primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      const junk = streamBlock('NEW_IMAGE', { ResourcePolicy: 'junk' });
      await expect(update(junk, structuredClone(junk))).resolves.toBeDefined();
      expect(writeTargets()).toEqual([]);
    });

    it.each([{ replayingState: true }, { desiredFromAwsReadback: true }])(
      'warns through the masked sink and leaves an unreadable member alone for a state-borne caller (%o)',
      async (flags) => {
        await assertUnreadableMemberLeftAlone(flags);
      }
    );

    async function assertUnreadableMemberLeftAlone(
      flags: Parameters<DynamoDBTableProvider['update']>[5]
    ): Promise<void> {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.policies.set(streamArnOf(1), JSON.stringify(DOC));
      const maskSecrets = vi.fn((text: string) => text.replaceAll(TABLE_NAME, '***'));
      await update(
        streamBlock('NEW_IMAGE', { ResourcePolicy: { 'Fn::GetAtt': ['X', 'Y'] } }),
        streamBlock('NEW_IMAGE', { ResourcePolicy: MEMBERS.ResourcePolicy }),
        { ...flags, maskSecrets }
      );
      expect(writeTargets()).toEqual([]);
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
      const warnings = childLogger.warn.mock.calls.map(([message]) => String(message));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('StreamSpecification.ResourcePolicy');
      expect(warnings[0]).toContain('***');
      expect(warnings[0]).not.toContain(TABLE_NAME);
    }

    it('never logs the policy text at any level', async () => {
      primeAws();
      await update(streamBlock('NEW_IMAGE', MEMBERS), undefined);
      const lines = [childLogger.debug, childLogger.info, childLogger.warn, childLogger.error]
        .flatMap((sink) => sink.mock.calls)
        .map(([message]) => String(message));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => line.includes('dynamodb:DescribeStream'))).toBe(false);
      expect(lines.some((line) => line.includes('arn:aws:iam::111111111111:root'))).toBe(false);
    });
  });

  describe('readCurrentState()', () => {
    const read = (desired: unknown) =>
      provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE, tableProps(desired));

    it('reads both members off the CURRENT stream arn, in the template shape, so both baselines converge', async () => {
      const aws = primeAws({ generation: 2, streamEnabled: true, viewType: 'KEYS_ONLY' });
      aws.policies.set(streamArnOf(2), JSON.stringify(DOC));
      aws.tags.set(
        streamArnOf(2),
        new Map([
          ['team', 'data'],
          ['aws:cloudformation:stack-name', 'x'],
        ])
      );
      const desired = streamBlock('KEYS_ONLY', MEMBERS);
      const live = await read(desired);

      expect(sent(GetResourcePolicyCommand)[0]!.input.ResourceArn).toBe(streamArnOf(2));
      // The stream tag read addresses the stream arn; the table-level one the TABLE arn.
      expect(sent(ListTagsOfResourceCommand).map((cmd) => cmd.input.ResourceArn)).toEqual([
        streamArnOf(2),
        TABLE_ARN,
      ]);
      expect(live!['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'KEYS_ONLY',
        ResourcePolicy: { PolicyDocument: DOC },
        Tags: [{ Key: 'team', Value: 'data' }],
      });
      // `properties` baseline (state-keys walk) and `observedProperties`
      // baseline (union walk) both report nothing.
      const desiredBag = { StreamSpecification: desired };
      expect(calculateResourceDrift(desiredBag, live!)).toEqual([]);
      expect(
        calculateResourceDrift({ StreamSpecification: live!['StreamSpecification'] }, live!, {
          unionWalkObjects: true,
        })
      ).toEqual([]);
    });

    it('reports an out-of-band policy delete and untag as drift on the declared member', async () => {
      primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      const desired = streamBlock('NEW_IMAGE', MEMBERS);
      const live = await read(desired);
      expect(live!['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_IMAGE',
      });
      const paths = calculateResourceDrift({ StreamSpecification: desired }, live!).map(
        (drift) => drift.path
      );
      expect(paths.sort()).toEqual([
        'StreamSpecification.ResourcePolicy',
        'StreamSpecification.Tags',
      ]);
    });

    it('compares the tag list as an UNORDERED set, with no unordered-path declaration', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.tags.set(
        streamArnOf(1),
        new Map([
          ['zeta', '1'],
          ['alpha', '2'],
        ])
      );
      const desired = streamBlock('NEW_IMAGE', {
        Tags: [
          { Key: 'alpha', Value: '2' },
          { Key: 'zeta', Value: '1' },
        ],
      });
      const live = await read(desired);
      expect(calculateResourceDrift({ StreamSpecification: desired }, live!)).toEqual([]);
      // A changed VALUE still reports.
      aws.tags.get(streamArnOf(1))!.set('zeta', 'changed');
      const drifted = await read(desired);
      expect(
        calculateResourceDrift({ StreamSpecification: desired }, drifted!).map((d) => d.path)
      ).toEqual(['StreamSpecification.Tags']);
    });

    it('reads NEITHER member when the block declares neither (one API call each)', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.policies.set(streamArnOf(1), JSON.stringify(DOC));
      const live = await read(streamBlock('NEW_IMAGE'));
      expect(sent(GetResourcePolicyCommand).map((cmd) => cmd.input.ResourceArn)).toEqual([
        TABLE_ARN,
      ]);
      expect(sent(ListTagsOfResourceCommand)).toHaveLength(1);
      expect(live!['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_IMAGE',
      });
    });

    it('gates each member separately and skips an UNUSABLE declaration', async () => {
      primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      await read(streamBlock('NEW_IMAGE', { ResourcePolicy: 'junk', Tags: MEMBERS.Tags }));
      expect(sent(GetResourcePolicyCommand).map((cmd) => cmd.input.ResourceArn)).toEqual([
        TABLE_ARN,
      ]);
      expect(sent(ListTagsOfResourceCommand)).toHaveLength(2);
    });

    it('reads a declared EMPTY tag list back as one, and an undeclared bag reads nothing', async () => {
      primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      const desired = streamBlock('NEW_IMAGE', { Tags: [] });
      const live = await read(desired);
      expect(calculateResourceDrift({ StreamSpecification: desired }, live!)).toEqual([]);
      mockSend.mockClear();
      await provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE);
      expect(sent(ListTagsOfResourceCommand)).toHaveLength(1);
    });

    it('degrades a failed member read to an omitted member, not a failed drift read', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.policies.set(streamArnOf(1), JSON.stringify(DOC));
      const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: unknown) => {
        const arn = (cmd as { input?: { ResourceArn?: string } }).input?.ResourceArn;
        if (arn === streamArnOf(1)) return Promise.reject(denied);
        return inner(cmd);
      });
      const live = await read(streamBlock('NEW_IMAGE', MEMBERS));
      expect(live!['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_IMAGE',
      });
    });

    it('re-asks an ABSENT answer for a declared member before believing it (eventually consistent reads)', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.policies.set(streamArnOf(1), JSON.stringify(DOC));
      aws.tags.set(streamArnOf(1), new Map([['team', 'data']]));
      setRereadDelays([0, 0]);
      // The first answer of each read lags behind the write that preceded it.
      aws.failures.set(GetResourcePolicyCommand, [
        new PolicyNotFoundException({ message: 'not yet', $metadata: {} }),
      ]);
      const inner = mockSend.getMockImplementation()!;
      let laggingTagReads = 1;
      mockSend.mockImplementation((cmd: unknown) => {
        if (
          cmd instanceof ListTagsOfResourceCommand &&
          cmd.input.ResourceArn === streamArnOf(1) &&
          laggingTagReads-- > 0
        ) {
          return Promise.resolve({ Tags: [] });
        }
        return inner(cmd);
      });
      const desired = streamBlock('NEW_IMAGE', MEMBERS);
      const live = await read(desired);
      expect(calculateResourceDrift({ StreamSpecification: desired }, live!)).toEqual([]);

      // ...and gives up after the configured attempts when it really is gone.
      aws.policies.clear();
      mockSend.mockClear();
      await read(streamBlock('NEW_IMAGE', { ResourcePolicy: MEMBERS.ResourcePolicy }));
      expect(
        sent(GetResourcePolicyCommand).filter((cmd) => cmd.input.ResourceArn === streamArnOf(1))
      ).toHaveLength(3);
    });

    it('re-asks an answer still holding the PREVIOUS value after a change, so the capture cannot freeze it', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.policies.set(streamArnOf(1), JSON.stringify(OTHER_DOC));
      aws.tags.set(streamArnOf(1), new Map([['team', 'data']]));
      setRereadDelays([0, 0]);
      const inner = mockSend.getMockImplementation()!;
      let stalePolicyReads = 1;
      let staleTagReads = 1;
      mockSend.mockImplementation((cmd: unknown) => {
        const onStream =
          (cmd as { input?: { ResourceArn?: string } }).input?.ResourceArn === streamArnOf(1);
        if (cmd instanceof GetResourcePolicyCommand && onStream && stalePolicyReads-- > 0) {
          return Promise.resolve({ Policy: JSON.stringify(DOC) });
        }
        if (cmd instanceof ListTagsOfResourceCommand && onStream && staleTagReads-- > 0) {
          return Promise.resolve({ Tags: [{ Key: 'team', Value: 'old' }] });
        }
        return inner(cmd);
      });
      const desired = streamBlock('NEW_IMAGE', {
        ResourcePolicy: { PolicyDocument: OTHER_DOC },
        Tags: MEMBERS.Tags,
      });
      const live = await read(desired);
      expect(calculateResourceDrift({ StreamSpecification: desired }, live!)).toEqual([]);
    });

    it('follows ListTagsOfResource pagination on the stream arn', async () => {
      primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof ListTagsOfResourceCommand && cmd.input.ResourceArn === streamArnOf(1)) {
          return Promise.resolve(
            cmd.input.NextToken === undefined
              ? { Tags: [{ Key: 'a', Value: '1' }], NextToken: 'page2' }
              : { Tags: [{ Key: 'team', Value: 'data' }] }
          );
        }
        return inner(cmd);
      });
      const live = await read(streamBlock('NEW_IMAGE', { Tags: MEMBERS.Tags }));
      expect((live!['StreamSpecification'] as Record<string, unknown>)['Tags']).toEqual([
        { Key: 'a', Value: '1' },
        { Key: 'team', Value: 'data' },
      ]);
    });

    it('drift --revert: the read-back as the previous side restores a deleted policy', async () => {
      const aws = primeAws({ generation: 1, streamEnabled: true, viewType: 'NEW_IMAGE' });
      aws.tags.set(streamArnOf(1), new Map([['team', 'data']]));
      const desired = streamBlock('NEW_IMAGE', MEMBERS);
      const live = await read(desired);
      mockSend.mockClear();
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        tableProps(desired),
        { ...tableProps(), StreamSpecification: live!['StreamSpecification'] },
        { desiredFromAwsReadback: true }
      );
      expect(sent(UpdateTableCommand)).toHaveLength(0);
      expect(writeTargets()).toEqual([streamArnOf(1)]);
      expect(aws.policies.get(streamArnOf(1))).toBe(JSON.stringify(DOC));
    });
  });
});
