import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836): `--stack-region`
 * is folded at each command's handler entry, but that only reaches the four
 * `cdkd local` commands whose handler cdkd OWNS (`invoke` / `start-api` /
 * `run-task` / `invoke-agentcore`). The ECS / CloudFront / AgentCore engine
 * commands (`start-service` / `start-alb` / `start-cloudfront` /
 * `start-agentcore`) inherit the flag from cdk-local and cdk-local owns their
 * handler — it calls `createLocalStateProvider` internally with cdkd's
 * `cdkdExtraStateProviders`, so THIS factory is the only cdkd-owned point their
 * `--stack-region` passes through. Hence the second, idempotent fold here.
 *
 * The S3 provider is mocked so the factory's constructor argument — the thing
 * that carries the region downstream into the state-record compare and the
 * `cdkd/{stack}/{region}/state.json` key — is directly observable.
 */
const captured = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../../../src/local/s3-local-state-provider.js', () => ({
  S3LocalStateProvider: vi.fn(function S3LocalStateProvider(
    this: unknown,
    opts: Record<string, unknown>
  ) {
    captured.push(opts);
  }),
}));

const { cdkdExtraStateProviders } = await import('../../../src/cli/commands/local-state-source.js');

beforeEach(() => {
  captured.length = 0;
});

describe('cdkd --from-state factory: --stack-region case (issue #1836)', () => {
  const build = (stackRegion: string | undefined): Record<string, unknown> => {
    // cdk-local's `LocalStateProviderFactory` takes the options bag alone —
    // which is exactly why the engine commands' `--stack-region` has no other
    // cdkd-owned stop between the CLI and the state read.
    cdkdExtraStateProviders.fromState!({
      fromState: true,
      statePrefix: 'cdkd',
      ...(stackRegion !== undefined && { stackRegion }),
    });
    expect(captured).toHaveLength(1);
    return captured[0]!;
  };

  it('folds an upper-cased --stack-region before the provider ever sees it', () => {
    expect(build('US-EAST-1')['stackRegion']).toBe('us-east-1');
  });

  it('folds a non-commercial spelling too, where the partition itself is at stake', () => {
    // `CN-NORTH-1` is the case that is not merely cosmetic. `--stack-region`
    // does not seed the S3 client (that is `--region`, folded by the sibling
    // suite below) — it is COMPARED against a state record's region and becomes
    // the `cdkd/{stack}/{region}/state.json` key, so a raw non-commercial
    // spelling reads a record and an object that do not exist.
    expect(build('CN-NORTH-1')['stackRegion']).toBe('cn-north-1');
  });

  it('does NOT hand the provider the raw spelling (the shape a regression restores)', () => {
    const opts = build('US-EAST-1');
    expect(opts['stackRegion']).not.toBe('US-EAST-1');
  });

  it('leaves an already-canonical --stack-region byte-identical', () => {
    expect(build('us-east-1')['stackRegion']).toBe('us-east-1');
  });

  it('omits stackRegion entirely when the flag is absent', () => {
    // The key must stay ABSENT rather than become `undefined`: the provider's
    // own option spreads are `!== undefined`-gated the same way.
    expect('stackRegion' in build(undefined)).toBe(false);
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 4, fix 3:
   * round 3's gate was `opts.stackRegion !== undefined`, so `--stack-region ''`
   * still forwarded `stackRegion: ''` while the comment on the RAW half beside it
   * claimed parity with this one. Harmless downstream (`loadStateForStack` gates
   * on TRUTHINESS), but the parity claim was false — so the gate was changed to
   * match the claim rather than the claim trimmed to match the gate, which also
   * makes this boundary agree with its `--region` sibling.
   */
  it('treats a BLANK --stack-region as absent on the FOLDED half too', () => {
    const opts = build('');

    // The shape the regression restores, stated on its own: `stackRegion: ''`
    // passed the `!== undefined` gate and arrived as an empty region.
    expect(opts['stackRegion']).not.toBe('');
    expect('stackRegion' in opts).toBe(false);
    // ... and the two halves genuinely agree, which is the claim being pinned.
    expect('rawStackRegion' in opts).toBe(false);
  });

  /**
   * Issue #1836 round 3: the fold above is REQUIRED (the same value names
   * cdk-local's CFn client region) and is ALSO what made the loader's
   * exact-match rule unreachable — with only the folded value in hand,
   * `--stack-region US-EAST-1` read the `us-east-1` record and reported it as
   * the exact spelling. So the factory carries the RAW spelling alongside, for
   * the record match only.
   */
  describe('rawStackRegion (the record-match spelling)', () => {
    it('carries the raw spelling beside the folded one', () => {
      const opts = build('US-EAST-1');
      expect(opts['rawStackRegion']).toBe('US-EAST-1');
      expect(opts['stackRegion']).toBe('us-east-1');
    });

    it('prefers a handler-captured rawStackRegion over the flag it receives', () => {
      // What the four commands with their own handler produce: they capture the
      // raw value and then fold `stackRegion` in place, so by the time the
      // factory runs the flag is ALREADY canonical and only the captured field
      // still knows what the user typed.
      cdkdExtraStateProviders.fromState!({
        fromState: true,
        statePrefix: 'cdkd',
        stackRegion: 'us-east-1',
        rawStackRegion: 'US-EAST-1',
      } as never);
      expect(captured).toHaveLength(1);
      expect(captured[0]!['rawStackRegion']).toBe('US-EAST-1');
      expect(captured[0]!['stackRegion']).toBe('us-east-1');
    });

    it('derives it from the flag for an ENGINE command, which has no capture point', () => {
      // `start-service` / `start-alb` / `start-cloudfront` / `start-agentcore`:
      // cdk-local owns the handler and folds nothing, so the value this factory
      // receives IS the user's own spelling.
      expect(build('CN-NORTH-1')['rawStackRegion']).toBe('CN-NORTH-1');
    });

    it('omits it entirely when no --stack-region was given', () => {
      expect('rawStackRegion' in build(undefined)).toBe(false);
    });

    it('treats a BLANK --stack-region as absent rather than carrying an empty raw', () => {
      expect('rawStackRegion' in build('')).toBe(false);
    });
  });
});

/**
 * The `--region` twin, and the more consequential half of the two: `--region` is
 * not merely compared, it BUILDS the `AwsClients` + `S3StateBackend` inside
 * `local-state-loader.ts`, and AWS SDK endpoint resolution is case-SENSITIVE
 * (`CN-NORTH-1` resolves the COMMERCIAL partition). The four commands with their
 * own handler fold it on entry (issue #1795), but the ECS / CloudFront /
 * AgentCore engine commands do not have a cdkd-owned handler at all — so
 * `cdkd local start-service --from-state --region CN-NORTH-1` reached a
 * commercial endpoint with nothing in between.
 */
describe('cdkd --from-state factory: --region case (issue #1836)', () => {
  const build = (region: string | undefined): Record<string, unknown> => {
    cdkdExtraStateProviders.fromState!({
      fromState: true,
      statePrefix: 'cdkd',
      ...(region !== undefined && { region }),
    });
    expect(captured).toHaveLength(1);
    return captured[0]!;
  };

  it('folds an upper-cased --region before the provider (and its S3 client) sees it', () => {
    expect(build('CN-NORTH-1')['region']).toBe('cn-north-1');
  });

  it('does NOT hand the provider the raw spelling (the shape a regression restores)', () => {
    // The feared shape stated on its own: an `S3StateBackend` built with
    // `CN-NORTH-1` talks to `s3.CN-NORTH-1.amazonaws.com`, i.e. the commercial
    // partition, and nothing rejects it.
    expect(build('CN-NORTH-1')['region']).not.toBe('CN-NORTH-1');
  });

  it('folds a commercial upper-cased spelling too', () => {
    expect(build('US-EAST-1')['region']).toBe('us-east-1');
  });

  it('leaves an already-canonical --region byte-identical', () => {
    expect(build('cn-north-1')['region']).toBe('cn-north-1');
  });

  it('omits region entirely when the flag is absent', () => {
    // Absent must stay ABSENT, not become `undefined` or `''`: omitting `region`
    // is what lets the SDK's own chain resolve the profile's region.
    expect('region' in build(undefined)).toBe(false);
  });

  it('treats a BLANK --region as absent (it named no endpoint, and now says so)', () => {
    // `--region ''` used to pass the `!== undefined` gate and arrive as
    // `region: ''` while the comment beside it claimed absent stays absent.
    expect('region' in build('')).toBe(false);
  });
});
