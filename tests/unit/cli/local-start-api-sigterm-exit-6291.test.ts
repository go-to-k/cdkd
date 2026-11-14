import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6291: `cdkd local start-api` exits 143 on SIGTERM after the same
 * cleanup SIGINT runs (it used to exit 0). SIGINT's 130 is pinned in
 * `local-start-api-boot-handoff.test.ts`. The harness is that file's: it drives
 * the real handler through `createLocalStartApiCommand()` up to the point where
 * it blocks, with Docker, AWS and the network doubled at their module boundary.
 * One signal per file, because a second signal takes the force-exit arm.
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

describe('local start-api: SIGTERM exit code (go-to-k/cdkd#6291)', () => {
  it('runs the cleanup and exits 143 on SIGTERM (go-to-k/cdkd#6291)', async () => {
    handlers.get('SIGTERM')!();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
    expect(exitSpy).not.toHaveBeenCalledWith(0);
    expect(h.started[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.pools[0]!.dispose).toHaveBeenCalledTimes(1);
    const exitOrder = exitSpy.mock.invocationCallOrder[0]!;
    expect(h.started[0]!.close.mock.invocationCallOrder[0]!).toBeLessThan(exitOrder);
    expect(h.pools[0]!.dispose.mock.invocationCallOrder[0]!).toBeLessThan(exitOrder);
  });
});
