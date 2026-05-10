import { describe, expect, it } from 'vitest';
import {
  buildCorsConfigByApiId,
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
});
