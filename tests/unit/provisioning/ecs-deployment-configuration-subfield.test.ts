import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `vi.hoisted` because the spy is referenced from the `vi.mock` factories
// below, which are hoisted above ordinary top-level declarations.
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecs')>('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { CreateServiceCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import {
  ECSProvider,
  CIRCUIT_BREAKER_THRESHOLD_CONFIGURATION_DEFAULT,
} from '../../../src/provisioning/providers/ecs-provider.js';

const TYPE = 'AWS::ECS::Service';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const updateResponse = { service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' } };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'cfn-schemas',
  'AWS-ECS-Service.json'
);

interface EcsSchemaFixture {
  nestedPropertyPaths?: Record<string, string[]>;
  definitionShapes?: Record<string, Record<string, string>>;
  /** Per-definition `required` list, captured since issue #1800. */
  definitionRequired?: Record<string, string[]>;
}

const readSchemaFixture = (): EcsSchemaFixture =>
  JSON.parse(readFileSync(SCHEMA_FIXTURE_PATH, 'utf8')) as EcsSchemaFixture;

const baseProps = (): Record<string, unknown> => ({
  Cluster: 'my-cluster',
  TaskDefinition: 'my-task:1',
  DesiredCount: 0,
});

const findCommand = (ctor: unknown) =>
  mockSend.mock.calls.find((c) => c[0] instanceof (ctor as new (...args: never[]) => object))?.[0];

/** The full block the live A/B used as its baseline. */
const FULL_BLOCK = {
  MaximumPercent: 200,
  MinimumHealthyPercent: 50,
  DeploymentCircuitBreaker: { Enable: true, Rollback: true },
};

/**
 * Issue #1225 (the #1160 bug class one level down): when a config object is
 * KEPT but one of its sub-fields is dropped, an API with server-side MERGE
 * semantics silently retains the dropped sub-field's live value.
 *
 * `AWS::ECS::Service.DeploymentConfiguration` was the one OPEN row of that
 * audit. It was live-probed against real AWS on 2026-08-13 (us-east-1), SDK
 * and CloudFormation side by side on the same service. The two TOP-LEVEL
 * shapes came back as PARITY — so the correct implementation is the verbatim
 * pass-through cdkd already performs, and BOTH the kept-partial normalization
 * and the #1160 whole-block removal reset that this field was holding open
 * would be DIVERGENCES from CloudFormation.
 *
 * | shape                           | SDK             | CloudFormation      | verdict   |
 * |---------------------------------|-----------------|---------------------|-----------|
 * | kept block, sub-field dropped   | MERGE (retains) | same end state      | parity    |
 * | whole block removed             | omit = retains  | retains (UPDATE ran)| parity    |
 * | nested block, sub-field dropped | REPLACE, ACCEPTS| REFUSES (required)  | DIVERGENT |
 *
 * Row 3 is scoped to the two nested blocks that CARRY a `required` list —
 * `DeploymentCircuitBreaker` and `DeploymentAlarms`. It is NOT a claim about
 * the property's other nested blocks: `LinearConfiguration` and
 * `CanaryConfiguration` have no `required` list and `DeploymentLifecycleHook`
 * requires only `LifecycleStages`, so CFn ACCEPTS a partial there. Those were
 * unmeasured when this file was written (the ROLLING probe could not reach
 * them); issue #1806 measured them and they are PARITY — see the second
 * describe block below, which is where their pins live.
 *
 * The third row is NOT parity, and an earlier revision of this file said it
 * was. The SDK ACCEPTS the partial nested struct and replaces it (a live
 * `rollback` went true -> false); only CloudFormation refuses the template,
 * via a `required`-list check cdkd performs NOWHERE. So cdkd deploys a
 * template CFn rejects — an accepted divergence in the PERMISSIVE direction,
 * tracked as issue #1802. The pass-through is still what these tests pin,
 * because the alternative (re-filling `Rollback` from the previous side)
 * would invent a value the template never declared; the fix belongs in
 * pre-flight, not here.
 *
 * These tests pin the pass-through so a future "helpful" normalization or
 * removal-reset cannot be added silently. Each assertion is written against
 * the shape the REGRESSION would emit (a synthesized default / a reset
 * payload), not merely against "something was sent".
 */
describe('ECS Service DeploymentConfiguration sub-field semantics (#1225)', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ECSProvider();
  });

  const update = async (
    props: Record<string, unknown>,
    prev: Record<string, unknown>
  ): Promise<unknown> => {
    mockSend.mockResolvedValueOnce(updateResponse);
    const result = await provider.update('Svc', SERVICE_ARN, TYPE, props, prev);
    // Same rationale as the #1806 block's helper: this file drains its `*Once`
    // queue, so the leak detector can never flag it and nothing else would
    // notice the update path starting to issue a second call.
    expect(mockSend).toHaveBeenCalledTimes(1);
    return result;
  };

  it('forwards a FULLY specified block verbatim (control polarity)', async () => {
    await update({ ...baseProps(), DeploymentConfiguration: FULL_BLOCK }, baseProps());

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      maximumPercent: 200,
      minimumHealthyPercent: 50,
      deploymentCircuitBreaker: { enable: true, rollback: true },
    });
  });

  it('kept-but-partial block is forwarded VERBATIM — no dropped sub-field is synthesized', async () => {
    await update(
      { ...baseProps(), DeploymentConfiguration: { MaximumPercent: 150 } },
      { ...baseProps(), DeploymentConfiguration: FULL_BLOCK }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    // Exactly what the template declared, and nothing else. AWS merges the
    // rest server-side and CloudFormation produces the identical end state.
    expect(sent).toEqual({ maximumPercent: 150 });

    // (The exact `toEqual` above already excludes any previous-value or
    // REPLICA/DAEMON-default fill; no per-member restatement is needed.)
  });

  it('whole-block removal sends NO deploymentConfiguration — never a reset payload', async () => {
    await update(baseProps(), { ...baseProps(), DeploymentConfiguration: FULL_BLOCK });

    const input = findCommand(UpdateServiceCommand).input;

    // CloudFormation issues a real resource UPDATE here and leaves the live
    // configuration intact; the SDK drops an `undefined` member from the wire,
    // so omitting it reproduces that exactly. `toBeUndefined()` is the whole
    // assertion — it already excludes every reset payload the #1160 arm would
    // have sent (`{}`, the REPLICA defaults, the previous block), since none of
    // those is `undefined`.
    expect(input.deploymentConfiguration).toBeUndefined();

    // Non-vacuity guard: the assertion above is an ABSENCE, which would also
    // hold if `update()` had thrown before building the command or issued no
    // call at all. Pin that the UpdateService call really was made, and that
    // the removal did not suppress the rest of the update.
    expect(findCommand(UpdateServiceCommand)).toBeDefined();
    expect(input.service).toBe(SERVICE_ARN);
  });

  it('never-present block stays absent — no reset is derived from an absence on both sides', async () => {
    // The third shape docs/provider-development.md's clear-on-removal
    // checklist demands ("never-present -> stays absent"), and the one that
    // separates a REMOVAL reset from a blanket always-send: a template that
    // never declared the block must not acquire one.
    await update(baseProps(), baseProps());

    const input = findCommand(UpdateServiceCommand).input;
    expect(input.deploymentConfiguration).toBeUndefined();
    expect(findCommand(UpdateServiceCommand)).toBeDefined();
  });

  it('the CREATE path forwards a partial block verbatim too', async () => {
    // update() is not the only converter caller — create() (ecs-provider.ts,
    // the CreateService input) runs the same
    // `convertDeploymentConfiguration`. A blanket default-filler there is
    // already caught by the full-block assertion in ecs-provider.test.ts, but
    // a CONDITIONAL "fill only the missing sub-fields" synthesis — precisely
    // the #1160 / #1225 shape this classification rejects — would slip past
    // it, since a fully-specified block has nothing to fill.
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });

    await provider.create('Svc', TYPE, {
      ...baseProps(),
      ServiceName: 'my-service',
      DeploymentConfiguration: { MaximumPercent: 150 },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(findCommand(CreateServiceCommand).input.deploymentConfiguration).toEqual({
      maximumPercent: 150,
    });
  });

  it('the CREATE path forwards a partial NESTED struct verbatim too', async () => {
    // The create pin above only covers the TOP level. The fill site, not the
    // shared converter, is where a "helpful" synthesis would be added, so the
    // nested struct needs its own pin — otherwise a fill-only-missing applied
    // one level down is caught by nothing.
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });

    await provider.create('Svc', TYPE, {
      ...baseProps(),
      ServiceName: 'my-service',
      DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: false } },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(findCommand(CreateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: { enable: false },
    });
  });

  it('a partial Alarms block is forwarded verbatim (the DeploymentAlarms twin)', async () => {
    // `DeploymentAlarms` (the `Alarms` property) carries the same required-ness
    // divergence as `DeploymentCircuitBreaker` — the registry schema requires
    // [AlarmNames, Rollback, Enable] and CFn refuses a partial, while cdkd
    // forwards it. The provider comment and docs assert that for BOTH blocks;
    // without this pin the claim was only ever exercised for one of them.
    // The previous side must CARRY an Alarms block, or a previous-side merge
    // has nothing to contribute and this test would pin nothing that the
    // DeploymentCircuitBreaker sibling does not already pin.
    await update(
      { ...baseProps(), DeploymentConfiguration: { Alarms: { Enable: true } } },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          ...FULL_BLOCK,
          Alarms: { AlarmNames: ['live-alarm'], Enable: true, Rollback: true },
        },
      }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent).toEqual({ alarms: { enable: true } });
  });

  it('nested block missing a required sub-field is forwarded verbatim (a DIVERGENCE, see #1802)', async () => {
    await update(
      { ...baseProps(), DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: false } } },
      { ...baseProps(), DeploymentConfiguration: FULL_BLOCK }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    // This shape DOES reach the provider — cdkd enforces no nested
    // required-ness, so unlike CloudFormation (which refuses the template with
    // "required key [Rollback] not found") cdkd forwards it, the SDK accepts
    // it, and the nested struct is REPLACED: a live `rollback: true` becomes
    // false. That divergence is issue #1802 and belongs in pre-flight.
    //
    // What is pinned here is that cdkd does not try to hide it by re-filling
    // `rollback` from the previous side — that would invent a value the
    // template never declared, and would make the shape look valid while
    // CloudFormation still rejects the same template.
    expect(sent).toEqual({ deploymentCircuitBreaker: { enable: false } });
  });

  it('the nested blocks whose required-ness carries the depth-2 verdict are still modelled', () => {
    // The weaker half of the fence: the members the verdict names have not
    // been REMOVED from the type. If `Rollback` disappears, the sentence in
    // `ecs-provider.ts` citing it stops describing the schema and the
    // classification needs re-measuring. Kept alongside the required-ness
    // assertion below because the two fail for different reasons — a member
    // can be dropped from the type entirely without any `required` list
    // changing, and vice versa.
    const schema = readSchemaFixture();
    const paths = schema.nestedPropertyPaths?.['DeploymentConfiguration'] ?? [];

    expect(paths).toContain('DeploymentCircuitBreaker.Enable');
    expect(paths).toContain('DeploymentCircuitBreaker.Rollback');
    expect(paths).toContain('Alarms.AlarmNames');
    expect(paths).toContain('Alarms.Enable');
    expect(paths).toContain('Alarms.Rollback');
  });

  it('the depth-2 verdict rests on required-ness, and the fixture now pins the actual lists (#1800)', () => {
    // THE condition the depth-2 row of the table above rests on. Before issue
    // #1800 the fixtures captured no `required` at all, so the strongest
    // available assertion was that the member paths are still MODELLED — which
    // stays true the day AWS relaxes a `required` list, silently turning a
    // "parity by loud reject" verdict into a real silent drop with no test
    // failing. The capture makes the real condition assertable:
    // `UpdateService` REPLACES a nested struct rather than merging it (live
    // A/B, us-east-1, 2026-08-13: a kept `DeploymentCircuitBreaker` missing
    // `Rollback` had its live `rollback` flipped true -> false), so the ONLY
    // thing making that shape unreachable from a valid template is
    // CloudFormation's own model validation refusing it.
    const schema = readSchemaFixture();
    const required = schema.definitionRequired ?? {};

    // Exact lists, not `toContain`: a member DROPPED from a required list is
    // precisely the relaxation this test exists to catch, and `toContain`
    // cannot see a removal.
    expect(required['DeploymentCircuitBreaker']).toEqual(['Enable', 'Rollback']);
    expect(required['DeploymentAlarms']).toEqual(['AlarmNames', 'Enable', 'Rollback']);

    // The three SIBLING nested blocks #1806 is about. Two of them carry NO
    // required list at all, so a kept-but-partial block there IS reachable
    // from a template CloudFormation accepts — which is why they were EXPECTED
    // to be strictly worse than #1802, where CFn at least refuses. They
    // MEASURED as parity instead (the API default-fills the omitted member and
    // CFn reaches the identical end state; see the #1806 describe block), so
    // asserting their ABSENCE states the SCOPE of that verdict rather than
    // over-claiming it: the day AWS adds a required list to one of them, the
    // row moves into the #1802-shaped class — CFn refusing a template cdkd
    // still deploys — visibly instead of silently. The third,
    // `DeploymentLifecycleHook`, does carry one — but only `LifecycleStages`,
    // leaving its other five members droppable, which is why it is in #1806's
    // scope too.
    // The two absences are only meaningful while the definitions still EXIST —
    // `toBeUndefined()` passes just as well if AWS renames or deletes them, at
    // which point the #1806 scope claim below would be about nothing. Pin
    // their existence through the sibling capture first.
    expect(schema.definitionShapes?.['LinearConfiguration']).toBeDefined();
    expect(schema.definitionShapes?.['CanaryConfiguration']).toBeDefined();
    expect(required['LinearConfiguration']).toBeUndefined();
    expect(required['CanaryConfiguration']).toBeUndefined();
    expect(required['DeploymentLifecycleHook']).toEqual(['LifecycleStages']);

    // Non-vacuity guard. It is the two `toBeUndefined` assertions that need
    // it: those pass just as happily against a fixture with NO
    // `definitionRequired` section at all, or against a typo'd key name, since
    // both read as `undefined`. (The `toEqual` assertions above are already
    // self-guarding — they FAIL on `undefined`.) Pinning that the section
    // exists and is populated is what stops a capture regression from
    // silently downgrading this test to the vacuous shape it replaced.
    expect(Object.keys(required).length).toBeGreaterThan(10);
  });
});

/** The traffic-shifting baselines the #1806 live A/B used. */
const LINEAR_FULL = {
  Strategy: 'LINEAR',
  BakeTimeInMinutes: 0,
  MaximumPercent: 200,
  MinimumHealthyPercent: 100,
  LinearConfiguration: { StepPercent: 33, StepBakeTimeInMinutes: 9 },
};
const CANARY_FULL = {
  Strategy: 'CANARY',
  BakeTimeInMinutes: 0,
  MaximumPercent: 200,
  MinimumHealthyPercent: 100,
  CanaryConfiguration: { CanaryPercent: 21, CanaryBakeTimeInMinutes: 9 },
};
const HOOK_FULL = {
  Strategy: 'CANARY',
  LifecycleHooks: [
    {
      TargetType: 'PAUSE',
      LifecycleStages: ['PRE_SCALE_UP'],
      TimeoutConfiguration: { TimeoutInMinutes: 31, Action: 'CONTINUE' },
    },
  ],
};

/**
 * Issue #1806 — the three `DeploymentConfiguration` nested blocks that carry
 * NO `required` list, so unlike the #1802 depth-2 case a kept-but-partial
 * block there is reachable from a template CloudFormation ACCEPTS.
 *
 * Measured against real AWS on 2026-08-13 (us-east-1), SDK and CloudFormation
 * side by side on the same traffic-shifting service, one A/B per block:
 *
 * | block (partial sent)                      | SDK end state   | CFn end state   | verdict |
 * |-------------------------------------------|-----------------|-----------------|---------|
 * | LinearConfiguration {StepPercent 44}      | {44, 6}         | {44, 6}         | parity  |
 * | CanaryConfiguration {CanaryPercent 30}    | {30, 10}        | {30, 10}        | parity  |
 * | hook TimeoutConfiguration {TimeoutMin 45} | {45, ROLLBACK}  | {45, ROLLBACK}  | parity  |
 *
 * So the nested struct IS replaced (the #1802 mechanism), but the absent
 * member is filled with an AWS-side DEFAULT rather than retained — and
 * CloudFormation handed the same partial template reaches the IDENTICAL end
 * state, so the verbatim pass-through cdkd performs is parity and a
 * "fill the missing member from the previous side" normalization would be the
 * DIVERGENCE. The defaults are fixed, not derived: an empty
 * `LinearConfiguration: {}` sent from a live {33, 9} came back {10, 6}.
 *
 * One PREMISE of the issue did not survive the measurement, and one FINDING it
 * does not discuss is recorded beside it: these configs are NOT reachable under
 * `Strategy: BLUE_GREEN` (AWS answers `Linear configuration can only be
 * present with LINEAR deployment strategy`; each config is gated on its own
 * strategy, while `LifecycleHooks` is not — measured under `CANARY`, with its
 * reach under `ROLLING` not probed), and the default-fill
 * does not become phantom drift, because the deploy engine captures
 * `observedProperties` from `readCurrentState` and the AWS-filled value lands
 * in the drift baseline.
 *
 * `LifecycleHooks[].LifecycleStages` — the family's one required member — is
 * the ASG `InstanceMaintenancePolicy` disposition (#1227) instead: AWS ITSELF
 * refuses the element (`InvalidParameterException: Lifecycle stage cannot be
 * null or empty for any deployment lifecycle hooks`), so cdkd's pass-through
 * fails loudly and is parity with no nested required-ness check involved.
 *
 * The same sweep found ONE divergent row, `DeploymentCircuitBreaker`'s two
 * OPTIONAL members, filed as #1861 and FIXED here: there the API RETAINS the
 * omitted member instead of default-filling it, so CloudFormation's removal
 * reset has to be applied by cdkd. That is why this file holds two opposite
 * verdicts about "a member dropped from a still-declared nested struct" — the
 * deciding fact is whether the API itself default-fills, which had to be
 * measured per block rather than reasoned about.
 *
 * Each assertion below is written against the shape the REGRESSION would emit
 * — a previous-side member merged back in for the parity rows, and for the
 * #1861 rows the member simply MISSING from the payload — not merely against
 * "something was sent".
 */
describe('ECS Service DeploymentConfiguration optional nested blocks (#1806)', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ECSProvider();
  });

  /**
   * Primes exactly ONE response and asserts exactly one send was consumed.
   * The count pin lives here rather than in each test because this file drains
   * its `*Once` queue in `beforeEach` — which is correct, but means the
   * once-leak detector can never flag it, so nothing else would notice the
   * update path starting to issue a second call (the change that silently
   * invalidates a priming). See `.claude/rules/testing.md`.
   */
  const update = async (
    props: Record<string, unknown>,
    prev: Record<string, unknown>
  ): Promise<unknown> => {
    mockSend.mockResolvedValueOnce(updateResponse);
    const result = await provider.update('Svc', SERVICE_ARN, TYPE, props, prev);
    expect(mockSend).toHaveBeenCalledTimes(1);
    return result;
  };

  it('kept-but-partial LinearConfiguration is forwarded verbatim — StepBakeTimeInMinutes is NOT merged back', async () => {
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: { ...LINEAR_FULL, LinearConfiguration: { StepPercent: 44 } },
      },
      { ...baseProps(), DeploymentConfiguration: LINEAR_FULL }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    // The exact `toEqual` excludes both regressions at once: the previous
    // side's `stepBakeTimeInMinutes: 9` merged back in (which would make cdkd
    // hold a value CloudFormation does NOT send), and AWS's own default 6
    // synthesized locally (which would make state describe a value cdkd never
    // put on the wire).
    expect(sent).toEqual({
      strategy: 'LINEAR',
      bakeTimeInMinutes: 0,
      maximumPercent: 200,
      minimumHealthyPercent: 100,
      linearConfiguration: { stepPercent: 44 },
    });
  });

  it('kept-but-partial CanaryConfiguration is forwarded verbatim (the sibling shape)', async () => {
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: { ...CANARY_FULL, CanaryConfiguration: { CanaryPercent: 30 } },
      },
      { ...baseProps(), DeploymentConfiguration: CANARY_FULL }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent).toEqual({
      strategy: 'CANARY',
      bakeTimeInMinutes: 0,
      maximumPercent: 200,
      minimumHealthyPercent: 100,
      canaryConfiguration: { canaryPercent: 30 },
    });
  });

  it('a LifecycleHooks element with a partial TimeoutConfiguration is forwarded verbatim (depth 3, inside an array)', async () => {
    // The deepest reachable case of the class: the drop is two levels below
    // the audited property AND inside an array element, so a per-element
    // "fill from the previous element of the same index" is the regression
    // this pins against. The live A/B says the omitted `Action` comes back as
    // AWS's `ROLLBACK` default under BOTH engines.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          ...HOOK_FULL,
          LifecycleHooks: [
            {
              TargetType: 'PAUSE',
              LifecycleStages: ['PRE_SCALE_UP'],
              TimeoutConfiguration: { TimeoutInMinutes: 45 },
            },
          ],
        },
      },
      { ...baseProps(), DeploymentConfiguration: HOOK_FULL }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent).toEqual({
      strategy: 'CANARY',
      lifecycleHooks: [
        {
          targetType: 'PAUSE',
          lifecycleStages: ['PRE_SCALE_UP'],
          timeoutConfiguration: { timeoutInMinutes: 45 },
        },
      ],
    });
  });

  it('a LifecycleHooks element missing the required LifecycleStages is still forwarded verbatim (AWS refuses it, so cdkd fails loudly)', async () => {
    // Deliberately NOT the #1802 shape: cdkd forwards the element unchanged
    // and the AWS API rejects it, so the loud failure IS the parity behavior
    // and no nested required-ness check is owed here. What is pinned is that
    // cdkd does not paper over it by re-filling `LifecycleStages` from the
    // previous side — that would deploy a hook stage the template dropped.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          ...HOOK_FULL,
          LifecycleHooks: [
            { TargetType: 'PAUSE', TimeoutConfiguration: { TimeoutInMinutes: 45 } },
          ],
        },
      },
      { ...baseProps(), DeploymentConfiguration: HOOK_FULL }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent).toEqual({
      strategy: 'CANARY',
      lifecycleHooks: [{ targetType: 'PAUSE', timeoutConfiguration: { timeoutInMinutes: 45 } }],
    });
  });

  it('the CREATE path forwards a partial LinearConfiguration verbatim too', async () => {
    // Same reason the #1225 block pins its own create-path case: a
    // fill-only-the-missing-member synthesis would be added at the fill site,
    // not in the shared converter, so create needs its own pin — and on
    // create there is no previous side at all, which makes AWS's default the
    // only value a synthesis could invent.
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });

    await provider.create('Svc', TYPE, {
      ...baseProps(),
      ServiceName: 'my-service',
      DeploymentConfiguration: { Strategy: 'LINEAR', LinearConfiguration: { StepPercent: 44 } },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(findCommand(CreateServiceCommand).input.deploymentConfiguration).toEqual({
      strategy: 'LINEAR',
      linearConfiguration: { stepPercent: 44 },
    });
  });

  it('a hook element missing TargetType is forwarded verbatim (AWS refuses it — the #1227 disposition)', async () => {
    // Measured: dropping `TargetType` makes AWS answer `Role arn or Hook
    // Target arn is missing for one or more deployment lifecycle hooks`,
    // because an absent TargetType DEFAULTS to AWS_LAMBDA — so one dropped
    // member arms a requirement for two others. cdkd must not paper over that
    // by re-filling `TargetType` from the previous side: the loud failure IS
    // the parity behavior, and inventing `PAUSE` would deploy a hook kind the
    // template stopped asking for.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          ...HOOK_FULL,
          LifecycleHooks: [
            {
              LifecycleStages: ['PRE_SCALE_UP'],
              TimeoutConfiguration: { TimeoutInMinutes: 41, Action: 'CONTINUE' },
            },
          ],
        },
      },
      { ...baseProps(), DeploymentConfiguration: HOOK_FULL }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      strategy: 'CANARY',
      lifecycleHooks: [
        {
          lifecycleStages: ['PRE_SCALE_UP'],
          timeoutConfiguration: { timeoutInMinutes: 41, action: 'CONTINUE' },
        },
      ],
    });
  });

  it('a SHORTENED LifecycleHooks array is forwarded verbatim — the array is replaced wholesale', async () => {
    // Measured: a 2-element list re-sent with ONE element left exactly that
    // one, so the array is replaced wholesale (the #1227 array shape) and a
    // per-element drop needs no special handling. The regression this pins is
    // a "merge the previous elements back in" normalization, which would
    // resurrect a hook the template deleted.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          ...HOOK_FULL,
          LifecycleHooks: [
            {
              TargetType: 'PAUSE',
              LifecycleStages: ['PRE_SCALE_UP'],
              TimeoutConfiguration: { TimeoutInMinutes: 51, Action: 'CONTINUE' },
            },
          ],
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          ...HOOK_FULL,
          LifecycleHooks: [
            ...(HOOK_FULL.LifecycleHooks as Array<Record<string, unknown>>),
            {
              TargetType: 'PAUSE',
              LifecycleStages: ['POST_SCALE_UP'],
              TimeoutConfiguration: { TimeoutInMinutes: 32, Action: 'CONTINUE' },
            },
          ],
        },
      }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent.lifecycleHooks).toHaveLength(1);
    expect(sent.lifecycleHooks).toEqual([
      {
        targetType: 'PAUSE',
        lifecycleStages: ['PRE_SCALE_UP'],
        timeoutConfiguration: { timeoutInMinutes: 51, action: 'CONTINUE' },
      },
    ]);
  });

  it('a partial ThresholdConfiguration inside a COMPLETE DeploymentCircuitBreaker is forwarded verbatim', async () => {
    // The FOURTH block in this property tree, and the one a depth-1 scan
    // misses: it nests under a block that DOES carry a required list, so the
    // parent's requirement is satisfied and the template reaches AWS. Measured
    // through `@aws-sdk/client-ecs` (NOT the AWS CLI, which refuses it
    // client-side off botocore's required trait and so would have answered for
    // the wrong reason): the service refuses with `Invalid deployment circuit
    // breaker threshold value.` — the #1227 disposition again.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: {
            Enable: true,
            Rollback: true,
            ThresholdConfiguration: { Type: 'BOUNDED_PERCENT' },
          },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: {
            Enable: true,
            Rollback: true,
            ThresholdConfiguration: { Type: 'BOUNDED_PERCENT', Value: 30 },
          },
        },
      }
    );

    // The previous side's `Value: 30` must NOT be merged back in.
    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: {
        enable: true,
        rollback: true,
        thresholdConfiguration: { type: 'BOUNDED_PERCENT' },
      },
    });
  });

  it('a dropped ResetOnHealthyTask is RESET to the AWS default — the fixed DIVERGENCE row (#1861)', async () => {
    // `ResetOnHealthyTask` is OPTIONAL (`DeploymentCircuitBreaker` requires
    // only [Enable, Rollback]), so dropping it from an otherwise complete block
    // is a CFn-accepted partial that reaches AWS. Measured: `UpdateService`
    // RETAINS the live value while CloudFormation RESETS it to the default —
    // cdkd used to fail to apply a removal CFn applies, the opposite polarity
    // to #1802's permissive divergence. Issue #1861 fixed that by routing the
    // member through `clearOnUpdateRemoval`.
    //
    // The DISCRIMINATOR is the payload `UpdateService` was called with: a
    // still-broken pass-through emits `{enable, rollback}` with no
    // `resetOnHealthyTask` at all, so the assertion below is written against
    // the shape the REGRESSION would emit. Note the required sibling
    // `Rollback` in the very same block reads as REPLACED, so neither row
    // generalizes to the other.
    await update(
      {
        ...baseProps(),
        // The top-level SIBLINGS are declared on purpose. Every removal
        // fixture used to send `{DeploymentCircuitBreaker: ...}` alone, which
        // let a rebuild that DROPPED the `...desired` spread pass every unit
        // test: on a real deploy that silently deletes `MaximumPercent` /
        // `MinimumHealthyPercent` / `Alarms` / `Strategy` / `LifecycleHooks`
        // from `UpdateService`, and ECS's server-side merge then keeps the old
        // values with no error anywhere. Only the integ caught it, so the
        // regression was CI-invisible and rested on a 14-day-TTL gate.
        DeploymentConfiguration: {
          MaximumPercent: 175,
          MinimumHealthyPercent: 25,
          DeploymentCircuitBreaker: { Enable: true, Rollback: false },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          MaximumPercent: 200,
          MinimumHealthyPercent: 50,
          DeploymentCircuitBreaker: { Enable: true, Rollback: true, ResetOnHealthyTask: false },
        },
      }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent).toEqual({
      maximumPercent: 175,
      minimumHealthyPercent: 25,
      deploymentCircuitBreaker: { enable: true, rollback: false, resetOnHealthyTask: true },
    });
    // The siblings must SURVIVE the rebuild — this is the `...desired` pin.
    expect(Object.keys(sent)).toEqual([
      'maximumPercent',
      'minimumHealthyPercent',
      'deploymentCircuitBreaker',
    ]);
    // This IS the arm that rebuilds the object (previous-present /
    // current-absent), so pin the KEY SET here: `toEqual` treats an explicit
    // `undefined` key as absent, and the conditional spreads exist to keep the
    // built object's keys equal to what was actually resolved. `sibling
    // untouched` matters too — `thresholdConfiguration` was never declared on
    // either side and must not appear.
    expect(Object.keys(sent.deploymentCircuitBreaker)).toEqual([
      'enable',
      'rollback',
      'resetOnHealthyTask',
    ]);
  });

  it('a WHOLE dropped ThresholdConfiguration is RESET to the AWS default — the other half of #1861', async () => {
    // The divergence row has two halves and the sibling pin above covers only
    // the scalar one. Dropping the whole `ThresholdConfiguration` BLOCK from a
    // still-declared `DeploymentCircuitBreaker` is the same shape one level
    // up: `UpdateService` retains the live `{COUNT, 7}`, CloudFormation resets
    // it to `{BOUNDED_PERCENT, 50}`. Pinning it separately matters because a
    // fix for #1861 could plausibly handle scalar members and miss a nested
    // BLOCK — the reset value is an OBJECT here, not a scalar.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: false },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: {
            Enable: true,
            Rollback: true,
            ThresholdConfiguration: { Type: 'COUNT', Value: 7 },
          },
        },
      }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent).toEqual({
      deploymentCircuitBreaker: {
        enable: true,
        rollback: false,
        thresholdConfiguration: { type: 'BOUNDED_PERCENT', value: 50 },
      },
    });
    // Key-set pin on the rebuilding arm (see the sibling above), and the
    // never-declared `resetOnHealthyTask` must NOT have been synthesized.
    expect(Object.keys(sent.deploymentCircuitBreaker)).toEqual([
      'enable',
      'rollback',
      'thresholdConfiguration',
    ]);
  });

  it('a NEVER-declared optional member is left absent even when the block itself changes (#1861)', async () => {
    // The arm that stops the removal-keyed fix from degenerating into
    // "always send the defaults". Measured (us-east-1, 2026-08-13): a template
    // that never declares `ResetOnHealthyTask` / `ThresholdConfiguration`,
    // with both set OUT OF BAND, survived a CloudFormation update that flipped
    // `Rollback` INSIDE the block — the out-of-band `false` / `{COUNT, 9}`
    // both persisted. That is also the arm that EXCLUDES the competing reading
    // "CFn re-serializes the struct whenever its declared content changed",
    // which the declared-then-removed arms fit just as well; hence the flipped
    // `Rollback` here rather than a no-op update.
    //
    // Sending the defaults here would CLOBBER a live value CloudFormation
    // deliberately preserves — a divergence in the opposite direction from the
    // one being fixed.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: false },
        },
      }
    );

    // NOTE this arm does NOT exercise the resolver's object REBUILD: both
    // members resolve to `undefined`, so it takes the identity early-return
    // and the conditional spreads never run. The key-set pin therefore lives
    // on the two REMOVAL arms above, which are the ones that build the object.
    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: { enable: true, rollback: true },
    });
  });

  it('the ROLLBACK replay direction re-declares the member instead of resetting it (#1861 / #1609)', async () => {
    // A removal-arm fix re-runs with the sides SWAPPED during a rollback
    // replay (#1609): the failed deploy's DESIRED becomes the replay's
    // PREVIOUS. Swapping the first #1861 case here means the member is
    // previous-ABSENT / current-PRESENT, which must send the DECLARED value
    // and never the default — a fix that keyed on "the sides differ" rather
    // than on previous-present / current-absent would emit `true` here and
    // silently discard the user's `false` on the way back.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: {
            Enable: true,
            Rollback: true,
            ResetOnHealthyTask: false,
            ThresholdConfiguration: { Type: 'COUNT', Value: 7 },
          },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: false },
        },
      }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: {
        enable: true,
        rollback: true,
        resetOnHealthyTask: false,
        thresholdConfiguration: { type: 'COUNT', value: 7 },
      },
    });
  });

  it('a member declared on BOTH sides is forwarded UNCHANGED — presence alone must not trigger a reset (#1861)', async () => {
    // The arm that closes a real hole: every other #1861 case is ONE-SIDED
    // (previous-only, or current-only), so a resolver keyed on
    // `previousBreaker['ResetOnHealthyTask'] !== undefined ? DEFAULT : desired`
    // — reading the PREVIOUS side alone and ignoring the desired one — passed
    // all of them. That mutation sends AWS's `true` on every deploy of a
    // template that declares `ResetOnHealthyTask: false`, silently discarding
    // the user's value: precisely the "invent a value the template never
    // declared" failure #1802 and #1861 both refuse.
    //
    // `Rollback` flips so the update is a real change rather than a no-op, and
    // `ResetOnHealthyTask: false` is held IDENTICAL across both sides — the
    // combination a one-sided key cannot distinguish from a removal.
    //
    // Its `thresholdConfiguration` twin is covered incidentally by the
    // partial-`ThresholdConfiguration` pin further up (declared on both sides,
    // must not be merged); the scalar member has no such neighbour, which is
    // why it needs its own row.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: false, ResetOnHealthyTask: false },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: true, ResetOnHealthyTask: false },
        },
      }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: { enable: true, rollback: false, resetOnHealthyTask: false },
    });
  });

  it('a member CHANGED on both sides sends the new value, not the default (#1861)', async () => {
    // The opposite polarity of the row above, and the reason it is worth its
    // own arm: there the declared value happened to EQUAL what a broken
    // resolver would keep, here it is the exact inverse of the AWS default.
    // A future `!resetOnHealthyTask` slip, or a reset keyed on "the sides
    // differ", flips this to `true` and silently inverts the user's intent.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: true, ResetOnHealthyTask: false },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: true, ResetOnHealthyTask: true },
        },
      }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: { enable: true, rollback: true, resetOnHealthyTask: false },
    });
  });

  it('the reset value is a FRESH object per call, never the shared module constant (#1861)', async () => {
    // `ECSProvider` is a singleton serving concurrent resources, so a
    // module-level default handed to the SDK BY REFERENCE would be one shared
    // mutable object across every in-flight `UpdateService`. Two updates, and
    // the first payload is mutated in between: if both calls received the same
    // object, the second one carries `value: 999`.
    const removalProps = {
      ...baseProps(),
      DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true, Rollback: false } },
    };
    const declaredPrev = {
      ...baseProps(),
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
          ThresholdConfiguration: { Type: 'COUNT', Value: 7 },
        },
      },
    };

    mockSend.mockResolvedValueOnce(updateResponse);
    await provider.update('Svc', SERVICE_ARN, TYPE, removalProps, declaredPrev);
    const first = findCommand(UpdateServiceCommand).input.deploymentConfiguration;
    (first.deploymentCircuitBreaker.thresholdConfiguration as { value: number }).value = 999;

    mockSend.mockReset();
    mockSend.mockResolvedValueOnce(updateResponse);
    await provider.update('Svc2', SERVICE_ARN, TYPE, removalProps, declaredPrev);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const second = findCommand(UpdateServiceCommand).input.deploymentConfiguration;
    expect(second.deploymentCircuitBreaker.thresholdConfiguration).toEqual({
      type: 'BOUNDED_PERCENT',
      value: 50,
    });
    expect(second.deploymentCircuitBreaker.thresholdConfiguration).not.toBe(
      first.deploymentCircuitBreaker.thresholdConfiguration
    );
    // The COPY and the FREEZE are two independent guards and the assertions
    // above only cover the copy — dropping `Object.freeze` alone left this
    // whole file green. What the freeze buys is that a future caller which
    // somehow DOES reach the shared constant fails loudly rather than
    // poisoning every later update, so assert the freeze DIRECTLY on the
    // module constant, which is exported for exactly this reason.
    expect(Object.isFrozen(CIRCUIT_BREAKER_THRESHOLD_CONFIGURATION_DEFAULT)).toBe(true);
    // And it must still hold the MEASURED default — a freeze on a wrong value
    // is a well-guarded bug.
    expect(CIRCUIT_BREAKER_THRESHOLD_CONFIGURATION_DEFAULT).toEqual({
      type: 'BOUNDED_PERCENT',
      value: 50,
    });
  });

  it('a READBACK-shaped previous bag makes the presence test mean "the bag carried it" (#1861)', async () => {
    // Pins the LIMIT of the presence test rather than a desirable behavior, so
    // the next member copied onto this pattern does not inherit the premise
    // unchecked. `clearOnUpdateRemoval` asks whether the PREVIOUS BAG carried
    // the member, which equals "the previous TEMPLATE declared it" only on the
    // deploy path. `drift --revert` (`src/cli/commands/drift.ts`, the
    // `provider.update(...)` that passes `outcome.awsProperties`) hands over an
    // AWS READBACK instead: AWS reports these members whether or not any
    // template declared them, so a desired side that omits one reads as a
    // removal here and the default is sent.
    //
    // The exposure is narrow — that path's desired bag is built from
    // `observedProperties`, which normally carries the member too, and its
    // `preserveUntemplated` arm recurses through `mergeUntemplatedValue` and
    // keeps AWS-only members — but it is real when an `observedProperties`
    // snapshot predates AWS reporting the member. It is NOT specific to this
    // resolver: it is shared by every `clearOnUpdateRemoval` call site in the
    // codebase — 78 of them across 14 provider files before this PR, 80 with
    // this resolver's two (grepped, not estimated; `asg-provider.ts` and
    // `lambda-function-provider.ts` carry 13 each) — so the fix belongs to
    // that shared contract. This arm exists so a change in the
    // behavior is a visible test edit rather than a silent one.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: false },
        },
      },
      {
        ...baseProps(),
        // An AWS readback shape: every member populated, including the two the
        // template never declared.
        DeploymentConfiguration: {
          MaximumPercent: 200,
          MinimumHealthyPercent: 100,
          DeploymentCircuitBreaker: {
            Enable: true,
            Rollback: true,
            ResetOnHealthyTask: false,
            ThresholdConfiguration: { Type: 'COUNT', Value: 9 },
          },
        },
      }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: {
        enable: true,
        rollback: false,
        resetOnHealthyTask: true,
        thresholdConfiguration: { type: 'BOUNDED_PERCENT', value: 50 },
      },
    });
  });

  it('the removal reset applies with the circuit breaker DISABLED too (#1861)', async () => {
    // Every other fixture in this file — and every phase of the integ — uses
    // `Enable: true`, so a resolver gated on `desiredBreaker.enable === true`
    // passed the whole suite AND the live test. `Enable` and the optional
    // members are independent: CloudFormation applies the removal to the
    // template's declared block whatever `Enable` says, and a disabled block
    // is a perfectly ordinary thing to deploy (it is how you turn the circuit
    // breaker off without deleting its configuration). Gating on it would
    // reinstate the divergence for exactly those users, silently.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: false, Rollback: false },
        },
      },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: {
            Enable: false,
            Rollback: true,
            ResetOnHealthyTask: false,
            ThresholdConfiguration: { Type: 'COUNT', Value: 7 },
          },
        },
      }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: {
        enable: false,
        rollback: false,
        resetOnHealthyTask: true,
        thresholdConfiguration: { type: 'BOUNDED_PERCENT', value: 50 },
      },
    });
  });

  it('a MALFORMED DeploymentCircuitBreaker is passed through untouched, never rebuilt (#1861)', async () => {
    // The guard is "is a plain object", not truthiness, and the difference is
    // observable. Every value below is TRUTHY, so a `!desiredBreaker` check
    // would send them all down the rebuild arm: `'oops'` spreads to
    // `{0:'o',1:'o',2:'p',3:'s'}` and then GAINS both synthesized defaults,
    // and an array or a number synthesizes the defaults onto an empty object.
    // No live mutation results either way — the rebuilt block carries no
    // `enable`/`rollback`, so AWS rejects the whole `UpdateService` exactly as
    // it did before this fix — but "a malformed shape falls back to the
    // pre-change pass-through" should be literally true, not nearly true.
    for (const malformed of ['oops', 42, [], ['a'], true] as unknown[]) {
      mockSend.mockReset();
      mockSend.mockResolvedValueOnce(updateResponse);
      await provider.update(
        'Svc',
        SERVICE_ARN,
        TYPE,
        {
          ...baseProps(),
          DeploymentConfiguration: { DeploymentCircuitBreaker: malformed },
        },
        {
          ...baseProps(),
          DeploymentConfiguration: {
            DeploymentCircuitBreaker: {
              Enable: true,
              Rollback: true,
              ResetOnHealthyTask: false,
              ThresholdConfiguration: { Type: 'COUNT', Value: 7 },
            },
          },
        }
      );

      const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;
      const got: unknown = sent.deploymentCircuitBreaker;
      // Exactly what the converter produced, and no synthesized member.
      expect(got).toEqual(malformed);
      expect(got).not.toHaveProperty('resetOnHealthyTask');
      expect(got).not.toHaveProperty('thresholdConfiguration');
      // The load-bearing one: the rebuild arm SPREADS, which turns a string
      // into a plain object (`{0:'o',...}`) and an array into `{}` — so the
      // discriminator is that the value's KIND survives. Asserting "no index
      // key `0`" would be wrong here, because a string legitimately has one.
      expect(typeof got).toBe(typeof malformed);
      expect(Array.isArray(got)).toBe(Array.isArray(malformed));
    }
  });

  it('a MALFORMED PREVIOUS DeploymentConfiguration yields the pass-through and does not throw (#1861)', async () => {
    // HONEST LABEL: this arm is a regression guard, NOT a mutation-pinned one,
    // and saying so is the point. The previous-side `isPlainCfnObject` guard
    // is defensive only — relaxing it to a truthiness check leaves this file
    // 36/36 green. State the reach of that claim precisely, because the
    // obvious phrasing is FALSE: an ARRAY (or a function, or a Proxy) that
    // carries a NAMED `ResetOnHealthyTask` property is truthy, is not a plain
    // object, and DOES answer the member read — measured, the shipped guard
    // emits `{enable, rollback}` there while the relaxed version emits
    // `{enable, rollback, resetOnHealthyTask: true}`. So such an input
    // discriminates the two. What is true is the narrower claim that matters:
    // no input REACHABLE FROM A JSON- OR SDK-DERIVED PREVIOUS BAG can. A
    // previous bag is `JSON.parse`d state, resolved template properties, or
    // an SDK readback, and none of those can produce an array with named
    // properties. Hence the guard stays unpinned rather than pinned by a
    // fixture no production path could build. What this DOES pin is the reachable property: a malformed
    // previous side produces the untouched pass-through rather than a throw
    // or a spurious reset.
    await update(
      {
        ...baseProps(),
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: false },
        },
      },
      { ...baseProps(), DeploymentConfiguration: 'not-an-object' }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: { enable: true, rollback: false },
    });
  });

  it('a removed member is NOT reset when the whole DeploymentCircuitBreaker block is gone (#1861)', async () => {
    // The scope boundary the measurement actually supports. Removing the WHOLE
    // `DeploymentConfiguration` resets nothing under either engine (#1805), and
    // the parent `DeploymentCircuitBreaker` disappearing while the property
    // stays declared was never measured — so the fix requires BOTH sides to
    // declare the block. Without this pin, widening the predicate to "previous
    // declared the member" alone would start synthesizing a circuit-breaker
    // block out of a template that no longer asks for one.
    await update(
      { ...baseProps(), DeploymentConfiguration: { MaximumPercent: 150 } },
      {
        ...baseProps(),
        DeploymentConfiguration: {
          MaximumPercent: 200,
          DeploymentCircuitBreaker: { Enable: true, Rollback: true, ResetOnHealthyTask: false },
        },
      }
    );

    expect(findCommand(UpdateServiceCommand).input.deploymentConfiguration).toEqual({
      maximumPercent: 150,
    });
  });

  it('the CREATE path never synthesizes the circuit-breaker defaults (#1861)', async () => {
    // The reset is an UPDATE-only removal semantic. `create()` has no previous
    // side at all, so a fix applied in the shared converter rather than in the
    // update resolver would start inventing members on first deploy.
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });

    await provider.create('Svc', TYPE, {
      ...baseProps(),
      ServiceName: 'my-service',
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(findCommand(CreateServiceCommand).input.deploymentConfiguration).toEqual({
      deploymentCircuitBreaker: { enable: true, rollback: true },
    });
  });

  it('an EMPTY nested block is forwarded verbatim — never dropped as "nothing to say"', async () => {
    // The DISCRIMINATOR that proved the AWS defaults are FIXED rather than
    // derived from the sibling member: an empty `LinearConfiguration: {}` sent
    // from a live {33, 9} came back {10, 6}, i.e. BOTH members took their
    // default. That measurement is what the parity verdict rests on, so the
    // shape has to reach AWS — a "prune the empty block" normalization would
    // silently turn it into the whole-block-omitted case, which AWS treats as
    // the OPPOSITE instruction (retain the live block, per the #1225 row).
    await update(
      { ...baseProps(), DeploymentConfiguration: { ...LINEAR_FULL, LinearConfiguration: {} } },
      { ...baseProps(), DeploymentConfiguration: LINEAR_FULL }
    );

    const sent = findCommand(UpdateServiceCommand).input.deploymentConfiguration;

    expect(sent).toEqual({
      strategy: 'LINEAR',
      bakeTimeInMinutes: 0,
      maximumPercent: 200,
      minimumHealthyPercent: 100,
      linearConfiguration: {},
    });
  });

  it('the CREATE path forwards a partial CanaryConfiguration and a partial hook TimeoutConfiguration verbatim', async () => {
    // The Linear create pin above states its rationale as "the fill site, not
    // the shared converter, is where a synthesis would be added" — which
    // applies just as much to the other two arms, so pin them rather than
    // leaving Linear as the only covered create path.
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });

    await provider.create('Svc', TYPE, {
      ...baseProps(),
      ServiceName: 'my-service',
      DeploymentConfiguration: {
        Strategy: 'CANARY',
        CanaryConfiguration: { CanaryPercent: 30 },
        LifecycleHooks: [
          {
            TargetType: 'PAUSE',
            LifecycleStages: ['PRE_SCALE_UP'],
            TimeoutConfiguration: { TimeoutInMinutes: 45 },
          },
        ],
      },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(findCommand(CreateServiceCommand).input.deploymentConfiguration).toEqual({
      strategy: 'CANARY',
      canaryConfiguration: { canaryPercent: 30 },
      lifecycleHooks: [
        {
          targetType: 'PAUSE',
          lifecycleStages: ['PRE_SCALE_UP'],
          timeoutConfiguration: { timeoutInMinutes: 45 },
        },
      ],
    });
  });

  it('DeploymentConfiguration stays drift-COMPARED, which is what makes the default-fill benign', () => {
    // The parity verdict has a load-bearing second half: the AWS-filled default
    // is not phantom drift ONLY because the deploy engine captures
    // `observedProperties` from `readCurrentState` and this block is read back
    // there, so the baseline already holds the filled value. Every other test
    // in this file inspects the SEND side, so declaring the property
    // drift-unknown later would falsify the verdict with all of them still
    // green. Pin the two conditions the claim actually rests on.
    expect(provider.getDriftUnknownPaths(TYPE)).not.toContain('DeploymentConfiguration');
  });

  it('readCurrentState round-trips the AWS-filled block into the CFn shape the baseline compares against', async () => {
    // The OTHER half of the same claim, and it needs a round-trip rather than
    // a source grep: a reverse-mapper that still WRITES the key but stops
    // re-casing it (raw SDK camelCase) keeps every send-side test green while
    // the recorded baseline becomes `linearConfiguration.stepBakeTimeInMinutes`
    // against a PascalCase state record — precisely the permanent phantom
    // drift the parity verdict rests on NOT happening.
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceArn: SERVICE_ARN,
          serviceName: 'my-service',
          status: 'ACTIVE',
          deploymentConfiguration: {
            strategy: 'LINEAR',
            // What AWS reports after the partial update: the declared member
            // plus the DEFAULT it filled in.
            linearConfiguration: { stepPercent: 44, stepBakeTimeInMinutes: 6 },
          },
        },
      ],
    });

    const observed = (await provider.readCurrentState?.(SERVICE_ARN, 'Svc', TYPE)) as
      | Record<string, unknown>
      | undefined;

    expect(observed?.['DeploymentConfiguration']).toEqual({
      Strategy: 'LINEAR',
      LinearConfiguration: { StepPercent: 44, StepBakeTimeInMinutes: 6 },
    });
  });

  it('the nested blocks this classification names are still modelled by the type', () => {
    // Fences BOTH halves the classification rests on, now that issue #1800's
    // `definitionRequired` capture makes the second one checkable offline:
    // that the members the verdict cites still EXIST, and that their
    // required-ness is still what each row assumed. The second is the one that
    // would silently invalidate the verdict — AWS ADDING a required list to
    // `LinearConfiguration` / `CanaryConfiguration` is exactly the change that
    // moves them out of "CFn accepts this partial" and into the #1802 row.
    const schema = readSchemaFixture();
    const paths = schema.nestedPropertyPaths?.['DeploymentConfiguration'] ?? [];
    const required = schema.definitionRequired ?? {};

    expect(paths).toContain('LinearConfiguration.StepPercent');
    expect(paths).toContain('LinearConfiguration.StepBakeTimeInMinutes');
    expect(paths).toContain('CanaryConfiguration.CanaryPercent');
    expect(paths).toContain('CanaryConfiguration.CanaryBakeTimeInMinutes');
    expect(paths).toContain('LifecycleHooks.LifecycleStages');
    expect(paths).toContain('LifecycleHooks.TimeoutConfiguration.Action');
    expect(paths).toContain('LifecycleHooks.TimeoutConfiguration.TimeoutInMinutes');
    // The two the issue's depth-1 scan never listed, and which produced the
    // DIVERGENCE (#1861) and the both-engines-refuse rows respectively.
    expect(paths).toContain('DeploymentCircuitBreaker.ResetOnHealthyTask');
    expect(paths).toContain('DeploymentCircuitBreaker.ThresholdConfiguration.Value');

    // A MISSING key means "nothing is required here" (issue #1800's contract),
    // which is precisely the premise of the parity rows for these two.
    expect(required['LinearConfiguration']).toBeUndefined();
    expect(required['CanaryConfiguration']).toBeUndefined();
    // The rows that turn on a required list carrying a specific member.
    expect(required['DeploymentLifecycleHook']).toEqual(['LifecycleStages']);
    expect(required['ThresholdConfiguration']).toEqual(['Type', 'Value']);
    // `ResetOnHealthyTask` is RETAINED by AWS precisely because it is NOT
    // required here, while its sibling `Rollback` is and reads as replaced —
    // the row that proves one block can hold members with different semantics,
    // and the one CFn resets on removal while cdkd does not (issue #1861).
    expect(required['DeploymentCircuitBreaker']).toEqual(['Enable', 'Rollback']);
    // The depth-3 hook row rests on this block accepting a partial, so its
    // required-ness needs pinning too — AWS adding `required: ['Action']` here
    // would move that row into the permissive-divergence class silently.
    expect(required['HookTimeoutConfig']).toBeUndefined();
    // NOTE the reach of this fence: the fixture is a CHECKED-IN capture, so it
    // trips on the next `refresh-cfn-schemas` regen rather than the day AWS
    // changes the schema. It is a tripwire, not a monitor. (For THIS type the
    // "missing key = nothing required" reading is a fact rather than an
    // assumption: the schema contains no `oneOf`/`anyOf`/`allOf`, so issue
    // #1800's uncaptured-combinator bound cannot apply.)
  });
});
