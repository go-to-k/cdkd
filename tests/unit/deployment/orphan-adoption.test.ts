/**
 * The deploy-side half of issue #2934: deciding, before the diff runs, whether
 * to re-adopt a resource a previous rollback left in AWS.
 *
 * Most of these cases are REFUSALS and KEEPS. The adopt path is one branch; the
 * value of the pre-pass is in what it declines to do, and each decline has a
 * different consequence if it inverts — a wrong adopt puts another stack's
 * resource under this stack's `cdkd destroy`, a wrong drop loses the only trace
 * of a live billing resource, and a wrong keep leaves the deploy loop unfixed.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  planOrphanAdoption,
  templateStillDeclares,
} from '../../../src/deployment/orphan-adoption.js';
import { explicitNamePropertyFor } from '../../../src/provisioning/resource-name.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState, StackOrphanRecord } from '../../../src/types/state.js';

function record(overrides: Partial<StackOrphanRecord> = {}): StackOrphanRecord {
  const state: ResourceState = {
    physicalId: 'cdkd-sandbox-KeptRole',
    resourceType: 'AWS::IAM::Role',
    properties: { Path: '/svc/' },
    attributes: { Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole' },
    deletionPolicy: 'Retain',
    ...(overrides.state ?? {}),
  };
  return { logicalId: 'KeptRole', orphanedAt: 1, ...overrides, state };
}

const declaringTemplate: CloudFormationTemplate = {
  Resources: { KeptRole: { Type: 'AWS::IAM::Role', Properties: { Path: '/svc/' } } },
} as CloudFormationTemplate;

function run(params: {
  records?: StackOrphanRecord[];
  managed?: string[];
  template?: CloudFormationTemplate;
  importImpl?: ResourceProvider['import'];
  claims?: string[];
}) {
  const importFn =
    params.importImpl ??
    (vi.fn(async () => ({ physicalId: 'cdkd-sandbox-KeptRole' })) as ResourceProvider['import']);
  const readSiblingClaims = vi.fn(async () => new Set(params.claims ?? []));
  return {
    readSiblingClaims,
    importFn,
    promise: planOrphanAdoption({
      records: params.records ?? [record()],
      managedLogicalIds: new Set(params.managed ?? []),
      template: params.template ?? declaringTemplate,
      stackName: 'MyStack',
      region: 'us-east-1',
      getProvider: () => ({ import: importFn }) as unknown as ResourceProvider,
      // The REAL lookup, never a stub: this function decides BOTH the
      // explicit-name guard and the allow-list gate, and an earlier version
      // stubbed it — which made the gate unobservable and left a `nameProperty`
      // override option with zero call sites.
      nameProperties: (t) => {
        const real = explicitNamePropertyFor(t);
        return real === undefined ? [] : [real];
      },
      readSiblingClaims,
      logger: { debug: vi.fn() },
    }),
  };
}

describe('planOrphanAdoption (#2934)', () => {
  it('adopts the RECORDED state, with attributes merged rather than replaced', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => ({
        physicalId: 'cdkd-sandbox-KeptRole',
        // A narrower readback than `create()` reported: `Arn` is absent here.
        attributes: { RoleId: 'AROAEXAMPLE' },
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    expect(Object.keys(plan.adopted)).toEqual(['KeptRole']);
    // The recorded properties survive — this is what makes the following diff
    // compare failed-template against fixed-template instead of readback
    // against template (which would read generated name keys as create-only
    // removals and REPLACE the resource).
    expect(plan.adopted['KeptRole']?.properties).toEqual({ Path: '/svc/' });
    // MERGED: losing `Arn` here would break a dependent's Fn::GetAtt.
    expect(plan.adopted['KeptRole']?.attributes).toEqual({
      Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole',
      RoleId: 'AROAEXAMPLE',
    });
    expect(plan.remaining).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it('drops the record when the resource is gone from AWS', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => null) as ResourceProvider['import'],
    });
    const plan = await promise;

    // Dropped, NOT kept: the user deleted it by hand, the name is free, and the
    // ordinary CREATE will succeed. Keeping it would pay an AWS read on every
    // future deploy forever.
    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toEqual([]);
    expect(plan.notices).toEqual([]);
  });

  it('KEEPS the record when the existence check THROWS', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => {
        throw new Error('Rate exceeded');
      }) as ResourceProvider['import'],
    });
    const plan = await promise;

    // The discriminator against the case above: a throttle is not absence.
    // Dropping here would lose the only trace of a live, billing resource.
    expect(plan.remaining).toHaveLength(1);
    expect(plan.adopted).toEqual({});
  });

  it('checks existence even when the template no longer declares the resource', async () => {
    const importFn = vi.fn(async () => null) as ResourceProvider['import'];
    const { promise } = run({
      template: { Resources: {} } as CloudFormationTemplate,
      importImpl: importFn,
    });
    const plan = await promise;

    // The ordering fix: with the template check first, a record whose logical
    // id had left the template was never verified and so never dropped —
    // present, blocking nothing, surfacing nowhere, unclearable.
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(plan.remaining).toEqual([]);
  });

  it('keeps and ANNOUNCES a record the template no longer declares', async () => {
    const { promise } = run({ template: { Resources: {} } as CloudFormationTemplate });
    const plan = await promise;

    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toHaveLength(1);
    // Without this line the record would be invisible, which is the defect the
    // scope cut (no list subcommand) would otherwise have introduced.
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('cdkd-sandbox-KeptRole');
    expect(plan.refusals).toEqual([]);
  });

  it('refuses when another stack already records the same physical id', async () => {
    const { promise } = run({ claims: ['cdkd-sandbox-KeptRole'] });
    const plan = await promise;

    // Adopting would put one physical id in two state files, and either
    // stack's destroy would delete the other's live resource.
    expect(plan.adopted).toEqual({});
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain('another cdkd stack');
    // Kept, not dropped: the resource is still there and still ours to track.
    expect(plan.remaining).toHaveLength(1);
  });

  it('keeps and announces when the provider implements no import()', async () => {
    const plan = await planOrphanAdoption({
      records: [record()],
      managedLogicalIds: new Set<string>(),
      template: declaringTemplate,
      stackName: 'MyStack',
      region: 'us-east-1',
      getProvider: () => ({}) as unknown as ResourceProvider,
      nameProperties: () => ['RoleName'],
      readSiblingClaims: async () => new Set<string>(),
      logger: { debug: vi.fn() },
    });

    // Neither adopt (attributes would be stale, breaking dependents' GetAtt)
    // nor refuse (the stack's deploys would brick with no way to clear it).
    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toHaveLength(1);
    expect(plan.notices).toHaveLength(1);
    expect(plan.refusals).toEqual([]);
  });

  it('adds no AWS calls and reads no siblings when there are no records', async () => {
    const { promise, readSiblingClaims, importFn } = run({ records: [] });
    const plan = await promise;

    // The property the whole design rests on: the normal deploy path is an
    // empty-array check.
    expect(importFn).not.toHaveBeenCalled();
    expect(readSiblingClaims).not.toHaveBeenCalled();
    expect(plan).toEqual({ adopted: {}, remaining: [], refusals: [], notices: [] });
  });

  it('drops a record whose logical id state already MANAGES, before any AWS call', async () => {
    const { promise, importFn } = run({ managed: ['KeptRole'] });
    const plan = await promise;

    // Reachable through cdkd's own advice: go-to-k/cdkd#2916 tells the user to
    // run `cdkd import`, and import carries the record forward — so the logical
    // id ends up in BOTH bags. Without this the next deploy would splice the
    // older orphan state over the record the import just created.
    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toEqual([]);
    // Before any AWS call: the resource is already managed, so there is nothing
    // to verify and nothing to pay for.
    expect(importFn).not.toHaveBeenCalled();
  });

  it('keeps and announces when the provider lookup THROWS', async () => {
    const plan = await planOrphanAdoption({
      records: [record()],
      managedLogicalIds: new Set<string>(),
      template: declaringTemplate,
      stackName: 'MyStack',
      region: 'us-east-1',
      getProvider: () => {
        throw new Error('Unsupported resource type');
      },
      nameProperties: () => ['RoleName'],
      readSiblingClaims: async () => new Set<string>(),
      logger: { debug: vi.fn() },
    });

    // A type this build cannot route must not fail the whole deploy with a
    // message about a resource the user did not ask to touch — and must not
    // leave the record unclearable either.
    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toHaveLength(1);
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('cannot route');
    expect(plan.refusals).toEqual([]);
  });

  it('ANNOUNCES a failed existence check rather than only logging it', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => {
        throw new Error('Rate exceeded');
      }) as ResourceProvider['import'],
    });
    const plan = await promise;

    // The deploy now walks into the collision this record exists to prevent.
    // A debug-only line means the user sees the go-to-k/cdkd#2916 diagnosis and
    // no hint that cdkd HELD the evidence and could not confirm it.
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('could not confirm');
  });

  it('leaves recorded attributes untouched when the readback reports none', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => ({
        physicalId: 'cdkd-sandbox-KeptRole',
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // The absent-attributes arm of the merge. Overwriting with `{}` here would
    // strip the `Arn` a dependent's Fn::GetAtt resolves.
    expect(plan.adopted['KeptRole']?.attributes).toEqual({
      Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole',
    });
  });

  it('reads sibling claims ONCE across several records', async () => {
    const { promise, readSiblingClaims } = run({
      records: [record(), record({ logicalId: 'Second' })],
      template: {
        Resources: {
          KeptRole: { Type: 'AWS::IAM::Role', Properties: {} },
          Second: { Type: 'AWS::IAM::Role', Properties: {} },
        },
      } as unknown as CloudFormationTemplate,
    });
    await promise;

    // The memoization is unobservable with a single record, so removing it
    // survives every other case here. Two records make the cost real: the scan
    // reads every sibling state file in the account.
    expect(readSiblingClaims).toHaveBeenCalledTimes(1);
  });

  it('drops a MASKED readback attribute instead of letting it overwrite a recorded one', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => ({
        physicalId: 'cdkd-sandbox-KeptRole',
        // `CloudControlProvider.import` returns its model through
        // `maskUncertifiedModelValues`, which replaces every leaf it cannot
        // certify with `SECRET_MASK` — the WHOLE model when `DescribeType` is
        // unavailable. Letting that win writes `'***'` where a real `Arn` was,
        // and that is what dependents resolve `Fn::GetAtt` against.
        attributes: { Arn: '***', RoleId: '***', Extra: 'real' },
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    expect(plan.adopted['KeptRole']?.attributes).toEqual({
      Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole',
      Extra: 'real',
    });
    // Dropped, not merely out-ranked: a masked key the record does NOT carry
    // must not arrive either.
    expect(plan.adopted['KeptRole']?.attributes).not.toHaveProperty('RoleId');
  });

  it('drops a key whose mask is NESTED, not only a top-level one', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => ({
        physicalId: 'cdkd-sandbox-KeptRole',
        // `maskUncertifiedModelValues` masks LEAVES (`maskLeavesDeep` walks
        // arrays and objects and PRESERVES the containers), so a masked
        // container comes back structurally intact with `'***'` at the bottom.
        // The first cut compared `value === SECRET_MASK` at the top level and
        // let these through while its comment claimed the opposite.
        //
        // The masking is per-top-level-key ALL-OR-NOTHING, so a PARTIALLY
        // masked container is unproducible and is not modelled here — an
        // earlier version of this case used `{ Address: '***', Port: 443 }` and
        // called it "the shape a real readback returns", which was false.
        attributes: {
          Tags: [{ Key: '***', Value: '***' }],
          Endpoint: { Address: '***', Port: '***' },
          Clean: { Nested: 'real' },
        },
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    const attrs = plan.adopted['KeptRole']?.attributes;
    expect(attrs).not.toHaveProperty('Tags');
    expect(attrs).not.toHaveProperty('Endpoint');
    // A container with no mask anywhere still arrives — the filter is about
    // masks, not about containers.
    expect(attrs?.['Clean']).toEqual({ Nested: 'real' });
  });

  it('an EMPTY readback container is not a mask, and is not treated as one', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => ({
        physicalId: 'cdkd-sandbox-KeptRole',
        attributes: { Empty: {}, EmptyList: [] },
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // `carriesSecretMask({})` is false, so an empty container passes the
    // filter. Recorded here rather than left implicit: the filter's comment
    // reasons about "a container that LOOKS complete and is missing members",
    // and this is that shape arriving legitimately — an attribute AWS really
    // reports as empty. The record's own value still wins for any key it
    // carries, so this can only ADD.
    expect(plan.adopted['KeptRole']?.attributes?.['Empty']).toEqual({});
    expect(plan.adopted['KeptRole']?.attributes?.['EmptyList']).toEqual([]);
  });

  it('a MASKED recorded attribute is KEPT — a readback never heals a redaction', async () => {
    const { promise } = run({
      records: [
        record({
          state: {
            physicalId: 'cdkd-sandbox-KeptRole',
            resourceType: 'AWS::IAM::Role',
            properties: { Path: '/svc/' },
            attributes: { Arn: '***' },
            deletionPolicy: 'Retain',
            provisionedBy: 'cc-api',
          },
        }),
      ],
      importImpl: vi.fn(async () => ({
        physicalId: 'cdkd-sandbox-KeptRole',
        attributes: { Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole' },
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // A per-key "heal" was tried here and is a DISCLOSURE: two producers write
    // the same `SECRET_MASK`, so `carriesSecretMask` cannot tell Cloud
    // Control's "not certified as an attribute" mask from a GHSA-class SECRET
    // redaction — and on a key that is both certified and secret-bearing the
    // heal wrote plaintext that an adopted NO_CHANGE resource has no needle to
    // re-redact. The stated cost: a mask recorded by a `DescribeType`-less
    // import survives adoption, and re-import stays the remedy.
    expect(plan.adopted['KeptRole']?.attributes?.['Arn']).toBe('***');
  });


  it('refuses AWS::Lambda::LayerVersion even though cdkd DOES name it', async () => {
    const { promise } = run({
      records: [
        record({
          state: {
            physicalId: 'arn:aws:lambda:us-east-1:111122223333:layer:utils:4',
            resourceType: 'AWS::Lambda::LayerVersion',
            properties: {},
            deletionPolicy: 'Retain',
          },
        }),
      ],
      template: {
        Resources: { KeptRole: { Type: 'AWS::Lambda::LayerVersion', Properties: {} } },
      } as unknown as CloudFormationTemplate,
      // Must answer for the RECORDED id: the default stub answers for another,
      // which trips the physical-id mismatch refusal first and the case would
      // pass on the wrong arm.
      importImpl: vi.fn(async () => ({
        physicalId: 'arn:aws:lambda:us-east-1:111122223333:layer:utils:4',
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // Found by review after TaskDefinition shipped alone: `LayerVersionArn` as
    // the physical id, `PublishLayerVersion` minting a new version rather than
    // colliding, and an `update()` that refuses outright — so an adopted
    // version's next change REPLACES, and the delete calls `DeleteLayerVersion`
    // on the revision `Retain` preserved. Membership is a PROFILE; a case per
    // member is what stops the set silently shrinking to one.
    expect(plan.adopted).toEqual({});
    // Arm 1's OWN sentence, not the shared prefix: the EFS case asserts arm 2's
    // ("does not derive that"), so without this, swapping arm 1's text for
    // arm 2's — the exact regression the split exists to prevent — leaves both
    // green.
    expect(plan.notices[0]).toContain('cannot update one in place');
  });

  it('refuses a type cdkd names NOWHERE — the allow-list gate alone', async () => {
    const { promise } = run({
      records: [
        record({
          state: {
            physicalId: 'fs-0123456789abcdef0',
            resourceType: 'AWS::EFS::FileSystem',
            properties: {},
            deletionPolicy: 'Retain',
          },
        }),
      ],
      template: {
        Resources: { KeptRole: { Type: 'AWS::EFS::FileSystem', Properties: {} } },
      } as unknown as CloudFormationTemplate,
      importImpl: vi.fn(async () => ({
        physicalId: 'fs-0123456789abcdef0',
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // `AWS::EFS::FileSystem` is in NEITHER name table and NOT in the refusal
    // set, so only the allow-list gate can refuse it — the other cases here are
    // all types the refusal set also names, which left that gate probing GREEN.
    // AWS mints `fs-…`, so there is nothing for a deploy to collide with.
    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toHaveLength(1);
    expect(plan.notices[0]).toContain('does not derive that');
  });

  it('never adopts a type cdkd does not name', async () => {
    const { promise } = run({
      records: [
        record({
          state: {
            physicalId: 'arn:aws:ecs:us-east-1:111122223333:task-definition/svc:7',
            resourceType: 'AWS::ECS::TaskDefinition',
            properties: {},
            deletionPolicy: 'Retain',
          },
        }),
      ],
      template: {
        Resources: { KeptRole: { Type: 'AWS::ECS::TaskDefinition', Properties: {} } },
      } as unknown as CloudFormationTemplate,
      // The default stub answers for a different id, which trips the
      // physical-id mismatch refusal FIRST — so without this the case passes on
      // the wrong arm and says nothing about the exclusion list.
      importImpl: vi.fn(async () => ({
        physicalId: 'arn:aws:ecs:us-east-1:111122223333:task-definition/svc:7',
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // Its physical id is the revision ARN, not a generated name, so the
    // by-construction match can never hold; `RegisterTaskDefinition` mints a
    // new revision rather than colliding, so there is no loop to break; and the
    // provider supports no UPDATE, so an adopted revision's next change is a
    // REPLACEMENT that deregisters the revision `Retain` preserved.
    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toHaveLength(1);
    // Arm 1's own sentence, like the LayerVersion case. The shared prefix is
    // satisfied by BOTH arms, so asserting it left this green when
    // `AWS::ECS::TaskDefinition` was dropped from `ADOPTION_REFUSED_TYPES` —
    // removing the very belt this case exists to pin. (TaskDefinition is
    // refused by the allow-list gate either way, which is exactly why only the
    // arm-1 text can witness the belt.)
    expect(plan.notices[0]).toContain('cannot update one in place');
  });

  it('an excluded type whose resource is GONE still drops its record', async () => {
    const { promise } = run({
      records: [
        record({
          state: {
            physicalId: 'arn:aws:ecs:us-east-1:111122223333:task-definition/svc:7',
            resourceType: 'AWS::ECS::TaskDefinition',
            properties: {},
            deletionPolicy: 'Retain',
          },
        }),
      ],
      importImpl: vi.fn(async () => null) as ResourceProvider['import'],
    });
    const plan = await promise;

    // Placing the exclusion arm at the TOP of the loop — where it first went —
    // made the two arms that CLEAR a record unreachable for these types. A user
    // who deleted the revision by hand could then never be rid of the record,
    // and a notice claiming it "is still in AWS" printed on every deploy and
    // every diff forever, with no AWS call behind it.
    expect(plan.remaining).toEqual([]);
    expect(plan.notices).toEqual([]);
  });

  it('an excluded type ALREADY in state drops its record too', async () => {
    const { promise, importFn } = run({
      records: [
        record({
          state: {
            physicalId: 'arn:aws:ecs:us-east-1:111122223333:task-definition/svc:7',
            resourceType: 'AWS::ECS::TaskDefinition',
            properties: {},
            deletionPolicy: 'Retain',
          },
        }),
      ],
      managed: ['KeptRole'],
    });
    const plan = await promise;

    // The other arm the too-early placement shadowed, and the reachable one:
    // go-to-k/cdkd#2916's own advice is `cdkd import`, which puts the logical id
    // in `resources`.
    expect(plan.remaining).toEqual([]);
    expect(importFn).not.toHaveBeenCalled();
  });

  it('a recorded attribute wins over an unmasked readback one', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => ({
        physicalId: 'cdkd-sandbox-KeptRole',
        attributes: { Arn: 'arn:aws:iam::999988887777:role/someone-else' },
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // The discriminator for the case above — without this, filtering masks
    // alone would pass while precedence stayed inverted. Recorded values came
    // from the actual create and are authoritative; drift is
    // `observedProperties`' job.
    expect(plan.adopted['KeptRole']?.attributes?.['Arn']).toBe(
      'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole'
    );
  });

  it('refuses when the provider answers for a DIFFERENT physical id', async () => {
    const { promise } = run({
      importImpl: vi.fn(async () => ({
        physicalId: 'some-other-role',
      })) as ResourceProvider['import'],
    });
    const plan = await promise;

    // `knownPhysicalId` is a contract ~74 implementations are trusted to keep
    // and nothing enforces. One that searches instead vouches for another
    // resource, which adoption would put under this stack's `cdkd destroy`.
    expect(plan.adopted).toEqual({});
    expect(plan.remaining).toHaveLength(1);
    expect(plan.notices[0]).toContain('some-other-role');
  });

  it('does not read siblings when the cheaper checks already declined', async () => {
    const { promise, readSiblingClaims } = run({
      template: { Resources: {} } as CloudFormationTemplate,
    });
    await promise;
    expect(readSiblingClaims).not.toHaveBeenCalled();
  });
});

describe('templateStillDeclares (#2934)', () => {
  const rec = record();

  it('true when the logical id and type match and no name is supplied', () => {
    expect(templateStillDeclares(declaringTemplate, rec, ['RoleName'])).toBe(true);
  });

  it('false when the logical id is absent', () => {
    expect(templateStillDeclares({ Resources: {} } as CloudFormationTemplate, rec, [])).toBe(false);
  });

  it('false when the same logical id now carries a DIFFERENT type', () => {
    // The by-construction argument is over (stack, logicalId) AND the type. A
    // CDK refactor can reuse a logical id for an unrelated resource; adopting
    // then would bind old data to a new purpose.
    const template = {
      Resources: { KeptRole: { Type: 'AWS::IAM::User', Properties: {} } },
    } as unknown as CloudFormationTemplate;
    expect(templateStillDeclares(template, rec, [])).toBe(false);
  });

  it('false when the template supplies an explicit name', () => {
    // There is no collision to solve: cdkd will not request the recorded name.
    const template = {
      Resources: { KeptRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'chosen' } } },
    } as unknown as CloudFormationTemplate;
    expect(templateStillDeclares(template, rec, ['RoleName'])).toBe(false);
  });

  it('false when the name property carries an unresolved intrinsic', () => {
    // Cannot be compared here, so it is treated as a mismatch. Falling through
    // to CREATE is the safe direction — it either succeeds or fails with the
    // go-to-k/cdkd#2916 diagnosis.
    const template = {
      Resources: {
        KeptRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: { Ref: 'NameParam' } } },
      },
    } as unknown as CloudFormationTemplate;
    expect(templateStillDeclares(template, rec, ['RoleName'])).toBe(false);
  });
});
