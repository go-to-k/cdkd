/**
 * A READBACK-ONLY `Definition` NO LONGER CARRIES A RESOLVED
 * `DefinitionSubstitutions` SECRET INTO `observedProperties` — issue
 * [#5315](https://github.com/go-to-k/cdkd/issues/5315).
 *
 * A Step Functions record holds its definition as `DefinitionString` (or
 * `Definition`, or `DefinitionS3Location`) with `${name}` placeholders, plus a
 * `DefinitionSubstitutions` map whose value can be a secure dynamic reference.
 * `readCurrentState` surfaces only `Definition`: the body AWS stores, with the
 * substitutions APPLIED. With an EMPTY secrets map nothing pairs the
 * substituted plaintext with its expression — the readback carries no
 * `DefinitionSubstitutions`, so no position is certified and no derived needle
 * is learned — and the walk handed `Definition` on verbatim.
 *
 * The cases run in the two configurations the issue names: `cdkd state
 * refresh-observed` (`redactForState` at `state-baseline` with an empty map) and
 * the deploy-start auto-refresh, which reaches the persist choke point
 * `scrubResourceRecord` with an empty map and a same-generation observed bag.
 * Each asserts BOTH polarities: no plaintext anywhere in the persisted record,
 * and the leaves the record itself spells (state names, a NON-secret
 * substitution) still there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  scrubResourceRecord,
  redactForState,
  clearRecordedSecretExpressions,
  SECRET_MASK,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:app/api:SecretString:key}}';
const SSM_EXPR = '{{resolve:ssm-secure:/app/token}}';
const PLAIN = 'sk-live-the-resolved-api-key-value';
const SSM_PLAIN = 'the-resolved-ssm-secure-token';
const REGION = 'us-east-1';

/** The definition with `${...}` placeholders, as the record's `properties` spell it. */
const templateDefinition = {
  Comment: 'calls the api',
  StartAt: 'Wait',
  States: {
    Wait: {
      Type: 'Pass',
      Result: { key: '${apiKey}', region: '${region}', auth: 'Bearer ${apiKey}' },
      End: true,
    },
  },
};

/** What `DescribeStateMachine` returns once AWS (or cdkd, #5298) applied the map. */
const substitutedDefinition = (): Record<string, unknown> => ({
  Comment: 'calls the api',
  StartAt: 'Wait',
  States: {
    Wait: {
      Type: 'Pass',
      Result: { key: PLAIN, region: REGION, auth: `Bearer ${PLAIN}` },
      End: true,
    },
  },
});

const properties = (definition: Record<string, unknown>): Record<string, unknown> => ({
  RoleArn: 'arn:aws:iam::123456789012:role/sfn',
  ...definition,
  DefinitionSubstitutions: { apiKey: EXPR, region: REGION },
});

const observed = (): Record<string, unknown> => ({
  StateMachineName: 'my-machine',
  RoleArn: 'arn:aws:iam::123456789012:role/sfn',
  Definition: substitutedDefinition(),
});

/** `cdkd state refresh-observed` (state.ts): an explicit `state-baseline` with no secrets. */
const refreshObserved = (
  props: Record<string, unknown>,
  bag: Record<string, unknown>
): Record<string, unknown> =>
  redactForState(bag, {
    provenance: 'state-baseline',
    secrets: new Map<string, string>(),
    source: props,
  }) as Record<string, unknown>;

/**
 * The deploy-start auto-refresh, at the persist choke point: an UNCHANGED
 * resource has no secrets map and no template bag, and the drained readback
 * carries the same-generation claim.
 */
const autoRefresh = (
  props: Record<string, unknown>,
  bag: Record<string, unknown>
): Record<string, unknown> =>
  scrubResourceRecord(
    { properties: props, observedProperties: bag },
    new Map<string, string>(),
    undefined,
    undefined,
    { observed: 'same-generation' }
  ) as Record<string, unknown>;

const CALLERS = [
  ['cdkd state refresh-observed', (p: Record<string, unknown>, b: Record<string, unknown>) =>
    ({ observedProperties: refreshObserved(p, b) }) as Record<string, unknown>],
  ['deploy-start auto-refresh (scrubResourceRecord)', autoRefresh],
] as const;

const resultOf = (persisted: Record<string, unknown>): Record<string, unknown> => {
  const def = (persisted['observedProperties'] as Record<string, unknown>)['Definition'] as Record<
    string,
    unknown
  >;
  return ((def['States'] as Record<string, unknown>)['Wait'] as Record<string, unknown>)[
    'Result'
  ] as Record<string, unknown>;
};

describe('secret-redaction - a substituted Definition on the empty-map readback path (issue #5315)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  describe.each(CALLERS)('%s', (_name, persist) => {
    it('the issue probe: DefinitionString source, substituted Definition readback', () => {
      const persisted = persist(
        properties({ DefinitionString: JSON.stringify(templateDefinition) }),
        observed()
      );
      const text = JSON.stringify(persisted);
      expect(text).not.toContain(PLAIN);
      const result = resultOf(persisted);
      expect(result['key']).toBe(SECRET_MASK);
      // EMBEDDED in a larger leaf: masked whole, not left as `Bearer <plaintext>`.
      expect(result['auth']).toBe(SECRET_MASK);
      // The other polarity: a NON-secret substitution and every leaf the record
      // spells survive, so the baseline is not emptied.
      expect(result['region']).toBe(REGION);
      const def = (persisted['observedProperties'] as Record<string, unknown>)['Definition'];
      expect(def).toMatchObject({
        Comment: 'calls the api',
        StartAt: 'Wait',
        States: { Wait: { Type: 'Pass', End: true } },
      });
      expect((persisted['observedProperties'] as Record<string, unknown>)['StateMachineName']).toBe(
        'my-machine'
      );
    });

    it('an object-form Definition source (the placeholder is not a reference)', () => {
      const persisted = persist(properties({ Definition: templateDefinition }), observed());
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      expect(resultOf(persisted)['region']).toBe(REGION);
      expect(resultOf(persisted)['key']).toBe(SECRET_MASK);
    });

    it('a DefinitionS3Location source: no body in the record, the substituted leaf is still masked', () => {
      const persisted = persist(
        properties({ DefinitionS3Location: { Bucket: 'b', Key: 'k.json' } }),
        observed()
      );
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      // A whole leaf equal to a NON-secret substitution value is spelled by the
      // record, so it is kept even with no body to render.
      expect(resultOf(persisted)['region']).toBe(REGION);
    });

    it('an ssm-secure substitution, and a Definition read back as an unparsed STRING', () => {
      const props = {
        DefinitionString: '{"StartAt":"A","States":{"A":{"Type":"Pass","Result":"${t}","End":true}}}',
        DefinitionSubstitutions: { t: SSM_EXPR },
      };
      const bag = {
        Definition: `{"StartAt":"A","States":{"A":{"Type":"Pass","Result":"${SSM_PLAIN}","End":true}}`,
      };
      const persisted = persist(props, bag);
      expect(JSON.stringify(persisted)).not.toContain(SSM_PLAIN);
    });

    it('a readback key spelled DefinitionString is refused too', () => {
      const persisted = persist(
        properties({ DefinitionString: JSON.stringify(templateDefinition) }),
        { DefinitionString: JSON.stringify(substitutedDefinition()) }
      );
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
    });

    it('leaves a Definition alone when no substitution carries a reference', () => {
      const props = {
        DefinitionString: JSON.stringify(templateDefinition),
        DefinitionSubstitutions: { apiKey: 'not-a-secret', region: REGION },
      };
      const bag = { Definition: { StartAt: 'Wait', States: { Wait: { Result: { key: 'drifted' } } } } };
      const persisted = persist(props, bag);
      expect((persisted['observedProperties'] as Record<string, unknown>)['Definition']).toEqual(
        bag.Definition
      );
    });

    it('keeps an UNSUBSTITUTED readback, which still spells the placeholder', () => {
      // The inline shape before #5298: AWS stores the body verbatim.
      const props = properties({ DefinitionString: JSON.stringify(templateDefinition) });
      const persisted = persist(props, { Definition: structuredClone(templateDefinition) });
      expect((persisted['observedProperties'] as Record<string, unknown>)['Definition']).toEqual(
        templateDefinition
      );
    });

    it('is IDEMPOTENT over its own output', () => {
      const props = properties({ DefinitionString: JSON.stringify(templateDefinition) });
      const once = persist(props, observed());
      const twice = persist(props, once['observedProperties'] as Record<string, unknown>);
      expect(twice['observedProperties']).toEqual(once['observedProperties']);
    });
  });
});
