/**
 * go-to-k/cdkd#5181: `cdkd local start-api --stack 'Svc*'` over two stacks
 * with unique physical names that reuse one construct id (each declares
 * `new HttpApi(this, 'Api')` with a `Handler` Lambda). The per-Lambda specs,
 * the Stage map and the CORS map are keyed by (stack, logical id), so each
 * stack's route is served by its own Lambda with its own Stage and CORS. Before
 * #5177 the bare-id maps served one stack's settings for both; #5177 refused
 * the union instead.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  assertServedLogicalIdsUnambiguous,
  attachStageContextPerStack,
  buildCorsConfigByStack,
  buildServedLambdaSpecs,
  corsConfigForGroup,
  filterSpecsForGroup,
  filterSpecsForWebSocketApi,
  groupStackName,
  perStack,
  reloadAllServers,
  resolveLambdaByLogicalId,
  servedLambdaKey,
  warnVpcConfigLambdas,
} from '../../../src/cli/commands/local-start-api.js';
import { createAuthorizerCache, type AuthorizerCache } from '../../../src/local/authorizer-cache.js';
import { resolveEnvVars } from '../../../src/local/env-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { DiscoveredWebSocketApi } from '../../../src/local/websocket-route-discovery.js';
import { discoverRoutes } from '../../../src/local/route-discovery.js';
import { attachAuthorizers } from '../../../src/local/authorizer-resolver.js';
import { groupRoutesByServer } from '../../../src/local/api-server-grouping.js';
import type { ContainerSpec } from '../../../src/local/container-pool.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/** One service stack: `Api` (HTTP API) -> `Handler`, with its own Stage and CORS. */
function service(stackName: string, marker: string): StackInfo {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    region: 'us-east-1',
    template: {
      Resources: {
        Handler: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: `exports.handler = async () => ${JSON.stringify(marker)};` },
          },
          Metadata: { 'aws:cdk:path': `${stackName}/Handler/Resource` },
        },
        Api: {
          Type: 'AWS::ApiGatewayV2::Api',
          Properties: {
            Name: 'Api',
            ProtocolType: 'HTTP',
            CorsConfiguration: {
              AllowOrigins: [`https://${marker}.example`],
              AllowMethods: ['GET'],
            },
          },
          Metadata: { 'aws:cdk:path': `${stackName}/Api/Resource` },
        },
        ApiStage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: { Ref: 'Api' },
            StageName: '$default',
            AutoDeploy: true,
            StageVariables: { marker },
          },
        },
        ApiIntegration: {
          Type: 'AWS::ApiGatewayV2::Integration',
          Properties: {
            ApiId: { Ref: 'Api' },
            IntegrationType: 'AWS_PROXY',
            IntegrationUri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
            PayloadFormatVersion: '2.0',
          },
        },
        ApiRoute: {
          Type: 'AWS::ApiGatewayV2::Route',
          Properties: {
            ApiId: { Ref: 'Api' },
            RouteKey: 'GET /',
            Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'ApiIntegration' }]] },
          },
        },
      },
    },
    dependencyNames: [],
  } as unknown as StackInfo;
}

const svcA = service('SvcA', 'svc-a');
const svcB = service('SvcB', 'svc-b');
const stacks = [svcA, svcB];

/** A spec standing in for `buildContainerSpec`: the resolved Lambda is all the test reads. */
async function fakeSpec(args: { logicalId: string; stacks: StackInfo[] }): Promise<ContainerSpec> {
  return { lambda: resolveLambdaByLogicalId(args.logicalId, args.stacks) } as ContainerSpec;
}

/** The boot pipeline `synthesizeAndBuild` runs, minus synth and docker. */
async function boot(served: StackInfo[]) {
  const routes = discoverRoutes(served);
  attachStageContextPerStack(served, routes, undefined);
  const routesWithAuth = attachAuthorizers(served, routes);
  assertServedLogicalIdsUnambiguous(served, routes, routesWithAuth);
  const specs = await buildServedLambdaSpecs(served, routes, routesWithAuth, [], fakeSpec);
  const material = { specs, stacks: served, corsConfigByStack: buildCorsConfigByStack(served) };
  return { specs, groups: groupRoutesByServer(routesWithAuth), material };
}

describe('start-api over two stacks reusing construct ids (#5181)', () => {
  it('builds one spec per (stack, logical id), each of its own stack', async () => {
    const { specs } = await boot(stacks);
    expect([...specs.keys()]).toEqual([
      servedLambdaKey('SvcA', 'Handler'),
      servedLambdaKey('SvcB', 'Handler'),
    ]);
    expect(specs.get('SvcA:Handler')!.lambda.stack).toBe(svcA);
    expect(specs.get('SvcB:Handler')!.lambda.stack).toBe(svcB);
  });

  it("serves each stack's route from its own Lambda, Stage and CORS", async () => {
    const { groups, material } = await boot(stacks);
    expect(groups).toHaveLength(2);
    const seen: string[] = [];
    for (const group of groups) {
      const stackName = group.routes[0]!.route.apiStackName!;
      const marker = stackName === 'SvcA' ? 'svc-a' : 'svc-b';
      seen.push(stackName);
      // The pool is keyed by the bare id the server dispatches on.
      const pool = filterSpecsForGroup(group, material);
      expect([...pool.keys()]).toEqual(['Handler']);
      const lambda = pool.get(group.routes[0]!.route.lambdaLogicalId)!.lambda;
      expect(lambda.stack.stackName).toBe(stackName);
      expect(lambda.kind === 'zip' && lambda.inlineCode).toContain(JSON.stringify(marker));
      // Stage variables from the route's own stack's Stage.
      expect(group.routes[0]!.route.stageVariables).toEqual({ marker });
      // CORS from the route's own stack's API.
      const cors = corsConfigForGroup(group, material).get('Api');
      expect(cors?.AllowOrigins).toEqual([`https://${marker}.example`]);
    }
    expect(seen.sort()).toEqual(['SvcA', 'SvcB']);
  });

  it('is independent of the order the stacks are served in', async () => {
    const { groups, material } = await boot([svcB, svcA]);
    for (const group of groups) {
      const stackName = group.routes[0]!.route.apiStackName!;
      const pool = filterSpecsForGroup(group, material);
      expect(pool.get('Handler')!.lambda.stack.stackName).toBe(stackName);
    }
  });

  it('names the stack of an API missing the --stage override, when several are served', () => {
    const routes = discoverRoutes(stacks);
    expect([...attachStageContextPerStack(stacks, routes, 'prod')].sort()).toEqual([
      'SvcA:Api',
      'SvcB:Api',
    ]);
    const single = discoverRoutes([svcA]);
    expect([...attachStageContextPerStack([svcA], single, 'prod')]).toEqual(['Api']);
  });
});

describe('a bare logical id the user passes, still ambiguous across served stacks (#5181)', () => {
  const routes = discoverRoutes(stacks);
  const routesWithAuth = attachAuthorizers(stacks, routes);

  it('refuses an --assume-role entry naming a Lambda both stacks declare', () => {
    const assumeRole = {
      perLambda: { Handler: 'arn:aws:iam::123456789012:role/R' },
    };
    expect(() =>
      assertServedLogicalIdsUnambiguous(stacks, routes, routesWithAuth, [], { assumeRole })
    ).toThrow(
      `--assume-role names Lambda Handler by its bare logical ID, which 2 of the served stacks ` +
        `declare (SvcA, SvcB), so it does not say which one to assume the role for. ` +
        `Serve one stack at a time: pass --stack with its CDK path, or a target starting with that path.`
    );
  });

  it('refuses an --env-vars key naming a Lambda both stacks declare, naming the construct paths', () => {
    const overrides = { Handler: { KEY: 'v' } };
    expect(() =>
      assertServedLogicalIdsUnambiguous(stacks, routes, routesWithAuth, [], { overrides })
    ).toThrow(
      `--env-vars key Handler names a Lambda by its bare logical ID, which 2 of the served ` +
        `stacks declare (SvcA, SvcB), so it does not say which one it overrides. Key it by the ` +
        `Lambda's construct path instead, which names one stack: "SvcA/Handler", "SvcB/Handler".`
    );
  });

  it('accepts the stack-qualified --env-vars key, the global Parameters, and a bare id one stack declares', () => {
    const overrides = { 'SvcA/Handler': { KEY: 'v' }, Parameters: { K: 'v' } };
    expect(() =>
      assertServedLogicalIdsUnambiguous(stacks, routes, routesWithAuth, [], { overrides })
    ).not.toThrow();
    const assumeRole = { perLambda: { Handler: 'arn:aws:iam::123456789012:role/R' } };
    expect(() =>
      assertServedLogicalIdsUnambiguous(
        [svcA],
        discoverRoutes([svcA]),
        attachAuthorizers([svcA], discoverRoutes([svcA])),
        [],
        { assumeRole, overrides: { Handler: { KEY: 'v' } } }
      )
    ).not.toThrow();
  });
});

/** `svc` with one more resource, or a patched Handler. */
function withResource(stack: StackInfo, id: string, resource: object): StackInfo {
  return {
    ...stack,
    template: { Resources: { ...stack.template.Resources, [id]: resource } },
  } as unknown as StackInfo;
}

function authFn(stackName: string): object {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: `exports.handler = async () => ${JSON.stringify(`auth-${stackName}`)};` },
    },
  };
}

describe('per-stack server state cdk-local keys by bare logical id (#5181)', () => {
  it("gives each stack's servers their own authorizer-verdict cache, kept per stack", async () => {
    const { groups, material } = await boot(stacks);
    const caches = new Map<string, AuthorizerCache>();
    const byGroup = groups.map((g) =>
      perStack(caches, groupStackName(g, material.stacks), createAuthorizerCache)
    );
    expect(byGroup[0]).not.toBe(byGroup[1]);
    // Same stack again (a --watch reload): the same cache.
    expect(perStack(caches, groupStackName(groups[0]!, material.stacks), createAuthorizerCache)).toBe(
      byGroup[0]
    );
    // An Allow cached by one stack's authorizer never answers the other stack.
    byGroup[0]!.set('Authorizer', 'token-hash', 300, { allow: true } as never);
    expect(byGroup[0]!.get('Authorizer', 'token-hash')).toBeDefined();
    expect(byGroup[1]!.get('Authorizer', 'token-hash')).toBeUndefined();
  });

  it("resolves each stack's Lambda authorizer reusing one logical id to its own stack", async () => {
    const served = [withResource(svcA, 'AuthFn', authFn('SvcA')), withResource(svcB, 'AuthFn', authFn('SvcB'))];
    const routes = discoverRoutes(served);
    const routesWithAuth = routes.map(
      (route) =>
        ({
          route,
          authorizer: { kind: 'lambda-request', lambdaLogicalId: 'AuthFn' },
        }) as unknown as RouteWithAuth
    );
    const specs = await buildServedLambdaSpecs(served, routes, routesWithAuth, [], fakeSpec);
    expect([...specs.keys()].sort()).toEqual(['SvcA:AuthFn', 'SvcA:Handler', 'SvcB:AuthFn', 'SvcB:Handler']);
    const material = { specs, stacks: served };
    for (const group of groupRoutesByServer(routesWithAuth)) {
      const stackName = group.routes[0]!.route.apiStackName!;
      const pool = filterSpecsForGroup(group, material);
      expect(pool.get('AuthFn')!.lambda.stack.stackName).toBe(stackName);
    }
  });

  it("gives each stack's WebSocket API the spec of its own stack's Lambda", async () => {
    const wsApi = (stackName: string): DiscoveredWebSocketApi =>
      ({
        apiLogicalId: 'Ws',
        apiStackName: stackName,
        declaredAt: `${stackName}/Ws`,
        routeSelectionExpression: '$request.body.action',
        stage: 'dev',
        routes: [
          {
            routeKey: '$default',
            targetLambdaLogicalId: 'Handler',
            lambdaStackName: stackName,
            declaredAt: `${stackName}/Route`,
          },
        ],
      }) as DiscoveredWebSocketApi;
    const apis = [wsApi('SvcA'), wsApi('SvcB')];
    const specs = await buildServedLambdaSpecs(stacks, [], [], apis, fakeSpec);
    expect([...specs.keys()]).toEqual(['SvcA:Handler', 'SvcB:Handler']);
    for (const api of apis) {
      const pool = filterSpecsForWebSocketApi(api, { specs, stacks });
      expect([...pool.keys()]).toEqual(['Handler']);
      expect(pool.get('Handler')!.lambda.stack.stackName).toBe(api.apiStackName);
    }
  });

  it('hands the resolver every served stack when a Lambda has no single owner', async () => {
    const route = { ...discoverRoutes([svcA])[0]!, lambdaLogicalId: 'Missing' };
    const seen: string[][] = [];
    await expect(
      buildServedLambdaSpecs(stacks, [route], [], [], async (args) => {
        seen.push(args.stacks.map((st) => st.stackName));
        return fakeSpec(args);
      })
    ).rejects.toThrow();
    expect(seen).toEqual([['SvcA', 'SvcB']]);
  });

  it('attaches the Stage of a single served stack to a route discovery left without its stack', () => {
    const route = { ...discoverRoutes([svcA])[0]! };
    delete route.apiStackName;
    attachStageContextPerStack([svcA], [route], undefined);
    expect(route.stageVariables).toEqual({ marker: 'svc-a' });
  });
});

describe('the other per-stack readers (#5181)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns about a VpcConfig Lambda of the stack declaring it, stack-qualified', () => {
    const vpcHandler = {
      ...(svcB.template.Resources!['Handler'] as object),
      Properties: {
        ...(svcB.template.Resources!['Handler']!.Properties as object),
        VpcConfig: { SubnetIds: ['subnet-1'] },
      },
    };
    const served = [svcA, withResource(svcB, 'Handler', vpcHandler)];
    const routes = discoverRoutes(served);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    warnVpcConfigLambdas(attachAuthorizers(served, routes), served);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('VpcConfig'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Lambda SvcB:Handler has VpcConfig/);
  });

  it("swaps each server to its own stack's CORS on a --watch reload", async () => {
    const { groups, material } = await boot(stacks);
    const routes = groups.flatMap((g) => g.routes);
    const states = new Map<string, unknown>();
    const servers = groups.map((group) => {
      let state: unknown = { routes: [], pool: { dispose: async () => undefined } };
      return {
        group,
        server: {
          host: '127.0.0.1',
          port: 3000,
          setServerState: (next: unknown) => {
            const prev = state;
            state = next;
            states.set(group.serverKey, next);
            return prev;
          },
        },
      };
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    await reloadAllServers({
      synthesizeAndBuild: async () => ({ ...material, routes }),
      servers: servers as never,
      buildPool: () => ({ dispose: async () => undefined }) as never,
      logger: getLogger(),
    });
    write.mockRestore();
    for (const group of groups) {
      const marker = group.routes[0]!.route.apiStackName === 'SvcA' ? 'svc-a' : 'svc-b';
      const state = states.get(group.serverKey) as { corsConfigByApiId: Map<string, { AllowOrigins: string[] }> };
      expect(state.corsConfigByApiId.get('Api')?.AllowOrigins).toEqual([`https://${marker}.example`]);
    }
  });

  it('applies a construct-path --env-vars key to its own stack only', () => {
    const overrides = { 'SvcA/Handler': { KEY: 'v' } };
    expect(resolveEnvVars('Handler', 'SvcA/Handler/Resource', {}, overrides).resolved['KEY']).toBe('v');
    expect(resolveEnvVars('Handler', 'SvcB/Handler/Resource', {}, overrides).resolved['KEY']).toBeUndefined();
  });

  it('describes the construct-path key without printing a path displayIdent would alter', () => {
    const odd = (st: StackInfo): StackInfo =>
      withResource(st, 'Handler', {
        ...(st.template.Resources!['Handler'] as object),
        Metadata: { 'aws:cdk:path': `${st.stackName}/Hand\nler/Resource` },
      });
    const served = [odd(svcA), odd(svcB)];
    const routes = discoverRoutes(served);
    expect(() =>
      assertServedLogicalIdsUnambiguous(served, routes, attachAuthorizers(served, routes), [], {
        overrides: { Handler: { KEY: 'v' } },
      })
    ).toThrow(/Key it by the Lambda's construct path instead, which names one stack\.$/);
  });
});

describe('the VpcConfig warning set (#5181)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('still warns for a Lambda reachable only through an unsupported route', () => {
    const vpcHandler = {
      ...(svcA.template.Resources!['Handler'] as object),
      Properties: {
        ...(svcA.template.Resources!['Handler']!.Properties as object),
        VpcConfig: { SubnetIds: ['subnet-1'] },
      },
    };
    const served = [withResource(svcA, 'Handler', vpcHandler)];
    const route = { ...discoverRoutes(served)[0]!, unsupported: { reason: 'x' } };
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    warnVpcConfigLambdas([{ route, authorizer: undefined } as RouteWithAuth], served);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('VpcConfig'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Lambda Handler has VpcConfig/);
  });
});
