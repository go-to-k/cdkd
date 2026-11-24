/**
 * go-to-k/cdkd#6713: the deploy's plan (`cdkd diff`, `--fail-on destructive`,
 * the `--require-approval` listing and `--json`) names a replacement whose old
 * copy is deleted before the deploy succeeds, so the loss is visible before it
 * happens, in the rollback's vocabulary.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  findDestructiveChanges,
  formatDestructiveChange,
} from '../../../src/analyzer/destructive-changes.js';
import { renderApprovalRequest } from '../../../src/cli/commands/require-approval.js';
import { renderDiffTree } from '../../../src/cli/commands/diff-recursive/render.js';
import { diffTreeToJson } from '../../../src/cli/commands/diff-recursive/json.js';
import type { DiffTreeNode } from '../../../src/cli/commands/diff-recursive/types.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

const CONSEQUENCE =
  "a failed deploy's rollback does not restore what AWS held for it beyond its recorded properties";

const rec = (resourceType: string): ResourceState =>
  ({ physicalId: 'p', resourceType, properties: {} }) as ResourceState;

const update = (
  logicalId: string,
  resourceType: string,
  extra: Partial<ResourceChange> = {}
): ResourceChange => ({
  logicalId,
  changeType: 'UPDATE',
  resourceType,
  propertyChanges: [],
  ...extra,
});

const classify = (
  change: ResourceChange,
  opts: { recreate?: boolean; template?: CloudFormationTemplate; recordType?: string } = {}
) =>
  findDestructiveChanges(
    'S',
    [change],
    { [change.logicalId]: rec(opts.recordType ?? change.resourceType) },
    opts.template,
    new Set(opts.recreate === true ? [change.logicalId] : [])
  );

describe('findDestructiveChanges: earlyDelete (#6713)', () => {
  it('a --recreate-via-* target is deleted before its replacement is created', () => {
    const [found] = classify(update('Q', 'AWS::SQS::Queue'), { recreate: true });
    expect(found).toMatchObject({ impact: 'WILL_REPLACE', earlyDelete: 'recreate' });
    expect(formatDestructiveChange(found!)).toBe(
      'S: AWS::SQS::Queue Q will be replaced — the deploy deletes the old resource before creating ' +
        `its replacement (unless the replacement takes another name), so ${CONSEQUENCE}`
    );
  });

  it('a --recreate-via-* target under UpdateReplacePolicy: Retain keeps its old copy', () => {
    const template: CloudFormationTemplate = {
      Resources: { Q: { Type: 'AWS::SQS::Queue', UpdateReplacePolicy: 'Retain' } },
    };
    const [found] = classify(update('Q', 'AWS::SQS::Queue'), { recreate: true, template });
    expect(found).toMatchObject({ impact: 'WILL_REPLACE' });
    expect(found).not.toHaveProperty('earlyDelete');
  });

  it("an SNS subscription the provider re-creates is deleted before its replacement", () => {
    const [found] = classify(
      update('Sub', 'AWS::SNS::Subscription', { providerReplacement: 'its FilterPolicyScope changed' })
    );
    expect(found).toMatchObject({ impact: 'WILL_REPLACE', earlyDelete: 'before-create' });
    expect(formatDestructiveChange(found!)).toBe(
      'S: AWS::SNS::Subscription Sub will be replaced — the deploy deletes the old resource before ' +
        `creating its replacement, so ${CONSEQUENCE}`
    );
  });

  it('a renamed Route 53 record set is deleted in the batch that creates the new one', () => {
    const [found] = classify(
      update('Rec', 'AWS::Route53::RecordSet', { providerReplacement: 'its Name changed' })
    );
    expect(found).toMatchObject({ impact: 'WILL_REPLACE', earlyDelete: 'during-deploy' });
    expect(formatDestructiveChange(found!)).toContain(
      `will be replaced — the deploy deletes the old resource before the deploy succeeds, so ${CONSEQUENCE}`
    );
  });

  it('a create-first replacement (a create-only property) waits for the cleanup phase: no note', () => {
    const [found] = classify(
      update('T', 'AWS::DynamoDB::Table', {
        propertyChanges: [{ path: 'TableName', oldValue: 'a', newValue: 'b', requiresReplacement: true }],
      })
    );
    expect(found).toMatchObject({ impact: 'WILL_REPLACE' });
    expect(found).not.toHaveProperty('earlyDelete');
    expect(formatDestructiveChange(found!)).toBe('S: AWS::DynamoDB::Table T will be replaced');
  });

  // go-to-k/cdkd#6958: AWS refuses the new link while the old one holds it,
  // so these two types are replaced delete-first, as CloudFormation does.
  const replaced = (path: string): Partial<ResourceChange> => ({
    propertyChanges: [{ path, oldValue: 'a', newValue: 'b', requiresReplacement: true }],
  });

  it.each([
    ['AWS::EC2::VPCGatewayAttachment', 'VpcId'],
    ['AWS::EC2::SubnetRouteTableAssociation', 'RouteTableId'],
    ['AWS::EC2::SubnetRouteTableAssociation', 'SubnetId'],
  ])('a replaced %s (%s) is deleted before its replacement is created (#6958)', (type, path) => {
    const [found] = classify(update('Link', type, replaced(path)));
    expect(found).toMatchObject({ impact: 'WILL_REPLACE', earlyDelete: 'before-create' });
    expect(formatDestructiveChange(found!)).toBe(
      `S: ${type} Link will be replaced — the deploy deletes the old resource before ` +
        `creating its replacement, so ${CONSEQUENCE}`
    );
  });

  it('an attachment that MAY be replaced (its VPC is) carries the note too (#6958)', () => {
    const [found] = classify(
      update('Link', 'AWS::EC2::VPCGatewayAttachment', {
        propertyChanges: [
          {
            path: 'VpcId',
            oldValue: 'vpc-a',
            newValue: 'vpc-a',
            requiresReplacement: true,
            replacementPropagated: true,
          },
        ],
      })
    );
    expect(found).toMatchObject({ impact: 'MAY_REPLACE', earlyDelete: 'before-create' });
    // Another type's MAY_REPLACE stays without one.
    const [other] = classify(
      update('Acl', 'AWS::EC2::SubnetNetworkAclAssociation', {
        propertyChanges: [
          {
            path: 'SubnetId',
            oldValue: 's',
            newValue: 's',
            requiresReplacement: true,
            replacementPropagated: true,
          },
        ],
      })
    );
    expect(other).toMatchObject({ impact: 'MAY_REPLACE' });
    expect(other).not.toHaveProperty('earlyDelete');
  });

  it('a replaced gateway attachment under UpdateReplacePolicy: Retain keeps its old copy (#6958)', () => {
    const template: CloudFormationTemplate = {
      Resources: { Link: { Type: 'AWS::EC2::VPCGatewayAttachment', UpdateReplacePolicy: 'Retain' } },
    };
    const [found] = classify(update('Link', 'AWS::EC2::VPCGatewayAttachment', replaced('VpcId')), {
      template,
    });
    expect(found).toMatchObject({ impact: 'WILL_REPLACE' });
    expect(found).not.toHaveProperty('earlyDelete');
  });

  it('a subnet network ACL association stays create-first: no note (#6958)', () => {
    const [found] = classify(
      update('Acl', 'AWS::EC2::SubnetNetworkAclAssociation', replaced('NetworkAclId'))
    );
    expect(found).toMatchObject({ impact: 'WILL_REPLACE' });
    expect(found).not.toHaveProperty('earlyDelete');
  });

  it('a Type change onto a delete-first type is not noted (#6958)', () => {
    const [found] = classify(update('Link', 'AWS::EC2::VPCGatewayAttachment'), {
      recordType: 'AWS::EC2::SubnetRouteTableAssociation',
    });
    expect(found).toMatchObject({ impact: 'WILL_REPLACE' });
    expect(found).not.toHaveProperty('earlyDelete');
  });

  it('an IAM inline policy is never noted: its record restores it whole', () => {
    const [found] = classify(update('Pol', 'AWS::IAM::Policy'), { recreate: true });
    expect(found).toMatchObject({ impact: 'WILL_REPLACE' });
    expect(found).not.toHaveProperty('earlyDelete');
  });

  it('a provider-replacement mark on a Type change is the engine replacement, not the provider one', () => {
    const [found] = classify(
      update('Sub', 'AWS::SNS::Subscription', { providerReplacement: 'its FilterPolicyScope changed' }),
      { recordType: 'AWS::SQS::Queue' }
    );
    expect(found).toMatchObject({ impact: 'WILL_REPLACE', resourceType: 'AWS::SQS::Queue' });
    expect(found).not.toHaveProperty('earlyDelete');
  });

  it('the approval prompt lists the note on the replacement line', () => {
    const destructiveChanges = classify(update('Q', 'AWS::SQS::Queue'), { recreate: true });
    const text = renderApprovalRequest({
      stackName: 'S',
      level: 'destructive',
      counts: { create: 0, update: 1, delete: 0 },
      destructiveChanges,
    });
    expect(text).toContain(`  S: AWS::SQS::Queue Q will be replaced — the deploy deletes the old resource`);
  });
});

describe('cdkd diff renders the note (#6713)', () => {
  const node = (change: ResourceChange): DiffTreeNode =>
    ({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      changes: new Map([[change.logicalId, change]]),
      ccApiRoutes: new Map(),
      outputChanges: [],
      adoptedOrphans: [],
      blocking: [],
      unreadable: [],
      unreadableContainers: [],
      unreadableOrphans: [],
      destructiveChanges: classify(change),
      children: [],
    }) as unknown as DiffTreeNode;

  it('the Route 53 rename line carries the consequence', () => {
    const lines: string[] = [];
    renderDiffTree(
      node(update('Rec', 'AWS::Route53::RecordSet', { providerReplacement: 'its Name changed' })),
      true,
      (m) => lines.push(m)
    );
    expect(lines).toContain(
      `      [requires replacement: its Name changed; deleted, then created again] — ${CONSEQUENCE}`
    );
  });

  it('--json carries earlyDelete on the destructive change, additively', () => {
    const json = diffTreeToJson(
      node(update('Sub', 'AWS::SNS::Subscription', { providerReplacement: 'its FilterPolicyScope changed' }))
    );
    expect(json.destructiveChanges).toEqual([
      {
        logicalId: 'Sub',
        resourceType: 'AWS::SNS::Subscription',
        impact: 'WILL_REPLACE',
        earlyDelete: 'before-create',
      },
    ]);
  });

  it('--json omits earlyDelete for a create-first replacement', () => {
    const json = diffTreeToJson(
      node(
        update('T', 'AWS::DynamoDB::Table', {
          propertyChanges: [{ path: 'TableName', oldValue: 'a', newValue: 'b', requiresReplacement: true }],
        })
      )
    );
    expect(json.destructiveChanges).toEqual([
      { logicalId: 'T', resourceType: 'AWS::DynamoDB::Table', impact: 'WILL_REPLACE' },
    ]);
  });
});
