/**
 * Issue #2803: `cdkd import` reported an intrinsic-resolution failure with the
 * resolver's error text UNMASKED. Its per-resource secrets bag was declared
 * INSIDE the `try` that calls `resolver.resolve(...)`, so the `catch` could not
 * name it, and the warn interpolated `err.message` verbatim at default
 * verbosity — in the command whose stated contract is to persist the
 * `{{resolve:...}}` EXPRESSION and never the value.
 *
 * Another instance of one class — NOT the third of that SHAPE, which the rule
 * file says in as many words: issue #2728 fixed
 * `DeployEngine.handleOutputResolutionFailure`, and `rollback-executor.ts` and
 * `drift.ts` already hoist their bags above the `try` for the same reason and
 * say so at their own declarations. Import was the site that had been MISSED.
 *
 * WHY THE REAL RESOLVER, NOT A MOCKED ONE. The exposure depends on what the
 * resolver ECHOES, so a fake that throws a message with a plaintext in it would
 * be manufacturing the very thing under test. The shape below is one the
 * resolver builds itself, and is the same one issue #2728's reachability case
 * uses: an `Fn::Sub` whose variable resolves the secret's `password` key, and
 * whose body uses that VALUE as the JSON key of a second reference to the same
 * secret. The second lookup SUCCEEDS and then fails to find the key, so the
 * resolver's own `key '<password>' not found in secret '<id>'` carries the
 * plaintext the same walk just recorded into the bag.
 *
 * `cdkd import` sets no `skipDynamicReferences`, so the resolve genuinely
 * decrypts — which is what makes this reachable here and not, say, in the
 * `cdkd diff` resolve contexts that do set it.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const SECRET_ID = 'cdkd-import-mask-probe';
const PASSWORD = 'Zk7pQw2mVx';
/** Below `MIN_NEEDLE_LENGTH` (4) — the documented residual's subject. */
const SHORT_SECRET_ID = 'cdkd-import-mask-short';
const SHORT_PASSWORD = 'ab3';
/**
 * Its own secret, and its own plaintext, so the AccessDenied arm cannot be
 * satisfied by another case's needle: the id assembled from THIS password is
 * the one the fake refuses.
 */
const DENIED_SECRET_ID = 'cdkd-import-mask-denied';
const DENIED_PASSWORD = 'Qr4tYu8iOp';
/** Recorded by one resource, and a coincidental substring of ANOTHER's literal. */
const NEIGHBOUR_LITERAL = `queue-${PASSWORD}`;

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: {
      input?: { SecretId?: string };
      constructor: { name: string };
    }): Promise<unknown> {
      if (command.constructor.name !== 'GetSecretValueCommand') {
        throw new Error(`unexpected Secrets Manager command ${command.constructor.name}`);
      }
      if (command.input?.SecretId === SHORT_SECRET_ID) {
        return { SecretString: JSON.stringify({ password: SHORT_PASSWORD }) };
      }
      if (command.input?.SecretId === DENIED_SECRET_ID) {
        return { SecretString: JSON.stringify({ password: DENIED_PASSWORD }) };
      }
      // The SDK-error population the resolver's own throw-site mask cannot
      // reach: raised inside `send`, so nothing in the resolver interpolates
      // it and nothing there masks it. The wording is IAM's, and it quotes the
      // RESOURCE — which for an assembled id IS the decrypted plaintext.
      if (command.input?.SecretId === DENIED_PASSWORD) {
        const denied = new Error(
          `User: arn:aws:iam::123456789012:user/cdkd is not authorized to perform: ` +
            `secretsmanager:GetSecretValue on resource: ${command.input.SecretId} ` +
            `because no identity-based policy allows the secretsmanager:GetSecretValue action`
        );
        denied.name = 'AccessDeniedException';
        throw denied;
      }
      // The id ASSEMBLED from the password resolves to a real secret that
      // carries only a binary value, which is what reaches the resolver's
      // `secret '<id>' does not contain a SecretString value` throw — the
      // second site this file pins. Without this arm the lookup takes the
      // SDK's `ResourceNotFoundException`, which names nothing: measured, the
      // id-position case then FAILS on the missing `***` rather than passing
      // vacuously, so the arm is load-bearing for REACHING the throw, not for
      // keeping the case honest.
      if (command.input?.SecretId === PASSWORD) {
        return { SecretBinary: new Uint8Array([1, 2, 3]) };
      }
      if (command.input?.SecretId !== SECRET_ID) {
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }
      return { SecretString: JSON.stringify({ username: 'cdkd-user', password: PASSWORD }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const { resolveImportedProperties } = await import('../../../src/cli/commands/import.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const ref = (jsonKey: string): string =>
  `{{resolve:secretsmanager:${SECRET_ID}:SecretString:${jsonKey}}}`;

/**
 * The `Fn::Sub` that makes the resolver echo its own input: `${Pw}` resolves to
 * the password, and the assembled body is then a second dynamic reference whose
 * JSON key IS that password.
 */
const ECHOING_PROPERTY = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${Pw}}}`,
    { Pw: ref('password') },
  ],
};

/**
 * The same trick with the plaintext in the SECRET ID position instead of the
 * JSON KEY position. It is not the same line twice: an assembled id that
 * RESOLVES to a secret carrying no `SecretString` reaches the resolver's
 * `secret '<id>' does not contain a SecretString value` throw, a different
 * site from the `key '<jsonKey>' not found` one above.
 */
const ID_ASSEMBLED_PROPERTY = {
  'Fn::Sub': [`{{resolve:secretsmanager:\${Pw}:SecretString:password}}`, { Pw: ref('password') }],
};

/**
 * The same assembly against `DENIED_SECRET_ID`, whose password the fake
 * refuses with an AccessDenied quoting the id — an error the RESOLVER never
 * builds, so only `import.ts`'s own mask stands between it and the terminal.
 */
const ID_ASSEMBLED_DENIED_PROPERTY = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:\${Pw}:SecretString:password}}`,
    { Pw: `{{resolve:secretsmanager:${DENIED_SECRET_ID}:SecretString:password}}` },
  ],
};

/**
 * The sub-floor twin of `ECHOING_PROPERTY`, against the short secret, with the
 * placeholder as the ENTIRE interpolated segment. Issue #2827 CLOSES this
 * shape: the resolver masks the raw `jsonKey`, which is the plaintext exactly,
 * so it reaches `maskSecretsInText`'s whole-value arm — the one arm with no
 * `MIN_NEEDLE_LENGTH` floor.
 */
const SHORT_WHOLE_SEGMENT_PROPERTY = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:${SHORT_SECRET_ID}:SecretString:\${Pw}}}`,
    { Pw: `{{resolve:secretsmanager:${SHORT_SECRET_ID}:SecretString:password}}` },
  ],
};

/**
 * The shape that stays open at ANY masker, and the reason issue #2827's
 * enumeration ends where it does (its comment 4 carries the measurement): ONE
 * literal character beside the placeholder makes the raw value a SUPERSTRING
 * of the plaintext, so the mask lands back on the substring arm and the
 * `MIN_NEEDLE_LENGTH` (4) floor drops the needle.
 */
const SHORT_SUPERSTRING_PROPERTY = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:${SHORT_SECRET_ID}:SecretString:key-\${Pw}}}`,
    { Pw: `{{resolve:secretsmanager:${SHORT_SECRET_ID}:SecretString:password}}` },
  ],
};

function makeState(
  properties: Record<string, unknown>,
  otherProperties?: Record<string, unknown>
): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'import-mask-stack',
    region: 'us-east-1',
    resources: {
      Res: {
        physicalId: 'res-phys',
        resourceType: 'AWS::SQS::Queue',
        properties,
      },
      ...(otherProperties && {
        Other: {
          physicalId: 'other-phys',
          resourceType: 'AWS::SQS::Queue',
          properties: otherProperties,
        },
      }),
    },
    outputs: {},
    lastModified: 0,
    // No `as unknown as` — the literal satisfies `StackState` on its own, so a
    // future required field reds here instead of being absorbed by a cast.
  } satisfies StackState;
}

const TEMPLATE: CloudFormationTemplate = {
  Resources: {
    Res: { Type: 'AWS::SQS::Queue', Properties: {} },
    Other: { Type: 'AWS::SQS::Queue', Properties: {} },
  },
};

/** Everything the warn spy was handed, joined — the sink under test. */
function warnedText(): string {
  return warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

async function runWalk(
  properties: Record<string, unknown>,
  otherProperties?: Record<string, unknown>
): Promise<StackState> {
  const state = makeState(properties, otherProperties);
  await resolveImportedProperties(
    state,
    TEMPLATE,
    'us-east-1',
    // The one cast that stays. `stateBackend` is only consulted for a
    // cross-stack read (`Fn::ImportValue` / `Fn::GetStackOutput`), and no
    // fixture here contains one — passing a stub would assert a call shape
    // nothing in this file exercises. A future case adding a cross-stack
    // reference gets a deref failure that `resolveImportedProperties`' own
    // catch turns into the warn under test, not a throw — so such a case must
    // assert on the resolved VALUE, not merely that the walk completed.
    undefined as never,
    getLogger()
  );
  return state;
}

describe('cdkd import masks the resolver error text it logs (issue #2803)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    debugSpy.mockClear();
  });

  it('the resolver reaches this throw AND masks it at the source — the premise, restated by issue #2827', async () => {
    // WHAT CHANGED. This case used to assert the opposite — that the
    // resolver's own message CARRIES the password — and that was the premise
    // the boundary mask below rested on. Issue #2827 fixed the PRODUCER end:
    // the resolver masks the raw `secretId` / `jsonKey` BEFORE interpolating
    // them, so the message that leaves the resolver is already masked and no
    // caller inherits the obligation. The assertion is inverted rather than
    // deleted, because the thing it is really pinning is unchanged: this shape
    // still REACHES the throw that used to leak, and that reachability is what
    // every case below depends on. A shape that stopped reaching it would make
    // them all vacuous, and the `not.toContain` alone cannot tell "masked"
    // from "never got there".
    //
    // The boundary mask this file is about is NOT made inert by that: it still
    // covers errors the resolver did not BUILD — the AccessDenied case further
    // down drives one, and that case is what discriminates `import.ts`'s own
    // mask now.
    const { IntrinsicFunctionResolver } = await import(
      '../../../src/deployment/intrinsic-function-resolver.js'
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const thrown = await resolver
      .resolve(ECHOING_PROPERTY, {
        template: TEMPLATE,
        resources: {},
        recordedSecretValues: new Map<string, string>(),
      } as never)
      .then(
        () => undefined,
        (reason: unknown) => reason
      );

    expect(thrown, 'the second lookup must fail, or there is no message').toBeInstanceOf(Error);
    expect(
      (thrown as Error).message,
      'the shape still reaches the not-found-key throw — otherwise every case below is vacuous'
    ).toContain(`not found in secret '${SECRET_ID}'`);
    expect(
      (thrown as Error).message,
      'and issue #2827 masks it at the throw, so the plaintext never leaves the resolver'
    ).not.toContain(PASSWORD);
    expect((thrown as Error).message, 'masked, not dropped').toContain('***');
  });

  it('the warn carries the mask, not the plaintext, and masks only the NEEDLE', async () => {
    await runWalk({ Password: ECHOING_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is still reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the plaintext must not reach the terminal').not.toContain(PASSWORD);
    expect(text, 'and it is masked rather than dropped').toContain('***');
    // THE CONTROL, and it has to live INSIDE the masked segment. Only
    // `err.message` is passed through `maskSecretsInText`; the logical id, the
    // resource type and the remedy sentence are concatenated OUTSIDE it, so
    // asserting those survives a `secrets.size > 0 -> mask the whole message`
    // regression untouched — measured, and it is why an earlier version of
    // this case was vacuous. This literal is part of the resolver's own
    // message and is not a needle, so it must survive.
    expect(text, 'the surrounding diagnosis inside the masked segment survives').toContain(
      `not found in secret '${SECRET_ID}'`
    );
    // The spans OUTSIDE the mask, folded in here rather than given their own
    // case. They ARE individually falsifiable — dropping the id/type prefix or
    // the remedy sentence reds this case (measured) — but no MASKING mutation
    // reaches them, since a working mask cannot swallow text it never sees. So
    // they belong beside the needle above, which is what makes the case read as
    // "this much survives, that much is masked", rather than standing alone as
    // a case no change to the thing under test can move.
    expect(text, 'the resource id is still named').toContain('Res');
    expect(text, 'the resource type is still named').toContain('AWS::SQS::Queue');
    expect(text, 'the remedy sentence survives').toContain('cdkd state orphan');
  });

  it('the resource keeps its raw intrinsic, so masking did not change the walk', async () => {
    const state = await runWalk({ Password: ECHOING_PROPERTY });

    expect(
      state.resources['Res']?.properties['Password'],
      'a failed resolution leaves the original shape in state'
    ).toEqual(ECHOING_PROPERTY);
  });

  it('a failure with NO secret recorded is reported verbatim', async () => {
    // The other end of the needle-set property: nothing was decrypted, so the
    // mask is a no-op and the message must not be degraded.
    await runWalk({ QueueName: { Ref: 'NoSuchResource' } });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the resolver names the missing resource').toContain('NoSuchResource');
    expect(text, 'with nothing recorded there is nothing to mask').not.toContain('***');
  });

  it('the SECRET-ID position reaches a DIFFERENT throw, and is masked there too', async () => {
    // The issue's verification plan named this shape beside the JSON-KEY one.
    // It is not redundant: an assembled SECRET ID lands on the resolver's
    // `secret '<id>' does not contain a SecretString value` throw, a different
    // site from the `key '<jsonKey>' not found` the case above drives. The
    // masking is position-agnostic, so this pins the SECOND site rather than
    // the same line twice.
    await runWalk({ Password: ID_ASSEMBLED_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the plaintext must not reach the terminal').not.toContain(PASSWORD);
    expect(text, 'masked, not dropped').toContain('***');
  });

  it('per-resource bags do not bleed: one resource failing does not mask another', async () => {
    // `import.ts` calls the fresh-per-resource map load-bearing — one shared
    // map would let resource A's plaintext rewrite resource B's coinciding
    // literal. With a single-resource fixture that claim is unfalsifiable:
    // hoisting the declaration OUT of the `for` reds nothing (measured). Two
    // resources make it real.
    const state = await runWalk({ Password: ECHOING_PROPERTY }, { QueueName: NEIGHBOUR_LITERAL });

    // Resource B resolves cleanly, and its literal happens to CONTAIN the
    // plaintext resource A recorded. With one shared bag, `redactSecretsForState`
    // would rewrite it to A's `{{resolve:...}}` expression. Its own bag is
    // empty, so it must survive byte-for-byte.
    expect(
      state.resources['Other']?.properties['QueueName'],
      "resource B's literal is not rewritten by resource A's needle"
    ).toBe(NEIGHBOUR_LITERAL);
  });

  it('CLOSED by issue #2827: a sub-floor plaintext that IS the whole segment is masked', async () => {
    // This case used to assert the plaintext printed. It does not any more,
    // and the mechanism is exactly the one issue #2827's comments 4-6 settled:
    // the resolver masks the RAW `jsonKey`, which here is `ab3` and nothing
    // else, so it reaches `maskSecretsInText`'s WHOLE-VALUE arm — the only arm
    // `buildNeedleRegex`'s `MIN_NEEDLE_LENGTH` (4) filter does not gate.
    // Masking the assembled MESSAGE, which is what the boundary does, closes
    // neither this nor its superstring twin below.
    await runWalk({ Password: SHORT_WHOLE_SEGMENT_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the sub-floor plaintext no longer prints').not.toContain(SHORT_PASSWORD);
    expect(text, 'masked, not dropped').toContain('***');
  });

  it('RESIDUAL, pinned rather than only described: a sub-floor plaintext INSIDE a longer segment still prints', async () => {
    // The bound issue #2827 stops at, and its counter-example verbatim: one
    // literal character beside the placeholder makes the raw value `key-ab3`,
    // a SUPERSTRING of the recorded `ab3`. A superstring is not a whole-value
    // match, so the mask falls to the substring arm and the floor drops the
    // needle — at the throw and at every boundary alike. Asserted so the day
    // `MIN_NEEDLE_LENGTH` changes, or a masker gains a sub-floor substring
    // arm, this reds and the enumeration gets revisited.
    await runWalk({ Password: SHORT_SUPERSTRING_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(
      text,
      'a sub-floor plaintext inside a longer segment is NOT masked — the documented residual'
    ).toContain(SHORT_PASSWORD);
  });

  it("import.ts's OWN mask still discriminates: an AWS error the resolver never built is masked here", async () => {
    // WHY THIS CASE EXISTS. With issue #2827 masking at the throw, every case
    // above would pass with `import.ts`'s boundary mask DELETED — the resolver
    // hands it an already-masked message. That would leave this file's actual
    // subject unfenced. An SDK rejection is the population the boundary still
    // owns: it is raised inside `client.send`, propagates through
    // `resolveDynamicReferences` untouched, and reaches the terminal only
    // through this catch.
    //
    // NOT a manufactured leak. The fake echoes `command.input.SecretId` in the
    // wording IAM actually uses (`... is not authorized to perform:
    // secretsmanager:GetSecretValue on resource: <resource>`), so the
    // plaintext is in the message because the RESOURCE NAME is, which is the
    // real behaviour for an id an `Fn::Sub` assembled out of a secret.
    // Measured: with the mask removed from `import.ts` this case reds and the
    // others do not.
    await runWalk({ Password: ID_ASSEMBLED_DENIED_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the AWS wording survives, so the mask is not a blanket').toContain(
      'is not authorized to perform'
    );
    expect(text, 'the plaintext must not reach the terminal').not.toContain(DENIED_PASSWORD);
    expect(text, 'masked, not dropped').toContain('***');
  });
});
