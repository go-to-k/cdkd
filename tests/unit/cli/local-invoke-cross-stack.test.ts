/**
 * Tests for the cross-stack CLI wiring helpers in
 * `src/cli/commands/local-invoke.ts`:
 *
 *   - `envHasCrossStackIntrinsic(templateEnv)` — gates the
 *     `buildCrossStackResolver` construction inside the `--from-state`
 *     flow so literal + same-stack-intrinsic env maps don't pay the
 *     extra S3-client / index-load cost.
 *
 * Plus the async `substituteEnvVarsFromStateAsync` happy path against a
 * real cross-stack resolver, which is the workhorse the CLI calls when
 * the predicate returns true. Together these two layers form the
 * end-to-end CLI wiring for `cdkd local invoke --from-state` env-var
 * resolution against cross-stack outputs.
 *
 * Coverage axes (closes the HIGH-severity gap surfaced by the PR #487
 * test-adequacy review on the CLI wiring layer):
 *   - predicate returns false on literal-only env
 *   - predicate returns true on Fn::ImportValue at root
 *   - predicate returns true on Fn::GetStackOutput at root
 *   - predicate returns false on `Ref` / `Fn::GetAtt` / `Fn::Sub` (the
 *     non-cross-stack intrinsics)
 *   - predicate returns false on undefined / empty / nested-only-cross-stack
 *   - cross-stack value resolves through substituteEnvVarsFromStateAsync
 *   - cross-stack resolver returning undefined drops the env key with
 *     a per-key audit entry
 *   - cross-stack resolver throwing surfaces a per-key audit entry
 *     without aborting the substitution pass
 */

import { describe, expect, it, vi } from 'vite-plus/test';
import {
  envHasCrossStackIntrinsic,
  envHasIntrinsicValue,
} from '../../../src/cli/commands/local-invoke.js';
import {
  substituteEnvVarsFromStateAsync,
  type CrossStackResolver,
  type SubstitutionContext,
} from '../../../src/local/state-resolver.js';

describe('envHasCrossStackIntrinsic', () => {
  it('returns false on undefined', () => {
    expect(envHasCrossStackIntrinsic(undefined)).toBe(false);
  });

  it('returns false on an empty env map', () => {
    expect(envHasCrossStackIntrinsic({})).toBe(false);
  });

  it('returns false on a fully-literal env map', () => {
    expect(envHasCrossStackIntrinsic({ A: 'a', B: 42, C: true })).toBe(false);
  });

  it('returns true when ANY value is Fn::ImportValue', () => {
    expect(
      envHasCrossStackIntrinsic({
        LITERAL: 'a',
        OTHER_BUCKET: { 'Fn::ImportValue': 'ProducerStack-BucketName' },
      })
    ).toBe(true);
  });

  it('returns true when ANY value is Fn::GetStackOutput', () => {
    expect(
      envHasCrossStackIntrinsic({
        URL: {
          'Fn::GetStackOutput': {
            StackName: 'Other',
            OutputName: 'ApiUrl',
          },
        },
      })
    ).toBe(true);
  });

  it('returns false for non-cross-stack intrinsics (Ref / Fn::GetAtt / Fn::Sub / Fn::Join)', () => {
    expect(envHasCrossStackIntrinsic({ A: { Ref: 'MyTable' } })).toBe(false);
    expect(envHasCrossStackIntrinsic({ A: { 'Fn::GetAtt': ['MyTable', 'Arn'] } })).toBe(false);
    expect(envHasCrossStackIntrinsic({ A: { 'Fn::Sub': 'https://${AWS::Region}' } })).toBe(false);
    expect(
      envHasCrossStackIntrinsic({ A: { 'Fn::Join': [':', ['a', { Ref: 'AWS::Region' }]] } })
    ).toBe(false);
  });

  it('returns false for nested cross-stack intrinsics (detection is one level deep, per docstring)', () => {
    // Buried inside a Fn::Join — the detector intentionally does NOT
    // descend (matches the v1 resolver's behavior where the async path
    // defers to the sync helper for Fn::Join / Fn::Sub bodies and so
    // cross-stack intrinsics nested under joins are not resolvable
    // today either).
    expect(
      envHasCrossStackIntrinsic({
        BURIED: { 'Fn::Join': [':', [{ 'Fn::ImportValue': 'Other' }]] },
      })
    ).toBe(false);
  });

  it('returns false for null / non-object env values (defensive)', () => {
    expect(
      envHasCrossStackIntrinsic({ A: null as unknown as undefined, B: 'literal' })
    ).toBe(false);
  });

  // Sanity-check both predicates have orthogonal semantics: a same-stack
  // intrinsic env map triggers the broader `envHasIntrinsicValue` (which
  // controls the pseudo-parameter STS hop) but NOT
  // `envHasCrossStackIntrinsic` (which controls the cross-stack resolver
  // construction). Same-stack only → STS hop, no cross-stack S3 client.
  it('co-orthogonal with envHasIntrinsicValue: same-stack intrinsic triggers only the broader predicate', () => {
    const env = { A: { Ref: 'MyTable' } };
    expect(envHasIntrinsicValue(env)).toBe(true);
    expect(envHasCrossStackIntrinsic(env)).toBe(false);
  });

  it('co-orthogonal with envHasIntrinsicValue: cross-stack intrinsic triggers both predicates', () => {
    const env = { BUCKET: { 'Fn::ImportValue': 'OtherStack-Bucket' } };
    expect(envHasIntrinsicValue(env)).toBe(true);
    expect(envHasCrossStackIntrinsic(env)).toBe(true);
  });
});

function makeResolver(impl: Partial<CrossStackResolver> = {}): CrossStackResolver {
  return {
    resolveImport: vi.fn().mockResolvedValue(undefined),
    resolveGetStackOutput: vi.fn().mockResolvedValue(undefined),
    ...impl,
  };
}

describe('substituteEnvVarsFromStateAsync — cross-stack wiring used by --from-state', () => {
  it('resolves an Fn::ImportValue env var via the cross-stack resolver', async () => {
    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('producer-bucket-12345'),
    });
    const context: SubstitutionContext = {
      resources: {},
      crossStackResolver: resolver,
      consumerRegion: 'us-east-1',
    };

    const { env, audit } = await substituteEnvVarsFromStateAsync(
      { OTHER_BUCKET: { 'Fn::ImportValue': 'ProducerStack-BucketName' } },
      context
    );

    expect(env).toEqual({ OTHER_BUCKET: 'producer-bucket-12345' });
    expect(audit.resolvedKeys).toEqual(['OTHER_BUCKET']);
    expect(audit.unresolved).toEqual([]);
    expect(resolver.resolveImport).toHaveBeenCalledWith('ProducerStack-BucketName');
  });

  it('resolves an Fn::GetStackOutput env var via the cross-stack resolver', async () => {
    const resolver = makeResolver({
      resolveGetStackOutput: vi.fn().mockResolvedValue('https://api.example.com'),
    });
    const context: SubstitutionContext = {
      resources: {},
      crossStackResolver: resolver,
      consumerRegion: 'us-east-1',
    };

    const { env, audit } = await substituteEnvVarsFromStateAsync(
      {
        API_URL: {
          'Fn::GetStackOutput': { StackName: 'OtherStack', OutputName: 'ApiUrl' },
        },
      },
      context
    );

    expect(env).toEqual({ API_URL: 'https://api.example.com' });
    expect(audit.resolvedKeys).toEqual(['API_URL']);
    expect(audit.unresolved).toEqual([]);
    expect(resolver.resolveGetStackOutput).toHaveBeenCalledWith(
      'OtherStack',
      'us-east-1',
      'ApiUrl'
    );
  });

  it('drops a cross-stack env var with an audit entry when the resolver returns undefined', async () => {
    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue(undefined),
    });
    const context: SubstitutionContext = {
      resources: {},
      crossStackResolver: resolver,
      consumerRegion: 'us-east-1',
    };

    const { env, audit } = await substituteEnvVarsFromStateAsync(
      {
        LITERAL: 'kept',
        DROPPED: { 'Fn::ImportValue': 'NotDeployedYet' },
      },
      context
    );

    expect(env).toEqual({ LITERAL: 'kept' });
    expect(audit.resolvedKeys).toEqual([]);
    expect(audit.unresolved).toHaveLength(1);
    expect(audit.unresolved[0]!.key).toBe('DROPPED');
    expect(audit.unresolved[0]!.reason).toContain('NotDeployedYet');
  });

  it('passes through a resolver-thrown error as an audit entry without aborting the pass', async () => {
    const resolver = makeResolver({
      resolveImport: vi.fn().mockRejectedValue(new Error('S3 access denied')),
    });
    const context: SubstitutionContext = {
      resources: {},
      crossStackResolver: resolver,
      consumerRegion: 'us-east-1',
    };

    const { env, audit } = await substituteEnvVarsFromStateAsync(
      {
        OTHER_BUCKET: { 'Fn::ImportValue': 'OtherStack-Bucket' },
        LITERAL_A: 'preserved',
      },
      context
    );

    // LITERAL_A still got through; the throw produced a per-key audit
    // entry (not a global abort).
    expect(env).toEqual({ LITERAL_A: 'preserved' });
    expect(audit.unresolved).toHaveLength(1);
    expect(audit.unresolved[0]!.key).toBe('OTHER_BUCKET');
    expect(audit.unresolved[0]!.reason).toContain('S3 access denied');
  });

  // Closes the cross-region asymmetry test (Gap 2 of the test reviewer's
  // report): the same-region scope filter applies only to
  // `Fn::ImportValue` (handled at the resolver layer). `Fn::GetStackOutput`
  // with an explicit Region argument resolves cross-region without
  // any cdkd-side gating — and the env-resolver simply passes the
  // resolved value through.
  it('cross-region: Fn::GetStackOutput with explicit Region resolves cross-region', async () => {
    const resolveGetStackOutput = vi
      .fn<
        (stack: string, region: string, output: string) => Promise<string | undefined>
      >()
      .mockImplementation(async (_stack, region, _out) => {
        return region === 'us-west-2' ? 'west-value' : undefined;
      });
    const resolver = makeResolver({ resolveGetStackOutput });
    const context: SubstitutionContext = {
      resources: {},
      crossStackResolver: resolver,
      consumerRegion: 'us-east-1',
    };

    const { env, audit } = await substituteEnvVarsFromStateAsync(
      {
        CROSS_REGION: {
          'Fn::GetStackOutput': {
            StackName: 'WestStack',
            OutputName: 'WestOut',
            Region: 'us-west-2',
          },
        },
      },
      context
    );

    expect(env).toEqual({ CROSS_REGION: 'west-value' });
    expect(audit.resolvedKeys).toEqual(['CROSS_REGION']);
    expect(resolveGetStackOutput).toHaveBeenCalledWith('WestStack', 'us-west-2', 'WestOut');
  });

  it('Fn::ImportValue without a crossStackResolver on context surfaces a clear audit reason', async () => {
    // CLI gating means this code path should be unreachable in practice
    // (the predicate gates resolver construction), but defense-in-depth:
    // if a caller wires the async substitution without supplying a
    // resolver, the per-key audit reason must point at the missing flag.
    const context: SubstitutionContext = { resources: {} };

    const { env, audit } = await substituteEnvVarsFromStateAsync(
      { B: { 'Fn::ImportValue': 'AnyExport' } },
      context
    );

    expect(env).toEqual({});
    expect(audit.unresolved).toHaveLength(1);
    expect(audit.unresolved[0]!.reason).toContain('no cross-stack resolver supplied');
  });
});
