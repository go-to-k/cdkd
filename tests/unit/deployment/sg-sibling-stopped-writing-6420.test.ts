import { describe, it, expect } from 'vite-plus/test';
import { pruneMembersSiblingsStoppedWriting } from '../../../src/deployment/deploy-engine/observed-capture.js';
import { sgRulesSiblingsStoppedWriting } from '../../../src/provisioning/sg-sibling-rules.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6420: a security-group baseline captured before #6418 can hold
 * the rule a standalone `SecurityGroupIngress` / `SecurityGroupEgress` wrote.
 * When a deploy removes or replaces that rule resource, its delete revokes the
 * rule; the same deploy drops it from the group's baseline, or `cdkd drift`
 * reports it lost and `--revert` re-authorizes access the template removed.
 */

const GROUP = 'sg-0aaaaaaaaaaaaaaaa';
const PEER = 'sg-0bbbbbbbbbbbbbbbb';

const inline = { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/16' };
const sibling = (port: number) => ({
  IpProtocol: 'tcp',
  FromPort: port,
  ToPort: port,
  SourceSecurityGroupId: PEER,
});
const live = (port: number) => ({
  ...sibling(port),
  SourceSecurityGroupOwnerId: '123456789012',
  Description: 'from B',
});

function group(
  baselineIngress: unknown[],
  declaredIngress: unknown[] = [inline],
  baselineEgress: unknown[] = []
): ResourceState {
  return {
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: GROUP,
    properties: { GroupDescription: 'A', SecurityGroupIngress: declaredIngress },
    observedProperties: {
      GroupDescription: 'A',
      SecurityGroupIngress: baselineIngress,
      SecurityGroupEgress: baselineEgress,
    },
  } as ResourceState;
}

function rule(
  props: Record<string, unknown>,
  extra: Partial<ResourceState> = {},
  type = 'AWS::EC2::SecurityGroupIngress'
): ResourceState {
  return {
    resourceType: type,
    physicalId: `sgr-${String(props['FromPort'])}`,
    properties: { GroupId: GROUP, ...props },
    ...extra,
  } as ResourceState;
}

/** Runs the prune over `previous` -> `next`; returns the group's baseline ingress ports. */
function pruned(
  previous: Record<string, ResourceState>,
  next: Record<string, ResourceState>
): { changed: number; ingress: unknown; egress: unknown } {
  const out = { ...next };
  const changed = pruneMembersSiblingsStoppedWriting(previous, out);
  const observed = out['SgA']!.observedProperties!;
  const ports = (list: unknown) => (list as Array<{ FromPort: number }>).map((r) => r.FromPort);
  return {
    changed,
    ingress: ports(observed['SecurityGroupIngress']),
    egress: ports(observed['SecurityGroupEgress']),
  };
}

describe('pruneMembersSiblingsStoppedWriting: security-group rules (go-to-k/cdkd#6420)', () => {
  it('a REMOVED standalone rule leaves the group baseline, the group itself unchanged', () => {
    const g = group([inline, live(5432)]);
    const result = pruned({ SgA: g, FromB: rule(sibling(5432)) }, { SgA: g });
    expect(result).toMatchObject({ changed: 1, ingress: [443] });
  });

  it('a REPLACED rule (new port) drops only the old rule; the new one is not in the baseline to begin with', () => {
    const g = group([inline, live(5432)]);
    const result = pruned(
      { SgA: g, FromB: rule(sibling(5432)) },
      { SgA: g, FromB: rule(sibling(5433), { physicalId: 'sgr-new' }) }
    );
    expect(result).toMatchObject({ changed: 1, ingress: [443] });
  });

  it('a removed SecurityGroupEgress leaves the egress baseline', () => {
    const egress = { IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, DestinationSecurityGroupId: PEER };
    const g = group([inline], [inline], [{ ...egress, Description: 'to B' }]);
    const result = pruned(
      { SgA: g, ToB: rule(egress, {}, 'AWS::EC2::SecurityGroupEgress') },
      { SgA: g }
    );
    expect(result).toMatchObject({ changed: 1, egress: [] });
  });

  it.each<[string, (g: ResourceState) => Record<string, ResourceState>, Partial<ResourceState>]>([
    ['the rule still written', (g) => ({ SgA: g, FromB: rule(sibling(5432)) }), {}],
    [
      'ANOTHER record still writes the same rule (the #4492 shared rule)',
      (g) => ({ SgA: g, FromB2: rule(sibling(5432), { physicalId: 'sgr-other' }) }),
      {},
    ],
    [
      'the rule resource retained by its DeletionPolicy (it still holds the rule)',
      (g) => ({ SgA: g }),
      { deletionPolicy: 'Retain' },
    ],
  ])('keeps the baseline rule when %s', (_label, nextOf, extra) => {
    const g = group([inline, live(5432)]);
    const result = pruned({ SgA: g, FromB: rule(sibling(5432), extra) }, nextOf(g));
    expect(result).toMatchObject({ changed: 0, ingress: [443, 5432] });
  });

  it("keeps a rule the group's own template also declares inline", () => {
    const g = group([inline, live(5432)], [inline, sibling(5432)]);
    const result = pruned({ SgA: g, FromB: rule(sibling(5432)) }, { SgA: g });
    expect(result).toMatchObject({ changed: 0, ingress: [443, 5432] });
  });

  it('a removed rule on ANOTHER group leaves this baseline alone', () => {
    const g = group([inline, live(5432)]);
    const result = pruned(
      { SgA: g, FromB: rule({ ...sibling(5432), GroupId: 'sg-0cccccccccccccccc' }) },
      { SgA: g }
    );
    expect(result).toMatchObject({ changed: 0, ingress: [443, 5432] });
  });

  it('a removed rule recorded with a redacted identity stops nothing (fails closed)', () => {
    const stopped = sgRulesSiblingsStoppedWriting(
      { SgA: group([]), FromB: rule({ ...sibling(5432), SourceSecurityGroupId: '***' }) },
      { SgA: group([]) }
    );
    expect(stopped.size).toBe(0);
  });

  it('a rule record of the next state cdkd cannot identify (GroupName-addressed) blocks its direction', () => {
    const g = group([inline, live(5432)]);
    const named = {
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      physicalId: 'sgr-named',
      properties: { GroupName: 'A', ...sibling(5432) },
    } as ResourceState;
    const result = pruned({ SgA: g, FromB: rule(sibling(5432)) }, { SgA: g, FromB: named });
    expect(result).toMatchObject({ changed: 0, ingress: [443, 5432] });
  });

  it('a replaced rule whose old resource may survive stops nothing', () => {
    const g = group([inline, live(5432)]);
    const out = { SgA: g, FromB: rule(sibling(5433), { physicalId: 'sgr-new' }) };
    const changed = pruneMembersSiblingsStoppedWriting({ SgA: g, FromB: rule(sibling(5432)) }, out, {
      retainedOldOnReplacement: new Set(),
      replacedOldMaySurvive: new Map([['FromB', true]]),
    });
    expect(changed).toBe(0);
  });
});
