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

    it('a DefinitionS3Location source: no body in the record, the WHOLE Definition is masked', () => {
      // No body spells any KEY, and a key can hold the secret (#5333), so the
      // whole value is `***` rather than leaf by leaf.
      const persisted = persist(
        properties({ DefinitionS3Location: { Bucket: 'b', Key: 'k.json' } }),
        observed()
      );
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      expect((persisted['observedProperties'] as Record<string, unknown>)['Definition']).toBe(
        SECRET_MASK
      );
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

    it('a reference INSIDE the DefinitionString body, with no substitution map', () => {
      // CDK's `Fn::Join` around a secret value: the record's body embeds the
      // expression, the readback embeds the plaintext.
      const props = {
        DefinitionString: JSON.stringify(templateDefinition)
          .replaceAll('${apiKey}', EXPR)
          .replaceAll('${region}', REGION),
      };
      const persisted = persist(props, observed());
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      expect(resultOf(persisted)['region']).toBe(REGION);
      expect(resultOf(persisted)['key']).toBe(SECRET_MASK);
    });

    it('a position the walk CERTIFIES keeps its expression rather than a mask', () => {
      // An object-form body holding the reference as a WHOLE leaf pairs by
      // position, so the arm must not take that certified row back.
      const props = {
        Definition: { StartAt: 'A', States: { A: { Type: 'Pass', Result: EXPR, End: true } } },
        DefinitionSubstitutions: { region: REGION },
      };
      const bag = {
        Definition: { StartAt: 'A', States: { A: { Type: 'Pass', Result: PLAIN, End: true } } },
      };
      const persisted = persist(props, bag);
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      expect((persisted['observedProperties'] as Record<string, unknown>)['Definition']).toEqual(
        props.Definition
      );
    });

    it('certified positions win where no derived needle can decide (two MIXED leaves, one value)', () => {
      // Both references resolve to the SAME plaintext, so a value needle is
      // ambiguous; only the POSITION walk can name each leaf's expression.
      const OTHER = '{{resolve:secretsmanager:app/other:SecretString:key}}';
      const props = {
        Definition: { StartAt: 'A', States: { A: { Type: 'Pass', Result: { a: `a-${EXPR}`, b: `b-${OTHER}` } } } },
        Note: `n-${OTHER}`,
        DefinitionSubstitutions: { region: REGION },
      };
      const bag = {
        Definition: { StartAt: 'A', States: { A: { Type: 'Pass', Result: { a: `a-${PLAIN}`, b: `b-${PLAIN}` } } } },
        Note: `n-${PLAIN}`,
      };
      const persisted = persist(props, bag);
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      expect((persisted['observedProperties'] as Record<string, unknown>)['Definition']).toEqual(
        props.Definition
      );
    });

    it('a DERIVED needle elsewhere in the record does not un-mask the substituted secret', () => {
      // A whole-token leaf certifies P1 -> EXPR, so the derived scan runs and the
      // MARK tree decides which positions it may fill: the substituted second
      // secret must read back as refused there, not as undecided.
      const P2 = 'plain-two-value-abc';
      const OTHER = '{{resolve:secretsmanager:app/other:SecretString:key}}';
      const props = {
        Definition: { StartAt: 'A', States: { A: { Type: 'Pass', Result: { x: EXPR, y: '${s}', z: 'pre-${s}' } } } },
        DefinitionSubstitutions: { s: OTHER },
      };
      const bag = {
        Definition: { StartAt: 'A', States: { A: { Type: 'Pass', Result: { x: PLAIN, y: P2, z: `pre-${P2}` } } } },
      };
      const persisted = persist(props, bag);
      const text = JSON.stringify(persisted);
      expect(text).not.toContain(P2);
      expect(text).not.toContain(PLAIN);
    });

    it('a NoEcho substitution value persisted as *** (no reference anywhere in the record)', () => {
      const props = {
        DefinitionString: JSON.stringify(templateDefinition),
        DefinitionSubstitutions: { apiKey: SECRET_MASK, region: REGION },
      };
      const persisted = persist(props, observed());
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      expect(resultOf(persisted)['region']).toBe(REGION);
    });

    it('a NoEcho body flattened whole to ***', () => {
      const persisted = persist(
        { DefinitionString: SECRET_MASK, DefinitionSubstitutions: { region: REGION } },
        observed()
      );
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
    });

    it('a secret substituted at a NUMERIC position is masked; spelled numbers and booleans are kept', () => {
      // An L1 `definitionString` placing `${pin}` outside quotes: AWS reads the
      // digits back as a JSON number.
      const PIN = 987654321;
      const props = {
        DefinitionString:
          '{"StartAt":"W","States":{"W":{"Type":"Wait","Seconds":${pin},"Next":"P"},' +
          '"P":{"Type":"Pass","Result":{"retries":3,"wait":${wait},"on":true},"End":true}}}',
        DefinitionSubstitutions: { pin: EXPR, wait: '45' },
      };
      const bag = {
        Definition: {
          StartAt: 'W',
          States: {
            W: { Type: 'Wait', Seconds: PIN, Next: 'P' },
            P: { Type: 'Pass', Result: { retries: 3, wait: 45, on: true }, End: true },
          },
        },
      };
      const persisted = persist(props, bag);
      expect(JSON.stringify(persisted)).not.toContain(String(PIN));
      const def = (persisted['observedProperties'] as Record<string, unknown>)[
        'Definition'
      ] as Record<string, Record<string, Record<string, unknown>>>;
      expect(def['States']!['W']!['Seconds']).toBe(SECRET_MASK);
      // The body parses in neither plain spelling (`${pin}` sits outside
      // quotes), but its SENTINEL reading does (#5333), so the numbers and
      // booleans it spells, and the non-secret substitution, are kept.
      expect(def['States']!['P']!['Result']).toEqual({ retries: 3, wait: 45, on: true });
    });

    it('keeps the numbers and booleans a PARSEABLE body spells', () => {
      const props = {
        DefinitionString: JSON.stringify({
          StartAt: 'W',
          States: { W: { Type: 'Wait', Seconds: 10, Result: '${apiKey}', End: true } },
        }),
        DefinitionSubstitutions: { apiKey: EXPR },
      };
      const bag = {
        Definition: {
          StartAt: 'W',
          States: { W: { Type: 'Wait', Seconds: 10, Result: PLAIN, End: true } },
        },
      };
      const persisted = persist(props, bag);
      expect(JSON.stringify(persisted)).not.toContain(PLAIN);
      const w = (
        (persisted['observedProperties'] as Record<string, Record<string, Record<string, unknown>>>)[
          'Definition'
        ]!['States'] as Record<string, Record<string, unknown>>
      )['W']!;
      expect(w['Seconds']).toBe(10);
      expect(w['End']).toBe(true);
      expect(w['Result']).toBe(SECRET_MASK);
    });

    it('is IDEMPOTENT over its own output', () => {
      const props = properties({ DefinitionString: JSON.stringify(templateDefinition) });
      const once = persist(props, observed());
      const twice = persist(props, once['observedProperties'] as Record<string, unknown>);
      expect(twice['observedProperties']).toEqual(once['observedProperties']);
    });
  });

  it('a POPULATED-map baseline keeps the expressions the value scan wrote, embedded ones too', () => {
    // `cdkd drift`'s baseline writers and the masked-baseline re-capture declare
    // `state-baseline` with a map: the scan has already rewritten the leaves, and
    // the refusal must not mask a correctly redacted `Bearer {{resolve:...}}`.
    const persisted = redactForState(observed(), {
      provenance: 'state-baseline',
      secrets: new Map<string, string>([[PLAIN, EXPR]]),
      source: properties({ DefinitionString: JSON.stringify(templateDefinition) }),
    }) as Record<string, unknown>;
    const result = resultOf({ observedProperties: persisted });
    expect(JSON.stringify(persisted)).not.toContain(PLAIN);
    expect(result['key']).toBe(EXPR);
    expect(result['auth']).toBe(`Bearer ${EXPR}`);
    expect(result['region']).toBe(REGION);
  });

  it('a readback-rules caller that does not fail closed is unchanged by this arm', () => {
    // An UNMARKED bag at the persist choke point is a previous generation being
    // re-written (issue #2906): the arm must not reach it.
    const bag = observed();
    const persisted = scrubResourceRecord(
      {
        properties: properties({ DefinitionString: JSON.stringify(templateDefinition) }),
        observedProperties: bag,
      },
      new Map<string, string>()
    );
    expect(resultOf(persisted as Record<string, unknown>)['region']).toBe(REGION);
    expect(resultOf(persisted as Record<string, unknown>)['key']).not.toBe(SECRET_MASK);
  });

  it('the DEPLOY persist with a POPULATED map masks a numeric substituted secret too', () => {
    // `deploy-engine.ts`'s persist call for the resource that resolved the
    // secret this deploy: its own map, the template bag, both claims. That
    // path is not fail-closed, so the value scan alone must name the number.
    const PIN = '987654321';
    const template = {
      DefinitionString: '{"StartAt":"W","States":{"W":{"Type":"Wait","Seconds":${pin},"End":true}}}',
      DefinitionSubstitutions: { pin: EXPR },
    };
    const persisted = scrubResourceRecord(
      {
        properties: { ...template, DefinitionSubstitutions: { pin: PIN } },
        observedProperties: {
          Definition: { StartAt: 'W', States: { W: { Type: 'Wait', Seconds: Number(PIN), End: true } } },
        },
      },
      new Map<string, string>([[PIN, EXPR]]),
      template,
      undefined,
      { properties: 'same-generation', observed: 'same-generation' }
    );
    expect(JSON.stringify(persisted)).not.toContain(PIN);
    const w = (
      (persisted.observedProperties as unknown as Record<string, Record<string, Record<string, unknown>>>)[
        'Definition'
      ]!['States'] as Record<string, Record<string, unknown>>
    )['W']!;
    expect(w['Seconds']).toBe(SECRET_MASK);
    // The other polarity: a number and a boolean no needle names are kept.
    expect(w['End']).toBe(true);
  });

  it('masks a numeric secret AWS re-spells (1.50 read back as 1.5) on the deploy persist', () => {
    const template = {
      DefinitionString: '{"StartAt":"W","States":{"W":{"Type":"Wait","Seconds":${s},"End":true}}}',
      DefinitionSubstitutions: { s: EXPR },
    };
    const persisted = scrubResourceRecord(
      {
        properties: { ...template, DefinitionSubstitutions: { s: '1.50' } },
        observedProperties: {
          Definition: { StartAt: 'W', States: { W: { Type: 'Wait', Seconds: 1.5, End: true } } },
        },
      },
      new Map<string, string>([['1.50', EXPR]]),
      template,
      undefined,
      { properties: 'same-generation', observed: 'same-generation' }
    );
    expect(JSON.stringify(persisted.observedProperties)).not.toContain('1.5');
    expect(JSON.stringify(persisted.observedProperties)).toContain(SECRET_MASK);
  });

  it('names no number OUTSIDE a rendered definition, even one equal to a secret', () => {
    // `Port: 5432` is a value the template spells as a number; rewriting it to
    // the expression would put a string in `properties` the diff then reports.
    const template = { Port: 5432, Password: EXPR, DefinitionSubstitutions: { pw: EXPR } };
    const persisted = scrubResourceRecord(
      {
        properties: { Port: 5432, Password: '5432', DefinitionSubstitutions: { pw: '5432' } },
        observedProperties: { Port: 5432, Definition: { Seconds: 5432 } },
      },
      new Map<string, string>([['5432', EXPR]]),
      template,
      undefined,
      { properties: 'same-generation', observed: 'same-generation' }
    );
    expect(persisted.properties['Port']).toBe(5432);
    expect((persisted.observedProperties as Record<string, unknown>)['Port']).toBe(5432);
    expect((persisted.observedProperties as Record<string, unknown>)['Definition']).toEqual({
      Seconds: SECRET_MASK,
    });
  });
});
