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
      // The id ASSEMBLED from the password resolves to a real secret that
      // carries only a binary value. Measured: without this arm the lookup
      // fails with the SDK's `ResourceNotFoundException`, which names nothing
      // — so the id-position case would assert against a message that never
      // had a plaintext in it, and would pass on unmasked code too.
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

/** The sub-floor twin of `ECHOING_PROPERTY`, against the short secret. */
const SHORT_ECHOING_PROPERTY = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:${SHORT_SECRET_ID}:SecretString:\${Pw}}}`,
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

  it('the resolver genuinely echoes the plaintext — the premise this file rests on', async () => {
    // Measured at the resolver, not asserted from the fix's own output: if the
    // message never carried the password, every case below would pass against
    // an unmasked build too. Reached by resolving the same shape directly.
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
      'the resolver echoes the resolved password as the missing JSON key'
    ).toContain(PASSWORD);
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

  it('RESIDUAL, pinned rather than only described: a sub-floor plaintext still prints', async () => {
    // `import.ts`'s residual 1. `buildNeedleRegex` filters a needle shorter
    // than `MIN_NEEDLE_LENGTH` (4), and the plaintext is EMBEDDED here rather
    // than being the whole string, so the whole-value arm does not apply
    // either. Asserted so the day the floor changes, this reds and the comment
    // gets revisited — the repo pins this boundary at the SITE in every other
    // masking test rather than leaving it as prose.
    await runWalk({ Password: SHORT_ECHOING_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'a sub-floor plaintext is NOT masked — this is the documented residual').toContain(
      SHORT_PASSWORD
    );
  });
});
