import { describe, expect, it } from 'vite-plus/test';
import {
  markSameGenerationBag,
  recordResolvedPair,
  redactForState,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// go-to-k/cdkd#5047: the walk takes the same-generation claim as an argument
// and never reads `markSameGenerationBag`'s mark. Each writer that still holds
// a producer-marked bag states the claim itself; every case here pairs a
// claimed walk with its unclaimed twin, so dropping the claim at a site turns
// the token back into the plaintext a sub-floor middle keeps without it.

const EXPR = '{{resolve:secretsmanager:short:SecretString:k}}';
const PLAINTEXT = 'q7';
const SOURCE_LEAF = `https://host/${EXPR}/path`;
const RESOLVED_LEAF = `https://host/${PLAINTEXT}/path`;

function pass(): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map([[PLAINTEXT, EXPR]]);
  recordResolvedPair(secrets, EXPR, PLAINTEXT);
  return secrets;
}

describe('the same-generation claim at each writer that holds a marked bag (#5047)', () => {
  it('premise: below the needle floor, an unclaimed walk keeps the plaintext', () => {
    const out = redactForState(
      { Url: RESOLVED_LEAF },
      { provenance: 'template-derived', secrets: pass(), source: { Url: SOURCE_LEAF }, generation: 'unproven' }
    );
    expect(out).toEqual({ Url: RESOLVED_LEAF });
  });

  it('the walk never reads the mark: a marked bag under an unproven context keeps the plaintext', () => {
    const out = redactForState(markSameGenerationBag({ Url: RESOLVED_LEAF }), {
      provenance: 'template-derived',
      secrets: pass(),
      source: { Url: SOURCE_LEAF },
      generation: 'unproven',
    });
    expect(out).toEqual({ Url: RESOLVED_LEAF });
  });

  it('template-sourced (the deploy outputs bag): the claim writes the token, its absence keeps the plaintext', () => {
    const at = (generation: 'same-generation' | 'unproven'): unknown =>
      redactForState(
        { Out: RESOLVED_LEAF },
        { provenance: 'template-sourced', secrets: pass(), source: { Out: SOURCE_LEAF }, generation }
      );
    expect(at('same-generation')).toEqual({ Out: SOURCE_LEAF });
    expect(at('unproven')).toEqual({ Out: RESOLVED_LEAF });
  });

  describe('scrubResourceRecord states the mark the deploy engine put on the record', () => {
    it('`properties` (propertiesToRecord): marked writes the token, unmarked keeps the plaintext', () => {
      const scrub = (marked: boolean): unknown => {
        const properties = { Url: RESOLVED_LEAF };
        return scrubResourceRecord(
          { properties: marked ? markSameGenerationBag(properties) : properties },
          pass(),
          { Url: SOURCE_LEAF }
        ).properties;
      };
      expect(scrub(true)).toEqual({ Url: SOURCE_LEAF });
      expect(scrub(false)).toEqual({ Url: RESOLVED_LEAF });
    });

    it('`observedProperties` (drainObservedCaptures), against the template: marked writes the token, unmarked keeps the plaintext', () => {
      const scrub = (marked: boolean): unknown => {
        const observed = { Url: RESOLVED_LEAF };
        return scrubResourceRecord(
          {
            properties: { Url: RESOLVED_LEAF },
            observedProperties: marked ? markSameGenerationBag(observed) : observed,
          },
          pass(),
          { Url: SOURCE_LEAF }
        ).observedProperties;
      };
      expect(scrub(true)).toEqual({ Url: SOURCE_LEAF });
      expect(scrub(false)).toEqual({ Url: RESOLVED_LEAF });
    });
  });
});
