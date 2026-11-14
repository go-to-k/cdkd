import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) } }),
}));

/**
 * go-to-k/cdkd#6242, measured against CloudFormation: GraphQLEndpointArn is
 * `arn:...:appsync:<region>:<account>:endpoints/graphql-api/<endpoint-id>` and
 * RealtimeUrl `wss://<endpoint-id>.appsync-realtime-api.<region>.<suffix>/graphql`,
 * where the endpoint id is the first label of the GraphQL host (NOT the api id).
 */
const resolve = (attributes: Record<string, unknown>, attr: string) =>
  new IntrinsicFunctionResolver('us-east-1').resolve({ 'Fn::GetAtt': ['Api', attr] }, {
    template: { Resources: { Api: { Type: 'AWS::AppSync::GraphQLApi', Properties: {} } } },
    resources: {
      Api: {
        physicalId: 'apiid123',
        resourceType: 'AWS::AppSync::GraphQLApi',
        properties: {},
        attributes,
        dependencies: [],
      },
    },
  } as ResolverContext);

describe('AppSync GraphQLEndpointArn / RealtimeUrl (#6242)', () => {
  beforeEach(() => resetAccountInfoCache());

  it.each([
    ['the recorded GraphQLDns', { GraphQLDns: 'endpt456.appsync-api.us-east-1.amazonaws.com' }],
    [
      'an older record\'s GraphQLUrl',
      { GraphQLUrl: 'https://endpt456.appsync-api.us-east-1.amazonaws.com/graphql' },
    ],
  ])('builds both on the endpoint id from %s', async (_label, attributes) => {
    await expect(resolve(attributes, 'GraphQLEndpointArn')).resolves.toBe(
      'arn:aws:appsync:us-east-1:123456789012:endpoints/graphql-api/endpt456'
    );
    await expect(resolve(attributes, 'RealtimeUrl')).resolves.toBe(
      'wss://endpt456.appsync-realtime-api.us-east-1.amazonaws.com/graphql'
    );
  });

  it('serves a recorded RealtimeUrl as recorded', async () => {
    await expect(resolve({ RealtimeUrl: 'wss://x.example/graphql' }, 'RealtimeUrl')).resolves.toBe(
      'wss://x.example/graphql'
    );
  });

  it('refuses without a GraphQL host to read the endpoint id from, never the api id', async () => {
    for (const attr of ['GraphQLEndpointArn', 'RealtimeUrl']) {
      const error = await resolve({}, attr).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error, attr).toBeInstanceOf(IntrinsicResolutionRefusalError);
    }
  });
});
