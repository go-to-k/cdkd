import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #1997: both DynamoDB providers interpolate RESOLVED property values
// into their own `logger.warn` lines — a recorded previous `BillingMode`, a
// declared `WarmThroughput` block, an index NAME. cdkd's secret masking lives at
// the deploy engine (error / reason text) and the resolver's debug line only, so
// a `{{resolve:secretsmanager:...}}` scalar reaching one of those printed in
// plaintext. Both providers now mask through the `maskSecrets` capability their
// caller puts on `CreateContext` / `UpdateContext` (the contract issue #1932
// item 3 added).
//
// The two types are covered in one file because they are the same defect twice
// over: `dynamodb-table-provider.ts` and `dynamodb-globaltable-provider.ts`
// carry near-identical BillingMode / WarmThroughput guards, and a fix applied to
// one alone is exactly the drift this file exists to catch.

const { mockSend, mockAutoScalingSend, warned, debugged } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warned: [] as string[],
  debugged: [] as string[],
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn((message: string) => {
      debugged.push(message);
    }),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Grepped against the whole tree before being invented, so they cannot coincide
// with another suite's assertion needle.
const SECRET_PLAINTEXT = 'issue1997-ddb-billing-plaintext';
const SECRET_EXPR = '{{resolve:secretsmanager:ddb/mode:SecretString:v::}}';

function secretBag(): RecordedSecretValues {
  return new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]);
}

const log = (): string => warned.join('\n');

/** A live PROVISIONED table with one index, enough for every arm below. */
function primeDescribe(): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'DescribeTableCommand') {
      return Promise.resolve({
        Table: {
          TableName: 'issue1997-table',
          TableArn: 'arn:aws:dynamodb:us-east-1:0:table/issue1997-table',
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      });
    }
    return Promise.resolve({});
  });
  mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
}

describe('DynamoDB providers - resolved secrets in provider warnings (issue #1997)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warned.length = 0;
    debugged.length = 0;
    primeDescribe();
  });

  // The `AWS::DynamoDB::Table` half. `update()`'s unusable-previous-BillingMode
  // arm quotes `previousProperties['BillingMode']` verbatim, and
  // `previousProperties` is a cdkd STATE record whose values were resolved by an
  // earlier deploy — so it really can be plaintext.
  describe('AWS::DynamoDB::Table update()', () => {
    let provider: DynamoDBTableProvider;

    beforeEach(() => {
      provider = new DynamoDBTableProvider();
    });

    async function run(
      previousBillingMode: unknown,
      context?: Parameters<DynamoDBTableProvider['update']>[5]
    ): Promise<unknown> {
      return await provider.update(
        'MyTable',
        'issue1997-table',
        'AWS::DynamoDB::Table',
        { BillingMode: 'PROVISIONED' },
        { BillingMode: previousBillingMode },
        context
      );
    }

    it('masks a resolved secret in the unusable recorded-previous BillingMode', async () => {
      // An ARRAY, not a bare string: `recordedPrevBillingModeUsable` accepts
      // any non-blank string, so a bare secret-shaped string is USABLE and
      // never reaches the warn arm at all. The array is unusable AND carries
      // the secret as a leaf, which is also the shape the leaf pass has to
      // walk into.
      await run([SECRET_PLAINTEXT], { maskSecrets: createSecretMasker(secretBag()) });

      // Non-vacuity: the warning DID fire, so the assertions below are about
      // masking rather than about an absent message.
      expect(log()).toContain('recorded previous BillingMode is');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    // The whole-VALUE arm, which the leaf pass reaches and the message pass
    // cannot once `JSON.stringify` has escaped the quote.
    it('masks a secret that JSON escaping would otherwise hide', async () => {
      const ESCAPED = 'a"b-issue1997-ddb-escaped';
      const bag: RecordedSecretValues = new Map([
        [ESCAPED, '{{resolve:secretsmanager:ddb/doc:SecretString:v::}}'],
      ]);

      await run([ESCAPED], { maskSecrets: createSecretMasker(bag) });

      expect(log()).toContain('recorded previous BillingMode is');
      // The ESCAPED rendering is what actually leaked, so asserting only the
      // raw form would pass on the broken code.
      expect(log()).not.toContain(ESCAPED);
      expect(log()).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
      expect(log()).toContain(SECRET_MASK);
    });

    // The needle floor: `maskSecretsInText` masks an exact WHOLE-VALUE match at
    // ANY length but only scans for SUBSTRING needles of >= 4 characters, and a
    // finished message is always longer than the value inside it.
    it('masks a SHORT secret, which only the value-level pass can reach', async () => {
      const SHORT = 'kx2';
      const bag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:ddb/pin:SecretString:v::}}'],
      ]);

      await run([SHORT], { maskSecrets: createSecretMasker(bag) });

      expect(log()).toContain('recorded previous BillingMode is');
      // Asserted as the QUOTED form so three characters cannot match
      // incidentally inside another word in the message.
      expect(log()).not.toContain(`"${SHORT}"`);
      expect(log()).toContain(`"${SECRET_MASK}"`);
    });

    // The SINK's own arm, and the reason both layers exist. `maskLeafValue`
    // walks string leaves only — it returns a NUMBER unchanged, by design, since
    // a number cannot be handed to `maskSecretsInText`'s whole-value arm as a
    // needle. A numeric recorded previous mode is a realistic malformed state
    // record (CloudFormation is stringly-AND-numerically typed), it is UNUSABLE
    // so it reaches the warn arm, and `JSON.stringify` renders it WITHOUT quotes
    // or escapes — exactly the shape the message-level scan can still match.
    // Reverting the sink to a bare `this.logger.warn(message)` leaves this the
    // only failing test; reverting `maskLeafValue` leaves the escaped / short
    // cases failing and this one passing, so the two layers are fenced
    // independently.
    it('masks a NUMERIC secret through the sink, which the leaf walk declines', async () => {
      const NUMERIC = '90210';
      const bag: RecordedSecretValues = new Map([
        [NUMERIC, '{{resolve:secretsmanager:ddb/num:SecretString:v::}}'],
      ]);

      await run(Number(NUMERIC), { maskSecrets: createSecretMasker(bag) });

      expect(log()).toContain('recorded previous BillingMode is');
      expect(log()).not.toContain(NUMERIC);
      expect(log()).toContain(SECRET_MASK);
    });

    // Back-compat: absent means unmasked, which is what lets the contract be
    // optional. It also fences the opposite failure — a "fix" that swallowed
    // the value unconditionally.
    it('leaves the warning unmasked when the caller passes no context', async () => {
      await run([SECRET_PLAINTEXT]);

      expect(log()).toContain('recorded previous BillingMode is');
      expect(log()).toContain(SECRET_PLAINTEXT);
      expect(log()).not.toContain(SECRET_MASK);
    });

    it('does not mangle a non-secret value when a masker IS supplied', async () => {
      await run(['definitely-not-a-billing-mode'], {
        maskSecrets: createSecretMasker(secretBag()),
      });

      expect(log()).toContain('definitely-not-a-billing-mode');
      expect(log()).not.toContain(SECRET_MASK);
    });

    it('does not throw for a context that carries no masker', async () => {
      await expect(run([SECRET_PLAINTEXT], { desiredFromAwsReadback: true })).resolves.toBeDefined();
      expect(log()).toContain('recorded previous BillingMode is');
    });
  });

  // The `AWS::DynamoDB::Table` CREATE half. It is a DIFFERENT warn site
  // (`warnRefusedWarmThroughput`, reached from `create()` rather than from
  // `update()`), so a masker threaded on update alone leaves the fix conditional
  // on which path a given deploy takes.
  describe('AWS::DynamoDB::Table create()', () => {
    let provider: DynamoDBTableProvider;

    beforeEach(() => {
      provider = new DynamoDBTableProvider();
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'DescribeTableCommand') {
          return Promise.resolve({
            Table: { TableName: 'issue1997-table', TableStatus: 'ACTIVE' },
          });
        }
        return Promise.resolve({
          TableDescription: {
            TableName: 'issue1997-table',
            TableArn: 'arn:aws:dynamodb:us-east-1:0:table/issue1997-table',
          },
        });
      });
    });

    async function run(
      warmThroughput: unknown,
      context?: Parameters<DynamoDBTableProvider['create']>[3]
    ): Promise<unknown> {
      return await provider.create(
        'MyTable',
        'AWS::DynamoDB::Table',
        {
          TableName: 'issue1997-table',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          WarmThroughput: warmThroughput,
        },
        context
      );
    }

    it('masks a resolved secret in the refused WarmThroughput warning', async () => {
      await run(
        { NotAMember: SECRET_PLAINTEXT },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      expect(log()).toContain('carries no usable');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    it('leaves the warning unmasked when the caller passes no context', async () => {
      await run({ NotAMember: SECRET_PLAINTEXT });

      expect(log()).toContain('carries no usable');
      expect(log()).toContain(SECRET_PLAINTEXT);
      expect(log()).not.toContain(SECRET_MASK);
    });
  });

  // The `AWS::DynamoDB::GlobalTable` half — the same guard one type over. Its
  // file was held by another lane during #1932 item 3, which is why it was never
  // wired then.
  describe('AWS::DynamoDB::GlobalTable update()', () => {
    let provider: DynamoDBGlobalTableProvider;

    beforeEach(() => {
      provider = new DynamoDBGlobalTableProvider();
    });

    async function run(
      previousBillingMode: unknown,
      context?: Parameters<DynamoDBGlobalTableProvider['update']>[5]
    ): Promise<unknown> {
      return await provider.update(
        'MyGlobalTable',
        'issue1997-table',
        'AWS::DynamoDB::GlobalTable',
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
        },
        { BillingMode: previousBillingMode },
        context
      );
    }

    it('masks a resolved secret in the unusable recorded-previous BillingMode', async () => {
      // An ARRAY for the same reason as the sibling type above: a bare
      // non-blank string is USABLE and never reaches the warn arm.
      await run([SECRET_PLAINTEXT], { maskSecrets: createSecretMasker(secretBag()) });

      expect(log()).toContain('recorded previous BillingMode');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    it('masks a secret that JSON escaping would otherwise hide', async () => {
      const ESCAPED = 'q"z-issue1997-gt-escaped';
      const bag: RecordedSecretValues = new Map([
        [ESCAPED, '{{resolve:secretsmanager:gt/doc:SecretString:v::}}'],
      ]);

      await run([ESCAPED], { maskSecrets: createSecretMasker(bag) });

      expect(log()).toContain('recorded previous BillingMode');
      expect(log()).not.toContain(ESCAPED);
      expect(log()).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
      expect(log()).toContain(SECRET_MASK);
    });

    it('masks a SHORT secret, which only the value-level pass can reach', async () => {
      const SHORT = 'wq9';
      const bag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:gt/pin:SecretString:v::}}'],
      ]);

      await run([SHORT], { maskSecrets: createSecretMasker(bag) });

      expect(log()).toContain('recorded previous BillingMode');
      expect(log()).not.toContain(`"${SHORT}"`);
      expect(log()).toContain(`"${SECRET_MASK}"`);
    });

    // The SINK's own arm, and the reason both layers exist. `maskLeafValue`
    // walks string leaves only — it returns a NUMBER unchanged, by design, since
    // a number cannot be handed to `maskSecretsInText`'s whole-value arm as a
    // needle. A numeric recorded previous mode is a realistic malformed state
    // record (CloudFormation is stringly-AND-numerically typed), it is UNUSABLE
    // so it reaches the warn arm, and `JSON.stringify` renders it WITHOUT quotes
    // or escapes — exactly the shape the message-level scan can still match.
    // Reverting the sink to a bare `this.logger.warn(message)` leaves this the
    // only failing test; reverting `maskLeafValue` leaves the escaped / short
    // cases failing and this one passing, so the two layers are fenced
    // independently.
    it('masks a NUMERIC secret through the sink, which the leaf walk declines', async () => {
      const NUMERIC = '90210';
      const bag: RecordedSecretValues = new Map([
        [NUMERIC, '{{resolve:secretsmanager:gt/num:SecretString:v::}}'],
      ]);

      await run(Number(NUMERIC), { maskSecrets: createSecretMasker(bag) });

      expect(log()).toContain('recorded previous BillingMode');
      expect(log()).not.toContain(NUMERIC);
      expect(log()).toContain(SECRET_MASK);
    });

    it('leaves the warning unmasked when the caller passes no context', async () => {
      await run([SECRET_PLAINTEXT]);

      expect(log()).toContain('recorded previous BillingMode');
      expect(log()).toContain(SECRET_PLAINTEXT);
      expect(log()).not.toContain(SECRET_MASK);
    });

    it('does not mangle a non-secret value when a masker IS supplied', async () => {
      await run(['definitely-not-a-billing-mode'], {
        maskSecrets: createSecretMasker(secretBag()),
      });

      expect(log()).toContain('definitely-not-a-billing-mode');
      expect(log()).not.toContain(SECRET_MASK);
    });

    it('does not throw for a context that carries no masker', async () => {
      await expect(run([SECRET_PLAINTEXT], { desiredFromAwsReadback: true })).resolves.toBeDefined();
      expect(log()).toContain('recorded previous BillingMode');
    });
  });

  // Gap 1 + 3 (test review): `AWS::DynamoDB::GlobalTable.create()`'s masking was
  // entirely unfenced — replacing the masker with identity left the whole suite
  // green, although that path wires ~8 warn sites plus
  // `reportThroughputDiagnostics`. The throughput-diagnostic route is the one
  // that reaches both: its message embeds `JSON.stringify(rawValue)` (built
  // OUTSIDE the reporter, so only the SINK can mask it) and its `indexName`
  // (masked as a raw value INSIDE the reporter), so the two layers are
  // separable here.
  describe('AWS::DynamoDB::GlobalTable create()', () => {
    let provider: DynamoDBGlobalTableProvider;

    beforeEach(() => {
      provider = new DynamoDBGlobalTableProvider();
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'DescribeTableCommand') {
          return Promise.resolve({
            Table: {
              TableName: 'issue1997-table',
              TableArn: 'arn:aws:dynamodb:us-east-1:0:table/issue1997-table',
              TableStatus: 'ACTIVE',
              BillingModeSummary: { BillingMode: 'PROVISIONED' },
            },
          });
        }
        return Promise.resolve({
          TableDescription: {
            TableName: 'issue1997-table',
            TableArn: 'arn:aws:dynamodb:us-east-1:0:table/issue1997-table',
          },
        });
      });
      mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    });

    /**
     * A PROVISIONED GlobalTable whose write-capacity value does not resolve to a
     * number, which is what produces an `unresolved-member` diagnostic quoting
     * the raw value. `indexName` is supplied only when a GSI carries the same
     * defect, so the two arms below drive the table-level and per-index cases
     * separately.
     */
    function props(
      tableCapacity: unknown,
      gsi?: { name: string; capacity: unknown }
    ): Record<string, unknown> {
      return {
        TableName: 'issue1997-table',
        BillingMode: 'PROVISIONED',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        Replicas: [{ Region: 'us-east-1' }],
        WriteProvisionedThroughputSettings: { WriteCapacityUnits: tableCapacity },
        ...(gsi
          ? {
              GlobalSecondaryIndexes: [
                {
                  IndexName: gsi.name,
                  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
                  Projection: { ProjectionType: 'ALL' },
                  WriteProvisionedThroughputSettings: { WriteCapacityUnits: gsi.capacity },
                },
              ],
            }
          : {}),
      };
    }

    // Gap 1: fences `create()`'s masker AND the 4th argument it passes to
    // `reportThroughputDiagnostics`. The diagnostic message is assembled by a
    // module-level helper that never sees a masker, so the sink is the only
    // thing that can mask it — drop either and this goes red.
    it('masks a resolved secret in a create-path throughput diagnostic', async () => {
      await provider.create('MyGlobalTable', 'AWS::DynamoDB::GlobalTable', props(SECRET_PLAINTEXT), {
        maskSecrets: createSecretMasker(secretBag()),
      });

      // Non-vacuity: the diagnostic DID fire.
      expect(log()).toContain('did not resolve to a number');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    // Gap 2: the INNER layer. `reportThroughputDiagnostics` masks
    // `diagnostic.indexName` as a raw value, and a DynamoDB index name may be 3
    // characters — below `MIN_NEEDLE_LENGTH` (4) — so the sink's substring scan
    // can never reach it. Strip that one `maskSecrets(...)` and only this fails.
    it('masks a SHORT GSI index name, which only the value-level pass can reach', async () => {
      const SHORT_INDEX = 'ix9';
      const bag: RecordedSecretValues = new Map([
        [SHORT_INDEX, '{{resolve:secretsmanager:gt/idx:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyGlobalTable',
        'AWS::DynamoDB::GlobalTable',
        props(5, { name: SHORT_INDEX, capacity: 'not-a-number' }),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('did not resolve to a number');
      // Asserted in the QUOTED position the reporter renders, so three
      // characters cannot match incidentally elsewhere in the line.
      expect(log()).not.toContain(`GSI '${SHORT_INDEX}'`);
      expect(log()).toContain(`GSI '${SECRET_MASK}'`);
    });

    it('leaves a create-path diagnostic unmasked when no context is passed', async () => {
      await provider.create('MyGlobalTable', 'AWS::DynamoDB::GlobalTable', props(SECRET_PLAINTEXT));

      expect(log()).toContain('did not resolve to a number');
      expect(log()).toContain(SECRET_PLAINTEXT);
      expect(log()).not.toContain(SECRET_MASK);
    });
  });

  // Gap 3 (update side): the same reporter is called from `update()`, and
  // dropping ITS masker argument was independently unfenced.
  describe('AWS::DynamoDB::GlobalTable update() throughput diagnostics', () => {
    let provider: DynamoDBGlobalTableProvider;

    beforeEach(() => {
      provider = new DynamoDBGlobalTableProvider();
    });

    it('masks a resolved secret in an update-path throughput diagnostic', async () => {
      await provider.update(
        'MyGlobalTable',
        'issue1997-table',
        'AWS::DynamoDB::GlobalTable',
        // The update path collects its diagnostics from the GSI / replica
        // translators, NOT from the table-level capacity block — so the
        // unresolvable value has to sit on an index for this arm to fire.
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'issue1997idx',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: SECRET_PLAINTEXT },
            },
          ],
        },
        { BillingMode: 'PROVISIONED' },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      expect(log()).toContain('did not resolve to a number');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });
  });

  // Gap 4: `warnRefusedWarmThroughput`'s INNER `maskLeafValue` was unfenced —
  // the existing create cases used only a long needle, which the sink also
  // catches. These three separate the layers.
  describe('AWS::DynamoDB::Table create() refused WarmThroughput layers', () => {
    let provider: DynamoDBTableProvider;

    beforeEach(() => {
      provider = new DynamoDBTableProvider();
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'DescribeTableCommand') {
          return Promise.resolve({
            Table: { TableName: 'issue1997-table', TableStatus: 'ACTIVE' },
          });
        }
        return Promise.resolve({
          TableDescription: {
            TableName: 'issue1997-table',
            TableArn: 'arn:aws:dynamodb:us-east-1:0:table/issue1997-table',
          },
        });
      });
    });

    async function run(warm: unknown, bag: RecordedSecretValues): Promise<void> {
      await provider.create(
        'MyTable',
        'AWS::DynamoDB::Table',
        {
          TableName: 'issue1997-table',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          WarmThroughput: warm,
        },
        { maskSecrets: createSecretMasker(bag) }
      );
    }

    // Only the leaf walk can reach this: `JSON.stringify` escapes the quote, so
    // the needle no longer occurs in the finished line for the sink to find.
    it('masks a secret that JSON escaping would otherwise hide', async () => {
      const ESCAPED = 'a"b-issue1997-warm-escaped';
      await run(
        { NotAMember: ESCAPED },
        new Map([[ESCAPED, '{{resolve:secretsmanager:warm/doc:SecretString:v::}}']])
      );

      expect(log()).toContain('carries no usable');
      expect(log()).not.toContain(ESCAPED);
      expect(log()).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
      expect(log()).toContain(SECRET_MASK);
    });

    // Below the 4-character needle floor, so again only the leaf walk reaches it.
    it('masks a SHORT secret, which only the value-level pass can reach', async () => {
      const SHORT = 'w7q';
      await run(
        { NotAMember: SHORT },
        new Map([[SHORT, '{{resolve:secretsmanager:warm/pin:SecretString:v::}}']])
      );

      expect(log()).toContain('carries no usable');
      expect(log()).not.toContain(`"${SHORT}"`);
      expect(log()).toContain(`"${SECRET_MASK}"`);
    });

    // The mirror image: the leaf walk declines a NUMBER by design, so only the
    // sink can reach this one. Together with the two above, each layer has a
    // case the other cannot cover.
    it('masks a NUMERIC secret through the sink, which the leaf walk declines', async () => {
      const NUMERIC = '70707';
      await run(
        { NotAMember: Number(NUMERIC) },
        new Map([[NUMERIC, '{{resolve:secretsmanager:warm/num:SecretString:v::}}']])
      );

      expect(log()).toContain('carries no usable');
      expect(log()).not.toContain(NUMERIC);
      expect(log()).toContain(SECRET_MASK);
    });
  });

  // Gap 2 (table side): the per-value index-name masks in
  // `dynamodb-table-provider.ts` were unfenced for the same reason as the
  // GlobalTable ones — every fixture used a long needle the sink also catches.
  // A 3-character index name is below `MIN_NEEDLE_LENGTH` (4), so only the
  // whole-value mask on `indexName` can reach it.
  describe('AWS::DynamoDB::Table update() short index name', () => {
    let provider: DynamoDBTableProvider;

    beforeEach(() => {
      provider = new DynamoDBTableProvider();
    });

    const SHORT_INDEX = 'ix4';

    function gsi(capacity: { ReadCapacityUnits: number; WriteCapacityUnits: number }) {
      return {
        IndexName: SHORT_INDEX,
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: capacity,
      };
    }

    beforeEach(() => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'DescribeTableCommand') {
          return Promise.resolve({
            Table: {
              TableName: 'issue1997-table',
              TableArn: 'arn:aws:dynamodb:us-east-1:0:table/issue1997-table',
              TableStatus: 'ACTIVE',
              BillingModeSummary: { BillingMode: 'PROVISIONED' },
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
              GlobalSecondaryIndexes: [
                {
                  IndexName: SHORT_INDEX,
                  IndexStatus: 'ACTIVE',
                  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
                },
              ],
            },
          });
        }
        return Promise.resolve({});
      });
    });

    // `skipZeroCapacityIndexUpdate` names the index in its warning. The `{0, 0}`
    // request is the pre-#1767 state-record shape that arm exists for.
    it('masks a SHORT index name in the zero-capacity skip warning', async () => {
      const bag: RecordedSecretValues = new Map([
        [SHORT_INDEX, '{{resolve:secretsmanager:tbl/idx:SecretString:v::}}'],
      ]);

      await provider.update(
        'MyTable',
        'issue1997-table',
        'AWS::DynamoDB::Table',
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [gsi({ ReadCapacityUnits: 0, WriteCapacityUnits: 0 })],
        },
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [gsi({ ReadCapacityUnits: 9, WriteCapacityUnits: 9 })],
        },
        { maskSecrets: createSecretMasker(bag) }
      );

      // Non-vacuity: the skip DID fire.
      expect(log()).toContain('on-demand placeholder');
      expect(log()).not.toContain(`GSI ${SHORT_INDEX}`);
      expect(log()).toContain(`GSI ${SECRET_MASK}`);
    });
  });

  // THE BLOCKER (security review). `warmThroughputOpFor` masked `indexName`
  // where it built the two helper `scope` strings and then interpolated the SAME
  // value RAW into its own decrease warning and its already-matches debug line.
  // With a resolved secret as `IndexName` and a per-index WarmThroughput below
  // the live value, `cdkd deploy` printed the plaintext at DEFAULT verbosity.
  // No test reached this method before, which is why the first probe sweep
  // missed it entirely.
  describe('AWS::DynamoDB::Table warmThroughputOpFor (issue #1997 blocker)', () => {
    let provider: DynamoDBTableProvider;
    const SECRET_INDEX = 'issue1997-warm-index-plaintext';

    function bagFor(name: string): RecordedSecretValues {
      return new Map([[name, '{{resolve:secretsmanager:tbl/warmidx:SecretString:v::}}']]);
    }

    function gsiWith(name: string, read: number) {
      return {
        IndexName: name,
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        WarmThroughput: { ReadUnitsPerSecond: read },
      };
    }

    /** A live index whose warm throughput is ABOVE the value the template asks
     *  for, which is the only shape that reaches the decrease arm. */
    function primeLive(name: string): void {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'DescribeTableCommand') {
          return Promise.resolve({
            Table: {
              TableName: 'issue1997-table',
              TableArn: 'arn:aws:dynamodb:us-east-1:0:table/issue1997-table',
              TableStatus: 'ACTIVE',
              BillingModeSummary: { BillingMode: 'PROVISIONED' },
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
              GlobalSecondaryIndexes: [
                {
                  IndexName: name,
                  IndexStatus: 'ACTIVE',
                  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
                  WarmThroughput: { ReadUnitsPerSecond: 12000 },
                },
              ],
            },
          });
        }
        return Promise.resolve({});
      });
    }

    beforeEach(() => {
      provider = new DynamoDBTableProvider();
    });

    async function runDecrease(name: string, bag: RecordedSecretValues): Promise<void> {
      primeLive(name);
      await provider.update(
        'MyTable',
        'issue1997-table',
        'AWS::DynamoDB::Table',
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [gsiWith(name, 1000)] },
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [gsiWith(name, 9000)] },
        { maskSecrets: createSecretMasker(bag) }
      );
    }

    it('masks the index name in the WarmThroughput-decrease warning', async () => {
      await runDecrease(SECRET_INDEX, bagFor(SECRET_INDEX));

      // Non-vacuity: the decrease arm DID fire.
      expect(log()).toContain('decreasing WarmThroughput is not supported');
      expect(log()).not.toContain(SECRET_INDEX);
      expect(log()).toContain(SECRET_MASK);
    });

    // Below the 4-character floor, so the sink cannot reach it and only the
    // whole-value mask on `safeIndexName` can.
    it('masks a SHORT index name in the decrease warning', async () => {
      const SHORT = 'iw3';
      await runDecrease(SHORT, bagFor(SHORT));

      expect(log()).toContain('decreasing WarmThroughput is not supported');
      expect(log()).not.toContain(`GSI ${SHORT}`);
      expect(log()).toContain(`GSI ${SECRET_MASK}`);
    });

    // The SINK's own arm in this method. The two cases above put the secret in
    // `indexName`, which `safeIndexName` masks on its own — so removing the sink
    // left them green. The decrease warning ALSO interpolates the requested and
    // live warm-throughput NUMBERS, which no per-value mask touches (a number
    // cannot be a whole-value needle), so a numeric secret is reachable only
    // through the sink.
    it('masks a NUMERIC secret in the decrease warning, which only the sink reaches', async () => {
      const NUMERIC = '1000';
      const bag: RecordedSecretValues = new Map([
        [NUMERIC, '{{resolve:secretsmanager:tbl/warmnum:SecretString:v::}}'],
      ]);
      // The requested value IS this number, so it is rendered into the message
      // by `JSON.stringify(sendable)`.
      await runDecrease('plain-public-index', bag);

      expect(log()).toContain('decreasing WarmThroughput is not supported');
      expect(log()).not.toContain(NUMERIC);
      expect(log()).toContain(SECRET_MASK);
    });

    // The DEBUG sink in the same method, which is a separate binding. Its line
    // names `physicalId` — the resolved table name — and nothing else that any
    // per-value mask covers.
    it('masks the table name in the already-matches debug line', async () => {
      const SECRET_PHYSICAL = 'issue1997-warm-physical-plaintext';
      const bag: RecordedSecretValues = new Map([
        [SECRET_PHYSICAL, '{{resolve:secretsmanager:tbl/phys:SecretString:v::}}'],
      ]);
      // Live warm throughput EQUALS the requested value, which is the
      // already-matches arm rather than the decrease one.
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'DescribeTableCommand') {
          return Promise.resolve({
            Table: {
              TableName: SECRET_PHYSICAL,
              TableArn: `arn:aws:dynamodb:us-east-1:0:table/${SECRET_PHYSICAL}`,
              TableStatus: 'ACTIVE',
              BillingModeSummary: { BillingMode: 'PROVISIONED' },
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'plain-public-index',
                  IndexStatus: 'ACTIVE',
                  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
                  WarmThroughput: { ReadUnitsPerSecond: 7000 },
                },
              ],
            },
          });
        }
        return Promise.resolve({});
      });

      await provider.update(
        'MyTable',
        SECRET_PHYSICAL,
        'AWS::DynamoDB::Table',
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [gsiWith('plain-public-index', 7000)],
        },
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [gsiWith('plain-public-index', 6000)],
        },
        { maskSecrets: createSecretMasker(bag) }
      );

      const debugLog = debugged.join('\n');
      expect(debugLog).toContain('already carries the requested warm');
      expect(debugLog).not.toContain(SECRET_PHYSICAL);
      expect(debugLog).toContain(SECRET_MASK);
    });

    // The entry line's INNER mask on `physicalId`. The sink alone covers any
    // needle of 4+ characters, so this is only reachable below the floor — a
    // 3-character table name is legal in DynamoDB (the minimum is 3).
    it('masks a SHORT table name in the update entry debug line', async () => {
      const SHORT_PHYSICAL = 'tb3';
      const bag: RecordedSecretValues = new Map([
        [SHORT_PHYSICAL, '{{resolve:secretsmanager:tbl/shortphys:SecretString:v::}}'],
      ]);

      await provider.update(
        'MyTable',
        SHORT_PHYSICAL,
        'AWS::DynamoDB::Table',
        { BillingMode: 'PROVISIONED' },
        { BillingMode: 'PROVISIONED' },
        { maskSecrets: createSecretMasker(bag) }
      );

      const debugLog = debugged.join('\n');
      expect(debugLog).toContain('Updating DynamoDB table');
      expect(debugLog).not.toContain(`: ${SHORT_PHYSICAL}`);
      expect(debugLog).toContain(`: ${SECRET_MASK}`);
    });

    it('leaves the decrease warning unmasked when no context is passed', async () => {
      primeLive(SECRET_INDEX);
      await provider.update(
        'MyTable',
        'issue1997-table',
        'AWS::DynamoDB::Table',
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [gsiWith(SECRET_INDEX, 1000)] },
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [gsiWith(SECRET_INDEX, 9000)] }
      );

      expect(log()).toContain('decreasing WarmThroughput is not supported');
      expect(log()).toContain(SECRET_INDEX);
      expect(log()).not.toContain(SECRET_MASK);
    });
  });

  // Minor 2 (spec review): `create()` installed the masker but built no sink, so
  // the partial-create rollback warning printed `tableName` — which is
  // `properties['TableName']` — unmasked. Reached by letting CreateTable
  // succeed and a later wiring call fail, then failing the cleanup DeleteTable
  // too, which is the only path to that warning.
  describe('AWS::DynamoDB::Table create() partial-create rollback', () => {
    let provider: DynamoDBTableProvider;
    const SECRET_TABLE = 'issue1997-rollback-table-plaintext';

    beforeEach(() => {
      provider = new DynamoDBTableProvider();
    });

    async function run(context?: Parameters<DynamoDBTableProvider['create']>[3]): Promise<void> {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        const name = command.constructor.name;
        if (name === 'CreateTableCommand') {
          return Promise.resolve({
            TableDescription: {
              TableName: SECRET_TABLE,
              TableArn: `arn:aws:dynamodb:us-east-1:0:table/${SECRET_TABLE}`,
            },
          });
        }
        // The post-create wait fails, which sends create() down its rollback
        // path; the rollback's own DeleteTable then fails too, which is the
        // arm that warns.
        if (name === 'DescribeTableCommand') return Promise.reject(new Error('wait blew up'));
        if (name === 'DeleteTableCommand') return Promise.reject(new Error('cleanup blew up'));
        return Promise.resolve({});
      });

      await provider
        .create(
          'MyTable',
          'AWS::DynamoDB::Table',
          {
            TableName: SECRET_TABLE,
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          },
          context
        )
        // The create is EXPECTED to fail here — the assertion is about what the
        // rollback warning printed on the way out, not about the outcome.
        .catch(() => undefined);
    }

    it('masks the table name in the partial-create rollback warning', async () => {
      const bag: RecordedSecretValues = new Map([
        [SECRET_TABLE, '{{resolve:secretsmanager:tbl/name:SecretString:v::}}'],
      ]);
      await run({ maskSecrets: createSecretMasker(bag) });

      // Non-vacuity: the rollback arm DID fire.
      expect(log()).toContain('Failed to roll back partially-created');
      expect(log()).not.toContain(SECRET_TABLE);
      expect(log()).toContain(SECRET_MASK);
    });

    it('leaves the rollback warning unmasked when no context is passed', async () => {
      await run();

      expect(log()).toContain('Failed to roll back partially-created');
      expect(log()).toContain(SECRET_TABLE);
      expect(log()).not.toContain(SECRET_MASK);
    });
  });

  // Minor 4 (spec review): `waitForTableActiveAfterUpdate` interpolates
  // `tableName` into a warning AND into a ProvisioningError. The THROW is the
  // more severe half — the deploy engine's CLI path logs `error.message` RAW,
  // masking it only on the events-store path — so the two are fenced separately.
  // `maxAttempts` is driven down to 1 so the loop exits immediately rather than
  // polling out its real ~12-minute budget.
  describe('AWS::DynamoDB::GlobalTable waitForTableActiveAfterUpdate', () => {
    let provider: DynamoDBGlobalTableProvider;
    const SECRET_TABLE = 'issue1997-wait-table-plaintext';

    function bag(): RecordedSecretValues {
      return new Map([[SECRET_TABLE, '{{resolve:secretsmanager:gt/wait:SecretString:v::}}']]);
    }

    /** Reach the method directly: driving it through `update()` would need the
     *  whole diff machinery to line up, and the masking is a property of this
     *  method rather than of the route into it. */
    function callWait(
      status: string,
      masker?: ReturnType<typeof createSecretMasker>
    ): Promise<void> {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Table: {
            TableName: SECRET_TABLE,
            TableStatus: status,
            GlobalSecondaryIndexes: [{ IndexName: 'ix', IndexStatus: 'CREATING' }],
          },
        })
      );
      return (
        provider as unknown as {
          waitForTableActiveAfterUpdate: (
            t: string,
            l: string,
            m?: number,
            b?: unknown,
            mask?: (text: string) => string
          ) => Promise<void>;
        }
      ).waitForTableActiveAfterUpdate(SECRET_TABLE, 'MyGlobalTable', 1, undefined, masker);
    }

    beforeEach(() => {
      provider = new DynamoDBGlobalTableProvider();
    });

    // ACTIVE table + a still-transitioning index = the WARN arm.
    it('masks the table name in the still-transitioning warning', async () => {
      await callWait('ACTIVE', createSecretMasker(bag()));

      expect(log()).toContain('were still transitioning');
      expect(log()).not.toContain(SECRET_TABLE);
      expect(log()).toContain(SECRET_MASK);
    });

    it('leaves that warning unmasked when no masker is passed', async () => {
      await callWait('ACTIVE');

      expect(log()).toContain('were still transitioning');
      expect(log()).toContain(SECRET_TABLE);
      expect(log()).not.toContain(SECRET_MASK);
    });

    // A never-ACTIVE table takes the THROW arm instead.
    it('masks the table name in the did-not-reach-ACTIVE throw', async () => {
      await expect(callWait('UPDATING', createSecretMasker(bag()))).rejects.toThrow(
        /did not reach ACTIVE/
      );

      try {
        await callWait('UPDATING', createSecretMasker(bag()));
        throw new Error('expected a refusal');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('did not reach ACTIVE');
        expect(message).not.toContain(SECRET_TABLE);
        expect(message).toContain(SECRET_MASK);
      }
    });
  });
});
