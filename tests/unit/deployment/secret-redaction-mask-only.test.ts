import { describe, it, expect } from 'vite-plus/test';
import {
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  carriesFreshNoEchoValue,
  carriesSecretMask,
  carryFreshNoEchoMark,
  embedsFreshNoEchoValue,
  freshNoEchoLeafPositions,
  recordFreshNoEchoValuesIn,
  clearRecoverableMaskedOutputs,
  maskSecretsInText,
  mergeResolvedPairs,
  recordDerivedMaskOnlyValue,
  recordMaskOnlyValue,
  recordMaskOnlyValuesIn,
  recordRecoverableMaskedOutput,
  recoverMaskedOutput,
  redactSecretsForState,
  scrubResourceRecord,
  wholeStringLeavesOf,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Issue #2274: the MASK-ONLY needle class. A Lambda-backed custom resource's
// handler can declare its response `Data` sensitive with `NoEcho: true`; the
// value is HANDLER-GENERATED, so there is no `{{resolve:...}}` expression to
// rewrite it onto and the mask itself is what gets persisted.
//
// Every case here fences one of the two invariants the design rests on:
//   (A) nothing plaintext survives in a bag that gets PERSISTED, and
//   (B) a mask is only ever written WHOLE, so every downstream consumer can
//       still recognise it (that is what `drift --revert` and the rollback
//       replay refuse on).
const NOECHO = 'handler-generated-secret-9f2a';
// Two credential identities, spelled the way `credentialFingerprint` spells one.
const ID_A = JSON.stringify(['account-a', null]);
const ID_B = JSON.stringify(['account-b', null]);
const DYNREF_PLAINTEXT = 'resolved-dynamic-ref-value';
const DYNREF_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password::}}';

describe('mask-only redaction channel (issue #2274)', () => {
  describe('recordMaskOnlyValue', () => {
    it('persists SECRET_MASK in place of a whole-leaf match', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, NOECHO);

      expect(redactSecretsForState({ Value: NOECHO }, secrets)).toEqual({ Value: SECRET_MASK });
    });

    it('refuses the empty string, so an empty leaf is never masked', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, '');

      expect(secrets.size).toBe(0);
      expect(secrets.get(NOECHO)).toBeUndefined();
      expect(redactSecretsForState({ Value: '' }, secrets)).toEqual({ Value: '' });
    });

    it('does NOT demote an EXPRESSION already recorded for the same plaintext', () => {
      // An expression is strictly better than a mask: it is re-resolvable, it
      // survives `drift --revert` and the rollback replay, and it reaches the
      // substring arm. A later mask-only registration must not take that away.
      const secrets: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      recordMaskOnlyValue(secrets, DYNREF_PLAINTEXT);

      expect(secrets.get(DYNREF_PLAINTEXT)).toBe(DYNREF_EXPR);
      expect(redactSecretsForState({ Value: DYNREF_PLAINTEXT }, secrets)).toEqual({
        Value: DYNREF_EXPR,
      });
    });

    it('stops being mask-only once the resolver records a real expression for it', () => {
      // `isMaskOnlyPlaintext` reads the MAP, and the sentinel value IS the
      // marker, so an entry the resolver later overwrites with a real
      // expression earns the substring arm back on the next walk.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, DYNREF_PLAINTEXT);
      expect(secrets.get(DYNREF_PLAINTEXT)).toBe(SECRET_MASK);

      secrets.set(DYNREF_PLAINTEXT, DYNREF_EXPR);
      // ...and the substring arm is handed back: the plaintext embedded in a
      // longer leaf is rewritten onto its expression again.
      expect(redactSecretsForState({ Url: `https://${DYNREF_PLAINTEXT}/x` }, secrets)).toEqual({
        Url: `https://${DYNREF_EXPR}/x`,
      });
    });
  });

  describe('the persist path takes a mask-only leaf WHOLE and never as a substring', () => {
    it('masks the WHOLE leaf that EMBEDS a fresh NoEcho value in a persisted bag (go-to-k/cdkd#2453)', () => {
      // Invariant (A) for the embedded shape, kept under invariant (B): an
      // inline `***` cannot be told apart from a literal `***` a user wrote, so
      // the leaf is replaced WHOLE, which `carriesSecretMask` recognises and
      // `drift --revert` / `resolveReplayProps` refuse.
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);

      const redacted = redactSecretsForState(
        { Url: `https://${NOECHO}/x`, Plain: 'https://example.invalid/x' },
        secrets
      );

      expect(redacted).toEqual({ Url: SECRET_MASK, Plain: 'https://example.invalid/x' });
      expect(JSON.stringify(redacted)).not.toContain(NOECHO);
      expect(carriesSecretMask(redacted)).toBe(true);
    });

    it('leaves an EMBEDDED occurrence of a mask-only value outside the containment population alone', () => {
      // The other polarity. Only the resolver's writers (a `NoEcho` value it
      // substituted, a derived `Fn::Base64` needle) mark a value for
      // containment; the custom resource's own `Data` and the drift write
      // paths stay whole-leaf, so an ordinary leaf merely containing one of
      // those values -- an account id inside the resource's own ServiceToken
      // ARN -- is not flattened.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, NOECHO);

      expect(redactSecretsForState({ Url: `https://${NOECHO}/x` }, secrets)).toEqual({
        Url: `https://${NOECHO}/x`,
      });
    });

    it('masks the WHOLE leaf that embeds a DERIVED Fn::Base64 needle, which is not fresh', () => {
      // `Fn::Join` around `Fn::Base64` of a secret persists a decodable
      // encoding inside a longer leaf. Contained, it is masked whole; it is
      // still not a FRESH value, so the no-change skip does not count it.
      const encoded = Buffer.from('a-resolved-secret').toString('base64');
      const secrets: RecordedSecretValues = new Map();
      recordDerivedMaskOnlyValue(secrets, encoded);
      const bag = { UserData: `#!/bin/bash\nTOKEN=${encoded}\n`, Whole: encoded };

      expect(redactSecretsForState(bag, secrets)).toEqual({
        UserData: SECRET_MASK,
        Whole: SECRET_MASK,
      });
      expect(carriesFreshNoEchoValue(bag, secrets)).toBe(false);
      // ...not even beside a fresh value of the same pass.
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      expect(carriesFreshNoEchoValue({ UserData: bag.UserData }, secrets)).toBe(false);
      expect(freshNoEchoLeafPositions({ UserData: bag.UserData }, secrets)).toEqual([]);
    });

    it('keeps a fresh value EQUAL to a public token out of the containment arm, but not out of the whole-leaf arm', () => {
      // A handler echoing the region or the account id under `NoEcho` would
      // otherwise flatten every ARN of the dependent. The value is already in
      // state in the clear (a segment of the producer's ServiceToken), so it
      // costs no secrecy; a leaf EQUAL to it is still masked, as before.
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(
        { Account: '111122223333', Token: NOECHO },
        secrets,
        undefined,
        new Set(['us-east-1', '111122223333', 'function', 'CrHandler'])
      );
      const bag = {
        Arn: 'arn:aws:ssm:us-east-1:111122223333:parameter/app',
        Account: '111122223333',
        Url: `u:${NOECHO}@h`,
      };

      expect(redactSecretsForState(bag, secrets)).toEqual({
        Arn: 'arn:aws:ssm:us-east-1:111122223333:parameter/app',
        Account: SECRET_MASK,
        Url: SECRET_MASK,
      });
      expect(carriesFreshNoEchoValue({ Arn: bag.Arn }, secrets)).toBe(false);
      expect(carriesFreshNoEchoValue({ Account: bag.Account }, secrets)).toBe(true);
    });

    it('matches public tokens by EQUALITY: a value merely INSIDE one is still a containment needle', () => {
      // A generated value that happens to occur inside the stack name is still
      // a secret; excluding it would reopen the embedded leak for it.
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn('prod', secrets, undefined, new Set(['myapp-prod-stack']));

      expect(redactSecretsForState({ Url: 'postgres://u:prod@h' }, secrets)).toEqual({
        Url: SECRET_MASK,
      });
    });

    it('carries the containment mark with the fresh one into a nested child bag', () => {
      const parent: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, parent);
      const child: RecordedSecretValues = new Map();
      recordMaskOnlyValue(child, NOECHO);
      expect(redactSecretsForState({ V: `x-${NOECHO}` }, child)).toEqual({ V: `x-${NOECHO}` });

      carryFreshNoEchoMark(parent, child, NOECHO);

      expect(redactSecretsForState({ V: `x-${NOECHO}` }, child)).toEqual({ V: SECRET_MASK });
    });

    it('masks an embedding leaf on the SOURCE-bearing path too', () => {
      // The persist choke point hands the template bag in as the position
      // source; an `Fn::Join` around the `Fn::GetAtt` is the connection-string
      // shape the issue names.
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const source = {
        Value: {
          'Fn::Join': ['', ['postgres://u:', { 'Fn::GetAtt': ['Cr', 'Token'] }, '@db/app']],
        },
        Name: '/app/url',
      };

      expect(
        redactSecretsForState({ Value: `postgres://u:${NOECHO}@db/app`, Name: '/app/url' }, secrets, source)
      ).toEqual({ Value: SECRET_MASK, Name: '/app/url' });
    });

    it('KEEPS a leaf whose only occurrence lies strictly inside a resolvable reference span', () => {
      // The reference guard: that occurrence is the reference's own public
      // text, and flattening would destroy a re-resolvable expression for a
      // coincidence. Every other placement flattens the leaf.
      const inner = 'app-noecho-name';
      const token = `{{resolve:secretsmanager:${inner}:SecretString:pw::}}`;
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(inner, secrets);

      expect(redactSecretsForState({ Whole: token, Framed: `u:${token}@h` }, secrets)).toEqual({
        Whole: token,
        Framed: `u:${token}@h`,
      });
      // Beside the reference: the value is disclosed, so the leaf goes whole.
      expect(redactSecretsForState({ Beside: `${token}:${inner}` }, secrets)).toEqual({
        Beside: SECRET_MASK,
      });
      // Inside a token of a service cdkd does not resolve: not a reference.
      expect(redactSecretsForState({ Other: `{{resolve:${inner}}}` }, secrets)).toEqual({
        Other: SECRET_MASK,
      });
    });

    it('flattens a leaf that carries a reference AND the value outside it, after the expression arm ran', () => {
      // The leak-vs-destroy case: the alternatives are the plaintext or an
      // unrecognisable inline mask. The reference could not be replayed from
      // this record anyway, since the NoEcho half is not recoverable from it.
      const secrets: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      recordFreshNoEchoValuesIn(NOECHO, secrets);

      expect(
        redactSecretsForState({ Url: `u:${DYNREF_PLAINTEXT}:${NOECHO}@h`, Other: `u:${DYNREF_PLAINTEXT}@h` }, secrets)
      ).toEqual({ Url: SECRET_MASK, Other: `u:${DYNREF_EXPR}@h` });
    });

    it('returns the input by identity when no leaf embeds a fresh value', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const scrubbed = redactSecretsForState({ A: 'plain', B: ['x'] }, secrets);

      expect(redactSecretsForState(scrubbed, new Map())).toBe(scrubbed);
    });

    it('keeps an own `__proto__` key as DATA when it rebuilds a container', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const bag = JSON.parse(`{"__proto__": {"polluted": "x-${NOECHO}"}, "Keep": "k"}`) as Record<
        string,
        unknown
      >;

      const redacted = redactSecretsForState(bag, secrets);

      expect(Object.prototype.hasOwnProperty.call(redacted, '__proto__')).toBe(true);
      expect(JSON.stringify(redacted)).not.toContain(NOECHO);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('carries the fresh mark through mergeResolvedPairs, so the OUTPUTS bag masks an embedding output', () => {
      // The engine copies each outputs-pass map into its outputs bag entry by
      // entry, then merges the pass's evidence with `mergeResolvedPairs`.
      const pass: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, pass);
      const outputs: RecordedSecretValues = new Map(pass);
      expect(redactSecretsForState({ Out: `token=${NOECHO};` }, outputs)).toEqual({
        Out: `token=${NOECHO};`,
      });

      mergeResolvedPairs(pass, outputs);

      expect(redactSecretsForState({ Out: `token=${NOECHO};` }, outputs)).toEqual({
        Out: SECRET_MASK,
      });
    });

    it('does not carry a fresh mark onto an entry the destination holds with an EXPRESSION', () => {
      const pass: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, pass);
      const outputs: RecordedSecretValues = new Map([[NOECHO, DYNREF_EXPR]]);

      mergeResolvedPairs(pass, outputs);

      expect(carriesFreshNoEchoValue({ Out: `x-${NOECHO}` }, outputs)).toBe(false);
      // The expression wins: the embedding leaf is rewritten onto it in place.
      expect(redactSecretsForState({ Out: `x-${NOECHO}` }, outputs)).toEqual({
        Out: `x-${DYNREF_EXPR}`,
      });
    });

    it('masks an embedding leaf inside an ARRAY, at any nesting', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);

      expect(
        redactSecretsForState(
          { L: ['ok', `x-${NOECHO}`], Env: [{ Name: 'URL', Value: `u:${NOECHO}@h` }] },
          secrets
        )
      ).toEqual({ L: ['ok', SECRET_MASK], Env: [{ Name: 'URL', Value: SECRET_MASK }] });
    });

    it('masks a Date leaf whose persisted ISO string embeds a containment needle', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn('2026-01-02', secrets);
      const kept = new Date('2025-05-05T00:00:00.000Z');

      const redacted = redactSecretsForState(
        { At: new Date('2026-01-02T03:04:05.000Z'), Kept: kept },
        secrets
      ) as Record<string, unknown>;

      expect(redacted['At']).toBe(SECRET_MASK);
      expect(redacted['Kept']).toBe(kept);
    });

    it('carries the containment mark of a DERIVED needle into a nested child bag, although it is not fresh', () => {
      const encoded = Buffer.from('a-resolved-secret').toString('base64');
      const parent: RecordedSecretValues = new Map();
      recordDerivedMaskOnlyValue(parent, encoded);
      const child: RecordedSecretValues = new Map();
      recordMaskOnlyValue(child, encoded);

      carryFreshNoEchoMark(parent, child, encoded);

      expect(redactSecretsForState({ V: `x-${encoded}` }, child)).toEqual({ V: SECRET_MASK });
      expect(carriesFreshNoEchoValue({ V: `x-${encoded}` }, child)).toBe(false);
    });

    it('masks the embedding leaf in every field scrubResourceRecord persists', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const record = {
        properties: { Value: `postgres://u:${NOECHO}@db/app` },
        attributes: { Echo: `echo:${NOECHO}` },
        observedProperties: { Value: `postgres://u:${NOECHO}@db/app` },
      };

      const scrubbed = scrubResourceRecord(record, secrets);

      expect(JSON.stringify(scrubbed)).not.toContain(NOECHO);
      expect(scrubbed.properties).toEqual({ Value: SECRET_MASK });
      expect(scrubbed.attributes).toEqual({ Echo: SECRET_MASK });
    });

    it('still substring-scans an EXPRESSION-bearing needle in the same bag', () => {
      // The narrowing is scoped to the mask class alone: a bag holding both
      // kinds must lose none of the dynamic-reference behaviour. `NOECHO` is a
      // NON-fresh mask-only value here, so its embedded occurrence stays.
      const secrets: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      recordMaskOnlyValue(secrets, NOECHO);

      expect(
        redactSecretsForState(
          { Mixed: `user:${DYNREF_PLAINTEXT}@host`, Whole: NOECHO, Embedded: `x-${NOECHO}-y` },
          secrets
        )
      ).toEqual({
        Mixed: `user:${DYNREF_EXPR}@host`,
        Whole: SECRET_MASK,
        Embedded: `x-${NOECHO}-y`,
      });
    });
  });

  describe('maskSecretsInText participates FULLY, including the substring arm', () => {
    it('masks an embedded mask-only value in log / error text', () => {
      // A log line, an error message and an event are read back by nobody as a
      // VALUE, so a partial mask costs nothing there and closes an embedded
      // disclosure the persist path deliberately leaves.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, NOECHO);

      expect(maskSecretsInText(`failed writing ${NOECHO} to /p`, secrets)).toBe(
        `failed writing ${SECRET_MASK} to /p`
      );
      expect(maskSecretsInText(NOECHO, secrets)).toBe(SECRET_MASK);
    });
  });

  describe('recordMaskOnlyValuesIn', () => {
    it('registers every STRING leaf of a Data bag, at any nesting', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(
        { Token: NOECHO, Nested: { Inner: 'inner-secret-value' }, List: ['list-secret-value'] },
        secrets
      );

      expect(
        redactSecretsForState(
          { a: NOECHO, b: 'inner-secret-value', c: ['list-secret-value'] },
          secrets
        )
      ).toEqual({ a: SECRET_MASK, b: SECRET_MASK, c: [SECRET_MASK] });
    });

    it('skips non-string leaves — there is nothing to key a number or boolean on', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Count: 3, Flag: true, Nothing: null }, secrets);

      expect(secrets.size).toBe(0);
    });
  });

  describe('carriesSecretMask', () => {
    it('recognises a WHOLE-leaf mask at any nesting, and nothing else', () => {
      expect(carriesSecretMask(SECRET_MASK)).toBe(true);
      expect(carriesSecretMask({ a: { b: [SECRET_MASK] } })).toBe(true);
      expect(carriesSecretMask({ a: 'ordinary' })).toBe(false);
      // Containment is deliberately NOT a match: an inline `***` is either a
      // user's own literal or text this module never wrote.
      expect(carriesSecretMask({ a: `prefix-${SECRET_MASK}` })).toBe(false);
    });
  });

  describe('carriesFreshNoEchoValue (go-to-k/cdkd#3662)', () => {
    // The engine's no-change skip compares REDACTED bags, and a `NoEcho` value
    // redacts to `***`, which identifies nothing. This is the question the skip
    // asks first: does this bag hold a `NoEcho` value supplied in THIS deploy?
    it('answers true exactly for the leaves the whole-value arm masks as a fresh NoEcho value', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn({ Value: NOECHO }, secrets);
      const bag = { Name: '/app/token', Nested: { List: ['x', NOECHO] } };

      expect(carriesFreshNoEchoValue(bag, secrets)).toBe(true);
      // The same bag redacts that leaf to the mask: the two agree.
      expect(redactSecretsForState(bag, secrets)).toEqual({
        Name: '/app/token',
        Nested: { List: ['x', SECRET_MASK] },
      });
    });

    it('answers false for a DERIVED mask-only needle (Fn::Base64 of a secret), which is not fresh', () => {
      // The review-round blocker: counting this population updated a
      // Base64-`UserData` resource on every deploy.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, NOECHO);

      expect(carriesFreshNoEchoValue({ Value: NOECHO }, secrets)).toBe(false);
    });

    it('answers false for an EXPRESSION-class secret, whose redaction still identifies the value', () => {
      const secrets: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      // An expression wins over the mask, so the fresh mark cannot take it.
      recordFreshNoEchoValuesIn(DYNREF_PLAINTEXT, secrets);

      expect(carriesFreshNoEchoValue({ Value: DYNREF_PLAINTEXT }, secrets)).toBe(false);
    });

    it('answers false for a leaf that already IS the mask (a read of a previous run)', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);

      expect(carriesFreshNoEchoValue({ Value: SECRET_MASK }, secrets)).toBe(false);
    });

    it('answers true for an EMBEDDED fresh value, which the persist path masks whole (go-to-k/cdkd#2453)', () => {
      // Both sides of the no-change skip redact this leaf to `***`, so
      // without this answer a handler returning a NEW value would compare
      // equal and the update would be skipped.
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const bag = { Value: `prefix-${NOECHO}` };

      expect(carriesFreshNoEchoValue(bag, secrets)).toBe(true);
      expect(redactSecretsForState(bag, secrets)).toEqual({ Value: SECRET_MASK });
    });

    it('answers false for a fresh value only inside a reference span, which the persist path keeps', () => {
      const inner = 'app-noecho-name';
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(inner, secrets);
      const bag = { Value: `u:{{resolve:secretsmanager:${inner}:SecretString:pw::}}@h` };

      expect(carriesFreshNoEchoValue(bag, secrets)).toBe(false);
      expect(redactSecretsForState(bag, secrets)).toEqual(bag);
    });

    it('does not mark an EXCLUDED leaf, which it did not register either', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn({ Token: NOECHO }, secrets, new Set([NOECHO]));

      expect(carriesFreshNoEchoValue({ Value: NOECHO }, secrets)).toBe(false);
    });

    it('is scoped to the pass: a copy of the map carries no fresh marks', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);

      expect(carriesFreshNoEchoValue({ Value: NOECHO }, new Map(secrets))).toBe(false);
    });

    it('answers false with no marks, and terminates on a cycle', () => {
      const cyclic: Record<string, unknown> = { Value: 'unrelated-value' };
      cyclic['self'] = cyclic;
      const secrets: RecordedSecretValues = new Map();

      expect(carriesFreshNoEchoValue(cyclic, secrets)).toBe(false);
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      expect(carriesFreshNoEchoValue(cyclic, secrets)).toBe(false);
    });

    it('embedsFreshNoEchoValue finds a fresh value inside a longer string, and nothing else', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, 'derived-needle-value');
      expect(embedsFreshNoEchoValue('x derived-needle-value y', secrets)).toBe(false);
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      expect(embedsFreshNoEchoValue(`#!/bin/sh\nTOKEN=${NOECHO}\n`, secrets)).toBe(true);
      expect(embedsFreshNoEchoValue('no token here', secrets)).toBe(false);
    });
  });

  describe('freshNoEchoLeafPositions (go-to-k/cdkd#3729)', () => {
    // The positions the engine asks AWS about for a create-only property whose
    // record is `***`. The same predicate as carriesFreshNoEchoValue, so the
    // two can never disagree about which leaves are fresh.
    it('names each fresh whole leaf by its path, with the plaintext found there', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn({ Value: NOECHO }, secrets);

      expect(freshNoEchoLeafPositions(NOECHO, secrets)).toEqual([{ path: [], plaintext: NOECHO }]);
      expect(
        freshNoEchoLeafPositions(
          { Plain: 'x', Keys: [{ Name: NOECHO, Kind: 'HASH' }, 'y', NOECHO] },
          secrets
        )
      ).toEqual([
        { path: ['Keys', 0, 'Name'], plaintext: NOECHO },
        { path: ['Keys', 2], plaintext: NOECHO },
      ]);
    });

    it('agrees with carriesFreshNoEchoValue on every population it refuses', () => {
      const derived: RecordedSecretValues = new Map();
      recordMaskOnlyValue(derived, NOECHO);
      const expression: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      recordFreshNoEchoValuesIn(DYNREF_PLAINTEXT, expression);
      const fresh: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, fresh);
      const excluded: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn({ Token: NOECHO }, excluded, new Set([NOECHO]));

      const cases: Array<[unknown, RecordedSecretValues]> = [
        [{ Value: NOECHO }, derived],
        [{ Value: DYNREF_PLAINTEXT }, expression],
        [{ Value: SECRET_MASK }, fresh],
        [{ Value: `prefix-${NOECHO}` }, derived],
        [{ Value: NOECHO }, excluded],
        [{ Value: NOECHO }, new Map(fresh)],
      ];
      for (const [bag, secrets] of cases) {
        expect(freshNoEchoLeafPositions(bag, secrets)).toEqual([]);
        expect(carriesFreshNoEchoValue(bag, secrets)).toBe(false);
      }
    });

    it('names a leaf EMBEDDING a fresh value, with the WHOLE leaf as its plaintext (go-to-k/cdkd#2453)', () => {
      // The engine compares AWS's value at the position with `plaintext`, so it
      // has to be the leaf AWS holds when the value is unchanged.
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const leaf = `postgres://u:${NOECHO}@db/app`;

      expect(freshNoEchoLeafPositions({ Url: leaf, Plain: 'x' }, secrets)).toEqual([
        { path: ['Url'], plaintext: leaf },
      ]);
    });

    it('names every position of a container shared by two paths', () => {
      // A position left out would go unchecked against AWS.
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const shared = { Name: NOECHO };

      expect(freshNoEchoLeafPositions({ A: shared, B: [shared] }, secrets)).toEqual([
        { path: ['A', 'Name'], plaintext: NOECHO },
        { path: ['B', 0, 'Name'], plaintext: NOECHO },
      ]);
    });

    it('terminates on a cycle, naming the leaf once', () => {
      const secrets: RecordedSecretValues = new Map();
      recordFreshNoEchoValuesIn(NOECHO, secrets);
      const cyclic: Record<string, unknown> = { Value: NOECHO };
      cyclic['self'] = cyclic;

      expect(freshNoEchoLeafPositions(cyclic, secrets)).toEqual([
        { path: ['Value'], plaintext: NOECHO },
      ]);
    });
  });

  describe('the needle FLOOR — a mask-only needle has no position behind it', () => {
    // Review finding (issue #2274 round 2). The whole-value arm substitutes at
    // ANY length, and an expression-bearing pair can afford that because it
    // came from a POSITION cdkd resolved. A mask-only pair is a bare plaintext,
    // so a short one masks every leaf equal to it — unrecoverably, since there
    // is no expression to re-resolve, and on every later run, because the mask
    // then trips the deploy refusal, the rollback refusal and the export
    // blocker.
    it('refuses a plaintext below MIN_NEEDLE_LENGTH', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Count: '7', Ok: 'yes', Empty: '' }, secrets);

      expect(secrets.size).toBe(0);
      // The discriminator: UNRELATED properties whose whole value equals one of
      // those are left alone. Before the floor each became `***` and stayed
      // that way, on every later run, with nothing able to recover it.
      expect(redactSecretsForState({ Retries: '7', Enabled: 'yes', Note: '' }, secrets)).toEqual({
        Retries: '7',
        Enabled: 'yes',
        Note: '',
      });
    });

    it('still records a value AT the floor, so the bound is not off by one', () => {
      const atFloor = 'a'.repeat(MIN_NEEDLE_LENGTH);
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, atFloor);

      expect(secrets.get(atFloor)).toBe(SECRET_MASK);
    });

    it('STATES the residual: a 4-character Data value is still a needle', () => {
      // `MIN_NEEDLE_LENGTH` is 4, so `Data: { Ready: "true" }` clears it and a
      // property whose whole value is `"true"` IS masked. That bound is the
      // module's own — shared with the substring arm so the two cannot
      // disagree about what is too short to distinguish — rather than one this
      // channel invented, and the remedy is a handler contract: do not declare
      // `NoEcho` over a response whose `Data` mixes a secret with short
      // non-secret members. Asserted so the bound is a recorded decision
      // instead of a surprise.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Ready: 'true' }, secrets);

      expect(secrets.get('true')).toBe(SECRET_MASK);
    });
  });

  describe('the EXCLUDED set — cdkd never masks its own inputs back at itself', () => {
    // Review finding (issue #2274 round 2), the security half. A handler
    // echoing `event.ResourceProperties` into its `Data` — what the CDK
    // `Provider` samples encourage — makes `Data.FunctionArn` equal the
    // resource's own `ServiceToken`. Registering that rewrites
    // `properties.ServiceToken` to `***` in the very record
    // `CustomResourceProvider.delete` reads it back from, where the mask is a
    // TRUTHY STRING that passes both of that method's guards.
    const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:111122223333:function:CrHandler';

    it('skips a leaf the resource own properties already carry', () => {
      const ownProperties = { ServiceToken: SERVICE_TOKEN, Seed: 'integ-seed' };
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(
        { FunctionArn: SERVICE_TOKEN, Token: NOECHO },
        secrets,
        wholeStringLeavesOf(ownProperties)
      );

      // The genuinely handler-generated value IS a needle...
      expect(secrets.get(NOECHO)).toBe(SECRET_MASK);
      // ...and the echoed input is NOT, so the record keeps an addressable
      // ServiceToken. This is the assertion that reds when the exclusion is
      // dropped.
      expect(secrets.get(SERVICE_TOKEN)).toBeUndefined();
      expect(scrubResourceRecord({ properties: ownProperties }, secrets).properties).toEqual(
        ownProperties
      );
    });

    it('masks everything when no exclusion set is supplied', () => {
      // The negative twin: the exclusion is opt-in per call site, so a caller
      // that passes nothing keeps the pre-fix behaviour. Without this the case
      // above could pass by `recordMaskOnlyValuesIn` simply never recording an
      // ARN-shaped value.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ FunctionArn: SERVICE_TOKEN }, secrets);

      expect(secrets.get(SERVICE_TOKEN)).toBe(SECRET_MASK);
    });
  });

  describe('the two walks agree about DEPTH', () => {
    // Review finding (issue #2274 round 2). The walk that WRITES the mask
    // (`redactSecretsForState`) is unbounded, so a depth cap on the
    // recognition side made a mask deeper than the cap persist while reading
    // as clean — after which the rollback replay, the export blocker and
    // `noteAttributeSecrecy` all missed it and `***` could ship to AWS.
    const DEEP = 14;
    function nest(leaf: unknown): unknown {
      let node: unknown = leaf;
      for (let i = 0; i < DEEP; i++) node = { down: node };
      return node;
    }

    it('recognises a mask nested deeper than the retired 10-level cap', () => {
      expect(carriesSecretMask(nest(SECRET_MASK))).toBe(true);
    });

    it('records a needle nested that deep, so the mask gets there in the first place', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(nest(NOECHO), secrets);

      expect(secrets.get(NOECHO)).toBe(SECRET_MASK);
      expect(carriesSecretMask(redactSecretsForState(nest(NOECHO), secrets))).toBe(true);
    });

    it('terminates on a self-referential structure', () => {
      // What the depth cap was reaching for. A visited-set answers it without
      // capping depth; without either, both walks recurse forever.
      const cyclic: Record<string, unknown> = { Token: NOECHO };
      cyclic['self'] = cyclic;

      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(cyclic, secrets);
      expect(secrets.get(NOECHO)).toBe(SECRET_MASK);

      const cyclicMask: Record<string, unknown> = { Value: SECRET_MASK };
      cyclicMask['self'] = cyclicMask;
      expect(carriesSecretMask(cyclicMask)).toBe(true);
    });
  });

  describe('the IN-RUN recovery store', () => {
    // Issue #2274 round 2, blocker 3. Every cross-stack route reads the
    // PRODUCER's persisted outputs, so a masked output would refuse a consumer
    // template that deployed before this feature. The store is what makes the
    // same-run case work, and its KEY is what keeps it from becoming the
    // process-wide plaintext store PR #2415 had to withdraw.
    it('answers for the exact coordinate and for nothing else', () => {
      clearRecoverableMaskedOutputs();
      recordRecoverableMaskedOutput(ID_A, 'Producer', 'us-east-1', 'Token', NOECHO);

      expect(recoverMaskedOutput(ID_A, 'Producer', 'us-east-1', 'Token')).toBe(NOECHO);
      // A different stack, region or output key gets NOTHING — this is the
      // assertion that separates a coordinate-keyed store from a value-keyed
      // one, which would answer for all three.
      expect(recoverMaskedOutput(ID_A, 'OtherStack', 'us-east-1', 'Token')).toBeUndefined();
      expect(recoverMaskedOutput(ID_A, 'Producer', 'eu-west-1', 'Token')).toBeUndefined();
      expect(recoverMaskedOutput(ID_A, 'Producer', 'us-east-1', 'Other')).toBeUndefined();
      clearRecoverableMaskedOutputs();
    });

    it('cannot be forged by a stack name carrying the separator', () => {
      clearRecoverableMaskedOutputs();
      recordRecoverableMaskedOutput(ID_A, 'A', 'B', 'C', NOECHO);
      // Any printable separator could be spelled inside a real stack name;
      // NUL cannot. Both spellings below would collide under a `:` or `/`.
      expect(recoverMaskedOutput(ID_A, 'A:B', 'C', 'D')).toBeUndefined();
      expect(recoverMaskedOutput(ID_A, 'A/B/C', '', '')).toBeUndefined();
      clearRecoverableMaskedOutputs();
    });

    it('answers only the credential identity that recorded it (go-to-k/cdkd#3691)', () => {
      // A library caller can switch `AwsClients` between accounts in one
      // process; account B's same-named stack must not get A's plaintext.
      clearRecoverableMaskedOutputs();
      recordRecoverableMaskedOutput(ID_A, 'Producer', 'us-east-1', 'Token', NOECHO);

      expect(recoverMaskedOutput(ID_A, 'Producer', 'us-east-1', 'Token')).toBe(NOECHO);
      expect(recoverMaskedOutput(ID_B, 'Producer', 'us-east-1', 'Token')).toBeUndefined();
      clearRecoverableMaskedOutputs();
    });

    it('forgets everything on clear, so a plaintext does not outlive the run', () => {
      recordRecoverableMaskedOutput(ID_A, 'Producer', 'us-east-1', 'Token', NOECHO);
      clearRecoverableMaskedOutputs();
      expect(recoverMaskedOutput(ID_A, 'Producer', 'us-east-1', 'Token')).toBeUndefined();
    });
  });

  describe('scrubResourceRecord — the persist choke point', () => {
    it('masks the custom resource own ATTRIBUTES and a dependent resolved PROPERTIES', () => {
      // Invariant (A): the plaintext must not reach state.json by ANY route.
      // The two bags are scrubbed with DIFFERENT per-resource maps, exactly as
      // `perResourceSecrets` is keyed by logical id — which is why the deploy
      // engine registers the needles in the DEPENDENT's bag too.
      const crSecrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Secret: NOECHO }, crSecrets);
      const cr = scrubResourceRecord(
        { properties: { ServiceToken: 'arn:aws:lambda:...' }, attributes: { Secret: NOECHO } },
        crSecrets
      );
      expect(cr.attributes).toEqual({ Secret: SECRET_MASK });

      const dependentSecrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(dependentSecrets, NOECHO);
      const dependent = scrubResourceRecord(
        { properties: { Name: '/p', Value: NOECHO }, observedProperties: { Value: NOECHO } },
        dependentSecrets,
        { Name: '/p', Value: { 'Fn::GetAtt': ['Cr', 'Secret'] } }
      );
      expect(dependent.properties).toEqual({ Name: '/p', Value: SECRET_MASK });
      expect(dependent.observedProperties).toEqual({ Value: SECRET_MASK });
      expect(JSON.stringify(dependent)).not.toContain(NOECHO);
    });

    it('leaves a NON-NoEcho custom resource attribute in cleartext (the negative case)', () => {
      // The existing `custom-resource-getatt-data` integ requires exactly this:
      // a handler that sets no `NoEcho` must keep resolving and persisting in
      // the clear.
      const secrets: RecordedSecretValues = new Map();
      const record = scrubResourceRecord(
        { properties: {}, attributes: { ComputedValue: 'computed-integ' } },
        secrets
      );
      expect(record.attributes).toEqual({ ComputedValue: 'computed-integ' });
    });
  });
});
