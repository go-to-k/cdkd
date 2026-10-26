/**
 * A Step Functions `DefinitionSubstitutions` secret placed in a JSON KEY, and
 * the NARROWED numeric naming — issue
 * [#5333](https://github.com/go-to-k/cdkd/issues/5333).
 *
 * A `${name}` can sit in a key (a state name) or outside quotes (a number).
 * No redaction walk reads object KEYS, so a key holding the resolved secret
 * reached `observedProperties` in plaintext. The maintainer's decision: when
 * any key of the read-back definition is one the record does not spell, the
 * WHOLE definition is persisted as `***`, which `cdkd drift` classifies as an
 * uncertified baseline (#5327's path).
 *
 * The numeric half narrows #5327's rewrite: only the position the record's
 * body places a secret `${name}` OUTSIDE quotes is rewritten, not every number
 * or boolean that happens to equal the secret.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  scrubResourceRecord,
  redactForState,
  clearRecordedSecretExpressions,
  SECRET_MASK,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:app/api:SecretString:key}}';
const PLAIN = 'sk-live-the-resolved-state-name-secret';

/** A state NAMED by the secret: the key and the `StartAt` both carry it. */
const keyedBody = '{"StartAt":"${k}","States":{"${k}":{"Type":"Pass","Result":"ok","End":true}}}';
const keyedReadback = (): Record<string, unknown> => ({
  Definition: { StartAt: PLAIN, States: { [PLAIN]: { Type: 'Pass', Result: 'ok', End: true } } },
});

const refreshObserved = (
  props: Record<string, unknown>,
  bag: Record<string, unknown>
): Record<string, unknown> =>
  redactForState(bag, {
    provenance: 'state-baseline',
    secrets: new Map<string, string>(),
    source: props,
  }) as Record<string, unknown>;

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
  ).observedProperties as Record<string, unknown>;

/** The deploy's own persist of the resource that resolved the secret. */
const deployPersist = (
  template: Record<string, unknown>,
  resolved: Record<string, unknown>,
  bag: Record<string, unknown>,
  secrets: Map<string, string>
): Record<string, unknown> =>
  scrubResourceRecord(
    { properties: resolved, observedProperties: bag },
    secrets,
    template,
    undefined,
    { properties: 'same-generation', observed: 'same-generation' }
  ).observedProperties as Record<string, unknown>;

const CALLERS = [
  ['cdkd state refresh-observed', refreshObserved],
  ['deploy-start auto-refresh (scrubResourceRecord)', autoRefresh],
] as const;

describe('secret-redaction - a substitution secret in a definition KEY (issue #5333)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  describe.each(CALLERS)('%s', (_name, persist) => {
    it('masks the WHOLE Definition when a key is one the record does not spell', () => {
      const out = persist(
        { DefinitionString: keyedBody, DefinitionSubstitutions: { k: EXPR } },
        keyedReadback()
      );
      expect(JSON.stringify(out)).not.toContain(PLAIN);
      expect(out['Definition']).toBe(SECRET_MASK);
    });

    it('keeps the Definition shape when every key is spelled (secret only in a value)', () => {
      const out = persist(
        {
          DefinitionString: '{"StartAt":"A","States":{"A":{"Type":"Pass","Result":"${k}","End":true}}}',
          DefinitionSubstitutions: { k: EXPR },
        },
        { Definition: { StartAt: 'A', States: { A: { Type: 'Pass', Result: PLAIN, End: true } } } }
      );
      expect(JSON.stringify(out)).not.toContain(PLAIN);
      expect(out['Definition']).toEqual({
        StartAt: 'A',
        States: { A: { Type: 'Pass', Result: SECRET_MASK, End: true } },
      });
    });

    it('keeps the numbers and booleans a body with an OUT-OF-QUOTES secret spells', () => {
      // Before #5333 such a body parsed in neither spelling, so every number of
      // the readback was masked; rendered with sentinels it parses.
      const out = persist(
        {
          DefinitionString:
            '{"StartAt":"W","States":{"W":{"Type":"Wait","Seconds":${pin},"Next":"P"},' +
            '"P":{"Type":"Pass","Result":{"retries":3,"on":true},"End":true}}}',
          DefinitionSubstitutions: { pin: EXPR },
        },
        {
          Definition: {
            StartAt: 'W',
            States: {
              W: { Type: 'Wait', Seconds: 987654321, Next: 'P' },
              P: { Type: 'Pass', Result: { retries: 3, on: true }, End: true },
            },
          },
        }
      );
      expect(JSON.stringify(out)).not.toContain('987654321');
      expect(out['Definition']).toEqual({
        StartAt: 'W',
        States: {
          W: { Type: 'Wait', Seconds: SECRET_MASK, Next: 'P' },
          P: { Type: 'Pass', Result: { retries: 3, on: true }, End: true },
        },
      });
    });
  });

  it('the DEPLOY persist (populated map) masks the whole Definition for a key secret', () => {
    const template = { DefinitionString: keyedBody, DefinitionSubstitutions: { k: EXPR } };
    const out = deployPersist(
      template,
      { DefinitionString: keyedBody, DefinitionSubstitutions: { k: PLAIN } },
      keyedReadback(),
      new Map([[PLAIN, EXPR]])
    );
    expect(JSON.stringify(out)).not.toContain(PLAIN);
    expect(out['Definition']).toBe(SECRET_MASK);
  });

  it('the DEPLOY persist names ONLY the out-of-quotes secret position, not an equal literal', () => {
    // A secret `3` and a secret `true`, beside a literal `Seconds: 3` and
    // `End: true` the template spells: only the substituted positions change.
    const body =
      '{"StartAt":"W","States":{"W":{"Type":"Wait","Seconds":3,"Next":"X"},' +
      '"X":{"Type":"Wait","Seconds":${pin},"Next":"P"},' +
      '"P":{"Type":"Pass","Result":{"flag":${on}},"End":true}}}';
    const ON_EXPR = '{{resolve:secretsmanager:app/flag:SecretString:on}}';
    const template = { DefinitionString: body, DefinitionSubstitutions: { pin: EXPR, on: ON_EXPR } };
    const out = deployPersist(
      template,
      { DefinitionString: body, DefinitionSubstitutions: { pin: '3', on: 'true' } },
      {
        Definition: {
          StartAt: 'W',
          States: {
            W: { Type: 'Wait', Seconds: 3, Next: 'X' },
            X: { Type: 'Wait', Seconds: 3, Next: 'P' },
            P: { Type: 'Pass', Result: { flag: true }, End: true },
          },
        },
      },
      new Map([
        ['3', EXPR],
        ['true', ON_EXPR],
      ])
    );
    expect(out['Definition']).toEqual({
      StartAt: 'W',
      States: {
        W: { Type: 'Wait', Seconds: 3, Next: 'X' },
        X: { Type: 'Wait', Seconds: EXPR, Next: 'P' },
        P: { Type: 'Pass', Result: { flag: ON_EXPR }, End: true },
      },
    });
  });

  it('a body no sentinel reading parses falls back to naming every equal number (#5327 rule)', () => {
    // `1${q}` glues a placeholder to a digit, so the body parses in no
    // spelling; the out-of-quotes `${pin}` must still not reach state.
    const body =
      '{"StartAt":"W","States":{"W":{"Type":"Wait","Seconds":${pin},"Next":"X"},' +
      '"X":{"Type":"Pass","Result":1${q},"End":true}}}';
    const Q = '{{resolve:secretsmanager:app/q:SecretString:q}}';
    const template = { DefinitionString: body, DefinitionSubstitutions: { pin: EXPR, q: Q } };
    const out = deployPersist(
      template,
      { DefinitionString: body, DefinitionSubstitutions: { pin: '987654321', q: '5' } },
      {
        Definition: {
          StartAt: 'W',
          States: {
            W: { Type: 'Wait', Seconds: 987654321, Next: 'X' },
            X: { Type: 'Pass', Result: 15, End: true },
          },
        },
      },
      new Map([
        ['987654321', EXPR],
        ['5', Q],
      ])
    );
    expect(JSON.stringify(out)).not.toContain('987654321');
  });

  it('a JSON-document secret placed outside quotes reads back as a container: whole ***', () => {
    const body = '{"StartAt":"P","States":{"P":{"Type":"Pass","Result":${doc},"End":true}}}';
    const doc = '{"user":"u","pw":"pw-the-document-secret"}';
    const template = { DefinitionString: body, DefinitionSubstitutions: { doc: EXPR } };
    const out = deployPersist(
      template,
      { DefinitionString: body, DefinitionSubstitutions: { doc } },
      {
        Definition: {
          StartAt: 'P',
          States: { P: { Type: 'Pass', Result: { user: 'u', pw: 'pw-the-document-secret' }, End: true } },
        },
      },
      new Map([[doc, EXPR]])
    );
    expect(JSON.stringify(out)).not.toContain('pw-the-document-secret');
    expect(out['Definition']).toBe(SECRET_MASK);
  });

  it('a secret that SPLICES array elements misaligns the list: whole ***, never an index rewrite', () => {
    const body = '{"StartAt":"P","States":{"P":{"Type":"Pass","Result":[${n},7],"End":true}}}';
    const template = { DefinitionString: body, DefinitionSubstitutions: { n: EXPR } };
    const out = deployPersist(
      template,
      { DefinitionString: body, DefinitionSubstitutions: { n: '41, 42' } },
      {
        Definition: {
          StartAt: 'P',
          States: { P: { Type: 'Pass', Result: [41, 42, 7], End: true } },
        },
      },
      new Map([['41, 42', EXPR]])
    );
    expect(out['Definition']).toBe(SECRET_MASK);
  });

  it('a SHORT secret inside a key is caught by the body, not the map (no needle floor)', () => {
    const body = '{"StartAt":"state-${s}","States":{"state-${s}":{"Type":"Pass","End":true}}}';
    const template = { DefinitionString: body, DefinitionSubstitutions: { s: EXPR } };
    const out = deployPersist(
      template,
      { DefinitionString: body, DefinitionSubstitutions: { s: 'zq' } },
      { Definition: { StartAt: 'state-zq', States: { 'state-zq': { Type: 'Pass', End: true } } } },
      new Map([['zq', EXPR]])
    );
    expect(JSON.stringify(out)).not.toContain('state-zq');
    expect(out['Definition']).toBe(SECRET_MASK);
  });

  it('the whole *** survives the derived-needle merge on the empty-map path', () => {
    // A certified whole-token sibling makes the derived scan run; the merge
    // must keep the refusal at the container position.
    const OTHER = '{{resolve:secretsmanager:app/other:SecretString:x}}';
    for (const persist of [refreshObserved, autoRefresh]) {
      const out = persist(
        { Note: OTHER, DefinitionString: keyedBody, DefinitionSubstitutions: { k: EXPR } },
        { Note: PLAIN, ...keyedReadback() }
      );
      expect(JSON.stringify(out)).not.toContain(PLAIN);
      expect(out['Definition']).toBe(SECRET_MASK);
      expect(out['Note']).toBe(OTHER);
    }
  });
});
