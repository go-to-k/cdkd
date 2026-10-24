import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2319, the `tail-e` provider slice: a provider's create / update
 * / delete wrap is persisted to `deployments/{runId}.jsonl`, so an AWS-authored
 * failure is named by its class plus the --verbose pointer; AWS's text (the
 * caller's role ARN and account id) goes to the masked debug line and stays on
 * `cause` for the retry classifiers. A delete wrap naming a foreign `NotFound`
 * class is stamped `markNotGone`, and an "already exists" the class does not
 * carry is restated, except from a post-create step.
 */

const { mockSend, debug, warn, error, waitUpdated, waitActive, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    waitUpdated: vi.fn(),
    waitActive: vi.fn(),
    fakeClient: () => ({
      send: (command: unknown) => send(command) as unknown,
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () => Promise.resolve(undefined),
      },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
  };
});

vi.mock('@aws-sdk/client-lambda', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda')>()),
  LambdaClient: vi.fn().mockImplementation(() => fakeClient()),
  waitUntilFunctionUpdatedV2: waitUpdated,
  waitUntilFunctionActiveV2: waitActive,
}));
for (const [mod, client] of [
  ['@aws-sdk/client-appsync', 'AppSyncClient'],
  ['@aws-sdk/client-glue', 'GlueClient'],
  ['@aws-sdk/client-sts', 'STSClient'],
  ['@aws-sdk/client-s3', 'S3Client'],
  ['@aws-sdk/client-s3tables', 'S3TablesClient'],
  ['@aws-sdk/client-servicediscovery', 'ServiceDiscoveryClient'],
] as const) {
  vi.doMock(mod, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    [client]: vi.fn().mockImplementation(() => fakeClient()),
  }));
}

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => new Proxy({}, { get: () => fakeClient() }),
}));
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccountInfo: () =>
    Promise.resolve({ accountId: '111122223333', region: 'us-east-1', partition: 'aws' }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = { debug, info: vi.fn(), warn, error, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

const { LambdaFunctionProvider } = await import(
  '../../../src/provisioning/providers/lambda-function-provider.js'
);
const { LambdaPermissionProvider } = await import(
  '../../../src/provisioning/providers/lambda-permission-provider.js'
);
const { LambdaLayerVersionProvider } = await import(
  '../../../src/provisioning/providers/lambda-layer-provider.js'
);
const { LambdaEventInvokeConfigProvider } = await import(
  '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js'
);
const { S3BucketPolicyProvider } = await import(
  '../../../src/provisioning/providers/s3-bucket-policy-provider.js'
);
const { S3BucketProvider } = await import(
  '../../../src/provisioning/providers/s3-bucket-provider.js'
);
const { AppSyncProvider } = await import('../../../src/provisioning/providers/appsync-provider.js');
const {
  GlueProvider,
  GlueWorkflowProvider,
  GlueSecurityConfigurationProvider,
  GlueJobProvider,
  GlueCrawlerProvider,
  GlueConnectionProvider,
  GlueTriggerProvider,
} = await import('../../../src/provisioning/providers/glue-provider.js');
const { S3TablesProvider } = await import(
  '../../../src/provisioning/providers/s3-tables-provider.js'
);
const { ServiceDiscoveryProvider } = await import(
  '../../../src/provisioning/providers/servicediscovery-provider.js'
);
const {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} = await import('../../../src/deployment/retryable-errors.js');
const { VERBOSE_POINTER } = await import('../../../src/utils/aws-failure-text.js');
const { isMarkedNotGone } = await import('../../../src/provisioning/not-gone.js');
const { allowUnscopedCreateTokensForTests } = await import(
  '../../../src/provisioning/providers/idempotency-token.js'
);
const { awsSdkError } = await import('../_aws-sdk-error.js');

// create() runs outside a withStackScope scope here, so the stack-scoped
// create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: x:Y`;
const denied = (): Error => {
  const e = awsSdkError(DENIED, 'AccessDenied');
  Object.assign(e, { $fault: 'client' });
  return e;
};
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
/** An AWS-authored failure whose CLASS spells the secret: only `mask(summary)` removes it. */
const secretClass = (): Error =>
  Object.assign(new Error('denied'), {
    name: 'Denieds3cr3tException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const ctx = { maskSecrets: mask };
const lines = (spy: typeof debug): string[] => spy.mock.calls.map((c) => String(c[0]));
const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

/** Only `failing` rejects (with the case's rejection); every other call answers `answer`. */
function only(failing: string, answer: (name: string) => unknown = () => ({})) {
  return (rejection: unknown): void => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      return name === failing ? Promise.reject(rejection) : Promise.resolve(answer(name));
    });
  };
}

const FN = 'AWS::Lambda::Function';
const PERM = 'AWS::Lambda::Permission';
const LAYER = 'AWS::Lambda::LayerVersion';
const EIC = 'AWS::Lambda::EventInvokeConfig';
const POLICY = 'AWS::S3::BucketPolicy';
const FN_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:fn`;
const FN_PROPS = {
  FunctionName: 'fn',
  Code: { ZipFile: 'exports.handler = async () => {};' },
  Role: `arn:aws:iam::${ACCOUNT}:role/exec`,
  Handler: 'index.handler',
  Runtime: 'nodejs20.x',
};
const FN_PROPS_NEW = { ...FN_PROPS, Timeout: 10 };
const PERM_PROPS = {
  FunctionName: 'fn',
  Action: 'lambda:InvokeFunction',
  Principal: 's3.amazonaws.com',
};
const PERM_PROPS_NEW = { ...PERM_PROPS, Principal: 'sns.amazonaws.com' };
const LAYER_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:l:1`;
const LAYER_PROPS = { LayerName: 'l', Content: { S3Bucket: 'b', S3Key: 'k' } };
const EIC_PROPS = { FunctionName: 'fn', Qualifier: '$LATEST', MaximumRetryAttempts: 1 };
const EIC_PROPS_NEW = { ...EIC_PROPS, MaximumRetryAttempts: 2 };
const POLICY_PROPS = {
  Bucket: 'bkt',
  PolicyDocument: { Version: '2012-10-17', Statement: [] },
};

/**
 * `prime` makes only the site's own call reject, for a site an earlier call in
 * the same method would otherwise wrap first; without it every send rejects.
 */
type Case = {
  wrap: string;
  run: () => Promise<unknown>;
  prime?: (rejection: unknown) => void;
};

function reject(c: Case, rejection: unknown): void {
  if (c.prime) c.prime(rejection);
  else mockSend.mockRejectedValue(rejection);
}

/** The sites whose wrap this slice converted to the class-only shape. */
const wrapCases: Case[] = [
  {
    wrap: 'Failed to create Lambda function Fn',
    run: () => new LambdaFunctionProvider().create('Fn', FN, FN_PROPS, ctx),
  },
  {
    wrap: 'Failed to update Lambda function Fn',
    run: () => new LambdaFunctionProvider().update('Fn', 'fn', FN, FN_PROPS_NEW, FN_PROPS, ctx),
  },
  {
    wrap: 'Lambda function Fn update did not complete',
    run: () => new LambdaFunctionProvider().update('Fn', 'fn', FN, FN_PROPS_NEW, FN_PROPS, ctx),
    prime: (rejection) => {
      mockSend.mockResolvedValue({ Configuration: { FunctionName: 'fn', FunctionArn: FN_ARN } });
      waitUpdated.mockRejectedValue(rejection);
    },
  },
  {
    wrap: 'Failed to delete Lambda function Fn',
    run: () => new LambdaFunctionProvider().delete('Fn', 'fn', FN, FN_PROPS, ctx),
  },
  {
    wrap: 'Failed to create Lambda permission Perm',
    run: () => new LambdaPermissionProvider().create('Perm', PERM, PERM_PROPS, ctx),
  },
  {
    wrap: 'Failed to update Lambda permission Perm',
    run: () =>
      new LambdaPermissionProvider().update('Perm', 'sid', PERM, PERM_PROPS_NEW, PERM_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete Lambda permission Perm',
    run: () => new LambdaPermissionProvider().delete('Perm', 'sid', PERM, PERM_PROPS, ctx),
  },
  {
    wrap: 'Failed to create Lambda layer version Layer',
    run: () => new LambdaLayerVersionProvider().create('Layer', LAYER, LAYER_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete Lambda layer version Layer',
    run: () => new LambdaLayerVersionProvider().delete('Layer', LAYER_ARN, LAYER, LAYER_PROPS, ctx),
  },
  {
    wrap: 'Failed to create Lambda EventInvokeConfig Eic',
    run: () => new LambdaEventInvokeConfigProvider().create('Eic', EIC, EIC_PROPS, ctx),
  },
  {
    wrap: 'Failed to update Lambda EventInvokeConfig Eic',
    run: () =>
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        'fn|$LATEST',
        EIC,
        EIC_PROPS_NEW,
        EIC_PROPS,
        ctx
      ),
  },
  {
    wrap:
      'Failed to update Lambda EventInvokeConfig Eic: could not resolve its FunctionName to ' +
      'confirm the re-spelling names the same function',
    run: () =>
      new LambdaEventInvokeConfigProvider().update(
        'Eic',
        `${FN_ARN}|$LATEST`,
        EIC,
        EIC_PROPS_NEW,
        { ...EIC_PROPS, FunctionName: FN_ARN },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete Lambda EventInvokeConfig Eic',
    run: () =>
      new LambdaEventInvokeConfigProvider().delete('Eic', 'fn|$LATEST', EIC, EIC_PROPS, ctx),
  },
  {
    wrap: 'Failed to create S3 bucket policy Pol',
    run: () => new S3BucketPolicyProvider().create('Pol', POLICY, POLICY_PROPS, ctx),
  },
  {
    wrap: 'Failed to update S3 bucket policy Pol',
    run: () =>
      new S3BucketPolicyProvider().update(
        'Pol',
        'bkt',
        POLICY,
        { ...POLICY_PROPS, PolicyDocument: { Version: '2012-10-17', Statement: [{}] } },
        POLICY_PROPS,
        ctx
      ),
  },
  {
    wrap: 'Failed to delete S3 bucket policy Pol',
    run: () => new S3BucketPolicyProvider().delete('Pol', 'bkt', POLICY, POLICY_PROPS, ctx),
  },
];

/**
 * The delete wraps that already named the class and gain only `markNotGone`
 * here, beside the converted ones above.
 */
const notGoneOnlyCases: Case[] = [
  {
    wrap: 'Failed to delete GraphQL API Res',
    run: () => new AppSyncProvider().delete('Res', 'api-1', 'AWS::AppSync::GraphQLApi', {}, ctx),
  },
  {
    wrap: 'Failed to delete DataSource Res',
    run: () =>
      new AppSyncProvider().delete('Res', 'api-1|ds1', 'AWS::AppSync::DataSource', {}, ctx),
  },
  {
    wrap: 'Failed to delete Resolver Res',
    run: () =>
      new AppSyncProvider().delete('Res', 'api-1|Query|a', 'AWS::AppSync::Resolver', {}, ctx),
  },
  {
    wrap: 'Failed to delete ApiKey Res',
    run: () => new AppSyncProvider().delete('Res', 'api-1|key-1', 'AWS::AppSync::ApiKey', {}, ctx),
  },
  {
    wrap: 'Failed to delete Glue Database Db',
    run: () => new GlueProvider().delete('Db', 'mydb', 'AWS::Glue::Database', {}, ctx),
  },
  {
    wrap: 'Failed to delete Glue Table Tbl',
    run: () =>
      new GlueProvider().delete(
        'Tbl',
        'mydb|mytbl',
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete Glue Workflow Wf',
    run: () => new GlueWorkflowProvider().delete('Wf', 'wf', 'AWS::Glue::Workflow', {}, ctx),
  },
  {
    wrap: 'Failed to delete Glue SecurityConfiguration Sec',
    run: () =>
      new GlueSecurityConfigurationProvider().delete(
        'Sec',
        'sec',
        'AWS::Glue::SecurityConfiguration',
        {},
        ctx
      ),
  },
  {
    wrap: 'Failed to delete Glue Job Job',
    run: () => new GlueJobProvider().delete('Job', 'job', 'AWS::Glue::Job', {}, ctx),
  },
  {
    wrap: 'Failed to delete Glue Crawler Cr',
    run: () => new GlueCrawlerProvider().delete('Cr', 'cr', 'AWS::Glue::Crawler', {}, ctx),
  },
  {
    wrap: 'Failed to delete Glue Connection Conn',
    run: () =>
      new GlueConnectionProvider().delete('Conn', 'conn', 'AWS::Glue::Connection', {}, ctx),
  },
  {
    wrap: 'Failed to delete Glue Trigger Trg',
    run: () => new GlueTriggerProvider().delete('Trg', 'trg', 'AWS::Glue::Trigger', {}, ctx),
  },
  {
    wrap: 'Failed to delete S3 Table Bucket Tb',
    run: () =>
      new S3TablesProvider().delete(
        'Tb',
        `arn:aws:s3tables:us-east-1:${ACCOUNT}:bucket/tb`,
        'AWS::S3Tables::TableBucket',
        {},
        ctx
      ),
  },
  {
    wrap: 'Failed to delete S3 Tables Namespace Ns',
    run: () =>
      new S3TablesProvider().delete(
        'Ns',
        `arn:aws:s3tables:us-east-1:${ACCOUNT}:bucket/tb|ns`,
        'AWS::S3Tables::Namespace',
        {},
        ctx
      ),
  },
  {
    wrap: 'Failed to delete S3 Tables Table Tt',
    run: () =>
      new S3TablesProvider().delete(
        'Tt',
        `arn:aws:s3tables:us-east-1:${ACCOUNT}:bucket/tb|ns|t`,
        'AWS::S3Tables::Table',
        {},
        ctx
      ),
  },
  {
    wrap: 'Failed to delete S3 bucket B',
    run: () => new S3BucketProvider().delete('B', 'bkt', 'AWS::S3::Bucket', {}, ctx),
  },
];

const isDelete = (c: Case): boolean => /^Failed to delete /.test(c.wrap);
const deleteCases = [...wrapCases.filter(isDelete), ...notGoneOnlyCases];

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  waitUpdated.mockReset();
  waitActive.mockReset();
  waitUpdated.mockResolvedValue({});
  waitActive.mockResolvedValue({});
});

describe('tail-e thrown wraps withhold AWS text (#2319)', () => {
  it.each(wrapCases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    const rejection = denied();
    reject(c, rejection);

    const failure = await caught(c.run());

    // Positive control: the fake error carried the identity this test withholds.
    expect(rejection.message).toContain(`${ACCOUNT}:assumed-role`);
    expect(failure.message.startsWith(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`)).toBe(true);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(failure.message).not.toContain('not authorized');
    expect(failure.cause).toBe(rejection);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(lines(debug).some((l) => l.startsWith(`${c.wrap}: ${mask(DENIED)}`))).toBe(true);
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });

  // The class itself is AWS-authored text: `mask(failure.summary)` is what keeps
  // a secret spelled inside it out of the thrown (persisted) message.
  it.each([...wrapCases, ...notGoneOnlyCases])('$wrap: a secret spelled in the class is masked', async (c) => {
    reject(
      c,
      Object.assign(new Error('denied'), {
        name: 'Denieds3cr3tException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: Denied***Exception. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(wrapCases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    reject(c, new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(wrapCases)('$wrap: a cdkd-authored failure the mask leaves alone is not stamped', async (c) => {
    reject(c, new Error('socket hang up'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each(wrapCases)('$wrap: a non-Error throw is withheld', async (c) => {
    reject(c, 'raw s3cr3t value');

    const failure = await caught(c.run());

    expect(failure.message).toContain(
      `${c.wrap}: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
  });

  it('covers every delete wrap', () => {
    expect(deleteCases).toHaveLength(21);
  });

  it.each(deleteCases)('$wrap: a foreign NotFound is named and marked not gone', async (c) => {
    reject(
      c,
      Object.assign(new Error(`Key arn:aws:kms:us-east-1:${ACCOUNT}:key/k is pending deletion`), {
        name: 'KMSNotFoundException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: KMSNotFoundException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(isMarkedNotGone(failure)).toBe(true);
  });

  // `delete()` runs on no masked view, so only the delete's own masker keeps a
  // secret out of the --verbose line (go-to-k/cdkd#2319).
  it('Failed to delete S3 bucket B: the debug line goes through the delete masker', async () => {
    mockSend.mockRejectedValue(denied());

    await caught(new S3BucketProvider().delete('B', 'bkt', 'AWS::S3::Bucket', {}, ctx));

    expect(lines(debug)).toContain(`Failed to delete S3 bucket B (bkt): ${mask(DENIED)}`);
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });

  it.each(deleteCases)('$wrap: a failure that is not a NotFound is not marked', async (c) => {
    reject(c, denied());

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`);
    expect(isMarkedNotGone(failure)).toBe(false);
  });

  // A ConflictException matches no collision pattern by its class, so only the
  // restatement keeps a create-first replacement recognising a taken name.
  const collisionCases: Array<Case & { logicalId: string }> = [
    ...wrapCases
      .filter((c) => /^Failed to create /.test(c.wrap))
      .map((c) => ({ ...c, logicalId: /(\w+)$/.exec(c.wrap)![1]! })),
    {
      wrap: 'Failed to create Glue Database Db',
      logicalId: 'Db',
      run: () =>
        new GlueProvider().create('Db', 'AWS::Glue::Database', { DatabaseInput: { Name: 'db' } }, ctx),
    },
    {
      wrap: 'Failed to create S3 bucket B',
      logicalId: 'B',
      // A generated name: an explicit one takes the adopt-refusal preflight.
      run: () => new S3BucketProvider().create('B', 'AWS::S3::Bucket', {}, ctx),
      prime: only('CreateBucketCommand'),
    },
  ];

  it.each(collisionCases)('$wrap: restates an "already exists" the class does not carry', async (c) => {
    reject(c, awsSdkError(`A resource named x already exists in ${ACCOUNT}.`, 'ConflictException'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(
      `${c.wrap}: ConflictException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain(ACCOUNT);
    expect(isNameCollisionErrorFrom(failure, c.logicalId)).toBe(true);
  });
});

describe('a post-create step failure is not restated as this resource\'s collision (#2319)', () => {
  const conflict = (): Error =>
    awsSdkError(`A resource named x already exists in ${ACCOUNT}.`, 'ConflictException');

  it('Lambda function: the post-create refusal and its warns name the class only', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateFunctionCommand') {
        return Promise.resolve({ FunctionName: 'fn', FunctionArn: FN_ARN });
      }
      if (name === 'PutFunctionConcurrencyCommand') return Promise.reject(conflict());
      if (name === 'DeleteFunctionCommand') return Promise.reject(denied());
      return Promise.resolve({});
    });

    const failure = await caught(
      new LambdaFunctionProvider().create(
        'Fn',
        FN,
        { ...FN_PROPS, ReservedConcurrentExecutions: 3 },
        ctx
      )
    );

    const inner = failure.cause as Error;
    expect(inner.message).toBe(
      `Failed to set ReservedConcurrentExecutions on Lambda function Fn (function was deleted to maintain atomicity): ConflictException. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('already exists');
    expect(failure.message).not.toContain(ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(isNameCollisionErrorFrom(failure, 'Fn')).toBe(false);
    // The post-create warn and the cleanup line: the class, never AWS's text.
    expect(lines(warn)).toContain(
      `PutFunctionConcurrency failed for Fn: ConflictException. ${VERBOSE_POINTER} — deleting partially-created function to maintain atomicity`
    );
    expect(lines(error)).toContain(
      `Cleanup DeleteFunction failed for Fn after PutFunctionConcurrency failure — function may be orphaned: AccessDenied. ${VERBOSE_POINTER}`
    );
    expect([...lines(warn), ...lines(error)].join('\n')).not.toContain(ACCOUNT);
    // AWS's text reaches debug, masked.
    expect(lines(debug)).toContain(
      `Cleanup DeleteFunction failed for Fn after PutFunctionConcurrency failure — function may be orphaned: ${mask(DENIED)}`
    );
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });

  it('Lambda function: a secret spelled in the class is masked in the refusal, warn and cleanup line', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateFunctionCommand') {
        return Promise.resolve({ FunctionName: 'fn', FunctionArn: FN_ARN });
      }
      if (name === 'PutFunctionConcurrencyCommand' || name === 'DeleteFunctionCommand') {
        return Promise.reject(secretClass());
      }
      return Promise.resolve({});
    });

    const failure = await caught(
      new LambdaFunctionProvider().create('Fn', FN, { ...FN_PROPS, ReservedConcurrentExecutions: 3 }, ctx)
    );

    expect((failure.cause as Error).message).toContain(
      `(function was deleted to maintain atomicity): Denied***Exception. ${VERBOSE_POINTER}`
    );
    expect((failure.cause as Error).message).not.toContain('s3cr3t');
    expect(failure.message).not.toContain('s3cr3t');
    expect(lines(warn).some((l) => l.includes(`PutFunctionConcurrency failed for Fn: Denied***Exception.`))).toBe(true);
    expect(lines(error).some((l) => l.includes(`function may be orphaned: Denied***Exception.`))).toBe(true);
    expect([...lines(warn), ...lines(error)].join('\n')).not.toContain('s3cr3t');
  });

  it('Lambda function: a cdkd-authored cleanup failure keeps its text at error level', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateFunctionCommand') {
        return Promise.resolve({ FunctionName: 'fn', FunctionArn: FN_ARN });
      }
      if (name === 'PutFunctionConcurrencyCommand') return Promise.reject(new Error('socket hang up'));
      if (name === 'DeleteFunctionCommand') return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({});
    });

    const failure = await caught(
      new LambdaFunctionProvider().create('Fn', FN, { ...FN_PROPS, ReservedConcurrentExecutions: 3 }, ctx)
    );

    expect((failure.cause as Error).message).toContain(
      '(function was deleted to maintain atomicity): socket hang up'
    );
    expect(lines(warn)).toContain(
      'PutFunctionConcurrency failed for Fn: socket hang up — deleting partially-created function to maintain atomicity'
    );
    expect(lines(error)).toContain(
      'Cleanup DeleteFunction failed for Fn after PutFunctionConcurrency failure — function may be orphaned: ECONNRESET'
    );
  });

  it('S3 bucket: no restatement from a post-create wiring step', async () => {
    only('PutBucketVersioningCommand')(conflict());

    const failure = await caught(
      new S3BucketProvider().create(
        'B',
        'AWS::S3::Bucket',
        { VersioningConfiguration: { Status: 'Enabled' } },
        ctx
      )
    );

    expect(failure.message).toBe(`Failed to create S3 bucket B: ConflictException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(isNameCollisionErrorFrom(failure, 'B')).toBe(false);
  });

  it('AppSync GraphQL API: no restatement from the post-create step, class-only rollback warn', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateGraphqlApiCommand') {
        return Promise.resolve({ graphqlApi: { apiId: 'api-1', arn: 'arn:api-1' } });
      }
      if (name === 'PutGraphqlApiEnvironmentVariablesCommand') return Promise.reject(conflict());
      if (name === 'DeleteGraphqlApiCommand') return Promise.reject(denied());
      return Promise.resolve({});
    });

    const failure = await caught(
      new AppSyncProvider().create(
        'Api',
        'AWS::AppSync::GraphQLApi',
        { Name: 'api', AuthenticationType: 'API_KEY', EnvironmentVariables: { K: 'v' } },
        ctx
      )
    );

    expect(failure.message).toBe(
      `Failed to create GraphQL API Api: Failed to update AppSync GraphqlApi (env vars, post-create) Api: ConflictException. ${VERBOSE_POINTER}`
    );
    expect(isNameCollisionErrorFrom(failure, 'Api')).toBe(false);
    const rollback = lines(warn).find((l) => l.startsWith('Failed to roll back partially-created GraphQL API'));
    expect(rollback).toBe(
      `Failed to roll back partially-created GraphQL API api-1: AccessDenied. ${VERBOSE_POINTER}`
    );
    expect(lines(debug)).toContain(
      `Failed to roll back partially-created GraphQL API api-1: ${mask(DENIED)}`
    );
  });

  it('AppSync GraphQL API: a secret spelled in the class is masked in the rollback warn', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateGraphqlApiCommand') {
        return Promise.resolve({ graphqlApi: { apiId: 'api-1', arn: 'arn:api-1' } });
      }
      if (name === 'PutGraphqlApiEnvironmentVariablesCommand') return Promise.reject(conflict());
      if (name === 'DeleteGraphqlApiCommand') return Promise.reject(secretClass());
      return Promise.resolve({});
    });

    await caught(
      new AppSyncProvider().create(
        'Api',
        'AWS::AppSync::GraphQLApi',
        { Name: 'api', AuthenticationType: 'API_KEY', EnvironmentVariables: { K: 'v' } },
        ctx
      )
    );

    const rollback = lines(warn).find((l) => l.startsWith('Failed to roll back partially-created GraphQL API'));
    expect(rollback).toBe(
      `Failed to roll back partially-created GraphQL API api-1: Denied***Exception. ${VERBOSE_POINTER}`
    );
    expect(lines(warn).join('\n')).not.toContain('s3cr3t');
  });

  it('AppSync GraphQL API: a cdkd-authored rollback failure keeps its text at warn', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateGraphqlApiCommand') {
        return Promise.resolve({ graphqlApi: { apiId: 'api-1', arn: 'arn:api-1' } });
      }
      if (name === 'PutGraphqlApiEnvironmentVariablesCommand') return Promise.reject(conflict());
      if (name === 'DeleteGraphqlApiCommand') return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({});
    });

    await caught(
      new AppSyncProvider().create(
        'Api',
        'AWS::AppSync::GraphQLApi',
        { Name: 'api', AuthenticationType: 'API_KEY', EnvironmentVariables: { K: 'v' } },
        ctx
      )
    );

    expect(lines(warn)).toContain(
      'Failed to roll back partially-created GraphQL API api-1: ECONNRESET'
    );
  });

  it('Cloud Map Service: the partial-create cleanup warn names the class only', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateServiceCommand') {
        return Promise.resolve({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'svc' } });
      }
      if (name === 'UpdateServiceAttributesCommand') return Promise.reject(conflict());
      if (name === 'DeleteServiceCommand') return Promise.reject(denied());
      return Promise.resolve({});
    });

    await caught(
      new ServiceDiscoveryProvider().create(
        'Svc',
        'AWS::ServiceDiscovery::Service',
        { Name: 'svc', NamespaceId: 'ns-1', ServiceAttributes: { team: 'cdkd' } },
        ctx
      )
    );

    const cleanup = lines(warn).find((l) =>
      l.startsWith('Failed to clean up partially-created ServiceDiscovery Service')
    );
    expect(cleanup).toContain(
      `after ServiceAttributes wiring failure: AccessDenied. ${VERBOSE_POINTER} Outside a rollback`
    );
    expect(cleanup).not.toContain(ACCOUNT);
    expect(lines(debug)).toContain(
      `Failed to clean up partially-created ServiceDiscovery Service Svc (srv-1) after ServiceAttributes wiring failure: ${mask(DENIED)}`
    );
  });

  it('Cloud Map Service: a secret spelled in the class is masked in the cleanup warn', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateServiceCommand') {
        return Promise.resolve({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'svc' } });
      }
      if (name === 'UpdateServiceAttributesCommand') return Promise.reject(conflict());
      if (name === 'DeleteServiceCommand') return Promise.reject(secretClass());
      return Promise.resolve({});
    });

    await caught(
      new ServiceDiscoveryProvider().create(
        'Svc',
        'AWS::ServiceDiscovery::Service',
        { Name: 'svc', NamespaceId: 'ns-1', ServiceAttributes: { team: 'cdkd' } },
        ctx
      )
    );

    const cleanup = lines(warn).find((l) =>
      l.startsWith('Failed to clean up partially-created ServiceDiscovery Service')
    );
    expect(cleanup).toContain(`wiring failure: Denied***Exception. ${VERBOSE_POINTER} Outside a rollback`);
    expect(lines(warn).join('\n')).not.toContain('s3cr3t');
  });

  it('Cloud Map Service: a cdkd-authored cleanup failure keeps its text at warn', async () => {
    mockSend.mockImplementation((command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateServiceCommand') {
        return Promise.resolve({ Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'svc' } });
      }
      if (name === 'UpdateServiceAttributesCommand') return Promise.reject(conflict());
      if (name === 'DeleteServiceCommand') return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({});
    });

    await caught(
      new ServiceDiscoveryProvider().create(
        'Svc',
        'AWS::ServiceDiscovery::Service',
        { Name: 'svc', NamespaceId: 'ns-1', ServiceAttributes: { team: 'cdkd' } },
        ctx
      )
    );

    expect(
      lines(warn).some((l) => l.includes('after ServiceAttributes wiring failure: ECONNRESET. Outside'))
    ).toBe(true);
  });
});
