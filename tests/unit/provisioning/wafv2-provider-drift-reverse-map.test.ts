import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

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
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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

const TEST_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123-def';
const IPSET_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/ipset/blocked/ip-1';
const RESOURCE_TYPE = 'AWS::WAFv2::WebACL';

const VISIBILITY_CONFIG = {
  CloudWatchMetricsEnabled: true,
  MetricName: 'my-acl-metric',
  SampledRequestsEnabled: true,
};

// "BadBot" — the exact example AWS uses in the SearchStringBase64 docs.
const BAD_BOT_BASE64 = 'QmFkQm90';
const BAD_BOT_BYTES = Uint8Array.from(Buffer.from('BadBot', 'utf8'));

/**
 * Drive readCurrentState with an AWS-shaped `Rules` array (what GetWebACL
 * really returns: `ARN`, and `SearchString` as a Uint8Array blob) plus the
 * state baseline, and return the CFn-shaped `Rules` the provider emits.
 */
async function readBackRules(
  provider: WAFv2WebACLProvider,
  awsRules: unknown[],
  baselineProperties: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  mockSend.mockResolvedValueOnce({
    WebACL: {
      Name: 'my-acl',
      Description: 'd',
      DefaultAction: { Allow: {} },
      Rules: awsRules,
      VisibilityConfig: VISIBILITY_CONFIG,
    },
  });
  mockSend.mockResolvedValueOnce({ TagInfoForResource: { TagList: [] } });

  const state = await provider.readCurrentState(
    TEST_ARN,
    'MyWebACL',
    RESOURCE_TYPE,
    baselineProperties
  );
  return state!['Rules'] as Record<string, unknown>[];
}

function rule(statement: Record<string, unknown>) {
  return {
    Name: 'r0',
    Priority: 0,
    Action: { Block: {} },
    Statement: statement,
    VisibilityConfig: VISIBILITY_CONFIG,
  };
}

function byteMatch(searchKeyValue: Record<string, unknown>) {
  return {
    ByteMatchStatement: {
      ...searchKeyValue,
      FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
      PositionalConstraint: 'CONTAINS',
      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
    },
  };
}

describe('WAFv2WebACLProvider drift reverse mapping (issue #1403)', () => {
  let provider: WAFv2WebACLProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WAFv2WebACLProvider();
  });

  describe('reference-statement ARN -> Arn', () => {
    it('renames a top-level IPSetReferenceStatement ARN back to the CFn spelling', async () => {
      const rules = await readBackRules(
        provider,
        [rule({ IPSetReferenceStatement: { ARN: IPSET_ARN } })],
        { Rules: [rule({ IPSetReferenceStatement: { Arn: IPSET_ARN } })] }
      );

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const reference = statement['IPSetReferenceStatement'] as Record<string, unknown>;
      expect(reference['Arn']).toBe(IPSET_ARN);
      expect(reference).not.toHaveProperty('ARN');
    });

    it('renames an ARN nested under AndStatement', async () => {
      const awsRule = rule({
        AndStatement: { Statements: [{ IPSetReferenceStatement: { ARN: IPSET_ARN } }] },
      });
      const baseRule = rule({
        AndStatement: { Statements: [{ IPSetReferenceStatement: { Arn: IPSET_ARN } }] },
      });

      const rules = await readBackRules(provider, [awsRule], { Rules: [baseRule] });

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const and = statement['AndStatement'] as Record<string, unknown>;
      const nested = (and['Statements'] as Record<string, unknown>[])[0]!;
      const reference = nested['IPSetReferenceStatement'] as Record<string, unknown>;
      expect(reference['Arn']).toBe(IPSET_ARN);
      expect(reference).not.toHaveProperty('ARN');
    });
  });

  describe('SearchString spelling is BASELINE-driven', () => {
    it('emits SearchStringBase64 when the template used the base64 form', async () => {
      const rules = await readBackRules(
        provider,
        [rule(byteMatch({ SearchString: BAD_BOT_BYTES }))],
        { Rules: [rule(byteMatch({ SearchStringBase64: BAD_BOT_BASE64 }))] }
      );

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const bms = statement['ByteMatchStatement'] as Record<string, unknown>;
      expect(bms['SearchStringBase64']).toBe(BAD_BOT_BASE64);
      expect(bms).not.toHaveProperty('SearchString');
    });

    it('emits a plain SearchString when the template used the plain form', async () => {
      const rules = await readBackRules(
        provider,
        [rule(byteMatch({ SearchString: BAD_BOT_BYTES }))],
        { Rules: [rule(byteMatch({ SearchString: 'BadBot' }))] }
      );

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const bms = statement['ByteMatchStatement'] as Record<string, unknown>;
      expect(bms['SearchString']).toBe('BadBot');
      expect(bms).not.toHaveProperty('SearchStringBase64');
    });

    it('falls back to the plain form when there is no usable baseline', async () => {
      const rules = await readBackRules(
        provider,
        [rule(byteMatch({ SearchString: BAD_BOT_BYTES }))],
        {}
      );

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const bms = statement['ByteMatchStatement'] as Record<string, unknown>;
      expect(bms['SearchString']).toBe('BadBot');
    });

    it('drives the choice per statement, not per WebACL', async () => {
      // One rule used base64, the other plain — a single global choice would
      // get exactly one of them wrong.
      const awsRules = [
        rule(byteMatch({ SearchString: BAD_BOT_BYTES })),
        rule(byteMatch({ SearchString: BAD_BOT_BYTES })),
      ];
      const baseline = {
        Rules: [
          rule(byteMatch({ SearchStringBase64: BAD_BOT_BASE64 })),
          rule(byteMatch({ SearchString: 'BadBot' })),
        ],
      };

      const rules = await readBackRules(provider, awsRules, baseline);

      const first = (rules[0]!['Statement'] as Record<string, unknown>)[
        'ByteMatchStatement'
      ] as Record<string, unknown>;
      const second = (rules[1]!['Statement'] as Record<string, unknown>)[
        'ByteMatchStatement'
      ] as Record<string, unknown>;
      expect(first['SearchStringBase64']).toBe(BAD_BOT_BASE64);
      expect(second['SearchString']).toBe('BadBot');
    });

    it('reverses a base64 needle nested under RateBasedStatement ScopeDownStatement', async () => {
      const awsRule = rule({
        RateBasedStatement: {
          Limit: 2000,
          AggregateKeyType: 'IP',
          ScopeDownStatement: byteMatch({ SearchString: BAD_BOT_BYTES }),
        },
      });
      const baseRule = rule({
        RateBasedStatement: {
          Limit: 2000,
          AggregateKeyType: 'IP',
          ScopeDownStatement: byteMatch({ SearchStringBase64: BAD_BOT_BASE64 }),
        },
      });

      const rules = await readBackRules(provider, [awsRule], { Rules: [baseRule] });

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const rateBased = statement['RateBasedStatement'] as Record<string, unknown>;
      const scopeDown = rateBased['ScopeDownStatement'] as Record<string, unknown>;
      const bms = scopeDown['ByteMatchStatement'] as Record<string, unknown>;
      expect(bms['SearchStringBase64']).toBe(BAD_BOT_BASE64);
    });
  });

  // The whole point of the issue: state and the AWS readback must compare
  // EQUAL for an undrifted WebACL. `drift-calculator` compares `Rules`
  // wholesale via deepEqual, so anything short of exact equality is drift.
  it('round-trips an undrifted WebACL to a byte-equal Rules array (no phantom drift)', async () => {
    const templateRules = [
      rule({
        AndStatement: {
          Statements: [
            { IPSetReferenceStatement: { Arn: IPSET_ARN } },
            byteMatch({ SearchStringBase64: BAD_BOT_BASE64 }),
            byteMatch({ SearchString: 'plain-needle' }),
          ],
        },
      }),
    ];
    // What AWS gives back for exactly those rules.
    const awsRules = [
      rule({
        AndStatement: {
          Statements: [
            { IPSetReferenceStatement: { ARN: IPSET_ARN } },
            byteMatch({ SearchString: BAD_BOT_BYTES }),
            byteMatch({ SearchString: Uint8Array.from(Buffer.from('plain-needle', 'utf8')) }),
          ],
        },
      }),
    ];

    const rules = await readBackRules(provider, awsRules, { Rules: templateRules });

    expect(rules).toEqual(templateRules);
  });

  // The baseline string is handed back VERBATIM whenever it re-encodes to the
  // AWS bytes. Without that, both of these drift forever.
  describe('baseline string is preserved byte-for-byte when it round-trips', () => {
    it('keeps a NON-CANONICAL base64 baseline instead of re-encoding it', async () => {
      // Same bytes as BAD_BOT_BASE64, but newline-wrapped — a canonical
      // re-encode would never equal this, so the WebACL would drift forever.
      const nonCanonical = 'QmFk\nQm90';
      expect(Buffer.from(nonCanonical, 'base64')).toEqual(Buffer.from(BAD_BOT_BYTES));

      const rules = await readBackRules(
        provider,
        [rule(byteMatch({ SearchString: BAD_BOT_BYTES }))],
        { Rules: [rule(byteMatch({ SearchStringBase64: nonCanonical }))] }
      );

      const bms = (rules[0]!['Statement'] as Record<string, unknown>)[
        'ByteMatchStatement'
      ] as Record<string, unknown>;
      expect(bms['SearchStringBase64']).toBe(nonCanonical);
    });

    it('does not lossily UTF-8 decode BINARY bytes under a plain baseline', async () => {
      // 0xFF 0xFE is not valid UTF-8: toString('utf8') yields U+FFFD, which
      // `drift --accept` would persist and `--revert` would push back to AWS.
      const binary = Uint8Array.from([0xff, 0xfe, 0x00, 0x01]);

      const rules = await readBackRules(provider, [rule(byteMatch({ SearchString: binary }))], {
        Rules: [rule(byteMatch({ SearchString: 'BadBot' }))],
      });

      const bms = (rules[0]!['Statement'] as Record<string, unknown>)[
        'ByteMatchStatement'
      ] as Record<string, unknown>;
      expect(bms['SearchString']).toBeUndefined();
      expect(bms['SearchStringBase64']).toBe(Buffer.from(binary).toString('base64'));
      // Round-trips to the exact bytes — no U+FFFD corruption.
      expect(Buffer.from(bms['SearchStringBase64'] as string, 'base64')).toEqual(
        Buffer.from(binary)
      );
    });

    it('falls back to base64 for binary bytes when there is no baseline at all', async () => {
      const binary = Uint8Array.from([0x80, 0x81]);
      const rules = await readBackRules(provider, [rule(byteMatch({ SearchString: binary }))], {});

      const bms = (rules[0]!['Statement'] as Record<string, unknown>)[
        'ByteMatchStatement'
      ] as Record<string, unknown>;
      expect(bms['SearchStringBase64']).toBe(Buffer.from(binary).toString('base64'));
    });
  });

  // The docstring claims the two walks cover the SAME recursion points, so
  // every one of them needs coverage or the claim is untested.
  describe('every recursion point is covered', () => {
    it.each([
      ['NotStatement', (s: unknown) => ({ NotStatement: { Statement: s } })],
      ['OrStatement', (s: unknown) => ({ OrStatement: { Statements: [s] } })],
      [
        'ManagedRuleGroupStatement.ScopeDownStatement',
        (s: unknown) => ({
          ManagedRuleGroupStatement: { Name: 'm', VendorName: 'AWS', ScopeDownStatement: s },
        }),
      ],
    ])('reverses a base64 needle nested under %s', async (_label, wrap) => {
      const rules = await readBackRules(
        provider,
        [rule(wrap(byteMatch({ SearchString: BAD_BOT_BYTES })) as Record<string, unknown>)],
        {
          Rules: [
            rule(wrap(byteMatch({ SearchStringBase64: BAD_BOT_BASE64 })) as Record<string, unknown>),
          ],
        }
      );

      // The needle survived somewhere in the tree with the CFn spelling.
      expect(JSON.stringify(rules[0])).toContain(BAD_BOT_BASE64);
      expect(JSON.stringify(rules[0])).not.toContain('"SearchString"');
    });

    it.each([
      ['RegexPatternSetReferenceStatement'],
      ['RuleGroupReferenceStatement'],
    ])('renames ARN back to Arn on %s', async (key) => {
      const rules = await readBackRules(provider, [rule({ [key]: { ARN: IPSET_ARN } })], {
        Rules: [rule({ [key]: { Arn: IPSET_ARN } })],
      });

      const statement = rules[0]!['Statement'] as Record<string, unknown>;
      const reference = statement[key] as Record<string, unknown>;
      expect(reference['Arn']).toBe(IPSET_ARN);
      expect(reference).not.toHaveProperty('ARN');
    });
  });

  it('still reports a REAL needle change as drift', async () => {
    const rules = await readBackRules(
      provider,
      [rule(byteMatch({ SearchString: Uint8Array.from(Buffer.from('Changed', 'utf8')) }))],
      { Rules: [rule(byteMatch({ SearchString: 'BadBot' }))] }
    );

    const bms = (rules[0]!['Statement'] as Record<string, unknown>)[
      'ByteMatchStatement'
    ] as Record<string, unknown>;
    expect(bms['SearchString']).toBe('Changed');
  });
});
