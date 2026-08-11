import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@aws-sdk/client-wafv2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-wafv2');
  return {
    ...actual,
    WAFV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';

const RESOURCE_TYPE = 'AWS::WAFv2::WebACL';
const TEST_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123-def';

/**
 * `CreateContext.replayingState` downgrade for the create-path `Scope`
 * pre-flight refusal (issue #1544).
 *
 * The rollback executor's reverse-replacement arm revives the OLD WebACL from
 * `previousState.properties` — a cdkd STATE record the user cannot edit from
 * CDK code. Before this fix `create()` did not declare the optional `context`
 * parameter, so the `requireConfigString` refusal fired even on that replay
 * and left the resource unrestorable. Modeled on the #1542 BillingMode suite.
 */
describe('WAFv2WebACLProvider malformed Scope on a state replay (issue #1544)', () => {
  let provider: WAFv2WebACLProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new WAFv2WebACLProvider();
  });

  const baseProps = {
    Name: 'my-acl',
    DefaultAction: { Allow: {} },
    VisibilityConfig: {
      SampledRequestsEnabled: true,
      CloudWatchMetricsEnabled: true,
      MetricName: 'my-acl',
    },
  };

  const createSucceeds = () =>
    mockSend.mockResolvedValue({
      Summary: { ARN: TEST_ARN, Id: 'abc-123-def', LabelNamespace: 'awswaf:...:' },
    });

  const commandNames = () => mockSend.mock.calls.map((c) => c[0].constructor.name);

  // ─── replayingState: true → warn, proceed with the default ─────────────

  it('WARNS instead of throwing when the create is a state replay', async () => {
    createSucceeds();

    const result = await provider.create(
      'MyWebACL',
      RESOURCE_TYPE,
      { ...baseProps, Scope: null },
      { replayingState: true }
    );

    expect(result.physicalId).toBe(TEST_ARN);
    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateWebACLCommand'
    );
    expect(createCall?.[0].input.Scope).toBe('REGIONAL');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::WAFv2::WebACL Scope must be a non-empty string')
    );
  });

  it('leaves a VALID Scope untouched on a state replay', async () => {
    createSucceeds();

    await provider.create(
      'MyWebACL',
      RESOURCE_TYPE,
      { ...baseProps, Scope: 'CLOUDFRONT' },
      { replayingState: true }
    );

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateWebACLCommand'
    );
    expect(createCall?.[0].input.Scope).toBe('CLOUDFRONT');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::WAFv2::WebACL Scope')
    );
  });

  // ─── replayingState absent / false / empty context → refusal stands ────

  it('keeps the refusal on an ordinary template-path create (no context)', async () => {
    createSucceeds();

    await expect(
      provider.create('MyWebACL', RESOURCE_TYPE, { ...baseProps, Scope: null })
    ).rejects.toThrow(/AWS::WAFv2::WebACL Scope must be a non-empty string \(got null\)/);

    // The refusal must land BEFORE CreateWebACL — a pre-flight refusal.
    expect(commandNames()).not.toContain('CreateWebACLCommand');
  });

  it('keeps the refusal when the context carries replayingState: false', async () => {
    createSucceeds();

    await expect(
      provider.create(
        'MyWebACL',
        RESOURCE_TYPE,
        { ...baseProps, Scope: '' },
        { replayingState: false }
      )
    ).rejects.toThrow(/AWS::WAFv2::WebACL Scope must be a non-empty string/);
    expect(commandNames()).not.toContain('CreateWebACLCommand');
  });

  it('keeps the refusal when the context is present but carries no replay flag', async () => {
    createSucceeds();

    // `replayWarn` tests `=== true`, so an empty context bag is an ordinary
    // create. Pinned so a future `!== false` refactor cannot silently turn
    // every context-carrying create into a warn.
    await expect(
      provider.create('MyWebACL', RESOURCE_TYPE, { ...baseProps, Scope: 5 }, {})
    ).rejects.toThrow(/AWS::WAFv2::WebACL Scope must be a non-empty string \(got a number\)/);
  });

  it('still defaults an ABSENT Scope to REGIONAL on a plain create', async () => {
    createSucceeds();

    await provider.create('MyWebACL', RESOURCE_TYPE, { ...baseProps });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateWebACLCommand'
    );
    expect(createCall?.[0].input.Scope).toBe('REGIONAL');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::WAFv2::WebACL Scope')
    );
  });
});
