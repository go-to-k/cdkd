import { afterAll, beforeAll, describe, vi } from 'vite-plus/test';
import { ACMClient } from '@aws-sdk/client-acm';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { LambdaWebClient } from '@aws-sdk/client-lambda-web';
import { Route53Client } from '@aws-sdk/client-route-53';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the eighth batch reaches (`sdk-wire-cases-8.ts` and
// `sdk-wire-cases-8-acm.ts`), wrapped as in `sdk-wire-coverage.test.ts`, so
// every instance (shared or provider-built: the web function revision's create
// client) is captured. The ACM provider writes its DNS validation record
// through Route 53.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-acm', (orig) => wrap(orig, 'ACMClient'));
vi.mock('@aws-sdk/client-cloudfront', (orig) => wrap(orig, 'CloudFrontClient'));
vi.mock('@aws-sdk/client-lambda-microvms', (orig) => wrap(orig, 'LambdaMicrovmsClient'));
vi.mock('@aws-sdk/client-lambda-web', (orig) => wrap(orig, 'LambdaWebClient'));
vi.mock('@aws-sdk/client-route-53', (orig) => wrap(orig, 'Route53Client'));

const clients = {
  acm: new ACMClient({}),
  route53: new Route53Client({}),
  cloudFront: new CloudFrontClient({}),
  lambdaMicrovms: new LambdaMicrovmsClient({}),
  lambdaWeb: new LambdaWebClient({}),
  credentialConfig: {},
};
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

// A create token is retired when its create succeeds, so the next create of the
// same logical id mints another and no two creates would send the same request
// (the harness's determinism check). Each (scope, logical id) answers one fixed
// token here instead; ACM's RequestCertificate `IdempotencyToken` and
// CloudFront's CreateDistribution `CallerReference` are the ones that take it.
vi.mock('../../../src/provisioning/providers/idempotency-token.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acquireIdempotencyToken: ({ scope, logicalId }: { scope: string; logicalId: string }) => ({
    value: `cdkd-${scope}-${logicalId}`,
    release: () => undefined,
  }),
}));

import { CASES_8 } from './sdk-wire-cases-8.js';
import { ACM_CASES } from './sdk-wire-cases-8-acm.js';
import { describeLambdawebExtras } from './sdk-wire-cases-8-lambdaweb.js';

describe('SDK wire coverage (batch 8)', () => {
  describeWireCases(CASES_8);
});

describe('SDK wire coverage (batch 8, ACM)', () => {
  // create() polls DescribeCertificate with this sleep between polls, read
  // when the provider is constructed; the arm answers ISSUED on the second.
  const saved = {
    interval: process.env['CDKD_ACM_POLL_INTERVAL_MS'],
    noWait: process.env['CDKD_NO_WAIT'],
  };
  beforeAll(() => {
    process.env['CDKD_ACM_POLL_INTERVAL_MS'] = '0';
    delete process.env['CDKD_NO_WAIT'];
  });
  afterAll(() => {
    if (saved.interval === undefined) delete process.env['CDKD_ACM_POLL_INTERVAL_MS'];
    else process.env['CDKD_ACM_POLL_INTERVAL_MS'] = saved.interval;
    if (saved.noWait !== undefined) process.env['CDKD_NO_WAIT'] = saved.noWait;
  });
  describeWireCases(ACM_CASES);
});

describeLambdawebExtras();
