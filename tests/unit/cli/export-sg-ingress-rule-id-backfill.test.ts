import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { buildImportPlan } from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issue [#1791](https://github.com/go-to-k/cdkd/issues/1791) — `cdkd export`'s
 * live-read BACKFILL of the `sgr-...` rule id for an
 * `AWS::EC2::SecurityGroupIngress` row that cdkd state does not carry one for.
 *
 * Every such row written by a cdkd older than issue #1761 has `attributes: {}`,
 * and `cdkd export` is all-or-nothing — so ONE of them makes a whole stack
 * un-exportable. The workaround the state-only message offers does not exist
 * for a no-op deploy: AWS returns the id only from
 * `AuthorizeSecurityGroupIngress`'s own response.
 *
 * The three arms fenced below are the ones the exactly-one discipline splits
 * into: exactly one match HEALS, zero matches REFUSES, and more than one
 * REFUSES naming the candidates — because two AWS rules sharing cdkd's
 * `<groupId>|<ipProtocol>|<fromPort>|<toPort>` tuple are two rules cdkd's own
 * physical id cannot tell apart either.
 */

/** Measured live (us-east-1, 2026-08-14) as a standalone rule's CFn `PhysicalResourceId`. */
const SG_RULE_ID = 'sgr-02345615af6d2db0d';
const OTHER_RULE_ID = 'sgr-0999888877776666a';
const GROUP_ID = 'sg-0abc0def0';

const SG_INGRESS_SCHEMA = {
  primaryIdentifier: ['/properties/Id'],
  handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
  provisioningType: 'FULLY_MUTABLE',
};

function cfnClient(): AwsClients['cloudFormation'] {
  return {
    async send(cmd: { input?: { TypeName?: string } }) {
      const typeName = cmd.input?.TypeName ?? '';
      if (typeName !== 'AWS::EC2::SecurityGroupIngress') {
        throw new Error(`DescribeType stub: no schema for ${typeName}`);
      }
      const { provisioningType, ...schemaJson } = SG_INGRESS_SCHEMA;
      return { Schema: JSON.stringify(schemaJson), ProvisioningType: provisioningType };
    },
  } as unknown as AwsClients['cloudFormation'];
}

interface StubRule {
  SecurityGroupRuleId?: string;
  IsEgress?: boolean;
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
}

interface DescribeCall {
  Filters?: Array<{ Name?: string; Values?: string[] }>;
  MaxResults?: number;
  NextToken?: string;
}

/** Every `DescribeSecurityGroupRules` request the plan builder issued. */
let describeCalls: DescribeCall[] = [];

beforeEach(() => {
  describeCalls = [];
});

/**
 * An EC2 stub answering `DescribeSecurityGroupRules` from a fixed page list.
 * One page = one round trip; a `NextToken` is synthesized between pages so the
 * pagination walk is exercised rather than assumed.
 */
function ec2ClientFor(pages: StubRule[][]): AwsClients['ec2'] {
  return {
    async send(cmd: { input?: DescribeCall }) {
      const input = cmd.input ?? {};
      describeCalls.push(input);
      const index = input.NextToken ? Number(input.NextToken) : 0;
      const page = pages[index] ?? [];
      const hasMore = index + 1 < pages.length;
      return {
        SecurityGroupRules: page,
        ...(hasMore && { NextToken: String(index + 1) }),
      };
    },
  } as unknown as AwsClients['ec2'];
}

/** An EC2 stub whose every page reports another one — the runaway-token shape. */
function endlesslyPaginatingEc2Client(): AwsClients['ec2'] {
  return {
    async send(cmd: { input?: DescribeCall }) {
      describeCalls.push(cmd.input ?? {});
      return { SecurityGroupRules: [], NextToken: 'more' };
    },
  } as unknown as AwsClients['ec2'];
}

function failingEc2Client(message: string): AwsClients['ec2'] {
  return {
    async send(cmd: { input?: DescribeCall }) {
      describeCalls.push(cmd.input ?? {});
      throw new Error(message);
    },
  } as unknown as AwsClients['ec2'];
}

function stateWithIngress(physicalId: string, attributes: Record<string, unknown> = {}): StackState {
  return {
    version: 8,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: {
      SshIn: {
        physicalId,
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        properties: {},
        attributes,
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

const TEMPLATE = {
  Resources: { SshIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} } },
};

function planWith(
  state: StackState,
  ec2Client: AwsClients['ec2'] | undefined
): ReturnType<typeof buildImportPlan> {
  return buildImportPlan(state, TEMPLATE, cfnClient(), 'MyStack', {
    recreateImportUnsupported: true,
    ...(ec2Client && { ec2Client }),
  });
}

describe('cdkd export — SecurityGroupIngress rule-id backfill (issue #1791)', () => {
  it('heals a pre-#1761 row from an EXACTLY ONE live match', async () => {
    // The headline case: `attributes: {}`, which every row written before issue
    // #1761 carries. Without the backfill this row is `blocked` and, because
    // export is all-or-nothing, so is the whole stack.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          // Same group, different tuple — must not be considered.
          { SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 22, ToPort: 22 },
        ],
      ])
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports).toHaveLength(1);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
    // `Id` is `readOnlyProperties`, so nothing may be overlaid onto Properties.
    expect(plan.phase1Imports[0]!.propertiesOverlay).toEqual({});
  });

  it('filters the live lookup by the recorded GROUP and pins MaxResults', async () => {
    // `MaxResults` is what makes the page ceiling mean a known number of rules;
    // without it AWS picks its own page size and the bound caps an unknown one.
    await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
    );

    expect(describeCalls).toHaveLength(1);
    expect(describeCalls[0]!.Filters).toEqual([{ Name: 'group-id', Values: [GROUP_ID] }]);
    expect(describeCalls[0]!.MaxResults).toBe(1000);
  });

  it('refuses ZERO matches, naming the row and the tuple it searched for', async () => {
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      // Right group, wrong ports — the rule cdkd recorded is gone.
      ec2ClientFor([[{ SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 22, ToPort: 22 }]])
    );

    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.logicalId).toBe('SshIn');
    expect(plan.blocked[0]!.reason).toMatch(
      /'SshIn'.*found NO ingress rule matching protocol 'tcp', ports 443 on security group 'sg-0abc0def0'/s
    );
    // The two live causes, and the escape hatch — a message that only said
    // "not found" would leave the user with nothing to do.
    expect(plan.blocked[0]!.reason).toMatch(/revoked outside cdkd/);
    expect(plan.blocked[0]!.reason).toMatch(/region other than the one this export is running/);
    expect(plan.blocked[0]!.reason).toMatch(/remove 'SshIn' from the stack before exporting/);
    // NOT the state-only refusal: cdkd has just asked AWS, so "re-deploy so
    // cdkd records the id" has been disproven for this row.
    expect(plan.blocked[0]!.reason).not.toMatch(/no-op re-deploy will NOT heal/);
  });

  it('refuses MORE THAN ONE match, naming every candidate rather than guessing', async () => {
    // The multi-source shape: one CFn resource declaring both `CidrIp` and
    // `CidrIpv6` makes AWS mint one rule PER SOURCE, both carrying this exact
    // tuple. Adopting either would record an identifier naming the wrong rule.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
        ],
      ])
    );

    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      new RegExp(
        `'SshIn'.*found 2 ingress rules matching protocol 'tcp', ports 443 on security group ` +
          `'${GROUP_ID}' \\(${SG_RULE_ID}, ${OTHER_RULE_ID}\\)`,
        's'
      )
    );
    expect(plan.blocked[0]!.reason).toMatch(
      /MORE THAN ONE source.*one AWS::EC2::SecurityGroupIngress resource per source/s
    );
  });

  it('detects an ambiguity SPLIT ACROSS PAGES rather than answering from page 1', async () => {
    // Why the walk is paginated at all: a truncated first page turns a genuine
    // 2-match into a false "exactly one" and records the wrong rule id.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }],
        [{ SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }],
      ])
    );

    expect(describeCalls).toHaveLength(2);
    expect(describeCalls[1]!.NextToken).toBe('1');
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/found 2 ingress rules matching/);
  });

  it('refuses rather than answering from a partial view when the walk never terminates', async () => {
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      endlesslyPaginatingEc2Client()
    );

    expect(describeCalls).toHaveLength(20);
    expect(plan.blocked[0]!.reason).toMatch(
      /still paginating after 20 pages.*cannot prove a match is unique/s
    );
  });

  it('canonicalizes the protocol on BOTH sides — a composite packed from IpProtocol: 6', async () => {
    // EC2 rewrites the four protocol numbers it has a name for before storing
    // the rule, so a record packed from `IpProtocol: 6` carries '6' while the
    // readback says 'tcp'. A raw compare matches nothing and refuses a row the
    // backfill exists to heal (the issue #1643 fold, at a fourth call site).
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|6|443|443`),
      ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
  });

  it('matches the ALL-PORTS composite against a rule AWS reports with -1 ports', async () => {
    // `EC2Provider` packs '-1' for an absent FromPort / ToPort, which is the
    // same spelling AWS reads back — so the two sides compare directly.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|-1|-1|-1`),
      ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: '-1', FromPort: -1, ToPort: -1 }]])
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
  });

  it('treats an OMITTED FromPort / ToPort in the readback as AWS -1', async () => {
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|-1|-1|-1`),
      ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: '-1' }]])
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
  });

  it('ignores the EGRESS rule sharing the tuple — the type is ingress-only', async () => {
    // A group commonly carries an egress rule on the same protocol and ports.
    // Counting it would make every such row ambiguous and refuse.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: OTHER_RULE_ID, IsEgress: true, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { SecurityGroupRuleId: SG_RULE_ID, IsEgress: false, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
        ],
      ])
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
  });

  it('ignores a matching rule whose reported id is not an sgr- value', async () => {
    // The same anchored predicate the recorded-attribute arm applies. A rule
    // AWS reports without a usable id cannot be handed to CFn IMPORT, so it
    // must not be counted as the match either.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: '', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
        ],
      ])
    );

    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/found NO ingress rule matching/);
  });

  it('refuses a physical id that is not cdkd composite, WITHOUT calling AWS', async () => {
    // A 5-segment id is the issue #1672 ambiguity (a segment carrying the
    // separator). Decoding its first four parts would look up a DIFFERENT
    // rule's tuple, so it is refused like any other unparseable shape.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443|extra`),
      ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
    );

    expect(describeCalls).toEqual([]);
    expect(plan.blocked[0]!.reason).toMatch(
      /is not cdkd's '<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>' composite/
    );
  });

  it('surfaces a lookup FAILURE as its own refusal, naming the permission', async () => {
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      failingEc2Client('User is not authorized to perform: ec2:DescribeSecurityGroupRules')
    );

    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /lookup that would have recovered it failed.*not authorized.*Grant ec2:DescribeSecurityGroupRules/s
    );
  });

  it('issues NO live read for a row whose state already records the rule id', async () => {
    // The property that makes the backfill free for every current deployment:
    // it is reached only when the state-only resolution THREW.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`, { Id: SG_RULE_ID }),
      ec2ClientFor([[{ SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
    );

    expect(describeCalls).toEqual([]);
    expect(plan.blocked).toEqual([]);
    // Resolved from state, so it is the RECORDED id — not the one the stub
    // would have reported, which is what proves no live read happened.
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
  });

  it('issues NO live read for a bare sgr- physicalId either — the second state arm', async () => {
    const plan = await planWith(
      stateWithIngress(SG_RULE_ID),
      ec2ClientFor([[{ SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
    );

    expect(describeCalls).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
  });

  it('keeps the pre-#1791 state-only refusal when no EC2 client is supplied', async () => {
    const plan = await planWith(stateWithIngress(`${GROUP_ID}|tcp|443|443`), undefined);

    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /attributes\.Id is missing or empty.*no-op re-deploy will NOT heal the record/s
    );
  });

  it('does not abort the run — a sibling row still resolves alongside the refusal', async () => {
    const state = stateWithIngress(`${GROUP_ID}|tcp|443|443`);
    state.resources['OtherIn'] = {
      physicalId: `${GROUP_ID}|tcp|22|22`,
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      properties: {},
      attributes: {},
      dependencies: [],
    };
    const template = {
      Resources: {
        SshIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} },
        OtherIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} },
      },
    };
    const plan = await buildImportPlan(state, template, cfnClient(), 'MyStack', {
      recreateImportUnsupported: true,
      ec2Client: ec2ClientFor([
        [{ SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 22, ToPort: 22 }],
      ]),
    });

    expect(plan.blocked.map((b) => b.logicalId)).toEqual(['SshIn']);
    expect(plan.phase1Imports.map((p) => p.logicalId)).toEqual(['OtherIn']);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: OTHER_RULE_ID });
  });
});
