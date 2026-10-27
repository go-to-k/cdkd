import { describe, vi } from 'vite-plus/test';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { S3Client } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';
import { describeWireCases } from './sdk-wire-harness.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

// The client classes the thirteenth batch reaches (`sdk-wire-cases-13.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`.
//
// - `ApiGatewayProvider` takes its shared client from `getAwsClients().apiGateway`
//   and builds its own `CreateAuthorizer` / `CreateDeployment` client. That create
//   client is paced (`withApiGatewayPacing`, 8 calls/s per Region), which would
//   only slow the probes down: the pacing is left out.
// - `CognitoUserPoolProvider` builds its own clients (a create client among them).
// - `S3BucketProvider` takes its shared client from `getAwsClients().s3` and
//   builds its own `CreateBucket` client in that client's region, so
//   `getAwsClients` answers an `eu-west-1` client: outside us-east-1 `create()`
//   sends no `GetBucketLocation` pre-flight.
// - `NestedStackProvider` builds no client: its wire is the child engine's, one
//   SNS topic. The topic provider reads its client through `getAwsClients()`;
//   STS answers the caller identity its ARN needs, and `DescribeType` (the child
//   diff's create-only lookup) is refused, so the engine reads the committed
//   create-only snapshot.
const { wrap, wrapS3 } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
  // S3 carries members where the harness's capture does not look, so the S3
  // wrapper moves them into view: the bucket NAME is in the virtual host (path
  // style puts it in the captured path), and several members are `x-amz-*`
  // headers (`CreateBucket`'s `ObjectLockEnabledForBucket`, the lifecycle Put's
  // `TransitionDefaultMinimumObjectSize`), which are copied into the captured
  // query. That runs at the `build` step ahead of the capture, before signing,
  // so only the request's own members are there; the SDK's checksum and
  // user-agent headers are left out.
  wrapS3: async (orig: () => Promise<Record<string, unknown>>) => {
    const mod = (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), 'S3Client');
    const Base = mod['S3Client'] as new (config: Record<string, unknown>) => {
      middlewareStack: { add(middleware: never, options: never): void };
    };
    const MEMBER_HEADER = /^x-amz-(?!checksum|sdk-checksum|content-sha256|user-agent)/;
    const S3Client = class extends Base {
      constructor(config: Record<string, unknown> = {}) {
        super({ ...config, forcePathStyle: true });
        const headersIntoQuery =
          (next: (args: unknown) => Promise<unknown>) =>
          async (args: { request: { headers: Record<string, string>; query?: object } }) => {
            const members = Object.entries(args.request.headers).filter(([h]) =>
              MEMBER_HEADER.test(h.toLowerCase())
            );
            if (members.length > 0) {
              args.request.query = { ...args.request.query, ...Object.fromEntries(members) };
            }
            return next(args);
          };
        this.middlewareStack.add(
          headersIntoQuery as never,
          { step: 'build', name: 's3HeadersIntoQuery', priority: 'high' } as never
        );
      }
    };
    Object.defineProperty(S3Client, 'name', { value: 'S3Client' });
    return { ...mod, S3Client };
  },
}));
vi.mock('@aws-sdk/client-api-gateway', (orig) => wrap(orig, 'APIGatewayClient'));
vi.mock('@aws-sdk/client-cognito-identity-provider', (orig) =>
  wrap(orig, 'CognitoIdentityProviderClient')
);
vi.mock('@aws-sdk/client-s3', (orig) => wrapS3(orig));
vi.mock('@aws-sdk/client-sns', (orig) => wrap(orig, 'SNSClient'));
vi.mock('../../../src/utils/apigateway-pacing.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withApiGatewayPacing: <T>(client: T): T => client,
}));

// The nested stack's child engine logs and renders progress: both are silenced.
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

const clients = {
  apiGateway: new APIGatewayClient({}),
  s3: new S3Client({ region: 'eu-west-1' }),
  sns: new SNSClient({}),
  sts: {
    send: async () => ({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:root' }),
  },
  cloudFormation: {
    send: () =>
      Promise.reject(
        Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 403 },
        })
      ),
  },
  credentialConfig: {},
};
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_13, describeCognitoExtras } from './sdk-wire-cases-13.js';

// The S3 bucket's every-property bag probes every path of 19 nested
// configurations, each through a create and both update directions: a
// CPU-bound enumeration of ~4.5 s alone, past Vitest's 5 s default under a
// loaded CI runner.
vi.setConfig({ testTimeout: CONTENDED_CASE_TIMEOUT_MS });

describe('SDK wire coverage (batch 13)', () => {
  describeWireCases(CASES_13);
});

describeCognitoExtras();
