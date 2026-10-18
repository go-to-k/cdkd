import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The S3 Tables, API Gateway and API Gateway v2 wraps must not write the
 * CALLER'S IDENTITY into a persisted store (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and these services word an
 * `AccessDeniedException` as `User: arn:aws:sts::<account>:assumed-role/<role>/
 * <session> is not authorized to perform: ...`. Each AWS fixture here carries
 * that wording and the smithy service markers `describeAwsFailure` keys on.
 * Both polarities: an AWS-authored failure is named by its class with `cause`
 * kept (so the retry classifiers still read it), and a cdkd-authored or
 * transport failure keeps its own text.
 */

const { mockSend, debugSpy, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    debugSpy: vi.fn(),
    fakeClient: () => ({
      send: (command: unknown) => send(command),
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () => Promise.resolve(undefined),
      },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
  };
});

vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3tables')>();
  return { ...actual, S3TablesClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('@aws-sdk/client-api-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-api-gateway')>();
  return { ...actual, APIGatewayClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-apigatewayv2')>();
  return { ...actual, ApiGatewayV2Client: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ apiGateway: fakeClient() }),
}));
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

import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
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

/** An `AccessDeniedException` as these services word it, AWS-authored. */
function accessDenied(action: string): Error {
  return Object.assign(
    new Error(
      `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
        `arn:aws:${action.split(':')[0]}:us-east-1:${CALLER_ACCOUNT}:x because no ` +
        `identity-based policy allows the ${action} action`
    ),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

/** A `ConflictException` naming an occupied name, AWS-authored. */
function conflict(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'ConflictException',
    $fault: 'client',
    $metadata: { httpStatusCode: 409 },
  });
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Fail `failing` with `error`; every other command answers `answers[name]` or `{}`. */
function failOn(failing: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name === failing) throw error;
    return answers[name] ?? {};
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

type Site = {
  site: string;
  command: string;
  /** The IAM action the denial names, the site's own. */
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  run: () => Promise<unknown>;
};

const TABLE_BUCKET_ARN = 'arn:aws:s3tables:us-east-1:111122223333:bucket/b1';
const TABLE_ID = `${TABLE_BUCKET_ARN}|ns1|t1`;
const TABLE_PROPS = { TableBucketARN: TABLE_BUCKET_ARN, Namespace: 'ns1', TableName: 't1' };

function sites(): Site[] {
  const s3t = new S3TablesProvider();
  const v1 = new ApiGatewayProvider();
  const v2 = new ApiGatewayV2Provider();
  return [
    {
      site: 'S3 Tables create TableBucket',
      command: 'CreateTableBucketCommand',
      action: 's3tables:CreateTableBucket',
      prefix: 'Failed to create S3 Table Bucket Res: ',
      run: () => s3t.create('Res', 'AWS::S3Tables::TableBucket', { TableBucketName: 'b1' }),
    },
    {
      site: 'S3 Tables delete TableBucket',
      command: 'DeleteTableBucketCommand',
      action: 's3tables:DeleteTableBucket',
      prefix: 'Failed to delete S3 Table Bucket Res: ',
      answers: { ListNamespacesCommand: { namespaces: [] } },
      run: () => s3t.delete('Res', TABLE_BUCKET_ARN, 'AWS::S3Tables::TableBucket'),
    },
    {
      site: 'S3 Tables update TableBucket tag diff',
      command: 'TagResourceCommand',
      action: 's3tables:TagResource',
      prefix: `applyTableBucketTagsDiff: TagResource failed for ${TABLE_BUCKET_ARN} (keys: k): `,
      run: () =>
        s3t.update(
          'Res',
          TABLE_BUCKET_ARN,
          'AWS::S3Tables::TableBucket',
          { TableBucketName: 'b1', Tags: [{ Key: 'k', Value: 'v2' }] },
          { TableBucketName: 'b1', Tags: [{ Key: 'k', Value: 'v1' }] }
        ),
    },
    {
      site: 'API Gateway delete Stage',
      command: 'DeleteStageCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway Stage Res: ',
      run: () => v1.delete('Res', 'prod', 'AWS::ApiGateway::Stage', { RestApiId: 'api-1' }),
    },
    {
      site: 'API Gateway delete Account',
      command: 'UpdateAccountCommand',
      action: 'apigateway:PATCH',
      prefix: 'Failed to delete API Gateway Account Res: ',
      run: () => v1.delete('Res', 'acct', 'AWS::ApiGateway::Account'),
    },
    {
      site: 'API Gateway create Authorizer',
      command: 'CreateAuthorizerCommand',
      action: 'apigateway:POST',
      prefix: 'Failed to create API Gateway Authorizer Res: ',
      run: () =>
        v1.create('Res', 'AWS::ApiGateway::Authorizer', {
          RestApiId: 'api-1',
          Name: 'auth',
          Type: 'TOKEN',
          AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/x',
        }),
    },
    {
      site: 'API Gateway v2 delete Api',
      command: 'DeleteApiCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway V2 Api Res: ',
      run: () => v2.delete('Res', 'api-1', 'AWS::ApiGatewayV2::Api'),
    },
    {
      site: 'API Gateway v2 create Api',
      command: 'CreateApiCommand',
      action: 'apigateway:POST',
      prefix: 'Failed to create API Gateway V2 Api Res: ',
      run: () =>
        v2.create('Res', 'AWS::ApiGatewayV2::Api', { Name: 'api', ProtocolType: 'HTTP' }),
    },
    {
      site: 'S3 Tables update outer wrap (GetTable fails resolving the tag-diff ARN)',
      command: 'GetTableCommand',
      action: 's3tables:GetTable',
      prefix: 'Failed to update S3 Tables resource Res: ',
      run: () =>
        s3t.update(
          'Res',
          TABLE_ID,
          'AWS::S3Tables::Table',
          { ...TABLE_PROPS, Tags: [{ Key: 'k', Value: 'v2' }] },
          { ...TABLE_PROPS, Tags: [{ Key: 'k', Value: 'v1' }] }
        ),
    },
    {
      site: 'S3 Tables create Namespace',
      command: 'CreateNamespaceCommand',
      action: 's3tables:CreateNamespace',
      prefix: 'Failed to create S3 Tables Namespace Res: ',
      run: () =>
        s3t.create('Res', 'AWS::S3Tables::Namespace', {
          TableBucketARN: TABLE_BUCKET_ARN,
          Namespace: 'ns1',
        }),
    },
    {
      site: 'S3 Tables delete Namespace',
      command: 'DeleteNamespaceCommand',
      action: 's3tables:DeleteNamespace',
      prefix: 'Failed to delete S3 Tables Namespace Res: ',
      run: () => s3t.delete('Res', `${TABLE_BUCKET_ARN}|ns1`, 'AWS::S3Tables::Namespace'),
    },
    {
      site: 'S3 Tables create Table',
      command: 'CreateTableCommand',
      action: 's3tables:CreateTable',
      prefix: 'Failed to create S3 Tables Table Res: ',
      run: () =>
        s3t.create('Res', 'AWS::S3Tables::Table', { ...TABLE_PROPS, OpenTableFormat: 'ICEBERG' }),
    },
    {
      site: 'S3 Tables resolve Table before delete (GetTable on a bare ARN)',
      command: 'GetTableCommand',
      action: 's3tables:GetTable',
      prefix: `Failed to resolve S3 Tables Table Res (${TABLE_BUCKET_ARN}/table/t1-id): `,
      run: () => s3t.delete('Res', `${TABLE_BUCKET_ARN}/table/t1-id`, 'AWS::S3Tables::Table'),
    },
    {
      site: 'S3 Tables delete Table',
      command: 'DeleteTableCommand',
      action: 's3tables:DeleteTable',
      prefix: 'Failed to delete S3 Tables Table Res: ',
      answers: {
        GetTableCommand: {
          tableARN: `${TABLE_BUCKET_ARN}/table/t1-id`,
          namespace: ['ns1'],
          name: 't1',
        },
      },
      run: () => s3t.delete('Res', `${TABLE_BUCKET_ARN}/table/t1-id`, 'AWS::S3Tables::Table'),
    },
    {
      site: 'API Gateway delete Authorizer',
      command: 'DeleteAuthorizerCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway Authorizer Res: ',
      run: () => v1.delete('Res', 'auth-1', 'AWS::ApiGateway::Authorizer', { RestApiId: 'api-1' }),
    },
    {
      site: 'API Gateway delete Deployment',
      command: 'DeleteDeploymentCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway Deployment Res: ',
      run: () => v1.delete('Res', 'dep-1', 'AWS::ApiGateway::Deployment', { RestApiId: 'api-1' }),
    },
    {
      site: 'API Gateway delete Method',
      command: 'DeleteMethodCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway Method Res: ',
      run: () => v1.delete('Res', 'api-1|res-1|GET', 'AWS::ApiGateway::Method'),
    },
    {
      site: 'API Gateway v2 delete Stage',
      command: 'DeleteStageCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway V2 Stage Res: ',
      run: () => v2.delete('Res', 'prod', 'AWS::ApiGatewayV2::Stage', { ApiId: 'api-1' }),
    },
    {
      site: 'API Gateway v2 delete Integration',
      command: 'DeleteIntegrationCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway V2 Integration Res: ',
      run: () =>
        v2.delete('Res', 'int-1', 'AWS::ApiGatewayV2::Integration', { ApiId: 'api-1' }),
    },
    {
      site: 'API Gateway v2 delete Route',
      command: 'DeleteRouteCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway V2 Route Res: ',
      run: () => v2.delete('Res', 'route-1', 'AWS::ApiGatewayV2::Route', { ApiId: 'api-1' }),
    },
    {
      site: 'API Gateway v2 delete Authorizer',
      command: 'DeleteAuthorizerCommand',
      action: 'apigateway:DELETE',
      prefix: 'Failed to delete API Gateway V2 Authorizer Res: ',
      run: () =>
        v2.delete('Res', 'auth-1', 'AWS::ApiGatewayV2::Authorizer', { ApiId: 'api-1' }),
    },
  ];
}

describe('S3 Tables / API Gateway thrown wraps keep the caller identity out (go-to-k/cdkd#2319)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
  });

  describe.each(sites())('$site', ({ command, action, prefix, answers, run }) => {
    it('names an AWS-authored failure by its class, keeps cause, and stays retryable', async () => {
      const original = accessDenied(action);
      failOn(command, original, answers);
      const failure = await thrown(run());

      // Non-vacuity: the rejection came from the site's own command.
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect(failure.message).toContain(`${prefix}AccessDeniedException. ${VERBOSE_POINTER}`);
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
      expect(debugged()).toContain(CALLER_ARN);
    });

    it('keeps a cdkd-authored or transport failure verbatim, unstamped', async () => {
      const original = new Error('connect ECONNREFUSED 10.0.0.1:443');
      failOn(command, original, answers);
      const failure = await thrown(run());

      expect(failure.message).toContain(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
      expect(failure.cause).toBe(original);
    });

    it('keeps a non-Error throw as text, unstamped', async () => {
      failOn(command, 'socket hang up', answers);
      const failure = await thrown(run());

      expect(failure.message).toContain(`${prefix}socket hang up`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });

  const TAG_DIFF_TARGETS = [
    { type: 'AWS::S3Tables::TableBucket', physicalId: TABLE_BUCKET_ARN, props: { TableBucketName: 'b1' } },
    {
      type: 'AWS::S3Tables::Table',
      physicalId: `${TABLE_BUCKET_ARN}|ns1|t1`,
      props: { TableBucketARN: TABLE_BUCKET_ARN, Namespace: 'ns1', TableName: 't1' },
    },
  ];
  it.each(
    TAG_DIFF_TARGETS.flatMap((t) =>
      ['TagResourceCommand', 'UntagResourceCommand'].map((command) => ({ ...t, command }))
    )
  )(
    'S3 Tables update() threads its masker to the $type $command tag-diff debug line',
    async ({ type, physicalId, props, command }) => {
      const SECRET = 's3tables-secret-tag-value';
      failOn(
        command,
        Object.assign(new Error(`Invalid tag value '${SECRET}'`), {
          name: 'BadRequestException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        }),
        { GetTableCommand: { tableARN: `${TABLE_BUCKET_ARN}/table/t1-id` } }
      );
      const failure = await thrown(
        new S3TablesProvider().update(
          'Res',
          physicalId,
          type,
          { ...props, Tags: [{ Key: 'k2', Value: 'v' }] },
          { ...props, Tags: [{ Key: 'k', Value: 'v' }] },
          { maskSecrets: (text: string) => text.split(SECRET).join('***') }
        )
      );
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(`BadRequestException. ${VERBOSE_POINTER}`);
      expect(debugged()).toContain("Invalid tag value '***'");
      expect(debugged()).not.toContain(SECRET);
    }
  );

  it.each(
    TAG_DIFF_TARGETS.flatMap((t) =>
      ['TagResourceCommand', 'UntagResourceCommand'].map((command) => ({ ...t, command }))
    )
  )(
    'S3 Tables $type $command tag-diff wrap keeps cause and stays retryable',
    async ({ type, physicalId, props, command }) => {
      const original = accessDenied(`s3tables:${command.replace(/Command$/, '')}`);
      failOn(command, original, {
        GetTableCommand: { tableARN: `${TABLE_BUCKET_ARN}/table/t1-id` },
      });
      const failure = await thrown(
        new S3TablesProvider().update(
          'Res',
          physicalId,
          type,
          { ...props, Tags: [{ Key: 'k2', Value: 'v' }] },
          { ...props, Tags: [{ Key: 'k', Value: 'v' }] }
        )
      );
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(`AccessDeniedException. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(failure.cause).toBe(original);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    }
  );

  it('S3 Tables create Table keeps the created-before-failure mark on the wrap', async () => {
    // CreateTable succeeded but returned no ARN: the cdkd-authored refusal is
    // wrapped, and the table it made must still be credited to the failure.
    failOn('NeverCalled', new Error('unused'), { CreateTableCommand: {} });
    const failure = await thrown(
      new S3TablesProvider().create('Res', 'AWS::S3Tables::Table', {
        ...TABLE_PROPS,
        OpenTableFormat: 'ICEBERG',
      })
    );
    expect(failure.message).toContain('CreateTable did not return a tableARN');
    expect(createdBeforeFailure(failure, 'Res', 'AWS::S3Tables::Table')).toBe(TABLE_ID);
  });

  it('API Gateway Account delete masks a secret AWS echoes back on the debug line', async () => {
    const SECRET = 'apigw-secret-role-value';
    failOn(
      'UpdateAccountCommand',
      Object.assign(new Error(`Invalid role ARN '${SECRET}'`), {
        name: 'BadRequestException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const failure = await thrown(
      new ApiGatewayProvider().delete('Res', 'acct', 'AWS::ApiGateway::Account', undefined, {
        maskSecrets: (text: string) => text.split(SECRET).join('***'),
      })
    );
    expect(failure.message).toContain(`BadRequestException. ${VERBOSE_POINTER}`);
    expect(debugged()).toContain("Invalid role ARN '***'");
    expect(debugged()).not.toContain(SECRET);
  });

  it('S3 Tables masks the redacted summary through the operation masker too', async () => {
    failOn(
      'CreateTableBucketCommand',
      Object.assign(new Error('denied'), {
        name: 'SecretNamedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const failure = await thrown(
      new S3TablesProvider().create(
        'Res',
        'AWS::S3Tables::TableBucket',
        { TableBucketName: 'b1' },
        { maskSecrets: (text: string) => text.split('SecretNamed').join('***') }
      )
    );
    expect(failure.message).toContain(`***Exception. ${VERBOSE_POINTER}`);
  });

  it('S3 Tables masks a secret AWS echoes back on the debug line', async () => {
    const SECRET = 's3tables-secret-tag-value';
    failOn(
      'CreateTableBucketCommand',
      Object.assign(new Error(`Invalid tag value '${SECRET}'`), {
        name: 'BadRequestException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const failure = await thrown(
      new S3TablesProvider().create(
        'Res',
        'AWS::S3Tables::TableBucket',
        { TableBucketName: 'b1' },
        { maskSecrets: (text: string) => text.split(SECRET).join('***') }
      )
    );
    expect(failure.message).toContain(`BadRequestException. ${VERBOSE_POINTER}`);
    expect(debugged()).toContain("Invalid tag value '***'");
    expect(debugged()).not.toContain(SECRET);
  });

  it('closes the redacted class as one sentence before the tag-diff remedy', async () => {
    failOn('UntagResourceCommand', accessDenied('s3tables:UntagResource'));
    const failure = await thrown(
      new S3TablesProvider().update(
        'Res',
        TABLE_BUCKET_ARN,
        'AWS::S3Tables::TableBucket',
        { TableBucketName: 'b1' },
        { TableBucketName: 'b1', Tags: [{ Key: 'k', Value: 'v1' }] }
      )
    );
    expect(failure.message).toContain(
      `AccessDeniedException. ${VERBOSE_POINTER} State has NOT been updated`
    );
  });

  describe('an occupied name is still credited as a name collision', () => {
    const cases = [
      {
        label: 'S3 Tables create TableBucket',
        command: 'CreateTableBucketCommand',
        error: conflict('The bucket that you tried to create already exists, and you own it.'),
        run: () =>
          new S3TablesProvider().create('Res', 'AWS::S3Tables::TableBucket', {
            TableBucketName: 'b1',
          }),
      },
      {
        label: 'API Gateway create Stage',
        command: 'CreateStageCommand',
        error: conflict('Stage already exists'),
        run: () =>
          new ApiGatewayProvider().create('Res', 'AWS::ApiGateway::Stage', {
            RestApiId: 'api-1',
            StageName: 'prod',
            DeploymentId: 'dep-1',
          }),
      },
      {
        label: 'API Gateway v2 create Stage',
        command: 'CreateStageCommand',
        error: conflict('Stage already exists'),
        run: () =>
          new ApiGatewayV2Provider().create('Res', 'AWS::ApiGatewayV2::Stage', {
            ApiId: 'api-1',
            StageName: 'prod',
          }),
      },
    ];

    it.each(cases)('$label', async ({ command, error, run }) => {
      failOn(command, error);
      const failure = await thrown(run());
      expect(failure.message).toContain(
        `ConflictException. ${VERBOSE_POINTER} AWS reports that it already exists.`
      );
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
    });

    it.each(cases)('$label: a ConflictException that is not an occupied name restates nothing', async ({ command, run }) => {
      failOn(command, conflict('A conflicting operation is in progress.'));
      const failure = await thrown(run());
      expect(failure.message).toContain(`ConflictException. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain('already exists');
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(false);
    });
  });
});
