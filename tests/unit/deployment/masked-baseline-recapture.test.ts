import { describe, it, expect } from 'vite-plus/test';
import {
  isMaskedBaselineRecaptureCandidate,
  recaptureMaskedBaseline,
  resolveRecordSecrets,
  secretReferenceTokensOf,
} from '../../../src/deployment/masked-baseline-recapture.js';
import {
  redactSecretsForState,
  scrubResourceRecord,
  STATE_SOURCED_BASELINE_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * Issue #3595 item (1): the deploy-start re-capture of an observed baseline
 * holding a #2852 fail-closed mask. The shape is the `secrets-array-nested`
 * integ's anchor arm: `EntryPoint` holds two bare references behind an
 * identical `-p`, so the empty-map walk cannot tell them apart and masks both.
 */
const ALPHA = '{{resolve:secretsmanager:s:SecretString:ambigAlpha}}';
const BRAVO = '{{resolve:secretsmanager:s:SecretString:ambigBravo}}';
const ANCHOR = '{{resolve:secretsmanager:s:SecretString:anchorPw}}';
const ALPHA_PT = 'alpha-plaintext-742';
const BRAVO_PT = 'bravo-plaintext-743';
const BRAVO_ROTATED_PT = 'bravo-rotated-plaintext-999';
const ANCHOR_PT = 'anchor-plaintext-741';

const properties = (): Record<string, unknown> => ({
  Family: 'fam',
  ContainerDefinitions: [
    {
      Name: 'anchorprobe',
      Command: ['-c', ANCHOR, '-v'],
      EntryPoint: ['-p', ALPHA, '-p', BRAVO],
    },
  ],
});

const readback = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  Family: 'fam',
  ContainerDefinitions: [
    {
      Name: 'anchorprobe',
      Command: ['-c', ANCHOR_PT, '-v'],
      EntryPoint: ['-p', ALPHA_PT, '-p', BRAVO_PT],
      ...overrides,
    },
  ],
  Tags: [],
});

/** What an ordinary empty-map capture persisted: the baseline under repair. */
const ordinaryBaseline = (bag: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(redactSecretsForState(bag, new Map(), properties(), STATE_SOURCED_BASELINE_RULES))
  ) as Record<string, unknown>;

const secretsOf = (pairs: Array<[string, string]>): RecordedSecretValues => new Map(pairs);

const entryPointOf = (bag: Record<string, unknown> | undefined): unknown =>
  (bag?.['ContainerDefinitions'] as Array<Record<string, unknown>>)[0]!['EntryPoint'];

describe('masked-baseline re-capture (issue #3595)', () => {
  it('the fixture premise: the ordinary capture masks both indistinguishable positions', () => {
    expect(entryPointOf(ordinaryBaseline(readback()))).toEqual(['-p', '***', '-p', '***']);
  });

  describe('recaptureMaskedBaseline', () => {
    it('unmasks a position the resolved map certifies and keeps a rotated one masked', () => {
      const previous = ordinaryBaseline(readback());
      const result = recaptureMaskedBaseline({
        previous,
        readback: readback(),
        properties: properties(),
        // BRAVO rotated since the task definition was registered: the map holds
        // TODAY's value, the readback still holds yesterday's.
        secrets: secretsOf([
          [ALPHA_PT, ALPHA],
          [BRAVO_ROTATED_PT, BRAVO],
          [ANCHOR_PT, ANCHOR],
        ]),
      });
      expect(entryPointOf(result)).toEqual(['-p', ALPHA, '-p', '***']);
      const text = JSON.stringify(result);
      for (const plaintext of [ALPHA_PT, BRAVO_PT, BRAVO_ROTATED_PT, ANCHOR_PT]) {
        expect(text).not.toContain(plaintext);
      }
    });

    it('unmasks every position when the whole map certifies them', () => {
      const result = recaptureMaskedBaseline({
        previous: ordinaryBaseline(readback()),
        readback: readback(),
        properties: properties(),
        secrets: secretsOf([
          [ALPHA_PT, ALPHA],
          [BRAVO_PT, BRAVO],
        ]),
      });
      expect(entryPointOf(result)).toEqual(['-p', ALPHA, '-p', BRAVO]);
    });

    it('changes ONLY masked positions: everything else stays byte-identical to the previous baseline', () => {
      // An observed-only key the source does not carry keeps whatever the
      // previous baseline held (the #2868 residual row), even though the
      // populated map would have redacted it: this re-capture repairs masks,
      // it does not re-scrub the baseline.
      const bag = readback({ Extra: 'untouched-literal' });
      const previous = ordinaryBaseline(bag);
      const result = recaptureMaskedBaseline({
        previous,
        readback: bag,
        properties: properties(),
        secrets: secretsOf([[ALPHA_PT, ALPHA]]),
      });
      const expected = JSON.parse(JSON.stringify(previous)) as Record<string, unknown>;
      (entryPointOf(expected) as unknown[])[1] = ALPHA;
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
    });

    it('refuses when the fresh readback no longer reproduces the baseline (no drift is absorbed)', () => {
      const previous = ordinaryBaseline(readback());
      const drifted = readback({ Command: ['-c', ANCHOR_PT, '--changed'] });
      expect(
        recaptureMaskedBaseline({
          previous,
          readback: drifted,
          properties: properties(),
          secrets: secretsOf([[ALPHA_PT, ALPHA]]),
        })
      ).toBeUndefined();
    });

    it('makes progress over an earlier re-capture: a secret rotated back clears the last mask', () => {
      // The baseline an earlier deploy left: [1] re-captured, [3] still masked
      // because BRAVO had been rotated. The ordinary capture masks BOTH, and
      // [1]'s expression in the baseline must still count as reproduced.
      const previous = ordinaryBaseline(readback());
      (entryPointOf(previous) as unknown[])[1] = ALPHA;
      const result = recaptureMaskedBaseline({
        previous,
        readback: readback(),
        properties: properties(),
        secrets: secretsOf([
          [ALPHA_PT, ALPHA],
          [BRAVO_PT, BRAVO],
        ]),
      });
      expect(entryPointOf(result)).toEqual(['-p', ALPHA, '-p', BRAVO]);
    });

    it('does not count a baseline value the record does not spell as reproduced at a masked position', () => {
      // A plaintext (or any other value) where the ordinary capture masks is
      // not a baseline this module wrote: refused, not repaired.
      const previous = ordinaryBaseline(readback());
      (entryPointOf(previous) as unknown[])[1] = 'something-else';
      expect(
        recaptureMaskedBaseline({
          previous,
          readback: readback(),
          properties: properties(),
          secrets: secretsOf([
            [ALPHA_PT, ALPHA],
            [BRAVO_PT, BRAVO],
          ]),
        })
      ).toBeUndefined();
    });

    it('refuses a baseline list longer than the readback reports', () => {
      // The longer list is NOT the masked one, so only the reproduction check
      // can refuse: the masked EntryPoint would otherwise be certified.
      const previous = ordinaryBaseline(readback());
      const container = (previous['ContainerDefinitions'] as Array<Record<string, unknown>>)[0]!;
      (container['Command'] as unknown[]).push('--extra');
      expect(
        recaptureMaskedBaseline({
          previous,
          readback: readback(),
          properties: properties(),
          secrets: secretsOf([[ALPHA_PT, ALPHA]]),
        })
      ).toBeUndefined();
    });

    it('refuses a baseline with a key the readback no longer reports', () => {
      const previous = { ...ordinaryBaseline(readback()), Gone: 'x' };
      expect(
        recaptureMaskedBaseline({
          previous,
          readback: readback(),
          properties: properties(),
          secrets: secretsOf([[ALPHA_PT, ALPHA]]),
        })
      ).toBeUndefined();
    });

    it('refuses when no masked position can be certified', () => {
      expect(
        recaptureMaskedBaseline({
          previous: ordinaryBaseline(readback()),
          readback: readback(),
          properties: properties(),
          secrets: secretsOf([['some-other-value', ALPHA]]),
        })
      ).toBeUndefined();
    });

    it('refuses on an empty map', () => {
      expect(
        recaptureMaskedBaseline({
          previous: ordinaryBaseline(readback()),
          readback: readback(),
          properties: properties(),
          secrets: new Map(),
        })
      ).toBeUndefined();
    });

    it('never writes an expression the record does not spell, whatever the map says', () => {
      // A map whose expression is not one of the record's references: the
      // value scan writes it, and the overlay must refuse to take it.
      const foreign = '{{resolve:secretsmanager:elsewhere:SecretString:k}}';
      expect(
        recaptureMaskedBaseline({
          previous: ordinaryBaseline(readback()),
          readback: readback(),
          properties: properties(),
          secrets: secretsOf([[ALPHA_PT, foreign]]),
        })
      ).toBeUndefined();
    });

    it('takes a MIXED leaf only as the record spells it', () => {
      const mixed = `--password=${ALPHA}`;
      const props = { Args: [mixed, `--b=${BRAVO}`] };
      // Reordered, so the unkeyed list cannot pair and both leaves fail closed.
      const bag = { Args: [`--b=${BRAVO_PT}`, `--password=${ALPHA_PT}`] };
      const previous = JSON.parse(
        JSON.stringify(redactSecretsForState(bag, new Map(), props, STATE_SOURCED_BASELINE_RULES))
      ) as Record<string, unknown>;
      expect(previous['Args']).toEqual(['***', '***']);
      const result = recaptureMaskedBaseline({
        previous,
        readback: bag,
        properties: props,
        secrets: secretsOf([
          [ALPHA_PT, ALPHA],
          [BRAVO_PT, BRAVO],
        ]),
      });
      expect(result?.['Args']).toEqual([`--b=${BRAVO}`, mixed]);
    });

    it('reads a readback Date as its persisted ISO string when comparing', () => {
      const when = new Date('2026-09-25T00:00:00.000Z');
      const bag = { ...readback(), RegisteredAt: when };
      const result = recaptureMaskedBaseline({
        previous: ordinaryBaseline(bag),
        readback: bag,
        properties: properties(),
        secrets: secretsOf([[ALPHA_PT, ALPHA]]),
      });
      expect(result?.['RegisteredAt']).toBe(when.toISOString());
      expect(entryPointOf(result)).toEqual(['-p', ALPHA, '-p', '***']);
    });

    it('survives the persist choke point unchanged', () => {
      const result = recaptureMaskedBaseline({
        previous: ordinaryBaseline(readback()),
        readback: readback(),
        properties: properties(),
        secrets: secretsOf([[ALPHA_PT, ALPHA]]),
      })!;
      const record = {
        physicalId: 'p',
        resourceType: 'AWS::ECS::TaskDefinition',
        properties: properties(),
        observedProperties: result,
      };
      // What `redactStateForPersist` does for an UNCHANGED resource: no map, no
      // template bag, and the re-capture installs the bag unmarked.
      const persisted = scrubResourceRecord(record, new Map(), undefined);
      expect(JSON.parse(JSON.stringify(persisted.observedProperties))).toEqual(
        JSON.parse(JSON.stringify(result))
      );
    });
  });

  describe('resolveRecordSecrets', () => {
    const resolveInto =
      (values: Record<string, string>) =>
      async (token: string, own: RecordedSecretValues): Promise<string> => {
        const plaintext = values[token];
        if (plaintext === undefined) throw new Error('not found');
        own.set(plaintext, token);
        return plaintext;
      };

    it('resolves every distinct token of the record', async () => {
      const secrets = await resolveRecordSecrets(
        properties(),
        resolveInto({ [ALPHA]: ALPHA_PT, [BRAVO]: BRAVO_PT, [ANCHOR]: ANCHOR_PT })
      );
      expect(secrets).toEqual(
        secretsOf([
          [ANCHOR_PT, ANCHOR],
          [ALPHA_PT, ALPHA],
          [BRAVO_PT, BRAVO],
        ])
      );
    });

    it('is all-or-nothing: one failing reference refuses the record', async () => {
      await expect(
        resolveRecordSecrets(properties(), resolveInto({ [ALPHA]: ALPHA_PT, [ANCHOR]: ANCHOR_PT }))
      ).resolves.toBeUndefined();
    });

    it('refuses two references resolving to one plaintext', async () => {
      await expect(
        resolveRecordSecrets(
          properties(),
          resolveInto({ [ALPHA]: 'same', [BRAVO]: 'same', [ANCHOR]: ANCHOR_PT })
        )
      ).resolves.toBeUndefined();
    });

    it('keeps a reference that records nothing (a public parameter) out of the map', async () => {
      const secrets = await resolveRecordSecrets({ A: ALPHA, B: '{{resolve:ssm:/public}}' }, async (token, own) => {
        if (token === ALPHA) own.set(ALPHA_PT, ALPHA);
        return 'x';
      });
      expect(secrets).toEqual(secretsOf([[ALPHA_PT, ALPHA]]));
    });
  });

  describe('isMaskedBaselineRecaptureCandidate', () => {
    const record = (over: Partial<ResourceState> = {}): ResourceState => ({
      physicalId: 'p',
      resourceType: 'AWS::ECS::TaskDefinition',
      properties: properties(),
      observedProperties: ordinaryBaseline(readback()),
      ...over,
    });

    it('takes a masked baseline over properties that spell a reference', () => {
      expect(isMaskedBaselineRecaptureCandidate(record())).toBe(true);
    });

    it('leaves a baseline with no mask alone', () => {
      expect(
        isMaskedBaselineRecaptureCandidate(record({ observedProperties: { Family: 'fam' } }))
      ).toBe(false);
    });

    it('leaves a record without a baseline to the missing-baseline arm', () => {
      const { observedProperties: _omit, ...rest } = record();
      expect(isMaskedBaselineRecaptureCandidate(rest)).toBe(false);
    });

    it('leaves a NoEcho record (a mask in properties) alone', () => {
      expect(
        isMaskedBaselineRecaptureCandidate(
          record({ properties: { ...properties(), Password: '***' } })
        )
      ).toBe(false);
    });

    it('leaves a record whose properties spell no reference alone', () => {
      expect(isMaskedBaselineRecaptureCandidate(record({ properties: { Family: 'fam' } }))).toBe(
        false
      );
    });

    it('leaves a record whose only reference names a service cdkd does not resolve alone', () => {
      expect(
        isMaskedBaselineRecaptureCandidate(
          record({ properties: { Family: 'fam', X: '{{resolve:unknownsvc:thing}}' } })
        )
      ).toBe(false);
    });

    it('leaves an import-refused record alone', () => {
      expect(isMaskedBaselineRecaptureCandidate(record({ observedBaselineRefused: true }))).toBe(
        false
      );
    });
  });

  it('secretReferenceTokensOf collects each resolvable token once, from whole and mixed leaves', () => {
    expect(
      secretReferenceTokensOf({
        a: [ALPHA, `x${ALPHA}y${BRAVO}`],
        b: { c: 'plain', d: '{{resolve:unknownsvc:thing}}' },
        e: '{{resolve:ssm-secure:/p}} {{resolve:ssm:/q}}',
      })
    ).toEqual([ALPHA, BRAVO, '{{resolve:ssm-secure:/p}}', '{{resolve:ssm:/q}}']);
  });
});
