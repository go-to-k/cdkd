import { describe, it, expect, vi } from 'vite-plus/test';
import { buildObservedCaptureSiblings } from '../../../src/deployment/deploy-engine/observed-capture.js';
import { siblingOwnedSgRuleIdentities } from '../../../src/provisioning/sg-sibling-rules.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6418: the deploy-time capture of an `AWS::EC2::SecurityGroup`
 * hands the provider's readback the stack's standalone rule siblings, so a
 * baseline captured while (or just after) a sibling authorizes its rule does
 * not record it. Measured live before this: an UPDATE of the group recorded
 * the sibling's 5432 rule in `observedProperties.SecurityGroupIngress`.
 */

const GROUP = 'sg-0aaaaaaaaaaaaaaaa';
const PEER = 'sg-0bbbbbbbbbbbbbbbb';

const ruleProps = (groupId: unknown, peer: unknown, port = 5432) => ({
  GroupId: groupId,
  IpProtocol: 'tcp',
  FromPort: port,
  ToPort: port,
  SourceSecurityGroupId: peer,
});

/** Resolves `Fn::GetAtt [<lid>, GroupId]` from a fixed map; throws on an unknown id. */
function depsWith(groupIds: Record<string, string>, captureObservedState = true) {
  const resolveValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolveValue);
    if (typeof v !== 'object' || v === null) return v;
    const getAtt = (v as Record<string, unknown>)['Fn::GetAtt'];
    if (Array.isArray(getAtt)) {
      const id = groupIds[getAtt[0] as string];
      if (id === undefined) throw new Error(`unresolved ${String(getAtt[0])}`);
      return id;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveValue(x)]));
  };
  return {
    options: { captureObservedState },
    buildResolverContext: vi.fn(() => ({}) as never),
    resolver: { resolve: vi.fn(async (v: unknown) => resolveValue(v)) },
  };
}

const templateWith = (resources: CloudFormationTemplate['Resources']): CloudFormationTemplate =>
  ({ Resources: { SgA: { Type: 'AWS::EC2::SecurityGroup', Properties: {} }, ...resources } }) as never;

const capture = (
  deps: ReturnType<typeof depsWith>,
  template: CloudFormationTemplate,
  state: Record<string, ResourceState> = {},
  conditions?: Record<string, boolean>
) =>
  buildObservedCaptureSiblings(
    deps as never,
    'AWS::EC2::SecurityGroup',
    'SgA',
    GROUP,
    template,
    state,
    'TestStack',
    undefined,
    conditions
  );

const owned = (ctx: Awaited<ReturnType<typeof capture>>) =>
  siblingOwnedSgRuleIdentities(GROUP, 'ingress', {}, ctx).size;

describe('buildObservedCaptureSiblings for an AWS::EC2::SecurityGroup (go-to-k/cdkd#6418)', () => {
  it('hands over a RECORDED sibling rule naming the group (an UPDATE capture)', async () => {
    const state: Record<string, ResourceState> = {
      FromB: {
        physicalId: 'sgr-1',
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        properties: ruleProps(GROUP, PEER),
      },
    };
    const ctx = await capture(depsWith({}), templateWith({}), state);
    expect(owned(ctx)).toBe(1);
  });

  it('hands over a TEMPLATE sibling created in this deploy, resolved, with GroupId set to the group', async () => {
    const template = templateWith({
      FromB: {
        Type: 'AWS::EC2::SecurityGroupIngress',
        Properties: ruleProps({ 'Fn::GetAtt': ['SgA', 'GroupId'] }, { 'Fn::GetAtt': ['SgB', 'GroupId'] }),
      },
    });
    const ctx = await capture(depsWith({ SgA: GROUP, SgB: PEER }), template);
    expect(ctx?.siblings?.['FromB']?.properties).toMatchObject({ GroupId: GROUP, SourceSecurityGroupId: PEER });
    expect(owned(ctx)).toBe(1);
  });

  it('keeps a recorded rule beside its changed template twin: until its operation runs, the recorded rule is live', async () => {
    const state: Record<string, ResourceState> = {
      FromB: {
        physicalId: 'sgr-1',
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        properties: ruleProps(GROUP, PEER, 5432),
      },
    };
    const template = templateWith({
      FromB: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: ruleProps({ Ref: 'SgA' }, PEER, 5433) },
    });
    const ctx = await capture(depsWith({}), template, state);
    expect(owned(ctx)).toBe(2);
  });

  it.each([
    [
      'a template rule whose peer is not created yet (unresolvable)',
      { FromB: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: ruleProps({ Ref: 'SgA' }, { 'Fn::GetAtt': ['SgB', 'GroupId'] }) } },
      undefined,
    ],
    [
      'a template rule naming another group',
      { FromB: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: ruleProps({ Ref: 'SgOther' }, PEER) } },
      undefined,
    ],
    [
      'a template rule whose Condition is false',
      { FromB: { Type: 'AWS::EC2::SecurityGroupIngress', Condition: 'Off', Properties: ruleProps({ Ref: 'SgA' }, PEER) } },
      { Off: false },
    ],
  ])('hands over nothing for %s', async (_label, resources, conditions) => {
    const ctx = await capture(depsWith({}), templateWith(resources as never), {}, conditions);
    expect(ctx).toBeUndefined();
  });

  it('builds nothing when the capture is off', async () => {
    const state: Record<string, ResourceState> = {
      FromB: { physicalId: 'sgr-1', resourceType: 'AWS::EC2::SecurityGroupIngress', properties: ruleProps(GROUP, PEER) },
    };
    expect(await capture(depsWith({}, false), templateWith({}), state)).toBeUndefined();
  });
});
