/**
 * `resolveDynamicReferences` recovers per TOKEN, so one unfetchable reference
 * stops abandoning every later token in the same leaf (issues
 * go-to-k/cdkd#3181, go-to-k/cdkd#3218).
 *
 * The loop was a bare sequential `for await` with no per-token `try`. A leaf
 * holding `{{resolve:ssm-secure:/deleted/p}}` before a live
 * `{{resolve:secretsmanager:prod/db}}` therefore recorded NO needle for the
 * second one — so its plaintext survived every redaction pass and every re-run,
 * and `cdkd scrub` could report the stack clean over it (go-to-k/cdkd#3160 made
 * that VISIBLE; this makes it recoverable).
 *
 * Two properties are pinned here and they pull in opposite directions:
 *
 *  - a failed FETCH is recorded and the walk continues, and
 *  - a deliberate REFUSAL still aborts the leaf.
 *
 * Getting the second backwards is the dangerous direction: a refusal the
 * resolver took on purpose — a region-ambiguous reference, an `ssm-secure`
 * spelling over a public parameter, a NAMELESS reference — would become a
 * quietly skipped token, and every consumer that relies on it aborting
 * (`cdkd scrub` re-raises all of them) would report success instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { AbandonedResolution } from '../../../src/deployment/intrinsic-function-resolver.js';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetSecretValueCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'GetSecretValue',
    input,
  })),
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'GetParameter',
    input,
  })),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const DELETED = '{{resolve:ssm-secure:/deleted/param}}';
const LIVE = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
const LIVE_PLAINTEXT = 'a-real-password-value';

/** `GetParameter` on the deleted name rejects; the secret resolves. */
function wireAws(): void {
  sendMock.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) => {
    if (cmd.__type === 'GetParameter') {
      return Promise.reject(
        Object.assign(new Error('Parameter /deleted/param not found.'), {
          name: 'ParameterNotFound',
        })
      );
    }
    return Promise.resolve({ SecretString: JSON.stringify({ password: LIVE_PLAINTEXT }) });
  });
}

describe('per-token recovery in resolveDynamicReferences (go-to-k/cdkd#3181)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    wireAws();
  });

  it('fetches a token AFTER one that failed, and records the failure', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: AbandonedResolution[] = [];

    const out = await resolver.resolveDynamicReferences(`${DELETED}/${LIVE}`, {
      recordedSecretValues,
      abandonedResolutions,
    } as never);

    // THE POINT. Under the bare loop the walk aborted on the first token and
    // the second was never fetched, so this map was EMPTY and the plaintext it
    // should have learned about survived untouched in state.
    expect(
      [...recordedSecretValues.keys()],
      'the live secret after the failing token recorded no needle, so a stored plaintext for it ' +
        'would survive every redaction pass and every re-run (go-to-k/cdkd#3181).'
    ).toContain(LIVE_PLAINTEXT);

    // The failing token stays in the output, unreplaced.
    expect(out).toContain(DELETED);
    // ...and it is REPORTED rather than swallowed, so a caller can still refuse
    // to call the record clean.
    expect(abandonedResolutions).toHaveLength(1);
    expect(abandonedResolutions[0]!.error).toBeInstanceOf(Error);
    expect(abandonedResolutions[0]!.unit).toBe('token');
  });

  it('records the entry as the log twin PRINTS it, not as the raw token spells it', async () => {
    // The entry's two TEXT fields are the only ones a consumer may render, and
    // each has its own route to a plaintext.
    //
    // THE SHAPE HERE IS LOAD-BEARING AND AN EARLIER CUT OF THIS CASE WAS
    // VACUOUS. It assembled the token from a plain LITERAL (`{Name:
    // 'SUPER-SECRET-PW'}`), where the twin equals the product, so the raw and
    // the log spellings were byte-identical — instrumenting the push site
    // measured `differ:false` on every push in this file. It reddened only
    // because the test pre-seeded `recordedSecretValues`, i.e. it fenced the
    // NEEDLE mask, not the SOURCE the field is documented to take. The
    // `fullMatch` mutation it claimed to catch left the file fully GREEN.
    //
    // What discriminates is a variable resolving to a SECRET, and a SUB-FLOOR
    // one: below `MIN_NEEDLE_LENGTH` the needle mask cannot clean it, so only
    // the twin-derived route can, and each field is then tested on its own
    // merits rather than on a needle that happens to cover both.
    const PW = 'pw1'; // shorter than MIN_NEEDLE_LENGTH (4) on purpose
    const PW_REF = '{{resolve:secretsmanager:app/pw:SecretString:pw}}';
    sendMock.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) => {
      if (cmd.__type === 'GetParameter') {
        return Promise.reject(
          Object.assign(new Error(`Parameter /deleted/${PW} not found.`), {
            name: 'ParameterNotFound',
          })
        );
      }
      return Promise.resolve({ SecretString: JSON.stringify({ pw: PW }) });
    });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolve(
      { 'Fn::Sub': ['{{resolve:ssm-secure:/deleted/${Pw}}}', { Pw: PW_REF }] },
      { recordedSecretValues: new Map<string, string>(), abandonedResolutions } as never
    );

    expect(abandonedResolutions).toHaveLength(1);
    expect(
      abandonedResolutions[0]!.subject,
      "the entry's 'subject' carries the assembled secret in the clear — an assembled " +
        'reference is exactly the shape that puts a plaintext in the RAW token ' +
        '(go-to-k/cdkd#2827), which is why the field takes the twin-derived text.'
    ).not.toContain(PW);
    expect(
      abandonedResolutions[0]!.message,
      "the entry's 'message' carries the assembled secret in the clear. An SDK rejection " +
        'arrives RAW and echoes the name it was handed, and below MIN_NEEDLE_LENGTH the ' +
        'needle mask cannot see it — so this field needs the twin-derived redaction too.'
    ).not.toContain(PW);
  });

  it('still ABORTS on a refusal that arrives through a KEY, not only through a token', async () => {
    // `resolveKeyUnit`'s refusal gate, which a round-4 test review measured
    // COMPLETELY unfenced: deleting `if (isDeliberateResolutionRefusal(err))
    // throw err` left 7,472 tests green. It is live code, not dead — with the
    // gate gone this resolves instead of rejecting and the refusal lands in the
    // bag.
    //
    // The three existing refusal cases all call `resolveDynamicReferences`
    // DIRECTLY, so none of them traverses a key. The token loop's twin gate has
    // three fences; its key-side mirror had none — and getting this backwards
    // is the direction this file's own docstring calls dangerous: a decision
    // the resolver took on purpose becomes a quietly skipped unit, and every
    // consumer that relies on it aborting reports success.
    sendMock.mockImplementation(() =>
      // `ssm-secure` over a parameter AWS reports as a public `String`: a
      // refusal by DECISION, reached here through a property KEY.
      Promise.resolve({ Parameter: { Type: 'String', Value: 'public-config' } })
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: AbandonedResolution[] = [];

    await expect(
      resolver.resolve(
        { Environment: { Variables: { A: '{{resolve:ssm-secure:/public/p}}', B: LIVE } } },
        { recordedSecretValues: new Map<string, string>(), abandonedResolutions } as never
      )
    ).rejects.toThrow(/ssm-secure spelling is defined for SecureString/);

    expect(
      abandonedResolutions,
      'a deliberate refusal reached through a KEY was RECORDED instead of re-raised, so the ' +
        'walk continued past a decision the resolver took on purpose.'
    ).toHaveLength(0);
  });

  it('redacts a LONGER reference field before a shorter one that prefixes it', async () => {
    // `preRedact`'s ORDERING, and it is LOAD-BEARING rather than defence in
    // depth. An earlier revision of this file asserted the opposite in a code
    // comment — that no discriminating case could exist, because a twin whose
    // colon fields are secret-derived degrades to `() => SECRET_MASK`. That
    // premise is FALSE: `SECRET_MASK` contains no colon, so a secret sitting
    // wholly inside one field leaves `twinPieces.length === pieces.length` and
    // `dynamicReferenceNameLogText` does not degrade. Measured twin:
    // `{{resolve:secretsmanager:***:SecretString:pw:***}}`.
    //
    // What discriminates: the LONGER secret-derived field must appear in the
    // thrown text while a SHORTER field that prefixes it comes EARLIER in
    // `inner.split(':')`. Source order then substitutes the short one first,
    // rewriting the long one's head and leaving its tail unmatched by its own
    // pass — measured `...staging label: ***SECRETTAIL`, ten characters of a
    // recorded secret in the field this interface documents as masked, and the
    // needle mask cannot recover it because the needle itself is mangled.
    const SHORT = 'abcd';
    const LONG = 'abcdSECRETTAIL';
    sendMock.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) => {
      if (cmd.__type === 'GetParameter') {
        return Promise.reject(
          Object.assign(new Error('Parameter not found.'), { name: 'ParameterNotFound' })
        );
      }
      const id = String(cmd.input['SecretId'] ?? '');
      if (id === 'app/short') return Promise.resolve({ SecretString: SHORT });
      if (id === 'app/long') return Promise.resolve({ SecretString: LONG });
      // The assembled reference's own fetch fails, ECHOING the long field back.
      return Promise.reject(
        Object.assign(
          new Error(`Secrets Manager can't find the secret value for staging label: ${LONG}`),
          { name: 'ResourceNotFoundException' }
        )
      );
    });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolve(
      {
        'Fn::Sub': [
          '{{resolve:secretsmanager:${A}:SecretString:pw:${B}}}',
          {
            A: '{{resolve:secretsmanager:app/short:SecretString}}',
            B: '{{resolve:secretsmanager:app/long:SecretString}}',
          },
        ],
      },
      { recordedSecretValues: new Map<string, string>(), abandonedResolutions } as never
    );

    expect(
      abandonedResolutions,
      'the assembled reference did not fail, so nothing was recorded and the assertion below ' +
        'would pass for the wrong reason.'
    ).toHaveLength(1);
    const message = abandonedResolutions[0]!.message;
    expect(
      message,
      `a recorded secret survived in the message: ${JSON.stringify(message)}. Under source ` +
        `order the shorter field '${SHORT}' is substituted first, rewriting the head of ` +
        `'${LONG}' so its own replacement matches nothing and its tail is left in the clear.`
    ).not.toContain('SECRETTAIL');
    expect(message).not.toContain(LONG);
  });

  it('keeps the pre-#3181 abort when the caller passes NO bag', async () => {
    // The recovery is OPT-IN, matching `redactedAttributeReads`: a caller asks
    // for it on the line where it builds its context. Without the bag the leaf
    // still aborts, so no existing consumer changed behaviour silently.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolveDynamicReferences(`${DELETED}/${LIVE}`, {
        recordedSecretValues: new Map<string, string>(),
      } as never)
    ).rejects.toThrow(/not found/);
  });

  it('still ABORTS on an IntrinsicResolutionRefusalError, not just the nameless spellings', async () => {
    // The CLASS arm of the partition, which the nameless case above does not
    // reach — that one is matched on cdkd-authored MESSAGE text. Measured:
    // deleting `if (err instanceof IntrinsicResolutionRefusalError) return true`
    // left every other case in this file GREEN, so without this the class arm
    // was unfenced and an `ssm-secure` refusal would become a skipped token.
    sendMock.mockImplementation(() =>
      // `ssm-secure` over a parameter AWS reports as a public `String`: the
      // resolver refuses by DECISION rather than failing to fetch.
      Promise.resolve({ Parameter: { Type: 'String', Value: 'public-config' } })
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: AbandonedResolution[] = [];

    await expect(
      resolver.resolveDynamicReferences(`{{resolve:ssm-secure:/public/p}}/${LIVE}`, {
        recordedSecretValues: new Map<string, string>(),
        abandonedResolutions,
      } as never)
    ).rejects.toThrow(/ssm-secure spelling is defined for SecureString/);

    expect(
      abandonedResolutions,
      'a deliberate refusal was RECORDED instead of re-raised, so the leaf continued past a ' +
        'decision the resolver took on purpose.'
    ).toHaveLength(0);
  });

  it('still ABORTS on a nameless reference, which is a refusal not a failed fetch', async () => {
    // `{{resolve:secretsmanager:}}` is a structurally broken template, and no
    // substitution produces one. go-to-k/cdkd#2692 made scrub refuse on it;
    // recovering from it here would silently downgrade that to a skipped token.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: AbandonedResolution[] = [];

    await expect(
      resolver.resolveDynamicReferences(`{{resolve:secretsmanager:}}/${LIVE}`, {
        recordedSecretValues: new Map<string, string>(),
        abandonedResolutions,
      } as never)
    ).rejects.toThrow(/SECRET_ID is required/);

    expect(
      abandonedResolutions,
      'the nameless refusal was RECORDED instead of re-raised, so a consumer that relies on it ' +
        'aborting would report success over a broken template.'
    ).toHaveLength(0);
  });

  it('does NOT read a nameless-refusal marker out of a FETCH failure that merely quotes it', async () => {
    // The `Dynamic reference: ` prefix half of the partition, which has no
    // other case. A secret id is template-assembled, so AWS's own rejection
    // echoes back whatever it was handed — and a parameter or secret NAMED
    // `SECRET_ID is required` puts the bare marker inside a message this repo
    // did not write. Matching the tail alone would read that as a refusal,
    // disarm recovery for the leaf, and restore the exact loss #3181 removes.
    sendMock.mockImplementation((cmd: { __type: string }) =>
      cmd.__type === 'GetParameter'
        ? Promise.reject(
            Object.assign(
              new Error("Parameter /app/SECRET_ID is required but was not found."),
              { name: 'ParameterNotFound' }
            )
          )
        : Promise.resolve({ SecretString: JSON.stringify({ password: LIVE_PLAINTEXT }) })
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolveDynamicReferences(
      `{{resolve:ssm-secure:/app/SECRET_ID is required}}/${LIVE}`,
      { recordedSecretValues, abandonedResolutions } as never
    );

    expect(
      [...recordedSecretValues.keys()],
      'an AWS FETCH failure quoting the marker was treated as a deliberate refusal, so the ' +
        'walk aborted and the live reference after it recorded no needle.'
    ).toContain(LIVE_PLAINTEXT);
    expect(abandonedResolutions).toHaveLength(1);
  });

  it('recovers per KEY, so a failing sibling key no longer abandons a live reference', async () => {
    // go-to-k/cdkd#3218, VERBATIM, and it is a separate mechanism from every
    // case above: `A` fails inside `resolveRef`, which is not a token failure
    // at all, so the per-token `try` never runs for it. Before the per-key
    // `try` the object walk was a bare `for … await` and `B` was never
    // reached — recording no needle, which is the only thing that drives
    // redaction.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolve(
      { Environment: { Variables: { A: { Ref: 'NoSuchThing' }, B: LIVE } } },
      { recordedSecretValues, abandonedResolutions } as never
    );

    expect(
      [...recordedSecretValues.keys()],
      "the live reference in sibling key 'B' recorded no needle because key 'A' aborted the " +
        'walk, so a stored plaintext for it would survive every redaction pass ' +
        '(go-to-k/cdkd#3218).'
    ).toContain(LIVE_PLAINTEXT);

    expect(abandonedResolutions).toHaveLength(1);
    expect(abandonedResolutions[0]!.unit).toBe('key');
    expect(abandonedResolutions[0]!.subject).toBe('A');
    // THE SEAM. `cdkd scrub`'s exit-code gate is computed from these two
    // booleans and nothing else, and the scrub-side tests supply them by hand
    // — so without this assertion the RESOLVER's half is unfenced. Measured:
    // hard-coding `carriedDynamicReference: false` at the push site left 208
    // of 208 tests across every bag-touching file GREEN, while making
    // `--dry-run --fail` exit 0 over every surviving plaintext.
    //
    // This key's value is `{"Ref": ...}` — no reference of its own — which is
    // exactly why go-to-k/cdkd#3218's repro must not count.
    expect(abandonedResolutions[0]!.carriedDynamicReference).toBe(false);
    expect(abandonedResolutions[0]!.carriedFetchableReference).toBe(false);
  });

  it('computes the gate booleans from the unit that actually failed', () => {
    // The positive side of the seam above, kept as its own case so the two
    // directions cannot be satisfied by one hard-coded value. A failing TOKEN
    // is a reference, and a fetchable one, so both booleans must be true —
    // that is what makes it COUNT and gate `--dry-run --fail`.
    expect.assertions(3);
    return (async (): Promise<void> => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const abandonedResolutions: AbandonedResolution[] = [];
      await resolver.resolveDynamicReferences(`${DELETED}/${LIVE}`, {
        recordedSecretValues: new Map<string, string>(),
        abandonedResolutions,
      } as never);
      expect(abandonedResolutions).toHaveLength(1);
      expect(abandonedResolutions[0]!.carriedDynamicReference).toBe(true);
      expect(abandonedResolutions[0]!.carriedFetchableReference).toBe(true);
    })();
  });

  it("recovers per key in Fn::Sub's variable map too, not only in a property bag", async () => {
    // The sibling site, found beside go-to-k/cdkd#3218's: `resolveSub`'s
    // variable-map walk had the identical bare `for … await`. Pinned
    // separately because it is a DIFFERENT loop — fixing one does not fix the
    // other, and a shared helper is only shared while both call it.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolve(
      { 'Fn::Sub': ['${A}/${B}', { A: { Ref: 'NoSuchThing' }, B: LIVE }] },
      { recordedSecretValues, abandonedResolutions } as never
    );

    expect([...recordedSecretValues.keys()]).toContain(LIVE_PLAINTEXT);
    expect(abandonedResolutions.map((e) => [e.unit, e.subject])).toEqual([['key', 'A']]);
  });

  it('recovers from a token in the MIDDLE, proving the walk RESUMES rather than merely not aborting', async () => {
    // Both original fixtures fail on token 1 of 2, which is satisfied by a
    // loop that simply does not abort. Failing in the middle is what
    // distinguishes `continue` from `break`: the token AFTER the failure must
    // still be fetched.
    const FIRST = '{{resolve:secretsmanager:prod/first:SecretString:password}}';
    const firstPlaintext = 'first-secret-value';
    sendMock.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) => {
      if (cmd.__type === 'GetParameter') {
        return Promise.reject(
          Object.assign(new Error('Parameter /deleted/param not found.'), {
            name: 'ParameterNotFound',
          })
        );
      }
      return Promise.resolve({
        SecretString: JSON.stringify({
          password: String(cmd.input['SecretId']).includes('first')
            ? firstPlaintext
            : LIVE_PLAINTEXT,
        }),
      });
    });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolveDynamicReferences(`${FIRST}/${DELETED}/${LIVE}`, {
      recordedSecretValues,
      abandonedResolutions,
    } as never);

    const keys = [...recordedSecretValues.keys()];
    expect(keys, 'the token BEFORE the failure was not recorded').toContain(firstPlaintext);
    expect(keys, 'the token AFTER the failure was not recorded, so the walk stopped there').toContain(
      LIVE_PLAINTEXT
    );
    expect(abandonedResolutions).toHaveLength(1);
  });

  it('records a needle for a live reference beside a failing one in an ARRAY leaf', async () => {
    // The array arm goes through `allSettledKeepingFirstRejection`, which
    // settles every element before rethrowing — so it was ALREADY safe, and
    // this pins that it stays so. Without the bag it still rejects; with one
    // the sibling's needle is recorded either way, which is the property that
    // matters for redaction.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolve([DELETED, LIVE], {
      recordedSecretValues,
      abandonedResolutions,
    } as never);

    expect([...recordedSecretValues.keys()]).toContain(LIVE_PLAINTEXT);
  });

  it('recovers from a failed fetch on an ARN-FORM token, which names its own region', async () => {
    // An ARN-form token states its own region, which is the shape that can be
    // handed to a region-pinned SIBLING resolver.
    //
    // WHAT THIS COVERS, stated after two wrong readings of it.
    //
    // The sibling arm IS entered: `classifyReplaySecretRegion` verdicts an
    // ARN naming another region as `named-region`, and the region-pinned
    // sibling performs the fetch. An earlier revision of this comment said the
    // parent resolved the token itself with no delegation — that was measured
    // wrong (a marker pushed inside the `named-region` arm reds this case).
    //
    // Stripping `abandonedResolutions` from the SIBLING's context still reds
    // nothing, and the reason is benign rather than a gap: the sibling's throw
    // propagates into the PARENT's token-loop catch, which records an
    // equivalent entry. So the sibling's own bag is genuinely unobservable
    // from here — not untested, but unobservable — and the recovery the caller
    // sees is the parent's. Do not read a bag-strip probe's green as evidence
    // that this arm is unexercised.
    const ARN =
      '{{resolve:secretsmanager:arn:aws:secretsmanager:eu-west-1:111122223333:secret:gone-AbCdEf:SecretString:password}}';
    sendMock.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) =>
      String(cmd.input['SecretId'] ?? '').includes('gone')
        ? Promise.reject(
            Object.assign(new Error('Secrets Manager cannot find the specified secret.'), {
              name: 'ResourceNotFoundException',
            })
          )
        : Promise.resolve({ SecretString: JSON.stringify({ password: LIVE_PLAINTEXT }) })
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: AbandonedResolution[] = [];

    await resolver.resolveDynamicReferences(`${ARN}/${LIVE}`, {
      recordedSecretValues,
      abandonedResolutions,
    } as never);

    // The ARN token's failure was RECORDED, not thrown...
    expect(
      abandonedResolutions,
      "the ARN-form token's failed fetch was not recorded, so the leaf aborted on it."
    ).toHaveLength(1);
    // ...and the walk went on to fetch the token behind it.
    expect([...recordedSecretValues.keys()]).toContain(LIVE_PLAINTEXT);
  });

  it('keeps ABORTING for a region a client cannot safely be built for', async () => {
    // An ARN-spelled reference names its own region, and
    // `resolverForProducerRegion` applies no `isClientSafeRegion` gate of its
    // own before the guest re-enters `clientsForRegion` — so with a bag in
    // hand this guard was reachable as a PLAIN Error and would have been
    // recorded as an unfetched token and walked past. Its subject is a region
    // substituted into an AWS service HOSTNAME, so it must abort.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: AbandonedResolution[] = [];

    await expect(
      resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1.evil:111122223333:secret:s}}',
        { recordedSecretValues: new Map<string, string>(), abandonedResolutions } as never
      )
    ).rejects.toThrow(/not a valid AWS region name/);

    expect(
      abandonedResolutions,
      'a hostname-substitution refusal was RECORDED instead of re-raised.'
    ).toHaveLength(0);
  });
});
