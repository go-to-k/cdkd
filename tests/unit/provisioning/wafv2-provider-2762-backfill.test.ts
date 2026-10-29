import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #2762: `AWS::WAFv2::WebACL` `DataProtectionConfig`,
// `OnSourceDDoSProtectionConfig`, `ApplicationConfig` and `MonetizationConfig`
// used to be silent drops, which routed the whole web ACL through Cloud
// Control. Each now rides `CreateWebACL` / `UpdateWebACL` and reads back from
// `GetWebACL`; `ApplicationConfig` is sent on an update only when it changed.

const mockSend = vi.fn();

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

const ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123';
const ID = 'abc-123';

const DATA_PROTECTION = {
  DataProtections: [
    {
      Field: { FieldType: 'SINGLE_HEADER', FieldKeys: ['authorization'] },
      Action: 'HASH',
      ExcludeRuleMatchDetails: true,
      ExcludeRateBasedDetails: false,
    },
    { Field: { FieldType: 'QUERY_STRING' }, Action: 'SUBSTITUTION' },
  ],
};
const ON_SOURCE_DDOS = { ALBLowReputationMode: 'ALWAYS_ON' };
const APPLICATION = {
  Attributes: [
    { Name: 'cdkdTier', Values: ['integ'] },
    { Name: 'cdkdOwner', Values: ['a', 'b'] },
  ],
};
const MONETIZATION = {
  CryptoConfig: {
    PaymentNetworks: [
      {
        Chain: 'BASE_SEPOLIA',
        WalletAddress: '0x0000000000000000000000000000000000000001',
        Prices: [{ Amount: '0.001', Currency: 'USDC' }],
      },
    ],
  },
  CurrencyMode: 'TEST',
};

const BASE = {
  Name: 'my-acl',
  Scope: 'REGIONAL',
  DefaultAction: { Allow: {} },
  VisibilityConfig: {
    CloudWatchMetricsEnabled: true,
    MetricName: 'my-acl',
    SampledRequestsEnabled: true,
  },
};

const FULL = {
  ...BASE,
  DataProtectionConfig: DATA_PROTECTION,
  OnSourceDDoSProtectionConfig: ON_SOURCE_DDOS,
  ApplicationConfig: APPLICATION,
  MonetizationConfig: MONETIZATION,
};

function commandInput(name: string): Record<string, unknown> {
  const call = mockSend.mock.calls.find((c) => c[0].constructor.name === name);
  if (!call) throw new Error(`no ${name} sent`);
  return call[0].input as Record<string, unknown>;
}

async function runUpdate(
  next: Record<string, unknown>,
  previous: Record<string, unknown>
): Promise<Record<string, unknown>> {
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'GetWebACLCommand') {
      return { LockToken: 'lock-1', WebACL: { Name: 'my-acl', Id: ID, ARN } };
    }
    return {};
  });
  await new WAFv2WebACLProvider().update(
    'MyWebACL',
    ARN,
    'AWS::WAFv2::WebACL',
    next,
    previous
  );
  return commandInput('UpdateWebACLCommand');
}

describe('WAFv2WebACLProvider #2762 backfill', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('declares the four properties handled', () => {
    const handled = new WAFv2WebACLProvider().handledProperties.get('AWS::WAFv2::WebACL')!;
    for (const key of [
      'DataProtectionConfig',
      'OnSourceDDoSProtectionConfig',
      'ApplicationConfig',
      'MonetizationConfig',
    ]) {
      expect(handled.has(key), key).toBe(true);
    }
  });

  it('create sends each one verbatim on CreateWebACL', async () => {
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateWebACLCommand') {
        return { Summary: { ARN, Id: ID } };
      }
      return { WebACL: { ARN, Id: ID } };
    });

    await new WAFv2WebACLProvider().create('MyWebACL', 'AWS::WAFv2::WebACL', FULL);

    const input = commandInput('CreateWebACLCommand');
    expect(input['DataProtectionConfig']).toEqual(DATA_PROTECTION);
    expect(input['OnSourceDDoSProtectionConfig']).toEqual(ON_SOURCE_DDOS);
    expect(input['ApplicationConfig']).toEqual(APPLICATION);
    expect(input['MonetizationConfig']).toEqual(MONETIZATION);
  });

  it('create leaves each one out when the template does not declare it', async () => {
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateWebACLCommand') {
        return { Summary: { ARN, Id: ID } };
      }
      return { WebACL: { ARN, Id: ID } };
    });

    await new WAFv2WebACLProvider().create('MyWebACL', 'AWS::WAFv2::WebACL', BASE);

    const input = commandInput('CreateWebACLCommand');
    expect(input['DataProtectionConfig']).toBeUndefined();
    expect(input['OnSourceDDoSProtectionConfig']).toBeUndefined();
    expect(input['ApplicationConfig']).toBeUndefined();
    expect(input['MonetizationConfig']).toBeUndefined();
  });

  it('update sends DataProtection / OnSourceDDoS / Monetization from next on every call', async () => {
    // UpdateWebACL replaces the web ACL whole, so an unchanged member must be
    // re-sent or AWS clears it.
    const input = await runUpdate(FULL, FULL);
    expect(input['DataProtectionConfig']).toEqual(DATA_PROTECTION);
    expect(input['OnSourceDDoSProtectionConfig']).toEqual(ON_SOURCE_DDOS);
    expect(input['MonetizationConfig']).toEqual(MONETIZATION);
  });

  it('update sends a changed DataProtection / OnSourceDDoS value', async () => {
    const changed = {
      ...FULL,
      DataProtectionConfig: {
        DataProtections: [{ Field: { FieldType: 'BODY' }, Action: 'SUBSTITUTION' }],
      },
      OnSourceDDoSProtectionConfig: { ALBLowReputationMode: 'ACTIVE_UNDER_DDOS' },
    };
    const input = await runUpdate(changed, FULL);
    expect(input['DataProtectionConfig']).toEqual(changed.DataProtectionConfig);
    expect(input['OnSourceDDoSProtectionConfig']).toEqual({
      ALBLowReputationMode: 'ACTIVE_UNDER_DDOS',
    });
  });

  it('update leaves out the three when the template removed them', async () => {
    const input = await runUpdate(BASE, FULL);
    expect(input['DataProtectionConfig']).toBeUndefined();
    expect(input['OnSourceDDoSProtectionConfig']).toBeUndefined();
    expect(input['MonetizationConfig']).toBeUndefined();
  });

  describe('ApplicationConfig on update', () => {
    it('is left out when unchanged (AWS keeps an omitted one and refuses any change)', async () => {
      const input = await runUpdate(FULL, FULL);
      expect(input['ApplicationConfig']).toBeUndefined();
    });

    it('is left out when unchanged in a different key order', async () => {
      const reordered = {
        ...FULL,
        ApplicationConfig: {
          Attributes: APPLICATION.Attributes.map((a) => ({ Values: a.Values, Name: a.Name })),
        },
      };
      const input = await runUpdate(reordered, FULL);
      expect(input['ApplicationConfig']).toBeUndefined();
    });

    it('is sent when the template adds it', async () => {
      const input = await runUpdate(FULL, BASE);
      expect(input['ApplicationConfig']).toEqual(APPLICATION);
    });

    it('is sent when the template changes it, so AWS answers the change', async () => {
      const changed = {
        ...FULL,
        ApplicationConfig: { Attributes: [{ Name: 'cdkdTier', Values: ['prod'] }] },
      };
      const input = await runUpdate(changed, FULL);
      expect(input['ApplicationConfig']).toEqual(changed.ApplicationConfig);
    });

    it('is left out when the template removed it', async () => {
      const input = await runUpdate(BASE, FULL);
      expect(input['ApplicationConfig']).toBeUndefined();
    });
  });

  describe('readCurrentState', () => {
    function armGet(webAcl: Record<string, unknown>): void {
      mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetWebACLCommand') {
          return { LockToken: 'lock-1', WebACL: { Name: 'my-acl', Id: ID, ARN, ...webAcl } };
        }
        return { TagInfoForResource: { TagList: [] } };
      });
    }

    it('reads each one back verbatim against the template baseline', async () => {
      armGet({
        DataProtectionConfig: DATA_PROTECTION,
        OnSourceDDoSProtectionConfig: ON_SOURCE_DDOS,
        ApplicationConfig: APPLICATION,
        MonetizationConfig: MONETIZATION,
      });
      const state = (await new WAFv2WebACLProvider().readCurrentState(
        ARN,
        'MyWebACL',
        'AWS::WAFv2::WebACL',
        FULL
      )) as Record<string, unknown>;
      expect(state['DataProtectionConfig']).toEqual(DATA_PROTECTION);
      expect(state['OnSourceDDoSProtectionConfig']).toEqual(ON_SOURCE_DDOS);
      expect(state['ApplicationConfig']).toEqual(APPLICATION);
      expect(state['MonetizationConfig']).toEqual(MONETIZATION);
    });

    describe('DataProtections false defaults', () => {
      const echoed = {
        DataProtections: [
          {
            Field: { FieldType: 'QUERY_STRING' },
            Action: 'SUBSTITUTION',
            ExcludeRuleMatchDetails: false,
            ExcludeRateBasedDetails: false,
          },
        ],
      };

      async function readWith(baseline: unknown): Promise<unknown> {
        armGet({ DataProtectionConfig: echoed });
        const state = (await new WAFv2WebACLProvider().readCurrentState(
          ARN,
          'MyWebACL',
          'AWS::WAFv2::WebACL',
          baseline === undefined ? undefined : { DataProtectionConfig: baseline }
        )) as Record<string, unknown>;
        return state['DataProtectionConfig'];
      }

      it('drops an echoed false the baseline entry leaves out', async () => {
        expect(
          await readWith({
            DataProtections: [{ Field: { FieldType: 'QUERY_STRING' }, Action: 'SUBSTITUTION' }],
          })
        ).toEqual({
          DataProtections: [{ Field: { FieldType: 'QUERY_STRING' }, Action: 'SUBSTITUTION' }],
        });
      });

      it('keeps a false the baseline entry declares', async () => {
        const declared = {
          DataProtections: [
            {
              Field: { FieldType: 'QUERY_STRING' },
              Action: 'SUBSTITUTION',
              ExcludeRuleMatchDetails: false,
            },
          ],
        };
        expect(await readWith(declared)).toEqual({
          DataProtections: [
            {
              Field: { FieldType: 'QUERY_STRING' },
              Action: 'SUBSTITUTION',
              ExcludeRuleMatchDetails: false,
            },
          ],
        });
      });

      it('keeps a true the baseline leaves out, so a real change shows', async () => {
        armGet({
          DataProtectionConfig: {
            DataProtections: [
              {
                Field: { FieldType: 'BODY' },
                Action: 'HASH',
                ExcludeRuleMatchDetails: true,
                ExcludeRateBasedDetails: false,
              },
            ],
          },
        });
        const state = (await new WAFv2WebACLProvider().readCurrentState(
          ARN,
          'MyWebACL',
          'AWS::WAFv2::WebACL',
          { DataProtectionConfig: { DataProtections: [{ Field: { FieldType: 'BODY' }, Action: 'HASH' }] } }
        )) as Record<string, unknown>;
        expect(state['DataProtectionConfig']).toEqual({
          DataProtections: [
            { Field: { FieldType: 'BODY' }, Action: 'HASH', ExcludeRuleMatchDetails: true },
          ],
        });
      });

      it('drops echoed falses when there is no baseline at all', async () => {
        expect(await readWith(undefined)).toEqual({
          DataProtections: [{ Field: { FieldType: 'QUERY_STRING' }, Action: 'SUBSTITUTION' }],
        });
      });
    });

    it('omits each one AWS does not report', async () => {
      armGet({});
      const state = (await new WAFv2WebACLProvider().readCurrentState(
        ARN,
        'MyWebACL',
        'AWS::WAFv2::WebACL'
      )) as Record<string, unknown>;
      for (const key of [
        'DataProtectionConfig',
        'OnSourceDDoSProtectionConfig',
        'ApplicationConfig',
        'MonetizationConfig',
      ]) {
        expect(key in state, key).toBe(false);
      }
    });
  });
});
