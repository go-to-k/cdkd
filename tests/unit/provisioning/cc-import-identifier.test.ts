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
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  expectOnlyDisplayResidual,
  spansThatRun,
  spansThatRunBesideTheDisplay,
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
   * Every value these messages name sits behind `displayIdent`'s boundary,
   * never inside a hand-written `'...'` (go-to-k/cdkd#3950), and the
   * `--resource` remedy names the logical id only when `isPasteableIdent`
   * admits it. Each `PASTE_PAYLOADS` family is rendered as the supplied id and
   * as the logical id, and every message -- the two refusals and the two DEBUG
   * notes -- is fed WHOLE to the paste harness.
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
    function messagesFor(v: string): Array<{ site: string; message: string; shown: string }> {
      const out: Array<{ site: string; message: string; shown: string }> = [];
      out.push({
        site: 'unplaceable id',
        message: refusal({ ...base, physicalId: v, properties: { A: 'a' } }),
        shown: `so ${JSON.stringify(v)} cannot be placed`,
      });
      out.push({
        site: 'wrong arity',
        message: refusal({ ...base, physicalId: `${v}|b`, properties: {} }),
        shown: `Res: ${JSON.stringify(`${v}|b`)} has 2 `,
      });
      out.push({
        site: 'id equal to a template value',
        message: refusal({ ...base, physicalId: v, properties: { A: v, C: 'c' } }),
        shown: `Res: ${JSON.stringify(v)} equals`,
      });
      out.push({
        site: 'hostile logical id',
        message: refusal({ ...base, logicalId: v, physicalId: 'x', properties: { A: 'a' } }),
        shown: `AWS::X::Y ${JSON.stringify(v)}: `,
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
        shown: `${JSON.stringify(v)} Res: `,
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

    it('names a long ARN whole, at the ARN ceiling rather than the 255 default', () => {
      const arn = `arn:aws:x:us-east-1:111122223333:thing/${'n'.repeat(1900)}`;
      const message = refusal({ ...base, physicalId: arn, properties: { A: 'a' } });
      expect(message).toContain(`so ${arn} cannot be placed`);
      expect(message).not.toContain('withheld');
    });

    it('holes a logical id the remedy could not carry, and still displays it in prose', () => {
      for (const { value } of PASTE_PAYLOADS) {
        const message = refusal({ ...base, logicalId: value, physicalId: 'x', properties: { A: 'a' } });
        const fragment = message.split('instead: ')[1] ?? '';
        expect(fragment, value).toBe("--resource '<logicalId>=<A>|<B>|<C>'.");
        expect(message, value).toContain(`AWS::X::Y ${JSON.stringify(value)}: `);
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
          // The five S1 refusals skip the default block rule until their fix
          // lands; their own case below asserts it.
          // Under the harness's OPERATOR_FLIP a displayed value holding `'` runs:
          // the go-to-k/cdkd#3950 residual, tracked for its fix by go-to-k/cdkd#4229.
          expectOnlyDisplayResidual(
            message,
            dir,
            value,
            S1_SITES.has(site) ? { unfixedS1Row: `go-to-k/cdkd#3950 composite-id ${site}` } : {}
          );
        }
      });
    }, 120_000);

    // S1 (go-to-k/cdkd#3950, the maintainer's 11:51Z rule, classified in the
    // go-to-k/cdkd#4127 review M9) until the row's source fix lands, which
    // flips the block-rule case: each refusal displays the payload (JSON) in a
    // block that ends in the `--resource` remedy. The two debug notes carry no
    // command and stay under the residual criterion above.
    const S1_SITES: ReadonlySet<string> = new Set([
      'unplaceable id',
      'wrong arity',
      'id equal to a template value',
      'hostile logical id',
      'hostile resource type',
    ]);
    const s1Refusals = (): Array<{ value: string; site: string; message: string }> => {
      const out: Array<{ value: string; site: string; message: string }> = [];
      for (const { value } of PASTE_PAYLOADS) {
        for (const { site, message } of messagesFor(value)) {
          if (!S1_SITES.has(site)) continue;
          // The row itself, found before any rule is asked.
          expect(message, `${site}: ${value}`).toContain('Pass the Cloud Control identifier instead: --resource ');
          out.push({ value, site, message });
        }
      }
      expect(out).toHaveLength(PASTE_PAYLOADS.length * S1_SITES.size);
      return out;
    };

    it('S1 composite-id refusals: a payload physical id runs nothing when pasted, under either shell', () => {
      // Measured per site: the three physical-id refusals run nothing under
      // bash or zsh, so they are pinned inert under both. The logical-id and
      // resource-type refusals display the payload at the head of a clause,
      // where it runs under BOTH shells with no verb: the residual the case
      // above asserts, as on `main`. Neither has a zsh-only difference, so
      // this row has no zsh paste case; its violation is the block rule's.
      const refusals = s1Refusals().filter(({ site }) =>
        ['unplaceable id', 'wrong arity', 'id equal to a template value'].includes(site)
      );
      expect(refusals).toHaveLength(PASTE_PAYLOADS.length * 3);
      withPasteDir((dir) => {
        for (const { value, site, message } of refusals) {
          // Beside the display (go-to-k/cdkd#4205 review): under the harness's
          // OPERATOR_FLIP the JSON-bounded display of a `'`-carrying value runs,
          // the classified go-to-k/cdkd#3950 residual (fix: go-to-k/cdkd#4229); all else strict.
          expect(spansThatRunBesideTheDisplay(message, dir, value), `${site}: ${value}`).toEqual([]);
        }
      });
    }, 120_000);

    it('S1 composite-id refusals: a payload block still carries the --resource remedy (block rule)', () => {
      for (const { value, site, message } of s1Refusals()) {
        expect(() => expectNoCommandBesideDisplay(message, value), `${site}: ${value}`).toThrow(
          /also carries a pasteable command/
        );
      }
    });
  });
});
