/**
 * Issue #2080 (Plan C, API Gateway v2): `CreateApi`, `CreateIntegration` and
 * `CreateAuthorizer` mint their id and carry no idempotency token. A 5xx whose
 * request AWS completed used to be replayed -- inside one `send` by the SDK,
 * invisibly, or by the engine's retry -- minting a second resource no state
 * records. The create now goes through a client that refuses the SDK's 5xx
 * retry, and the engine's next attempt REPORTS the candidates first.
 * Detection only: nothing is adopted and nothing is deleted.
 *
 * The fakes count RESOURCES, not calls (acceptance item 2), and every retry
 * advances the clock (acceptance item 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, sentVia, baseStrategy, ctorArgs, regionFails } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** How many upcoming `config.region()` reads reject, across every client. */
  regionFails: { remaining: 0 },
  /** Every `ApiGatewayV2Client` constructor's options, in order. */
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
}));

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-apigatewayv2')>();
  return {
    ...actual,
    ApiGatewayV2Client: vi.fn().mockImplementation((options: { region?: unknown }) => {
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>();
  return {
    ...actual,
    getAccountInfo: vi.fn().mockResolvedValue({
      accountId: '123456789012',
      region: 'us-east-1',
      fabricated: false,
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
  ApiGatewayV2Provider,
  resetApiGatewayV2CreateRetryStateForTests,
} from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal server error'), {
    name: 'InternalServerError',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/**
 * API Gateway's modeled throttle, identified BY NAME. On a 503 on purpose: with
 * a 4xx status the ambiguity check answers false at its status check, so only
 * the name exemption keeps this one from arming the latch.
 */
const throttled = (): Error =>
  Object.assign(new Error('Too Many Requests'), {
    name: 'TooManyRequestsException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: API Gateway did nothing, and the text is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error(
      'User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: apigateway:POST'
    ),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

interface FakeApi {
  ApiId: string;
  Name: string;
  ProtocolType: string;
  CreatedDate: Date;
}

interface FakeIntegration {
  IntegrationId: string;
  ApiId: string;
  IntegrationType: string;
  IntegrationUri?: string;
}

interface FakeAuthorizer {
  AuthorizerId: string;
  ApiId: string;
  Name: string;
  AuthorizerType: string;
}

/** A fake API Gateway v2. The arrays count RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeApiGatewayV2 {
  readonly apis: FakeApi[] = [];
  readonly integrations: FakeIntegration[] = [];
  readonly authorizers: FakeAuthorizer[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** The next create makes its resource, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Items per list page. */
  pageSize = 100;
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
      case 'CreateApiCommand': {
        const created: FakeApi = {
          ApiId: `api${this.nextId++}`,
          Name: input['Name'] as string,
          ProtocolType: input['ProtocolType'] as string,
          CreatedDate: new Date(Date.now()),
        };
        this.apis.push(created);
        this.loseResponse();
        return {
          ApiId: created.ApiId,
          ApiEndpoint: `https://${created.ApiId}.execute-api.us-east-1.amazonaws.com`,
        };
      }
      case 'CreateIntegrationCommand': {
        const created: FakeIntegration = {
          IntegrationId: `int${this.nextId++}`,
          ApiId: input['ApiId'] as string,
          IntegrationType: input['IntegrationType'] as string,
          ...(input['IntegrationUri'] !== undefined && {
            IntegrationUri: input['IntegrationUri'] as string,
          }),
        };
        this.integrations.push(created);
        this.loseResponse();
        return { IntegrationId: created.IntegrationId };
      }
      case 'CreateAuthorizerCommand': {
        const created: FakeAuthorizer = {
          AuthorizerId: `auth${this.nextId++}`,
          ApiId: input['ApiId'] as string,
          Name: input['Name'] as string,
          AuthorizerType: input['AuthorizerType'] as string,
        };
        this.authorizers.push(created);
        this.loseResponse();
        return { AuthorizerId: created.AuthorizerId };
      }
      case 'GetApisCommand':
        return this.page(this.apis, input['NextToken']);
      case 'GetIntegrationsCommand':
        return this.page(
          this.integrations.filter((i) => i.ApiId === input['ApiId']),
          input['NextToken']
        );
      case 'GetAuthorizersCommand':
        return this.page(
          this.authorizers.filter((a) => a.ApiId === input['ApiId']),
          input['NextToken']
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

  private page<T>(all: T[], token: unknown): { Items: T[]; NextToken?: string } {
    this.onList?.();
    const start = token === undefined ? 0 : Number(token);
    const end = start + this.pageSize;
    return {
      Items: all.slice(start, end).map((a) => ({ ...a })),
      ...(end < all.length && { NextToken: String(end) }),
    };
  }

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const API_PROPS = { Name: 'orders-http', ProtocolType: 'HTTP' };
const INT_PROPS = {
  ApiId: 'httpapi1',
  IntegrationType: 'AWS_PROXY',
  IntegrationUri: 'arn:aws:lambda:us-east-1:123456789012:function:orders',
  PayloadFormatVersion: '2.0',
};
const AUTH_PROPS = {
  ApiId: 'httpapi1',
  AuthorizerType: 'JWT',
  Name: 'jwt',
  IdentitySource: ['$request.header.Authorization'],
  JwtConfiguration: { Audience: ['a'], Issuer: 'https://issuer.example.com' },
};

describe('ApiGatewayV2Provider tokenless create retry safety (issue #2080, detection only)', () => {
  let provider: ApiGatewayV2Provider;
  let aws: FakeApiGatewayV2;
  let savedRegion: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetApiGatewayV2CreateRetryStateForTests();
    aws = new FakeApiGatewayV2();
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
    provider = new ApiGatewayV2Provider();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  const createWithRetry = (type: string, props: Record<string, unknown>, logicalId = 'Res') =>
    withRetry(() => provider.create(logicalId, type, props), logicalId, {
      sleep: advancingSleep,
    });

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportFor = (action: string): string | undefined =>
    warnLines().find((l) => l.includes(`earlier ${action} attempt`));

  describe('CreateApi (CreatedDate: windowed, delete command after the read command)', () => {
    it('names the API a lost response created, with a read then a conditional delete command', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::ApiGatewayV2::Api', API_PROPS);

      expect(aws.apis.map((a) => a.ApiId)).toEqual(['api1', 'api2']);
      expect(result.physicalId).toBe('api2');
      expect(aws.calls).not.toContain('DeleteApiCommand');
      const line = reportFor('CreateApi')!;
      expect(line).toContain('api1');
      const read = line.indexOf('aws apigatewayv2 get-api --api-id api1 --region eu-west-3');
      const remove = line.indexOf('aws apigatewayv2 delete-api --api-id api1 --region eu-west-3');
      expect(read).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(read);
      expect(line).toContain('does not adopt or delete');
      expect(line).toContain('Only after confirming');
      // The shared report's defaults: the service and the remove verb.
      expect(line).toContain('API Gateway may have created');
      expect(line).toContain('delete it:');
    });

    it('does not report an API created before the window, recorded, of another name or protocol', async () => {
      const earlier = await provider.create('Other', 'AWS::ApiGatewayV2::Api', API_PROPS);
      aws.apis.push(
        {
          ApiId: 'older',
          Name: 'orders-http',
          ProtocolType: 'HTTP',
          CreatedDate: new Date(Date.now() - 60_000),
        },
        { ApiId: 'othername', Name: 'x', ProtocolType: 'HTTP', CreatedDate: new Date(Date.now()) },
        {
          ApiId: 'ws',
          Name: 'orders-http',
          ProtocolType: 'WEBSOCKET',
          CreatedDate: new Date(Date.now()),
        }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Api', API_PROPS);

      const line = reportFor('CreateApi')!;
      expect(line).toContain('1 API(s) were created');
      for (const id of [earlier.physicalId, 'older', 'othername', 'ws']) {
        expect(line).not.toContain(` ${id}`);
      }
    });

    it('follows GetApis pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.apis.push(
        { ApiId: 'a', Name: 'a', ProtocolType: 'HTTP', CreatedDate: new Date(Date.now()) },
        { ApiId: 'b', Name: 'b', ProtocolType: 'HTTP', CreatedDate: new Date(Date.now()) }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Api', API_PROPS);

      expect(reportFor('CreateApi')).toContain('api1');
    });

    it('says the search was incomplete when the listing is cut at the page ceiling', async () => {
      aws.pageSize = 1;
      for (let i = 0; i < 25; i++) {
        aws.apis.push({
          ApiId: `x${i}`,
          Name: `o${i}`,
          ProtocolType: 'HTTP',
          CreatedDate: new Date(Date.now()),
        });
      }
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Api', API_PROPS);

      expect(warnLines().some((l) => l.includes('cut at 20 pages'))).toBe(true);
    });

    it('a report naming a candidate still says the listing was cut short', async () => {
      aws.pageSize = 1;
      aws.loseNextCreateResponse = transient500();
      // The orphan is the first item; 25 more arrive behind it, past the ceiling.
      aws.onList = () => {
        for (let i = 0; i < 25; i++) {
          aws.apis.push({
            ApiId: `x${i}`,
            Name: `o${i}`,
            ProtocolType: 'HTTP',
            CreatedDate: new Date(Date.now()),
          });
        }
        aws.onList = undefined;
      };

      await createWithRetry('AWS::ApiGatewayV2::Api', API_PROPS);

      const line = reportFor('CreateApi')!;
      expect(line).toContain('api1');
      expect(line).toContain('cut at 20 pages');
    });

    it('masks a short secret-derived API name as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();

      await withRetry(
        () =>
          provider.create(
            'Res',
            'AWS::ApiGatewayV2::Api',
            { ...API_PROPS, Name: 'zq' },
            { maskSecrets: (t) => (t === 'zq' ? '***' : t) }
          ),
        'Res',
        { sleep: advancingSleep }
      );

      const line = reportFor('CreateApi')!;
      expect(line).toContain('api1');
      expect(line).toContain('named ***');
      expect(line).not.toContain('named zq');
    });

    it('two ambiguous attempts in a row: the second report covers the FIRST attempt too', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(() => provider.create('Res', 'AWS::ApiGatewayV2::Api', API_PROPS), 'Res', {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      });

      const lines = warnLines().filter((l) => l.includes('earlier CreateApi attempt'));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('between 2026-09-30T23:59:55.000Z');
      expect(lines[1]).toContain('api1');
      expect(lines[1]).toContain('api2');
    });

    it('a failed GetApis warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('GetApisCommand', [propagationDenied()]);

      const result = await createWithRetry('AWS::ApiGatewayV2::Api', API_PROPS);

      expect(result.physicalId).toBe('api2');
      expect(warnLines().some((l) => l.includes('could not look for it (GetApis'))).toBe(true);
    });
  });

  describe('CreateIntegration (no creation date: read command only)', () => {
    it('names the integration a lost response created, and neither adopts nor deletes it', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::ApiGatewayV2::Integration', INT_PROPS);

      expect(aws.integrations.map((i) => i.IntegrationId)).toEqual(['int1', 'int2']);
      expect(result.physicalId).toBe('int2');
      const line = reportFor('CreateIntegration')!;
      expect(line).toContain(
        'aws apigatewayv2 get-integration --api-id httpapi1 --integration-id int1 --region eu-west-3'
      );
      expect(line).not.toContain('delete-integration');
      // The shared report's default service name, on the undated arm too.
      expect(line).toContain('API Gateway may have created');
      expect(line).toContain('API Gateway reports no creation time');
    });

    it('does not report one recorded, of another type, URI or API', async () => {
      const earlier = await provider.create('Other', 'AWS::ApiGatewayV2::Integration', INT_PROPS);
      aws.integrations.push(
        { IntegrationId: 'othertype', ApiId: 'httpapi1', IntegrationType: 'HTTP_PROXY' },
        {
          IntegrationId: 'otheruri',
          ApiId: 'httpapi1',
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: 'arn:aws:lambda:us-east-1:123456789012:function:billing',
        },
        {
          IntegrationId: 'otherapi',
          ApiId: 'httpapi2',
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: INT_PROPS.IntegrationUri,
        }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Integration', INT_PROPS);

      const line = reportFor('CreateIntegration')!;
      expect(line).toContain('1 integration(s) match');
      for (const id of [earlier.physicalId, 'othertype', 'otheruri', 'otherapi']) {
        expect(line).not.toContain(` ${id}`);
      }
    });

    it('two ambiguous attempts in a row: the second report dates from the FIRST attempt', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(
        () => provider.create('Res', 'AWS::ApiGatewayV2::Integration', INT_PROPS),
        'Res',
        {
          sleep: (): Promise<void> => {
            vi.setSystemTime(Date.now() + 30_000);
            return Promise.resolve();
          },
        }
      );

      const lines = warnLines().filter((l) => l.includes('earlier CreateIntegration attempt'));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('(at 2026-09-30T23:59:55.000Z)');
    });

    it('follows GetIntegrations pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.integrations.push(
        { IntegrationId: 'a', ApiId: 'httpapi1', IntegrationType: 'MOCK' },
        { IntegrationId: 'b', ApiId: 'httpapi1', IntegrationType: 'MOCK' }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Integration', INT_PROPS);

      const line = reportFor('CreateIntegration')!;
      expect(line).toContain('--integration-id int1');
      expect(line).not.toContain('incomplete');
    });

    it('omits --region from the commands when the client region cannot be read', async () => {
      aws.loseNextCreateResponse = transient500();
      // CreateIntegration reads no region, so the one failing read is the report's.
      regionFails.remaining = 1;

      await createWithRetry('AWS::ApiGatewayV2::Integration', INT_PROPS);

      const line = reportFor('CreateIntegration')!;
      expect(line).toContain(
        'aws apigatewayv2 get-integration --api-id httpapi1 --integration-id int1.'
      );
      expect(regionFails.remaining).toBe(0);
    });

    it('matches an integration with no URI only to a create with none', async () => {
      aws.integrations.push({
        IntegrationId: 'withuri',
        ApiId: 'httpapi1',
        IntegrationType: 'MOCK',
        IntegrationUri: 'https://example.com',
      });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Integration', {
        ApiId: 'httpapi1',
        IntegrationType: 'MOCK',
      });

      const line = reportFor('CreateIntegration')!;
      expect(line).toContain('--integration-id int1');
      expect(line).not.toContain('withuri');
    });

    it('masks a secret-derived integration URI as a WHOLE value', async () => {
      const secretUri = 'https://hooks.example.com/zq';
      aws.loseNextCreateResponse = transient500();

      await withRetry(
        () =>
          provider.create(
            'Res',
            'AWS::ApiGatewayV2::Integration',
            { ApiId: 'httpapi1', IntegrationType: 'HTTP_PROXY', IntegrationUri: secretUri },
            { maskSecrets: (t) => (t === secretUri ? '***' : t) }
          ),
        'Res',
        { sleep: advancingSleep }
      );

      const line = reportFor('CreateIntegration')!;
      expect(line).toContain('int1');
      expect(line).toContain('to ***');
      expect(line).not.toContain(secretUri);
    });

    it('a recorded integration id under ANOTHER API does not hide a same-id candidate here', async () => {
      const earlier = await provider.create('Other', 'AWS::ApiGatewayV2::Integration', {
        ...INT_PROPS,
        ApiId: 'httpapi2',
      });
      expect(earlier.physicalId).toBe('int1');
      aws.integrations.push({
        IntegrationId: 'int1',
        ApiId: 'httpapi1',
        IntegrationType: INT_PROPS.IntegrationType,
        IntegrationUri: INT_PROPS.IntegrationUri,
      });
      aws.failNext.set('CreateIntegrationCommand', [transient500()]);

      await createWithRetry('AWS::ApiGatewayV2::Integration', INT_PROPS);

      expect(reportFor('CreateIntegration')).toContain('--integration-id int1');
    });

    it('a DEFINITE CreateIntegration failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('CreateIntegrationCommand', [propagationDenied()]);

      await createWithRetry('AWS::ApiGatewayV2::Integration', INT_PROPS);

      expect(aws.count('GetIntegrationsCommand')).toBe(0);
      expect(aws.integrations).toHaveLength(1);
    });
  });

  describe('CreateAuthorizer (no creation date: read command only)', () => {
    it('names the authorizer a lost response created, and neither adopts nor deletes it', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::ApiGatewayV2::Authorizer', AUTH_PROPS);

      expect(aws.authorizers.map((a) => a.AuthorizerId)).toEqual(['auth1', 'auth2']);
      expect(result.physicalId).toBe('auth2');
      const line = reportFor('CreateAuthorizer')!;
      expect(line).toContain(
        'aws apigatewayv2 get-authorizer --api-id httpapi1 --authorizer-id auth1 --region eu-west-3'
      );
      expect(line).not.toContain('delete-authorizer');
    });

    it('does not report one recorded, of another name or type', async () => {
      const earlier = await provider.create('Other', 'AWS::ApiGatewayV2::Authorizer', AUTH_PROPS);
      aws.authorizers.push(
        { AuthorizerId: 'othername', ApiId: 'httpapi1', Name: 'x', AuthorizerType: 'JWT' },
        { AuthorizerId: 'othertype', ApiId: 'httpapi1', Name: 'jwt', AuthorizerType: 'REQUEST' }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Authorizer', AUTH_PROPS);

      const line = reportFor('CreateAuthorizer')!;
      expect(line).toContain('1 authorizer(s) match');
      for (const id of [earlier.physicalId, 'othername', 'othertype']) {
        expect(line).not.toContain(` ${id}`);
      }
    });

    it('two ambiguous attempts in a row: the second report dates from the FIRST attempt', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(
        () => provider.create('Res', 'AWS::ApiGatewayV2::Authorizer', AUTH_PROPS),
        'Res',
        {
          sleep: (): Promise<void> => {
            vi.setSystemTime(Date.now() + 30_000);
            return Promise.resolve();
          },
        }
      );

      const lines = warnLines().filter((l) => l.includes('earlier CreateAuthorizer attempt'));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('(at 2026-09-30T23:59:55.000Z)');
    });

    it('follows GetAuthorizers pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.authorizers.push(
        { AuthorizerId: 'a', ApiId: 'httpapi1', Name: 'a', AuthorizerType: 'JWT' },
        { AuthorizerId: 'b', ApiId: 'httpapi1', Name: 'b', AuthorizerType: 'JWT' }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGatewayV2::Authorizer', AUTH_PROPS);

      const line = reportFor('CreateAuthorizer')!;
      expect(line).toContain('--authorizer-id auth1');
      expect(line).not.toContain('incomplete');
    });

    it('masks a short secret-derived authorizer name as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();

      await withRetry(
        () =>
          provider.create(
            'Res',
            'AWS::ApiGatewayV2::Authorizer',
            { ...AUTH_PROPS, Name: 'zq' },
            { maskSecrets: (t) => (t === 'zq' ? '***' : t) }
          ),
        'Res',
        { sleep: advancingSleep }
      );

      const line = reportFor('CreateAuthorizer')!;
      expect(line).toContain('auth1');
      expect(line).toContain('named ***');
      expect(line).not.toContain('named zq');
    });

    it('a throttled CreateAuthorizer triggers no lookup', async () => {
      aws.failNext.set('CreateAuthorizerCommand', [throttled()]);

      await createWithRetry('AWS::ApiGatewayV2::Authorizer', AUTH_PROPS);

      expect(aws.count('GetAuthorizersCommand')).toBe(0);
      expect(aws.authorizers).toHaveLength(1);
    });
  });

  it('builds the create client in the stack region, like the shared client', async () => {
    await provider.create('Res', 'AWS::ApiGatewayV2::Api', API_PROPS);

    // The mock's region() echoes the constructor's `region`, else the SDK-like
    // fallback `us-east-1`: only a client built WITH the stack region says eu-west-3.
    const createConfig = sentVia.find(([name]) => name === 'CreateApiCommand')![1];
    expect(await createConfig.region()).toBe('eu-west-3');
    expect(ctorArgs.map((o) => o.region)).toEqual(['eu-west-3', 'eu-west-3']);
  });

  it('two creates build ONE create client', async () => {
    await Promise.all([
      provider.create('A', 'AWS::ApiGatewayV2::Api', API_PROPS),
      provider.create('I', 'AWS::ApiGatewayV2::Integration', INT_PROPS),
    ]);

    // The shared client and one create client.
    expect(ctorArgs).toHaveLength(2);
  });

  it.each([
    ['CreateApiCommand', 'GetApisCommand', 'AWS::ApiGatewayV2::Api', API_PROPS],
    [
      'CreateIntegrationCommand',
      'GetIntegrationsCommand',
      'AWS::ApiGatewayV2::Integration',
      INT_PROPS,
    ],
    [
      'CreateAuthorizerCommand',
      'GetAuthorizersCommand',
      'AWS::ApiGatewayV2::Authorizer',
      AUTH_PROPS,
    ],
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
});
