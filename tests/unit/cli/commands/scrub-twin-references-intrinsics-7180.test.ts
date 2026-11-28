/**
 * go-to-k/cdkd#7180: the #7154 twin pass corroborates a list element whose
 * template leaf is an intrinsic (`Fn::GetAtt`, `Ref`) by the value this run's
 * resolve pass resolved it to, and only when that resolution is CERTAIN.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { redactForState, type RecordedSecretValues } from '../../../../src/deployment/secret-redaction.js';
import { recordResolvedPair } from '../../../../src/deployment/secret-redaction/pairs.js';
import { positionTwinReferences } from '../../../../src/cli/commands/scrub/twin-references.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const PLAIN = 'tw1n-7180-pl4intext';

vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...child, setLevel: vi.fn(), child: () => child }) };
});
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: vi.fn(() => Promise.resolve({ Parameter: { Value: PLAIN, Type: 'SecureString' } })) },
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const OWN = '{{resolve:ssm-secure:/app/own}}';
const TWIN = '{{resolve:ssm-secure:/app/twin}}';
const ARN_A = 'arn:aws:sqs:us-east-1:123456789012:queue-a-7180';
const ARN_B = 'arn:aws:sqs:us-east-1:123456789012:queue-b-7180';
const GET_A = { 'Fn::GetAtt': ['QueueA', 'Arn'] };
const GET_B = { 'Fn::GetAtt': ['QueueB', 'Arn'] };

/** The pass map as the resolver leaves it: TWIN recorded last, so it holds the slot. */
function passSecrets(): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  secrets.set(PLAIN, OWN);
  recordResolvedPair(secrets, OWN, PLAIN);
  secrets.set(PLAIN, TWIN);
  recordResolvedPair(secrets, TWIN, PLAIN);
  return secrets;
}

function positionedOf(stored: Record<string, unknown>, template: Record<string, unknown>, secrets: RecordedSecretValues): unknown {
  return redactForState(stored, { provenance: 'template-sourced', secrets, source: template, generation: 'unproven' });
}

describe('scrub twin references across intrinsics (go-to-k/cdkd#7180)', () => {
  const template = { Targets: [{ Arn: GET_A, Id: 'T', Input: OWN }], Description: TWIN };
  const stored = { Targets: [{ Arn: ARN_A, Id: 'T', Input: PLAIN }], Description: PLAIN };
  const resolved = { Targets: [{ Arn: ARN_A, Id: 'T', Input: PLAIN }], Description: PLAIN };

  it('pairs an element whose Fn::GetAtt resolves to the stored leaf', () => {
    const secrets = passSecrets();
    const positioned = positionedOf(stored, template, secrets);
    // Without a resolution (the pre-#7180 behaviour) the element never pairs.
    expect(positionTwinReferences(stored, positioned, template, secrets)).toBe(positioned);
    const out = positionTwinReferences(stored, positioned, template, secrets, resolved);
    expect(out).toEqual({ Targets: [{ Arn: ARN_A, Id: 'T', Input: OWN }], Description: TWIN });
    expect(JSON.stringify(out)).not.toContain(PLAIN);
  });

  it('pairs an element whose Ref resolves to the stored physical id', () => {
    const secrets = passSecrets();
    const t = { L: [{ Queue: { Ref: 'QueueA' }, V: OWN }] };
    const s = { L: [{ Queue: 'queue-a-7180', V: PLAIN }] };
    const positioned = positionedOf(s, t, secrets);
    const out = positionTwinReferences(s, positioned, t, secrets, { L: [{ Queue: 'queue-a-7180', V: PLAIN }] });
    expect(out).toEqual({ L: [{ Queue: 'queue-a-7180', V: OWN }] });
  });

  it('never pairs a reordered list whose elements differ only by their GetAtt', () => {
    const secrets = passSecrets();
    const t = { Targets: [{ Arn: GET_A, Input: OWN }, { Arn: GET_B, Input: TWIN }] };
    const s = { Targets: [{ Arn: ARN_B, Input: PLAIN }, { Arn: ARN_A, Input: PLAIN }] };
    const r = { Targets: [{ Arn: ARN_A, Input: PLAIN }, { Arn: ARN_B, Input: PLAIN }] };
    const positioned = positionedOf(s, t, secrets);
    expect(positionTwinReferences(s, positioned, t, secrets, r)).toBe(positioned);
  });

  it('keeps today’s leaf when the resolution is missing or uncertain', () => {
    const secrets = passSecrets();
    const positioned = positionedOf(stored, template, secrets);
    const element = (arn: unknown): Record<string, unknown> => ({ Targets: [{ Arn: arn, Id: 'T', Input: PLAIN }], Description: PLAIN });
    const cases: Array<[string, unknown]> = [
      // The unit was abandoned (an attribute missing from state): no counterpart.
      ['no resolved bag', undefined],
      ['no resolved property', { Description: PLAIN }],
      // A key the resolver abandoned keeps the intrinsic itself.
      ['unresolved GetAtt', element(GET_A)],
      // An `Fn::If` dropped an element: indices no longer align.
      ['resolved list shorter', { Targets: [], Description: PLAIN }],
      ['AWS::NoValue', element(Symbol('AWS::NoValue'))],
    ];
    for (const [name, r] of cases) {
      expect(positionTwinReferences(stored, positioned, template, secrets, r), name).toBe(positioned);
    }
  });

  it('never pairs on a masked or secret-bearing attribute, even when the stored leaf equals it', () => {
    const secrets = passSecrets();
    const cases: Array<[string, string]> = [
      ['masked attribute', '***'],
      ['masked id segment', 'arn:aws:sqs:us-east-1:123456789012:****7180'],
      ['dynamic reference', TWIN],
      ['recorded plaintext', `arn:${PLAIN}`],
    ];
    for (const [name, arn] of cases) {
      const s = { Targets: [{ Arn: arn, Id: 'T', Input: PLAIN }], Description: PLAIN };
      const r = { Targets: [{ Arn: arn, Id: 'T', Input: PLAIN }], Description: PLAIN };
      const positioned = positionedOf(s, template, secrets);
      const out = positionTwinReferences(s, positioned, template, secrets, r);
      expect(out, name).toBe(positioned);
    }
  });

  it('still refuses a mismatched literal next to a resolved intrinsic', () => {
    const secrets = passSecrets();
    const s = { Targets: [{ Arn: ARN_A, Id: 'other', Input: PLAIN }], Description: PLAIN };
    const positioned = positionedOf(s, template, secrets);
    expect(positionTwinReferences(s, positioned, template, secrets, resolved)).toBe(positioned);
  });

  /** One `cdkd scrub` over an EventBridge rule targeting a queue by `Fn::GetAtt`. */
  async function scrubRule(queueAttributes: Record<string, unknown>, twinFirst: boolean): Promise<StackState> {
    const targets = [{ Arn: GET_A, Id: 'T', Input: OWN }];
    const properties = twinFirst ? { Description: TWIN, Targets: targets } : { Targets: targets, Description: TWIN };
    const tpl = {
      Resources: {
        QueueA: { Type: 'AWS::SQS::Queue', Properties: {} },
        Rule: { Type: 'AWS::Events::Rule', Properties: properties, DependsOn: [] },
      },
      Outputs: {},
    } as unknown as CloudFormationTemplate;
    const ruleStored = { Targets: [{ Arn: ARN_A, Id: 'T', Input: PLAIN }], Description: PLAIN };
    const state = {
      version: 11,
      region: 'us-east-1',
      stackName: 'S',
      resources: {
        QueueA: {
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-a-7180',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: queueAttributes,
          dependencies: [],
        },
        Rule: {
          physicalId: 'rule-7180',
          resourceType: 'AWS::Events::Rule',
          properties: ruleStored,
          observedProperties: structuredClone(ruleStored),
          attributes: {},
          dependencies: ['QueueA'],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const saveState = vi.fn().mockResolvedValue('etag-2');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await scrubStack(
      { stackName: 'S', template: tpl } as never,
      'us-east-1',
      {
        getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
        saveState,
        purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
        listStacks: vi.fn().mockResolvedValue([]),
      } as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(undefined), releaseLock: vi.fn().mockResolvedValue(undefined) } as never,
      { dryRun: false, logger } as never
    );
    const saved = saveState.mock.calls.at(-1)?.[2] as StackState | undefined;
    expect(saved).toBeDefined();
    // No plaintext anywhere, nor in a single line the run logged.
    expect(JSON.stringify(saved)).not.toContain(PLAIN);
    expect(JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(PLAIN);
    return saved!;
  }

  it.each([
    ['the twin first', true],
    ['the twin last', false],
  ])('cdkd scrub writes a GetAtt-targeted element its own expression, %s', async (_name, twinFirst) => {
    const saved = await scrubRule({ Arn: ARN_A }, twinFirst);
    expect(saved.resources.Rule!.properties).toEqual({
      Targets: [{ Arn: ARN_A, Id: 'T', Input: OWN }],
      Description: TWIN,
    });
  });

  it.each([
    ['a masked attribute', { Arn: '***' }],
    ['a different attribute value', { Arn: ARN_B }],
  ])('cdkd scrub keeps the element masked as before on %s', async (_name, attributes) => {
    const saved = await scrubRule(attributes, false);
    const target = (saved.resources.Rule!.properties as { Targets: Array<Record<string, unknown>> }).Targets[0]!;
    // Today's leaf: masked, on the expression holding the map slot, not OWN.
    expect(target['Input']).not.toBe(OWN);
    expect(target['Arn']).toBe(ARN_A);
  });
});
