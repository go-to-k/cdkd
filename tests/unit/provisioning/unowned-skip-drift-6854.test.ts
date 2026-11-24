/**
 * go-to-k/cdkd#6854 (lane E): DLM `PolicyDetails` (and a default policy's
 * shorthand fields) and EMR `AutoTerminationPolicy` / `ManagedScalingPolicy`
 * used to be skipped whole by `getDriftUnknownPaths`, hiding a real
 * out-of-band change. They are now read and compared as their DECLARED
 * members only. Each AWS answer below is the shape measured in us-east-1 on
 * 2026-11-23.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dlm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dlm')>();
  return {
    ...actual,
    DLMClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

import { InvalidRequestException } from '@aws-sdk/client-emr';
import { DLMLifecyclePolicyProvider } from '../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import { EMRClusterProvider } from '../../../src/provisioning/providers/emr-cluster-provider.js';
import {
  filledDefaultsFrom,
  projectDeclaredDriftPair,
  projectOntoDeclared,
  undeclaredDriftKeys,
} from '../../../src/provisioning/drift-declared-projection.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { buildRevertNewProperties } from '../../../src/cli/commands/drift/revert-payload.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

function routeSend(routes: Record<string, unknown>): void {
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (!(name in routes)) return Promise.reject(new Error(`Unexpected command: ${name}`));
    const value = routes[name];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  });
}

/**
 * What `cdkd drift` reports for one resource, through the provider's hooks.
 * `observed`: the baseline is an `observedProperties` record, which the
 * comparator walks by the key union (`compare.ts`).
 */
async function driftPaths(
  provider: ResourceProvider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown>,
  observed = false
): Promise<string[]> {
  const pair = await provider.canonicalizeDriftPair!(resourceType, baseline, aws, properties);
  return calculateResourceDrift(pair.baseline, pair.aws, {
    unionWalkObjects: observed,
    ignorePaths: provider.getDriftUnknownPaths!(resourceType, properties),
    resourceType,
  }).map((d) => d.path);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('projectOntoDeclared', () => {
  const filled = filledDefaultsFrom({ Filled: [true], D: [0], E: [[]] });

  it('drops undeclared members holding a filled default and keeps declared ones, by position in lists', () => {
    expect(
      projectOntoDeclared(
        { A: 1, L: [{ X: 'x' }] },
        { A: 1, Filled: true, L: [{ X: 'x', D: 0 }] },
        filled
      )
    ).toEqual({ A: 1, L: [{ X: 'x' }] });
  });

  it('keeps an undeclared member that is not a filled default, or holds another value', () => {
    // A member added out of band, a filled name holding another value, and
    // every undeclared member when no defaults are given.
    expect(
      projectOntoDeclared({ L: [{ X: 'x' }] }, { L: [{ X: 'x', D: 3, Rule: { N: 1 } }] }, filled)
    ).toEqual({ L: [{ X: 'x', D: 3, Rule: { N: 1 } }] });
    expect(projectOntoDeclared({ A: 1 }, { A: 1, Filled: false }, filled)).toEqual({
      A: 1,
      Filled: false,
    });
    expect(projectOntoDeclared({ A: 1 }, { A: 1, D: 0 })).toEqual({ A: 1, D: 0 });
  });

  it('an object of filled defaults only is a filled default; one other member keeps it', () => {
    expect(projectOntoDeclared({ A: 1 }, { A: 1, O: { D: 0, E: [] } }, filled)).toEqual({ A: 1 });
    expect(projectOntoDeclared({ A: 1 }, { A: 1, O: { D: 0, E: ['x'] } }, filled)).toEqual({
      A: 1,
      O: { D: 0, E: ['x'] },
    });
    expect(projectOntoDeclared({ A: 1 }, { A: 1, O: {} }, filled)).toEqual({ A: 1, O: {} });
  });

  it('keeps a list element past the declared length, and a missing declared member stays missing', () => {
    expect(projectOntoDeclared([{ X: 1 }], [{ X: 1 }, { X: 2, D: 0 }])).toEqual([
      { X: 1 },
      { X: 2, D: 0 },
    ]);
    expect(projectOntoDeclared({ A: 1, B: 2 }, { A: 1 })).toEqual({ A: 1 });
  });

  it('folds a template scalar spelling only when the string forms are equal', () => {
    expect(projectOntoDeclared({ Count: '7' }, { Count: 7 })).toEqual({ Count: '7' });
    expect(projectOntoDeclared({ On: 'true' }, { On: true })).toEqual({ On: 'true' });
    // Negative: another value, or another spelling of a number, stays as read.
    expect(projectOntoDeclared({ Count: '7' }, { Count: 8 })).toEqual({ Count: 8 });
    expect(projectOntoDeclared({ Count: '07' }, { Count: 7 })).toEqual({ Count: 7 });
    // No case folding.
    expect(projectOntoDeclared({ Unit: 'hours' }, { Unit: 'HOURS' })).toEqual({ Unit: 'HOURS' });
  });

  it('leaves a shape mismatch as read, and returns the input by identity when nothing is dropped', () => {
    const actual = { A: [1] };
    expect(projectOntoDeclared({ A: { B: 1 } }, actual)).toBe(actual);
    expect(projectOntoDeclared({ A: [1] }, actual)).toBe(actual);
  });

  it('the baseline takes the readback only for a whole-leaf mask or a {{resolve:}} reference', () => {
    const aws = { K: { V: 'live' } };
    const pair = (v: string): unknown =>
      projectDeclaredDriftPair(['K'], {}, aws, { K: { V: v } }).baseline['K'];
    expect(pair('***')).toEqual({ V: 'live' });
    expect(pair('{{resolve:ssm:/p}}')).toEqual({ V: 'live' });
    // A literal holding three asterisks is what the deploy sent.
    expect(pair('a***b')).toEqual({ V: 'a***b' });
  });

  it('with fillUnread, a readback missing a declared key (its read failed) takes the baseline value', () => {
    const baseline = { K: { V: 'recorded' } };
    const props = { K: { V: 'template' } };
    const out = projectDeclaredDriftPair(['K'], baseline, {}, props, undefined, true);
    expect(out.aws).toEqual({ K: { V: 'recorded' } });
    expect(out.baseline).toBe(baseline);
    // Without it the missing key stays missing (a removal).
    expect(projectDeclaredDriftPair(['K'], baseline, {}, props).aws).toEqual({});
    // Undeclared: left alone.
    const none = projectDeclaredDriftPair(['K'], baseline, {}, {}, undefined, true);
    expect(none.aws).toEqual({});
  });

  it('undeclaredDriftKeys: every key with no recorded properties, else the undeclared ones', () => {
    expect(undeclaredDriftKeys(['A', 'B'], undefined)).toEqual(['A', 'B']);
    expect(undeclaredDriftKeys(['A', 'B'], {})).toEqual(['A', 'B']);
    expect(undeclaredDriftKeys(['A', 'B'], { A: {}, B: null, C: 1 })).toEqual(['B']);
  });
});

const DLM = 'AWS::DLM::LifecyclePolicy';

/** A custom policy as CDK synthesizes it (`RetainRule.Count: 7`). */
const DLM_TEMPLATE = {
  ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
  Description: 'snapshots',
  State: 'ENABLED',
  PolicyDetails: {
    PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
    ResourceTypes: ['VOLUME'],
    TargetTags: [{ Key: 'backup', Value: 'true' }],
    Schedules: [
      {
        Name: 'Daily',
        CreateRule: { Interval: 24, IntervalUnit: 'HOURS', Times: ['09:00'] },
        RetainRule: { Count: 7 },
      },
    ],
  },
};

/** GetLifecyclePolicy's answer for that policy (measured, with the filled defaults). */
function dlmAnswer(count = 7): Record<string, unknown> {
  return {
    Policy: {
      PolicyId: 'policy-0123456789abcdef0',
      Description: 'snapshots',
      State: 'ENABLED',
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
      DefaultPolicy: false,
      PolicyDetails: {
        PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
        ResourceTypes: ['VOLUME'],
        ResourceLocations: ['CLOUD'],
        TargetTags: [{ Key: 'backup', Value: 'true' }],
        Schedules: [
          {
            Name: 'Daily',
            CopyTags: false,
            CreateRule: { Location: 'CLOUD', Interval: 24, IntervalUnit: 'HOURS', Times: ['09:00'] },
            RetainRule: { Count: count, Interval: 0 },
          },
        ],
        PolicyLanguage: 'STANDARD',
      },
      Tags: {},
    },
  };
}

describe('DLM LifecyclePolicy: PolicyDetails compared as declared (#6854)', () => {
  let provider: DLMLifecyclePolicyProvider;
  const read = async (count = 7): Promise<Record<string, unknown>> => {
    routeSend({ GetLifecyclePolicyCommand: dlmAnswer(count) });
    return (await provider.readCurrentState('policy-0123456789abcdef0', 'P', DLM)) as Record<
      string,
      unknown
    >;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
  });

  it('a template baseline against the readback with its filled defaults: no drift', async () => {
    expect(await driftPaths(provider, DLM, clone(DLM_TEMPLATE), await read(), DLM_TEMPLATE)).toEqual(
      []
    );
  });

  it('an out-of-band RetainRule.Count change is drift (was hidden by the whole-key skip)', async () => {
    expect(
      await driftPaths(provider, DLM, clone(DLM_TEMPLATE), await read(30), DLM_TEMPLATE)
    ).toEqual(['PolicyDetails.Schedules']);
  });

  it('an observed baseline holding the full readback: a declared change is drift, an undeclared default is not', async () => {
    const observed = await read();
    expect(await driftPaths(provider, DLM, observed, await read(30), DLM_TEMPLATE, true)).toEqual([
      'PolicyDetails.Schedules',
    ]);
    const live = await read();
    const schedule = (
      (live['PolicyDetails'] as Record<string, unknown>)['Schedules'] as Array<
        Record<string, unknown>
      >
    )[0]!;
    // Undeclared but not DLM's filled value: changed out of band, and the next
    // update's whole PolicyDetails would reset it, so it is drift.
    schedule['CopyTags'] = true;
    expect(await driftPaths(provider, DLM, observed, live, DLM_TEMPLATE, true)).toEqual([
      'PolicyDetails.Schedules',
    ]);
  });

  it('a schedule member added out of band (FastRestoreRule, ShareRules) is drift on either baseline', async () => {
    for (const [member, value] of [
      ['FastRestoreRule', { Count: 1, AvailabilityZones: ['us-east-1a'] }],
      ['ShareRules', [{ TargetAccounts: ['210987654321'] }]],
      ['CrossRegionCopyRules', [{ TargetRegion: 'us-west-2', Encrypted: false }]],
    ] as const) {
      const live = await read();
      (
        (live['PolicyDetails'] as Record<string, unknown>)['Schedules'] as Array<
          Record<string, unknown>
        >
      )[0]![member] = value;
      expect(await driftPaths(provider, DLM, clone(DLM_TEMPLATE), live, DLM_TEMPLATE)).toEqual([
        'PolicyDetails.Schedules',
      ]);
      expect(await driftPaths(provider, DLM, await read(), live, DLM_TEMPLATE, true)).toEqual([
        'PolicyDetails.Schedules',
      ]);
    }
  });

  it('a legacy baseline whose recorded declaration holds a {{resolve:}} reference is completed from the readback', async () => {
    const withRef = clone(DLM_TEMPLATE) as Record<string, unknown>;
    (withRef['PolicyDetails'] as Record<string, unknown>)['TargetTags'] = [
      { Key: 'backup', Value: '{{resolve:ssm:/backup-tag}}' },
    ];
    const legacy = { ...(await read()) };
    delete legacy['PolicyDetails'];
    const pair = await provider.canonicalizeDriftPair(DLM, legacy, await read(30), withRef);
    expect(JSON.stringify(pair.baseline)).not.toContain('{{resolve:');
    expect(
      (
        (pair.baseline['PolicyDetails'] as Record<string, unknown>)['Schedules'] as Array<
          Record<string, Record<string, unknown>>
        >
      )[0]!['RetainRule']!['Count']
    ).toBe(30);
  });

  it('a legacy observed baseline (no PolicyDetails) is completed from the template', async () => {
    const legacy = { ...(await read()) };
    delete legacy['PolicyDetails'];
    expect(await driftPaths(provider, DLM, legacy, await read(), DLM_TEMPLATE)).toEqual([]);
    expect(await driftPaths(provider, DLM, legacy, await read(30), DLM_TEMPLATE)).toEqual(['PolicyDetails.Schedules']);
  });

  it('an added or reordered schedule is drift (DLM keeps the order sent)', async () => {
    const two = clone(DLM_TEMPLATE);
    const second = {
      Name: 'Weekly',
      CreateRule: { Interval: 12, IntervalUnit: 'HOURS', Times: ['03:00'] },
      RetainRule: { Count: 2 },
    };
    two.PolicyDetails.Schedules.push(second);
    const live = await read();
    const added = clone(live);
    (
      (added['PolicyDetails'] as Record<string, unknown>)['Schedules'] as unknown[]
    ).push({ ...second, CopyTags: false });
    expect(await driftPaths(provider, DLM, clone(DLM_TEMPLATE), added, DLM_TEMPLATE)).toEqual(['PolicyDetails.Schedules']);
    const reordered = clone(added);
    (
      (reordered['PolicyDetails'] as Record<string, unknown>)['Schedules'] as unknown[]
    ).reverse();
    expect(await driftPaths(provider, DLM, clone(two), reordered, two)).toEqual(['PolicyDetails.Schedules']);
    expect(await driftPaths(provider, DLM, clone(two), added, two)).toEqual([]);
  });

  it('a template that does not declare PolicyDetails skips it; no properties is the type-level skip', () => {
    expect(provider.getDriftUnknownPaths(DLM, { State: 'ENABLED' })).toContain('PolicyDetails');
    expect(provider.getDriftUnknownPaths(DLM)).toContain('PolicyDetails');
    expect(provider.getDriftUnknownPaths(DLM, DLM_TEMPLATE)).not.toContain('PolicyDetails');
    expect(provider.getDriftUnknownPaths(DLM, DLM_TEMPLATE)).toContain('DefaultPolicy');
  });

  describe('a default policy', () => {
    const TEMPLATE = {
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
      State: 'DISABLED',
      DefaultPolicy: 'VOLUME',
      CreateInterval: 2,
      Exclusions: { ExcludeBootVolumes: true },
    };
    const answer = (createInterval: number, retainInterval: number): Record<string, unknown> => ({
      Policy: {
        PolicyId: 'policy-0123456789abcdef1',
        State: 'DISABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        DefaultPolicy: true,
        PolicyDetails: {
          PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
          PolicyLanguage: 'SIMPLIFIED',
          ResourceType: 'VOLUME',
          CreateInterval: createInterval,
          RetainInterval: retainInterval,
          CopyTags: false,
          ExtendDeletion: false,
          Exclusions: { ExcludeBootVolumes: true, ExcludeVolumeTypes: [], ExcludeTags: [] },
        },
        Tags: {},
      },
    });
    const viaDetails = {
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
      State: 'DISABLED',
      DefaultPolicy: 'VOLUME',
      PolicyDetails: { PolicyLanguage: 'SIMPLIFIED', ResourceType: 'VOLUME', CreateInterval: 2 },
    };
    const readDefault = async (
      c: number,
      r: number,
      properties: Record<string, unknown> = TEMPLATE,
      excludeBootVolumes = true
    ): Promise<Record<string, unknown>> => {
      const a = answer(c, r);
      (
        (a['Policy'] as Record<string, Record<string, Record<string, unknown>>>)['PolicyDetails']![
          'Exclusions'
        ]!
      )['ExcludeBootVolumes'] = excludeBootVolumes;
      routeSend({ GetLifecyclePolicyCommand: a });
      return (await provider.readCurrentState(
        'policy-0123456789abcdef1',
        'D',
        DLM,
        properties
      )) as Record<string, unknown>;
    };

    it('reads the shorthand fields at the top level (no PolicyDetails), and DefaultPolicy in the template spelling', async () => {
      const state = await readDefault(2, 7);
      expect(state).toMatchObject({
        CreateInterval: 2,
        RetainInterval: 7,
        CopyTags: false,
        DefaultPolicy: 'VOLUME',
      });
      expect(state).not.toHaveProperty('PolicyDetails');
      // No recorded properties (an import): the top-level form too.
      routeSend({ GetLifecyclePolicyCommand: answer(2, 7) });
      const bare = (await provider.readCurrentState('policy-0123456789abcdef1', 'D', DLM)) as Record<
        string,
        unknown
      >;
      expect(bare).not.toHaveProperty('PolicyDetails');
      expect(bare['CreateInterval']).toBe(2);
    });

    it('a record declaring PolicyDetails reads PolicyDetails only, no shorthand field', async () => {
      const state = await readDefault(2, 7, viaDetails);
      expect(state['PolicyDetails']).toMatchObject({ ResourceType: 'VOLUME', CreateInterval: 2 });
      for (const key of ['CreateInterval', 'RetainInterval', 'CopyTags', 'ExtendDeletion', 'Exclusions']) {
        expect(state).not.toHaveProperty(key);
      }
      expect(state['DefaultPolicy']).toBe('VOLUME');
    });

    it('declared through PolicyDetails (DLM takes either form): no phantom drift; a change is drift', async () => {
      const live = (c: number, boot = false): Promise<Record<string, unknown>> =>
        readDefault(c, 7, viaDetails, boot);
      expect(await driftPaths(provider, DLM, clone(viaDetails), await live(2), viaDetails)).toEqual(
        []
      );
      const observed = await live(2);
      expect(await driftPaths(provider, DLM, observed, await live(2), viaDetails, true)).toEqual([]);
      expect(await driftPaths(provider, DLM, clone(viaDetails), await live(4), viaDetails)).toEqual([
        'PolicyDetails.CreateInterval',
      ]);
      // An undeclared exclusion turned on out of band is not a filled default.
      expect(
        await driftPaths(provider, DLM, observed, await live(2, true), viaDetails, true)
      ).toEqual(['PolicyDetails.Exclusions']);
      // The template baseline walks only its own keys inside an object (the
      // comparator's rule for every type): not compared there.
      expect(
        await driftPaths(provider, DLM, clone(viaDetails), await live(2, true), viaDetails)
      ).toEqual([]);
    });

    it('a revert of a Description and CreateInterval drift sends one form, never both', async () => {
      const template = { ...TEMPLATE, Description: 'default' };
      const a = answer(4, 7);
      (a['Policy'] as Record<string, unknown>)['Description'] = 'changed in the console';
      routeSend({ GetLifecyclePolicyCommand: a });
      const live = (await provider.readCurrentState(
        'policy-0123456789abcdef1',
        'D',
        DLM,
        template
      )) as Record<string, unknown>;
      const pair = await provider.canonicalizeDriftPair(DLM, clone(template), live, template);
      const drifts = calculateResourceDrift(pair.baseline, pair.aws, {
        ignorePaths: provider.getDriftUnknownPaths(DLM, template),
        resourceType: DLM,
      });
      expect(drifts.map((d) => d.path).sort()).toEqual(['CreateInterval', 'Description']);
      const next = buildRevertNewProperties(drifts, pair.baseline, live, {
        preserveUntemplated: true,
      });
      const arn = vi
        .spyOn(provider as unknown as { fetchPolicyArn: () => Promise<string> }, 'fetchPolicyArn')
        .mockResolvedValue('arn:aws:dlm:us-east-1:123456789012:policy/p');
      routeSend({ UpdateLifecyclePolicyCommand: {} });
      await provider.update('D', 'policy-0123456789abcdef1', DLM, next, live);
      arn.mockRestore();
      const input = mockSend.mock.calls
        .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
        .find((c) => c.constructor.name === 'UpdateLifecyclePolicyCommand')!.input;
      expect(input).not.toHaveProperty('PolicyDetails');
      expect(input).toMatchObject({ CreateInterval: 2, Description: 'default' });
    });

    it('a declared shorthand field DLM no longer returns is drift (a removal, never filled from the baseline)', async () => {
      const a = answer(2, 7);
      delete (a['Policy'] as Record<string, Record<string, unknown>>)['PolicyDetails']![
        'Exclusions'
      ];
      routeSend({ GetLifecyclePolicyCommand: a });
      const live = (await provider.readCurrentState(
        'policy-0123456789abcdef1',
        'D',
        DLM,
        TEMPLATE
      )) as Record<string, unknown>;
      expect(live).not.toHaveProperty('Exclusions');
      expect(await driftPaths(provider, DLM, clone(TEMPLATE), live, TEMPLATE)).toEqual([
        'Exclusions',
      ]);
    });

    it('update() refuses a bag holding PolicyDetails and a shorthand field, before any call', async () => {
      routeSend({});
      await expect(
        provider.update(
          'D',
          'policy-0123456789abcdef1',
          DLM,
          { ...clone(viaDetails), CreateInterval: 2 },
          clone(viaDetails)
        )
      ).rejects.toThrow(/PolicyDetails and CreateInterval are both set/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a legacy observed baseline (no DefaultPolicy) is completed, so a revert built from it is not refused', async () => {
      const legacy = { ...(await readDefault(2, 7)) };
      delete legacy['DefaultPolicy'];
      delete legacy['PolicyDetails'];
      const live = await readDefault(5, 7);
      const pair = await provider.canonicalizeDriftPair(DLM, legacy, live, TEMPLATE);
      expect(pair.baseline['DefaultPolicy']).toBe('VOLUME');
      const arn = vi
        .spyOn(provider as unknown as { fetchPolicyArn: () => Promise<string> }, 'fetchPolicyArn')
        .mockResolvedValue('arn:aws:dlm:us-east-1:123456789012:policy/p');
      routeSend({ UpdateLifecyclePolicyCommand: {} });
      await expect(
        provider.update('D', 'policy-0123456789abcdef1', DLM, pair.baseline, live)
      ).resolves.toMatchObject({ wasReplaced: false });
      arn.mockRestore();
    });

    it("a revert's previous side (the readback) carries the template's DefaultPolicy, so update() does not refuse", async () => {
      const live = await readDefault(5, 7);
      const update = vi
        .spyOn(provider as unknown as { fetchPolicyArn: () => Promise<string> }, 'fetchPolicyArn')
        .mockResolvedValue('arn:aws:dlm:us-east-1:123456789012:policy/p');
      routeSend({ UpdateLifecyclePolicyCommand: {} });
      await expect(
        provider.update('D', 'policy-0123456789abcdef1', DLM, clone(TEMPLATE), live)
      ).resolves.toMatchObject({ wasReplaced: false });
      update.mockRestore();
    });

    it('declared fields compare (filled Exclusions lists dropped); undeclared ones do not', async () => {
      expect(await driftPaths(provider, DLM, clone(TEMPLATE), await readDefault(2, 7), TEMPLATE)).toEqual(
        []
      );
      // RetainInterval is undeclared: an out-of-band change is not compared.
      expect(await driftPaths(provider, DLM, clone(TEMPLATE), await readDefault(2, 30), TEMPLATE)).toEqual(
        []
      );
      expect(await driftPaths(provider, DLM, clone(TEMPLATE), await readDefault(5, 7), TEMPLATE)).toEqual(
        ['CreateInterval']
      );
    });
  });
});

const EMR = 'AWS::EMR::Cluster';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';

describe('EMR Cluster: declared AutoTerminationPolicy / ManagedScalingPolicy (#6854)', () => {
  let provider: EMRClusterProvider;
  const TEMPLATE = {
    Name: 'c',
    AutoTerminationPolicy: { IdleTimeout: 3600 },
    ManagedScalingPolicy: {
      ComputeLimits: { UnitType: 'Instances', MinimumCapacityUnits: 1, MaximumCapacityUnits: 2 },
    },
  };
  const routes = (
    idle: number | undefined,
    max: number | undefined
  ): Record<string, unknown> => ({
    DescribeClusterCommand: {
      Cluster: { Id: CLUSTER_ID, Name: 'c', Status: { State: 'WAITING' } },
    },
    ListInstanceGroupsCommand: { InstanceGroups: [] },
    GetAutoTerminationPolicyCommand:
      idle === undefined ? {} : { AutoTerminationPolicy: { IdleTimeout: idle } },
    GetManagedScalingPolicyCommand:
      max === undefined
        ? {}
        : {
            ManagedScalingPolicy: {
              ComputeLimits: {
                UnitType: 'Instances',
                MinimumCapacityUnits: 1,
                MaximumCapacityUnits: max,
              },
            },
          },
  });
  const read = async (
    idle: number | undefined,
    max: number | undefined,
    properties: Record<string, unknown> = TEMPLATE
  ): Promise<Record<string, unknown>> => {
    routeSend(routes(idle, max));
    return (await provider.readCurrentState(CLUSTER_ID, 'C', EMR, properties)) as Record<
      string,
      unknown
    >;
  };
  const sent = (): string[] => mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EMRClusterProvider();
  });

  it('reads both policies when declared, beside the instance list', async () => {
    const state = await read(3600, 2);
    expect(state['AutoTerminationPolicy']).toEqual({ IdleTimeout: 3600 });
    expect(state['ManagedScalingPolicy']).toEqual(TEMPLATE.ManagedScalingPolicy);
    expect(sent()).toEqual(
      expect.arrayContaining(['GetAutoTerminationPolicyCommand', 'GetManagedScalingPolicyCommand'])
    );
  });

  it('issues no Get*Policy call when the template declares neither', async () => {
    const state = await read(3600, 2, { Name: 'c' });
    expect(sent()).not.toContain('GetAutoTerminationPolicyCommand');
    expect(sent()).not.toContain('GetManagedScalingPolicyCommand');
    expect(state).not.toHaveProperty('AutoTerminationPolicy');
  });

  it('an empty answer (the policy removed) emits the key as {}', async () => {
    const state = await read(undefined, undefined);
    expect(state['AutoTerminationPolicy']).toEqual({});
    expect(state['ManagedScalingPolicy']).toEqual({});
  });

  it('a failed Get*Policy omits only that key, with a warning naming the class only', async () => {
    const denied = Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x is not authorized'), {
      name: 'AccessDeniedException',
    });
    const warn = vi.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    routeSend({ ...routes(3600, 2), GetManagedScalingPolicyCommand: denied });
    const state = (await provider.readCurrentState(CLUSTER_ID, 'C', EMR, TEMPLATE)) as Record<
      string,
      unknown
    >;
    expect(state).not.toHaveProperty('ManagedScalingPolicy');
    expect(state['AutoTerminationPolicy']).toEqual({ IdleTimeout: 3600 });
    expect(state['Name']).toBe('c');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('ManagedScalingPolicy not read (AccessDeniedException');
    expect(line).toContain('allow elasticmapreduce:GetManagedScalingPolicy');
    expect(line).not.toContain('assumed-role');
    // Throttled: the same, no permission hint.
    warn.mockClear();
    routeSend({
      ...routes(3600, 2),
      GetAutoTerminationPolicyCommand: Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
      }),
    });
    const throttled = (await provider.readCurrentState(CLUSTER_ID, 'C', EMR, TEMPLATE)) as Record<
      string,
      unknown
    >;
    expect(throttled).not.toHaveProperty('AutoTerminationPolicy');
    expect(throttled['ManagedScalingPolicy']).toEqual(TEMPLATE.ManagedScalingPolicy);
    expect(String(warn.mock.calls[0]![0])).not.toContain('allow ');
    warn.mockRestore();
  });

  it('an unread key is not compared, and a later readable drift neither phantoms nor misses', async () => {
    const warn = vi.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    routeSend({ ...routes(7200, 2), GetAutoTerminationPolicyCommand: denied });
    const unread = (await provider.readCurrentState(CLUSTER_ID, 'C', EMR, TEMPLATE)) as Record<
      string,
      unknown
    >;
    // Against an observed baseline holding an accepted 7200: not compared, and
    // `--accept` (which persists the pair's AWS side) keeps the recorded value.
    const accepted = { ...(await read(7200, 2)) };
    const pair = await provider.canonicalizeDriftPair(EMR, accepted, unread, TEMPLATE);
    expect(pair.aws['AutoTerminationPolicy']).toEqual({ IdleTimeout: 7200 });
    expect(await driftPaths(provider, EMR, accepted, unread, TEMPLATE, true)).toEqual([]);
    expect(await driftPaths(provider, EMR, clone(TEMPLATE), unread, TEMPLATE)).toEqual([]);
    // A baseline captured by that failed read lacks the key: the next readable
    // drift compares the template's value (what the deploy sent).
    expect(await driftPaths(provider, EMR, unread, await read(3600, 2), TEMPLATE)).toEqual([]);
    expect(await driftPaths(provider, EMR, unread, await read(5400, 2), TEMPLATE)).toEqual([
      'AutoTerminationPolicy.IdleTimeout',
    ]);
    warn.mockRestore();
  });

  it('readUnsettled reads an unsettled policy even when undeclared, reports {} as absent, and fails on an unread one', async () => {
    routeSend(routes(3600, undefined));
    const live = (await provider.readUnsettled(
      CLUSTER_ID,
      'C',
      EMR,
      new Set(['AutoTerminationPolicy', 'ManagedScalingPolicy']),
      { Name: 'c' }
    )) as Record<string, unknown>;
    expect(live['AutoTerminationPolicy']).toEqual({ IdleTimeout: 3600 });
    expect(live).not.toHaveProperty('ManagedScalingPolicy');
    const warn = vi.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    routeSend({
      ...routes(3600, 2),
      GetManagedScalingPolicyCommand: Object.assign(new Error('denied'), {
        name: 'AccessDeniedException',
      }),
    });
    await expect(
      provider.readUnsettled(CLUSTER_ID, 'C', EMR, new Set(['ManagedScalingPolicy']), TEMPLATE)
    ).rejects.toThrow(/ManagedScalingPolicy of EMR cluster C could not be read/);
    // An unread policy that is not unsettled does not fail the read.
    await expect(
      provider.readUnsettled(CLUSTER_ID, 'C', EMR, new Set(['AutoTerminationPolicy']), TEMPLATE)
    ).resolves.toMatchObject({ AutoTerminationPolicy: { IdleTimeout: 3600 } });
    warn.mockRestore();
  });

  it('a member added out of band to a declared policy is drift (EMR fills none)', async () => {
    const live = await read(3600, 2);
    (live['ManagedScalingPolicy'] as Record<string, unknown>)['ScalingStrategy'] = 'ADVANCED';
    expect(await driftPaths(provider, EMR, await read(3600, 2), live, TEMPLATE, true)).toEqual([
      'ManagedScalingPolicy.ScalingStrategy',
    ]);
  });

  it('a cluster gone between the reads is drift-unknown', async () => {
    routeSend({
      ...routes(3600, 2),
      GetAutoTerminationPolicyCommand: new InvalidRequestException({
        $metadata: {},
        message: 'gone',
      }),
    });
    await expect(provider.readCurrentState(CLUSTER_ID, 'C', EMR, TEMPLATE)).resolves.toBeUndefined();
  });

  it('unchanged: no drift; an out-of-band change or removal: drift', async () => {
    expect(await driftPaths(provider, EMR, clone(TEMPLATE), await read(3600, 2), TEMPLATE)).toEqual(
      []
    );
    expect(await driftPaths(provider, EMR, clone(TEMPLATE), await read(7200, 2), TEMPLATE)).toEqual([
      'AutoTerminationPolicy.IdleTimeout',
    ]);
    expect(await driftPaths(provider, EMR, clone(TEMPLATE), await read(3600, 5), TEMPLATE)).toEqual([
      'ManagedScalingPolicy.ComputeLimits.MaximumCapacityUnits',
    ]);
    expect(
      await driftPaths(provider, EMR, clone(TEMPLATE), await read(undefined, 2), TEMPLATE)
    ).toEqual(['AutoTerminationPolicy.IdleTimeout']);
  });

  it('a template string spelling of a number is the same value; another number is not', async () => {
    const stringy = { ...TEMPLATE, AutoTerminationPolicy: { IdleTimeout: '3600' } };
    expect(await driftPaths(provider, EMR, clone(stringy), await read(3600, 2), stringy)).toEqual(
      []
    );
    expect(await driftPaths(provider, EMR, clone(stringy), await read(3601, 2), stringy)).toEqual([
      'AutoTerminationPolicy.IdleTimeout',
    ]);
  });

  it('a legacy observed baseline (no policy keys) is completed from the template', async () => {
    const legacy = { ...(await read(3600, 2)) };
    delete legacy['AutoTerminationPolicy'];
    delete legacy['ManagedScalingPolicy'];
    expect(await driftPaths(provider, EMR, legacy, await read(3600, 2), TEMPLATE)).toEqual([]);
    expect(await driftPaths(provider, EMR, legacy, await read(7200, 2), TEMPLATE)).toEqual([
      'AutoTerminationPolicy.IdleTimeout',
    ]);
  });

  it('skipped when undeclared or with no recorded properties (the unsettled check reads the type level)', () => {
    expect(provider.getDriftUnknownPaths(EMR)).toEqual(
      expect.arrayContaining(['AutoTerminationPolicy', 'ManagedScalingPolicy'])
    );
    expect(provider.getDriftUnknownPaths(EMR, { Name: 'c' })).toEqual(
      expect.arrayContaining(['AutoTerminationPolicy', 'ManagedScalingPolicy'])
    );
    expect(provider.getDriftUnknownPaths(EMR, TEMPLATE)).not.toContain('AutoTerminationPolicy');
    expect(provider.getDriftUnknownPaths(EMR, TEMPLATE)).not.toContain('ManagedScalingPolicy');
  });
});
