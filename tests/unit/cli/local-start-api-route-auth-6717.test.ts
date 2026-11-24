import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { resetEmbedConfig } from 'cdk-local';

/**
 * go-to-k/cdkd#6717: the host side of go-to-k/cdk-local#1013. aws-cdk-lib's
 * `CognitoUserPoolsAuthorizer` emits `ProviderARNs: [{ Fn::GetAtt: [Pool, Arn] }]`;
 * with `--from-state` the handler must resolve that pool from the deployed
 * state before the routes reach the servers, and a REST method's
 * `ApiKeyRequired`, which the local server does not enforce, must be warned
 * per route at boot instead of being dropped silently. Drives the real
 * handler; `attachAuthorizers`, `resolveJwtAuthorizerIntrinsics` and
 * `warnUnenforcedRouteAuthSettings` are NOT mocked.
 */

const h = vi.hoisted(() => {
  const stack = {
    stackName: 'StackA',
    displayName: 'StackA',
    template: {
      Resources: {
        Pool: { Type: 'AWS::Cognito::UserPool', Properties: {} },
        Auth: {
          Type: 'AWS::ApiGateway::Authorizer',
          Properties: {
            Type: 'COGNITO_USER_POOLS',
            ProviderARNs: [{ 'Fn::GetAtt': ['Pool', 'Arn'] }],
          },
        },
        Method: {
          Type: 'AWS::ApiGateway::Method',
          Properties: {
            HttpMethod: 'GET',
            AuthorizationType: 'COGNITO_USER_POOLS',
            AuthorizerId: { Ref: 'Auth' },
            ApiKeyRequired: true,
          },
        },
      },
    },
    region: 'eu-west-1',
  };
  const route = {
    method: 'GET',
    pathPattern: '/secure',
    lambdaLogicalId: 'Fn',
    source: 'rest-v1',
    apiVersion: 'v1',
    stage: 'prod',
    declaredAt: 'StackA/Method',
    apiLogicalId: 'Api',
  };
  const bundle = {
    state: {
      resources: {
        Pool: {
          physicalId: 'eu-west-1_AbC123',
          resourceType: 'AWS::Cognito::UserPool',
          properties: {},
        },
      },
    },
    region: 'eu-west-1',
  };
  const wsApi = {
    apiLogicalId: 'WsApi',
    apiStackName: 'StackA',
    stage: 'dev',
    declaredAt: 'StackA/WsApi',
    routes: [],
  };
  const group = { serverKey: 'StackA:Api', displayName: 'Api', routes: [{ route }] };
  const httpSpec = { kind: 'image', lambda: { timeoutSec: 40 }, env: {} as Record<string, string> };
  const wsSpec = { kind: 'image', lambda: { timeoutSec: 1 }, env: {} as Record<string, string>, extraHosts: undefined as unknown };
  const httpSpecs = new Map<string, unknown>([['StackA:Fn', httpSpec]]);
  const wsSpecs = new Map<string, unknown>([['StackA:WsFn', wsSpec]]);
  const allSpecs = new Map<string, unknown>([
    ['StackA:Fn', httpSpec],
    ['StackA:WsFn', wsSpec],
  ]);
  return {
    stack,
    route,
    bundle,
    wsApi,
    group,
    httpSpecs,
    wsSpecs,
    allSpecs,
    groupedRoutes: [] as unknown[],
    prewarmCaches: [] as unknown[],
    poolCalls: [] as Array<{ specs: unknown; opts: unknown }>,
    routeTables: [] as unknown[],
    loaders: [] as unknown[],
    startCalls: [] as Array<Record<string, unknown>>,
    started: [] as Array<{ close: ReturnType<typeof vi.fn>; port: number }>,
    pools: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
    attached: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  };
});

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
  pullImage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/local/local-role-arn.js', () => ({
  applyRoleArnForLocal: vi.fn(async () => undefined),
}));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApp: vi.fn(() => 'node app.js'),
}));
vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: class {
    synthesize = vi.fn(async () => ({ stacks: [h.stack], failedLookups: [] }));
  },
}));
vi.mock('../../../src/local/route-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discoverRoutes: vi.fn(() => [h.route]),
}));
vi.mock('../../../src/local/websocket-route-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discoverWebSocketApis: vi.fn(() => ({ apis: [h.wsApi], errors: [] })),
}));
vi.mock('../../../src/cli/commands/local-start-api/state.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // No `pseudoParameters`, as for a stack whose only state need is an
  // authorizer: the pool's region must come from `bundle.region`.
  loadStateForRoutedStacks: vi.fn(async () => new Map([['StackA', h.bundle]])),
}));
vi.mock('../../../src/local/api-server-grouping.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  groupRoutesByServer: vi.fn((routes: unknown) => {
    h.groupedRoutes.push(routes);
    return [h.group];
  }),
}));
vi.mock('../../../src/local/sigv4-verify.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // A fresh loader per call, so a second construction is told apart.
  defaultCredentialsLoader: vi.fn(() => {
    const loader = { tag: `loader-${h.loaders.length}` };
    h.loaders.push(loader);
    return loader;
  }),
}));
vi.mock('../../../src/local/docker-version.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeHostGatewaySupport: vi.fn(async () => ({
    supported: true,
    parsed: { major: 27, minor: 0 },
    rawVersion: '27.0.1',
  })),
}));
vi.mock('../../../src/local/container-pool.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createContainerPool: vi.fn((specs: unknown, opts: unknown) => {
    h.poolCalls.push({ specs, opts });
    const pool = { acquire: vi.fn(), release: vi.fn(), dispose: vi.fn(async () => undefined) };
    h.pools.push(pool);
    return pool;
  }),
}));
vi.mock('../../../src/local/http-server.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startApiServer: vi.fn(async (args: Record<string, unknown>) => {
    h.startCalls.push(args);
    const port = (args['port'] as number) || 7000 + h.started.length;
    const state = args['state'];
    const started = {
      server: {},
      host: args['host'] as string,
      port,
      scheme: 'http',
      close: vi.fn(async () => undefined),
      getServerState: () => state,
      setServerState: vi.fn(),
    };
    h.started.push(started);
    return started;
  }),
}));
vi.mock('../../../src/local/websocket-server.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachWebSocketServer: vi.fn(() => {
    const attached = { registry: {}, close: vi.fn(async () => undefined) };
    h.attached.push(attached);
    return attached;
  }),
}));
vi.mock('../../../src/cli/commands/local-start-api/startup-warnings.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prewarmJwks: vi.fn(async (_routes: unknown, jwksCache: unknown) => {
    h.prewarmCaches.push(jwksCache);
  }),
  warnVpcConfigLambdas: vi.fn(),
}));
vi.mock('../../../src/cli/commands/local-start-api/served-lambdas.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertServedLogicalIdsUnambiguous: vi.fn(),
  groupStackName: vi.fn(() => 'StackA'),
}));
vi.mock('../../../src/cli/commands/local-start-api/servers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachStageContextPerStack: vi.fn(() => []),
  buildCorsConfigByStack: vi.fn(() => new Map()),
  buildServedLambdaSpecs: vi.fn(async () => h.allSpecs),
  filterSpecsForGroup: vi.fn(() => h.httpSpecs),
  filterSpecsForWebSocketApi: vi.fn(() => h.wsSpecs),
  corsConfigForGroup: vi.fn(() => new Map()),
  printPerServerRouteTables: vi.fn((servers: unknown) => {
    h.routeTables.push(servers);
  }),
  warnUnsupportedRoutes: vi.fn(),
  warnUnsupportedWebSocketApis: vi.fn(),
  warnSsrfRiskyIntegrations: vi.fn(),
}));

const { createLocalStartApiCommand } = await import('../../../src/cli/commands/local-start-api.js');
const { createLocalCommand } = await import('../../../src/cli/commands/local-invoke.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const SIGNALS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
const writes: string[] = [];
const warnings: string[] = [];
/**
 * Replace `obj[key]` with `vi.fn(impl)` until `restoreStubs()`. A `vi.spyOn`
 * stub would fall back to the REAL method after `mockReset` (go-to-k/cdkd#6928),
 * while `vi.fn(impl)` keeps `impl`.
 */
const stubRestores: Array<() => void> = [];
function stubMethod<T extends object>(obj: T, key: keyof T & string, impl: (...args: never[]) => unknown) {
  const own = Object.getOwnPropertyDescriptor(obj, key);
  const stub = vi.fn(impl as (...args: unknown[]) => unknown);
  Object.defineProperty(obj, key, { value: stub, configurable: true, writable: true, enumerable: own?.enumerable ?? false });
  stubRestores.push(() => {
    if (own) Object.defineProperty(obj, key, own);
    else delete (obj as Record<string, unknown>)[key];
  });
  return stub;
}
function restoreStubs(): void {
  while (stubRestores.length > 0) stubRestores.pop()!();
}
let exitSpy: ReturnType<typeof stubMethod>;
let onSpy: ReturnType<typeof stubMethod>;
let writeSpy: ReturnType<typeof stubMethod>;
let warnSpy: ReturnType<typeof stubMethod>;

beforeAll(async () => {
  // Installs cdkd's embed config, whose logger forwards cdk-local's own
  // warnings (the ones under test) into cdkd's logger.
  createLocalCommand();
  warnSpy = stubMethod(getLogger(), 'warn', ((message: string) => {
    warnings.push(String(message));
  }) as never);
  const realOn = process.on.bind(process);
  onSpy = stubMethod(process, 'on', ((event: string, fn: () => void) => {
    if (SIGNALS.includes(event)) return process;
    return realOn(event, fn);
  }) as typeof process.on);
  exitSpy = stubMethod(process, 'exit', (() => undefined) as never);
  writeSpy = stubMethod(process.stdout, 'write', ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  // The handler never resolves: it blocks until a signal exits the process.
  void createLocalStartApiCommand().parseAsync(['node', 'cdkd', '--from-state']);
  await vi.waitFor(() => expect(writes.join('')).toContain('^C to stop'), { timeout: 4000 });
});

afterAll(() => {
  restoreStubs();
  resetEmbedConfig();
});

describe('local start-api --from-state: REST v1 CognitoUserPoolsAuthorizer (go-to-k/cdkd#6717)', () => {
  it('hands the servers a Cognito authorizer whose GetAtt pool ARN resolved from state', () => {
    const routes = h.groupedRoutes[0] as Array<{ authorizer?: Record<string, unknown> }>;
    expect(routes).toHaveLength(1);
    const authorizer = routes[0]!.authorizer!;
    expect(authorizer['kind']).toBe('cognito');
    expect(authorizer['userPoolId']).toBe('eu-west-1_AbC123');
    expect(authorizer['region']).toBe('eu-west-1');
    expect(authorizer['pending']).toBeUndefined();
  });

  it("warns at boot that the route's ApiKeyRequired is not enforced", () => {
    const hits = warnings.filter((w) => w.includes('ApiKeyRequired is not enforced'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('StackA/Method');
    expect(hits[0]).toContain('cdkd local start-api');
  });

  it('warns nothing about the resolved pool', () => {
    expect(warnings.filter((w) => w.includes('ProviderARNs'))).toEqual([]);
  });
});
