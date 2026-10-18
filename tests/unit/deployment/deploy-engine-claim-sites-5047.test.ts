import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { redactOperationsForJournal } from '../../../src/deployment/deploy-engine/rollback.js';
import { redactOutputs } from '../../../src/deployment/deploy-engine/masking.js';
import { redactRollbackRecord } from '../../../src/deployment/rollback-executor/replay-secrets.js';
import {
  markSameGenerationBag,
  recordResolvedPair,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// go-to-k/cdkd#5047: the engine-side writers that state a producer mark as the
// walk's same-generation claim. Each case pairs the marked bag with an
// UNMARKED one, so a site that claimed whatever the bag (a mutant hard-wiring
// `'same-generation'`) fabricates the token onto a bag this pass never
// produced, and one that dropped the claim leaves the plaintext.

const EXPR = '{{resolve:secretsmanager:short:SecretString:k}}';
const PLAINTEXT = 'q7';
const SOURCE_LEAF = `https://host/${EXPR}/path`;
const RESOLVED_LEAF = `https://host/${PLAINTEXT}/path`;
// A record whose own `properties` spell the leaf as an intrinsic frame (what
// `cdkd import` persists): under the readback rules that is the shape the
// generation claim decides, through the frame arm.
const FRAMED_SOURCE = { 'Fn::Join': ['', ['p:', EXPR]] };
const FRAMED_RESOLVED = `p:${PLAINTEXT}`;
const FRAMED_PERSISTED = `p:${EXPR}`;

function pass(): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map([[PLAINTEXT, EXPR]]);
  recordResolvedPair(secrets, EXPR, PLAINTEXT);
  return secrets;
}

function makeBareEngine(): DeployEngine {
  return new DeployEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dryRun: false },
    'us-east-1'
  );
}

describe('engine writers state the mark as the claim, in both directions (#5047)', () => {
  it("the journal's completed-op `properties`: a marked bag holds the token, an unmarked one its plaintext", () => {
    const journal = (marked: boolean): unknown => {
      const engine = makeBareEngine();
      const run = (engine as unknown as { secretsRun: { perResourceSecrets: Map<string, RecordedSecretValues>; perResourceTemplateProps: Map<string, Record<string, unknown>> } }).secretsRun;
      run.perResourceSecrets.set('Fn', pass());
      run.perResourceTemplateProps.set('Fn', { Url: SOURCE_LEAF });
      const properties = { Url: RESOLVED_LEAF };
      const [op] = redactOperationsForJournal(engine.rollbackDeps(), [
        {
          logicalId: 'Fn',
          resourceType: 'AWS::Lambda::Function',
          changeType: 'CREATE',
          properties: marked ? markSameGenerationBag(properties) : properties,
        } as never,
      ]) as Array<{ properties: unknown }>;
      return op!.properties;
    };
    expect(journal(true)).toEqual({ Url: SOURCE_LEAF });
    expect(journal(false)).toEqual({ Url: RESOLVED_LEAF });
  });

  it('`redactOutputs`: the bag this pass resolved (marked) holds the token, a previous deploy bag its plaintext', () => {
    const outputs = (marked: boolean): unknown => {
      const engine = makeBareEngine();
      const run = (engine as unknown as { outputsRun: { outputSecrets: RecordedSecretValues; outputsTemplateSource: Record<string, unknown> } }).outputsRun;
      run.outputSecrets = pass();
      run.outputsTemplateSource['Out'] = SOURCE_LEAF;
      const bag: Record<string, unknown> = { Out: RESOLVED_LEAF };
      return redactOutputs(engine.maskingDeps(), marked ? markSameGenerationBag(bag) : bag);
    };
    expect(outputs(true)).toEqual({ Out: SOURCE_LEAF });
    expect(outputs(false)).toEqual({ Out: RESOLVED_LEAF });
  });

  it("the journal's `previousState` readback: a marked bag holds the token, an unmarked one its plaintext", () => {
    const journal = (marked: boolean): unknown => {
      const engine = makeBareEngine();
      const run = (engine as unknown as { secretsRun: { perResourceSecrets: Map<string, RecordedSecretValues> } }).secretsRun;
      run.perResourceSecrets.set('Fn', pass());
      const observed = { Url: FRAMED_RESOLVED };
      const [op] = redactOperationsForJournal(engine.rollbackDeps(), [
        {
          logicalId: 'Fn',
          resourceType: 'AWS::Lambda::Function',
          changeType: 'UPDATE',
          previousState: {
            physicalId: 'fn',
            resourceType: 'AWS::Lambda::Function',
            properties: { Url: FRAMED_SOURCE },
            observedProperties: marked ? markSameGenerationBag(observed) : observed,
          },
        } as never,
      ]) as Array<{ previousState: { observedProperties: unknown } }>;
      return op!.previousState.observedProperties;
    };
    expect(journal(true)).toEqual({ Url: FRAMED_PERSISTED });
    expect(journal(false)).toEqual({ Url: FRAMED_RESOLVED });
  });

  it('`redactRollbackRecord` (the replay restore): a marked readback holds the token, an unmarked one its plaintext', () => {
    const restore = (marked: boolean): unknown => {
      const observed = { Url: FRAMED_RESOLVED };
      return redactRollbackRecord(
        {
          physicalId: 'fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Url: FRAMED_SOURCE },
          observedProperties: marked ? markSameGenerationBag(observed) : observed,
        } as never,
        pass()
      ).observedProperties;
    };
    expect(restore(true)).toEqual({ Url: FRAMED_PERSISTED });
    expect(restore(false)).toEqual({ Url: FRAMED_RESOLVED });
  });

  it('the orphan save (`redactStateForPersist`): marked bags hold the token, unmarked ones their plaintext', () => {
    const persist = (marked: boolean): { properties: unknown; observedProperties: unknown } => {
      const engine = makeBareEngine();
      const run = (
        engine as unknown as {
          secretsRun: {
            perResourceSecrets: Map<string, RecordedSecretValues>;
            perResourceTemplateProps: Map<string, Record<string, unknown>>;
            perResourceResolvedType: Map<string, string>;
          };
        }
      ).secretsRun;
      run.perResourceSecrets.set('Fn', pass());
      run.perResourceTemplateProps.set('Fn', { Url: SOURCE_LEAF });
      run.perResourceResolvedType.set('Fn', 'AWS::Lambda::Function');
      const properties = { Url: RESOLVED_LEAF };
      const observed = { Url: RESOLVED_LEAF };
      const persisted = (
        engine as unknown as {
          redactStateForPersist(state: unknown): {
            orphans: Array<{ state: { properties: unknown; observedProperties: unknown } }>;
          };
        }
      ).redactStateForPersist({
        version: 12,
        stackName: 'S',
        resources: {},
        outputs: {},
        orphans: [
          {
            logicalId: 'Fn',
            orphanedAt: 0,
            state: {
              physicalId: 'fn',
              resourceType: 'AWS::Lambda::Function',
              properties: marked ? markSameGenerationBag(properties) : properties,
              observedProperties: marked ? markSameGenerationBag(observed) : observed,
            },
          },
        ],
      });
      return persisted.orphans[0]!.state;
    };
    expect(persist(true)).toMatchObject({
      properties: { Url: SOURCE_LEAF },
      observedProperties: { Url: SOURCE_LEAF },
    });
    expect(persist(false)).toMatchObject({
      properties: { Url: RESOLVED_LEAF },
      observedProperties: { Url: RESOLVED_LEAF },
    });
  });
});
