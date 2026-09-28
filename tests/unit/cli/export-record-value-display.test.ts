/**
 * `cdkd export` renders values read out of a state record's BODY — a
 * `physicalId`, a `properties` / `attributes` value, or a segment split out of
 * one — with their own boundary and a length cap (go-to-k/cdkd#3375). Nothing
 * validates those values on read, so a hand-written `'...'` around one is
 * exactly what a planted `'` closes, and a raw one can be any length.
 *
 * Both polarities per site family: a forging value stays inside a visible
 * JSON boundary, and an ordinary value renders exactly as it does in a real
 * record (bare, since it is a plain identifier).
 *
 * The plan rows `cdkd export` prints above its confirmation are driven through
 * the command in `export-plan-record-display.test.ts`.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildImportPlan,
  filterTemplateForImport,
  resolveCompositePhysicalIdIdentifier,
  securityGroupRuleLookupRetryDelays,
  groupBlockedReasons,
  indexNestedTemplatePaths,
  preDeletedLine,
  executeUpdateChangeSet,
  splitCompositePhysicalId,
  submitImportChangeSet,
} from '../../../src/cli/commands/export.js';
import { AWS_MESSAGE_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import { getLogger } from '../../../src/utils/logger.js';

/** Closes a hand-written `'...'` and writes its own clause after it. */
const QUOTE_FORGE = "abc'. Verified safe to import. 'x";

describe('composite physical-id refusals render the recorded id with its own boundary', () => {
  it('JSON-quotes a forging id, so its quote cannot close one of cdkd', () => {
    // One `|` segment where `AWS::ApiGateway::Method` needs three.
    const forged = `${QUOTE_FORGE}|b`;
    let message = '';
    try {
      splitCompositePhysicalId('AWS::ApiGateway::Method', forged);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`got 2: ${JSON.stringify(forged)}`);
    expect(message).not.toContain(`'${forged}'`);
  });

  it('renders an ordinary plain id bare', () => {
    expect(() => splitCompositePhysicalId('AWS::ApiGateway::Method', 'abc123')).toThrow(
      /got 1: abc123$/
    );
  });

  it('caps a planted multi-kilobyte id and says how much it withheld', () => {
    const forged = 'z'.repeat(5000);
    expect(() => splitCompositePhysicalId('AWS::ApiGateway::Method', forged)).toThrow(
      `[cut: ${5000 - 2048} more characters withheld]`
    );
  });
});

describe('the EC2::Route destination refusal renders recorded values with their own boundary', () => {
  it('JSON-quotes a forging destination segment in the refusal', () => {
    // The declared destination is an IPv4 CIDR, so the mismatch is decidable
    // and refused rather than warned.
    let message = '';
    try {
      splitCompositePhysicalId('AWS::EC2::Route', `rtb-1|${QUOTE_FORGE}`, {
        DestinationCidrBlock: '10.0.0.0/16',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`destination segment is ${JSON.stringify(QUOTE_FORGE)}.`);
    expect(message).toContain(`currently sits at ${JSON.stringify(QUOTE_FORGE)} —`);
    expect(message).not.toContain(`'${QUOTE_FORGE}'`);
  });

  it('JSON-quotes a forging recorded property in the warning', () => {
    // A declared value cdkd cannot normalise takes the WARNING arm.
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-1|10.1.0.0/16', {
        DestinationCidrBlock: QUOTE_FORGE,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain(`declare DestinationCidrBlock=${JSON.stringify(QUOTE_FORGE)}, but`);
      expect(message).not.toContain(`'${QUOTE_FORGE}'`);
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds the warning as a whole when several recorded values are long', () => {
    // Three destinations, each under the per-value cap, one line together.
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-1|10.1.0.0/16', {
        DestinationCidrBlock: 'a'.repeat(2000),
        DestinationIpv6CidrBlock: 'b'.repeat(2000),
        DestinationPrefixListId: 'c'.repeat(2000),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toMatch(/ \[cut: \d+ more characters withheld\]$/);
      expect(message.length).toBeLessThanOrEqual(AWS_MESSAGE_MAX_CODE_POINTS + 50);
    } finally {
      warn.mockRestore();
    }
  });

  it('renders ordinary recorded values bare', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-1|10.1.0.0/16', {
        DestinationCidrBlock: '10.0.0.0/16',
      })
    ).toThrow(
      'declare DestinationCidrBlock=10.0.0.0/16, but the physical id\'s destination segment is 10.1.0.0/16.'
    );
  });
});

/**
 * Values split out of a physical id or read off `attributes` into a LOCAL — the
 * shape the source fence in `export.test.ts` cannot see, so each is pinned
 * here by its forging polarity.
 */
describe('refusals naming a value split out of a record render it with its own boundary', () => {
  function thrown(fn: () => unknown): string {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected a throw');
  }

  it('the VPCCidrBlock reversed-segment refusal (the VPC id)', () => {
    const message = thrown(() =>
      splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `vpc-cidr-assoc-1|${QUOTE_FORGE}`)
    );
    expect(message).toContain(`${JSON.stringify(QUOTE_FORGE)} is not a VPC id`);
  });

  it('the VPCGatewayAttachment refusal (the gateway segment)', () => {
    const message = thrown(() =>
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', `${QUOTE_FORGE}|vpc-1`, {})
    );
    expect(message).toContain(`segment ${JSON.stringify(QUOTE_FORGE)} is not a recognized gateway id`);
  });

  it('renders an ordinary gateway segment bare', () => {
    expect(
      thrown(() => splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'x-1|vpc-1', {}))
    ).toContain('segment x-1 is not a recognized gateway id');
  });

  it('the ARN-attribute check shows the recorded value itself, padding included', () => {
    const message = thrown(() =>
      resolveCompositePhysicalIdIdentifier('AWS::AppSync::GraphQLApi', {
        logicalId: 'Api',
        physicalId: 'abcdefghijklmnopqrstuvwxyz',
        attributes: { Arn: `${QUOTE_FORGE} ` },
      })
    );
    // Not `.trim()`med first: the trailing space is part of what is recorded,
    // and the boundary is what shows it.
    expect(message).toContain(`attributes.Arn is recorded as ${JSON.stringify(`${QUOTE_FORGE} `)}`);
  });
});

describe('the SecurityGroupIngress refusals render recorded values with their own boundary', () => {
  const SCHEMA = {
    primaryIdentifier: ['/properties/Id'],
    handlers: { create: {}, read: {}, update: {}, delete: {}, list: {} },
  };
  const cfnClient = {
    async send() {
      return { Schema: JSON.stringify(SCHEMA), ProvisioningType: 'FULLY_MUTABLE' };
    },
  } as unknown as AwsClients['cloudFormation'];

  function state(physicalId: string, attributes: Record<string, unknown> = {}): StackState {
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
  const template = {
    Resources: { SshIn: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: {} } },
  };

  function ec2(send: () => Promise<unknown>): AwsClients['ec2'] {
    return { send } as unknown as AwsClients['ec2'];
  }

  async function reasonFor(st: StackState, ec2Client: AwsClients['ec2']): Promise<string> {
    const plan = await buildImportPlan(st, template, cfnClient, 'MyStack', {
      recreateImportUnsupported: true,
      ec2Client,
    });
    expect(plan.blocked).toHaveLength(1);
    return plan.blocked[0]!.reason;
  }

  it('the zero-match refusal (the protocol and group split out of the id)', async () => {
    const reason = await reasonFor(
      state(`${QUOTE_FORGE}|${QUOTE_FORGE}|443|443`),
      ec2(async () => ({ SecurityGroupRules: [] }))
    );
    expect(reason).toContain(
      `protocol ${JSON.stringify(QUOTE_FORGE)}, ports 443 on security group ${JSON.stringify(QUOTE_FORGE)}`
    );
  });

  it('the still-paginating refusal (the group)', async () => {
    const reason = await reasonFor(
      state(`${QUOTE_FORGE}|tcp|443|443`),
      ec2(async () => ({ SecurityGroupRules: [], NextToken: 'more' }))
    );
    expect(reason).toContain(`lookup on ${JSON.stringify(QUOTE_FORGE)} was still paginating`);
  });

  it('the unusable attributes.Id refusal (the recorded id)', () => {
    let message = '';
    try {
      resolveCompositePhysicalIdIdentifier('AWS::EC2::SecurityGroupIngress', {
        logicalId: 'SshIn',
        physicalId: 'sg-1|tcp|443|443',
        attributes: { Id: QUOTE_FORGE },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`attributes.Id is recorded as ${JSON.stringify(QUOTE_FORGE)}`);
  });

  it('the throttle retry names the group with its boundary', async () => {
    const debug = vi.fn();
    const child = vi
      .spyOn(getLogger(), 'child')
      .mockReturnValue({ debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
    securityGroupRuleLookupRetryDelays.sleep = async () => undefined;
    let calls = 0;
    try {
      await reasonFor(
        state(`${QUOTE_FORGE}|tcp|443|443`),
        ec2(async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error('Request limit exceeded.');
            err.name = 'RequestLimitExceeded';
            throw err;
          }
          return { SecurityGroupRules: [] };
        })
      );
    } finally {
      child.mockRestore();
      delete securityGroupRuleLookupRetryDelays.sleep;
    }
    const lines = debug.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(`DescribeSecurityGroupRules(${JSON.stringify(QUOTE_FORGE)})`))).toBe(
      true
    );
  });
});

describe('groupBlockedReasons bounds each reason (go-to-k/cdkd#3375)', () => {
  it('cuts a reason past the AWS-message cap and marks the cut', () => {
    const reason = 'y'.repeat(AWS_MESSAGE_MAX_CODE_POINTS + 500);
    const [line] = groupBlockedReasons([
      { logicalId: 'Bucket', resourceType: 'AWS::S3::Bucket', reason },
    ]);
    expect(line).toContain('[cut: 500 more characters withheld]');
    expect(line).toContain('y'.repeat(AWS_MESSAGE_MAX_CODE_POINTS));
    expect(line).not.toContain('y'.repeat(AWS_MESSAGE_MAX_CODE_POINTS + 1));
  });

  it('leaves an ordinary reason byte-identical', () => {
    expect(
      groupBlockedReasons([
        { logicalId: 'Bucket', resourceType: 'AWS::S3::Bucket', reason: 'no physical id' },
      ])
    ).toEqual(['  - Bucket (AWS::S3::Bucket): no physical id']);
  });
});

describe('the identifier-overlay warning and refusal render the recorded scalar with its own boundary', () => {
  const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';

  function entryFor(namespace: string) {
    const physicalId = `${BUCKET_ARN}|${namespace}`;
    return {
      logicalId: 'Ns',
      resourceType: 'AWS::S3Tables::Namespace',
      physicalId,
      ...splitCompositePhysicalId('AWS::S3Tables::Namespace', physicalId, {}),
    };
  }

  const template = (namespace: unknown): Record<string, unknown> => ({
    Resources: { Ns: { Type: 'AWS::S3Tables::Namespace', Properties: { Namespace: namespace } } },
  });

  function rewriteWarning(namespace: string): string {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      filterTemplateForImport(template(['analytics']), [entryFor(namespace)]);
      expect(warn).toHaveBeenCalledTimes(1);
      return String(warn.mock.calls[0]![0]);
    } finally {
      warn.mockRestore();
    }
  }

  it('JSON-quotes a forging recorded scalar in the rewrite warning', () => {
    const message = rewriteWarning(QUOTE_FORGE);
    expect(message).toContain(`to the scalar ${JSON.stringify(QUOTE_FORGE)} recorded in cdkd state`);
    expect(message).not.toContain(`'${QUOTE_FORGE}'`);
  });

  it('renders an ordinary recorded scalar bare in the rewrite warning', () => {
    expect(rewriteWarning('analytics')).toContain(
      'Ns (AWS::S3Tables::Namespace): rewriting the identifier property Namespace from'
    );
    expect(rewriteWarning('analytics')).toContain('to the scalar analytics recorded in cdkd state');
  });

  it('JSON-quotes a forging recorded scalar in the unrepresentable-list refusal', () => {
    expect(() =>
      filterTemplateForImport(template([{ Ref: 'Parent' }]), [entryFor(QUOTE_FORGE)])
    ).toThrow(`Declare Namespace as the scalar ${JSON.stringify(QUOTE_FORGE)} (or drop`);
  });

  it('renders an ordinary recorded scalar bare in the refusal', () => {
    expect(() =>
      filterTemplateForImport(template([{ Ref: 'Parent' }]), [entryFor('analytics')])
    ).toThrow('Declare Namespace as the scalar analytics (or drop');
  });
});

describe('the nested-stack asset-path refusals render the logical id without cdkd quotes (go-to-k/cdkd#3617)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-export-record-display-')));
  const template = (logicalId: string): Record<string, unknown> => ({
    Resources: {
      [logicalId]: {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': '/abs/child.template.json' },
      },
    },
  });

  it('JSON-quotes a forging logical id', () => {
    expect(() => indexNestedTemplatePaths(template(QUOTE_FORGE), dir)).toThrow(
      `cdkd export: nested-stack ${JSON.stringify(QUOTE_FORGE)} has `
    );
  });

  it('renders an ordinary logical id bare', () => {
    expect(() => indexNestedTemplatePaths(template('Child'), dir)).toThrow(
      "cdkd export: nested-stack Child has Metadata['aws:asset:path']="
    );
  });
});

describe('preDeletedLine renders the recorded physical id with its own boundary', () => {
  it('keeps a forging id on its one line, JSON-quoted', () => {
    const forged = '$default\n  ✓ deleted prod-stage';
    const line = preDeletedLine(forged);
    expect(line).not.toContain('\n');
    // Escaped, not replaced: the value stays recoverable and reads as ONE
    // value, not a second row.
    expect(line).toBe(String.raw`✓ deleted "$default\n  \u2713 deleted prod-stage"`);
  });

  it('renders an ordinary plain id bare', () => {
    expect(preDeletedLine('abc123')).toBe('✓ deleted abc123');
  });

  // Real AWS identifiers carrying `$`, `|`, `#` and `*` printed bare before
  // go-to-k/cdkd#3375 and still do (the `export` integ fixture greps
  // `Qualifier=$LATEST`).
  it.each([
    ['a Lambda qualifier', '$LATEST'],
    ['an API Gateway v2 stage', '$default'],
    ['an API Gateway v2 route key', '$connect'],
    ['a cdkd composite physical id', 'a1b2c3|r4s5t6|GET'],
    ['a log-group name', '/aws/lambda/fn#1'],
    ['a Route 53 wildcard record', '*.example.com'],
  ])('renders %s bare', (_what, id) => {
    expect(preDeletedLine(id)).toBe(`✓ deleted ${id}`);
  });

  // ...while anything that could close a quote, spell an annotation or run
  // together with the surrounding line keeps its boundary.
  it.each([
    ['a space-separated annotation', '$default (AWS::S3::Bucket)'],
    ['a command substitution', '$(touch x)'],
    ['a quote', "$LATEST'"],
    ['a trailing space', '$LATEST '],
    ['a bracket', '$default[0]'],
  ])('keeps %s quoted', (_what, id) => {
    expect(preDeletedLine(id)).toBe(`✓ deleted ${JSON.stringify(id)}`);
  });

  it('caps the ESCAPED text, so escaping cannot multiply the payload', () => {
    // Each of these escapes to six characters; an astral one to twelve.
    for (const unit of ['\u2028', '\u{1F600}']) {
      const line = preDeletedLine(unit.repeat(3000));
      const shown = line.slice('✓ deleted '.length);
      expect(shown).toMatch(/^"[ -~]*" \[cut: \d+ more characters withheld\]$/);
      expect(shown.indexOf('" [cut:')).toBeLessThanOrEqual(2048 + 1);
      // The cut lands between escapes, never inside one.
      expect(shown.slice(0, shown.indexOf('" [cut:'))).toMatch(/^"(?:\\u[0-9a-f]{4})*$/);
    }
  });

  it('renders a plain id of exactly the cap bare, and one past it cut', () => {
    expect(preDeletedLine('a'.repeat(2048))).toBe(`✓ deleted ${'a'.repeat(2048)}`);
    expect(preDeletedLine('a'.repeat(2049))).toBe(
      `✓ deleted "${'a'.repeat(2048)}" [cut: 1 more characters withheld]`
    );
  });

  it('caps a planted multi-kilobyte id', () => {
    expect(preDeletedLine('z'.repeat(3000))).toContain(
      `[cut: ${3000 - 2048} more characters withheld]`
    );
  });
});

/**
 * CloudFormation can QUOTE the submitted ResourceIdentifier — a state record's
 * physical id — back in its failure reasons, so those reasons are folded to
 * one line and bounded where cdkd renders them.
 */
describe('CloudFormation IMPORT failure reasons are folded and bounded', () => {
  const ECHO = `Identifier stage\nRe-run with: rm -rf ~ ${'r'.repeat(5000)}`;

  function cfn(answers: Record<string, () => unknown>): AwsClients['cloudFormation'] {
    return {
      async send(cmd: { constructor: { name: string } }) {
        const answer = answers[cmd.constructor.name];
        if (!answer) throw new Error(`unexpected ${cmd.constructor.name}`);
        return answer();
      },
    } as unknown as AwsClients['cloudFormation'];
  }

  it('the changeset-creation StatusReason', async () => {
    const client = cfn({
      CreateChangeSetCommand: () => ({}),
      DescribeChangeSetCommand: () => ({ Status: 'FAILED', StatusReason: ECHO }),
      DeleteChangeSetCommand: () => ({}),
    });
    const error = await submitImportChangeSet(client, 'S', { Resources: {} }, [], []).catch(
      (e: unknown) => e as Error
    );
    expect(error?.message).toMatch(/^IMPORT changeset FAILED: Identifier stage Re-run with: rm -rf ~ r+ \[cut: \d+ more characters withheld\]$/);
  });

  it('the phase-2 UPDATE changeset StatusReason', async () => {
    const client = cfn({
      CreateChangeSetCommand: () => ({}),
      DescribeChangeSetCommand: () => ({ Status: 'FAILED', StatusReason: ECHO }),
      DeleteChangeSetCommand: () => ({}),
    });
    const error = await executeUpdateChangeSet(client, 'S', { Resources: {} }, []).catch(
      (e: unknown) => e as Error
    );
    expect(error?.message).toMatch(
      /^UPDATE changeset FAILED: Identifier stage Re-run with: rm -rf ~ r+ \[cut: \d+ more characters withheld\]$/
    );
  });

  it('the UPDATE and IMPORT CreateChangeSet rejections', async () => {
    const rejecting = cfn({
      CreateChangeSetCommand: () => {
        throw new Error(ECHO);
      },
    });
    for (const run of [
      () => executeUpdateChangeSet(rejecting, 'S', { Resources: {} }, []),
      () => submitImportChangeSet(rejecting, 'S', { Resources: {} }, [], []),
    ]) {
      const error = await run().catch((e: unknown) => e as Error);
      expect(error?.message).toMatch(
        /^Failed to create (?:UPDATE|IMPORT) changeset: Identifier stage Re-run with: rm -rf ~ r+ \[cut: \d+ more characters withheld\]$/
      );
    }
  });

  it('each per-resource ResourceStatusReason in the execute-failure summary', async () => {
    const client = cfn({
      CreateChangeSetCommand: () => ({}),
      DescribeChangeSetCommand: () => ({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE' }),
      ExecuteChangeSetCommand: () => ({}),
      DescribeStacksCommand: () => ({
        Stacks: [{ StackName: 'S', StackStatus: 'IMPORT_ROLLBACK_COMPLETE' }],
      }),
      DescribeStackEventsCommand: () => ({
        StackEvents: [
          {
            LogicalResourceId: 'Stage',
            ResourceType: 'AWS::ApiGatewayV2::Stage',
            ResourceStatus: 'IMPORT_FAILED',
            ResourceStatusReason: ECHO,
          },
          {
            // Each field of a row keeps its own boundary.
            LogicalResourceId: "Other) ok'",
            ResourceType: 'AWS::S3::Bucket',
            ResourceStatus: 'IMPORT_FAILED',
            ResourceStatusReason: 'short',
          },
        ],
      }),
      DeleteChangeSetCommand: () => ({}),
    });
    const error = await submitImportChangeSet(client, 'S', { Resources: {} }, [], []).catch(
      (e: unknown) => e as Error
    );
    const lines = (error?.message ?? '').split('\n');
    // The header, then exactly one row per event: the echoed newline did not
    // start another.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`  - ${JSON.stringify("Other) ok'")} (AWS::S3::Bucket): short`);
    expect(lines[0]).toBe('IMPORT changeset failed:');
    expect(lines[1]).toMatch(
      /^ {2}- Stage \(AWS::ApiGatewayV2::Stage\): Identifier stage Re-run with: rm -rf ~ r+ \[cut: \d+ more characters withheld\]$/
    );
  });
});
