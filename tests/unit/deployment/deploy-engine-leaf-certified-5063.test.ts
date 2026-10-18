import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { redactOperationsForJournal } from '../../../src/deployment/deploy-engine/rollback.js';
import { propertiesToRecord } from '../../../src/deployment/deploy-engine/record-shape.js';
import {
  isLeafCertifiedBag,
  isSameGenerationBag,
  markLeafCertifiedBag,
  markSameGenerationBag,
  recordResolvedPair,
  redactionClaimOf,
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

// go-to-k/cdkd#5063: a provider's `effectiveProperties` bag is LEAF-CERTIFIED,
// a redaction-only mark, distinct from the same-generation mark the v12
// reference-provenance rule reads.

const EXPR = '{{resolve:secretsmanager:short:SecretString:k}}';
const PLAINTEXT = 'q7';
const SOURCE_LEAF = `https://host/${EXPR}/path`;
const RESOLVED_LEAF = `https://host/${PLAINTEXT}/path`;

function pass(): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map([[PLAINTEXT, EXPR]]);
  recordResolvedPair(secrets, EXPR, PLAINTEXT);
  return secrets;
}

describe('propertiesToRecord marks a provider bag leaf-certified, never same-generation', () => {
  const desired = { Url: RESOLVED_LEAF, Tags: [{ Key: 'k', Value: 'v' }] };

  it('the desired bag: same-generation', () => {
    const recorded = propertiesToRecord({ ...desired }, {}, 'AWS::Kinesis::Stream', 'sdk');
    expect(isSameGenerationBag(recorded)).toBe(true);
  });

  it('an effectiveProperties bag: leaf-certified only (the provenance rule is unchanged)', () => {
    for (const route of ['sdk', 'cc-api'] as const) {
      const recorded = propertiesToRecord(
        { ...desired },
        { effectiveProperties: { ...desired, DesiredShardLevelMetrics: ['A'] } },
        'AWS::Kinesis::Stream',
        route
      );
      expect({ route, leaf: isLeafCertifiedBag(recorded) }).toEqual({ route, leaf: true });
      expect({ route, gen: isSameGenerationBag(recorded) }).toEqual({ route, gen: false });
      expect(redactionClaimOf(recorded)).toBe('same-generation');
    }
  });

  it('redactionClaimOf: either mark claims, neither does not', () => {
    expect(redactionClaimOf(markLeafCertifiedBag({}))).toBe('same-generation');
    expect(redactionClaimOf(markSameGenerationBag({}))).toBe('same-generation');
    expect(redactionClaimOf({})).toBe('unproven');
    expect(redactionClaimOf(undefined)).toBe('unproven');
  });
});

describe("the journal's completed-op `properties` states the leaf-certified claim", () => {
  it('a leaf-certified bag holds the token, an unmarked one its plaintext', () => {
    const journal = (marked: boolean): unknown => {
      const engine = new DeployEngine(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { dryRun: false },
        'us-east-1'
      );
      const run = (
        engine as unknown as {
          secretsRun: {
            perResourceSecrets: Map<string, RecordedSecretValues>;
            perResourceTemplateProps: Map<string, Record<string, unknown>>;
          };
        }
      ).secretsRun;
      run.perResourceSecrets.set('Fn', pass());
      run.perResourceTemplateProps.set('Fn', { Url: SOURCE_LEAF });
      const properties = { Url: RESOLVED_LEAF };
      const [op] = redactOperationsForJournal(engine.rollbackDeps(), [
        {
          logicalId: 'Fn',
          resourceType: 'AWS::Kinesis::Stream',
          changeType: 'CREATE',
          properties: marked ? markLeafCertifiedBag(properties) : properties,
        } as never,
      ]) as Array<{ properties: unknown }>;
      return op!.properties;
    };
    expect(journal(true)).toEqual({ Url: SOURCE_LEAF });
    expect(journal(false)).toEqual({ Url: RESOLVED_LEAF });
  });
});
