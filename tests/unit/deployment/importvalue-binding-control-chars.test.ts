import { describe, it, expect, vi } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * The BINDING route: a masked value bound to a local and interpolated later
 * carries no control characters either.
 *
 * ## What this fences that its `Fn::GetStackOutput` sibling could not
 *
 * `getstackoutput-neighbour-control-chars.test.ts` pins the shape where the
 * masker is interpolated AT the render site. go-to-k/cdkd#3408 closed that
 * shape and its scanner forbade the spelling — and the class simply MOVED one
 * indirection out, to
 *
 *     const loggedExportName = this.<masker>(exportName, context);
 *     ...
 *     this.logger.warn(`... '${loggedExportName}' ...`);
 *
 * which a line-shaped scanner structurally cannot see. Ten such bindings
 * existed; go-to-k/cdkd#3426 measured `loggedExportName` reaching an
 * `Fn::ImportValue` warn AND throw with a live `ESC[2K` + CR, at DEFAULT
 * verbosity on the DEFAULT path, and closed the class by deleting the bare
 * masker's escaping spelling entirely.
 *
 * The cases below are BEHAVIOURAL for the same reason that file states: a
 * source-shape assertion passes while the binding feeds only one of the six
 * sites that read it, and says nothing about what reaches a terminal. The
 * SHAPE half — "no render may reach a masker that does not sanitize", judged
 * through the binding by an AST walk — is
 * `scripts/check-resolver-mask-coverage.ts` and its suite.
 */

/**
 * The SSM client the `{{resolve:ssm:...}}` case reaches. Mocked at the PACKAGE,
 * because the resolver constructs its own client: answering with an EMPTY
 * parameter drives the not-found refusal, which is the sentence that names the
 * parameter.
 */
const ssmSend = vi.hoisted(() => vi.fn(async () => ({ Parameter: undefined })));
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ssm')>();
  return {
    ...actual,
    SSMClient: vi.fn().mockImplementation(() => ({
      send: ssmSend,
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

const ESC = String.fromCharCode(0x1b);
/**
 * `ESC[2K` erases the line the cursor sits on and CR returns it to the start,
 * so the pair REPLACES what cdkd already printed. Asserted separately because a
 * repair covering only C0 (the CR) or only the escape reads as complete.
 */
const HOSTILE = `Prod${ESC}[2K\rEvil`;

/** U+2028: `stripControlChars` does NOT touch it; `displaySafe` does. */
const LS = ' ';

/** A state backend holding no stacks at all, so every export lookup misses. */
function emptyBackend(): S3StateBackend {
  return {
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
  } as unknown as S3StateBackend;
}

function buildContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  const template: CloudFormationTemplate = { Resources: {} };
  return {
    template,
    resources: {},
    stackName: 'Consumer',
    stateBackend: emptyBackend(),
    ...overrides,
  };
}

/** Swap the mocked logger's method for the duration of one case. */
async function captureLog<T extends 'warn' | 'debug' | 'error' | 'info'>(
  method: T,
  body: () => Promise<void>
): Promise<string> {
  const calls = vi.fn();
  const logger = await import('../../../src/utils/logger.js');
  const got = logger.getLogger() as unknown as Record<string, unknown>;
  const previous = got[method];
  got[method] = calls;
  try {
    await body();
  } finally {
    got[method] = previous;
  }
  return calls.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('Fn::ImportValue renders its export name through the display builder (go-to-k/cdkd#3426)', () => {
  it('the exports-index WARN carries no raw ESC or CR — the site the issue called sharpest', async () => {
    // THE SITE: `'${loggedExportName}'` sits one operand to the LEFT of a
    // `displayMasked(err...)` on the same warn, which go-to-k/cdkd#3408 had
    // just sanitized — the guard defeated by its own neighbour, inside the
    // repair that introduced the neighbour. It is a `warn`, so it prints at
    // DEFAULT verbosity, and the index lookup failing is an ordinary
    // permissions outcome rather than a crafted one.
    const failingIndex = {
      lookup: vi.fn(async () => {
        throw new Error('AccessDenied: cdkd/_index/us-east-1/exports.json');
      }),
    } as unknown as ExportIndexStore;

    const warned = await captureLog('warn', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      await resolver
        .resolve({ 'Fn::ImportValue': HOSTILE }, buildContext({ exportIndex: failingIndex }))
        .catch(() => undefined);
    });

    // BOUND THE ARM before asserting its bytes: without this the case is
    // satisfied by the lookup never having been attempted.
    expect(warned, 'the index-lookup warn never fired, so this case proves nothing').toContain(
      'Exports index lookup failed'
    );
    // Still IDENTIFIES the export — a sanitizer that emptied the name would
    // satisfy every byte assertion below while making the warn useless.
    expect(warned).toContain('Prod');
    expect(warned).toContain('Evil');
    expect(warned, 'a raw ESC reached the index-lookup warn').not.toContain(ESC);
    expect(warned, 'a raw CR reached the index-lookup warn').not.toContain('\r');
  });

  it('the not-found THROW carries no raw ESC or CR', async () => {
    // The same binding's last reader, and the one the issue measured first.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve({ 'Fn::ImportValue': HOSTILE }, buildContext())
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err, 'the resolve was expected to REFUSE; a resolved value proves nothing').toBeDefined();
    const message = String(err?.message ?? '');
    expect(message).toContain('not found in any stack');
    expect(message).toContain('Prod');
    expect(message).toContain('Evil');
    expect(message, 'a raw ESC reached the throw').not.toContain(ESC);
    expect(message, 'a raw CR reached the throw').not.toContain('\r');
  });

  it('strips the class `stripControlChars` does NOT cover — U+2028', async () => {
    // The discriminator between the two halves of the builder. A repair that
    // reached only `maskThenStripThenMask` passes both cases above and fails
    // this one, which is exactly the near-miss the builder exists to prevent:
    // a JSON log viewer reads U+2028 as a line terminator.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve({ 'Fn::ImportValue': `Prod${LS}Evil` }, buildContext())
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err).toBeDefined();
    const message = String(err?.message ?? '');
    expect(message).toContain('Prod');
    // Anchored PAST the character: a sanitizer that TRUNCATED there would
    // satisfy the assertions around this one.
    expect(message).toContain('Evil');
    expect(message, 'U+2028 reached the message').not.toContain(LS);
  });

  it('leaves an ORDINARY export name byte-identical', async () => {
    // The other direction, and what keeps this file from rewarding an
    // over-tightening repair: a sanitizer that mangled ordinary names would
    // pass every case above. An export name may legally carry `:` and `-`.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve({ 'Fn::ImportValue': 'My-Prod:Api-Url.v1' }, buildContext())
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err).toBeDefined();
    expect(String(err?.message ?? '')).toContain("export 'My-Prod:Api-Url.v1' not found");
  });
});

describe('an Fn::Sub PLACEHOLDER NAME cannot forge a line either (go-to-k/cdkd#3426 sweep)', () => {
  it('the Ref-not-found warn carries no raw ESC or CR', async () => {
    // FOUND BY THE LIVE REPRO, not by the issue: `resolveSub` re-enters
    // `resolveRef` with whatever text sits between `${` and `}`, and this site
    // rendered it under an exclusion marker reading "a literal per
    // CloudFormation's grammar" — a true statement about SECRETS (the only
    // question that marker answers) and a false one about control characters.
    // Measured on `node dist/cli.js`: a live `ESC[2K` + CR on a DEFAULT-verbosity
    // warn during an ordinary deploy.
    const warned = await captureLog('warn', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      await resolver
        .resolve({ 'Fn::Sub': `x\${${HOSTILE}}` }, buildContext())
        .catch(() => undefined);
    });

    expect(warned, 'the Ref-not-found warn never fired, so this case proves nothing').toContain(
      'not a resource, parameter, or pseudo parameter'
    );
    expect(warned).toContain('Prod');
    expect(warned).toContain('Evil');
    expect(warned, 'a raw ESC reached the Ref-not-found warn').not.toContain(ESC);
    expect(warned, 'a raw CR reached the Ref-not-found warn').not.toContain('\r');
  });
});

describe('the parameter-value debug lines sanitize too (go-to-k/cdkd#3426 sweep)', () => {
  it("a template DEFAULT reaches the debug line stripped, through maskInherited's own sanitizer", async () => {
    // `maskInherited` is the third `MASKERS` entry with a body in the resolver,
    // and the one a sweep forgets: it masks against the INHERITED bag alone, so
    // it cannot reach the builder's context-shaped masker and had to grow the
    // same composition (mask, strip, mask, `displaySafe`) in its own closure.
    //
    // THE ARM IS CHOSEN, not convenient. The user-provided line is a WORSE
    // subject even though its value is more obviously attacker-shaped: it
    // leaf-masks through `maskValueLeaves` FIRST, which since go-to-k/cdkd#3426
    // sanitizes, so that line stays clean with this closure's own sanitizer
    // deleted — measured, and it is exactly the confluence
    // `.claude/rules/testing.md` warns a mutation probe about. The `Default`
    // arm hands its value straight to the encoder, so this closure is the only
    // thing standing there.
    const logged = await captureLog('debug', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      await resolver.resolveParameters({
        Resources: {},
        Parameters: { Stage: { Type: 'String', Default: HOSTILE } },
      });
    });

    // BOUND THE ARM: three branches render through this closure, and the two
    // others print a different sentence.
    expect(logged, 'the default-value parameter line never fired').toContain('using default value');
    expect(logged).toContain('Prod');
    expect(logged).toContain('Evil');
    expect(logged, 'a raw ESC reached the parameter debug line').not.toContain(ESC);
    expect(logged, 'a raw CR reached the parameter debug line').not.toContain('\r');
  });

  it("strips U+2028 there too, which is the half stripControlChars cannot do", async () => {
    // THE DISCRIMINATOR between the closure's two halves, and the reason the
    // case above is not enough: `stripControlChars` already removes ESC and CR,
    // so deleting the `displaySafe` pass leaves that case green. U+2028 is the
    // character only `displaySafe` touches, so this one reds instead — measured
    // both ways during go-to-k/cdkd#3426's review.
    const logged = await captureLog('debug', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      await resolver.resolveParameters({
        Resources: {},
        Parameters: { Stage: { Type: 'String', Default: `Prod${LS}Evil` } },
      });
    });

    expect(logged, 'the default-value parameter line never fired').toContain('using default value');
    expect(logged).toContain('Prod');
    // Anchored PAST the character: a sanitizer that TRUNCATED there would
    // satisfy the assertions around this one.
    expect(logged).toContain('Evil');
    expect(logged, 'U+2028 reached the parameter debug line').not.toContain(LS);
  });
});

describe('the dynamic-reference bindings sanitize too (go-to-k/cdkd#3426 sweep)', () => {
  it('an SSM parameter name reaches its refusal stripped', async () => {
    // `loggedParameterName` is the same shape as `loggedExportName` — bound
    // from the bare masker, read by four sites — and its value is
    // TOKEN-DERIVED, so no charset gate stands in front of it. Reached with no
    // SSM client available, which fails the lookup before any AWS call.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

    const err = await resolver
      .resolve(`{{resolve:ssm:${HOSTILE}}}`, buildContext())
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(err, 'the dynamic reference was expected to FAIL to resolve').toBeDefined();
    const message = String(err?.message ?? '');
    // BOUND THE ARM, and bound it to the sentence that NAMES the parameter: a
    // different failure (no client, a throttle) would satisfy the byte
    // assertions below while the binding under test never rendered at all.
    expect(message, 'a different SSM failure fired, so this case proves nothing').toContain(
      'SSM parameter'
    );
    expect(message).toContain('Prod');
    expect(message).toContain('Evil');
    expect(message, 'a raw ESC reached the SSM refusal').not.toContain(ESC);
    expect(message, 'a raw CR reached the SSM refusal').not.toContain('\r');
  });
});
