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
 * secret. Since issue #4266 that second reference is REFUSED before its
 * lookup (a `secretsmanager` token assembled from a secret), so the error the
 * walk reports is the resolver's own refusal, which names the assembled token
 * and is never sent to AWS. The resolver throws that run AFTER a lookup are
 * reached here through a plain `ssm` token instead, which is still looked up
 * on this route.
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
 * satisfied by another case's needle: the parameter name assembled from THIS
 * password is the one the SSM fake refuses.
 */
const DENIED_SECRET_ID = 'cdkd-import-mask-denied';
const DENIED_PASSWORD = 'Qr4tYu8iOp';
const DENIED_PARAMETER = `/app/${DENIED_PASSWORD}`;

/**
 * Every name a request CARRIED, so a case can say which lookups ran and, for a
 * reference assembled from a secret, that the plaintext was never sent.
 */
const sent = vi.hoisted(() => ({ secretIds: [] as string[], parameterNames: [] as string[] }));
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
      sent.secretIds.push(String(command.input?.SecretId));
      if (command.input?.SecretId === SHORT_SECRET_ID) {
        return { SecretString: JSON.stringify({ password: SHORT_PASSWORD }) };
      }
      if (command.input?.SecretId === DENIED_SECRET_ID) {
        return { SecretString: JSON.stringify({ password: DENIED_PASSWORD }) };
      }
      // No arm answers an id ASSEMBLED from a plaintext: since issue #4266 no
      // such id is sent, and the cases assert that on `sent.secretIds`.
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

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSSMClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: {
      input?: { Name?: string };
      constructor: { name: string };
    }): Promise<unknown> {
      if (command.constructor.name !== 'GetParameterCommand') {
        throw new Error(`unexpected SSM command ${command.constructor.name}`);
      }
      const name = String(command.input?.Name);
      sent.parameterNames.push(name);
      // The population the resolver's masks cannot reach: a rejection that is
      // NOT an `Error` instance. `maskSecretsInError` returns a non-`Error`
      // unchanged, so the resolver forwards it as it came, and only
      // `import.ts`'s `maskSecretsInText(String(err), ...)` stands between it
      // and the terminal. The wording is IAM's, and it quotes the RESOURCE,
      // which for an assembled name IS the decrypted plaintext.
      if (name === DENIED_PARAMETER) {
        throw (
          `AccessDeniedException: User: arn:aws:iam::123456789012:user/cdkd is not authorized ` +
          `to perform: ssm:GetParameter on resource: ${name} because no identity-based policy ` +
          `allows the ssm:GetParameter action`
        );
      }
      // Every other name answers with no value, which reaches the resolver's
      // own `SSM parameter '<name>' not found or has no value` throw: one that
      // runs AFTER the lookup and interpolates the assembled name.
      return { Parameter: {} };
    }
    destroy(): void {}
  }
  return { ...actual, SSMClient: FakeSSMClient };
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
 * JSON KEY position: the position whose lookup would SEND the plaintext to AWS
 * as the `SecretId`, which issue #4266 refuses before the lookup.
 */
const ID_ASSEMBLED_PROPERTY = {
  'Fn::Sub': [`{{resolve:secretsmanager:\${Pw}:SecretString:password}}`, { Pw: ref('password') }],
};

/**
 * A plain `ssm` name assembled from `DENIED_SECRET_ID`'s password. Plain `ssm`
 * is still looked up on this route (only its `Type` says whether it is a
 * secret), and the SSM fake refuses the name with a NON-`Error` rejection
 * quoting it: one the RESOLVER never builds and does not mask, so only
 * `import.ts`'s own mask stands between it and the terminal.
 */
const NAME_ASSEMBLED_DENIED_PROPERTY = {
  'Fn::Sub': [
    '{{resolve:ssm:/app/${Pw}}}',
    { Pw: `{{resolve:secretsmanager:${DENIED_SECRET_ID}:SecretString:password}}` },
  ],
};

/**
 * A sub-floor plaintext as the ENTIRE name of a plain `ssm` reference, which is
 * still looked up and reaches the resolver's `SSM parameter '<name>' not found`
 * throw. Issue #2827 CLOSES this shape: the resolver masks the raw name, which
 * is the plaintext exactly, so no `MIN_NEEDLE_LENGTH` needle is needed. (The
 * `secretsmanager` spelling of this shape is refused before its lookup since
 * issue #4266, and reaches no such throw.)
 */
const SHORT_WHOLE_SEGMENT_PROPERTY = {
  'Fn::Sub': [
    '{{resolve:ssm:${Pw}}}',
    { Pw: `{{resolve:secretsmanager:${SHORT_SECRET_ID}:SecretString:password}}` },
  ],
};

/**
 * The shape issue #2827's needle masks could not close (its comment 4 carries
 * the measurement): ONE literal character beside the placeholder makes the raw
 * name a SUPERSTRING of the plaintext, so a needle mask lands on the substring
 * arm and the `MIN_NEEDLE_LENGTH` (4) floor drops the needle. Issue #3150 closes
 * it by POSITION (the case below).
 */
const SHORT_SUPERSTRING_PROPERTY = {
  'Fn::Sub': [
    '{{resolve:ssm:key-${Pw}}}',
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

/** Every debug line, for the "the plaintext is nowhere" assertions. */
function debugText(): string {
  return debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

/** The opening of the issue #4266 refusal, as the resolver words it. */
const REFUSAL =
  /Refusing to resolve \{\{resolve:secretsmanager:[^}]*\}\}: the reference was assembled from a secret value/;

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
    sent.secretIds.length = 0;
    sent.parameterNames.length = 0;
  });

  it('the resolver reaches this throw AND masks it at the source — the premise, restated by issues #2827 and #4266', async () => {
    // WHAT CHANGED, twice. This case first asserted that the resolver's own
    // message CARRIES the password, the premise the boundary mask below
    // rested on. Issue #2827 fixed the PRODUCER end, so the message leaves the
    // resolver masked. Issue #4266 then moved WHICH throw this shape reaches:
    // the assembled `secretsmanager` reference is refused before its lookup,
    // so the walk now fails on the resolver's own refusal rather than on the
    // `key '<jsonKey>' not found` throw after a second lookup (that throw's
    // own mask is pinned in `intrinsic-resolver-throw-masking.test.ts`,
    // reached through the persisted route). What the case pins is unchanged:
    // this shape REACHES a resolver throw naming the assembled token, which is
    // what every case below depends on, and the `not.toContain` alone cannot
    // tell "masked" from "never got there".
    //
    // The boundary mask this file is about is NOT made inert by that: it still
    // covers errors the resolver did not BUILD. The non-`Error` rejection case
    // at the end drives one, and that case is what discriminates `import.ts`'s
    // own mask.
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

    expect(thrown, 'the assembled reference must be refused, or there is no message').toBeInstanceOf(
      Error
    );
    expect(
      (thrown as Error).message,
      'the shape reaches the issue #4266 refusal — otherwise every case below is vacuous'
    ).toMatch(REFUSAL);
    expect(
      (thrown as Error).message,
      'the token is named, with only the needle masked inside it'
    ).toContain(`{{resolve:secretsmanager:${SECRET_ID}:SecretString:***}}`);
    expect(
      (thrown as Error).message,
      'and it is masked at the throw, so the plaintext never leaves the resolver'
    ).not.toContain(PASSWORD);
    expect(
      sent.secretIds,
      'ONE lookup, for the variable: the assembled reference was refused before its own'
    ).toEqual([SECRET_ID]);
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
      `{{resolve:secretsmanager:${SECRET_ID}:SecretString:***}}: the reference was assembled from a secret value`
    );
    // Nowhere else either: the debug echo, and the request that would have
    // carried it. The assembled reference is refused before its lookup (issue
    // #4266), so the only Secrets Manager call is the variable's.
    expect(debugText(), 'the plaintext must not reach the debug log').not.toContain(PASSWORD);
    expect(sent.secretIds, 'the assembled reference was never looked up').toEqual([SECRET_ID]);
    // The spans OUTSIDE the mask, folded in here rather than given their own
    // case. They ARE individually falsifiable — dropping the id/type prefix or
    // the remedy sentence reds this case (measured) — but no MASKING mutation
    // reaches them, since a working mask cannot swallow text it never sees. So
    // they belong beside the needle above, which is what makes the case read as
    // "this much survives, that much is masked", rather than standing alone as
    // a case no change to the thing under test can move.
    expect(text, 'the resource id is still named').toContain('Res');
    expect(text, 'the resource type is still named').toContain('AWS::SQS::Queue');
    expect(text, 'the remedy sentence survives').toContain(
      "remove this resource from state with 'cdkd orphan <StackPath>/<Path/To/Resource>'"
    );
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

  it('the SECRET-ID position is refused before its lookup, so the plaintext is neither printed nor SENT', async () => {
    // The issue's verification plan named this shape beside the JSON-KEY one.
    // It used to reach the resolver's `secret '<id>' does not contain a
    // SecretString value` throw, AFTER a `GetSecretValue` whose `SecretId` was
    // the plaintext. Since issue #4266 it is refused before that lookup; the
    // throw's own mask is pinned in `intrinsic-resolver-throw-masking.test.ts`
    // through the persisted route, which still reaches it. What this position
    // adds here is the request: the id IS the plaintext, so the lookup it no
    // longer makes is the disclosure #4266 closes.
    await runWalk({ Password: ID_ASSEMBLED_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'as the issue #4266 refusal').toMatch(REFUSAL);
    expect(text, 'the plaintext must not reach the terminal').not.toContain(PASSWORD);
    expect(text, 'masked, not dropped').toContain('{{resolve:secretsmanager:***:SecretString:password}}');
    expect(sent.secretIds, 'the plaintext was never sent as a SecretId').toEqual([SECRET_ID]);
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
    // This case used to assert the plaintext printed. It does not any more:
    // the resolver masks the RAW parameter name, which here is `ab3` and
    // nothing else, before interpolating it (issue #2827's comments 4-6), so
    // no needle at or above `MIN_NEEDLE_LENGTH` (4) is needed. Masking the
    // assembled MESSAGE, which is what the boundary does, closes neither this
    // nor its superstring twin below (which issue #3150 closes by position).
    //
    // A plain `ssm` reference since issue #4266: the `secretsmanager` spelling
    // of this shape is now refused before its lookup and never reaches a
    // throw that interpolates the name after one.
    await runWalk({ Password: SHORT_WHOLE_SEGMENT_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the sub-floor plaintext no longer prints').not.toContain(SHORT_PASSWORD);
    expect(text, 'masked at the after-lookup throw, not dropped').toContain(
      "SSM parameter '***' not found or has no value"
    );
    expect(sent.parameterNames, 'the premise: the plain ssm lookup ran').toEqual([SHORT_PASSWORD]);
  });

  it('CLOSED by issue #3150: a sub-floor plaintext INSIDE a longer segment is masked', async () => {
    // This case used to pin the bound issue #2827 stopped at: one literal
    // character beside the placeholder makes the raw name `key-ab3`, a
    // SUPERSTRING of the recorded `ab3`, which the needle mask's substring arm
    // drops below `MIN_NEEDLE_LENGTH`. Issue #3150 closes it by POSITION, not by
    // the needle: `resolveSub` hands the dynamic-reference loop the token's log
    // twin, and the name parsed out of the token prints the twin's run over the
    // same `:`-separated pieces (`key-***`). The needle floor itself is
    // unchanged. A plain `ssm` reference since issue #4266, for the reason the
    // whole-segment case above gives.
    await runWalk({ Password: SHORT_SUPERSTRING_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the sub-floor plaintext no longer prints').not.toContain(SHORT_PASSWORD);
    expect(text, 'masked at its position, not dropped').toContain(
      "SSM parameter 'key-***' not found or has no value"
    );
    expect(sent.parameterNames, 'the premise: the plain ssm lookup ran').toEqual([
      `key-${SHORT_PASSWORD}`,
    ]);
  });

  it("import.ts's OWN mask still discriminates: an AWS error the resolver never built is masked here", async () => {
    // WHY THIS CASE EXISTS. With issue #2827 masking at the throw, every case
    // above would pass with `import.ts`'s boundary mask DELETED: the resolver
    // hands it an already-masked message. That would leave this file's actual
    // subject unfenced. So would an ordinary SDK `Error`: since issue #3171
    // `sendWithThrottleRetry` masks the rejection it rethrows, by position and
    // by needle, so the earlier fixture here (an AccessDenied `Error`) stopped
    // discriminating then (measured: green with the boundary mask deleted).
    // The population the boundary still owns alone is a rejection that is NOT
    // an `Error` instance: `maskSecretsInError` returns it untouched, it
    // propagates through `resolveDynamicReferences` as it came, and reaches the
    // terminal only through this catch's `String(err)`.
    //
    // NOT a manufactured leak. The fake echoes `command.input.Name` in the
    // wording IAM actually uses (`... is not authorized to perform:
    // ssm:GetParameter on resource: <resource>`), so the plaintext is in the
    // message because the RESOURCE NAME is, which is the real behaviour for a
    // name an `Fn::Sub` assembled out of a secret. A plain `ssm` reference,
    // because the assembled `secretsmanager` one is refused before its lookup
    // since issue #4266 and so is never rejected by AWS at all.
    await runWalk({ Password: NAME_ASSEMBLED_DENIED_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the AWS wording survives, so the mask is not a blanket').toContain(
      'is not authorized to perform: ssm:GetParameter on resource: /app/***'
    );
    expect(text, 'the plaintext must not reach the terminal').not.toContain(DENIED_PASSWORD);
    expect(sent.parameterNames, 'the premise: the lookup ran and was refused').toEqual([
      DENIED_PARAMETER,
    ]);
  });
});
