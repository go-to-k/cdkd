import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const accountLookup = vi.hoisted(() => ({
  getAccountInfo: vi.fn(async (region?: string) => ({
    accountId: '123456789012',
    region: region ?? 'us-east-1',
    partition: region?.startsWith('us-gov-') === true ? 'aws-us-gov' : 'aws',
  })),
}));
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>()),
  getAccountInfo: accountLookup.getAccountInfo,
}));

import {
  apiGatewayAuthorizerSdkPhysicalId,
  apiGatewayStageSdkPhysicalId,
  apiGatewayV2AuthorizerSdkPhysicalId,
  apiGatewayV2IntegrationSdkPhysicalId,
  apiGatewayV2RouteSdkPhysicalId,
  apiGatewayV2StageSdkPhysicalId,
  appSyncGraphQLApiSdkPhysicalId,
  codeCommitRepositorySdkPhysicalId,
  ecsServiceSdkPhysicalId,
  s3VectorsVectorBucketSdkPhysicalId,
  wafv2WebAclSdkPhysicalId,
  type CcPhysicalIdContext,
} from '../../../src/provisioning/sticky-exempt-physical-id.js';
import {
  STICKY_CC_MIGRATION_EXEMPT,
  assertSdkReadMatchesCcId,
  sdkAddressedPhysicalId,
  sdkAddressedRecord,
} from '../../../src/provisioning/provider-registry.js';
import type { ResourceState } from '../../../src/types/state.js';
import { AccountIdUnavailableError } from '../../../src/utils/error-handler.js';

/**
 * The declared physicalId normalizers of the sticky-CC exemption
 * (go-to-k/cdkd#5654). Strict by contract: only the measured Cloud Control
 * form is accepted, and anything else throws rather than being handed to the
 * SDK provider under a guessed id.
 */
const LONG = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const SHORT = 'arn:aws:ecs:us-east-1:123456789012:service/my-service';
const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster';

describe('ecsServiceSdkPhysicalId', () => {
  it.each([
    ['a long-format ARN with the cluster name', `${LONG}|my-cluster`, LONG],
    ['a long-format ARN with the cluster ARN', `${LONG}|${CLUSTER_ARN}`, LONG],
    ['a legacy short-format ARN', `${SHORT}|my-cluster`, SHORT],
    [
      'another partition',
      'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:service/c/s|c',
      'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:service/c/s',
    ],
  ])('accepts %s and keeps the ARN', (_label, ccId, sdkId) => {
    expect(ecsServiceSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare ARN the SDK route records', LONG],
    ['the reverse <clusterArn>|<serviceName> order', `${CLUSTER_ARN}|my-service`],
    ['an empty cluster segment', `${LONG}|`],
    ['an extra segment', `${LONG}|my-cluster|x`],
    ['a bare service name', 'my-service|my-cluster'],
    ['another service ARN namespace', 'arn:aws:sns:us-east-1:123456789012:service/a/b|a'],
    ['a long-format ARN naming another cluster', `${LONG}|other-cluster`],
    ['a cluster ARN naming another cluster', `${LONG}|${CLUSTER_ARN.replace('my-cluster', 'x')}`],
    ['a cluster segment that is an ARN of another kind', `${LONG}|arn:aws:iam::123456789012:role/r`],
    ['an empty string', ''],
    ['a short-format ARN with a non-cluster ARN', `${SHORT}|arn:aws:iam::123456789012:role/r`],
    ['a short-format ARN with a cluster segment carrying a slash', `${SHORT}|a/b`],
    ['a four-segment service ARN', `${LONG}/extra|my-cluster`],
    ['a service name carrying a newline', `${LONG}\nx|my-cluster`],
  ])('refuses %s', (_label, ccId) => {
    expect(() => ecsServiceSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    const secretish = 'arn:aws:ecs:us-east-1:123456789012:service/c/supersecret';
    expect(() => ecsServiceSdkPhysicalId(secretish)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

// The measured Cloud Control forms (us-east-1, 2026-11-17): `mm525t8176|yj4gsv`
// for an authorizer and `mm525t8176|cdkdmeasure` for a stage.
describe('apiGatewayAuthorizerSdkPhysicalId', () => {
  it('keeps the authorizer id of the measured <restApiId>|<authorizerId> form', () => {
    expect(apiGatewayAuthorizerSdkPhysicalId('mm525t8176|yj4gsv')).toBe('yj4gsv');
  });

  it.each([
    ['the bare id the SDK route records', 'yj4gsv'],
    // The committed schema fixture lists AuthorizerId first.
    ['the reversed <authorizerId>|<restApiId> order', 'yj4gsv|mm525t8176'],
    ['an empty authorizer segment', 'mm525t8176|'],
    ['an empty rest API segment', '|yj4gsv'],
    ['a rest API id one character short', 'mm525t817|yj4gsv'],
    ['a rest API id one character long', 'mm525t8176x|yj4gsv'],
    ['an extra segment', 'mm525t8176|yj4gsv|x'],
    ['an uppercase id', 'mm525t8176|YJ4GSV'],
    ['an ARN', 'arn:aws:apigateway:us-east-1::/restapis/mm525t8176/authorizers/yj4gsv'],
    ['an id carrying a newline', 'mm525t8176|yj4gsv\nx'],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayAuthorizerSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayAuthorizerSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('apiGatewayStageSdkPhysicalId', () => {
  it.each([
    ['the measured form', 'mm525t8176|cdkdmeasure', 'cdkdmeasure'],
    ['a name with hyphens, underscores and capitals', 'mm525t8176|Prod_v-2', 'Prod_v-2'],
  ])('keeps the stage name of %s', (_label, ccId, sdkId) => {
    expect(apiGatewayStageSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare name the SDK route records', 'prod'],
    ['an empty stage segment', 'mm525t8176|'],
    ['an empty rest API segment', '|prod'],
    ['an extra segment', 'mm525t8176|prod|x'],
    ['the reversed <stageName>|<restApiId> order', 'reroute|mm525t8176'],
    ['the reversed order with a capitalized stage name', 'Prod|mm525t8176'],
    ['a rest API id one character short', 'mm525t817|prod'],
    ['an uppercase rest API id', 'MM525T8176|prod'],
    ['a stage name with a slash', 'mm525t8176|a/b'],
    ['a stage name carrying a newline', 'mm525t8176|prod\nx'],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayStageSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayStageSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

// The measured Cloud Control forms (us-east-1, 2026-11-17), all under the
// HTTP API `9qyhc572r8`: integration `9qyhc572r8|c1m2ghk`, route
// `9qyhc572r8|m036gwk`, stage `9qyhc572r8|cdkdmeasure` (and
// `j4qslfc9hj|$default`), and authorizer `fhvgo9|9qyhc572r8` -- API id LAST.
const V2_API = '9qyhc572r8';

describe.each([
  ['apiGatewayV2IntegrationSdkPhysicalId', apiGatewayV2IntegrationSdkPhysicalId, 'c1m2ghk'],
  ['apiGatewayV2RouteSdkPhysicalId', apiGatewayV2RouteSdkPhysicalId, 'm036gwk'],
])('%s', (_name, normalize, childId) => {
  it('keeps the child id of the measured <apiId>|<childId> form', () => {
    expect(normalize(`${V2_API}|${childId}`)).toBe(childId);
  });

  it.each([
    ['the bare id the SDK route records', childId],
    // The real measured ids, swapped.
    ['the reversed <childId>|<apiId> order', `${childId}|${V2_API}`],
    ['an empty child segment', `${V2_API}|`],
    ['an empty API segment', `|${childId}`],
    ['an API id one character short', `${V2_API.slice(1)}|${childId}`],
    ['an API id one character long', `${V2_API}x|${childId}`],
    ['an extra segment', `${V2_API}|${childId}|x`],
    ['an uppercase child id', `${V2_API}|${childId.toUpperCase()}`],
    ['an id carrying a newline', `${V2_API}|${childId}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => normalize(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => normalize('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('apiGatewayV2AuthorizerSdkPhysicalId', () => {
  it('keeps the authorizer id of the measured <authorizerId>|<apiId> form', () => {
    expect(apiGatewayV2AuthorizerSdkPhysicalId(`fhvgo9|${V2_API}`)).toBe('fhvgo9');
  });

  it.each([
    ['the bare id the SDK route records', 'fhvgo9'],
    // The order its siblings and the committed schema fixture use.
    ['the reversed <apiId>|<authorizerId> order', `${V2_API}|fhvgo9`],
    ['an empty authorizer segment', `|${V2_API}`],
    ['an empty API segment', 'fhvgo9|'],
    ['an API id one character short', `fhvgo9|${V2_API.slice(1)}`],
    ['an API id one character long', `fhvgo9|${V2_API}x`],
    ['an extra segment', `fhvgo9|${V2_API}|x`],
    ['an uppercase id', `FHVGO9|${V2_API}`],
    ['an id carrying a newline', `fhvgo9|${V2_API}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayV2AuthorizerSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayV2AuthorizerSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('apiGatewayV2StageSdkPhysicalId', () => {
  it.each([
    ['the measured form', `${V2_API}|cdkdmeasure`, 'cdkdmeasure'],
    ['the measured $default stage', 'j4qslfc9hj|$default', '$default'],
    ['a name with hyphens, underscores and capitals', `${V2_API}|Prod_v-2`, 'Prod_v-2'],
  ])('keeps the stage name of %s', (_label, ccId, sdkId) => {
    expect(apiGatewayV2StageSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare name the SDK route records', 'cdkdmeasure'],
    ['the reversed <stageName>|<apiId> order', `reroute|${V2_API}`],
    ['the reversed order with $default', `$default|${V2_API}`],
    ['an empty stage segment', `${V2_API}|`],
    ['an empty API segment', '|prod'],
    ['an extra segment', `${V2_API}|prod|x`],
    ['an API id one character short', `${V2_API.slice(1)}|prod`],
    ['an uppercase API id', `${V2_API.toUpperCase()}|prod`],
    ['a dollar sign other than $default', `${V2_API}|$prod`],
    ['a stage name with a slash', `${V2_API}|a/b`],
    ['a stage name carrying a newline', `${V2_API}|prod\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayV2StageSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayV2StageSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

// Measured (us-east-1, 2026-11-17).
const GQL_ID = 'bebeljql55ecvbv2bfs4vg3wha';
const GQL_ARN = `arn:aws:appsync:us-east-1:123456789012:apis/${GQL_ID}`;

describe('appSyncGraphQLApiSdkPhysicalId', () => {
  it.each([
    ['the measured ARN', GQL_ARN, GQL_ID],
    ['a GovCloud ARN', `arn:aws-us-gov:appsync:us-gov-west-1:123456789012:apis/${GQL_ID}`, GQL_ID],
  ])('keeps the API id of %s', (_label, ccId, sdkId) => {
    expect(appSyncGraphQLApiSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare id the SDK route records', GQL_ID],
    ['a child type ARN', `${GQL_ARN}/types/Query`],
    ['an API id one character short', GQL_ARN.slice(0, -1)],
    ['an API id one character long', `${GQL_ARN}x`],
    ['an uppercase API id', GQL_ARN.toUpperCase()],
    ['another service', GQL_ARN.replace(':appsync:', ':s3vectors:')],
    ['a partition that is not one', GQL_ARN.replace('arn:aws:', 'arn:awsfoo:')],
    ['a partition with an empty suffix', GQL_ARN.replace('arn:aws:', 'arn:aws-:')],
    ['an endpoint ARN', 'arn:aws:appsync:us-east-1:123456789012:endpoints/graphql-api/5yvlgolsc5bgvkmbp546coh2j4'],
    ['a short account id', GQL_ARN.replace('123456789012', '12345678901')],
    ['a composite', `${GQL_ARN}|x`],
    ['an ARN carrying a newline', `${GQL_ARN}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => appSyncGraphQLApiSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => appSyncGraphQLApiSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

const VB_ARN = 'arn:aws:s3vectors:us-east-1:123456789012:bucket/cdkd-measure-6490-b8-vb';

describe('s3VectorsVectorBucketSdkPhysicalId', () => {
  it.each([
    ['the measured ARN', VB_ARN, 'cdkd-measure-6490-b8-vb'],
    ['a three-character name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/a1b', 'a1b'],
    ['a China-partition ARN', 'arn:aws-cn:s3vectors:cn-north-1:123456789012:bucket/a1b', 'a1b'],
    // Measured accepted by CreateVectorBucket (us-east-1, 2026-11-17).
    [
      'a dotted name',
      'arn:aws:s3vectors:us-east-1:123456789012:bucket/cdkd-measure-6490.dot-11427',
      'cdkd-measure-6490.dot-11427',
    ],
  ])('keeps the bucket name of %s', (_label, ccId, sdkId) => {
    expect(s3VectorsVectorBucketSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare name the SDK route records', 'cdkd-measure-6490-b8-vb'],
    ['an index ARN', `${VB_ARN}/index/idx`],
    ['a two-character name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/ab'],
    ['a name ending in a hyphen', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/abc-'],
    ['an uppercase name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/ABC'],
    ['an empty name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/'],
    ['a name with a slash', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/ab/c'],
    ['a name ending in a dot', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/abc.'],
    ['a sixty-four-character name', `arn:aws:s3vectors:us-east-1:123456789012:bucket/${'a'.repeat(64)}`],
    ['an S3 bucket ARN', 'arn:aws:s3:::cdkd-measure-6490-b8-vb'],
    ['a partition that is not one', VB_ARN.replace('arn:aws:', 'arn:awsfoo:')],
    ['a composite', `${VB_ARN}|x`],
    ['an ARN carrying a newline', `${VB_ARN}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => s3VectorsVectorBucketSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => s3VectorsVectorBucketSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

// Measured us-east-1, 2026-11-17 (throwaway `cdkd-measure-6490-b10-*`).
const ACL_ID = '20803c2a-0b8f-4df4-a600-11eda6efc69b';
const ACL_NAME = 'cdkd-measure-6490-b10-acl';
const ACL_CC_ID = `${ACL_NAME}|${ACL_ID}|REGIONAL`;
const ACL_ARN = `arn:aws:wafv2:us-east-1:123456789012:regional/webacl/${ACL_NAME}/${ACL_ID}`;
const CF_ACL_ID = '21127f57-a066-4e02-8a71-b96b4222a6dd';
const CF_ACL_NAME = 'cdkd-measure-6490-b10-cfacl';
const REPO_ID = 'b4019a38-d7a8-4176-96f0-f53991fd3c5a';
const REPO_NAME = 'cdkd-measure-6490-b10-repo';

function ctx(properties: Record<string, unknown>, over: Partial<CcPhysicalIdContext> = {}): CcPhysicalIdContext {
  return { properties, region: 'us-east-1', accountId: '123456789012', partition: 'aws', ...over };
}

describe('wafv2WebAclSdkPhysicalId', () => {
  it('builds the measured REGIONAL ARN from <Name>|<Id>|<Scope>', () => {
    expect(wafv2WebAclSdkPhysicalId(ACL_CC_ID, ctx({ Name: ACL_NAME, Scope: 'REGIONAL' }))).toBe(ACL_ARN);
  });

  it('builds the measured CLOUDFRONT (global) ARN in us-east-1', () => {
    expect(
      wafv2WebAclSdkPhysicalId(
        `${CF_ACL_NAME}|${CF_ACL_ID}|CLOUDFRONT`,
        ctx({ Name: CF_ACL_NAME, Scope: 'CLOUDFRONT' })
      )
    ).toBe(`arn:aws:wafv2:us-east-1:123456789012:global/webacl/${CF_ACL_NAME}/${CF_ACL_ID}`);
  });

  it('accepts a record whose Name is generated (absent from its properties)', () => {
    expect(wafv2WebAclSdkPhysicalId(ACL_CC_ID, ctx({ Scope: 'REGIONAL' }))).toBe(ACL_ARN);
  });

  it('builds the ARN in the record region, account and partition', () => {
    expect(
      wafv2WebAclSdkPhysicalId(
        ACL_CC_ID,
        ctx({ Scope: 'REGIONAL' }, { region: 'us-gov-west-1', accountId: '210987654321', partition: 'aws-us-gov' })
      )
    ).toBe(`arn:aws-us-gov:wafv2:us-gov-west-1:210987654321:regional/webacl/${ACL_NAME}/${ACL_ID}`);
  });

  it('accepts an underscore in the name, as the WAFv2 name pattern does', () => {
    expect(wafv2WebAclSdkPhysicalId(`a_b|${ACL_ID}|REGIONAL`, ctx({ Scope: 'REGIONAL' }))).toBe(
      `arn:aws:wafv2:us-east-1:123456789012:regional/webacl/a_b/${ACL_ID}`
    );
  });

  it.each([
    ['the ARN the SDK provider records', ACL_ARN],
    ['the id first', `${ACL_ID}|${ACL_NAME}|REGIONAL`],
    ['the scope first', `REGIONAL|${ACL_NAME}|${ACL_ID}`],
    ['the scope in the middle', `${ACL_NAME}|REGIONAL|${ACL_ID}`],
    ['a lowercase scope', `${ACL_NAME}|${ACL_ID}|regional`],
    ['an unknown scope', `${ACL_NAME}|${ACL_ID}|GLOBAL`],
    ['an uppercase id', `${ACL_NAME}|${ACL_ID.toUpperCase()}|REGIONAL`],
    ['a truncated id', `${ACL_NAME}|${ACL_ID.slice(0, -1)}|REGIONAL`],
    ['two segments', `${ACL_NAME}|${ACL_ID}`],
    ['a fourth segment', `${ACL_CC_ID}|x`],
    ['a name with a dot', `a.b|${ACL_ID}|REGIONAL`],
    ['a 129-character name', `${'a'.repeat(129)}|${ACL_ID}|REGIONAL`],
    ['an empty name', `|${ACL_ID}|REGIONAL`],
    ['a trailing newline', `${ACL_CC_ID}\n`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => wafv2WebAclSdkPhysicalId(ccId, ctx({ Scope: 'REGIONAL' }))).toThrow(
      /not the `<Name>\|<Id>\|<Scope>` form/
    );
  });

  it('refuses a Scope the record does not declare', () => {
    expect(() => wafv2WebAclSdkPhysicalId(ACL_CC_ID, ctx({ Scope: 'CLOUDFRONT' }))).toThrow(/scope/);
    expect(() => wafv2WebAclSdkPhysicalId(ACL_CC_ID, ctx({}))).toThrow(/scope/);
  });

  it('refuses a Name other than the one the record declares', () => {
    expect(() =>
      wafv2WebAclSdkPhysicalId(ACL_CC_ID, ctx({ Name: 'another-acl', Scope: 'REGIONAL' }))
    ).toThrow(/name in its recorded physical id/);
    // A masked or unresolved secret-derived name is a mismatch too.
    expect(() => wafv2WebAclSdkPhysicalId(ACL_CC_ID, ctx({ Name: '***', Scope: 'REGIONAL' }))).toThrow(
      /name in its recorded physical id/
    );
  });

  it('refuses a CLOUDFRONT web ACL outside us-east-1', () => {
    expect(() =>
      wafv2WebAclSdkPhysicalId(
        `${CF_ACL_NAME}|${CF_ACL_ID}|CLOUDFRONT`,
        ctx({ Scope: 'CLOUDFRONT' }, { region: 'eu-west-1' })
      )
    ).toThrow(/only from us-east-1/);
  });

  it.each([
    ['a non-AWS partition', { partition: 'gcp' }],
    ['a short account id', { accountId: '12345' }],
    ['a region carrying a colon', { region: 'us-east-1:x' }],
  ])('refuses to build an ARN in %s', (_label, over) => {
    expect(() => wafv2WebAclSdkPhysicalId(ACL_CC_ID, ctx({ Scope: 'REGIONAL' }, over))).toThrow(
      /not an AWS partition|not a 12-digit account id|not a region name/
    );
  });

  it('does not echo the id it refuses', () => {
    expect(() => wafv2WebAclSdkPhysicalId('supersecret', ctx({ Scope: 'REGIONAL' }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('codeCommitRepositorySdkPhysicalId', () => {
  it('keeps the RepositoryName the record holds for the measured RepositoryId', () => {
    expect(codeCommitRepositorySdkPhysicalId(REPO_ID, ctx({ RepositoryName: REPO_NAME }))).toBe(REPO_NAME);
  });

  it('accepts dots and underscores in the name, as CodeCommit does', () => {
    expect(codeCommitRepositorySdkPhysicalId(REPO_ID, ctx({ RepositoryName: 'a.b_c-d' }))).toBe('a.b_c-d');
  });

  it.each([
    ['the repository name', REPO_NAME],
    ['the repository ARN', `arn:aws:codecommit:us-east-1:123456789012:${REPO_NAME}`],
    ['an uppercase UUID', REPO_ID.toUpperCase()],
    ['a UUID without hyphens', REPO_ID.replace(/-/g, '')],
    ['a composite', `${REPO_ID}|${REPO_NAME}`],
    ['a trailing newline', `${REPO_ID}\n`],
    ['an empty string', ''],
  ])('refuses %s as the Cloud Control id', (_label, ccId) => {
    expect(() => codeCommitRepositorySdkPhysicalId(ccId, ctx({ RepositoryName: REPO_NAME }))).toThrow(
      /not the RepositoryId/
    );
  });

  it.each([
    ['no RepositoryName', {}],
    ['a non-string RepositoryName', { RepositoryName: 42 }],
    ['an empty RepositoryName', { RepositoryName: '' }],
    ['the redaction mask', { RepositoryName: '***' }],
    ['an unresolved dynamic reference', { RepositoryName: '{{resolve:ssm:/repo/name}}' }],
    ['a 101-character name', { RepositoryName: 'a'.repeat(101) }],
    ['a name with a slash', { RepositoryName: 'a/b' }],
  ])('refuses a record with %s', (_label, properties) => {
    expect(() => codeCommitRepositorySdkPhysicalId(REPO_ID, ctx(properties))).toThrow(
      /no plain RepositoryName/
    );
  });

  it('does not echo the id it refuses', () => {
    expect(() => codeCommitRepositorySdkPhysicalId('supersecret', ctx({ RepositoryName: REPO_NAME }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

/** `sdkAddressedPhysicalId` over a record built from its parts. */
const addressed = (
  resourceType: string,
  physicalId: string,
  logicalId: string,
  record: { properties: ResourceState['properties'] | undefined; region: string }
) =>
  sdkAddressedPhysicalId(
    { resourceType, physicalId, properties: record.properties as ResourceState['properties'] },
    logicalId,
    record.region
  );

const REGION_ONLY = { properties: {}, region: 'us-east-1' };

describe('sdkAddressedPhysicalId', () => {
  beforeEach(() => {
    accountLookup.getAccountInfo.mockClear();
  });

  it('is the ECS::Service entry normalizer', async () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::ECS::Service')?.normalizeCcPhysicalId).toBe(
      ecsServiceSdkPhysicalId
    );
    await expect(addressed('AWS::ECS::Service', `${LONG}|my-cluster`, 'Svc', REGION_ONLY)).resolves.toBe(
      LONG
    );
  });

  it.each([
    ['AWS::ApiGateway::Authorizer', apiGatewayAuthorizerSdkPhysicalId, 'mm525t8176|yj4gsv', 'yj4gsv'],
    ['AWS::ApiGateway::Stage', apiGatewayStageSdkPhysicalId, 'mm525t8176|prod', 'prod'],
    ['AWS::ApiGatewayV2::Stage', apiGatewayV2StageSdkPhysicalId, `${V2_API}|cdkdmeasure`, 'cdkdmeasure'],
    ['AWS::ApiGatewayV2::Integration', apiGatewayV2IntegrationSdkPhysicalId, `${V2_API}|c1m2ghk`, 'c1m2ghk'],
    ['AWS::ApiGatewayV2::Route', apiGatewayV2RouteSdkPhysicalId, `${V2_API}|m036gwk`, 'm036gwk'],
    ['AWS::ApiGatewayV2::Authorizer', apiGatewayV2AuthorizerSdkPhysicalId, `fhvgo9|${V2_API}`, 'fhvgo9'],
    ['AWS::AppSync::GraphQLApi', appSyncGraphQLApiSdkPhysicalId, GQL_ARN, GQL_ID],
    ['AWS::S3Vectors::VectorBucket', s3VectorsVectorBucketSdkPhysicalId, VB_ARN, 'cdkd-measure-6490-b8-vb'],
  ])('is the %s entry normalizer', async (type, normalizer, ccId, sdkId) => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get(type)?.normalizeCcPhysicalId).toBe(normalizer);
    await expect(addressed(type, ccId, 'R', REGION_ONLY)).resolves.toBe(sdkId);
  });

  it('hands the WAFv2 normalizer the record properties and the region, account and partition', async () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::WAFv2::WebACL')?.normalizeCcPhysicalId).toBe(
      wafv2WebAclSdkPhysicalId
    );
    await expect(
      addressed('AWS::WAFv2::WebACL', ACL_CC_ID, 'Acl', {
        properties: { Name: ACL_NAME, Scope: 'REGIONAL' },
        region: 'us-gov-west-1',
      })
    ).resolves.toBe(`arn:aws-us-gov:wafv2:us-gov-west-1:123456789012:regional/webacl/${ACL_NAME}/${ACL_ID}`);
    // The account is asked for in the RECORD's region.
    expect(accountLookup.getAccountInfo).toHaveBeenCalledWith('us-gov-west-1');
  });

  it('hands the CodeCommit normalizer the record RepositoryName', async () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::CodeCommit::Repository')?.normalizeCcPhysicalId).toBe(
      codeCommitRepositorySdkPhysicalId
    );
    await expect(
      addressed('AWS::CodeCommit::Repository', REPO_ID, 'Repo', {
        properties: { RepositoryName: REPO_NAME },
        region: 'us-east-1',
      })
    ).resolves.toBe(REPO_NAME);
  });

  it('reads an absent record bag as empty, so a properties-reading normalizer refuses', async () => {
    await expect(
      addressed('AWS::CodeCommit::Repository', REPO_ID, 'Repo', {
        properties: undefined,
        region: 'us-east-1',
      })
    ).rejects.toThrow(/^Repo \(AWS::CodeCommit::Repository\) cannot move .*no plain RepositoryName.*--pin-cc-api Repo/);
  });

  it('passes the parity AWS::ApiGateway::Method composite through unchanged', async () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::ApiGateway::Method')?.normalizeCcPhysicalId).toBeUndefined();
    await expect(
      addressed('AWS::ApiGateway::Method', 'mm525t8176|0gqhttf0ej|GET', 'M', REGION_ONLY)
    ).resolves.toBe('mm525t8176|0gqhttf0ej|GET');
  });

  it('passes a parity type through unchanged, whatever its shape, without asking for the account', async () => {
    await expect(addressed('AWS::SNS::Topic', 'a|b', 'T', REGION_ONLY)).resolves.toBe('a|b');
    await expect(addressed('AWS::S3::Bucket', 'not-exempt', 'B', REGION_ONLY)).resolves.toBe(
      'not-exempt'
    );
    expect(accountLookup.getAccountInfo).not.toHaveBeenCalled();
  });

  it('asks for the account only for an entry whose normalizer reads it', async () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::WAFv2::WebACL')?.normalizerReadsAccountId).toBe(true);
    const readers = [...STICKY_CC_MIGRATION_EXEMPT].filter(([, e]) => e.normalizerReadsAccountId === true);
    expect(readers.map(([type]) => type)).toEqual(['AWS::WAFv2::WebACL']);
    // An STS refusal never blocks the flip of a type whose normalizer does not read the account.
    accountLookup.getAccountInfo.mockRejectedValue(new Error('STS is unreachable'));
    try {
      await expect(addressed('AWS::ECS::Service', `${LONG}|my-cluster`, 'Svc', REGION_ONLY)).resolves.toBe(LONG);
      await expect(
        addressed('AWS::CodeCommit::Repository', REPO_ID, 'Repo', {
          properties: { RepositoryName: REPO_NAME },
          region: 'us-east-1',
        })
      ).resolves.toBe(REPO_NAME);
      expect(accountLookup.getAccountInfo).not.toHaveBeenCalled();
    } finally {
      accountLookup.getAccountInfo.mockReset();
      accountLookup.getAccountInfo.mockImplementation(async (region?: string) => ({
        accountId: '123456789012',
        region: region ?? 'us-east-1',
        partition: 'aws',
      }));
    }
  });

  it("takes the partition from the record's region", async () => {
    await expect(
      addressed('AWS::WAFv2::WebACL', ACL_CC_ID, 'Acl', {
        properties: { Scope: 'REGIONAL' },
        region: 'cn-north-1',
      })
    ).resolves.toBe(`arn:aws-cn:wafv2:cn-north-1:123456789012:regional/webacl/${ACL_NAME}/${ACL_ID}`);
  });

  it('names the resource and the --pin-cc-api remedy on a refusal', async () => {
    await expect(
      addressed('AWS::ECS::Service', `${CLUSTER_ARN}|my-service`, 'Svc', REGION_ONLY)
    ).rejects.toThrow(
      /^Svc \(AWS::ECS::Service\) cannot move from Cloud Control to its SDK provider: .*Pass --pin-cc-api Svc to keep it on Cloud Control\.$/
    );
  });

  it('throws a failed account lookup as it is, with its own class, not as an id refusal', async () => {
    const lookupFailure = new AccountIdUnavailableError('Cannot determine the AWS account id: token expired');
    accountLookup.getAccountInfo.mockRejectedValueOnce(lookupFailure);
    const outcome = await addressed('AWS::WAFv2::WebACL', ACL_CC_ID, 'Acl', {
      properties: { Scope: 'REGIONAL' },
      region: 'us-east-1',
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(outcome).toBe(lookupFailure);
    expect(String((outcome as Error).message)).not.toContain('--pin-cc-api');
  });

  it.each([
    ['an id of another shape', ACL_ARN, { Scope: 'REGIONAL' }],
    ['a Scope the record does not declare', ACL_CC_ID, { Scope: 'CLOUDFRONT' }],
    ['a Name the record does not declare', ACL_CC_ID, { Name: 'other', Scope: 'REGIONAL' }],
  ])('refuses %s before asking STS', async (_label, ccId, properties) => {
    await expect(
      addressed('AWS::WAFv2::WebACL', ccId, 'Acl', { properties, region: 'us-east-1' })
    ).rejects.toThrow(/^Acl \(AWS::WAFv2::WebACL\) cannot move .*--pin-cc-api Acl/);
    expect(accountLookup.getAccountInfo).not.toHaveBeenCalled();
  });

  it('builds the ARN with the resolved account, never the placeholder', async () => {
    await expect(
      addressed('AWS::WAFv2::WebACL', ACL_CC_ID, 'Acl', { properties: { Scope: 'REGIONAL' }, region: 'us-east-1' })
    ).resolves.toBe(ACL_ARN);
    expect(accountLookup.getAccountInfo).toHaveBeenCalledTimes(1);
  });
});

describe('assertSdkReadMatchesCcId (go-to-k/cdkd#6490)', () => {
  const repo = { resourceType: 'AWS::CodeCommit::Repository', physicalId: REPO_ID };

  it('passes a read whose RepositoryId is the recorded Cloud Control id', () => {
    expect(() => assertSdkReadMatchesCcId(repo, 'Repo', { RepositoryId: REPO_ID })).not.toThrow();
  });

  it.each([
    ['another repository holding the name', { RepositoryId: 'd26c8cf1-5737-4ea9-8820-394b84eb5bc7' }],
    ['no RepositoryId', {}],
  ])('refuses %s, naming the resource and --pin-cc-api', (_label, attributes) => {
    expect(() => assertSdkReadMatchesCcId(repo, 'Repo', attributes)).toThrow(
      /^Repo \(AWS::CodeCommit::Repository\) cannot move .*RepositoryId Cloud Control recorded\. Pass --pin-cc-api Repo/
    );
  });

  it('is a no-op for an entry with no identity attribute', () => {
    expect(() =>
      assertSdkReadMatchesCcId({ resourceType: 'AWS::WAFv2::WebACL', physicalId: ACL_CC_ID }, 'Acl', {})
    ).not.toThrow();
  });
});

describe('sdkAddressedRecord (go-to-k/cdkd#6490)', () => {
  const base = { attributes: { Arn: 'a' }, dependencies: [], provisionedBy: 'cc-api' };

  it("sets a CodeCommit record's RepositoryId to the Cloud Control id, over a masked or absent one", async () => {
    for (const attributes of [{ Arn: 'a' }, { Arn: 'a', RepositoryId: '***' }]) {
      const record = {
        ...base,
        attributes,
        physicalId: REPO_ID,
        resourceType: 'AWS::CodeCommit::Repository',
        properties: { RepositoryName: REPO_NAME },
      } as unknown as ResourceState;
      await expect(sdkAddressedRecord(record, 'Repo', 'us-east-1')).resolves.toMatchObject({
        physicalId: REPO_NAME,
        attributes: { Arn: 'a', RepositoryId: REPO_ID },
      });
    }
  });

  it('leaves the attributes of a type with no identity attribute alone', async () => {
    const record = {
      ...base,
      physicalId: `${LONG}|my-cluster`,
      resourceType: 'AWS::ECS::Service',
      properties: {},
    } as unknown as ResourceState;
    await expect(sdkAddressedRecord(record, 'Svc', 'us-east-1')).resolves.toEqual({ ...record, physicalId: LONG });
  });
});
