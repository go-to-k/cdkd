import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  buildImportPlan,
  securityGroupRuleLookupRetryDelays,
} from '../../../src/cli/commands/export.js';
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
/** Every backoff the throttle retry asked for, in milliseconds. */
let sleeps: number[] = [];

beforeEach(() => {
  describeCalls = [];
  sleeps = [];
  // Drive the throttle backoff without burning its real ~15s schedule.
  securityGroupRuleLookupRetryDelays.sleep = async (ms: number) => {
    sleeps.push(ms);
  };
});

afterEach(() => {
  delete securityGroupRuleLookupRetryDelays.sleep;
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

function failingEc2Client(message: string, name?: string): AwsClients['ec2'] {
  return {
    async send(cmd: { input?: DescribeCall }) {
      describeCalls.push(cmd.input ?? {});
      const err = new Error(message);
      if (name) err.name = name;
      throw err;
    },
  } as unknown as AwsClients['ec2'];
}

/**
 * An EC2 stub that throttles its first `failures` calls and then answers from
 * `pages`. `RequestLimitExceeded` is THE common EC2 Describe failure, and it is
 * detected by error NAME (most AWS throttles are HTTP 400, not 429).
 */
function throttlingThenAnsweringEc2Client(
  failures: number,
  pages: StubRule[][]
): AwsClients['ec2'] {
  let thrown = 0;
  const inner = ec2ClientFor(pages) as unknown as { send: (cmd: unknown) => Promise<unknown> };
  return {
    async send(cmd: { input?: DescribeCall }) {
      if (thrown < failures) {
        thrown += 1;
        describeCalls.push(cmd.input ?? {});
        const err = new Error('Request limit exceeded.');
        err.name = 'RequestLimitExceeded';
        throw err;
      }
      return inner.send(cmd);
    },
  } as unknown as AwsClients['ec2'];
}

/**
 * An EC2 stub that answers page 1 normally and then throttles the first
 * `failures` requests that carry a `NextToken`. Distinct from
 * {@link throttlingThenAnsweringEc2Client}, which throttles page 1: the retry
 * has to wrap the request INSIDE the pagination loop, and a stub that only
 * ever throttles the first call cannot tell that apart from one wrapping the
 * walk from outside.
 */
function throttlingOnPagedRequestEc2Client(
  failures: number,
  pages: StubRule[][]
): AwsClients['ec2'] {
  let thrown = 0;
  const inner = ec2ClientFor(pages) as unknown as { send: (cmd: unknown) => Promise<unknown> };
  return {
    async send(cmd: { input?: DescribeCall }) {
      if (cmd.input?.NextToken && thrown < failures) {
        thrown += 1;
        describeCalls.push(cmd.input);
        const err = new Error('Request limit exceeded.');
        err.name = 'RequestLimitExceeded';
        throw err;
      }
      return inner.send(cmd);
    },
  } as unknown as AwsClients['ec2'];
}

/** Two ingress rows on ONE security group, differing only by port range. */
function stateWithTwoIngressRowsOnOneGroup(): StackState {
  const state = stateWithIngress(`${GROUP_ID}|tcp|443|443`);
  state.resources['OtherIn'] = {
    physicalId: `${GROUP_ID}|tcp|22|22`,
    resourceType: 'AWS::EC2::SecurityGroupIngress',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return state;
}

const TWO_ROW_TEMPLATE = {
  Resources: {
    SshIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} },
    OtherIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} },
  },
};

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

  it('refuses a MATCHING rule whose reported id is unusable — not "found NO rule"', async () => {
    // This test pinned the OPPOSITE behavior until the #1791 review: the
    // unusable ids were filtered out BEFORE the count, so two matching rules
    // became `ids.length === 0` and the refusal said cdkd "found NO ingress
    // rule matching <tuple>" — a false statement, since two rules did match.
    // A rule AWS reports without a usable id still cannot be handed to CFn
    // IMPORT, so the answer is a refusal either way; what changed is that it
    // now says what actually happened.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: '', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
        ],
      ])
    );

    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /found 2 ingress rule\(s\) matching protocol 'tcp', ports 443 on security group 'sg-0abc0def0', but 2 of them carry no usable 'sgr-\.\.\.' rule id/
    );
    // The raw values, so the user can see WHAT AWS reported.
    expect(plan.blocked[0]!.reason).toMatch(/AWS reported '', <absent>/);
    expect(plan.blocked[0]!.reason).not.toMatch(/found NO ingress rule matching/);
  });

  it('refuses a 2-match whose OTHER candidate has no id — never adopts the survivor', async () => {
    // The defect the count-before-filter ordering exists to prevent (issue
    // #1791 review, F1). AWS holds TWO rules with this tuple; one is reported
    // without an id. Filtering first collapses that to a single surviving id
    // and ADOPTS it — recording an identifier cdkd has not proven names this
    // row, which is exactly what the exactly-one discipline forbids.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
        ],
      ])
    );

    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(
      /found 2 ingress rule\(s\) matching.*but 1 of them carry no usable 'sgr-\.\.\.' rule id/s
    );
    // The count is a count of MATCHING RULES, and the message says so.
    expect(plan.blocked[0]!.reason).toMatch(/count of MATCHING RULES/);
  });

  it('gives a 2-match-with-an-unusable-id BOTH remedies, not just "open a cdkd issue"', async () => {
    // This row has two problems at once, and the unusable-id branch pre-empts
    // the `> 1` one — so its message used to be the only one the user saw, and
    // it prescribed "please open a cdkd issue". True about the unreadable id,
    // and no help at all about the ambiguity, which is the problem that would
    // remain even if AWS reported every id: two rules match this row's tuple.
    // The remedy the user can act on lives in the `> 1` message, so it is
    // appended here rather than left unreachable.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
        ],
      ])
    );

    const reason = plan.blocked[0]!.reason;
    // The unusable-id cause is still reported — this is an ADDITION, not a
    // swap of one message for the other.
    expect(reason).toMatch(/but 1 of them carry no usable 'sgr-\.\.\.' rule id/);
    expect(reason).toMatch(/please open a cdkd issue if it persists/);
    // ...and the ambiguity is named as a problem in its own right.
    expect(reason).toMatch(/2 rules matching one row is an ambiguity in its own right/);
    expect(reason).toMatch(/could not resolve even if every id were readable/);
    // Both causes of that ambiguity, verbatim from the `> 1` arm: only one of
    // them is splittable, so naming just the first sends half the users to a
    // remedy they cannot apply.
    expect(reason).toMatch(
      /MORE THAN ONE source.*one AWS::EC2::SecurityGroupIngress resource per source/s
    );
    expect(reason).toMatch(
      /TWO DISTINCT AWS::EC2::SecurityGroupIngress resources that differ only by SOURCE/
    );
    expect(reason).toMatch(/set the row's attributes\.Id to the 'sgr-\.\.\.' id that belongs to it/);
    // ...and that remedy is only actionable if cdkd names the ids it COULD
    // read. Asking the user to set attributes.Id to "the right one" while
    // withholding the candidates it saw is a remedy they cannot carry out.
    expect(reason).toMatch(
      new RegExp(`The readable candidates cdkd did see: '${SG_RULE_ID}'\\.`)
    );
  });

  it('does NOT prescribe the ambiguity remedy when only ONE rule matched', async () => {
    // The other polarity of the same branch: a single matching rule whose id
    // AWS reported unusable is NOT ambiguous — there is nothing to split and
    // no second candidate — so appending the two-cause remedy unconditionally
    // would send this user chasing a problem they do not have.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([[{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
    );

    const reason = plan.blocked[0]!.reason;
    expect(reason).toMatch(/found 1 ingress rule\(s\) matching/);
    expect(reason).toMatch(/please open a cdkd issue if it persists/);
    expect(reason).not.toMatch(/ambiguity in its own right/);
    expect(reason).not.toMatch(/MORE THAN ONE source/);
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

  it('names BOTH causes of an ambiguity, since only one of them is splittable', async () => {
    // The multi-source cause is not the only one: cdkd's composite carries no
    // SOURCE, so two DISTINCT resources (443 from a CIDR, 443 from a peer SG)
    // have byte-identical physical ids too — and those are already one
    // resource per source, so "split it" is not a remedy they can act on.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      ec2ClientFor([
        [
          { SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
        ],
      ])
    );

    const reason = plan.blocked[0]!.reason;
    expect(reason).toMatch(/MORE THAN ONE source.*one AWS::EC2::SecurityGroupIngress resource per source/s);
    expect(reason).toMatch(/TWO DISTINCT AWS::EC2::SecurityGroupIngress resources that differ only by SOURCE/);
    expect(reason).toMatch(/splitting is not their remedy/);
    expect(reason).toMatch(/set the row's attributes\.Id to the 'sgr-\.\.\.' id that belongs to it/);
  });

  // --- the composite parse guards (issue #1791 review, F2 / T2) -------------

  it('refuses a BLANK port segment instead of reading it as port 0', async () => {
    // `Number(''.trim())` is 0, not NaN — so this id used to parse to
    // `fromPort: 0` and go looking up a REAL tuple (ICMP type 0 is echo
    // reply), which could adopt an id for a rule the record does not name.
    // `EC2Provider.cfnIngressPortValue` reads the same blank as -1 (all
    // ports), so the two layers did not even agree on what it meant.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp||443`),
      ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 0, ToPort: 443 }]])
    );

    expect(describeCalls).toEqual([]);
    expect(plan.phase1Imports).toEqual([]);
    expect(plan.blocked[0]!.reason).toMatch(
      /is not cdkd's '<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>' composite/
    );
  });

  it('refuses a blank GROUP or PROTOCOL segment, WITHOUT calling AWS', async () => {
    for (const physicalId of [`|tcp|443|443`, `${GROUP_ID}| |443|443`]) {
      describeCalls = [];
      const plan = await planWith(
        stateWithIngress(physicalId),
        ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
      );

      expect(describeCalls).toEqual([]);
      expect(plan.blocked[0]!.reason).toMatch(
        /is not cdkd's '<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>' composite/
      );
    }
  });

  it('refuses a NON-NUMERIC port segment, WITHOUT calling AWS', async () => {
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|https|443`),
      ec2ClientFor([[{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }]])
    );

    expect(describeCalls).toEqual([]);
    expect(plan.blocked[0]!.reason).toMatch(
      /is not cdkd's '<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>' composite/
    );
  });

  // --- throttling (issue #1791 review, F3) ----------------------------------

  it('RETRIES a throttled lookup rather than aborting the whole export', async () => {
    // `RequestLimitExceeded` is the common EC2 Describe failure, and export is
    // all-or-nothing — so one un-retried throttle costs the entire run.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      throttlingThenAnsweringEc2Client(2, [
        [{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }],
      ])
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
    // Two throttles backed off on the doubling schedule (1s then 2s) before
    // the answer. Summed, because `withRetry` sleeps in 1s slices so it can
    // check for an interrupt once a second.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(3000);
  });

  it('retries a throttle on a SECOND page too — the retry is inside the walk', async () => {
    // Pins WHERE the retry sits. A refactor that hoists `withRetry` outside
    // the `do/while` still passes the page-1 throttle test above, but loses
    // every page after the first: the walk would restart from page 1 on a
    // retry, or the throttled page would abort the whole export. Long-lived
    // security groups are exactly the ones that paginate AND the ones whose
    // repeated describes get throttled, so this is not a hypothetical pair.
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      throttlingOnPagedRequestEc2Client(2, [
        [{ SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 22, ToPort: 22 }],
        [{ SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }],
      ])
    );

    expect(plan.blocked).toEqual([]);
    // The match lives on page 2, so healing at all proves the walk resumed
    // rather than answered from the page it already had.
    expect(plan.phase1Imports[0]!.resourceIdentifier).toEqual({ Id: SG_RULE_ID });
    // page 1, then the page-2 request throttled twice, then answered.
    expect(describeCalls).toHaveLength(4);
    expect(describeCalls.map((c) => c.NextToken)).toEqual([undefined, '1', '1', '1']);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(3000);
  });

  it('reports a persistent throttle AS a throttle — never as a missing permission', async () => {
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      failingEc2Client('Request limit exceeded.', 'RequestLimitExceeded')
    );

    expect(plan.blocked).toHaveLength(1);
    const reason = plan.blocked[0]!.reason;
    expect(reason).toMatch(/AWS throttled the lookup and cdkd retried it 4 times/);
    expect(reason).toMatch(/no permission is missing/);
    // The wrong advice this arm exists to stop: auditing a policy that was
    // correct all along, while "re-run it" goes unsaid.
    expect(reason).not.toMatch(/Grant ec2:DescribeSecurityGroupRules/);
    // 1 initial attempt + 4 retries, and the retries actually backed off
    // (1s + 2s + 4s + 8s = the ~15s budget the constant documents).
    expect(describeCalls).toHaveLength(5);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(15000);
  });

  it('recognizes EVERY authorization shape EC2 uses, not just the IAM sentence', async () => {
    // `isAuthorizationShapedError` offers four alternatives and only the
    // `not authorized to perform` sentence was exercised. The other three are
    // ERROR CODES rather than prose, and EC2 picks between them by API and by
    // credential problem — `UnauthorizedOperation` for a denied EC2 action,
    // `AuthFailure` for credentials AWS would not accept at all. Dropping any
    // one of them silently reclassifies that failure as the generic `failed`
    // kind, whose remedy ("re-run once that cause is resolved") never names
    // the permission the user is missing.
    for (const name of ['AccessDenied', 'UnauthorizedOperation', 'AuthFailure']) {
      describeCalls = [];
      sleeps = [];
      const plan = await planWith(
        stateWithIngress(`${GROUP_ID}|tcp|443|443`),
        // Deliberately NOT the IAM prose: the code must key on the NAME here,
        // or this test passes for the reason the existing one already covers.
        failingEc2Client('You do not have permission to access the specified resource.', name)
      );

      const reason = plan.blocked[0]!.reason;
      expect(reason, name).toMatch(/Grant ec2:DescribeSecurityGroupRules and re-run cdkd export/);
      // Not the throttle remedy, and not the generic one.
      expect(reason, name).not.toMatch(/AWS throttled the lookup/);
      expect(reason, name).not.toMatch(/Re-run cdkd export once that cause is resolved/);
      // A permissions failure cannot heal by waiting, so it is not retried.
      expect(describeCalls, name).toHaveLength(1);
      expect(sleeps, name).toEqual([]);
    }
  });

  it('does not prescribe the permission for a failure that is not about permissions', async () => {
    const plan = await planWith(
      stateWithIngress(`${GROUP_ID}|tcp|443|443`),
      failingEc2Client('The security group sg-0abc0def0 does not exist', 'InvalidGroup.NotFound')
    );

    const reason = plan.blocked[0]!.reason;
    expect(reason).toMatch(/lookup that would have recovered it failed.*does not exist/s);
    expect(reason).toMatch(/Re-run cdkd export once that cause is resolved/);
    expect(reason).not.toMatch(/Grant ec2:DescribeSecurityGroupRules/);
    // A non-throttle failure cannot heal by waiting, so it is surfaced at once.
    expect(describeCalls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  // --- per-group memoization (issue #1791 review, F5) ------------------------

  it('walks a security group ONCE for the many rows sitting on it', async () => {
    // N rows on one SG used to cost N paginated walks — N times the latency
    // and N chances to be throttled.
    const plan = await buildImportPlan(
      stateWithTwoIngressRowsOnOneGroup(),
      TWO_ROW_TEMPLATE,
      cfnClient(),
      'MyStack',
      {
        recreateImportUnsupported: true,
        ec2Client: ec2ClientFor([
          [
            { SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
            { SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 22, ToPort: 22 },
          ],
        ]),
      }
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.phase1Imports.map((p) => p.resourceIdentifier)).toEqual([
      { Id: SG_RULE_ID },
      { Id: OTHER_RULE_ID },
    ]);
    expect(describeCalls).toHaveLength(1);
  });

  it('walks each DISTINCT group, and starts a fresh memo per buildImportPlan call', async () => {
    // The memo is scoped to ONE call by construction: module-global state
    // would be shared across the stacks a concurrent run exports in parallel,
    // and the walk's answer is per-account / per-region.
    const state = stateWithTwoIngressRowsOnOneGroup();
    state.resources['OtherIn']!.physicalId = `sg-0fff1111|tcp|22|22`;
    const rulesFor = (): AwsClients['ec2'] =>
      ec2ClientFor([
        [
          { SecurityGroupRuleId: SG_RULE_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
          { SecurityGroupRuleId: OTHER_RULE_ID, IpProtocol: 'tcp', FromPort: 22, ToPort: 22 },
        ],
      ]);

    const opts = { recreateImportUnsupported: true, ec2Client: rulesFor() };
    const first = await buildImportPlan(state, TWO_ROW_TEMPLATE, cfnClient(), 'MyStack', opts);
    expect(first.blocked).toEqual([]);
    // One walk per GROUP, not one per row.
    expect(describeCalls.map((c) => c.Filters?.[0]?.Values?.[0])).toEqual([
      GROUP_ID,
      'sg-0fff1111',
    ]);

    describeCalls = [];
    await buildImportPlan(state, TWO_ROW_TEMPLATE, cfnClient(), 'MyStack', {
      recreateImportUnsupported: true,
      ec2Client: rulesFor(),
    });
    // A second call re-reads AWS: nothing survives from the first one.
    expect(describeCalls).toHaveLength(2);
  });

  it('names EACH row when one shared failed lookup blocks several of them', async () => {
    // What the memo caches is the OUTCOME, not an Error — a cached Error would
    // refuse the second row in the FIRST row's name.
    const plan = await buildImportPlan(
      stateWithTwoIngressRowsOnOneGroup(),
      TWO_ROW_TEMPLATE,
      cfnClient(),
      'MyStack',
      {
        recreateImportUnsupported: true,
        ec2Client: failingEc2Client(
          'User is not authorized to perform: ec2:DescribeSecurityGroupRules'
        ),
      }
    );

    expect(plan.blocked.map((b) => b.logicalId)).toEqual(['SshIn', 'OtherIn']);
    expect(plan.blocked[0]!.reason).toMatch(/rule id for 'SshIn'/);
    expect(plan.blocked[1]!.reason).toMatch(/rule id for 'OtherIn'/);
    // And the failure was paid ONCE, not once per row.
    expect(describeCalls).toHaveLength(1);
  });
});
