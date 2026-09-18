import { describe, it, expect, vi } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * `Fn::GetStackOutput`'s messages strip control characters from the NAMES, not
 * only from the `RoleArn` beside them.
 *
 * Issue [#3397](https://github.com/go-to-k/cdkd/issues/3397) sanitized the
 * `RoleArn` on four of this method's lines. go-to-k/cdkd#3408's security review
 * then measured the operand IMMEDIATELY LEFT of it still going out raw: driving
 * `resolveGetStackOutput` with `StackName = "Prod\x1b[2K\rEvil"` emitted a
 * throw containing a live `ESC[2K` and a live CR — a line that erases and
 * rewrites itself in the terminal. That is the SAME shape the issue is about
 * ("the guard defeated by its own neighbour"), in the file the fix's own PR
 * called its flagship.
 *
 * The cause was a real distinction rather than an oversight: `loggedStackName`
 * and `loggedOutputName` went through `maskSecretsForLog`, which answers "does
 * this text contain a RECORDED SECRET" and makes no claim about control
 * characters. Both names are template-derived through `resolveValue` with only
 * a non-empty-string gate in front of them, so nothing else was going to.
 *
 * ## Why a behavioural test rather than a source-shape one
 *
 * A `src.includes('maskThenStripThenMask')` check would pass while the binding
 * fed only ONE of the four renders, and would say nothing about what reaches a
 * terminal. These cases read the thrown MESSAGE and assert on its BYTES, which
 * is the property an operator actually depends on. The mixed-render arm of
 * `tests/unit/cli/local-profile-display-population.test.ts` would be the
 * mechanical guard, but `src/deployment/` is outside its scope
 * (go-to-k/cdkd#3405), so until that widening lands this file IS the guard.
 */

/**
 * The CloudFormation client the DEFAULT path reaches. Mocked to REJECT with a
 * message that echoes the submitted stack name, which is what `DescribeStacks`
 * really does — and which is the whole reason the warn's AWS text is bounded
 * and sanitized beside the name.
 */
const cfnSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: cfnSend,
      destroy: vi.fn(),
      config: { region: () => 'us-east-1' },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** A state backend holding exactly the stacks given, and nothing else. */
function makeBackend(
  stacks: Array<{ stackName: string; region: string; outputs: Record<string, unknown> }>
): S3StateBackend {
  return {
    listStacks: vi.fn(async () => stacks.map((s) => ({ stackName: s.stackName, region: s.region }))),
    getState: vi.fn(async (stackName: string, region: string) => {
      const found = stacks.find((s) => s.stackName === stackName && s.region === region);
      if (!found) return null;
      return {
        state: {
          version: 8,
          stackName: found.stackName,
          region: found.region,
          resources: {},
          outputs: found.outputs,
          lastModified: 1,
        },
        etag: 'e',
      };
    }),
  } as unknown as S3StateBackend;
}

function buildContext(overrides: Partial<ResolverContext>): ResolverContext {
  const template: CloudFormationTemplate = { Resources: {} };
  return { template, resources: {}, stackName: 'Consumer', ...overrides };
}

/**
 * The needles, and why each one.
 *
 * `ESC[2K` erases the line the cursor is on and CR returns the cursor to its
 * start, so the pair together REPLACES whatever cdkd already printed — the
 * mechanism, not a decorative escape. They are asserted separately because a
 * repair that handles only C0 (CR) or only ESC would otherwise read as
 * complete.
 */
const ESC = String.fromCharCode(0x1b);
const HOSTILE = `Prod${ESC}[2K\rEvil`;

/**
 * A control character the DENYLIST reaches but a naive `[\x00-\x1f]` pass does
 * not: U+0085 (NEL), which xterm treats as a line break in UTF-8. Included so
 * the case is a statement about the shared sanitizer's class rather than about
 * two bytes someone happened to think of.
 */
const NEL = String.fromCharCode(0x85);
const HOSTILE_NEL = `Prod${NEL}Evil`;

describe('Fn::GetStackOutput strips control characters from the NAMES (issue #3397 review)', () => {
  it('the not-found throw carries no raw ESC or CR from a hostile StackName', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve(
        { 'Fn::GetStackOutput': { StackName: HOSTILE, OutputName: 'ApiUrl' } },
        buildContext({ stateBackend: makeBackend([]) })
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err, 'the resolve was expected to REFUSE; a resolved value proves nothing').toBeDefined();
    const message = String(err?.message ?? '');

    // The message must still IDENTIFY the stack -- a sanitizer that emptied it
    // would satisfy every byte assertion below while making the error useless.
    expect(message).toContain('Fn::GetStackOutput');
    expect(message).toContain('Prod');
    expect(message).toContain('Evil');

    // ...and carry none of the mechanism.
    expect(message, 'a raw ESC reached the message').not.toContain(ESC);
    expect(message, 'a raw CR reached the message').not.toContain('\r');
  });

  it('the output-not-found throw strips a hostile OutputName too', async () => {
    // The SECOND binding. `loggedStackName` and `loggedOutputName` are separate
    // assignments, so fixing one leaves the other -- exactly the per-site drift
    // this class keeps recurring through. Reached by a producer that EXISTS but
    // lacks the output, which is a different throw from the case above.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve(
        { 'Fn::GetStackOutput': { StackName: 'Upstream', OutputName: HOSTILE } },
        buildContext({
          stateBackend: makeBackend([
            // NOT named `Producer`: that string CONTAINS `Prod`, so the
            // "still identifies" assertion below passed even when the hostile
            // OUTPUT name rendered empty -- the exact bound case 1 has and this
            // one lacked (go-to-k/cdkd#3408 round 2).
            { stackName: 'Upstream', region: 'us-east-1', outputs: { Other: 'v' } },
          ]),
        })
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err).toBeDefined();
    const message = String(err?.message ?? '');
    // Anchored to the OUTPUT position, so an emptied `loggedOutputName` fails
    // here rather than being satisfied by the stack name beside it.
    expect(message).toContain("output 'Prod");
    expect(message).toContain('Evil');
    expect(message, 'a raw ESC reached the message').not.toContain(ESC);
    expect(message, 'a raw CR reached the message').not.toContain('\r');
  });

  it('strips the WIDER class, not just C0 -- U+0085 too', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve(
        { 'Fn::GetStackOutput': { StackName: HOSTILE_NEL, OutputName: 'ApiUrl' } },
        buildContext({ stateBackend: makeBackend([]) })
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err).toBeDefined();
    const message = String(err?.message ?? '');
    expect(message).toContain('Prod');
    // Anchored PAST the control character too: a sanitizer that TRUNCATED at it
    // rather than replacing it would satisfy the two assertions around this one
    // (round 2 nit).
    expect(message).toContain('Evil');
    expect(message, 'U+0085 reached the message; xterm reads it as a line break').not.toContain(
      NEL
    );
  });

  it('the SELF-REFERENCE refusal strips them too', async () => {
    // The fourth sink, and the one a mutation probe found unfenced after the
    // other three were closed (P29). It fires BEFORE `loggedStackName` is bound
    // and so cannot reuse that binding -- which is exactly why it was missed,
    // and why its own comment arguing that masking suffices had to go.
    //
    // Reached by naming the CONSUMER's own stack in the same region. Hostile
    // here means the user's own stack name, so this is the narrowest of the
    // four sinks; it is fenced anyway because it renders the same value class
    // five lines from a site that was just repaired.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve(
        { 'Fn::GetStackOutput': { StackName: HOSTILE, OutputName: 'ApiUrl' } },
        buildContext({ stateBackend: makeBackend([]), stackName: HOSTILE })
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err).toBeDefined();
    const message = String(err?.message ?? '');
    // BOUND THE ARM: without this the case is satisfied by the not-found throw
    // above, which is already fenced and would make this one vacuous.
    expect(message, 'the self-reference guard did not fire').toContain('cannot reference own stack');
    expect(message).toContain('Prod');
    expect(message).toContain('Evil');
    expect(message, 'a raw ESC reached the self-reference refusal').not.toContain(ESC);
    expect(message, 'a raw CR reached the self-reference refusal').not.toContain('\r');
  });

  it('leaves an ORDINARY stack name byte-identical', async () => {
    // The other direction, and the one that keeps this file from rewarding an
    // over-tightening repair: a sanitizer that mangled ordinary names would
    // pass every case above.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve(
        { 'Fn::GetStackOutput': { StackName: 'My-Prod.Stack_1', OutputName: 'Api/Url' } },
        buildContext({ stateBackend: makeBackend([]) })
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err).toBeDefined();
    expect(String(err?.message ?? '')).toContain("stack 'My-Prod.Stack_1' not found");
  });
});

/**
 * The DEFAULT path, which every case above deliberately opts out of.
 *
 * `cfnFallback` defaults to TRUE, so an ordinary `cdkd deploy` whose producer
 * is not in cdkd state reaches `lookupCfnStackOutputs` — and its failure is a
 * `logger.warn`, printed at DEFAULT verbosity. go-to-k/cdkd#3408 round 1 fixed
 * `resolveGetStackOutput`'s four throws and left that warn mask-only; round 2
 * measured it emitting a live `ESC[2K` + CR.
 *
 * The cases above could not have caught it: each passes `{ cfnFallback: false }`
 * to keep the CFn client out of a test about display, and that option is
 * exactly the switch between the two sinks. A fence that pins the option it is
 * supposed to range over cannot see the arm it excludes — so this block ranges
 * over it.
 */
describe('the CFn-fallback WARN strips control characters too (round 2 blocker)', () => {
  it('emits no raw ESC or CR when DescribeStacks fails on a hostile StackName', async () => {
    cfnSend.mockReset();
    cfnSend.mockRejectedValue(
      new Error(`ValidationError: Stack with id ${HOSTILE} does not exist`)
    );
    const warn = vi.fn();
    const logger = await import('../../../src/utils/logger.js');
    const got = logger.getLogger() as unknown as { warn: typeof warn };
    const previous = got.warn;
    got.warn = warn;

    try {
      // `cfnFallback` left at its DEFAULT. The CFn client is mocked to reject
      // with a message that ECHOES the submitted name, which is what
      // DescribeStacks really does.
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      await resolver
        .resolve(
          { 'Fn::GetStackOutput': { StackName: HOSTILE, OutputName: 'ApiUrl' } },
          buildContext({ stateBackend: makeBackend([]) })
        )
        .catch(() => undefined);

      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned, 'the CFn fallback warn never fired, so this case proves nothing').toContain(
        'CloudFormation DescribeStacks fallback failed'
      );
      expect(warned).toContain('Prod');
      expect(warned, 'a raw ESC reached the warn line').not.toContain(ESC);
      expect(warned, 'a raw CR reached the warn line').not.toContain('\r');
    } finally {
      got.warn = previous;
    }
  });
});
