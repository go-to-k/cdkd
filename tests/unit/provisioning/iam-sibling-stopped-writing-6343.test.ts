import { describe, it, expect, vi } from 'vite-plus/test';
import { membersSiblingsStoppedWriting } from '../../../src/provisioning/iam-sibling-managed-policies.js';
import {
  pruneMembersSiblingsStoppedWriting,
  pruneStoppedSiblingMembersBestEffort,
} from '../../../src/deployment/deploy-engine/observed-capture.js';
import {
  isLeafCertifiedBag,
  isSameGenerationBag,
  markLeafCertifiedBag,
  markSameGenerationBag,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6343: a member a sibling STOPPED writing onto a resource's
 * declared IAM list leaves that resource's drift baseline at the deploy that
 * stopped it, even when the resource itself is NO_CHANGE.
 */

const ARN = 'arn:aws:iam::123456789012:policy/stack-Mp-OLD';
const NEW_ARN = 'arn:aws:iam::123456789012:policy/stack-Mp-NEW';
const AWS_MANAGED = 'arn:aws:iam::aws:policy/ReadOnlyAccess';

function rec(
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown>,
  observedProperties?: Record<string, unknown>
): ResourceState {
  return {
    resourceType,
    physicalId,
    properties,
    ...(observedProperties && { observedProperties }),
  } as ResourceState;
}

/** Runs the prune over `previous` -> `next` and returns `next`'s baselines. */
function prune(
  previous: Record<string, ResourceState>,
  next: Record<string, ResourceState>
): Record<string, Record<string, unknown> | undefined> {
  pruneMembersSiblingsStoppedWriting(previous, next);
  return Object.fromEntries(Object.entries(next).map(([k, r]) => [k, r.observedProperties]));
}

describe('a sibling AWS::IAM::ManagedPolicy that stopped attaching a principal', () => {
  const role = (declared: string[] = [AWS_MANAGED]): ResourceState =>
    rec('AWS::IAM::Role', 'role-a', { ManagedPolicyArns: declared }, {
      ManagedPolicyArns: [AWS_MANAGED, ARN],
    });

  it.each([
    ['Roles', 'AWS::IAM::Role'],
    ['Users', 'AWS::IAM::User'],
    ['Groups', 'AWS::IAM::Group'],
  ])('drops the ARN when the policy drops the principal from %s', (field, type) => {
    const principal = rec(type, 'p-a', { ManagedPolicyArns: [AWS_MANAGED] }, {
      ManagedPolicyArns: [AWS_MANAGED, ARN],
    });
    const out = prune(
      { P: principal, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { [field]: ['p-a'] }) },
      { P: principal, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { [field]: ['p-b'] }) }
    );
    expect(out['P']).toEqual({ ManagedPolicyArns: [AWS_MANAGED] });
  });

  it('drops the OLD ARN when the policy is replaced under a new one', () => {
    const r = role();
    const out = prune(
      { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) },
      { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', NEW_ARN, { Roles: ['role-a'] }) }
    );
    expect(out['Role']).toEqual({ ManagedPolicyArns: [AWS_MANAGED] });
  });

  it('drops the ARN when the policy is deleted', () => {
    const r = role();
    const out = prune(
      { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) },
      { Role: r }
    );
    expect(out['Role']).toEqual({ ManagedPolicyArns: [AWS_MANAGED] });
  });

  it('keeps the ARN while the policy still attaches the principal', () => {
    const r = role();
    const mp = rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] });
    expect(membersSiblingsStoppedWriting({ Role: r, Mp: mp }, { Role: r, Mp: mp }).size).toBe(0);
    expect(prune({ Role: r, Mp: mp }, { Role: r, Mp: mp })['Role']).toEqual({
      ManagedPolicyArns: [AWS_MANAGED, ARN],
    });
  });

  it("keeps the ARN the principal's own template declares", () => {
    const r = role([AWS_MANAGED, ARN]);
    const out = prune(
      { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) },
      { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: [] }) }
    );
    expect(out['Role']).toEqual({ ManagedPolicyArns: [AWS_MANAGED, ARN] });
  });

  // The withdrawn #6329 shape: a stack policy attached out of band and
  // `--accept`ed is in the baseline with NO sibling write behind it. No
  // record changed for it, so it stays, and a later detach is still drift.
  it('keeps an accepted ARN no sibling record ever attached', () => {
    const r = role();
    const mp = rec('AWS::IAM::ManagedPolicy', ARN, { Roles: [] });
    const mpNext = rec('AWS::IAM::ManagedPolicy', ARN, { Roles: [], Description: 'changed' });
    expect(prune({ Role: r, Mp: mp }, { Role: r, Mp: mpNext })['Role']).toEqual({
      ManagedPolicyArns: [AWS_MANAGED, ARN],
    });
  });

  it('drops nothing from a principal of another type the policy never named', () => {
    // `Users: ['role-a']` names a user, never the role spelled alike.
    const r = role();
    const out = prune(
      { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Users: ['role-a'] }) },
      { Role: r }
    );
    expect(out['Role']).toEqual({ ManagedPolicyArns: [AWS_MANAGED, ARN] });
  });
});

describe('a sibling AWS::IAM::UserToGroupAddition that stopped adding a user', () => {
  const user = (declared: string[] = ['Own']): ResourceState =>
    rec('AWS::IAM::User', 'alice', { Groups: declared }, { Groups: ['Own', 'GroupA'] });

  it('drops the group when the addition drops the user, folding case', () => {
    const u = user();
    const out = prune(
      {
        U: u,
        Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'groupa', Users: ['ALICE'] }),
      },
      { U: u, Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'groupa', Users: ['bob'] }) }
    );
    expect(out['U']).toEqual({ Groups: ['Own'] });
  });

  it('drops the group when the addition is deleted', () => {
    const u = user();
    const out = prune(
      { U: u, Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'GroupA', Users: ['alice'] }) },
      { U: u }
    );
    expect(out['U']).toEqual({ Groups: ['Own'] });
  });

  it('keeps the group while a re-cased addition still adds the user', () => {
    const u = user();
    const out = prune(
      { U: u, Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'GroupA', Users: ['alice'] }) },
      { U: u, Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'groupa', Users: ['Alice'] }) }
    );
    expect(out['U']).toEqual({ Groups: ['Own', 'GroupA'] });
  });

  it("keeps the group the user's own template declares", () => {
    const u = user(['Own', 'GROUPA']);
    const out = prune(
      { U: u, Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'GroupA', Users: ['alice'] }) },
      { U: u }
    );
    expect(out['U']).toEqual({ Groups: ['Own', 'GroupA'] });
  });
});

describe('a sibling principal that stopped attaching a managed policy', () => {
  const policy = (declared: string[] = []): ResourceState =>
    rec('AWS::IAM::ManagedPolicy', ARN, { Roles: declared }, { Roles: ['role-a'], Users: [] });

  it("drops the role when its ManagedPolicyArns drops the policy", () => {
    const mp = policy();
    const out = prune(
      { Mp: mp, Role: rec('AWS::IAM::Role', 'role-a', { ManagedPolicyArns: [ARN] }) },
      { Mp: mp, Role: rec('AWS::IAM::Role', 'role-a', { ManagedPolicyArns: [] }) }
    );
    expect(out['Mp']).toEqual({ Roles: [], Users: [] });
  });

  it('drops the OLD role name when the role is replaced under a new one', () => {
    const mp = policy();
    const out = prune(
      { Mp: mp, Role: rec('AWS::IAM::Role', 'role-a', { ManagedPolicyArns: [ARN] }) },
      { Mp: mp, Role: rec('AWS::IAM::Role', 'role-b', { ManagedPolicyArns: [ARN] }) }
    );
    expect(out['Mp']).toEqual({ Roles: [], Users: [] });
  });

  it('drops the role name when the role is deleted', () => {
    const mp = policy();
    const out = prune(
      { Mp: mp, Role: rec('AWS::IAM::Role', 'role-a', { ManagedPolicyArns: [ARN] }) },
      { Mp: mp }
    );
    expect(out['Mp']).toEqual({ Roles: [], Users: [] });
  });

  it("drops the group name when the group's ManagedPolicyArns drops the policy", () => {
    const mp = rec('AWS::IAM::ManagedPolicy', ARN, {}, { Groups: ['grp-a', 'grp-b'] });
    const out = prune(
      { Mp: mp, G: rec('AWS::IAM::Group', 'grp-a', { ManagedPolicyArns: [ARN] }) },
      { Mp: mp, G: rec('AWS::IAM::Group', 'grp-a', { ManagedPolicyArns: [AWS_MANAGED] }) }
    );
    expect(out['Mp']).toEqual({ Groups: ['grp-b'] });
  });

  it("keeps the role the policy's own template declares", () => {
    const mp = policy(['role-a']);
    const out = prune(
      { Mp: mp, Role: rec('AWS::IAM::Role', 'role-a', { ManagedPolicyArns: [ARN] }) },
      { Mp: mp }
    );
    expect(out['Mp']).toEqual({ Roles: ['role-a'], Users: [] });
  });
});

// Review B1 / m1: a sibling whose AWS resource survives the deploy still
// writes what its record listed, so nothing it wrote is dropped.
describe('a sibling whose previous resource may survive the deploy', () => {
  const role = (): ResourceState =>
    rec('AWS::IAM::Role', 'role-a', { ManagedPolicyArns: [AWS_MANAGED] }, {
      ManagedPolicyArns: [AWS_MANAGED, ARN],
    });
  const mp = (extra: Partial<ResourceState> = {}): ResourceState =>
    ({ ...rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }), ...extra }) as ResourceState;

  it.each(['Retain', 'RetainExceptOnCreate'] as const)(
    'keeps the ARN of a policy removed under DeletionPolicy %s',
    (deletionPolicy) => {
      const r = role();
      expect(prune({ Role: r, Mp: mp({ deletionPolicy }) }, { Role: r })['Role']).toEqual({
        ManagedPolicyArns: [AWS_MANAGED, ARN],
      });
    }
  );

  it('keeps the group of a UserToGroupAddition removed under DeletionPolicy Retain', () => {
    const u = rec('AWS::IAM::User', 'alice', {}, { Groups: ['GroupA'] });
    const add = {
      ...rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'GroupA', Users: ['alice'] }),
      deletionPolicy: 'Retain',
    } as ResourceState;
    expect(prune({ U: u, Add: add }, { U: u })['U']).toEqual({ Groups: ['GroupA'] });
  });

  it('keeps the OLD ARN of a policy replaced under UpdateReplacePolicy Retain', () => {
    const r = role();
    const out = prune(
      { Role: r, Mp: mp({ updateReplacePolicy: 'Retain' }) },
      { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', NEW_ARN, { Roles: ['role-a'] }) }
    );
    expect(out['Role']).toEqual({ ManagedPolicyArns: [AWS_MANAGED, ARN] });
  });

  it.each([
    ['kept', { retainedOldOnReplacement: new Set(['Mp']), replacedOldMaySurvive: new Map() }],
    [
      'not confirmed gone',
      { retainedOldOnReplacement: new Set<string>(), replacedOldMaySurvive: new Map([['Mp', 'unconfirmed']]) },
    ],
  ])('keeps the OLD ARN when the replaced policy was %s', (_label, run) => {
    const r = role();
    const next: Record<string, ResourceState> = {
      Role: r,
      Mp: rec('AWS::IAM::ManagedPolicy', NEW_ARN, { Roles: ['role-a'] }),
    };
    expect(pruneMembersSiblingsStoppedWriting({ Role: r, Mp: mp() }, next, run)).toBe(0);
    // ...and the same run for ANOTHER id leaves this replacement's drop alone.
    const other = { retainedOldOnReplacement: new Set(['Other']), replacedOldMaySurvive: new Map() };
    expect(pruneMembersSiblingsStoppedWriting({ Role: r, Mp: mp() }, next, other)).toBe(1);
    expect(next['Role']!.observedProperties).toEqual({ ManagedPolicyArns: [AWS_MANAGED] });
  });

  // A record written before state schema v5 has no policy of its own, so the
  // template's is the fallback, as in `delete.ts`. The caller passes the
  // Condition-filtered template, where only a defined resource has one.
  it.each([
    ['DeletionPolicy', { DeletionPolicy: 'Retain' }, undefined],
    ['UpdateReplacePolicy', { UpdateReplacePolicy: 'Retain' }, NEW_ARN],
  ] as const)(
    "falls back to the template's %s for a record lacking one",
    (_label, policy, replacedArn) => {
      const r = role();
      const template = {
        Resources: { Mp: { Type: 'AWS::IAM::ManagedPolicy', ...policy } },
      } as unknown as CloudFormationTemplate;
      const next: Record<string, ResourceState> = {
        Role: r,
        ...(replacedArn && { Mp: rec('AWS::IAM::ManagedPolicy', replacedArn, { Roles: ['role-a'] }) }),
      };
      expect(pruneMembersSiblingsStoppedWriting({ Role: r, Mp: mp() }, next, undefined, template)).toBe(0);
      // ...and the same arm without the template's policy still drops it.
      expect(pruneMembersSiblingsStoppedWriting({ Role: r, Mp: mp() }, next)).toBe(1);
    }
  );

  it('still drops the ARN of a policy DELETED under DeletionPolicy Delete', () => {
    const r = role();
    expect(prune({ Role: r, Mp: mp({ deletionPolicy: 'Delete' }) }, { Role: r })['Role']).toEqual({
      ManagedPolicyArns: [AWS_MANAGED],
    });
  });
});

// Review C-N3: `previous` holds the PERSISTED form, `next` the in-memory one,
// so a member or target stored as an expression or mask is never compared.
describe('a sibling write spelled as a stored expression or mask', () => {
  it.each([
    ['a resolve expression', '{{resolve:ssm:/grp}}'],
    ['the mask', '***'],
  ])('does not count a GroupName stored as %s as a stopped member', (_label, stored) => {
    // The baseline holds the same stored spelling (the persisted, redacted
    // form) for a membership the addition STILL writes.
    const u = rec('AWS::IAM::User', 'alice', {}, { Groups: [stored] });
    const out = prune(
      { U: u, Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: stored, Users: ['alice'] }) },
      { U: u, Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', { GroupName: 'GroupA', Users: ['alice'] }) }
    );
    expect(out['U']).toEqual({ Groups: [stored] });
  });

  it('does not count a target user stored as an expression', () => {
    const u = rec('AWS::IAM::User', '{{resolve:ssm:/user}}', {}, { Groups: ['GroupA'] });
    const out = prune(
      {
        U: u,
        Add: rec('AWS::IAM::UserToGroupAddition', 'add-1', {
          GroupName: 'GroupA',
          Users: ['{{resolve:ssm:/user}}'],
        }),
      },
      { U: u }
    );
    expect(out['U']).toEqual({ Groups: ['GroupA'] });
  });
});

describe('pruneMembersSiblingsStoppedWriting record handling', () => {
  it('replaces the record, leaves the loaded one untouched, and counts it', () => {
    const observed = { ManagedPolicyArns: [AWS_MANAGED, ARN] };
    const r = rec('AWS::IAM::Role', 'role-a', {}, observed);
    const previous = { Role: r, Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) };
    const next: Record<string, ResourceState> = { Role: r };
    expect(pruneMembersSiblingsStoppedWriting(previous, next)).toBe(1);
    expect(next['Role']).not.toBe(r);
    expect(r.observedProperties).toBe(observed);
    expect(observed.ManagedPolicyArns).toEqual([AWS_MANAGED, ARN]);
    expect(next['Role']!.observedProperties).toEqual({ ManagedPolicyArns: [AWS_MANAGED] });
  });

  it.each([true, false])('carries the same-generation mark over (marked: %s)', (marked) => {
    const observed = { ManagedPolicyArns: [ARN] };
    if (marked) markSameGenerationBag(observed);
    const next: Record<string, ResourceState> = {
      Role: rec('AWS::IAM::Role', 'role-a', {}, observed),
    };
    pruneMembersSiblingsStoppedWriting(
      { Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) },
      next
    );
    expect(next['Role']!.observedProperties).toEqual({ ManagedPolicyArns: [] });
    expect(isSameGenerationBag(next['Role']!.observedProperties)).toBe(marked);
  });

  it('carries the leaf-certified mark over too', () => {
    const observed = markLeafCertifiedBag({ ManagedPolicyArns: [ARN] });
    const next: Record<string, ResourceState> = {
      Role: rec('AWS::IAM::Role', 'role-a', {}, observed),
    };
    pruneMembersSiblingsStoppedWriting(
      { Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) },
      next
    );
    expect(isLeafCertifiedBag(next['Role']!.observedProperties)).toBe(true);
    expect(isSameGenerationBag(next['Role']!.observedProperties)).toBe(false);
  });

  // Review S-N2: at a failure save the prune never stands in the save's way.
  it('the best-effort form swallows a failure and logs its class only', () => {
    const debug = vi.fn();
    const next = new Proxy({} as Record<string, ResourceState>, {
      ownKeys: () => {
        throw new TypeError('secret-ish detail');
      },
    });
    expect(() =>
      pruneStoppedSiblingMembersBestEffort(
        { debug },
        { Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) },
        next
      )
    ).not.toThrow();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]![0])).toContain('TypeError');
    expect(String(debug.mock.calls[0]![0])).not.toContain('secret-ish detail');
  });

  it('skips a record with no baseline and returns 0', () => {
    const next: Record<string, ResourceState> = { Role: rec('AWS::IAM::Role', 'role-a', {}) };
    expect(
      pruneMembersSiblingsStoppedWriting(
        { Mp: rec('AWS::IAM::ManagedPolicy', ARN, { Roles: ['role-a'] }) },
        next
      )
    ).toBe(0);
    expect(next['Role']!.observedProperties).toBeUndefined();
  });
});
