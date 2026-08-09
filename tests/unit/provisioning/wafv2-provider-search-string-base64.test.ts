import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
// `vi.hoisted` runs before the hoisted `vi.mock` factory, so the spy exists
// when the provider's module-level `getLogger().child(...)` call resolves.
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-wafv2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-wafv2')>(
    '@aws-sdk/client-wafv2'
  );
  return {
    ...actual,
    WAFV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
    }),
  };
});

import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';

const TEST_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123-def';
const TEST_ID = 'abc-123-def';
const RESOURCE_TYPE = 'AWS::WAFv2::WebACL';

const VISIBILITY_CONFIG = {
  CloudWatchMetricsEnabled: true,
  MetricName: 'my-acl-metric',
  SampledRequestsEnabled: true,
};

// "BadBot" base64-encoded — the exact example AWS uses in the
// SearchStringBase64 docs.
const BAD_BOT_BASE64 = 'QmFkQm90';
const BAD_BOT_BYTES = Uint8Array.from(Buffer.from('BadBot', 'utf8'));

function byteMatchStatement(searchKey: 'SearchString' | 'SearchStringBase64', value: string) {
  return {
    ByteMatchStatement: {
      [searchKey]: value,
      FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
      PositionalConstraint: 'CONTAINS',
      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
    },
  };
}

function rule(statement: Record<string, unknown>) {
  return {
    Name: 'block-bad-bot',
    Priority: 0,
    Action: { Block: {} },
    Statement: statement,
    VisibilityConfig: VISIBILITY_CONFIG,
  };
}

function baseProperties(rules: unknown[]) {
  return {
    Name: 'my-acl',
    Scope: 'REGIONAL',
    DefaultAction: { Allow: {} },
    VisibilityConfig: VISIBILITY_CONFIG,
    Rules: rules,
  };
}

/** Drive create() and return the `Rules` the CreateWebACL command carried. */
async function createdRules(
  provider: WAFv2WebACLProvider,
  rules: unknown[]
): Promise<Record<string, unknown>[]> {
  mockSend.mockResolvedValueOnce({ Summary: { ARN: TEST_ARN, Id: TEST_ID } });
  await provider.create('MyWebACL', RESOURCE_TYPE, baseProperties(rules));
  return mockSend.mock.calls[0][0].input.Rules;
}

describe('WAFv2WebACLProvider ByteMatchStatement.SearchStringBase64 (issue #1389)', () => {
  let provider: WAFv2WebACLProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WAFv2WebACLProvider();
  });

  describe('create', () => {
    it('decodes a top-level SearchStringBase64 into the SDK SearchString blob', async () => {
      const rules = await createdRules(provider, [
        rule(byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64)),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const byteMatch = statement['ByteMatchStatement'] as Record<string, unknown>;
      expect(byteMatch['SearchString']).toEqual(BAD_BOT_BYTES);
      expect(byteMatch).not.toHaveProperty('SearchStringBase64');
      // Sibling members are preserved verbatim.
      expect(byteMatch['PositionalConstraint']).toBe('CONTAINS');
    });

    it('decodes a SearchStringBase64 nested under AndStatement / NotStatement', async () => {
      const rules = await createdRules(provider, [
        rule({
          AndStatement: {
            Statements: [
              { NotStatement: { Statement: byteMatchStatement('SearchStringBase64', 'QQ==') } },
              byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64),
            ],
          },
        }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const and = statement['AndStatement'] as Record<string, unknown>;
      const nested = and['Statements'] as Record<string, unknown>[];

      const notInner = (nested[0]!['NotStatement'] as Record<string, unknown>)[
        'Statement'
      ] as Record<string, unknown>;
      const notByteMatch = notInner['ByteMatchStatement'] as Record<string, unknown>;
      expect(notByteMatch['SearchString']).toEqual(Uint8Array.from([0x41]));
      expect(notByteMatch).not.toHaveProperty('SearchStringBase64');

      const siblingByteMatch = nested[1]!['ByteMatchStatement'] as Record<string, unknown>;
      expect(siblingByteMatch['SearchString']).toEqual(BAD_BOT_BYTES);
      expect(siblingByteMatch).not.toHaveProperty('SearchStringBase64');
    });

    it('decodes a SearchStringBase64 nested under OrStatement', async () => {
      const rules = await createdRules(provider, [
        rule({
          OrStatement: {
            Statements: [byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64)],
          },
        }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const or = statement['OrStatement'] as Record<string, unknown>;
      const nested = (or['Statements'] as Record<string, unknown>[])[0]!;
      const byteMatch = nested['ByteMatchStatement'] as Record<string, unknown>;
      expect(byteMatch['SearchString']).toEqual(BAD_BOT_BYTES);
      expect(byteMatch).not.toHaveProperty('SearchStringBase64');
    });

    it('decodes a SearchStringBase64 under RateBasedStatement.ScopeDownStatement', async () => {
      const rules = await createdRules(provider, [
        rule({
          RateBasedStatement: {
            Limit: 2000,
            AggregateKeyType: 'IP',
            ScopeDownStatement: byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64),
          },
        }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const rateBased = statement['RateBasedStatement'] as Record<string, unknown>;
      const scopeDown = rateBased['ScopeDownStatement'] as Record<string, unknown>;
      const byteMatch = scopeDown['ByteMatchStatement'] as Record<string, unknown>;
      expect(byteMatch['SearchString']).toEqual(BAD_BOT_BYTES);
      expect(byteMatch).not.toHaveProperty('SearchStringBase64');
      // Sibling members of the rate-based statement survive the rebuild.
      expect(rateBased['Limit']).toBe(2000);
    });

    it('decodes a SearchStringBase64 under ManagedRuleGroupStatement.ScopeDownStatement', async () => {
      const rules = await createdRules(provider, [
        rule({
          ManagedRuleGroupStatement: {
            VendorName: 'AWS',
            Name: 'AWSManagedRulesCommonRuleSet',
            ScopeDownStatement: byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64),
          },
        }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const managed = statement['ManagedRuleGroupStatement'] as Record<string, unknown>;
      const scopeDown = managed['ScopeDownStatement'] as Record<string, unknown>;
      const byteMatch = scopeDown['ByteMatchStatement'] as Record<string, unknown>;
      expect(byteMatch['SearchString']).toEqual(BAD_BOT_BYTES);
      expect(byteMatch).not.toHaveProperty('SearchStringBase64');
    });

    it('leaves a plain SearchString untouched', async () => {
      const rules = await createdRules(provider, [
        rule(byteMatchStatement('SearchString', 'BadBot')),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const byteMatch = statement['ByteMatchStatement'] as Record<string, unknown>;
      // The SDK's JSON serializer accepts a string at a blob member (UTF-8 +
      // base64 on the wire), so the pre-existing behavior must not change.
      expect(byteMatch['SearchString']).toBe('BadBot');
    });

    it('prefers SearchStringBase64 when a template carries both keys', async () => {
      const rules = await createdRules(provider, [
        rule({
          ByteMatchStatement: {
            SearchString: 'ignored',
            SearchStringBase64: BAD_BOT_BASE64,
            FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
            PositionalConstraint: 'CONTAINS',
            TextTransformations: [{ Priority: 0, Type: 'NONE' }],
          },
        }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const byteMatch = statement['ByteMatchStatement'] as Record<string, unknown>;
      expect(byteMatch['SearchString']).toEqual(BAD_BOT_BYTES);
      expect(byteMatch).not.toHaveProperty('SearchStringBase64');
    });

    it('does not mutate the caller-supplied properties object', async () => {
      const inputRules = [rule(byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64))];
      await createdRules(provider, inputRules);

      const original = (inputRules[0]!.Statement as Record<string, unknown>)[
        'ByteMatchStatement'
      ] as Record<string, unknown>;
      expect(original['SearchStringBase64']).toBe(BAD_BOT_BASE64);
      expect(original).not.toHaveProperty('SearchString');
    });

    it('still sends an empty Rules array when the property is absent', async () => {
      mockSend.mockResolvedValueOnce({ Summary: { ARN: TEST_ARN, Id: TEST_ID } });
      await provider.create('MyWebACL', RESOURCE_TYPE, {
        Name: 'my-acl',
        Scope: 'REGIONAL',
        DefaultAction: { Allow: {} },
        VisibilityConfig: VISIBILITY_CONFIG,
      });

      expect(mockSend.mock.calls[0][0].input.Rules).toEqual([]);
    });
  });

  describe('update', () => {
    it('decodes SearchStringBase64 on the update path too', async () => {
      // GetWebACL (LockToken), then UpdateWebACL.
      mockSend.mockResolvedValueOnce({ LockToken: 'lock-token-123', WebACL: {} });
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'MyWebACL',
        TEST_ARN,
        RESOURCE_TYPE,
        baseProperties([
          rule({
            NotStatement: { Statement: byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64) },
          }),
        ]),
        baseProperties([])
      );

      const updateCall = mockSend.mock.calls[1][0];
      expect(updateCall.constructor.name).toBe('UpdateWebACLCommand');
      const statement = updateCall.input.Rules[0]['Statement'] as Record<string, unknown>;
      const not = statement['NotStatement'] as Record<string, unknown>;
      const inner = not['Statement'] as Record<string, unknown>;
      const byteMatch = inner['ByteMatchStatement'] as Record<string, unknown>;
      expect(byteMatch['SearchString']).toEqual(BAD_BOT_BYTES);
      expect(byteMatch).not.toHaveProperty('SearchStringBase64');
    });
  });

  describe('SDK-unsupported rule properties', () => {
    it('warns loudly on create when a rule carries a property the SDK model lacks', async () => {
      mockSend.mockResolvedValueOnce({ Summary: { ARN: TEST_ARN, Id: TEST_ID } });
      await provider.create(
        'MyWebACL',
        RESOURCE_TYPE,
        baseProperties([
          {
            Name: 'monetize-bots',
            Priority: 0,
            Action: { Monetize: { PriceMultiplier: 2 } },
            Statement: {
              ByteMatchStatement: {
                SearchString: 'BadBot',
                FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
                PositionalConstraint: 'CONTAINS',
                TextTransformations: [
                  { Priority: 0, Type: 'NONE', PreParseTextTransformations: [{ Type: 'JSON' }] },
                ],
              },
            },
            VisibilityConfig: VISIBILITY_CONFIG,
          },
        ])
      );

      expect(mockWarn).toHaveBeenCalledTimes(1);
      const message = mockWarn.mock.calls[0][0] as string;
      expect(message).toContain('MyWebACL');
      expect(message).toContain('Monetize');
      expect(message).toContain('PreParseTextTransformations');
      expect(message).toContain('PriceMultiplier');
      // Three names -> the plural branch of the message must be selected.
      expect(message).toContain('rule properties');
      expect(message).toContain('have no member');
    });

    it('warns on the update path too', async () => {
      mockSend.mockResolvedValueOnce({ LockToken: 'lock-token-123', WebACL: {} });
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'MyWebACL',
        TEST_ARN,
        RESOURCE_TYPE,
        baseProperties([
          {
            Name: 'monetize-bots',
            Priority: 0,
            Action: { Monetize: {} },
            Statement: byteMatchStatement('SearchString', 'BadBot'),
            VisibilityConfig: VISIBILITY_CONFIG,
          },
        ]),
        baseProperties([])
      );

      expect(mockWarn).toHaveBeenCalledTimes(1);
      const updateMessage = mockWarn.mock.calls[0][0] as string;
      expect(updateMessage).toContain('Monetize');
      // One name -> the singular branch. Pinning both branches keeps the
      // grammar swap from silently regressing.
      expect(updateMessage).toContain('rule property Monetize has no member');
    });

    it('stays quiet for rules that use only SDK-supported properties', async () => {
      await createdRules(provider, [rule(byteMatchStatement('SearchStringBase64', BAD_BOT_BASE64))]);
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  // The other CFn-vs-SDK spelling divergence in the whole Rules tree: CFn
  // spells the reference-statement member `Arn`, every one of these SDK types
  // declares it `ARN` and marks it REQUIRED, so the serializer dropped it and
  // CreateWebACL failed validation the same way SearchStringBase64 did.
  describe('reference-statement Arn -> ARN', () => {
    const IPSET_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/ipset/blocked/ip-1';
    const REGEX_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/regexpatternset/re/re-1';
    const GROUP_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/rulegroup/rg/rg-1';

    it.each([
      ['IPSetReferenceStatement', IPSET_ARN],
      ['RegexPatternSetReferenceStatement', REGEX_ARN],
      ['RuleGroupReferenceStatement', GROUP_ARN],
    ])('renames Arn to ARN on a top-level %s', async (key, arn) => {
      const rules = await createdRules(provider, [rule({ [key]: { Arn: arn } })]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const reference = statement[key] as Record<string, unknown>;
      expect(reference['ARN']).toBe(arn);
      expect(reference).not.toHaveProperty('Arn');
    });

    it('preserves the reference statement sibling members', async () => {
      const rules = await createdRules(provider, [
        rule({
          RuleGroupReferenceStatement: {
            Arn: GROUP_ARN,
            ExcludedRules: [{ Name: 'noisy-rule' }],
          },
        }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const reference = statement['RuleGroupReferenceStatement'] as Record<string, unknown>;
      expect(reference['ARN']).toBe(GROUP_ARN);
      expect(reference['ExcludedRules']).toEqual([{ Name: 'noisy-rule' }]);
    });

    it('renames Arn nested under a RateBasedStatement ScopeDownStatement', async () => {
      const rules = await createdRules(provider, [
        rule({
          RateBasedStatement: {
            Limit: 2000,
            AggregateKeyType: 'IP',
            ScopeDownStatement: { IPSetReferenceStatement: { Arn: IPSET_ARN } },
          },
        }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const rateBased = statement['RateBasedStatement'] as Record<string, unknown>;
      const scopeDown = rateBased['ScopeDownStatement'] as Record<string, unknown>;
      const reference = scopeDown['IPSetReferenceStatement'] as Record<string, unknown>;
      expect(reference['ARN']).toBe(IPSET_ARN);
      expect(reference).not.toHaveProperty('Arn');
    });

    it('leaves an already-SDK-spelled ARN untouched', async () => {
      const rules = await createdRules(provider, [
        rule({ IPSetReferenceStatement: { ARN: IPSET_ARN } }),
      ]);

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const reference = statement['IPSetReferenceStatement'] as Record<string, unknown>;
      expect(reference['ARN']).toBe(IPSET_ARN);
    });

    it('renames Arn on the update path too', async () => {
      mockSend.mockResolvedValueOnce({ LockToken: 'lock-1' });
      mockSend.mockResolvedValueOnce({ NextLockToken: 'lock-2' });

      await provider.update(
        'MyWebACL',
        TEST_ARN,
        RESOURCE_TYPE,
        baseProperties([rule({ IPSetReferenceStatement: { Arn: IPSET_ARN } })]),
        baseProperties([])
      );

      const updateCall = mockSend.mock.calls.at(-1)!;
      const rules = updateCall[0].input.Rules as Record<string, unknown>[];
      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const reference = statement['IPSetReferenceStatement'] as Record<string, unknown>;
      expect(reference['ARN']).toBe(IPSET_ARN);
      expect(reference).not.toHaveProperty('Arn');
    });
  });

  describe('non-array Rules', () => {
    // A truthy non-array is an unresolved intrinsic. Defaulting it to [] would
    // make update() a silent UpdateWebACL that wipes every rule and reports
    // success; passing it through keeps the loud SDK validation failure.
    it('passes a non-array Rules value through instead of wiping the rules', async () => {
      mockSend.mockResolvedValueOnce({ Summary: { ARN: TEST_ARN, Id: TEST_ID } });
      await provider.create('MyWebACL', RESOURCE_TYPE, {
        ...baseProperties([]),
        Rules: { Ref: 'SomeUnresolvedParameter' },
      });

      expect(mockSend.mock.calls[0][0].input.Rules).toEqual({
        Ref: 'SomeUnresolvedParameter',
      });
    });

    // The dangerous half: on update, defaulting an unresolved intrinsic to []
    // would issue an UpdateWebACL that WIPES every rule and report success.
    it('passes a non-array Rules value through on the update path too', async () => {
      mockSend.mockResolvedValueOnce({ LockToken: 'lock-1' });
      mockSend.mockResolvedValueOnce({ NextLockToken: 'lock-2' });

      await provider.update('MyWebACL', TEST_ARN, RESOURCE_TYPE, {
        ...baseProperties([]),
        Rules: { Ref: 'SomeUnresolvedParameter' },
      }, baseProperties([]));

      const updateCall = mockSend.mock.calls.at(-1)!;
      expect(updateCall[0].input.Rules).toEqual({ Ref: 'SomeUnresolvedParameter' });
    });

    it('degrades every FALSY Rules value to an empty array (parity with `|| []`)', async () => {
      for (const falsy of [null, '', 0, false]) {
        mockSend.mockReset();
        mockSend.mockResolvedValueOnce({ Summary: { ARN: TEST_ARN, Id: TEST_ID } });
        await provider.create('MyWebACL', RESOURCE_TYPE, {
          ...baseProperties([]),
          Rules: falsy,
        });
        expect(mockSend.mock.calls[0][0].input.Rules).toEqual([]);
      }
    });

    it('still defaults absent Rules to an empty array', async () => {
      mockSend.mockResolvedValueOnce({ Summary: { ARN: TEST_ARN, Id: TEST_ID } });
      const properties: Record<string, unknown> = { ...baseProperties([]) };
      delete properties['Rules'];
      await provider.create('MyWebACL', RESOURCE_TYPE, properties);

      expect(mockSend.mock.calls[0][0].input.Rules).toEqual([]);
    });
  });
});
