import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { redactOperationsForJournal } from '../../../src/deployment/deploy-engine/rollback.js';
import { redactOutputs } from '../../../src/deployment/deploy-engine/masking.js';
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
});
