import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  paths,
  setOutputOverrides,
  type Bag,
  type TypeCase,
} from './sdk-wire-harness.js';
import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';

/**
 * The batch-8 CloudFront wire case (#3723): `AWS::CloudFront::Distribution`.
 *
 * `CreateDistribution` carries a cdkd-minted `CallerReference`
 * (`acquireIdempotencyToken`, retired per successful create), so the runner
 * pins that helper to one fixed token per (scope, logical id), as batch 5 does.
 *
 * The update is a read-modify-write (cloudfront-distribution-provider.ts:504-531):
 * `GetDistributionConfig` answers the live config (the PREVIOUS bag, in SDK
 * shape) and its ETag, and the template overwrites every top-level member it
 * carries (`mergeUpdateConfig`, :1078-1115).
 */

const ID = 'E1ABCDEF';
const ARN = `arn:aws:cloudfront::${ACCOUNT}:distribution/${ID}`;

type Converter = {
  convertToSdkFormat(config: Record<string, unknown>): Record<string, unknown>;
};

/**
 * The live distribution `bag` describes: its config in SDK shape (the
 * provider's own CFn -> SDK conversion, what CloudFront would hold), a fixed
 * ETag and CallerReference, and a deployed distribution with its ARN for the
 * tag diff.
 *
 * Because the live config IS `prev`, a top-level `update-remove` probe cannot
 * tell a reset from a member left at its live value: both differ from the
 * `update(reduced, reduced)` side. The reset to `REMOVAL_RESET_DEFAULTS` is
 * pinned in `cloudfront-distribution-provider.test.ts`; a member with no
 * schema-documented default (AnycastIpListId, CacheTagConfig,
 * ConnectionFunctionAssociation, ConnectionMode, ContinuousDeploymentPolicyId,
 * IPV6Enabled, Staging, TenantConfig, ViewerMtlsConfig) keeps its live value
 * with a warning by design (cloudfront-distribution-provider.ts:127-131), the
 * absent-field removal class tracked by go-to-k/cdkd#1160.
 */
function armDistribution(bag: Bag): void {
  const convert = new CloudFrontDistributionProvider() as unknown as Converter;
  const config = (bag['DistributionConfig'] as Record<string, unknown> | undefined) ?? {};
  setOutputOverrides({
    GetDistributionConfigCommand: () => ({
      ETag: 'etag-1',
      DistributionConfig: {
        ...convert.convertToSdkFormat(config),
        CallerReference: 'ref-1',
      },
    }),
    GetDistributionCommand: () => ({
      Distribution: {
        Id: ID,
        ARN,
        DomainName: 'd111.cloudfront.net',
        Status: 'Deployed',
      },
    }),
  });
}

const behavior = {
  // Not the GET/HEAD the update fills in (cloudfront-distribution-provider.ts:1171-1188).
  AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
  CachedMethods: ['GET', 'HEAD', 'OPTIONS'],
  CachePolicyId: 'cp-1',
  Compress: true,
  DefaultTTL: 60,
  // Not the '' the update fills in (:1158).
  FieldLevelEncryptionId: 'fle-1',
  ForwardedValues: {
    Cookies: { Forward: 'whitelist', WhitelistedNames: ['c1', 'c2'] },
    Headers: ['h1', 'h2'],
    QueryString: true,
    QueryStringCacheKeys: ['q1', 'q2'],
  },
  FunctionAssociations: [
    {
      EventType: 'viewer-request',
      FunctionARN: `arn:aws:cloudfront::${ACCOUNT}:function/f1`,
    },
  ],
  GrpcConfig: { Enabled: true },
  LambdaFunctionAssociations: [
    {
      EventType: 'origin-request',
      IncludeBody: true,
      LambdaFunctionARN: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:l1:1`,
    },
  ],
  MaxTTL: 600,
  MinTTL: 1,
  OriginRequestPolicyId: 'orp-1',
  RealtimeLogConfigArn: `arn:aws:cloudfront::${ACCOUNT}:realtime-log-config/r1`,
  ResponseHeadersPolicyId: 'rhp-1',
  // Not the false the update fills in (:1157).
  SmoothStreaming: true,
  TargetOriginId: 'origin-1',
  TrustedKeyGroups: ['kg-1'],
  TrustedSigners: ['111111111111'],
  ViewerProtocolPolicy: 'redirect-to-https',
};

/**
 * Every modern DistributionConfig member, each list with two entries where a
 * removal names one. Unrealistic on purpose: members AWS accepts only one of
 * (ViewerCertificate's ACM / IAM / CloudFront-default certificate, an origin's
 * S3OriginConfig beside VpcOriginConfig) share the bag, so each is probed; a
 * union member the conversion dropped would still show as silent.
 */
const DISTRIBUTION_FULL: Bag = {
  DistributionConfig: {
    Aliases: ['alias-one.example.com', 'alias-two.example.com'],
    AnycastIpListId: 'aip-1',
    CacheBehaviors: [{ ...behavior, PathPattern: '/api/*' }],
    CacheTagConfig: { HeaderName: 'x-cache-tag' },
    // Not the '' a missing Comment is sent as (:1215-1218).
    Comment: 'c',
    ConnectionFunctionAssociation: { Id: 'cfa-1' },
    ConnectionMode: 'direct',
    ContinuousDeploymentPolicyId: 'cdp-1',
    CustomErrorResponses: [
      {
        ErrorCachingMinTTL: 10,
        ErrorCode: 404,
        ResponseCode: 200,
        ResponsePagePath: '/404.html',
      },
      {
        ErrorCachingMinTTL: 20,
        ErrorCode: 503,
        ResponseCode: 503,
        ResponsePagePath: '/503.html',
      },
    ],
    DefaultCacheBehavior: behavior,
    DefaultRootObject: 'index.html',
    Enabled: true,
    HttpVersion: 'http2and3',
    IPV6Enabled: true,
    // Neither the cookie / prefix defaults the conversion fills in (:1262-1268).
    Logging: {
      Bucket: 'logs.s3.amazonaws.com',
      IncludeCookies: true,
      Prefix: 'p/',
    },
    OriginGroups: {
      Quantity: 1,
      Items: [
        {
          Id: 'group-1',
          FailoverCriteria: { StatusCodes: { Quantity: 2, Items: [500, 502] } },
          Members: {
            Quantity: 2,
            Items: [{ OriginId: 'origin-1' }, { OriginId: 'origin-2' }],
          },
          SelectionCriteria: 'media-quality-based',
        },
      ],
    },
    Origins: [
      {
        ConnectionAttempts: 2,
        ConnectionTimeout: 5,
        // Neither the ports nor the timeouts the conversion / update fill in
        // (:1610-1618, :1147-1148).
        CustomOriginConfig: {
          HTTPPort: 8080,
          HTTPSPort: 8443,
          IpAddressType: 'dualstack',
          OriginKeepaliveTimeout: 6,
          OriginMtlsConfig: {
            ClientCertificateArn: `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/c1`,
          },
          OriginProtocolPolicy: 'https-only',
          OriginReadTimeout: 31,
          OriginSSLProtocols: ['TLSv1.2', 'TLSv1.1'],
        },
        DomainName: 'origin-one.example.com',
        Id: 'origin-1',
        OriginAccessControlId: 'oac-1',
        OriginCustomHeaders: [
          { HeaderName: 'x-h1', HeaderValue: 'v1' },
          { HeaderName: 'x-h2', HeaderValue: 'v2' },
        ],
        // Not the '' the update fills in (:1143).
        OriginPath: '/p',
        OriginShield: { Enabled: true, OriginShieldRegion: 'us-east-1' },
        ResponseCompletionTimeout: 40,
      },
      {
        DomainName: 'origin-two.s3.amazonaws.com',
        Id: 'origin-2',
        S3OriginConfig: {
          OriginAccessIdentity: 'origin-access-identity/cloudfront/o1',
          OriginReadTimeout: 32,
        },
        VpcOriginConfig: {
          OriginKeepaliveTimeout: 7,
          OriginReadTimeout: 33,
          OwnerAccountId: '222222222222',
          VpcOriginId: 'vo-1',
        },
      },
    ],
    PriceClass: 'PriceClass_100',
    Restrictions: {
      GeoRestriction: { Locations: ['JP', 'US'], RestrictionType: 'whitelist' },
    },
    Staging: true,
    TenantConfig: {
      ParameterDefinitions: [
        {
          Name: 'param-1',
          Definition: {
            StringSchema: { Comment: 'pc', DefaultValue: 'dv', Required: true },
          },
        },
      ],
    },
    ViewerCertificate: {
      AcmCertificateArn: `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/v1`,
      CloudFrontDefaultCertificate: true,
      IamCertificateId: 'iam-cert-1',
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    },
    ViewerMtlsConfig: {
      Mode: 'required',
      TrustStoreConfig: {
        AdvertiseTrustStoreCaNames: true,
        IgnoreCertificateExpiry: true,
        TrustStoreId: 'ts-1',
      },
    },
    WebACLId: `arn:aws:wafv2:us-east-1:${ACCOUNT}:global/webacl/w/1`,
  },
  Tags: [
    { Key: 'tag-a', Value: 'va' },
    { Key: 'tag-b', Value: 'vb' },
  ],
};

// Not a gap: the update sends each top-level DistributionConfig member the
// template carries WHOLE from `next` over the live config
// (`Object.assign(merged, templateSdk)`, cloudfront-distribution-provider.ts:1111),
// so a member's nested removal reaches the wire through `next` alone, as its
// update-add probe observes; `prev` is read only for a top-level member
// removed outright (:1089-1109).
const MEMBER_WHOLE_FROM_NEXT =
  'a carried DistributionConfig member is sent whole from next over the live config, so a nested removal is delivered by next alone (cloudfront-distribution-provider.ts:1089-1111)';

const nestedUpdateRemoves = Object.fromEntries(
  paths(DISTRIBUTION_FULL)
    .filter((p) => p[0] === 'DistributionConfig' && p.length > 2)
    .map((p) => [`update-remove:${p.join('.')}`, MEMBER_WHOLE_FROM_NEXT])
);

const LEGACY_ALLOW_LISTED =
  'a legacy pre-2012 DistributionConfig member the modern Create/UpdateDistribution API has no member for and CDK never synthesizes; allow-listed in scripts/gen-nested-key-coverage.ts:2355-2391';

export const CLOUDFRONT_CASES: TypeCase[] = [
  {
    resourceType: 'AWS::CloudFront::Distribution',
    provider: () => new CloudFrontDistributionProvider(),
    physicalId: ID,
    createOnly: createOnlyOf('AWS::CloudFront::Distribution'),
    arm: (_id, bag) => armDistribution(bag),
    exempt: {},
    nestedExempt: {
      'DistributionConfig.CNAMEs': LEGACY_ALLOW_LISTED,
      'DistributionConfig.CustomOrigin': LEGACY_ALLOW_LISTED,
      'DistributionConfig.CustomOrigin.DNSName': LEGACY_ALLOW_LISTED,
      'DistributionConfig.CustomOrigin.HTTPPort': LEGACY_ALLOW_LISTED,
      'DistributionConfig.CustomOrigin.HTTPSPort': LEGACY_ALLOW_LISTED,
      'DistributionConfig.CustomOrigin.OriginProtocolPolicy': LEGACY_ALLOW_LISTED,
      'DistributionConfig.CustomOrigin.OriginSSLProtocols': LEGACY_ALLOW_LISTED,
      'DistributionConfig.S3Origin': LEGACY_ALLOW_LISTED,
      'DistributionConfig.S3Origin.DNSName': LEGACY_ALLOW_LISTED,
      'DistributionConfig.S3Origin.OriginAccessIdentity': LEGACY_ALLOW_LISTED,
    },
    targets: [
      {
        path: ['Tags', 0],
        command: 'UntagResourceCommand',
        names: 'tag-a',
        notNames: 'tag-b',
      },
      {
        path: ['Tags', 1],
        command: 'UntagResourceCommand',
        names: 'tag-b',
        notNames: 'tag-a',
      },
      // UpdateDistribution re-sends each list from next: the removed element
      // must not ride along.
      {
        path: ['DistributionConfig', 'Aliases', 0],
        command: 'UpdateDistributionCommand',
        names: 'alias-two.example.com',
        notNames: 'alias-one.example.com',
      },
      {
        path: ['DistributionConfig', 'Origins', 0, 'OriginCustomHeaders', 0],
        command: 'UpdateDistributionCommand',
        names: 'x-h2',
        notNames: 'x-h1',
      },
    ],
    bags: [
      {
        name: 'every modern DistributionConfig member, tagged',
        bag: DISTRIBUTION_FULL,
        expectedSilent: {
          ...nestedUpdateRemoves,
          // Not a gap: a missing Comment is always sent as '' (its CFn default),
          // which overwrites the live value whatever the previous side held
          // (cloudfront-distribution-provider.ts:1068-1073, 1215-1218).
          'update-remove:DistributionConfig.Comment':
            "a missing Comment is always sent as its CFn default '', overwriting the live value whatever prev held (cloudfront-distribution-provider.ts:1068-1073, 1215-1218)",
        },
        expectedRemovalThrows: TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
      },
    ],
  },
];
