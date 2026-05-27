import { describe, expect, it } from 'vite-plus/test';
import {
  buildCorsConfigByApiId,
  buildCorsConfigFromCloudFrontChain,
  matchPreflight,
  type CorsConfig,
} from '../../../src/local/cors-handler.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

function tpl(resources: Record<string, TemplateResource>): CloudFormationTemplate {
  return { Resources: resources };
}

describe('buildCorsConfigByApiId', () => {
  it('extracts CorsConfiguration from AWS::ApiGatewayV2::Api', () => {
    const m = buildCorsConfigByApiId(
      tpl({
        Api: {
          Type: 'AWS::ApiGatewayV2::Api',
          Properties: {
            ProtocolType: 'HTTP',
            CorsConfiguration: {
              AllowOrigins: ['https://example.com'],
              AllowMethods: ['GET', 'POST'],
              AllowHeaders: ['Content-Type'],
              ExposeHeaders: ['X-Trace-Id'],
              MaxAge: 600,
              AllowCredentials: true,
            },
          },
        },
      })
    );
    const cors = m.get('Api');
    expect(cors).toBeDefined();
    expect(cors!.AllowOrigins).toEqual(['https://example.com']);
    expect(cors!.AllowMethods).toEqual(['GET', 'POST']);
    expect(cors!.MaxAge).toBe(600);
    expect(cors!.AllowCredentials).toBe(true);
  });

  it('skips APIs without CorsConfiguration', () => {
    const m = buildCorsConfigByApiId(
      tpl({
        Api: {
          Type: 'AWS::ApiGatewayV2::Api',
          Properties: { ProtocolType: 'HTTP' },
        },
      })
    );
    expect(m.size).toBe(0);
  });

  it('skips REST v1 RestApi resources (not in scope)', () => {
    const m = buildCorsConfigByApiId(
      tpl({
        RestApi: {
          Type: 'AWS::ApiGateway::RestApi',
          Properties: { Name: 'A' },
        },
      })
    );
    expect(m.size).toBe(0);
  });

  it('returns empty when CorsConfiguration is fully blank', () => {
    const m = buildCorsConfigByApiId(
      tpl({
        Api: {
          Type: 'AWS::ApiGatewayV2::Api',
          Properties: { ProtocolType: 'HTTP', CorsConfiguration: {} },
        },
      })
    );
    expect(m.size).toBe(0);
  });

  // Issue #644: Function URL Cors block extraction. The CFn schema for
  // AWS::Lambda::Url.Cors is field-for-field identical to HTTP API v2's
  // CorsConfiguration, so the same parser handles both.
  describe('AWS::Lambda::Url.Cors (issue #644)', () => {
    it('extracts Cors from AWS::Lambda::Url', () => {
      const m = buildCorsConfigByApiId(
        tpl({
          Url: {
            Type: 'AWS::Lambda::Url',
            Properties: {
              AuthType: 'AWS_IAM',
              TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] },
              Cors: {
                AllowOrigins: ['http://127.0.0.1:5050'],
                AllowMethods: ['POST'],
                AllowHeaders: ['Authorization', 'Content-Type'],
                AllowCredentials: true,
                MaxAge: 600,
              },
            },
          },
        })
      );
      const cors = m.get('Url');
      expect(cors).toBeDefined();
      expect(cors?.AllowOrigins).toEqual(['http://127.0.0.1:5050']);
      expect(cors?.AllowMethods).toEqual(['POST']);
      expect(cors?.AllowHeaders).toEqual(['Authorization', 'Content-Type']);
      expect(cors?.AllowCredentials).toBe(true);
      expect(cors?.MaxAge).toBe(600);
    });

    it('skips Function URLs without a Cors block', () => {
      const m = buildCorsConfigByApiId(
        tpl({
          Url: {
            Type: 'AWS::Lambda::Url',
            Properties: { AuthType: 'NONE', TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
          },
        })
      );
      expect(m.size).toBe(0);
    });

    it('returns empty for a Function URL with a fully blank Cors block', () => {
      const m = buildCorsConfigByApiId(
        tpl({
          Url: {
            Type: 'AWS::Lambda::Url',
            Properties: {
              AuthType: 'NONE',
              TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] },
              Cors: {},
            },
          },
        })
      );
      expect(m.size).toBe(0);
    });

    it('merges Function URL entries with HTTP API v2 entries (different logical IDs)', () => {
      const m = buildCorsConfigByApiId(
        tpl({
          HttpApi: {
            Type: 'AWS::ApiGatewayV2::Api',
            Properties: {
              ProtocolType: 'HTTP',
              CorsConfiguration: { AllowOrigins: ['*'] },
            },
          },
          FnUrl: {
            Type: 'AWS::Lambda::Url',
            Properties: {
              AuthType: 'NONE',
              TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] },
              Cors: { AllowOrigins: ['http://localhost:3000'] },
            },
          },
        })
      );
      expect(m.size).toBe(2);
      expect(m.get('HttpApi')?.AllowOrigins).toEqual(['*']);
      expect(m.get('FnUrl')?.AllowOrigins).toEqual(['http://localhost:3000']);
    });

    it('tolerates a malformed Cors block (non-object) without throwing', () => {
      const m = buildCorsConfigByApiId(
        tpl({
          Url: {
            Type: 'AWS::Lambda::Url',
            Properties: {
              AuthType: 'NONE',
              TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] },
              Cors: 'not-an-object',
            },
          },
        })
      );
      expect(m.size).toBe(0);
    });
  });
});

// Issue #646: CloudFront ResponseHeadersPolicy CORS borrowed for the
// fronted Function URL. The canonical production-correct CDK pattern
// puts CORS on the edge (CloudFront), not on the origin (Function URL).
describe('buildCorsConfigFromCloudFrontChain (issue #646)', () => {
  function fnUrlOriginDomainName(fnUrlLogicalId: string): unknown {
    return {
      'Fn::Select': [
        2,
        {
          'Fn::Split': ['/', { 'Fn::GetAtt': [fnUrlLogicalId, 'FunctionUrl'] }],
        },
      ],
    };
  }

  function rhpResource(corsConfig: unknown): TemplateResource {
    return {
      Type: 'AWS::CloudFront::ResponseHeadersPolicy',
      Properties: {
        ResponseHeadersPolicyConfig: { CorsConfig: corsConfig, Name: 'rhp' },
      },
    };
  }

  function distributionResource(args: {
    fnUrlLogicalId: string;
    rhpLogicalId?: string;
  }): TemplateResource {
    return {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Origins: [
            {
              DomainName: fnUrlOriginDomainName(args.fnUrlLogicalId),
              Id: 'origin-1',
            },
          ],
          DefaultCacheBehavior: {
            TargetOriginId: 'origin-1',
            ...(args.rhpLogicalId !== undefined && {
              ResponseHeadersPolicyId: { Ref: args.rhpLogicalId },
            }),
          },
        },
      },
    };
  }

  it('extracts CORS from a CloudFront → Function URL chain', () => {
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        FnUrl: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'AWS_IAM', TargetFunctionArn: { Ref: 'Fn' } },
        },
        Dist: distributionResource({ fnUrlLogicalId: 'FnUrl', rhpLogicalId: 'Rhp' }),
        Rhp: rhpResource({
          AccessControlAllowOrigins: { Items: ['http://127.0.0.1:5050', 'https://dev.example.com'] },
          AccessControlAllowMethods: { Items: ['POST'] },
          AccessControlAllowHeaders: { Items: ['authorization', 'content-type'] },
          AccessControlAllowCredentials: false,
          AccessControlMaxAgeSec: 600,
          OriginOverride: true,
        }),
      })
    );
    const cors = m.get('FnUrl');
    expect(cors).toBeDefined();
    expect(cors?.AllowOrigins).toEqual(['http://127.0.0.1:5050', 'https://dev.example.com']);
    expect(cors?.AllowMethods).toEqual(['POST']);
    expect(cors?.AllowHeaders).toEqual(['authorization', 'content-type']);
    expect(cors?.AllowCredentials).toBe(false);
    expect(cors?.MaxAge).toBe(600);
  });

  it('returns empty when the CloudFront distribution has no ResponseHeadersPolicy', () => {
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        FnUrl: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'Fn' } },
        },
        Dist: distributionResource({ fnUrlLogicalId: 'FnUrl' }),
      })
    );
    expect(m.size).toBe(0);
  });

  it('returns empty when the ResponseHeadersPolicy has no CorsConfig', () => {
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        FnUrl: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'Fn' } },
        },
        Dist: distributionResource({ fnUrlLogicalId: 'FnUrl', rhpLogicalId: 'Rhp' }),
        Rhp: {
          Type: 'AWS::CloudFront::ResponseHeadersPolicy',
          Properties: { ResponseHeadersPolicyConfig: { Name: 'rhp' } },
        },
      })
    );
    expect(m.size).toBe(0);
  });

  it('ignores CloudFront distributions whose origin is not a Function URL', () => {
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Dist: {
          Type: 'AWS::CloudFront::Distribution',
          Properties: {
            DistributionConfig: {
              Origins: [{ DomainName: 'static.example.com.s3.amazonaws.com', Id: 'origin-1' }],
              DefaultCacheBehavior: {
                TargetOriginId: 'origin-1',
                ResponseHeadersPolicyId: { Ref: 'Rhp' },
              },
            },
          },
        },
        Rhp: rhpResource({ AccessControlAllowOrigins: { Items: ['*'] } }),
      })
    );
    expect(m.size).toBe(0);
  });

  it('ignores AWS-managed RHP IDs (literal UUID, not Ref)', () => {
    // CDK can set ResponseHeadersPolicyId to a literal AWS-managed-policy
    // UUID. cdkd can't fetch those (they live in AWS), so we skip.
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        FnUrl: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'Fn' } },
        },
        Dist: {
          Type: 'AWS::CloudFront::Distribution',
          Properties: {
            DistributionConfig: {
              Origins: [{ DomainName: fnUrlOriginDomainName('FnUrl'), Id: 'origin-1' }],
              DefaultCacheBehavior: {
                TargetOriginId: 'origin-1',
                ResponseHeadersPolicyId: '67f7b8e0-7e4f-4e4c-a4f6-aws-managed',
              },
            },
          },
        },
      })
    );
    expect(m.size).toBe(0);
  });

  it('maps multiple distributions / Function URLs independently', () => {
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        FnUrl1: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'Fn1' } },
        },
        FnUrl2: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'Fn2' } },
        },
        Dist1: distributionResource({ fnUrlLogicalId: 'FnUrl1', rhpLogicalId: 'Rhp1' }),
        Dist2: distributionResource({ fnUrlLogicalId: 'FnUrl2', rhpLogicalId: 'Rhp2' }),
        Rhp1: rhpResource({ AccessControlAllowOrigins: { Items: ['https://a.example.com'] } }),
        Rhp2: rhpResource({ AccessControlAllowOrigins: { Items: ['https://b.example.com'] } }),
      })
    );
    expect(m.size).toBe(2);
    expect(m.get('FnUrl1')?.AllowOrigins).toEqual(['https://a.example.com']);
    expect(m.get('FnUrl2')?.AllowOrigins).toEqual(['https://b.example.com']);
  });

  it('walks both DefaultCacheBehavior and CacheBehaviors[]', () => {
    // Per-path CORS: v1 applies last-write-wins across cache behaviors
    // (no per-path routing). Confirms we DO walk CacheBehaviors[].
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        FnUrl: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'Fn' } },
        },
        Dist: {
          Type: 'AWS::CloudFront::Distribution',
          Properties: {
            DistributionConfig: {
              Origins: [{ DomainName: fnUrlOriginDomainName('FnUrl'), Id: 'origin-1' }],
              DefaultCacheBehavior: {
                TargetOriginId: 'origin-1',
                ResponseHeadersPolicyId: { Ref: 'RhpDefault' },
              },
              CacheBehaviors: [
                {
                  PathPattern: '/api/*',
                  TargetOriginId: 'origin-1',
                  ResponseHeadersPolicyId: { Ref: 'RhpApi' },
                },
              ],
            },
          },
        },
        RhpDefault: rhpResource({
          AccessControlAllowOrigins: { Items: ['https://default.example.com'] },
        }),
        RhpApi: rhpResource({
          AccessControlAllowOrigins: { Items: ['https://api.example.com'] },
        }),
      })
    );
    // Last-write-wins: CacheBehaviors[] iterated after DefaultCacheBehavior.
    expect(m.get('FnUrl')?.AllowOrigins).toEqual(['https://api.example.com']);
  });

  it('tolerates a malformed CorsConfig (non-object) without throwing', () => {
    const m = buildCorsConfigFromCloudFrontChain(
      tpl({
        FnUrl: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'Fn' } },
        },
        Dist: distributionResource({ fnUrlLogicalId: 'FnUrl', rhpLogicalId: 'Rhp' }),
        Rhp: rhpResource('not-an-object'),
      })
    );
    expect(m.size).toBe(0);
  });
});

describe('matchPreflight', () => {
  const config: CorsConfig = {
    AllowOrigins: ['https://example.com'],
    AllowMethods: ['GET', 'POST'],
    AllowHeaders: ['Content-Type', 'Authorization'],
    ExposeHeaders: [],
  };

  it('returns null on non-OPTIONS requests', () => {
    expect(
      matchPreflight(
        {
          method: 'GET',
          headers: { origin: ['https://example.com'] },
        },
        config
      )
    ).toBeNull();
  });

  it('returns null when Origin header is absent', () => {
    expect(
      matchPreflight(
        {
          method: 'OPTIONS',
          headers: { 'access-control-request-method': ['GET'] },
        },
        config
      )
    ).toBeNull();
  });

  it('emits canonical preflight response on full match', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['POST'],
          'access-control-request-headers': ['Content-Type'],
        },
      },
      config
    );
    expect(r).not.toBeNull();
    expect(r!.statusCode).toBe(204);
    expect(r!.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(r!.headers['access-control-allow-methods']).toBe('POST');
    expect(r!.headers['access-control-allow-headers']).toBe('Content-Type');
  });

  it('returns null when Origin is not allowed', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://other.example'],
          'access-control-request-method': ['GET'],
        },
      },
      config
    );
    expect(r).toBeNull();
  });

  it('returns null when method is not allowed', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['DELETE'],
        },
      },
      config
    );
    expect(r).toBeNull();
  });

  it('returns null when a requested header is not allowed', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['POST'],
          'access-control-request-headers': ['X-Forbidden-Header'],
        },
      },
      config
    );
    expect(r).toBeNull();
  });

  it("`*` wildcard matches any Origin", () => {
    const wildcardConfig: CorsConfig = {
      AllowOrigins: ['*'],
      AllowMethods: ['*'],
      AllowHeaders: ['*'],
      ExposeHeaders: [],
    };
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://anywhere.example'],
          'access-control-request-method': ['DELETE'],
          'access-control-request-headers': ['X-Custom-Header'],
        },
      },
      wildcardConfig
    );
    expect(r).not.toBeNull();
    expect(r!.headers['access-control-allow-origin']).toBe('*');
    expect(r!.headers['access-control-allow-methods']).toBe('DELETE');
    expect(r!.headers['access-control-allow-headers']).toBe('X-Custom-Header');
  });

  it('echoes request Origin (not `*`) when AllowCredentials is true', () => {
    const wildcardCreds: CorsConfig = {
      AllowOrigins: ['*'],
      AllowMethods: ['*'],
      AllowHeaders: ['*'],
      ExposeHeaders: [],
      AllowCredentials: true,
    };
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://anywhere.example'],
          'access-control-request-method': ['POST'],
        },
      },
      wildcardCreds
    );
    expect(r).not.toBeNull();
    expect(r!.headers['access-control-allow-origin']).toBe('https://anywhere.example');
    expect(r!.headers['access-control-allow-credentials']).toBe('true');
  });

  it('emits MaxAge + ExposeHeaders when configured', () => {
    const c: CorsConfig = {
      AllowOrigins: ['https://example.com'],
      AllowMethods: ['GET'],
      AllowHeaders: ['*'],
      ExposeHeaders: ['X-A', 'X-B'],
      MaxAge: 1800,
    };
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['GET'],
        },
      },
      c
    );
    expect(r!.headers['access-control-expose-headers']).toBe('X-A,X-B');
    expect(r!.headers['access-control-max-age']).toBe('1800');
  });

  it('treats requested-headers absence as a clean match', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['GET'],
        },
      },
      config
    );
    expect(r).not.toBeNull();
  });

  it('case-insensitively matches Methods + Headers', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['get'],
          'access-control-request-headers': ['content-type, authorization'],
        },
      },
      config
    );
    expect(r).not.toBeNull();
  });

  it('emits Vary: Origin on every successful preflight (literal Origin path)', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['POST'],
        },
      },
      config
    );
    expect(r).not.toBeNull();
    expect(r!.headers['vary']).toBe('Origin');
  });

  it('emits Vary: Origin on the wildcard / no-credentials path', () => {
    const wildcardConfig: CorsConfig = {
      AllowOrigins: ['*'],
      AllowMethods: ['*'],
      AllowHeaders: ['*'],
      ExposeHeaders: [],
    };
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://anywhere.example'],
          'access-control-request-method': ['GET'],
        },
      },
      wildcardConfig
    );
    expect(r).not.toBeNull();
    expect(r!.headers['access-control-allow-origin']).toBe('*');
    expect(r!.headers['vary']).toBe('Origin');
  });

  it('emits Vary: Origin on the AllowCredentials echo path', () => {
    const credsConfig: CorsConfig = {
      AllowOrigins: ['*'],
      AllowMethods: ['*'],
      AllowHeaders: ['*'],
      ExposeHeaders: [],
      AllowCredentials: true,
    };
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://anywhere.example'],
          'access-control-request-method': ['POST'],
        },
      },
      credsConfig
    );
    expect(r).not.toBeNull();
    expect(r!.headers['access-control-allow-origin']).toBe('https://anywhere.example');
    expect(r!.headers['vary']).toBe('Origin');
  });

  it('rejects access-control-request-headers with an empty entry (e.g. "Content-Type,,Authorization")', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://example.com'],
          'access-control-request-method': ['POST'],
          'access-control-request-headers': ['Content-Type,,Authorization'],
        },
      },
      config
    );
    // Pre-fix the empty entry was silently skipped and the request
    // matched. Post-fix the malformed list rejects.
    expect(r).toBeNull();
  });

  it('does NOT include access-control-allow-origin header when origin is rejected (negative-header pin)', () => {
    const r = matchPreflight(
      {
        method: 'OPTIONS',
        headers: {
          origin: ['https://other.example'],
          'access-control-request-method': ['GET'],
        },
      },
      config
    );
    // Returning null means the server falls through to route dispatch
    // (404 / user OPTIONS handler). Pinning the null contract here
    // because callers depend on "no preflight headers in null result".
    expect(r).toBeNull();
  });
});
