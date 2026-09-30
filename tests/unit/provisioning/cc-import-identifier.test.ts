/**
 * `cdkd import` completes a bare CloudFormation physical id to the Cloud Control
 * identifier for a type whose primary identifier is COMPOSITE (issue
 * [#3672](https://github.com/go-to-k/cdkd/issues/3672)).
 *
 * The provider cases assert the `Identifier` actually SENT to `GetResource` and
 * the `physicalId` RECORDED — the two values the bug got wrong — rather than
 * only the helper's return, so a provider that computed the identifier and then
 * kept sending `knownPhysicalId` would still fail here.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { displayIdent, SECRET_REF_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  expectOnlyDisplayResidual,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

const mockCloudControlSend = vi.fn();
const mockCloudFormationSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: vi.fn() } },
    cloudFormation: { send: mockCloudFormationSend },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

const { mockWarn, mockDebug } = vi.hoisted(() => ({ mockWarn: vi.fn(), mockDebug: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: mockDebug,
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return {
    getLogger: () => ({ ...child, child: () => child }),
  };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  clearPrimaryIdentifierCache,
  getPrimaryIdentifierFields,
  toCloudControlIdentifier,
} from '../../../src/provisioning/cc-import-identifier.js';
import { clearReadOnlyPropertiesCache } from '../../../src/provisioning/read-only-properties.js';
import { describeTypeRetryDelays } from '../../../src/provisioning/describe-type.js';

const CIDR_TYPE = 'AWS::EC2::VPCCidrBlock';
const ASSOC_ID = 'vpc-cidr-assoc-0123456789abcdef0';
const VPC_ID = 'vpc-0abc1234def567890';

/** The live registry schema's shape for the fields this path reads. */
const CIDR_SCHEMA = JSON.stringify({
  primaryIdentifier: ['/properties/Id', '/properties/VpcId'],
  readOnlyProperties: ['/properties/Id', '/properties/Ipv6CidrBlock'],
});

function wireGetResource(): void {
  mockCloudControlSend.mockImplementation(
    (cmd: { constructor: { name: string }; input: { Identifier?: string } }) => {
      if (cmd.constructor.name === 'GetResourceCommand') {
        return Promise.resolve({
          ResourceDescription: {
            Identifier: cmd.input.Identifier,
            Properties: JSON.stringify({ Id: ASSOC_ID, VpcId: VPC_ID }),
          },
        });
      }
      return Promise.reject(new Error(`unexpected command ${cmd.constructor.name}`));
    }
  );
}

function sentIdentifiers(): unknown[] {
  return mockCloudControlSend.mock.calls
    .filter((c) => (c[0] as { constructor: { name: string } }).constructor.name === 'GetResourceCommand')
    .map((c) => (c[0] as { input: { Identifier?: unknown } }).input.Identifier);
}

describe('CloudControlProvider.import composite identifier (issue #3672)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPrimaryIdentifierCache();
    clearReadOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  it("completes CloudFormation's bare VPCCidrBlock id with the template's VpcId, and records the composite", async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    wireGetResource();

    const result = await new CloudControlProvider().import({
      logicalId: 'VpcIpv6Cidr',
      resourceType: CIDR_TYPE,
      stackName: 'S',
      region: 'us-east-1',
      // What `cdkd import` hands over after its Ref pre-substitution.
      properties: { VpcId: VPC_ID, AmazonProvidedIpv6CidrBlock: true },
      knownPhysicalId: ASSOC_ID,
    });

    expect(sentIdentifiers()).toEqual([`${ASSOC_ID}|${VPC_ID}`]);
    expect(result?.physicalId).toBe(`${ASSOC_ID}|${VPC_ID}`);
    expect(result?.attributes).toMatchObject({ Id: ASSOC_ID });
  });

  it('passes an id that already carries the full composite through unchanged', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    wireGetResource();

    const result = await new CloudControlProvider().import({
      logicalId: 'VpcIpv6Cidr',
      resourceType: CIDR_TYPE,
      stackName: 'S',
      region: 'us-east-1',
      // A DIFFERENT template VpcId proves the supplied composite is not rebuilt.
      properties: { VpcId: 'vpc-0ffffffffffffffff' },
      knownPhysicalId: `${ASSOC_ID}|${VPC_ID}`,
    });

    expect(sentIdentifiers()).toEqual([`${ASSOC_ID}|${VPC_ID}`]);
    expect(result?.physicalId).toBe(`${ASSOC_ID}|${VPC_ID}`);
  });

  it('passes the id through unchanged when the schema cannot be read (the pre-#3672 behaviour)', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    wireGetResource();

    const result = await new CloudControlProvider().import({
      logicalId: 'VpcIpv6Cidr',
      resourceType: CIDR_TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: { VpcId: VPC_ID },
      knownPhysicalId: ASSOC_ID,
    });

    expect(sentIdentifiers()).toEqual([ASSOC_ID]);
    expect(result?.physicalId).toBe(ASSOC_ID);
  });

  it('refuses, without calling GetResource, when the template cannot supply the other field', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    wireGetResource();

    await expect(
      new CloudControlProvider().import({
        logicalId: 'VpcIpv6Cidr',
        resourceType: CIDR_TYPE,
        stackName: 'S',
        region: 'us-east-1',
        // An unsubstituted Ref: the VPC's id is not known.
        properties: { VpcId: { Ref: 'Vpc' } },
        knownPhysicalId: ASSOC_ID,
      })
    ).rejects.toThrow("--resource 'VpcIpv6Cidr=<Id>|<VpcId>'");
    expect(sentIdentifiers()).toEqual([]);
  });
});

describe('getPrimaryIdentifierFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPrimaryIdentifierCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  it('returns the fields in SCHEMA order, which is the order Cloud Control joins them in', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ primaryIdentifier: ['/properties/VpcId', '/properties/Id'] }),
    });
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['VpcId', 'Id']);
  });

  it('returns undefined for a nested pointer, which no template property maps onto', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ primaryIdentifier: ['/properties/A/B', '/properties/C'] }),
    });
    expect(await getPrimaryIdentifierFields('AWS::X::Y')).toBeUndefined();
  });

  it('does not cache a failed lookup', async () => {
    mockCloudFormationSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toBeUndefined();
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: CIDR_SCHEMA });
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['Id', 'VpcId']);
  });

  it('caches a successful lookup: a second call issues no DescribeType', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['Id', 'VpcId']);
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['Id', 'VpcId']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('skips DescribeType for a type with no registry schema', async () => {
    expect(await getPrimaryIdentifierFields('Custom::Thing')).toBeUndefined();
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });
});

describe('toCloudControlIdentifier', () => {
  const base = {
    resourceType: 'AWS::X::Y',
    logicalId: 'Res',
    fields: ['A', 'B', 'C'] as const,
  };

  it('fills the one field the template does not supply, in schema position', () => {
    expect(
      toCloudControlIdentifier({ ...base, physicalId: 'id-b', properties: { A: 'a', C: 'c' } })
    ).toBe('a|id-b|c');
  });

  it('uses the template composite when the template supplies every field, noting at DEBUG that the supplied id is set aside', () => {
    mockWarn.mockClear();
    mockDebug.mockClear();
    expect(
      toCloudControlIdentifier({
        ...base,
        physicalId: 'cfn-generated-name',
        properties: { A: 'a', B: 'b', C: 'c' },
      })
    ).toBe('a|b|c');
    // Expected on every ordinary migration of such a type, so never a warning.
    expect(mockWarn).not.toHaveBeenCalled();
    const noted = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('the supplied id cfn-generated-name is not used'));
    expect(noted).toHaveLength(1);
  });

  it('does not note a set-aside id when the supplied id is one of the template values', () => {
    mockDebug.mockClear();
    expect(
      toCloudControlIdentifier({ ...base, physicalId: 'b', properties: { A: 'a', B: 'b', C: 'c' } })
    ).toBe('a|b|c');
    const noted = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('is not used'));
    expect(noted).toHaveLength(0);
  });

  it('reads a numeric or boolean template value as its string form', () => {
    expect(
      toCloudControlIdentifier({
        ...base,
        physicalId: 'acl-1',
        properties: { B: 100, C: false },
      })
    ).toBe('acl-1|100|false');
  });

  it('passes a single-field id carrying a pipe through, rather than refusing its arity', () => {
    // A single-field type's id may legitimately contain `|` (CloudFormation
    // spells a custom-bus `AWS::Events::Rule` as `<bus>|<rule>`); only a
    // COMPOSITE type's arity is checked.
    expect(
      toCloudControlIdentifier({ ...base, fields: ['A'], physicalId: 'bus|rule', properties: { A: 'a' } })
    ).toBe('bus|rule');
  });

  it('passes a single-field type through', () => {
    expect(
      // `A` present in the template: a single-field type must NOT be completed
      // from it, so the supplied id wins.
      toCloudControlIdentifier({ ...base, fields: ['A'], physicalId: 'x', properties: { A: 'a' } })
    ).toBe('x');
  });

  it("passes Cloud Control's JSON identifier form through", () => {
    const json = '{"A":"a","B":"b","C":"c"}';
    expect(toCloudControlIdentifier({ ...base, physicalId: json, properties: {} })).toBe(json);
  });

  it('refuses when two or more fields are unknown', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'x', properties: { A: 'a' } })
    ).toThrow('no literal value for B or C');
  });

  it('treats a non-string or blank template value as unknown', () => {
    expect(() =>
      toCloudControlIdentifier({
        ...base,
        physicalId: 'x',
        properties: { A: { 'Fn::GetAtt': ['P', 'Id'] }, B: ' ', C: 'c' },
      })
    ).toThrow('no literal value for A or B');
  });

  it('refuses a supplied id equal to a value the template gives another field', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'a', properties: { A: 'a', C: 'c' } })
    ).toThrow('cannot be told which field it is');
  });

  it('refuses a composite of the wrong arity', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'a|b', properties: {} })
    ).toThrow("has 2 '|'-separated segments");
  });

  it('refuses a template value carrying the separator', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'id-b', properties: { A: 'x|y', C: 'c' } })
    ).toThrow("contains '|'");
  });

  it('does not read an inherited property as a template value', () => {
    const properties = Object.create({ A: 'inherited' }) as Record<string, unknown>;
    properties['C'] = 'c';
    expect(() => toCloudControlIdentifier({ ...base, physicalId: 'x', properties })).toThrow(
      'no literal value for A or B'
    );
  });

  /**
   * No value these messages name sits inside a hand-written `'...'`
   * (go-to-k/cdkd#3950). The DEBUG notes name it behind `displayIdent`'s
   * boundary; the three refusals, which end in the `--resource` remedy, describe
   * a value that is not plain; and the remedy names the logical id only when
   * `isPasteableIdent` admits it. Each `PASTE_PAYLOADS` family is rendered as
   * the supplied id, the logical id and the resource type, and every message is
   * fed WHOLE to the paste harness.
   */
  describe('a value in these messages is never inside cdkd quotes (go-to-k/cdkd#3950)', () => {
    const debugLines = (): string[] => mockDebug.mock.calls.map((c) => String(c[0]));
    const refusal = (input: Parameters<typeof toCloudControlIdentifier>[0]): string => {
      try {
        toCloudControlIdentifier(input);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('toCloudControlIdentifier did not refuse');
    };

    /** Every message one payload reaches, with the boundary it must show. */
    /**
     * The exact composite displays these messages render around a value, each
     * JSON-quoted: the harness sets aside only an EXACT display under its
     * OPERATOR_FLIP, so the site names the composites it prints.
     */
    const compositeDisplays = (v: string): string[] =>
      [`${v}|b`, `a|${v}|c`, `${v}|b|c`].map((c) => JSON.stringify(c));

    function messagesFor(v: string): Array<{ site: string; message: string; shown: string }> {
      const out: Array<{ site: string; message: string; shown: string }> = [];
      out.push({
        site: 'unplaceable id',
        message: refusal({ ...base, physicalId: v, properties: { A: 'a' } }),
        shown: 'so the supplied id (not shown: it is not a plain identifier) cannot be placed',
      });
      out.push({
        site: 'wrong arity',
        message: refusal({ ...base, physicalId: `${v}|b`, properties: {} }),
        shown: 'Res: the supplied id (not shown: it is not a plain identifier) has 2 ',
      });
      out.push({
        site: 'id equal to a template value',
        message: refusal({ ...base, physicalId: v, properties: { A: v, C: 'c' } }),
        shown: 'Res: the supplied id (not shown: it is not a plain identifier) equals',
      });
      out.push({
        site: 'hostile logical id',
        message: refusal({ ...base, logicalId: v, physicalId: 'x', properties: { A: 'a' } }),
        shown: 'AWS::X::Y (logical id not shown: it is not a plain identifier): ',
      });
      mockDebug.mockClear();
      toCloudControlIdentifier({ ...base, physicalId: v, properties: { A: 'a', B: 'b', C: 'c' } });
      out.push({
        site: 'set-aside note',
        message: debugLines().find((l) => l.includes('is not used')) ?? '',
        shown: `the supplied id ${JSON.stringify(v)} is not used`,
      });
      // The payload in the TEMPLATE, so it reaches the composite the note
      // names (`so <identifier> is looked up`) rather than the supplied id.
      mockDebug.mockClear();
      toCloudControlIdentifier({ ...base, physicalId: 'cfn-id', properties: { A: v, B: 'b', C: 'c' } });
      out.push({
        site: 'set-aside note, template composite',
        message: debugLines().find((l) => l.includes('is not used')) ?? '',
        shown: `so ${JSON.stringify(`${v}|b|c`)} is looked up`,
      });
      // The payload as the RESOURCE TYPE.
      out.push({
        site: 'hostile resource type',
        message: refusal({ ...base, resourceType: v, physicalId: 'x', properties: { A: 'a' } }),
        shown: '(resource type not shown: it is not a plain identifier) Res: ',
      });
      mockDebug.mockClear();
      toCloudControlIdentifier({ ...base, physicalId: v, properties: { A: 'a', C: 'c' } });
      out.push({
        site: 'completed note',
        message: debugLines().find((l) => l.includes(' completed ')) ?? '',
        shown: `completed ${JSON.stringify(v)} to the Cloud Control identifier ${JSON.stringify(`a|${v}|c`)}`,
      });
      return out;
    }

    it('names a PLAIN id bare, and a plain logical id in the --resource remedy', () => {
      const message = refusal({ ...base, physicalId: 'id-b', properties: { A: 'a' } });
      expect(message).toContain('so id-b cannot be placed');
      expect(message).toContain("--resource 'Res=<A>|<B>|<C>'");
      expect(message).not.toContain("'id-b'");
      // A composite carries `|`, which is not a plain identifier character, so
      // the arity refusal JSON-quotes even a legitimate one -- never `'a|b'`.
      const arity = refusal({ ...base, physicalId: 'a|b', properties: {} });
      expect(arity).toContain('Res: "a|b" has 2 ');
      expect(arity).not.toContain("'a|b'");
    });

    it('describes a type that displayIdent admits but the CloudFormation type shape refuses', () => {
      // `./x` and `A=b` print unquoted under `displayIdent`, and at the head of a
      // pasted line one runs a path and the other assigns a variable. Only
      // `resourceTypeShown`'s type shape refuses them, so this case reds if the
      // head falls back to `displayIdent` alone.
      for (const resourceType of ['./x', 'A=b']) {
        const message = refusal({ ...base, resourceType, physicalId: 'x', properties: { A: 'a' } });
        expect(message, resourceType).toMatch(/^\(resource type not shown: it is not a plain identifier\) Res: /);
        expect(message, resourceType).not.toContain(resourceType);
      }
    });

    it('names a long ARN whole, at the ARN ceiling rather than the 255 default', () => {
      const arn = `arn:aws:x:us-east-1:111122223333:thing/${'n'.repeat(1900)}`;
      const message = refusal({ ...base, physicalId: arn, properties: { A: 'a' } });
      expect(message).toContain(`so ${arn} cannot be placed`);
      expect(message).not.toContain('withheld');
    });

    it('holes a logical id the remedy could not carry, and describes it in the prose too', () => {
      for (const { value } of PASTE_PAYLOADS) {
        const message = refusal({ ...base, logicalId: value, physicalId: 'x', properties: { A: 'a' } });
        const fragment = message.split('instead: ')[1] ?? '';
        expect(fragment, value).toBe("--resource '<logicalId>=<A>|<B>|<C>'.");
        expect(message, value).toContain('AWS::X::Y (logical id not shown: it is not a plain identifier): ');
        expect(message, value).not.toContain(value);
      }
    });

    it('every payload is JSON-bounded, and no pasted span runs a command', () => {
      const rendered: Array<{ value: string; site: string; message: string; shown: string }> = [];
      for (const { value } of PASTE_PAYLOADS) {
        for (const m of messagesFor(value)) rendered.push({ value, ...m });
      }
      expect(rendered).toHaveLength(PASTE_PAYLOADS.length * 8);
      withPasteDir((dir) => {
        for (const { value, site, message, shown } of rendered) {
          const label = `${site}: ${value}`;
          expect(message, label).toContain(shown);
          expect(message, label).not.toContain(`'${value}'`);
          expect(message, label).not.toContain(`'${JSON.stringify(value)}'`);
          // Under the harness's OPERATOR_FLIP a displayed value holding `'` runs:
          // the go-to-k/cdkd#3950 residual, tracked for its fix by go-to-k/cdkd#4229.
          expectOnlyDisplayResidual(message, dir, value, {
            // The site's exact display, which can hold the value inside a
            // composite (`"<value>|b"`).
            displays: compositeDisplays(value),
          });
        }
      });
    }, 120_000);

    // A former S1 row (go-to-k/cdkd#3950, classified in the go-to-k/cdkd#4127
    // review M9): each refusal ends in the `--resource` remedy, so a payload
    // value there is described rather than displayed. Displayed, the
    // logical-id and resource-type payloads ran at the head of a clause under
    // both shells. The debug notes carry no command and stay under the
    // residual criterion above.
    const REFUSAL_SITES: ReadonlySet<string> = new Set([
      'unplaceable id',
      'wrong arity',
      'id equal to a template value',
      'hostile logical id',
      'hostile resource type',
    ]);

    it('the composite-id refusals describe every payload beside the --resource remedy, and no pasted span runs', () => {
      const refusals: Array<{ value: string; site: string; message: string }> = [];
      for (const { value } of PASTE_PAYLOADS) {
        for (const { site, message } of messagesFor(value)) {
          if (!REFUSAL_SITES.has(site)) continue;
          // The remedy itself, found before the rule is asked.
          expect(message, `${site}: ${value}`).toContain('Pass the Cloud Control identifier instead: --resource ');
          refusals.push({ value, site, message });
        }
      }
      expect(refusals).toHaveLength(PASTE_PAYLOADS.length * REFUSAL_SITES.size);
      withPasteDir((dir) => {
        for (const { value, site, message } of refusals) {
          expect(message, `${site}: ${value}`).not.toContain(value);
          expectNoCommandBesideDisplay(message, value);
          expect(spansThatRun(message, dir), `${site}: ${value}`).toEqual([]);
        }
      });
    }, 120_000);

    it('describes a physical id forged to end in displayIdent’s own cut marker', () => {
      // 2048 plain characters (the ARN cap) plus the 35-character marker for 35
      // withheld characters: `displayIdent` cuts it to exactly itself, so the
      // round-trip alone admits it and the whitespace test refuses it.
      const forged = `${'a'.repeat(2048)} [cut: 35 more characters withheld]`;
      expect(displayIdent(forged, { maxCodePoints: SECRET_REF_MAX_CODE_POINTS })).toBe(forged);
      const message = refusal({ ...base, physicalId: forged, properties: { A: 'a' } });
      expect(message).toContain('so the supplied id (not shown: it is not a plain identifier) cannot be placed');
    });

    it('describes a hostile logical id and resource type in all three refusal shapes', () => {
      // `refusalHead` is shared by the missing-field, wrong-arity and
      // equals-template refusals, so each shape is driven on its own
      // (go-to-k/cdkd#4209 review M2).
      const shapes = [
        { name: 'missing fields', over: { physicalId: 'x', properties: { A: 'a' } } },
        { name: 'wrong arity', over: { physicalId: 'a|b', properties: {} } },
        { name: 'equals a template value', over: { physicalId: 'x', properties: { A: 'x', C: 'c' } } },
      ];
      for (const { value } of PASTE_PAYLOADS) {
        for (const { name, over } of shapes) {
          const byId = refusal({ ...base, ...over, logicalId: value });
          expect(byId, `${name}: ${value}`).toContain('AWS::X::Y (logical id not shown: it is not a plain identifier): ');
          const byType = refusal({ ...base, ...over, resourceType: value });
          expect(byType, `${name}: ${value}`).toContain('(resource type not shown: it is not a plain identifier) Res: ');
          for (const message of [byId, byType]) {
            expect(message, `${name}: ${value}`).not.toContain(value);
            expectNoCommandBesideDisplay(message, value);
          }
        }
      }
    });

    it('still shows a plain composite and a long ARN in the refusals', () => {
      // `|` is not in the plain set, so the segments are tested one by one: a
      // legitimate composite stays shown, JSON-quoted, where it is inert.
      expect(refusal({ ...base, physicalId: 'a|b', properties: {} })).toContain('Res: "a|b" has 2 ');
      // An empty segment is plain too, so `a|` stays shown.
      expect(refusal({ ...base, physicalId: 'a|', properties: {} })).toContain('Res: "a|" has 2 ');
      const arn = `arn:aws:x:us-east-1:111122223333:thing/${'n'.repeat(1900)}`;
      expect(refusal({ ...base, physicalId: arn, properties: { A: 'a' } })).toContain(`so ${arn} cannot be placed`);
    });
  });
});
