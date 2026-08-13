import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>(
    '@aws-sdk/client-appsync'
  );
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';

/**
 * Issue #1657 — the previously SILENT decode sites. Each of these used to emit
 * only `Invalid <X> physical ID format: <value>`, which told a user nothing
 * they did not already have: the composite format is documented nowhere else,
 * so the message was the only route to it.
 */
describe('AppSync composite-id decode messages state the expected format (issue #1657)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AppSyncProvider();
  });

  it('updateDataSource THROWS naming the shape', async () => {
    await expect(
      provider.update(
        'MyDataSource',
        'no-separator-here',
        'AWS::AppSync::DataSource',
        { ApiId: 'abc', Name: 'ds', Type: 'NONE' },
        { ApiId: 'abc', Name: 'ds', Type: 'NONE' }
      )
    ).rejects.toThrow(
      /Invalid physicalId format for AppSync DataSource MyDataSource: expected "<apiId>\|<name>", got "no-separator-here"/
    );
  });

  it('updateResolver THROWS naming its THREE-segment shape', async () => {
    await expect(
      provider.update(
        'MyResolver',
        'abc|onlyTwo',
        'AWS::AppSync::Resolver',
        { ApiId: 'abc', TypeName: 'Query', FieldName: 'f' },
        { ApiId: 'abc', TypeName: 'Query', FieldName: 'f' }
      )
    ).rejects.toThrow(/expected "<apiId>\|<typeName>\|<fieldName>", got "abc\|onlyTwo"/);
  });

  it('updateApiKey THROWS naming the shape', async () => {
    await expect(
      provider.update(
        'MyApiKey',
        'lonely',
        'AWS::AppSync::ApiKey',
        { ApiId: 'abc' },
        { ApiId: 'abc' }
      )
    ).rejects.toThrow(/Invalid physicalId format for AppSync ApiKey MyApiKey: expected "<apiId>\|<apiKeyId>"/);
  });

  it('deleteResolver WARNS with the shape AND says the AWS resource survives', async () => {
    await provider.delete('MyResolver', 'abc|onlyTwo', 'AWS::AppSync::Resolver');

    expect(mockSend).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('expected "<apiId>|<typeName>|<fieldName>"');
    // The secondary observation on #1657: warn-and-continue is the delete path's
    // documented policy, but a malformed record leaves the resource alive while
    // `cdkd destroy` reports success — so the warning has to say so.
    expect(warned).toContain('LEFT IN PLACE');
  });

  it('deleteDataSource WARNS the same way', async () => {
    await provider.delete('MyDataSource', 'nosep', 'AWS::AppSync::DataSource');

    expect(mockSend).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Invalid physicalId format for AppSync DataSource MyDataSource');
    expect(warned).toContain('expected "<apiId>|<name>"');
  });

  it('deleteApiKey WARNS the same way', async () => {
    await provider.delete('MyApiKey', 'nosep', 'AWS::AppSync::ApiKey');

    expect(mockSend).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('expected "<apiId>|<apiKeyId>"');
  });

  it('a WELL-FORMED id is not intercepted — the guard still only fires on malformed input', async () => {
    mockSend.mockResolvedValue({});
    await provider.delete('MyResolver', 'abc|Query|field', 'AWS::AppSync::Resolver');
    expect(mockSend).toHaveBeenCalled();
    // Without this the counter-case only proves the call happened, not that the
    // guard stayed silent — a guard that warns AND proceeds would still pass.
    expect(warnSpy).not.toHaveBeenCalled();
    // `mockResolvedValue` is not drained by `clearAllMocks`; reset it so a case
    // appended after this one does not inherit a primed response.
    mockSend.mockReset();
  });
});
