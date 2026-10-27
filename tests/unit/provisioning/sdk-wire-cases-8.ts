import type { TypeCase } from './sdk-wire-harness.js';
import { ACM_CASES } from './sdk-wire-cases-8-acm.js';
import { CLOUDFRONT_CASES } from './sdk-wire-cases-8-cloudfront.js';
import { LAMBDAWEB_CASES } from './sdk-wire-cases-8-lambdaweb.js';

/**
 * The eighth batch of wire cases (#3723): the ACM certificate, the CloudFront
 * distribution, and the Lambda MicroVM image, web function endpoint and web
 * function revision. One module per service, gathered here; run by
 * `sdk-wire-coverage-8.test.ts`, which mocks the clients these providers
 * reach and also registers each module's direct-call blocks.
 *
 * `ACM_CASES` is NOT in this list: its create polls DescribeCertificate with a
 * sleep the test file zeroes through an environment variable for those cases
 * only.
 *
 * The other candidates of this batch stay uncovered behind the provider bugs
 * their draft cases found: ApiGatewayV2 (#5390), ApiGateway (#5391) and ECS
 * (#5392).
 */
export const CASES_8: TypeCase[] = [...CLOUDFRONT_CASES, ...LAMBDAWEB_CASES];
