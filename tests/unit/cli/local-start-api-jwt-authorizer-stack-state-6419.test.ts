/**
 * go-to-k/cdkd#6419: an `HttpUserPoolAuthorizer` resolves its intrinsic
 * Issuer / Audience from its OWN stack's state, so `--from-state` loads that
 * stack even when none of its Lambdas is routed (an HTTP_PROXY route, or the
 * Lambda in another stack), keyed as every other shared bundle is.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

const stateSource = vi.hoisted(() => ({ createLocalStateProvider: vi.fn() }));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: stateSource.createLocalStateProvider,
}));

import { loadStateForRoutedStacks } from '../../../src/cli/commands/local-start-api.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const apiStack = {
  stackName: 'Api',
  displayName: 'Api',
  region: 'us-east-1',
  template: { Resources: {} },
} as unknown as StackInfo;

function jwtEntry(pending: boolean): RouteWithAuth {
  return {
    route: { declaredAt: 'Api/Route', serviceIntegration: true } as never,
    authorizer: {
      kind: 'jwt',
      logicalId: 'Auth',
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cdkdplaceholderAuth',
      audience: [],
      declaredAt: 'Api/Route',
      ...(pending && { pending: { stackName: 'Api', issuer: { Ref: 'Pool' }, audience: [] } }),
    },
  } as RouteWithAuth;
}

function provide(loaded: string[]): void {
  stateSource.createLocalStateProvider.mockImplementation(() => ({
    label: '--from-state',
    load: vi.fn(async (name: string) => {
      loaded.push(name);
      return { region: 'us-east-1', resources: {}, outputs: {} };
    }),
    dispose: vi.fn(),
  }));
}

describe('loadStateForRoutedStacks with a JWT authorizer waiting on state (#6419)', () => {
  it("loads the authorizer's stack although no Lambda there is routed", async () => {
    const loaded: string[] = [];
    provide(loaded);
    const bundles = await loadStateForRoutedStacks([apiStack], [], [jwtEntry(true)], {
      fromState: true,
    } as never);
    expect(loaded).toEqual(['Api']);
    expect([...bundles.keys()]).toEqual(['Api']);
  });

  it("loads a REST v1 Cognito authorizer's stack while its ProviderARNs wait on state (#6717)", async () => {
    const loaded: string[] = [];
    provide(loaded);
    const pool = {
      userPoolArn: 'arn:aws:cognito-idp:us-east-1:000000000000:userpool/us-east-1_cdkdplaceholderAuth',
      region: 'us-east-1',
      userPoolId: 'us-east-1_cdkdplaceholderAuth',
    };
    const entry = {
      route: { declaredAt: 'Api/Method', serviceIntegration: true } as never,
      authorizer: {
        kind: 'cognito',
        logicalId: 'Auth',
        pools: [pool],
        ...pool,
        pending: { stackName: 'Api', providerArns: [{ 'Fn::GetAtt': ['Pool', 'Arn'] }] },
        declaredAt: 'Api/Method',
      },
    } as RouteWithAuth;
    const bundles = await loadStateForRoutedStacks([apiStack], [], [entry], {
      fromState: true,
    } as never);
    expect(loaded).toEqual(['Api']);
    expect([...bundles.keys()]).toEqual(['Api']);
  });

  it('does not load a stack whose JWT authorizer is all literal', async () => {
    const loaded: string[] = [];
    provide(loaded);
    await loadStateForRoutedStacks([apiStack], [], [jwtEntry(false)], { fromState: true } as never);
    expect(loaded).toEqual([]);
  });
});
