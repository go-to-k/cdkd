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
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';

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
 * requires only `LifecycleStages`, so CFn ACCEPTS a partial there and the SDK
 * side is unmeasured (they are reachable only under `Strategy: BLUE_GREEN`,
 * which the ROLLING probe could not exercise). Tracked as issue #1806.
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

  const update = (
    props: Record<string, unknown>,
    prev: Record<string, unknown>
  ): Promise<unknown> => {
    mockSend.mockResolvedValueOnce(updateResponse);
    return provider.update('Svc', SERVICE_ARN, TYPE, props, prev);
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
    // from a template CloudFormation accepts — which is strictly worse than
    // #1802, where CFn at least refuses. Asserting their ABSENCE states the
    // SCOPE of the depth-2 parity verdict rather than over-claiming it, and
    // means the day AWS adds a required list to one of them, #1806 shrinks
    // visibly instead of silently. The third, `DeploymentLifecycleHook`, does
    // carry one — but only `LifecycleStages`, leaving its other five members
    // droppable, which is why it is in #1806's scope too.
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
