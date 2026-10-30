import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The DynamoDB Table and GlobalTable wraps must not write the CALLER'S
 * IDENTITY into a persisted store (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and DynamoDB words an `AccessDeniedException` as
 * `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
 * to perform: ...`. Each AWS fixture here carries that wording and the smithy
 * service markers `describeAwsFailure` keys on. Both polarities: an
 * AWS-authored failure is named by its class with `cause` kept (so the retry
 * classifiers still read it), and a cdkd-authored or transport failure keeps
 * its own text.
 */

const { mockSend, mockAutoScalingSend, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  debugSpy: vi.fn(),
}));

// Issue #5451: a rate-limited UpdateTimeToLive is re-sent until the enclosing
// resource deadline runs out. 0 = already out, so a refusal is final at once.
const ttlDeadline = vi.hoisted(() => ({ remainingMs: 0 }));
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/resource-deadline.js')>()),
  enclosingDeadlineRemainingMs: () => ttlDeadline.remainingMs,
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
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAccountInfo: () =>
      Promise.resolve({ accountId: '111122223333', region: 'us-east-1', partition: 'aws' }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  DynamoDBTableProvider,
  deleteTableRetryDelays as tableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import {
  DynamoDBGlobalTableProvider,
  deleteTableRetryDelays as globalTableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** An AWS-authored DynamoDB failure: the smithy markers plus `name`. */
function awsError(name: string, message: string, httpStatusCode = 400): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
  });
}

/** An `AccessDeniedException` as DynamoDB words it. */
function accessDenied(action: string): Error {
  return awsError(
    'AccessDeniedException',
    `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
      `arn:aws:dynamodb:us-east-1:${CALLER_ACCOUNT}:table/t1 because no ` +
      `identity-based policy allows the ${action} action`
  );
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

const TABLE_NAME = 't1';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:111122223333:table/${TABLE_NAME}`;
const ACTIVE_TABLE = {
  Table: {
    TableName: TABLE_NAME,
    TableArn: TABLE_ARN,
    TableId: 'table-id-1',
    TableStatus: 'ACTIVE',
    Replicas: [],
  },
};

/** Fail `failing` with `error`; every other command answers `answers[name]` or an ACTIVE table. */
function failOn(failing: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name === failing) throw error;
    return answers[name] ?? ACTIVE_TABLE;
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

const debugged = (): string => debugSpy.mock.calls.map((args) => String(args[0])).join('\n');

const TABLE_PROPS = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
};
const GLOBAL_PROPS = { ...TABLE_PROPS, Replicas: [{ Region: 'us-east-1' }] };

type Site = {
  site: string;
  command: string;
  /** The IAM action the denial names, the site's own. */
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  run: () => Promise<unknown>;
};

function sites(): Site[] {
  return [
    {
      site: 'Table create',
      command: 'CreateTableCommand',
      action: 'dynamodb:CreateTable',
      prefix: 'Failed to create DynamoDB table Res: ',
      run: () => new DynamoDBTableProvider().create('Res', 'AWS::DynamoDB::Table', TABLE_PROPS),
    },
    {
      site: 'Table update',
      command: 'TagResourceCommand',
      action: 'dynamodb:TagResource',
      prefix: 'Failed to update DynamoDB table Res: ',
      run: () =>
        new DynamoDBTableProvider().update(
          'Res',
          TABLE_NAME,
          'AWS::DynamoDB::Table',
          { ...TABLE_PROPS, Tags: [{ Key: 'k', Value: 'v2' }] },
          { ...TABLE_PROPS, Tags: [{ Key: 'k', Value: 'v1' }] }
        ),
    },
    {
      site: 'Table delete',
      command: 'DeleteTableCommand',
      action: 'dynamodb:DeleteTable',
      prefix: 'Failed to delete DynamoDB table Res: ',
      run: () => new DynamoDBTableProvider().delete('Res', TABLE_NAME, 'AWS::DynamoDB::Table', {}),
    },
    // The GlobalTable sites live in `tail-d-thrown-text-2319.test.ts`
    // (go-to-k/cdkd#2319): their wrap withholds a non-Error throw.
  ];
}

describe('DynamoDB thrown wraps keep the caller identity out (go-to-k/cdkd#2319)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    debugSpy.mockReset();
  });

  describe.each(sites())('$site', ({ site, command, action, prefix, answers, run }) => {
    it('names an AWS-authored failure by its class, keeps cause, and stays retryable', async () => {
      const original = accessDenied(action);
      failOn(command, original, answers);
      const failure = await thrown(run());

      // Non-vacuity: the rejection came from the site's own command.
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect(failure.message).toBe(`${prefix}AccessDeniedException. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(failure.message).not.toContain(CALLER_ROLE);
      expect(failure.message).not.toContain(CALLER_SESSION);
      expect(failure.cause).toBe(original);

      // The withheld `not authorized to perform` still reaches the classifier.
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);

      // AWS's own text is not discarded: it is on the debug line.
      expect(debugged()).toContain(`${prefix}User: ${CALLER_ARN}`);
    });

    it('keeps a cdkd-authored or transport failure verbatim, unstamped', async () => {
      const original = new Error('connect ECONNREFUSED 10.0.0.1:443');
      failOn(command, original, answers);
      const failure = await thrown(run());

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toBe(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(hasRedactedCause(failure)).toBe(false);
      expect(failure.cause).toBe(original);
    });

    it('handles a non-Error throw unstamped', async () => {
      failOn(command, 'socket hang up', answers);
      const failure = await thrown(run());

      if (site.startsWith('Table ')) {
        // The Table wrap withholds the value, the whole payload with no class
        // to fall back to, as the settled #2319 wrap does; it has no chain to
        // stamp, and the text is on the debug line.
        expect(failure.message).toBe(
          `${prefix}a non-Error value of type string. ${VERBOSE_POINTER}`
        );
        expect(debugged()).toContain(`${prefix}socket hang up`);
      } else {
        expect(failure.message).toBe(`${prefix}socket hang up`);
      }
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });

  describe.each([
    {
      label: 'Table',
      prefix: 'Failed to create DynamoDB table Res: ',
      run: (context?: { maskSecrets: (text: string) => string }) =>
        new DynamoDBTableProvider().create('Res', 'AWS::DynamoDB::Table', TABLE_PROPS, context),
    },
    {
      label: 'GlobalTable',
      prefix: 'Failed to create DynamoDB GlobalTable Res: ',
      run: (context?: { maskSecrets: (text: string) => string }) =>
        new DynamoDBGlobalTableProvider().create(
          'Res',
          'AWS::DynamoDB::GlobalTable',
          GLOBAL_PROPS,
          context
        ),
    },
  ])('$label create', ({ prefix, run }) => {
    it('restates an occupied name, so a create-first replacement still sees the collision', async () => {
      failOn(
        'CreateTableCommand',
        awsError('ResourceInUseException', `Table already exists: ${TABLE_NAME}`)
      );
      const failure = await thrown(run());
      expect(failure.message).toBe(
        `${prefix}ResourceInUseException. ${VERBOSE_POINTER} AWS reports that it already exists.`
      );
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
    });

    it('restates nothing for a ResourceInUseException that is not an occupied name', async () => {
      failOn(
        'CreateTableCommand',
        awsError('ResourceInUseException', `Table is being deleted: ${TABLE_NAME}`)
      );
      const failure = await thrown(run());
      expect(failure.message).toBe(`${prefix}ResourceInUseException. ${VERBOSE_POINTER}`);
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(false);
    });

    it('masks a secret AWS echoes back on the debug line', async () => {
      const SECRET = 'dynamodb-secret-echo-value';
      failOn(
        'CreateTableCommand',
        awsError('ValidationException', `Invalid table name '${SECRET}'`)
      );
      const failure = await thrown(
        run({ maskSecrets: (text: string) => text.split(SECRET).join('***') })
      );
      expect(failure.message).toBe(`${prefix}ValidationException. ${VERBOSE_POINTER}`);
      expect(debugged()).toContain(`${prefix}Invalid table name '***'`);
      expect(debugged()).not.toContain(SECRET);
    });
  });

  it.each([
    {
      label: 'Table delete',
      command: 'DeleteTableCommand',
      prefix: 'Failed to delete DynamoDB table Res: ',
      run: (maskSecrets: (text: string) => string) =>
        new DynamoDBTableProvider().delete('Res', TABLE_NAME, 'AWS::DynamoDB::Table', {}, {
          maskSecrets,
        }),
    },
    {
      label: 'GlobalTable describe before delete',
      command: 'DescribeTableCommand',
      prefix: 'Failed to describe DynamoDB GlobalTable Res before delete: ',
      run: (maskSecrets: (text: string) => string) =>
        new DynamoDBGlobalTableProvider().delete(
          'Res',
          TABLE_NAME,
          'AWS::DynamoDB::GlobalTable',
          {},
          { maskSecrets }
        ),
    },
    {
      label: 'GlobalTable delete',
      command: 'DeleteTableCommand',
      prefix: 'Failed to delete DynamoDB GlobalTable Res: ',
      run: (maskSecrets: (text: string) => string) =>
        new DynamoDBGlobalTableProvider().delete(
          'Res',
          TABLE_NAME,
          'AWS::DynamoDB::GlobalTable',
          {},
          { maskSecrets }
        ),
    },
  ])('$label masks a secret AWS echoes back on the debug line', async ({ command, prefix, run }) => {
    const SECRET = 'dynamodb-secret-echo-value';
    failOn(command, awsError('ValidationException', `Invalid request for '${SECRET}'`));
    const failure = await thrown(run((text: string) => text.split(SECRET).join('***')));
    expect(failure.message).toBe(`${prefix}ValidationException. ${VERBOSE_POINTER}`);
    expect(debugged()).toContain(`${prefix}Invalid request for '***'`);
    expect(debugged()).not.toContain(SECRET);
  });

  describe.each([
    {
      label: 'Table',
      seam: tableDeleteDelays,
      run: (name: string, maskSecrets: (text: string) => string) =>
        new DynamoDBTableProvider().delete('Res', name, 'AWS::DynamoDB::Table', {}, {
          maskSecrets,
        }),
    },
    {
      label: 'GlobalTable',
      seam: globalTableDeleteDelays,
      run: (name: string, maskSecrets: (text: string) => string) =>
        new DynamoDBGlobalTableProvider().delete(
          'Res',
          name,
          'AWS::DynamoDB::GlobalTable',
          {},
          { maskSecrets }
        ),
    },
  ])('$label index-busy retry loop', ({ seam, run }) => {
    const INDEX_BUSY =
      'Attempt to change a resource which is still in use: Cannot delete table while ' +
      'indexes are being created, updated, or deleted.';

    it.each([
      {
        // A long secret name: the masker's substring arm catches it in the line.
        shape: 'a secret name in the line',
        name: 'secret-derived-table-name',
        maskSecrets: (text: string) => text.split('secret-derived-table-name').join('***'),
      },
      {
        // A name below the substring floor: only the whole-value arm knows it,
        // so it is caught only because the loop's sink masks the NAME as a value.
        shape: 'a short secret name only the whole-value arm matches',
        name: 'k9',
        maskSecrets: (text: string) => (text === 'k9' ? '***' : text),
      },
    ])('masks withRetry\'s debug line on the delete path ($shape)', async ({ name, maskSecrets }) => {
      seam.sleep = () => Promise.resolve();
      try {
        let deletes = 0;
        mockSend.mockImplementation(async (command: unknown) => {
          if (commandName(command) === 'DeleteTableCommand') {
            deletes += 1;
            if (deletes === 1) {
              throw awsError('ResourceInUseException', `${INDEX_BUSY} Table: ${name}`);
            }
            return {};
          }
          if (commandName(command) === 'DescribeTableCommand' && deletes > 0) {
            throw awsError('ResourceNotFoundException', 'Requested resource not found');
          }
          return { Table: { ...ACTIVE_TABLE.Table, TableName: name } };
        });
        await run(name, maskSecrets);

        expect(deletes).toBe(2);
        const retryLine = debugSpy.mock.calls
          .map((args) => String(args[0]))
          .find((line) => line.includes('Retrying Res'));
        // The `dynamodb-gsi-update` / `dynamodb-globaltable` integs grep AWS's
        // sentence out of this line: masking must leave it intact.
        expect(retryLine).toContain('Cannot delete table while indexes are being');
        expect(retryLine).toContain('Table: ***');
        expect(retryLine).not.toContain(`Table: ${name}`);
      } finally {
        delete seam.sleep;
      }
    });
  });

  describe('GlobalTable TimeToLive rate-limit wrap', () => {
    const TTL_LIMIT = 'Time to live has been modified multiple times within a fixed interval';
    const runTtl = () =>
      new DynamoDBGlobalTableProvider().update(
        'Res',
        TABLE_NAME,
        'AWS::DynamoDB::GlobalTable',
        { ...GLOBAL_PROPS, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } },
        GLOBAL_PROPS
      );

    it('names the class and closes it as one sentence before the remedy', async () => {
      const original = awsError('ValidationException', `${TTL_LIMIT} (account ${CALLER_ACCOUNT})`);
      failOn('UpdateTimeToLiveCommand', original);
      const failure = await thrown(runTtl());
      expect(failure.message).toBe(
        `AWS rejected TimeToLive update on ${TABLE_NAME}: ValidationException. ${VERBOSE_POINTER} ` +
          'AWS rate-limits TTL changes per table, and kept refusing until the resource timeout ' +
          'ran out; redeploy once the interval has passed (up to about an hour), or raise ' +
          '--resource-timeout.'
      );
      expect(failure.cause).toBe(original);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(debugged()).toContain(TTL_LIMIT);
    });

    it('keeps a non-AWS text verbatim, closed as one sentence', async () => {
      failOn('UpdateTimeToLiveCommand', new Error(TTL_LIMIT));
      const failure = await thrown(runTtl());
      expect(failure.message).toContain(`${TTL_LIMIT}. AWS rate-limits`);
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });
});
