import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

// Mock `@aws-sdk/client-application-auto-scaling` (issue #2081) — note the
// hyphen in `auto-scaling`, which does NOT match the `application-autoscaling`
// service name in the endpoint host. `DynamoDBGlobalTableProvider`
// builds its OWN `new ApplicationAutoScalingClient({ region })` for the
// capacity-target reconciliation (`getLocalAutoScalingClient` /
// `getRegionalAutoScalingClient` / `readAutoScalingSettings`), so the
// `src/utils/aws-clients.js` mock above — which only supplies `dynamoDB` —
// never reaches it. Any test whose template carries a
// `*CapacityAutoScalingSettings` block therefore issued REAL
// `application-autoscaling` calls against whatever account the runner is
// authenticated to.
//
// The calls are mocked to SUCCEED, against a table with NOTHING registered
// yet. That state is deliberately chosen to be observationally identical to the
// pre-fence behaviour while dropping its noise: `readAutoScalingSettings`
// returns `null` on an empty `ScalableTargets` list exactly as it does on a
// thrown error, and `probeExistingAutoScalingTargets` re-asserts every target
// either way — so nothing these tests assert on moves, but the provider no
// longer takes the best-effort "Could not register auto-scaling target" WARN
// branch that a failing client would push it down. The reconciliation is an
// idempotent upsert, so an unregistered table is the ordinary shape for it.
//
// Responses are keyed on the command class and carry the fields the provider
// actually reads (`ScalableTargets` / `ScalingPolicies` / `NextToken`); the
// write verbs return their real ARN-bearing shapes even though nothing reads
// them.
const autoScalingSend = vi.hoisted(() =>
  vi.fn(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'DescribeScalableTargetsCommand':
        return { ScalableTargets: [] };
      case 'DescribeScalingPoliciesCommand':
        return { ScalingPolicies: [] };
      case 'RegisterScalableTargetCommand':
        return {
          ScalableTargetARN:
            'arn:aws:application-autoscaling:us-east-1:123456789012:scalable-target/1234',
        };
      case 'PutScalingPolicyCommand':
        return {
          PolicyARN:
            'arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:1234:resource/dynamodb/table/my-test-table-xxx:policyName/test',
          Alarms: [],
        };
      case 'DeleteScalingPolicyCommand':
      case 'DeregisterScalableTargetCommand':
        return {};
      default:
        throw new Error(
          `unmocked application-autoscaling command: ${command.constructor.name}`
        );
    }
  })
);

vi.mock('@aws-sdk/client-application-auto-scaling', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@aws-sdk/client-application-auto-scaling')>();
  return {
    ...actual,
    ApplicationAutoScalingClient: vi
      .fn()
      .mockImplementation(() => ({ send: autoScalingSend, destroy: vi.fn() })),
  };
});

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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

const baseProps = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  Replicas: [{ Region: 'us-east-1', Tags: [{ Key: 'k', Value: 'v1' }] }],
};

const warnText = (): string => childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
const commandNames = (): string[] => mockSend.mock.calls.map((c) => c[0].constructor.name);

/**
 * Issue #3740 (the #3728 shape): three DESIRED-side reads in
 * `DynamoDBGlobalTableProvider.update()` warn-and-skip a malformed value on
 * every caller — `BillingMode`, `StreamSpecification`, and a non-array
 * `GlobalSecondaryIndexes` — and each runs after the tag diff. A template-path
 * update now REFUSES a CHANGED malformed value before the ACTIVE wait, the
 * `DescribeTable` and every write; the rollback revert arms (`replayingState`)
 * and `cdkd drift --revert` (`desiredFromAwsReadback`) keep the warnings.
 */
describe('DynamoDBGlobalTableProvider template-path refusals (issue #3740)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: `arn:aws:dynamodb:us-east-1:111111111111:table/${TABLE_NAME}`,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  // One row per arm: the malformed desired value, the recorded previous one,
  // the refusal text, and what the arm's warning says on a replay.
  const arms: Array<{
    arm: string;
    key: string;
    malformed: unknown;
    previous: unknown;
    refusal: RegExp;
    warning: RegExp;
  }> = [
    {
      arm: 'BillingMode',
      key: 'BillingMode',
      malformed: '   ',
      previous: 'PAY_PER_REQUEST',
      refusal: /AWS::DynamoDB::GlobalTable BillingMode must be a non-empty string \(got a blank string\)/,
      warning: /BillingMode must be a non-empty string/,
    },
    {
      arm: 'StreamSpecification',
      key: 'StreamSpecification',
      malformed: 'NEW_IMAGE',
      previous: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      refusal: /AWS::DynamoDB::GlobalTable StreamSpecification must be an object/,
      warning: /existing stream configuration is left untouched/,
    },
    {
      arm: 'StreamSpecification.StreamViewType',
      key: 'StreamSpecification',
      malformed: { StreamViewType: null },
      previous: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      refusal: /AWS::DynamoDB::GlobalTable StreamSpecification\.StreamViewType must be a non-empty string/,
      warning: /existing stream configuration is left untouched/,
    },
    {
      arm: 'GlobalSecondaryIndexes',
      key: 'GlobalSecondaryIndexes',
      malformed: { 'Fn::If': ['C', [], []] },
      previous: [],
      refusal: /AWS::DynamoDB::GlobalTable GlobalSecondaryIndexes must be an array, got object/,
      warning: /No GlobalSecondaryIndexes change is applied by this update/,
    },
  ];

  const edit = (
    key: string,
    malformed: unknown,
    previous: unknown,
    context?: Record<string, unknown>
  ) =>
    provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        [key]: malformed,
        // A tag change rides along, so "nothing was applied" is observable.
        Replicas: [{ Region: 'us-east-1', Tags: [{ Key: 'k', Value: 'v2' }] }],
      },
      { ...baseProps, [key]: previous },
      context
    );

  describe.each(arms)('$arm', ({ key, malformed, previous, refusal, warning }) => {
    it.each([
      ['no context', undefined],
      ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
    ])('REFUSES a changed malformed value on a template-path update (%s), before any AWS call', async (_label, context) => {
      const error = await edit(key, malformed, previous, context).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(/^AWS::DynamoDB::GlobalTable MyTable: /);
      expect((error as Error).message).toMatch(refusal);
      expect((error as Error).message).toMatch(
        /Nothing was applied to the table; fix the template value$/
      );
      // Not even the ACTIVE wait or the DescribeTable went out.
      expect(mockSend).not.toHaveBeenCalled();
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
      ['a rollback revert arm (replayingState)', { replayingState: true }],
      ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
    ])('keeps the warning on %s, and the rest of the update proceeds', async (_label, context) => {
      await expect(edit(key, malformed, previous, context)).resolves.toBeDefined();

      expect(warnText()).toMatch(warning);
      expect(commandNames()).toContain('TagResourceCommand');
    });

    it('does NOT refuse the value on the template path when it is UNCHANGED from the record', async () => {
      await expect(edit(key, malformed, malformed)).resolves.toBeDefined();
      expect(commandNames()).toContain('TagResourceCommand');
    });
  });

  it('refuses the FIRST failing arm only, in read order (BillingMode before StreamSpecification)', async () => {
    const error = await provider
      .update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: null, StreamSpecification: 'NEW_IMAGE' },
        { ...baseProps }
      )
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/BillingMode must be a non-empty string/);
    expect((error as Error).message).not.toMatch(/StreamSpecification/);
  });

  it('never refuses a REMOVED StreamSpecification or GlobalSecondaryIndexes block', async () => {
    await expect(
      provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, { ...baseProps }, {
        ...baseProps,
        StreamSpecification: 'NEW_IMAGE',
        GlobalSecondaryIndexes: { 'Fn::If': ['C', [], []] },
      })
    ).resolves.toBeDefined();
  });

  it('masks the GlobalSecondaryIndexes value it quotes (issue #2178)', async () => {
    const secret = 'sup3r-s3cret-value';
    const error = await provider
      .update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, GlobalSecondaryIndexes: { IndexName: secret } },
        { ...baseProps },
        { maskSecrets: (text: string) => text.split(secret).join('****') }
      )
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/GlobalSecondaryIndexes must be an array/);
    expect((error as Error).message).not.toContain(secret);
  });
});
