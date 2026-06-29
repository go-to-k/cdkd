import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudFormationSend = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getTopLevelCreateOnlyProperties,
  clearCreateOnlyPropertiesCache,
} from '../../../src/provisioning/create-only-properties.js';

function schemaResponse(createOnlyProperties: string[]): { Schema: string } {
  return { Schema: JSON.stringify({ createOnlyProperties }) };
}

describe('getTopLevelCreateOnlyProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCreateOnlyPropertiesCache();
  });

  it('extracts top-level createOnly property names from the registry schema', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse([
        '/properties/PerformanceMode',
        '/properties/Encrypted',
        '/properties/KmsKeyId',
      ])
    );

    const result = await getTopLevelCreateOnlyProperties('AWS::EFS::FileSystem');

    expect([...result].sort()).toEqual(['Encrypted', 'KmsKeyId', 'PerformanceMode']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('reduces a nested createOnly JSON pointer to its top-level containing property', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse(['/properties/Foo/Bar', '/properties/Baz'])
    );

    const result = await getTopLevelCreateOnlyProperties('AWS::Some::Type');

    expect([...result].sort()).toEqual(['Baz', 'Foo']);
  });

  it('unescapes RFC 6901 JSON-pointer segments (~1 -> /, ~0 -> ~) in the property name', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse(['/properties/Foo~1Bar', '/properties/Tilde~0Name'])
    );

    const result = await getTopLevelCreateOnlyProperties('AWS::Some::Type');

    expect([...result].sort()).toEqual(['Foo/Bar', 'Tilde~Name']);
  });

  it('caches SUCCESSFUL lookups per type (one DescribeType for repeated calls)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(schemaResponse(['/properties/Engine']));

    const a = await getTopLevelCreateOnlyProperties('AWS::ElastiCache::CacheCluster');
    const b = await getTopLevelCreateOnlyProperties('AWS::ElastiCache::CacheCluster');

    expect(a).toBe(b); // same cached promise result
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('a Schema-less response is a successful "no createOnly props" lookup (no warning)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({});

    const result = await getTopLevelCreateOnlyProperties('AWS::Private::Type');

    expect(result.size).toBe(0);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('degrades gracefully on DescribeType failure (empty set + warning, NOT cached)', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce(schemaResponse(['/properties/ProtocolType']));

    const first = await getTopLevelCreateOnlyProperties('AWS::ApiGatewayV2::Api');
    expect(first.size).toBe(0); // graceful fallback
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);

    // The failure was NOT cached — a later call retries DescribeType and succeeds.
    const second = await getTopLevelCreateOnlyProperties('AWS::ApiGatewayV2::Api');
    expect([...second]).toEqual(['ProtocolType']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });
});
