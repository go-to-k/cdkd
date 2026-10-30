import { describe, it, expect, vi } from 'vite-plus/test';

// The createOnly fallback is DescribeType-backed; stub the lookup so this file
// makes no AWS call. The pure comparison beside it runs for real.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return { ...actual, getCreateOnlyPropertyPaths: async () => [] as string[] };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const warn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
  }),
}));

/**
 * Issue [#2750](https://github.com/go-to-k/cdkd/issues/2750) — the DIFF half.
 *
 * The write-side fix (record only what the SDK route sent) is not shippable on
 * its own: state then holds one bag while the template holds a wider one, so
 * the comparison reads the silent-dropped key as a user-made ADD on every later
 * flag-ful deploy — and for a create-only property that classifies as a
 * REPLACEMENT of a resource nobody touched. That is the failure
 * `CanonicalizePropertiesFn`'s contract in `src/types/resource.ts` spells out
 * for issue #1591, arriving through a different narrowing.
 *
 * So both sides are narrowed, by DIFFERENT rules, and the asymmetry is the
 * whole fix:
 *
 * - the RECORD side loses every silent drop for the type. An `sdk` record
 *   cannot have had one written, so its presence is junk — and removing it is
 *   what lets a record poisoned by a pre-fix binary HEAL: the key reads as an
 *   addition, the deploy stops being NO_CHANGE, and the auto-route fires.
 * - the DESIRED side loses only the drops THIS deploy opted into. An un-allowed
 *   drop auto-routes the resource to Cloud Control, which forwards the full map
 *   and does write the property.
 *
 * `AWS::Logs::LogGroup` / `ResourcePolicyDocument` is the pair
 * `tests/integration/sdk-to-cc-autoroute/` measures against real AWS (issue
 * #5524 moved it off the alarm once `EvaluationWindow` was wired).
 */
describe('DiffCalculator silent-drop narrowing (#2750)', () => {
  const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
  const DROPPED = 'ResourcePolicyDocument';
  const ALLOW_KEY = `${RESOURCE_TYPE}:${DROPPED}`;

  // The mixed-bag case needs a type with TWO silent drops (LogGroup has one),
  // so it runs on an AutoScalingGroup: `NotificationConfiguration` is the
  // allow-listed drop and `LaunchConfigurationName` the un-allowed sibling.
  const ASG_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
  const ASG_DROPPED = 'NotificationConfiguration';
  const ASG_SIBLING = 'LaunchConfigurationName';

  const WRITTEN: Record<string, unknown> = {
    LogGroupName: 'log-group-1',
    LogGroupClass: 'STANDARD',
    RetentionInDays: 1,
  };
  const ASG_WRITTEN: Record<string, unknown> = { MinSize: '0', MaxSize: '1' };
  const POLICY = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'delivery.logs.amazonaws.com' },
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: '*',
      },
    ],
  };

  it('PREMISE: the fixture key is a silent drop for this type', () => {
    const coverage = getPropertyCoverage(RESOURCE_TYPE);
    if (!coverage) throw new Error(`${RESOURCE_TYPE} lost its property-coverage record`);
    expect(coverage.silentDrop.has(DROPPED)).toBe(true);
  });

  it('PREMISE: the mixed-bag type has both keys as non-create-only silent drops', () => {
    const coverage = getPropertyCoverage(ASG_TYPE);
    if (!coverage) throw new Error(`${ASG_TYPE} lost its property-coverage record`);
    expect(coverage.silentDrop.has(ASG_DROPPED)).toBe(true);
    expect(coverage.silentDrop.has(ASG_SIBLING)).toBe(true);
    expect(coverage.createOnlyDrops.has(ASG_DROPPED)).toBe(false);
    expect(coverage.createOnlyDrops.has(ASG_SIBLING)).toBe(false);
  });

  function stateWith(
    properties: Record<string, unknown>,
    provisionedBy: 'sdk' | 'cc-api',
    resourceType: string = RESOURCE_TYPE
  ): StackState {
    return {
      version: 7,
      region: 'us-east-1',
      stackName: 'log-group-stack',
      resources: {
        MyLogGroup: {
          physicalId: 'log-group-1',
          resourceType,
          properties,
          attributes: {},
          provisionedBy,
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
  }

  function templateWith(
    properties: Record<string, unknown>,
    resourceType: string = RESOURCE_TYPE
  ): CloudFormationTemplate {
    return { Resources: { MyLogGroup: { Type: resourceType, Properties: properties } } };
  }

  async function diff(
    state: StackState,
    template: CloudFormationTemplate,
    allowed?: ReadonlySet<string>,
    canonicalize?: (t: string, p: Record<string, unknown>) => Record<string, unknown>
  ) {
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      undefined,
      canonicalize,
      allowed
    );
    return changes.get('MyLogGroup')!;
  }

  it('reports NO_CHANGE for a record the fix already narrowed, under the flag', async () => {
    // The steady state after the write-side fix: state holds what was written,
    // the template still declares the opted-into property.
    const change = await diff(
      stateWith({ ...WRITTEN }, 'sdk'),
      templateWith({ ...WRITTEN, [DROPPED]: POLICY }),
      new Set([ALLOW_KEY])
    );
    expect(change.changeType).toBe('NO_CHANGE');
  });

  it('reports NO_CHANGE for a record a PRE-FIX binary poisoned, under the flag', async () => {
    // The record carries the never-written key. Narrowing the record side is
    // what keeps this quiet; narrowing only the desired side would report it as
    // a REMOVE.
    const change = await diff(
      stateWith({ ...WRITTEN, [DROPPED]: POLICY }, 'sdk'),
      templateWith({ ...WRITTEN, [DROPPED]: POLICY }),
      new Set([ALLOW_KEY])
    );
    expect(change.changeType).toBe('NO_CHANGE');
  });

  /**
   * The reported bug, at the diff layer. Drop the flag and nothing else: with
   * the poisoned record compared verbatim this is NO_CHANGE, no update runs,
   * and the auto-route the user is relying on never fires. Stripping the record
   * side makes the property an ADD, so the deploy happens.
   */
  it('reports the property as ADDED once the flag is gone — even from a poisoned record', async () => {
    const change = await diff(
      stateWith({ ...WRITTEN, [DROPPED]: POLICY }, 'sdk'),
      templateWith({ ...WRITTEN, [DROPPED]: POLICY }),
      new Set()
    );
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges?.map((c) => c.path)).toContain(DROPPED);
  });

  it('reports the property as ADDED with no allow set passed at all (`cdkd diff`)', async () => {
    // `cdkd diff` registers no `--allow-unsupported-properties`, so it passes
    // nothing — and its preview is of a FLAG-LESS deploy, which is exactly the
    // one that auto-routes and writes the property.
    const change = await diff(
      stateWith({ ...WRITTEN, [DROPPED]: POLICY }, 'sdk'),
      templateWith({ ...WRITTEN, [DROPPED]: POLICY })
    );
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges?.map((c) => c.path)).toContain(DROPPED);
  });

  /**
   * The NEGATIVE CONTROL for the record side. A `cc-api` record's bag WAS
   * written from the full map, so its silent-drop key is a real AWS value —
   * stripping it would manufacture an ADD on every deploy and re-send it
   * forever.
   */
  it('leaves a cc-api record alone — NO_CHANGE with no flag and the key on both sides', async () => {
    const change = await diff(
      stateWith({ ...WRITTEN, [DROPPED]: POLICY }, 'cc-api'),
      templateWith({ ...WRITTEN, [DROPPED]: POLICY }),
      new Set()
    );
    expect(change.changeType).toBe('NO_CHANGE');
  });

  /**
   * The DESIRED side's half of that same control, which the row above cannot
   * reach: with an empty allow set the desired narrowing is a no-op whatever
   * the route, so only a `cc-api` record WITH the flag discriminates. Cloud
   * Control keeps such a resource (rule 2) and writes the full map, so a
   * desired-side narrowing here would read the recorded, genuinely-applied
   * value as a REMOVAL and patch it away.
   */
  it('does not narrow the DESIRED side for a cc-api record, even under the flag', async () => {
    const change = await diff(
      stateWith({ ...WRITTEN }, 'cc-api'),
      templateWith({ ...WRITTEN, [DROPPED]: POLICY }),
      new Set([ALLOW_KEY])
    );
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges?.map((c) => c.path)).toContain(DROPPED);
  });

  /**
   * The MIXED bag, which a per-property reading of the allow set gets wrong:
   * the un-allowed `LaunchConfigurationName` auto-routes the whole RESOURCE to
   * Cloud Control, which forwards the full map — so the allow-listed
   * `NotificationConfiguration` reaches AWS too and must still be compared.
   */
  it('does not narrow the desired side when a SIBLING drop is un-allowed', async () => {
    const change = await diff(
      stateWith({ ...ASG_WRITTEN }, 'sdk', ASG_TYPE),
      templateWith(
        {
          ...ASG_WRITTEN,
          [ASG_DROPPED]: {
            TopicARN: 'arn:aws:sns:us-east-1:123456789012:t',
            NotificationTypes: ['autoscaling:EC2_INSTANCE_LAUNCH'],
          },
          [ASG_SIBLING]: 'lc-1',
        },
        ASG_TYPE
      ),
      new Set([`${ASG_TYPE}:${ASG_DROPPED}`])
    );
    expect(change.changeType).toBe('UPDATE');
    const paths = change.propertyChanges?.map((c) => c.path) ?? [];
    expect(paths).toContain(ASG_DROPPED);
    expect(paths).toContain(ASG_SIBLING);
  });

  it('a change to a WRITTEN property is still reported under the flag', async () => {
    // The narrowing must not swallow real work: everything outside the drop set
    // is compared exactly as before.
    const change = await diff(
      stateWith({ ...WRITTEN }, 'sdk'),
      templateWith({ ...WRITTEN, RetentionInDays: 14, [DROPPED]: POLICY }),
      new Set([ALLOW_KEY])
    );
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges?.map((c) => c.path)).toEqual(['RetentionInDays']);
  });

  describe('the provider-narrowing WARN keeps its own population', () => {
    const NARROWING_WARN = 'cannot be sent as declared';
    const identity = (_t: string, p: Record<string, unknown>) => p;

    it('does not fire for an opted-into drop', async () => {
      // That warning tells the user to "fix the template to declare only what
      // the resource supports", which is the wrong remedy for a drop they asked
      // for — and `ProviderRegistry.reportSilentDropDecisions` already warns
      // about those, with accurate wording. A canonicalizer is passed because
      // the warning is computed only when one exists; without it this case
      // could not fire the warning under ANY implementation.
      warn.mockClear();
      await diff(
        stateWith({ ...WRITTEN }, 'sdk'),
        templateWith({ ...WRITTEN, [DROPPED]: POLICY }),
        new Set([ALLOW_KEY]),
        identity
      );
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.filter((m) => m.includes(NARROWING_WARN))).toEqual([]);
    });

    it('POSITIVE CONTROL: still fires when the PROVIDER hook drops a key', async () => {
      // Without this the row above passes under an implementation that has
      // silently stopped warning at all.
      warn.mockClear();
      await diff(
        stateWith({ ...WRITTEN }, 'sdk'),
        templateWith({ ...WRITTEN, [DROPPED]: POLICY }),
        new Set([ALLOW_KEY]),
        (_t, p) => {
          const narrowed = { ...p };
          delete narrowed['LogGroupClass'];
          return narrowed;
        }
      );
      const messages = warn.mock.calls.map((c) => String(c[0]));
      const hits = messages.filter((m) => m.includes(NARROWING_WARN));
      expect(hits).toHaveLength(1);
      // It names the PROVIDER's key and not the opted-into drop.
      expect(hits[0]).toContain('LogGroupClass');
      expect(hits[0]).not.toContain(DROPPED);
    });
  });

  // Issue #3713: a key the snapshot does not know routes the resource through
  // Cloud Control only when it differs from the record. Held unchanged, the
  // resource stays on the SDK route, so the allow-listed drop beside it must
  // still be narrowed off the desired side — or it reads as an ADD every deploy.
  describe('an unrecognized key held unchanged (#3713)', () => {
    const UNKNOWN = 'CdkdTotallyNewPropertyFromTheFuture';

    it('keeps the allow-listed narrowing: NO_CHANGE', async () => {
      const change = await diff(
        stateWith({ ...WRITTEN, [UNKNOWN]: 'same' }, 'sdk'),
        templateWith({ ...WRITTEN, [UNKNOWN]: 'same', [DROPPED]: POLICY }),
        new Set([ALLOW_KEY])
      );
      expect(change.changeType).toBe('NO_CHANGE');
    });

    it('a CHANGED unknown key routes, so the drop is not narrowed: UPDATE', async () => {
      const change = await diff(
        stateWith({ ...WRITTEN, [UNKNOWN]: 'same' }, 'sdk'),
        templateWith({ ...WRITTEN, [UNKNOWN]: 'changed', [DROPPED]: POLICY }),
        new Set([ALLOW_KEY])
      );
      expect(change.changeType).toBe('UPDATE');
      expect(change.propertyChanges?.map((p) => p.path).sort()).toEqual([DROPPED, UNKNOWN].sort());
    });
  });
});
