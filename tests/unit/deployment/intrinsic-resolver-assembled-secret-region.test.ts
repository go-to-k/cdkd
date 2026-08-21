import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * `IntrinsicFunctionResolver` must decide WHICH REGION answers for a
 * `{{resolve:...}}` reference AFTER the reference is assembled, not before
 * (issue [#2134](https://github.com/go-to-k/cdkd/issues/2134)).
 *
 * The pre-#2134 answer was a PRE-PASS in `cdkd scrub` over the RAW template
 * leaf. A reference whose opening or whose tail is contributed by a `Ref` /
 * `Fn::Sub` / `Fn::Join` part does not EXIST in that text, so the pre-pass
 * found nothing to classify and handed the leaf on; `resolveSub` / `resolveJoin`
 * then re-entered `resolveDynamicReferences` with the assembled expression on
 * the PRIMARY resolver, and a foreign ARN was fetched against the stack's own
 * regional endpoint.
 *
 * WHY THIS FILE FAKES THE SDK CLIENT CLASSES rather than `getAwsClients()`
 * (the same choice as `rollback-executor-cross-region-secret.test.ts`): the
 * whole question is WHICH REGION WAS ASKED, and a plain-object
 * `getAwsClients()` double has no region, so it cannot be asked it. The real
 * `AwsClients` is used -- which is also what makes `clientsForRegion` derive a
 * region-pinned sibling at all -- and only the leaf `SecretsManagerClient` /
 * `SSMClient` are faked, with the CONSTRUCTOR region as the discriminator.
 *
 * THE ASSERTION IS THE RESOLVED VALUE, not the absence of an error. Two regions
 * hold DIFFERENT values behind the same reference, which is the ordinary
 * Secrets Manager reality and the only thing that makes "which region answered"
 * observable: a fixture priming one value could not tell the fixed path from
 * the broken one, because both paths return successfully.
 *
 * Every literal below is invented for this file.
 */

interface FakeClientConfig {
  region?: string;
}

interface FakeSend {
  /** The region the sending client was CONSTRUCTED with -- the discriminator. */
  ctorRegion: string | undefined;
  region: string | undefined;
  command: string;
}

const { responses, secretSends, ssmSends, makeFakeClientClass } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();

  const makeFakeClientClass = (sends: FakeSend[], serviceLabel: string): unknown =>
    class {
      readonly ctorConfig: FakeClientConfig;
      readonly config: { region: () => Promise<string> };
      private resolved?: Promise<string>;

      constructor(ctorConfig: FakeClientConfig = {}) {
        this.ctorConfig = ctorConfig;
        this.config = { region: () => this.resolveRegion() };
      }

      private resolveRegion(): Promise<string> {
        if (!this.resolved) {
          const region = this.ctorConfig.region || process.env['AWS_REGION'];
          this.resolved = region
            ? Promise.resolve(region)
            : Promise.reject(new Error('Region is missing'));
        }
        return this.resolved;
      }

      async send(command: { constructor: { name: string } }): Promise<unknown> {
        let region: string | undefined;
        try {
          region = await this.resolveRegion();
        } catch {
          region = undefined;
        }
        const name = command.constructor.name;
        sends.push({ ctorRegion: this.ctorConfig.region, region, command: name });
        const response = responses.get(`${String(region)}|${name}`);
        if (response === undefined) {
          throw new Error(`no ${serviceLabel} response primed for ${String(region)}|${name}`);
        }
        return response;
      }
      destroy(): void {}
    };

  return {
    responses,
    secretSends: [] as FakeSend[],
    ssmSends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager') };
});

// An `ssm` reference can name an ARN too -- `resolveSSMReference` rebuilds the
// parameter name from the colon-split tail -- so it needs the same
// region-observable fake.
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], 'sts') };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const CONSUMER_REGION = 'ap-northeast-1';
const PRODUCER_REGION = 'eu-west-1';

const REF_NAME = 'prod/db/cred';
const PRODUCER_ARN = `arn:aws:secretsmanager:${PRODUCER_REGION}:111122223333:secret:${REF_NAME}-AbCdEf`;
const CONSUMER_ARN = `arn:aws:secretsmanager:${CONSUMER_REGION}:111122223333:secret:${REF_NAME}-AbCdEf`;

/** Two regions, two DIFFERENT values behind the same reference. */
const TOKYO_VALUE = 'tokyo-value-2134';
const IRELAND_VALUE = 'ireland-value-2134';

beforeEach(() => {
  responses.clear();
  secretSends.length = 0;
  ssmSends.length = 0;
  resetAccountInfoCache();
  responses.set(`${CONSUMER_REGION}|GetSecretValueCommand`, {
    SecretString: JSON.stringify({ password: TOKYO_VALUE }),
  });
  responses.set(`${PRODUCER_REGION}|GetSecretValueCommand`, {
    SecretString: JSON.stringify({ password: IRELAND_VALUE }),
  });
  responses.set(`${CONSUMER_REGION}|GetCallerIdentityCommand`, {
    Account: '111122223333',
    Arn: 'arn:aws:iam::111122223333:user/test',
  });
  responses.set(`${PRODUCER_REGION}|GetCallerIdentityCommand`, {
    Account: '111122223333',
    Arn: 'arn:aws:iam::111122223333:user/test',
  });
  setAwsClients(new AwsClients({ region: CONSUMER_REGION }));
});

afterEach(() => {
  resetAwsClients();
  resetAccountInfoCache();
});

const TEMPLATE = { Resources: {} } as unknown as CloudFormationTemplate;

function ctx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return { template: TEMPLATE, resources: {}, ...overrides };
}

/**
 * Which regions were actually ASKED, in order.
 *
 * `ctorRegion` ALONE, deliberately: it is the constructor argument, so an
 * UNPINNED client surfaces as `undefined` and fails the assertion loudly. An
 * earlier version fell back to `s.region`, which resolves through
 * `process.env.AWS_REGION` -- so an unpinned client would have read as the
 * ambient region and a missing pin could have passed. (Instrumented by a
 * reviewer: the fallback never fired in any case here, so removing it changes
 * no result -- only what a future regression would look like.)
 */
function askedRegions(): Array<string | undefined> {
  return secretSends
    .filter((s) => s.command === 'GetSecretValueCommand')
    .map((s) => s.ctorRegion);
}

/**
 * THE JOINT DISTRIBUTION.
 *
 * The two signals are the reference's SHAPE (is it whole in the template text,
 * or built by an intrinsic?) and its REGION FORM (does it name a region?). They
 * are independent, and the cell the pre-#2134 code got wrong is exactly the one
 * a "pick the cases that are easy to construct" matrix omits: ASSEMBLED x
 * FOREIGN-ARN. Building the matrix from the product rather than from a list is
 * what makes that cell impossible to forget -- the lesson issue #2133 left for
 * this one, where a correlated matrix left the cell every real invocation lands
 * in empty and three wrong implementations passed a green suite.
 */
const SHAPES = [
  {
    key: 'literal',
    /** The reference is already whole in the template text. */
    build: (arn: string): unknown => `{{resolve:secretsmanager:${arn}:SecretString:password}}`,
  },
  {
    key: 'assembled-sub',
    /** `Fn::Sub` contributes the id, so the raw leaf holds no ARN. */
    build: (arn: string): unknown => ({
      'Fn::Sub': [
        '{{resolve:secretsmanager:${TargetArn}:SecretString:password}}',
        { TargetArn: arn },
      ],
    }),
  },
  {
    key: 'assembled-join',
    /** `Fn::Join` splits the reference BEFORE the service name. */
    build: (arn: string): unknown => ({
      'Fn::Join': ['', ['{{resolve:secretsmanager:', arn, ':SecretString:password}}']],
    }),
  },
] as const;

describe('the region a reference resolves in is decided AFTER assembly (issue #2134)', () => {
  describe('a FOREIGN ARN routes to the region it names, in every shape', () => {
    for (const shape of SHAPES) {
      it(`${shape.key}: resolves in the ARN's region, not the stack's`, async () => {
        const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

        const out = await resolver.resolve(shape.build(PRODUCER_ARN), ctx());

        // THE DISCRIMINATOR: the VALUE, which differs by region. Asserting only
        // that no error was thrown would pass on the broken path too -- it
        // resolved successfully, against the wrong endpoint.
        expect(out).toBe(IRELAND_VALUE);
        expect(out).not.toBe(TOKYO_VALUE);
        // ...and the mechanism behind it, so a future change that returns the
        // right value by some other route is still visible here.
        expect(askedRegions()).toEqual([PRODUCER_REGION]);
      });
    }
  });

  describe("an OWN-REGION ARN stays on the stack's own resolver, in every shape", () => {
    for (const shape of SHAPES) {
      it(`${shape.key}: resolves locally`, async () => {
        const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

        const out = await resolver.resolve(shape.build(CONSUMER_ARN), ctx());

        expect(out).toBe(TOKYO_VALUE);
        expect(askedRegions()).toEqual([CONSUMER_REGION]);
      });
    }
  });

  describe('a NAME-FORM reference is refused only when the evidence says a boundary was crossed', () => {
    const NAME_FORM = `{{resolve:secretsmanager:${REF_NAME}:SecretString:password}}`;

    it('refuses when a foreign producer region is on record', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      await expect(
        resolver.resolve(NAME_FORM, ctx({ producerRegions: [PRODUCER_REGION] }))
      ).rejects.toThrow(/without a region/);

      // NOT a confluence point: the refusal must happen BEFORE any fetch, or a
      // wrong-region value has already been read (and, on the scrub path, has
      // already become a redaction needle).
      expect(askedRegions()).toEqual([]);
    });

    it('resolves locally when the only producer region on record is the stack own', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const out = await resolver.resolve(NAME_FORM, ctx({ producerRegions: [CONSUMER_REGION] }));

      expect(out).toBe(TOKYO_VALUE);
      expect(askedRegions()).toEqual([CONSUMER_REGION]);
    });

    it('resolves locally when NO evidence is supplied -- the `cdkd deploy` shape', async () => {
      // The load-bearing negative for the deploy path. `cdkd deploy` does not
      // pass `producerRegions`, deliberately: the evidence is per-STACK, so
      // arming the refusal there would reject the ordinary CDK
      // `secretValueFromJson` shape in any stack that also holds one
      // cross-region import. If this test ever starts throwing, templates that
      // deploy today have stopped deploying.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const out = await resolver.resolve(NAME_FORM, ctx());

      expect(out).toBe(TOKYO_VALUE);
      expect(askedRegions()).toEqual([CONSUMER_REGION]);
    });

    it('is refused in an ASSEMBLED shape too, which the raw-leaf pre-pass could not see', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      await expect(
        resolver.resolve(
          {
            'Fn::Sub': [
              '{{resolve:secretsmanager:${TargetName}:SecretString:password}}',
              { TargetName: REF_NAME },
            ],
          },
          ctx({ producerRegions: [PRODUCER_REGION] })
        )
      ).rejects.toThrow(/without a region/);
      expect(askedRegions()).toEqual([]);
    });
  });

  describe('the delegation terminates', () => {
    it('asks the foreign region exactly once, not once per level', async () => {
      // The sibling re-enters `resolveDynamicReferences` and re-classifies. It
      // is pinned to the ARN's region, so the same classifier now compares that
      // region against its own and returns `local` -- exactly one level. A
      // second hop would show up as a second send here, and a non-terminating
      // one as a timeout.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);

      const out = await resolver.resolve(SHAPES[1].build(PRODUCER_ARN), ctx());

      expect(out).toBe(IRELAND_VALUE);
      expect(askedRegions()).toEqual([PRODUCER_REGION]);
    });

    /**
     * THE CONTROL, and it is what makes the test below meaningful rather than a
     * bare count.
     *
     * `Fn::Join` resolves each PART on its own, and a part that is a whole
     * reference is resolved before the join re-scans -- so the same expression
     * appearing twice is fetched twice. MEASURED, not assumed: this arm was
     * written expecting ONE fetch and failed with two, on the purely LOCAL
     * path that this PR does not touch at all.
     *
     * It is therefore pre-existing `Fn::Join` behaviour rather than anything
     * the #2134 delegation introduces, and asserting an absolute "one lookup"
     * on the foreign arm below would have pinned a property the local path does
     * not have either.
     */
    it('CONTROL: a LOCAL reference appearing twice is fetched once per occurrence', async () => {
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const expr = SHAPES[0].build(CONSUMER_ARN);

      const out = await resolver.resolve({ 'Fn::Join': ['|', [expr, expr]] }, ctx());

      expect(out).toBe(`${TOKYO_VALUE}|${TOKYO_VALUE}`);
      expect(askedRegions()).toEqual([CONSUMER_REGION, CONSUMER_REGION]);
    });

    it('delegating adds no round trips beyond what the local path costs', async () => {
      // PARITY with the control above is the invariant, not an absolute count:
      // two occurrences, two fetches, exactly as a local reference costs.
      //
      // WHAT THIS DOES NOT PROVE, stated because an earlier version of this
      // comment claimed it: it does NOT rule out a sibling rebuilt per
      // occurrence. A per-occurrence sibling is constructed with the same region
      // string, so the constructor region is identical either way -- measured by
      // a reviewer, who disabled the `producerRegionResolvers` memo and watched
      // this test stay green. Sibling REUSE is a performance property; what is
      // fenced here is that delegating costs no MORE round trips than the local
      // path, which is the correctness-adjacent half.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const expr = SHAPES[0].build(PRODUCER_ARN);

      const out = await resolver.resolve({ 'Fn::Join': ['|', [expr, expr]] }, ctx());

      expect(out).toBe(`${IRELAND_VALUE}|${IRELAND_VALUE}`);
      expect(askedRegions()).toEqual([PRODUCER_REGION, PRODUCER_REGION]);
      // ...and nothing was asked of the consumer region, which is the defect.
      expect(askedRegions()).not.toContain(CONSUMER_REGION);
    });
  });

  describe('the comparison path is unaffected', () => {
    it('a NAME-FORM reference with evidence is SKIPPED, not refused (placement fence)', async () => {
      // THE CASE THAT PINS WHERE THE CLASSIFIER SITS, built by a reviewer after
      // finding the placement unfenced. The classification is deliberately
      // BELOW the `skipDynamicReferences` early-continue; moving it above still
      // passed all 14 cases, because the only other skip test uses a foreign
      // ARN, which delegates and returns the expression unchanged either way.
      //
      // Only a NAME-FORM reference WITH evidence separates the two placements:
      // below the arm it is skipped (the comparison path fetches nothing, so
      // there is nothing to attribute); above it, it refuses -- turning every
      // `cdkd diff` over such a stack into an error.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const expr = `{{resolve:secretsmanager:${REF_NAME}:SecretString:password}}`;

      const out = await resolver.resolve(
        expr,
        ctx({ skipDynamicReferences: true, producerRegions: [PRODUCER_REGION] })
      );

      expect(out).toBe(expr);
      expect(askedRegions()).toEqual([]);
    });

    it('skips a foreign reference rather than refusing or routing it', async () => {
      // `skipDynamicReferences` is the diff / no-op comparison path: it resolves
      // nothing at all, so classifying there could only manufacture a refusal
      // for a reference nobody was going to fetch. The expression must come back
      // untouched.
      const resolver = new IntrinsicFunctionResolver(CONSUMER_REGION);
      const expr = SHAPES[0].build(PRODUCER_ARN);

      const out = await resolver.resolve(
        expr,
        ctx({ skipDynamicReferences: true, producerRegions: [PRODUCER_REGION] })
      );

      expect(out).toBe(expr);
      expect(askedRegions()).toEqual([]);
    });
  });
});
