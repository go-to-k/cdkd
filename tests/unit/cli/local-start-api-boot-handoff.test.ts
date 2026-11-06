import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

/**
 * `localStartApiCommand` hands its initial-boot state to `bootServers`
 * (`local-start-api/boot-servers.ts`), which go-to-k/cdkd#5835 moved out of the
 * handler verbatim. Every value that crosses that call is pinned here by
 * driving the real handler through `createLocalStartApiCommand()` up to the
 * point where it blocks:
 *
 * - the JWKS cache the servers get is the one `prewarmJwks` already filled;
 * - the SigV4 credentials loader is the one the handler built just before, and
 *   reaches the HTTP server only (the WebSocket server never took one);
 * - the options are the folded ones (`--region US-WEST-2` reaches the server as
 *   `us-west-2`), with `--host`, `--port` and `--strict-sigv4`;
 * - `buildPool` carries `--per-lambda-concurrency` and tags each pool with its
 *   specs;
 * - the initial material's specs drive the RIE timeout and the WebSocket
 *   container env;
 * - one authorizer cache per stack, shared by both servers of that stack;
 * - the `servers` / `wsServers` arrays it returns are the ones the banners, the
 *   route tables and the ^C cleanup read.
 *
 * Dependencies that would reach Docker, AWS or the network are doubled at their
 * module boundary, as are the family helpers whose inputs need a real
 * template; nothing in `command.ts` or `boot-servers.ts` is.
 */

const h = vi.hoisted(() => {
  const stack = {
    stackName: 'StackA',
    displayName: 'StackA',
    template: { Resources: {} },
    region: 'us-west-2',
  };
  const route = { stackName: 'StackA', logicalId: 'Route', lambdaLogicalId: 'Fn' };
  const wsApi = {
    apiLogicalId: 'WsApi',
    apiStackName: 'StackA',
    stage: 'dev',
    declaredAt: 'StackA/WsApi',
    routes: [],
  };
  const group = { serverKey: 'StackA:HttpApi', displayName: 'HttpApi', routes: [{ route }] };
  const httpSpec = { kind: 'image', lambda: { timeoutSec: 40 }, env: {} as Record<string, string> };
  const wsSpec = {
    kind: 'image',
    lambda: { timeoutSec: 1 },
    env: {} as Record<string, string>,
    extraHosts: undefined as unknown,
  };
  const httpSpecs = new Map<string, unknown>([['StackA:Fn', httpSpec]]);
  const wsSpecs = new Map<string, unknown>([['StackA:WsFn', wsSpec]]);
  const allSpecs = new Map<string, unknown>([
    ['StackA:Fn', httpSpec],
    ['StackA:WsFn', wsSpec],
  ]);
  return {
    stack,
    route,
    wsApi,
    group,
    httpSpecs,
    wsSpecs,
    allSpecs,
    wsSpec,
    prewarmCaches: [] as unknown[],
    loaders: [] as unknown[],
    startCalls: [] as Array<Record<string, unknown>>,
    started: [] as Array<{ close: ReturnType<typeof vi.fn>; port: number }>,
    poolCalls: [] as Array<{ specs: unknown; opts: unknown }>,
    pools: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
    attached: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
    routeTables: [] as unknown[],
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
vi.mock('../../../src/local/authorizer-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachAuthorizers: vi.fn((_stacks: unknown, routes: unknown[]) =>
    routes.map((route) => ({ route, authorizer: undefined }))
  ),
}));
vi.mock('../../../src/local/api-server-grouping.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  groupRoutesByServer: vi.fn(() => [h.group]),
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

const SIGNALS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
const handlers = new Map<string, (...args: unknown[]) => void>();
const writes: string[] = [];
const savedEnv = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
let exitSpy: ReturnType<typeof vi.spyOn>;
let onSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  const realOn = process.on.bind(process);
  onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
    if (SIGNALS.includes(event)) {
      handlers.set(event, fn);
      return process;
    }
    return realOn(event, fn);
  }) as typeof process.on);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  // The handler never resolves: it blocks until a signal exits the process.
  void createLocalStartApiCommand().parseAsync([
    'node',
    'cdkd',
    '--region',
    'US-WEST-2',
    '--host',
    '0.0.0.0',
    '--port',
    '5000',
    '--strict-sigv4',
    '--per-lambda-concurrency',
    '3',
  ]);
  await vi.waitFor(() => expect(writes.join('')).toContain('^C to stop'), { timeout: 4000 });
});

afterAll(() => {
  onSpy.mockRestore();
  exitSpy.mockRestore();
  writeSpy.mockRestore();
  if (savedEnv.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedEnv.region;
  if (savedEnv.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = savedEnv.def;
});

describe('local start-api: the handler -> bootServers hand-off (go-to-k/cdkd#5835)', () => {
  it('boots one HTTP server and one WebSocket server', () => {
    expect(h.startCalls).toHaveLength(2);
    expect(h.startCalls[0]!['state']).toMatchObject({ routes: h.group.routes });
    expect(h.startCalls[1]!['state']).toMatchObject({ routes: [] });
  });

  it('hands the servers the JWKS cache prewarmJwks filled, not another one', () => {
    expect(h.prewarmCaches).toHaveLength(1);
    expect(h.startCalls[0]!['jwksCache']).toBe(h.prewarmCaches[0]);
    expect(h.startCalls[1]!['jwksCache']).toBe(h.prewarmCaches[0]);
  });

  it('hands the HTTP server the one SigV4 loader the handler built; the WebSocket server none', () => {
    expect(h.loaders).toHaveLength(1);
    expect(h.startCalls[0]!['sigV4CredentialsLoader']).toBe(h.loaders[0]);
    expect('sigV4CredentialsLoader' in h.startCalls[1]!).toBe(false);
  });

  it('shares one warned-at map, one foreign-id set and one per-stack authorizer cache', () => {
    const [http, ws] = h.startCalls as [Record<string, unknown>, Record<string, unknown>];
    expect(http['jwksWarnedAt']).toBeInstanceOf(Map);
    expect(ws['jwksWarnedAt']).toBe(http['jwksWarnedAt']);
    expect(http['sigV4WarnedForeignIds']).toBeInstanceOf(Set);
    expect(ws['sigV4WarnedForeignIds']).toBe(http['sigV4WarnedForeignIds']);
    expect(http['authorizerCache']).toBeDefined();
    expect(ws['authorizerCache']).toBe(http['authorizerCache']);
  });

  it('reads the folded options: region, host, ports, --strict-sigv4', () => {
    const [http, ws] = h.startCalls as [Record<string, unknown>, Record<string, unknown>];
    expect(http['defaultRegion']).toBe('us-west-2');
    expect(http['host']).toBe('0.0.0.0');
    expect(http['port']).toBe(5000);
    expect(ws['port']).toBe(5001);
    expect(http['sigV4Strict']).toBe(true);
    expect(ws['sigV4Strict']).toBe(true);
    expect('mtls' in http).toBe(false);
    expect(h.wsSpec.env['AWS_REGION']).toBe('us-west-2');
  });

  it("derives the RIE timeout from the initial material's specs", () => {
    // 2x the slowest Lambda's 40s Timeout.
    expect(h.startCalls[0]!['rieTimeoutMs']).toBe(80_000);
    expect(h.startCalls[1]!['rieTimeoutMs']).toBe(80_000);
  });

  it("builds each pool through the handler's buildPool", () => {
    expect(h.poolCalls).toHaveLength(2);
    expect(h.poolCalls[0]).toEqual({
      specs: h.httpSpecs,
      opts: { perLambdaConcurrency: 3, skipPull: false },
    });
    expect(h.poolCalls[1]!.specs).toBe(h.wsSpecs);
    const httpPool = (h.startCalls[0]!['state'] as { pool: unknown }).pool;
    expect(httpPool).toBe(h.pools[0]);
    expect((httpPool as { __cdkdSpecs?: unknown }).__cdkdSpecs).toBe(h.httpSpecs);
  });

  it("points the WebSocket Lambda's env at its own server", () => {
    expect(h.wsSpec.env['AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI']).toBe(
      'http://host.docker.internal:5001/dev'
    );
  });

  it('returns the arrays the route tables and the banners read', () => {
    expect(h.routeTables).toHaveLength(1);
    const servers = h.routeTables[0] as Array<{ server: unknown }>;
    expect(servers.map((s) => s.server)).toEqual([h.started[0]]);
    const out = writes.join('');
    expect(out).toContain('Server listening on http://0.0.0.0:5000  (HttpApi)');
    expect(out).toContain('Server listening on ws://0.0.0.0:5001/dev  (WsApi (WebSocket API))');
  });

  it('returns the arrays the ^C cleanup closes and disposes', async () => {
    handlers.get('SIGINT')!();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
    expect(h.attached[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.started[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.started[1]!.close).toHaveBeenCalledTimes(1);
    expect(h.pools[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.pools[1]!.dispose).toHaveBeenCalledTimes(1);
  });
});
