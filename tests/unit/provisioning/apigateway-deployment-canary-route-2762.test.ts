/**
 * `AWS::ApiGateway::Deployment.DeploymentCanarySettings` routing
 * (issue [#2762](https://github.com/go-to-k/cdkd/issues/2762)).
 *
 * API Gateway refuses a `CreateDeployment` that carries `canarySettings`
 * without a stage name, on the Cloud Control route and the SDK route alike
 * (measured in us-east-1, request 2571bd53-7f09-4cbd-9c38-0bff4edf32ec:
 * "Non null and non empty stageName must be provided for canary deployment").
 * `StageName` is not handled by the SDK provider, so every canary Deployment
 * AWS accepts routes through Cloud Control. The property is therefore declared
 * `unhandledByDesign` instead of wired.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

const RESOURCE_TYPE = 'AWS::ApiGateway::Deployment';
const PROPERTY = 'DeploymentCanarySettings';
const CANARY = { PercentTraffic: 10, UseStageCache: false };

describe('AWS::ApiGateway::Deployment DeploymentCanarySettings (issue #2762)', () => {
  it('is declared unhandledByDesign, not handled, with a rationale naming StageName', () => {
    const provider = new ApiGatewayProvider();
    expect([...provider.handledProperties.get(RESOURCE_TYPE)!]).not.toContain(PROPERTY);
    expect(provider.unhandledByDesign.get(RESOURCE_TYPE)?.get(PROPERTY)).toMatch(/StageName/);
  });

  it.each([
    ['with StageName (the shape AWS accepts)', { StageName: 'live' }],
    ['without StageName (AWS refuses it on either route)', {}],
  ])('routes a canary Deployment %s through Cloud Control', (_label, extra) => {
    const registry = new ProviderRegistry();
    registry.register(RESOURCE_TYPE, new ApiGatewayProvider());

    const decision = registry.getProviderFor({
      resourceType: RESOURCE_TYPE,
      properties: { RestApiId: 'api-id', [PROPERTY]: CANARY, ...extra },
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.provider).toBe(registry.getCloudControlProvider());
  });

  it('keeps a plain Deployment on the SDK provider (negative control)', () => {
    const registry = new ProviderRegistry();
    registry.register(RESOURCE_TYPE, new ApiGatewayProvider());

    const decision = registry.getProviderFor({
      resourceType: RESOURCE_TYPE,
      properties: { RestApiId: 'api-id', Description: 'plain' },
    });
    expect(decision.provisionedBy).toBe('sdk');
  });
});
