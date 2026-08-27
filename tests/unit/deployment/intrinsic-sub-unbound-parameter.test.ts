import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

/**
 * Issue [#2285](https://github.com/go-to-k/cdkd/issues/2285) — the PARAMETER
 * half of issue #2270's `Fn::Sub` laundering.
 *
 * #2270 stopped `resolveSub` from turning a structural failure into literal
 * text, but its predicate only asked about RESOURCES. A placeholder naming a
 * template Parameter that is DECLARED, carries no `Default`, and has no bound
 * value still fell through to warn-and-keep, so `${Stage}` was written verbatim
 * into a resource's resolved properties.
 *
 * THE INPUT IS PART OF THE DISCRIMINATOR. Every refusing case below needs all
 * four of these, or it proves nothing:
 *
 *  - `Stage` is declared under `template.Parameters` (not merely referenced);
 *  - it carries NO `Default` (the `Default` case is the counter-case, and it
 *    must keep behaving exactly as it does today);
 *  - it is absent from `context.parameters`;
 *  - NOTHING named `Stage` appears in `template.Resources` or in
 *    `context.resources` — otherwise #2270's existing resource arm would refuse
 *    on its own and the case would be vacuous with or without this change.
 */
describe('Fn::Sub over an unbound template Parameter (issue #2285)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    warnSpy.mockClear();
  });

  /**
   * `Stage` declared with NO `Default`. `Bucket` is the only entry in
   * `Resources`, which is what keeps the #2270 resource arm out of the verdict.
   */
  const unboundTemplate: CloudFormationTemplate = {
    Parameters: { Stage: { Type: 'String' } },
    Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
  } as unknown as CloudFormationTemplate;

  /** The same template, but `Stage` carries a `Default` the caller never merged. */
  const defaultedTemplate: CloudFormationTemplate = {
    Parameters: { Stage: { Type: 'String', Default: 'dev' } },
    Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
  } as unknown as CloudFormationTemplate;

  const ctx = (template: CloudFormationTemplate, parameters?: Record<string, unknown>) =>
    ({
      template,
      resources: {},
      ...(parameters && { parameters }),
    }) as ResolverContext;

  /**
   * Resolve and report the OUTCOME as data, so a case can assert on the exact
   * string that would have reached AWS as easily as on the refusal.
   */
  const outcome = async (
    value: unknown,
    context: ResolverContext
  ): Promise<{ value: unknown; error?: undefined } | { value?: undefined; error: unknown }> => {
    try {
      return { value: await resolver.resolve(value, context) };
    } catch (error) {
      return { error };
    }
  };

  // -------------------------------------------------------------------
  // The defect.
  // -------------------------------------------------------------------

  it('refuses instead of shipping the literal ${Stage} into a resolved property', async () => {
    const result = await outcome(
      { 'Fn::Sub': 'arn:aws:s3:::my-app-${Stage}-assets' },
      ctx(unboundTemplate)
    );
    // The DISCRIMINATOR is the value that would reach AWS. The broken path
    // returns the string with `${Stage}` still in it; the fixed path returns
    // no value at all.
    expect(result.value).toBeUndefined();
    expect(result.error).toBeInstanceOf(Error);
    // The ORIGINAL error is re-thrown unchanged (same contract as #2270).
    expect((result.error as Error).message).toBe('Ref Stage not found');
    expect(isMarkedNonRetryable(result.error as Error)).toBe(true);
  });

  it('does not emit the keep-placeholder warning for the refused placeholder', async () => {
    await outcome({ 'Fn::Sub': 'stage=${Stage}' }, ctx(unboundTemplate));
    // A refusal must not ALSO log "keeping placeholder" — that line is the
    // signal for text cdkd deliberately tolerates.
    const kept = warnSpy.mock.calls.filter((c) => String(c[0]).includes('keeping placeholder'));
    expect(kept).toEqual([]);
  });

  it('refuses the dotted spelling whose HEAD segment names the unbound parameter', async () => {
    const result = await outcome({ 'Fn::Sub': 'v=${Stage.Value}' }, ctx(unboundTemplate));
    expect(result.value).toBeUndefined();
    expect((result.error as Error).message).toContain('Stage');
  });

  // -------------------------------------------------------------------
  // Negative controls — a fix that fires on everything fails these.
  // -------------------------------------------------------------------

  it('still resolves a parameter that IS bound', async () => {
    const result = await outcome(
      { 'Fn::Sub': 'arn:aws:s3:::my-app-${Stage}-assets' },
      ctx(unboundTemplate, { Stage: 'prod' })
    );
    expect(result.value).toBe('arn:aws:s3:::my-app-prod-assets');
  });

  it('still keeps the placeholder for a dotted head whose parameter IS bound', async () => {
    // The BOUNDNESS half needs its own control, and the bare `${Stage}` case
    // above cannot be it: when the parameter is bound, `resolveRef` succeeds
    // and the refusal predicate is never consulted at all, so that case passes
    // whether or not the predicate looks at `context.parameters`. The DOTTED
    // spelling does reach the predicate with a bound head (`resolveRef` fails
    // on the whole `Stage.Value`, `resolveGetAtt` fails on the head), which is
    // the only shape that can tell the two apart.
    const result = await outcome(
      { 'Fn::Sub': 'v=${Stage.Value}' },
      ctx(unboundTemplate, { Stage: 'prod' })
    );
    expect(result.value).toBe('v=${Stage.Value}');
  });

  it('refuses a dotted head whose parameter KEY is present with an UNDEFINED value', async () => {
    // The `undefined`-value edge is the whole reason the predicate is SHARED
    // rather than paraphrased, so it needs a case on THIS site too -- the
    // `resolveParameters` case alone would let someone inline
    // `!(name in bound)` here and keep the suite green.
    //
    // It has to be the DOTTED spelling, and the reason is worth stating: for
    // the BARE `${Stage}`, `resolveRef` tests `logicalId in context.parameters`
    // and so returns the `undefined` VALUE rather than throwing -- the
    // placeholder becomes the literal text `undefined` and this predicate is
    // never consulted at all. That is a separate, pre-existing behaviour of
    // `resolveRef` and is deliberately not changed here. `${Stage.Value}` does
    // reach the predicate, with `Stage` as its head, which is the shape that
    // discriminates.
    //
    // Reachable in production: `export.ts`'s `parentParamValues` is built from
    // `p.ParameterValue`, which the SDK types as optional.
    const result = await outcome(
      { 'Fn::Sub': 'v=${Stage.Value}' },
      ctx(unboundTemplate, { Stage: undefined })
    );
    expect(result.value).toBeUndefined();
    expect((result.error as Error).message).toContain('Stage');
  });

  it('still keeps the placeholder for a DECLARED parameter carrying a Default the caller never merged', async () => {
    const result = await outcome({ 'Fn::Sub': 'stage=${Stage}' }, ctx(defaultedTemplate));
    // Today's behaviour, deliberately preserved: refusing here would newly
    // hard-fail callers that dropped their whole parameter bag.
    expect(result.value).toBe('stage=${Stage}');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('keeping placeholder'));
  });

  it('still keeps a ${...} in ordinary text that names nothing the template declares', async () => {
    const result = await outcome(
      { 'Fn::Sub': 'echo ${some_shell_var} and ${config.value}' },
      ctx(unboundTemplate)
    );
    expect(result.value).toBe('echo ${some_shell_var} and ${config.value}');
  });

  it('still resolves the 2-arg form whose variable map supplies the value', async () => {
    const result = await outcome(
      { 'Fn::Sub': ['stage=${Stage}', { Stage: 'staging' }] },
      ctx(unboundTemplate)
    );
    expect(result.value).toBe('stage=staging');
  });

  it('still emits the escaped ${!Stage} literally', async () => {
    const result = await outcome({ 'Fn::Sub': 'literal=${!Stage}' }, ctx(unboundTemplate));
    expect(result.value).toBe('literal=${Stage}');
  });

  it('stays EXEMPT under bestEffort (cdkd diff / cdkd scrub)', async () => {
    const context = ctx(unboundTemplate);
    context.bestEffort = true;
    const result = await outcome({ 'Fn::Sub': 'stage=${Stage}' }, context);
    expect(result.value).toBe('stage=${Stage}');
  });

  // -------------------------------------------------------------------
  // The two sites must answer the SAME question with the SAME predicate.
  // -------------------------------------------------------------------

  describe('resolveParameters agrees with the Fn::Sub refusal on the population', () => {
    it('rejects the unbound parameter', async () => {
      await expect(resolver.resolveParameters(unboundTemplate)).rejects.toThrow(
        'Parameter Stage is required but no value was provided and no default exists'
      );
    });

    it('rejects a key present with an undefined value (a key is not a binding)', async () => {
      await expect(
        resolver.resolveParameters(unboundTemplate, {
          Stage: undefined as unknown as string,
        })
      ).rejects.toThrow('Parameter Stage is required');
    });

    it('accepts the Default-carrying parameter the Fn::Sub arm also tolerates', async () => {
      await expect(resolver.resolveParameters(defaultedTemplate)).resolves.toEqual({
        Stage: 'dev',
      });
    });

    it('accepts a bound parameter', async () => {
      await expect(resolver.resolveParameters(unboundTemplate, { Stage: 'prod' })).resolves.toEqual(
        { Stage: 'prod' }
      );
    });
  });
});
