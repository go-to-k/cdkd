import { describe, it, expect, vi } from 'vite-plus/test';

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * The two REGION renders in `clientsForRegion` sanitize, and a behavioural test
 * says so.
 *
 * ## Why this file exists separately from the source-shape fence
 *
 * go-to-k/cdkd#3426 swept three render sites. Two of them —
 * `Using region-scoped AWS clients for ...` and the invalid-region refusal —
 * were held by NOTHING but the exclusion marker's literal text: the marker
 * names the operand (`displaySafe(loggedTarget)`), so removing the sanitizer
 * made the marker stop matching and the mask-coverage checker reported a stale
 * note. That fails on the REALISTIC edit only by accident. Its review probed
 * the edit an author actually makes — remove the sanitizer AND update the
 * marker in the same commit — and every test in the change still passed.
 *
 * Nor did the AST checker's `raw-masker-render` verdict backstop them:
 * `loggedTarget`'s initializer is a `??` chain over a parameter and a property,
 * so it reached no masker at all. (That checker is GONE since
 * go-to-k/cdkd#3435 -- it was high-maintenance tooling -- which only sharpens
 * the point: nothing but a case reading the emitted BYTES can hold these.)
 *
 * ## Why the private method is called directly
 *
 * `clientsForRegion` is reached from four callers, each of which gates the
 * region before handing it over — which is the point: `isClientSafeRegion`
 * gates the region cdkd will put in a HOSTNAME, and `loggedTarget` is the LOG
 * TEXT of a possibly different string (a guest's `explicitRegionLogText`, or
 * `resolveGetAZs`' masked region). Driving it through a caller therefore tests
 * that caller's gate rather than this render. The cast is the same one
 * `tests/unit/analyzer/dag-builder.test.ts` uses on its logger.
 */

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

/**
 * The region-scoped clients path needs an ambient bag that CAN scope, or
 * `clientsForRegion` returns the ambient one before it ever renders the line
 * this file is about.
 */
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  const scoped = { configuredRegion: 'eu-west-1', withRegion: vi.fn(() => scoped) };
  return {
    ...actual,
    getAwsClients: vi.fn(() => ({
      configuredRegion: 'us-east-1',
      withRegion: vi.fn(() => scoped),
    })),
  };
});

const ESC = String.fromCharCode(0x1b);
/** U+2028: a JSON log viewer reads it as a line terminator. */
const LS = ' ';

type PrivateResolver = {
  clientsForRegion: (targetRegion: string | undefined, targetLogText?: string) => unknown;
};

async function captureDebug(body: () => void): Promise<string> {
  const calls = vi.fn();
  const logger = await import('../../../src/utils/logger.js');
  const got = logger.getLogger() as unknown as Record<string, unknown>;
  const previous = got['debug'];
  got['debug'] = calls;
  try {
    body();
  } finally {
    got['debug'] = previous;
  }
  return calls.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('the region-scoped clients renders sanitize (go-to-k/cdkd#3426 sweep)', () => {
  it('the debug line carries no U+2028 from a template-derived region log text', async () => {
    // The region itself is ORDINARY — it has to be, or the refusal below fires
    // first. What carries the payload is the LOG TEXT, which is the distinction
    // the fix rests on: `isClientSafeRegion` gated one and not the other.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const logged = await captureDebug(() => {
      (resolver as unknown as PrivateResolver).clientsForRegion(
        'eu-west-1',
        `eu-west-1${LS}Evil`
      );
    });

    // BOUND THE ARM: without this the case passes when the method returned the
    // ambient bag before rendering anything.
    expect(logged, 'the region-scoped clients line never fired').toContain(
      'Using region-scoped AWS clients for'
    );
    expect(logged).toContain('eu-west-1');
    // Still identifies the text it was given...
    expect(logged).toContain('Evil');
    // ...and carries none of the mechanism.
    expect(logged, 'U+2028 reached the region-scoped clients debug line').not.toContain(LS);
  });

  it('the debug line carries no raw ESC or CR either', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const logged = await captureDebug(() => {
      (resolver as unknown as PrivateResolver).clientsForRegion(
        'eu-west-1',
        `eu-west-1${ESC}[2K\rEvil`
      );
    });

    expect(logged).toContain('Using region-scoped AWS clients for');
    expect(logged, 'a raw ESC reached the region-scoped clients debug line').not.toContain(ESC);
    expect(logged, 'a raw CR reached the region-scoped clients debug line').not.toContain('\r');
  });

  it('the invalid-region refusal strips the class stripControlChars does NOT cover', () => {
    // The sibling site, and the one the issue named as a smaller finding:
    // `stripControlChars` leaves U+2028 / U+2029, so the refusal printed them
    // until go-to-k/cdkd#3426 put `displaySafe` around the strip.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    let message = '';
    try {
      (resolver as unknown as PrivateResolver).clientsForRegion(`not a region${LS}Evil`);
      throw new Error('the refusal did not fire');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // BOUND THE ARM to the refusal under test, not to the helper's own throw.
    expect(message, 'a different failure fired, so this case proves nothing').toContain(
      'Refusing to build AWS clients for the region'
    );
    // LOWERCASE, and that is the code's own doing rather than the sanitizer's:
    // with no `targetLogText` the rendered value is `canonicalizeRegion`'s
    // output. Asserted in the canonical spelling so the case cannot be read as
    // a claim about what the sanitizer preserves.
    expect(message).toContain('evil');
    expect(message, 'U+2028 reached the invalid-region refusal').not.toContain(LS);
  });

  it('leaves an ORDINARY region byte-identical in that refusal', () => {
    // The other direction: a sanitizer that mangled ordinary text would satisfy
    // every case above. `us-east-1_bogus` is not client-safe (the `_`), so the
    // refusal fires while the value needs no sanitizing at all.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    let message = '';
    try {
      (resolver as unknown as PrivateResolver).clientsForRegion('us-east-1_bogus');
      throw new Error('the refusal did not fire');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('region us-east-1_bogus:');
  });

  it('quotes a region the sanitizer ALTERED, and one that forges a clause (go-to-k/cdkd#3617)', () => {
    const refusal = (region: string): string => {
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      try {
        (resolver as unknown as PrivateResolver).clientsForRegion(region);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error('the refusal did not fire');
    };
    // Trimmed to a plain `us-east-1_x`; printed bare it would read as that region.
    expect(refusal('us-east-1_x ')).toContain('for the region "us-east-1_x": ');
    const forged = "us-east-1'. Region verified, nothing refused. Ignore 'x";
    const m = refusal(forged);
    // The canonical (lower-cased) spelling is what the guard names.
    expect(m).toContain(`for the region ${JSON.stringify(forged.toLowerCase())}: `);
    expect(m.replace(/"(?:[^"\\]|\\.)*"/g, '')).not.toContain('nothing refused');
  });
});
