import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The AppSync wraps must not write the CALLER'S IDENTITY into a persisted
 * store (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and AppSync (and S3, for the `*S3Location`
 * fetch) words an access denial as `User: arn:aws:sts::<account>:assumed-role/
 * <role>/<session> is not authorized to perform: ...`. Each AWS fixture here
 * carries that wording and the smithy service markers `describeAwsFailure`
 * keys on. Both polarities: an AWS-authored failure is named by its class with
 * `cause` kept (so the retry classifiers still read it), and a cdkd-authored or
 * transport failure keeps its own text.
 */

const { mockSend, mockS3Send, debugSpy, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    mockS3Send: vi.fn(),
    debugSpy: vi.fn(),
    fakeClient: (sender: (command: unknown) => unknown) => ({
      send: (command: unknown) => sender(command),
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () => Promise.resolve(undefined),
      },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
  };
});

vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => fakeClient((c) => mockSend(c))),
  };
});
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => fakeClient((c) => mockS3Send(c))),
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

import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** An access denial as AppSync / S3 word it, AWS-authored. */
function accessDenied(action: string, name = 'AccessDeniedException'): Error {
  return Object.assign(
    new Error(
      `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
        `arn:aws:appsync:us-east-1:${CALLER_ACCOUNT}:apis/api-1`
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

/** An AWS-authored client failure with the given class and text. */
function awsFailure(name: string, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Fail `failing` with `error`; every other command answers `answers[name]` or `{}`. */
function failOn(failing: string, error: unknown, answers: Record<string, unknown> = {}): void {
  const impl = async (command: unknown) => {
    const name = commandName(command);
    if (name === failing) throw error;
    return answers[name] ?? {};
  };
  mockSend.mockImplementation(impl);
  mockS3Send.mockImplementation(impl);
}

const sentCommands = (): string[] =>
  [...mockSend.mock.calls, ...mockS3Send.mock.calls].map(([c]) => commandName(c));

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

const debugged = (): string => debugSpy.mock.calls.map((args) => String(args[0])).join('\n');

const API_ARN = 'arn:aws:appsync:us-east-1:111122223333:apis/api-1';
const DS = { ApiId: 'api-1', Name: 'ds1', Type: 'NONE' };
const RESOLVER = {
  ApiId: 'api-1',
  TypeName: 'Query',
  FieldName: 'a',
  DataSourceName: 'ds1',
  Kind: 'UNIT',
  RequestMappingTemplate: '{}',
  ResponseMappingTemplate: '$util.toJson($ctx.result)',
};
const API = { Name: 'api', AuthenticationType: 'API_KEY' };

type Site = {
  site: string;
  command: string;
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  run: (p: AppSyncProvider) => Promise<unknown>;
};

const SITES: Site[] = [
  {
    site: 'create GraphQLApi',
    command: 'CreateGraphqlApiCommand',
    action: 'appsync:CreateGraphqlApi',
    prefix: 'Failed to create GraphQL API Res: ',
    run: (p) => p.create('Res', 'AWS::AppSync::GraphQLApi', API),
  },
  {
    site: 'delete GraphQLApi',
    command: 'DeleteGraphqlApiCommand',
    action: 'appsync:DeleteGraphqlApi',
    prefix: 'Failed to delete GraphQL API Res: ',
    run: (p) => p.delete('Res', 'api-1', 'AWS::AppSync::GraphQLApi'),
  },
  {
    site: 'create GraphQLSchema',
    command: 'StartSchemaCreationCommand',
    action: 'appsync:StartSchemaCreation',
    prefix: 'Failed to create GraphQL Schema Res: ',
    run: (p) =>
      p.create('Res', 'AWS::AppSync::GraphQLSchema', {
        ApiId: 'api-1',
        Definition: 'type Query { a: String }',
      }),
  },
  {
    site: 'create GraphQLSchema (DefinitionS3Location fetch)',
    command: 'GetObjectCommand',
    action: 's3:GetObject',
    prefix:
      'Failed to create GraphQL Schema Res: Failed to fetch DefinitionS3Location ' +
      's3://bkt/schema.graphql for Res: ',
    run: (p) =>
      p.create('Res', 'AWS::AppSync::GraphQLSchema', {
        ApiId: 'api-1',
        DefinitionS3Location: 's3://bkt/schema.graphql',
      }),
  },
  {
    site: 'create DataSource',
    command: 'CreateDataSourceCommand',
    action: 'appsync:CreateDataSource',
    prefix: 'Failed to create DataSource Res: ',
    run: (p) => p.create('Res', 'AWS::AppSync::DataSource', DS),
  },
  {
    site: 'delete DataSource',
    command: 'DeleteDataSourceCommand',
    action: 'appsync:DeleteDataSource',
    prefix: 'Failed to delete DataSource Res: ',
    run: (p) => p.delete('Res', 'api-1|ds1', 'AWS::AppSync::DataSource'),
  },
  {
    site: 'create Resolver',
    command: 'CreateResolverCommand',
    action: 'appsync:CreateResolver',
    prefix: 'Failed to create Resolver Res: ',
    run: (p) => p.create('Res', 'AWS::AppSync::Resolver', RESOLVER),
  },
  {
    site: 'delete Resolver',
    command: 'DeleteResolverCommand',
    action: 'appsync:DeleteResolver',
    prefix: 'Failed to delete Resolver Res: ',
    run: (p) => p.delete('Res', 'api-1|Query|a', 'AWS::AppSync::Resolver'),
  },
  {
    site: 'create ApiKey',
    command: 'CreateApiKeyCommand',
    action: 'appsync:CreateApiKey',
    prefix: 'Failed to create ApiKey Res: ',
    run: (p) => p.create('Res', 'AWS::AppSync::ApiKey', { ApiId: 'api-1' }),
  },
  {
    site: 'delete ApiKey',
    command: 'DeleteApiKeyCommand',
    action: 'appsync:DeleteApiKey',
    prefix: 'Failed to delete ApiKey Res: ',
    run: (p) => p.delete('Res', 'api-1|key-1', 'AWS::AppSync::ApiKey'),
  },
  {
    site: 'update DataSource',
    command: 'UpdateDataSourceCommand',
    action: 'appsync:UpdateDataSource',
    prefix: 'Failed to update AppSync DataSource Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1|ds1',
        'AWS::AppSync::DataSource',
        { ...DS, Description: 'new' },
        { ...DS, Description: 'old' }
      ),
  },
  {
    site: 'update Resolver',
    command: 'UpdateResolverCommand',
    action: 'appsync:UpdateResolver',
    prefix: 'Failed to update AppSync Resolver Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1|Query|a',
        'AWS::AppSync::Resolver',
        { ...RESOLVER, RequestMappingTemplate: '{"v":2}' },
        RESOLVER
      ),
  },
  {
    site: 'update ApiKey',
    command: 'UpdateApiKeyCommand',
    action: 'appsync:UpdateApiKey',
    prefix: 'Failed to update AppSync ApiKey Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1|key-1',
        'AWS::AppSync::ApiKey',
        { ApiId: 'api-1', Description: 'new' },
        { ApiId: 'api-1', Description: 'old' }
      ),
  },
  {
    site: 'create Resolver (RequestMappingTemplateS3Location fetch)',
    command: 'GetObjectCommand',
    action: 's3:GetObject',
    prefix:
      'Failed to create Resolver Res: Failed to fetch RequestMappingTemplateS3Location ' +
      's3://bkt/req.vtl for Res: ',
    run: (p) =>
      p.create('Res', 'AWS::AppSync::Resolver', {
        ...RESOLVER,
        RequestMappingTemplate: undefined,
        RequestMappingTemplateS3Location: 's3://bkt/req.vtl',
      }),
  },
  {
    site: 'update GraphQLApi',
    command: 'UpdateGraphqlApiCommand',
    action: 'appsync:UpdateGraphqlApi',
    prefix: 'Failed to update AppSync GraphqlApi Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1',
        'AWS::AppSync::GraphQLApi',
        { ...API, XrayEnabled: true },
        { ...API, XrayEnabled: false }
      ),
  },
  {
    site: 'update GraphQLApi environment variables',
    command: 'PutGraphqlApiEnvironmentVariablesCommand',
    action: 'appsync:PutGraphqlApiEnvironmentVariables',
    prefix: 'Failed to update AppSync GraphqlApi (env vars) Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1',
        'AWS::AppSync::GraphQLApi',
        { ...API, EnvironmentVariables: { K: 'v2' } },
        { ...API, EnvironmentVariables: { K: 'v1' } }
      ),
  },
  {
    site: 'update GraphQLApi tag diff ARN lookup',
    command: 'GetGraphqlApiCommand',
    action: 'appsync:GetGraphqlApi',
    prefix: 'Failed to update AppSync GraphqlApi Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1',
        'AWS::AppSync::GraphQLApi',
        { ...API, Tags: [{ Key: 'k', Value: 'v2' }] },
        { ...API, Tags: [{ Key: 'k', Value: 'v1' }] }
      ),
  },
  {
    site: 'update GraphQLApi untag',
    command: 'UntagResourceCommand',
    action: 'appsync:UntagResource',
    prefix: 'Failed to update AppSync GraphqlApi (untag) Res: ',
    answers: { GetGraphqlApiCommand: { graphqlApi: { apiId: 'api-1', arn: API_ARN } } },
    run: (p) =>
      p.update(
        'Res',
        'api-1',
        'AWS::AppSync::GraphQLApi',
        { ...API },
        { ...API, Tags: [{ Key: 'k', Value: 'v1' }] }
      ),
  },
  {
    site: 'update GraphQLSchema',
    command: 'StartSchemaCreationCommand',
    action: 'appsync:StartSchemaCreation',
    prefix: 'Failed to update AppSync GraphqlSchema Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1',
        'AWS::AppSync::GraphQLSchema',
        { ApiId: 'api-1', Definition: 'type Query { b: String }' },
        { ApiId: 'api-1', Definition: 'type Query { a: String }' }
      ),
  },
  {
    site: 'update GraphQLSchema (DefinitionS3Location fetch)',
    command: 'GetObjectCommand',
    action: 's3:GetObject',
    prefix: 'Failed to fetch DefinitionS3Location s3://bkt/v2.graphql for Res: ',
    run: (p) =>
      p.update(
        'Res',
        'api-1',
        'AWS::AppSync::GraphQLSchema',
        { ApiId: 'api-1', DefinitionS3Location: 's3://bkt/v2.graphql' },
        { ApiId: 'api-1', DefinitionS3Location: 's3://bkt/v1.graphql' }
      ),
  },
  {
    site: 'update GraphQLApi tag diff',
    command: 'TagResourceCommand',
    action: 'appsync:TagResource',
    prefix: 'Failed to update AppSync GraphqlApi (tag) Res: ',
    answers: { GetGraphqlApiCommand: { graphqlApi: { apiId: 'api-1', arn: API_ARN } } },
    run: (p) =>
      p.update(
        'Res',
        'api-1',
        'AWS::AppSync::GraphQLApi',
        { ...API, Tags: [{ Key: 'k', Value: 'v2' }] },
        { ...API, Tags: [{ Key: 'k', Value: 'v1' }] }
      ),
  },
];

beforeEach(() => {
  mockSend.mockReset();
  mockS3Send.mockReset();
  debugSpy.mockReset();
});

describe('AppSync thrown wraps withhold the caller identity (go-to-k/cdkd#2319)', () => {
  describe.each(SITES)('$site', ({ command, action, prefix, answers, run }) => {
    it('names an AWS-authored failure by its class, keeps cause, stays retryable', async () => {
      const original = accessDenied(
        action,
        action.startsWith('s3:') ? 'AccessDenied' : 'AccessDeniedException'
      );
      failOn(command, original, answers);
      const failure = await thrown(run(new AppSyncProvider()));

      // Non-vacuity: the rejection came from the site's own command.
      expect(sentCommands()).toContain(command);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect(failure.message).toContain(`${prefix}${original.name}. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(failure.message).not.toContain(CALLER_ROLE);
      expect(failure.message).not.toContain(CALLER_SESSION);

      // The AWS error stays on the chain (directly, or under the S3 fetch wrap).
      let link: unknown = failure;
      while (link instanceof Error && link !== original) link = link.cause;
      expect(link).toBe(original);

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
      const failure = await thrown(run(new AppSyncProvider()));

      expect(sentCommands()).toContain(command);
      expect(failure.message).toContain(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
    });

    it('keeps a non-Error throw as text, unstamped', async () => {
      failOn(command, 'socket hang up', answers);
      const failure = await thrown(run(new AppSyncProvider()));

      expect(failure.message).toContain(`${prefix}socket hang up`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });

  it('a delete of an already-gone resource still returns quietly (typed NotFound)', async () => {
    failOn(
      'DeleteDataSourceCommand',
      awsFailure('NotFoundException', 'No data source found with name ds1')
    );
    await expect(
      new AppSyncProvider().delete('Res', 'api-1|ds1', 'AWS::AppSync::DataSource')
    ).resolves.toBeUndefined();
  });

  it('a delete whose AWS text says "does not exist" returns before the wrap (message-based NotFound)', async () => {
    failOn(
      'DeleteResolverCommand',
      awsFailure('BadRequestException', 'Resolver Query.a does not exist')
    );
    await expect(
      new AppSyncProvider().delete('Res', 'api-1|Query|a', 'AWS::AppSync::Resolver')
    ).resolves.toBeUndefined();
    expect(sentCommands()).toContain('DeleteResolverCommand');
    expect(debugged()).not.toContain(VERBOSE_POINTER);
  });

  it('masks a secret AWS echoes back on the debug line, and the summary', async () => {
    const SECRET = 'appsync-secret-ds-name';
    failOn(
      'CreateDataSourceCommand',
      awsFailure('SecretBadRequestException', `Invalid data source name '${SECRET}'`)
    );
    const failure = await thrown(
      new AppSyncProvider().create(
        'Res',
        'AWS::AppSync::DataSource',
        { ...DS, Name: SECRET },
        { maskSecrets: (text: string) => text.split(SECRET).join('***').split('Secret').join('#') }
      )
    );
    expect(failure.message).toContain(`#BadRequestException. ${VERBOSE_POINTER}`);
    expect(debugged()).toContain("Invalid data source name '***'");
    expect(debugged()).not.toContain(SECRET);
  });

  describe('threads the operation masker to the debug line and the summary', () => {
    const SECRET = 'appsync-secret-echo';
    const mask = { maskSecrets: (text: string) => text.split(SECRET).join('***') };
    const cases = [
      {
        label: 'create GraphQLSchema',
        command: 'StartSchemaCreationCommand',
        run: (p: AppSyncProvider) =>
          p.create(
            'Res',
            'AWS::AppSync::GraphQLSchema',
            { ApiId: 'api-1', Definition: 'type Query { a: String }' },
            mask
          ),
      },
      {
        label: 'create GraphQLSchema DefinitionS3Location fetch',
        command: 'GetObjectCommand',
        run: (p: AppSyncProvider) =>
          p.create(
            'Res',
            'AWS::AppSync::GraphQLSchema',
            { ApiId: 'api-1', DefinitionS3Location: 's3://bkt/schema.graphql' },
            mask
          ),
      },
      {
        label: 'update GraphQLSchema DefinitionS3Location fetch',
        command: 'GetObjectCommand',
        run: (p: AppSyncProvider) =>
          p.update(
            'Res',
            'api-1',
            'AWS::AppSync::GraphQLSchema',
            { ApiId: 'api-1', DefinitionS3Location: 's3://bkt/v2.graphql' },
            { ApiId: 'api-1', DefinitionS3Location: 's3://bkt/v1.graphql' },
            mask
          ),
      },
      {
        label: 'create GraphQLApi',
        command: 'CreateGraphqlApiCommand',
        run: (p: AppSyncProvider) => p.create('Res', 'AWS::AppSync::GraphQLApi', API, mask),
      },
      {
        label: 'create Resolver',
        command: 'CreateResolverCommand',
        run: (p: AppSyncProvider) => p.create('Res', 'AWS::AppSync::Resolver', RESOLVER, mask),
      },
      {
        label: 'create ApiKey',
        command: 'CreateApiKeyCommand',
        run: (p: AppSyncProvider) =>
          p.create('Res', 'AWS::AppSync::ApiKey', { ApiId: 'api-1' }, mask),
      },
      {
        label: 'delete GraphQLApi',
        command: 'DeleteGraphqlApiCommand',
        run: (p: AppSyncProvider) =>
          p.delete('Res', 'api-1', 'AWS::AppSync::GraphQLApi', undefined, mask),
      },
      {
        label: 'delete DataSource',
        command: 'DeleteDataSourceCommand',
        run: (p: AppSyncProvider) =>
          p.delete('Res', 'api-1|ds1', 'AWS::AppSync::DataSource', undefined, mask),
      },
      {
        label: 'delete Resolver',
        command: 'DeleteResolverCommand',
        run: (p: AppSyncProvider) =>
          p.delete('Res', 'api-1|Query|a', 'AWS::AppSync::Resolver', undefined, mask),
      },
      {
        label: 'delete ApiKey',
        command: 'DeleteApiKeyCommand',
        run: (p: AppSyncProvider) =>
          p.delete('Res', 'api-1|key-1', 'AWS::AppSync::ApiKey', undefined, mask),
      },
      {
        label: 'update GraphQLSchema StartSchemaCreation',
        command: 'StartSchemaCreationCommand',
        run: (p: AppSyncProvider) =>
          p.update(
            'Res',
            'api-1',
            'AWS::AppSync::GraphQLSchema',
            { ApiId: 'api-1', Definition: 'type Query { b: String }' },
            { ApiId: 'api-1', Definition: 'type Query { a: String }' },
            mask
          ),
      },
      ...(
        [
          ['GetGraphqlApiCommand', { ...API, Tags: [{ Key: 'k', Value: 'v2' }] }],
          ['TagResourceCommand', { ...API, Tags: [{ Key: 'k', Value: 'v2' }] }],
          ['UntagResourceCommand', { ...API }],
          ['PutGraphqlApiEnvironmentVariablesCommand', { ...API, EnvironmentVariables: { K: 'v2' } }],
        ] as const
      ).map(([command, desired]) => ({
        label: `update GraphQLApi ${command}`,
        command,
        answers: { GetGraphqlApiCommand: { graphqlApi: { apiId: 'api-1', arn: API_ARN } } },
        run: (p: AppSyncProvider) =>
          p.update(
            'Res',
            'api-1',
            'AWS::AppSync::GraphQLApi',
            desired,
            { ...API, Tags: [{ Key: 'k', Value: 'v1' }], EnvironmentVariables: { K: 'v1' } },
            mask
          ),
      })),
      {
        label: 'create Resolver CodeS3Location fetch',
        command: 'GetObjectCommand',
        run: (p: AppSyncProvider) =>
          p.create(
            'Res',
            'AWS::AppSync::Resolver',
            {
              ...RESOLVER,
              RequestMappingTemplate: undefined,
              ResponseMappingTemplate: undefined,
              Runtime: { Name: 'APPSYNC_JS', RuntimeVersion: '1.0.0' },
              CodeS3Location: 's3://bkt/code.js',
            },
            mask
          ),
      },
      {
        label: 'update Resolver CodeS3Location fetch',
        command: 'GetObjectCommand',
        run: (p: AppSyncProvider) =>
          p.update(
            'Res',
            'api-1|Query|a',
            'AWS::AppSync::Resolver',
            {
              ...RESOLVER,
              RequestMappingTemplate: undefined,
              ResponseMappingTemplate: undefined,
              Runtime: { Name: 'APPSYNC_JS', RuntimeVersion: '1.0.0' },
              CodeS3Location: 's3://bkt/code-v2.js',
            },
            RESOLVER,
            mask
          ),
      },
    ];

    it.each(cases)('$label', async (c) => {
      const { command, run } = c;
      const answers = 'answers' in c ? c.answers : undefined;
      failOn(command, awsFailure(`${SECRET}Exception`, `Rejected value '${SECRET}'`), answers);
      const failure = await thrown(run(new AppSyncProvider()));
      expect(sentCommands()).toContain(command);
      expect(failure.message).toContain(`***Exception. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(SECRET);
      expect(debugged()).toContain("Rejected value '***'");
      expect(debugged()).not.toContain(SECRET);
    });
  });

  it('an update wrap masks a cdkd-authored failure and stamps it when the mask changed it', async () => {
    const SECRET = 'appsync-secret-value';
    const original = new Error(`unexpected reply naming ${SECRET}`);
    failOn('UpdateApiKeyCommand', original);
    const failure = await thrown(
      new AppSyncProvider().update(
        'Res',
        'api-1|key-1',
        'AWS::AppSync::ApiKey',
        { ApiId: 'api-1', Description: 'new' },
        { ApiId: 'api-1', Description: 'old' },
        { maskSecrets: (text: string) => text.split(SECRET).join('***') }
      )
    );
    expect(failure.message).toContain('unexpected reply naming ***');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(failure.cause).toBe(original);
  });

  it('a GraphQLApi whose rollback failed keeps the created-before-failure mark and stays terminal', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateGraphqlApiCommand') {
        return { graphqlApi: { apiId: 'api-9', arn: API_ARN } };
      }
      if (name === 'PutGraphqlApiEnvironmentVariablesCommand') {
        throw accessDenied('appsync:PutGraphqlApiEnvironmentVariables');
      }
      if (name === 'DeleteGraphqlApiCommand') {
        throw accessDenied('appsync:DeleteGraphqlApi');
      }
      return {};
    });
    const failure = await thrown(
      new AppSyncProvider().create('Res', 'AWS::AppSync::GraphQLApi', {
        ...API,
        EnvironmentVariables: { K: 'v' },
      })
    );
    expect(sentCommands()).toContain('DeleteGraphqlApiCommand');
    expect(failure.message).toContain(
      `Failed to create GraphQL API Res: Failed to update AppSync GraphqlApi (env vars, post-create) Res: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain(CALLER_ACCOUNT);
    expect(createdBeforeFailure(failure, 'Res', 'AWS::AppSync::GraphQLApi')).toBe('api-9');
    expect(isMarkedNonRetryable(failure)).toBe(true);
  });

  describe('an occupied name is still credited as a name collision', () => {
    const cases = [
      {
        label: 'create DataSource',
        command: 'CreateDataSourceCommand',
        run: (p: AppSyncProvider) => p.create('Res', 'AWS::AppSync::DataSource', DS),
      },
      {
        label: 'create Resolver',
        command: 'CreateResolverCommand',
        run: (p: AppSyncProvider) => p.create('Res', 'AWS::AppSync::Resolver', RESOLVER),
      },
    ];

    it.each(cases)('$label', async ({ command, run }) => {
      failOn(command, awsFailure('BadRequestException', 'Resource ds1 already exists.'));
      const failure = await thrown(run(new AppSyncProvider()));
      expect(failure.message).toContain(
        `BadRequestException. ${VERBOSE_POINTER} AWS reports that it already exists.`
      );
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
    });

    it.each(cases)('$label: a failure that is not an occupied name restates nothing', async ({ command, run }) => {
      failOn(command, awsFailure('BadRequestException', 'Invalid request.'));
      const failure = await thrown(run(new AppSyncProvider()));
      expect(failure.message).toContain(`BadRequestException. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain('already exists');
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(false);
    });
  });
});
