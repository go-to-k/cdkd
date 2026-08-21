import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * `cdkd scrub` must not re-resolve a secret reference that belongs to ANOTHER
 * region against the stack's own region (issue
 * [#2109](https://github.com/go-to-k/cdkd/issues/2109), the `scrub.ts` sibling
 * of [#2057](https://github.com/go-to-k/cdkd/issues/2057)).
 *
 * scrub learns WHICH plaintexts to look for by re-resolving today's template
 * through one resolver built from the stack's own region. A reference naming
 * another region's ARN was therefore sent to this stack's regional endpoint,
 * and both halves of that go wrong at once: the plaintext scrub exists to
 * remove is never found (the needle is the wrong region's value), so the
 * command reports the stack CLEAN over state that still holds the secret; and
 * the foreign value is a real string, so scanning for it can rewrite an
 * unrelated stored literal.
 *
 * WHY THIS FILE FAKES THE SDK CLIENT CLASSES rather than the resolver (the same
 * choice `rollback-executor-cross-region-secret.test.ts` makes, and the reason
 * this suite cannot reuse `scrub.test.ts`'s resolver double): the whole question
 * is WHICH REGION WAS ASKED, and a resolver double has no region to be asked
 * about. The real `IntrinsicFunctionResolver` and the real `AwsClients` are
 * used; only the leaf `SecretsManagerClient` / `SSMClient` are faked, with the
 * CONSTRUCTOR region as the discriminator.
 *
 * The fixture primes the SAME reference with DIFFERENT values in the two
 * regions, which is the ordinary Secrets Manager reality and the only thing
 * that makes "which region answered" observable at all — a fixture where both
 * regions agree cannot tell the fixed path from the broken one.
 */

interface FakeClientConfig {
  region?: string;
  profile?: string;
}

interface FakeSend {
  /** The region the sending client was CONSTRUCTED with — the discriminator. */
  ctorRegion: string | undefined;
  region: string | undefined;
  command: string;
  input: unknown;
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

      async send(command: { input?: unknown; constructor: { name: string } }): Promise<unknown> {
        let region: string | undefined;
        try {
          region = await this.resolveRegion();
        } catch {
          region = undefined;
        }
        const name = command.constructor.name;
        sends.push({
          ctorRegion: this.ctorConfig.region,
          region,
          command: name,
          input: command.input,
        });
        const response = responses.get(`${String(region)}|${name}`);
        if (response === undefined) {
          throw new Error(`no ${serviceLabel} response primed for ${String(region)}|${name}`);
        }
        // A primed ERROR is thrown rather than returned, so a test can control
        // the failure MESSAGE a pinned lookup surfaces — which is what the
        // masking case needs and cannot get any other way (see its comment).
        if (response instanceof Error) throw response;
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
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager'),
  };
});

// An `ssm` reference can name an ARN too, so the ssm client needs the same
// region-observable fake as the secretsmanager one.
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], 'sts') };
});

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void => void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../../src/deployment/intrinsic-function-resolver.js';
import { clearRecordedSecretExpressions } from '../../../../src/deployment/secret-redaction.js';
import { scrubStack } from '../../../../src/cli/commands/scrub.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const CONSUMER_REGION = 'ap-northeast-1';
const PRODUCER_REGION = 'eu-west-1';
const PROFILE = 'cdkd-lane-2109';

const SECRET_NAME = 'prod/db/cred';
/** The producer's own, region-less spelling — what issue #1934 persists downstream. */
const NAME_EXPR = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}`;
const CONSUMER_ARN = `arn:aws:secretsmanager:${CONSUMER_REGION}:111122223333:secret:${SECRET_NAME}-AbCdEf`;
const PRODUCER_ARN = `arn:aws:secretsmanager:${PRODUCER_REGION}:111122223333:secret:${SECRET_NAME}-AbCdEf`;
const CONSUMER_ARN_EXPR = `{{resolve:secretsmanager:${CONSUMER_ARN}:SecretString:password}}`;
const PRODUCER_ARN_EXPR = `{{resolve:secretsmanager:${PRODUCER_ARN}:SecretString:password}}`;

/**
 * Two regions holding DIFFERENT values behind the SAME reference. Without this
 * the assertions below could only say "a value came back", which the broken
 * path satisfies just as well as the fixed one.
 */
const TOKYO_PASSWORD = 'tokyo-password-2109';
const IRELAND_PASSWORD = 'ireland-password-2109';

/**
 * The two shapes that ASSEMBLE a reference out of parts. Neither is a complete
 * `{{resolve:...}}` token in the RAW template, so the shared token scan
 * (`\{\{resolve:[^}]+\}\}`, a class that cannot cross the `}` of `${Env}` or
 * the end of a Join part) finds ZERO tokens in them — while the leaf plainly
 * OPENS a reference. That gap is what the unclassifiable guard closes: without
 * it the leaf is returned by identity, and `resolveSub` / `resolveJoin` then
 * hand the assembled expression to the PRIMARY resolver, which is issue #2109
 * verbatim with the ambiguous refusal never firing.
 *
 * THAT LAST CLAUSE IS NO LONGER TRUE, and is kept only to record what the
 * guard was written against. Since issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134) the resolver classifies
 * the ASSEMBLED expression itself, so a leaf this guard refuses would now be
 * answered correctly if it were let through -- routed to the region its ARN
 * names, or refused per-reference on its own evidence. The guard therefore
 * only OVER-refuses today; it is kept because over-refusing is loud and
 * actionable, and relaxing it deliberately is issue
 * [#2157](https://github.com/go-to-k/cdkd/issues/2157). These cases still pin
 * live behaviour and are correct as written.
 */
const SUB_ASSEMBLED_EXPR = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:\${Env}-db:SecretString:password}}`,
    { Env: 'prod' },
  ],
};
const JOIN_SPLIT_EXPR = {
  'Fn::Join': ['', ['{{resolve:secretsmanager:', 'prod-db', ':SecretString:password}}']],
};
/**
 * The THIRD assembled shape, and the one the opening/token COUNT provably
 * cannot see: the `Fn::Sub` placeholder is TRAILING, so `[^}]+` stops at the
 * `}` of `${Field}` and the following `}}` closes the match ONE BRACE SHORT.
 * The scan therefore returns exactly one whole-looking token for exactly one
 * opening — measured — and only the "a whole token still contains `${`" test
 * catches it. Both the name form and the ARN form are kept: before that second
 * test they took different downstream paths (`ambiguous` vs. a lookup in the
 * producer region that happened to fail), i.e. they were safe by luck rather
 * than by the guard.
 */
const TRAILING_SUB_NAME_EXPR = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:\${Field}}}`;
/**
 * The shape issue [#2157](https://github.com/go-to-k/cdkd/issues/2157) unlocks,
 * and the one whose refusal actually cost something: a WELL-FORMED reference to
 * a FOREIGN secret, assembled by `Fn::Sub` out of a parameter holding the ARN.
 * The raw leaf opens one reference and yields zero whole tokens, so the pre-pass
 * cannot classify it -- but `resolveSub` produces a complete ARN-form expression
 * that the resolver routes correctly. Pre-#2157 the whole stack refused.
 */
const SUB_ASSEMBLED_FOREIGN_ARN_EXPR = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:\${SecretArn}:SecretString:password}}`,
    { SecretArn: PRODUCER_ARN },
  ],
};
const TRAILING_SUB_ARN_EXPR = `{{resolve:secretsmanager:${PRODUCER_ARN}:SecretString:\${Field}}}`;

/**
 * Leaves that merely MENTION the dynamic-reference syntax. Every one of them
 * OPENS `{{resolve:` and yields ZERO whole tokens, so counting the bare opening
 * refused all three — permanently, for the whole stack, with no bypass flag —
 * in any stack with a foreign producer region on record. A description, an IAM
 * policy document, a UserData script or an env var saying this is ordinary, and
 * the refusal's remedy ("spell the reference as one complete literal") is
 * unactionable for prose. Counting only openings followed by a SECRET SERVICE
 * is what makes them pass.
 */
const PROSE_MENTIONS = [
  ['prose describing the syntax', 'Use the {{resolve: prefix for dynamic references'],
  ['a value ending in the bare opening', 'prefix {{resolve:'],
  ['an empty reference', '{{resolve:}}'],
  // The other side of the SAME filter: openings are counted per secret service,
  // so the TOKENS they are compared against must be filtered the same way. A
  // COMPLETE reference to a service CloudFormation does not define as a secret
  // yields one token and zero counted openings, and comparing it against the
  // unfiltered token count would refuse the leaf for having too FEW openings.
  ['a complete reference to a non-secret service', '{{resolve:someservice:x}}'],
] as const;

/** A leaf carrying a FOREIGN token, a LOCAL token and literal text around both. */
/**
 * A leaf carrying ONE COMPLETE region-less token AND a bare trailing opening --
 * the `Fn::Join`-split shape spliced beside a whole reference. Two counted
 * openings, one whole token, so ONLY the COUNT clause of
 * `isAssembledSecretReference` sees it; the `${` clause does not, because the
 * token it found is complete.
 *
 * It exists because the count clause was otherwise UNFENCED by the whole suite
 * (measured on the #2157 review: short-circuiting it to `false` left 15 496 of
 * 15 496 green). Every other assembled fixture here yields ZERO tokens, and a
 * zero-token leaf reaches the same identity return through the empty-`verdicts`
 * path whether the clause fires or not -- so the clause could only be caught by
 * a leaf where the two paths DIVERGE. Here they do: deferred, the resolver
 * refuses with its own code; classified by the pre-pass, the complete
 * region-less token is `ambiguous` and the PRE-PASS refuses with a different
 * one.
 */
const COUNT_ONLY_MIXED_EXPR = `${NAME_EXPR} plus a split part {{resolve:secretsmanager:`;
const MIXED_TWO_TOKEN_EXPR = `db://${PRODUCER_ARN_EXPR}@host/${CONSUMER_ARN_EXPR}`;
const MIXED_TWO_TOKEN_PLAINTEXT = `db://${IRELAND_PASSWORD}@host/${TOKYO_PASSWORD}`;
/** A producer-region secret whose VALUE is itself reference-shaped. */
const NESTED_TOKEN = '{{resolve:secretsmanager:other-secret:SecretString:pw}}';
/** An `ssm` reference naming a full ARN — `ssm` routes to a pinned sibling too. */
const PRODUCER_SSM_ARN = `arn:aws:ssm:${PRODUCER_REGION}:111122223333:parameter/app/pw`;
const PRODUCER_SSM_EXPR = `{{resolve:ssm:${PRODUCER_SSM_ARN}}}`;
/** A public template value for an output whose STORED value is a legacy leak. */
const PUBLIC_ENDPOINT = 'db.example.com';
/** A SECOND foreign region, for the leaf that resolves one reference then fails on another. */
const SECOND_PRODUCER_REGION = 'us-east-2';
const SECOND_PRODUCER_ARN_EXPR =
  `{{resolve:secretsmanager:arn:aws:secretsmanager:${SECOND_PRODUCER_REGION}:111122223333:` +
  `secret:other/db-XyZ:SecretString:password}}`;

const logger = {
  debug: (...a: unknown[]): void => void logLines.push(`debug ${a.map(String).join(' ')}`),
  info: (...a: unknown[]): void => void logLines.push(`info ${a.map(String).join(' ')}`),
  warn: (...a: unknown[]): void => void logLines.push(`warn ${a.map(String).join(' ')}`),
  error: (...a: unknown[]): void => void logLines.push(`error ${a.map(String).join(' ')}`),
} as never;

function makeStackInfo(
  expr: unknown,
  outputs?: Record<string, unknown>,
  /**
   * Extra TEMPLATE properties. The pre-pass walks the TEMPLATE bag, not the
   * stored one, so a leaf that only exists in `makeLeakyState` never reaches
   * the guard at all — which is how the first draft of the prose cases below
   * passed with the guard mutated (measured).
   */
  extraProps?: Record<string, unknown>,
  /**
   * Template `Parameters`. Needed only by the issue #2134 cases, which have to
   * produce a leaf whose `{{resolve:` OPENING is contributed by an intrinsic --
   * a `Default` holding the reference, referenced through `Fn::Sub`. Any leaf
   * that spells the opening literally is caught by the pre-pass instead, which
   * is a different guard.
   */
  parameters?: Record<string, unknown>
): {
  stackName: string;
  displayName: string;
  artifactId: string;
  template: CloudFormationTemplate;
  dependencyNames: string[];
} {
  return {
    stackName: 'Consumer',
    displayName: 'Consumer',
    artifactId: 'Consumer',
    dependencyNames: [],
    template: {
      ...(parameters && { Parameters: parameters }),
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: { MasterUserPassword: expr, MasterUsername: 'admin', ...extraProps },
        },
      },
      ...(outputs && { Outputs: outputs }),
    } as CloudFormationTemplate,
  };
}

/**
 * State written by an old binary: it holds the PRODUCER region's plaintext,
 * because that is the value the deploy resolved for this reference.
 */
function makeLeakyState(
  storedPassword: string,
  crossRegionReads: 'imports' | 'outputReads' | 'none' = 'none',
  /**
   * What the record holds at the leaf the template does NOT position with a
   * secret reference. The template says `admin` there, so this leaf is reachable
   * only by the VALUE SCAN — which is where a wrong-region plaintext becomes a
   * bogus NEEDLE that rewrites an unrelated literal.
   */
  storedUsername = 'admin',
  /** What `state.outputs` holds, for the cases whose leak lives there. */
  storedOutputs: Record<string, unknown> = {}
): StackState {
  return {
    version: 8,
    region: CONSUMER_REGION,
    stackName: 'Consumer',
    resources: {
      Db: {
        physicalId: 'db-1',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { MasterUserPassword: storedPassword, MasterUsername: storedUsername },
      },
    },
    outputs: storedOutputs,
    ...(crossRegionReads === 'imports' && {
      imports: [
        { sourceStack: 'Producer', sourceRegion: PRODUCER_REGION, exportName: 'Producer:Db' },
      ],
    }),
    ...(crossRegionReads === 'outputReads' && {
      outputReads: [
        { sourceStack: 'Producer', sourceRegion: PRODUCER_REGION, outputName: 'DbSecret' },
      ],
    }),
    lastModified: 0,
  };
}

function prime(region: string, command: string, response: unknown): void {
  responses.set(`${region}|${command}`, response);
}

let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
let lockManager: {
  acquireLockWithRetry: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
};
let savedRegion: string | undefined;

function useState(state: StackState): void {
  stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });
}

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  delete process.env['AWS_REGION'];
  responses.clear();
  secretSends.length = 0;
  ssmSends.length = 0;
  logLines.length = 0;
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  setAwsClients(new AwsClients({ region: CONSUMER_REGION, profile: PROFILE }));
  prime(CONSUMER_REGION, 'GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: TOKYO_PASSWORD }),
  });
  prime(PRODUCER_REGION, 'GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: IRELAND_PASSWORD }),
  });
  stateBackend = {
    getState: vi.fn().mockResolvedValue({ state: makeLeakyState(IRELAND_PASSWORD), etag: 'etag-1' }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
  };
  lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  resetAwsClients();
  clearRecordedSecretExpressions();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

async function scrub(
  expr: unknown,
  outputs?: Record<string, unknown>,
  extraProps?: Record<string, unknown>,
  parameters?: Record<string, unknown>
): Promise<{
  recordsChanged: number;
  secretsFound: number;
  secretBearingKeys: number;
  deferredUnresolvedReads: number;
}> {
  return await scrubStack(
    makeStackInfo(expr, outputs, extraProps, parameters) as never,
    CONSUMER_REGION,
    stateBackend as never,
    lockManager as never,
    { dryRun: false, logger }
  );
}

describe('a region-AMBIGUOUS refusal is not swallowed by the best-effort catch (issue #2134)', () => {
  /**
   * THE GAP THAT SHIPPED THE BUG, closed at the level it lives at.
   *
   * The #2134 refusal is raised inside `resolveDynamicReferences`, and every
   * unit test of it drove the RESOLVER directly -- so all of them were green
   * while `scrubStack` wrapped that resolution in
   * `try { ... } catch { logger.debug(...) }` and downgraded the refusal to a
   * verbose line. The command then recorded no needle for the reference, left
   * the plaintext in `state.json`, and returned normally with `secretsFound: 0`.
   *
   * That is strictly WORSE than not refusing at all: pre-#2134 this shape
   * resolved locally, produced a needle, and the plaintext WAS scrubbed.
   *
   * THE SHAPE HAD TO BE CHOSEN, not guessed, and the first attempt was wrong.
   * A leaf that spells `{{resolve:` literally -- including the template string
   * of an `Fn::Sub` -- used to be caught by the PRE-PASS
   * (`SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE`), which is correctly placed OUTSIDE
   * the catch and so proved nothing about it. The shape that reaches the
   * resolver is the one issue #2134's scope-correction comment names: the
   * OPENING itself is contributed by an intrinsic. Here a template `Parameter`
   * holds the reference as its `Default` and the property is
   * `{"Fn::Sub": "${DbSecretRef}"}`, so the raw leaf is `"${DbSecretRef}"` -- no
   * opening at all, returned by identity, assembled only inside `resolveSub`.
   *
   * Issue [#2157](https://github.com/go-to-k/cdkd/issues/2157) has since made
   * the literal-spelling shape reach the resolver too (the pre-pass defers
   * rather than refusing), so this fixture is no longer the ONLY one that gets
   * there. It is kept as-is because it reaches the resolver for a DIFFERENT
   * reason -- the pre-pass never sees an opening at all -- and that route is
   * unaffected by #2157, so it still fences the catch independently.
   *
   * A SECOND case used to sit beside the one below, asserting that the error was
   * NOT the pre-pass's `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE`. #2157 retired
   * that code, which made the assertion true of every possible outcome, and its
   * replacement (`secretSends` is empty) could not fail independently either --
   * this leaf carries no `{{resolve:` opening, so the pre-pass can never issue a
   * lookup for it whatever the code does. It is DELETED rather than reworded:
   * the case below already discriminates, because the pre-pass's own ambiguity
   * refusal carries `SCRUB_SECRET_REGION_AMBIGUOUS` and could only ever have
   * named the raw `${DbSecretRef}` spelling.
   */
  const ASSEMBLED_VIA_PARAMETER = { 'Fn::Sub': '${DbSecretRef}' };
  const PARAMETER_HOLDING_REFERENCE = { DbSecretRef: { Type: 'String', Default: NAME_EXPR } };

  it('scrubStack THROWS rather than reporting a clean scrub', async () => {
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports', IRELAND_PASSWORD));

    await expect(
      scrub(ASSEMBLED_VIA_PARAMETER, undefined, undefined, PARAMETER_HOLDING_REFERENCE)
    ).rejects.toMatchObject({ code: 'DYNAMIC_REFERENCE_REGION_AMBIGUOUS' });
  });


  it('CONTROL: with NO cross-region read on record the same template scrubs normally', async () => {
    // Without this the cases above are also what a scrub refusing EVERY
    // assembled reference would produce -- a refusal that fires on everything
    // satisfies every positive assertion about refusing. The EVIDENCE is what
    // arms it, so removing the evidence must restore an ordinary, successful
    // scrub of the identical template.
    useState(makeLeakyState(TOKYO_PASSWORD, 'none', TOKYO_PASSWORD));

    const result = await scrub(
      ASSEMBLED_VIA_PARAMETER,
      undefined,
      undefined,
      PARAMETER_HOLDING_REFERENCE
    );

    expect(result.secretsFound).toBeGreaterThan(0);
  });

  it('CONTROL: the wiring is what arms it -- this fails if scrub stops passing producerRegions', async () => {
    // Aimed at a specific surviving mutation a reviewer found: deleting
    // `producerRegions` from scrub's resolver context passed every suite,
    // because nothing tied the COMMAND's wiring to the refusal. The first case
    // above is that fence; this one states the dependency explicitly so a
    // future reader sees which line it protects.
    useState(makeLeakyState(IRELAND_PASSWORD, 'outputReads', IRELAND_PASSWORD));

    await expect(
      scrub(ASSEMBLED_VIA_PARAMETER, undefined, undefined, PARAMETER_HOLDING_REFERENCE)
    ).rejects.toMatchObject({ code: 'DYNAMIC_REFERENCE_REGION_AMBIGUOUS' });
  });
});

describe('cdkd scrub resolves a foreign-region secret in ITS OWN region (issue #2109)', () => {
  it('ARN naming a FOREIGN region: answered by a client CONSTRUCTED in that region, and the producer plaintext is what gets scrubbed', async () => {
    // The producer plaintext sits at BOTH leaves, and the second one is why.
    // `MasterUserPassword` is POSITIONED by the template's secret reference, so
    // the position pass rewrites it to that expression whatever region answered
    // — a confluence point that cannot tell the fixed path from the broken one,
    // which is what left this case resting on its two `ctorRegion` lines alone.
    // `MasterUsername` is positioned by the public literal `admin`, so only the
    // VALUE SCAN can reach it, and the scan's needle IS the resolved plaintext.
    // That makes this the issue's HEADLINE in positive polarity: the secret the
    // scrub was meant to remove is actually removed.
    useState(makeLeakyState(IRELAND_PASSWORD, 'none', IRELAND_PASSWORD));

    const res = await scrub(PRODUCER_ARN_EXPR);

    // THE discriminator. The broken path asks the stack's own region and gets
    // the Tokyo password, which is not what state holds — so it finds nothing
    // and reports the stack clean over the surviving Ireland plaintext.
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect(secretSends.map((s) => s.ctorRegion)).not.toContain(CONSUMER_REGION);

    expect(res.recordsChanged).toBe(1);
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(PRODUCER_ARN_EXPR);
    // The value-scan-only leaf: with the WRONG region's needle this still holds
    // the Ireland plaintext, and the command reports the stack clean over it.
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(PRODUCER_ARN_EXPR);
    // The plaintext is gone from the persisted document — the command's job.
    expect(JSON.stringify(saved)).not.toContain(IRELAND_PASSWORD);
  });

  it('ARN naming a foreign region: the CONSUMER region value never becomes a needle', async () => {
    // `MasterUsername` holds a literal that COINCIDES with the consumer
    // region's same-named secret, and the template positions that leaf with the
    // public string `admin` — so only the VALUE SCAN can reach it. The broken
    // path resolves Tokyo, matches this literal, and rewrites it onto the
    // producer's expression: a fabricated reference written into the very bag
    // scrub exists to repair. The `MasterUserPassword` leaf is scrubbed either
    // way (the position pass takes the source expression regardless of the
    // value), which is why the assertion is on the OTHER leaf.
    useState(makeLeakyState(IRELAND_PASSWORD, 'none', TOKYO_PASSWORD));

    await scrub(PRODUCER_ARN_EXPR);

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(TOKYO_PASSWORD);
    expect(saved.resources['Db']!.properties['MasterUsername']).not.toBe(PRODUCER_ARN_EXPR);
  });

  it('region-LESS reference with a cross-region IMPORT on record: refuses instead of asking the stack region', async () => {
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports'));

    await expect(scrub(NAME_EXPR)).rejects.toThrow(/carries no region of its own/);

    // Asks NOBODY: the refusal lands before any secret is read.
    expect(secretSends).toHaveLength(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // The lock is still released — the refusal is thrown inside the try/finally.
    expect(lockManager.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('the refusal names the reference, both regions and the remedy, and leaks neither value', async () => {
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports'));

    const err = await scrub(NAME_EXPR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(SECRET_NAME);
    expect(message).toContain(CONSUMER_REGION);
    expect(message).toContain(PRODUCER_REGION);
    expect(message).toContain("resource 'Db'");
    expect(message).toContain("re-run 'cdkd scrub'");
    // A `CdkdError` with a code is what maps to a NON-ZERO EXIT rather than a
    // debug line under a "nothing to scrub" summary.
    expect((err as { code?: string }).code).toBe('SCRUB_SECRET_REGION_AMBIGUOUS');
    // Exit 2 ("error"), NOT the `CdkdError` default of 1 — which `--fail`
    // already spends on `ScrubNeededError` ("plaintext found"). A CI gate
    // reading the exit code alone must not confuse "refused to look" with
    // "looked and found a leak": the two call for opposite responses.
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(message).not.toContain(TOKYO_PASSWORD);
    expect(message).not.toContain(IRELAND_PASSWORD);
    expect(logLines.join('\n')).not.toContain(TOKYO_PASSWORD);
    expect(logLines.join('\n')).not.toContain(IRELAND_PASSWORD);
  });

  it('region-LESS reference with a cross-region Fn::GetStackOutput READ on record: refused too', async () => {
    // `state.outputReads` is the weak (schema v8) edge and is the EASIER of the
    // two to point across a region boundary, so it counts as evidence as well.
    useState(makeLeakyState(IRELAND_PASSWORD, 'outputReads'));

    await expect(scrub(NAME_EXPR)).rejects.toThrow(/carries no region of its own/);
    expect(secretSends).toHaveLength(0);
  });

  it('region-LESS reference with NO cross-stack read on record: resolved in the stack region, exactly as before', async () => {
    useState(makeLeakyState(TOKYO_PASSWORD));

    const res = await scrub(NAME_EXPR);

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION]);
    expect(res.recordsChanged).toBe(1);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(NAME_EXPR);
  });

  it('ARN naming the stack OWN region: stays local even with a foreign producer region on record', async () => {
    // The expression settles the question itself, so the weaker per-stack
    // evidence is never consulted.
    useState(makeLeakyState(TOKYO_PASSWORD, 'imports'));

    const res = await scrub(CONSUMER_ARN_EXPR);

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION]);
    expect(res.recordsChanged).toBe(1);
  });

  it('a MIXED leaf splices a FOREIGN token, a LOCAL token and literal text, and each is resolved in its own region', async () => {
    // One leaf, two references, text around and between them. The SPLICE is the
    // part with no other coverage: every other case here hands the pin a leaf
    // that IS a single whole token, so a bug that dropped the untouched local
    // token (or the literal text) from the rebuilt string was invisible — and a
    // dropped local token means its plaintext is never recorded, so the state
    // leaf holding it survives the scrub.
    //
    // It carries a cross-region IMPORT on record deliberately, which makes it
    // the NEGATIVE side of the unclassifiable-reference guard as well: this leaf
    // opens two references and the scan finds two COMPLETE tokens, so the guard
    // must wave it through even with foreign evidence armed. (Its ARN-form
    // sibling — one whole token plus evidence — is the case below.)
    useState(makeLeakyState(MIXED_TWO_TOKEN_PLAINTEXT, 'imports'));

    await scrub(MIXED_TWO_TOKEN_EXPR);

    // The foreign one is answered by its own region's client FIRST (the pin runs
    // before the primary resolution), the local one by the stack's own.
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION, CONSUMER_REGION]);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    // BOTH plaintexts are replaced by the expression that produced each, which
    // requires that both were recorded — i.e. that the rebuilt leaf still held
    // the local token and the literal text between them.
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(MIXED_TWO_TOKEN_EXPR);
    expect(JSON.stringify(saved)).not.toContain(IRELAND_PASSWORD);
    expect(JSON.stringify(saved)).not.toContain(TOKYO_PASSWORD);
  });

  it('an Fn::Sub-ASSEMBLED reference is refused by the RESOLVER, after assembly (#2157)', async () => {
    // The token scan finds NOTHING in an assembled reference — `[^}]+` cannot
    // cross the `}` of `${Env}` — so this pre-pass cannot classify the leaf and
    // hands it on BY IDENTITY. `resolveSub` then assembles
    // `{{resolve:secretsmanager:prod-db:SecretString:password}}` and the PRIMARY
    // resolver classifies THAT (issue #2134): a region-LESS name in a stack that
    // reads across a region boundary is `ambiguous`, so the refusal still fires
    // — one layer down, on the complete expression, with the same safety.
    //
    // Before issue #2157 this same input threw the pre-pass's own
    // `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE`. The CODE is the discriminator
    // here: it is the one observable that separates "refused before assembly
    // because nothing could classify it" from "classified after assembly and
    // found genuinely ambiguous", and only the second is reachable now.
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports'));

    const err = await scrub(SUB_ASSEMBLED_EXPR).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('DYNAMIC_REFERENCE_REGION_AMBIGUOUS');
    const message = (err as Error).message;
    // The ASSEMBLED name, which is the point: the pre-pass could only ever have
    // named the raw `${Env}-db` spelling, because that is all it could see.
    expect(message).toContain('prod-db');
    expect(message).toContain(PRODUCER_REGION);
    // Still refused BEFORE any lookup, in either region — the property the old
    // pre-pass refusal bought, now bought downstream.
    expect(secretSends).toHaveLength(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockManager.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('an Fn::Join-SPLIT reference is refused by the resolver for the same reason (#2157)', async () => {
    // The other assembly shape: the reference is split ACROSS parts, so its
    // opening lives in a leaf with no closing brace anywhere in it. `resolveJoin`
    // joins the parts and re-enters `resolveDynamicReferences`, which reaches the
    // same verdict on the same assembled name.
    useState(makeLeakyState(IRELAND_PASSWORD, 'outputReads'));

    const err = await scrub(JOIN_SPLIT_EXPR).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('DYNAMIC_REFERENCE_REGION_AMBIGUOUS');
    expect((err as Error).message).toContain('prod-db');
    expect(secretSends).toHaveLength(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('an assembled reference with NO cross-region read on record proceeds exactly as before', async () => {
    // The guard is GATED on foreign-region evidence, and this is the other side
    // of that gate. With no producer region on record there is no cross-region
    // question to get wrong, and `Fn::Sub`-built references are ordinary — a
    // guard that refused here would refuse most templates.
    useState(makeLeakyState(TOKYO_PASSWORD));

    const res = await scrub(SUB_ASSEMBLED_EXPR);

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([CONSUMER_REGION]);
    expect(res.recordsChanged).toBe(1);
    expect(JSON.stringify(stateBackend.saveState.mock.calls[0]![2])).not.toContain(TOKYO_PASSWORD);
  });

  it('a foreign value that is itself reference-shaped is refused, never passed to the primary resolver', async () => {
    // #1917's guarantee (a resolved plaintext is never re-resolved) is a
    // property of ONE resolution over the ORIGINAL string, and it does not cross
    // this seam: the primary receives a string this pre-pass already substituted
    // into. So a producer-region value that is token-shaped would be resolved by
    // the stack's OWN region as if it were a reference of this stack's — a
    // lookup for an id spliced out of a plaintext.
    prime(PRODUCER_REGION, 'GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: NESTED_TOKEN }),
    });
    useState(makeLeakyState(IRELAND_PASSWORD));

    const err = await scrub(PRODUCER_ARN_EXPR).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_SECRET_RESOLUTION_REINTRODUCED_TOKEN');
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    // The producer region was asked once; the stack's own region never saw the
    // reintroduced token.
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('an OUTPUT VALUE naming a foreign region is pinned, and the producer plaintext in state.outputs is removed', async () => {
    // The outputs `Value` loop is a SEPARATE call site from the resource bag,
    // with its own secrets map, so no case above reaches it. `Endpoint` is the
    // discriminating leaf: today's template positions it with a public literal,
    // so only the value scan can repair its stored legacy plaintext — and the
    // needle is whatever region answered.
    useState(
      makeLeakyState('benign-stored-value', 'none', 'admin', {
        DbSecret: IRELAND_PASSWORD,
        Endpoint: IRELAND_PASSWORD,
      })
    );

    await scrub('no-reference-here', {
      DbSecret: { Value: PRODUCER_ARN_EXPR },
      Endpoint: { Value: PUBLIC_ENDPOINT },
    });

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs['Endpoint']).toBe(PRODUCER_ARN_EXPR);
    expect(JSON.stringify(saved)).not.toContain(IRELAND_PASSWORD);
  });

  it('an intrinsic Export.Name naming a foreign region is pinned too', async () => {
    // The THIRD call site, and the one with the widest blast radius: this
    // resolution's RESULT becomes a state KEY, so a wrong-region answer mis-keys
    // the whole positioned outputs pass. It also fills the SAME secrets map the
    // value loop uses, which is what makes the outcome observable at `Endpoint`.
    useState(makeLeakyState('benign-stored-value', 'none', 'admin', { Endpoint: IRELAND_PASSWORD }));

    await scrub('no-reference-here', {
      Endpoint: {
        Value: PUBLIC_ENDPOINT,
        Export: { Name: { 'Fn::Join': ['-', ['exp', PRODUCER_ARN_EXPR]] } },
      },
    });

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs['Endpoint']).toBe(PRODUCER_ARN_EXPR);
  });

  it('an ssm FULL-ARN reference is answered by the SSM client of the region the ARN names', async () => {
    // `resolveSSMReference` joins its colon-split tail back together, so an
    // `ssm` reference CAN name a full ARN and CAN therefore route to a pinned
    // sibling. It matters MORE than the secretsmanager case, not less: an ssm
    // parameter is secret exactly when its TYPE is `SecureString`, and the type
    // is region-dependent (#1957), so the stack's own region cannot be trusted
    // to classify another region's parameter.
    prime(PRODUCER_REGION, 'GetParameterCommand', {
      Parameter: { Value: IRELAND_PASSWORD, Type: 'SecureString' },
    });
    prime(CONSUMER_REGION, 'GetParameterCommand', {
      Parameter: { Value: TOKYO_PASSWORD, Type: 'SecureString' },
    });
    useState(makeLeakyState(IRELAND_PASSWORD, 'none', IRELAND_PASSWORD));

    await scrub(PRODUCER_SSM_EXPR);

    expect(ssmSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect(secretSends).toHaveLength(0);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(PRODUCER_SSM_EXPR);
    // The value-scan-only leaf again: the needle must be the PRODUCER's value.
    expect(saved.resources['Db']!.properties['MasterUsername']).toBe(PRODUCER_SSM_EXPR);
    expect(JSON.stringify(saved)).not.toContain(IRELAND_PASSWORD);
  });

  it('the unresolvable-region refusal MASKS what it echoes from the cause', async () => {
    // The refusal echoes the cause because it is the actionable half (a denied
    // read reads very differently from a missing secret). No resolver error
    // carries a plaintext TODAY — which is why the cause message here is
    // supplied by the fixture rather than produced by a real failure — but this
    // is a remediation command whose entire subject is a leaked plaintext, so
    // the day a message does carry one it must not be printed by the tool that
    // exists to remove it.
    //
    // The leaf splices TWO foreign references: the first RESOLVES (recording
    // its plaintext into the very map the refusal masks against), and the
    // second's region fails.
    prime(
      SECOND_PRODUCER_REGION,
      'GetSecretValueCommand',
      new Error(`AccessDenied while reading; the value it holds is ${IRELAND_PASSWORD}`)
    );
    useState(makeLeakyState(IRELAND_PASSWORD));

    const err = await scrub(`${PRODUCER_ARN_EXPR}|${SECOND_PRODUCER_ARN_EXPR}`).catch(
      (e: unknown) => e
    );

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_REGION_SECRET_UNRESOLVED');
    const message = (err as Error).message;
    expect(message).toContain('AccessDenied while reading');
    expect(message).not.toContain(IRELAND_PASSWORD);
    expect(message).toContain('***');
    expect(logLines.join('\n')).not.toContain(IRELAND_PASSWORD);
  });

  it('a foreign-region reference whose OWN region cannot answer is refused, not retried locally', async () => {
    // Nothing primed for the producer region: the pinned lookup throws.
    responses.delete(`${PRODUCER_REGION}|GetSecretValueCommand`);
    useState(makeLeakyState(IRELAND_PASSWORD));

    const err = await scrub(PRODUCER_ARN_EXPR).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_REGION_SECRET_UNRESOLVED');
    // The stack's own region was NEVER asked as a fallback — that fallback is
    // the defect itself.
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it.each(PROSE_MENTIONS)(
    'a leaf that only MENTIONS the syntax (%s) does not brick the stack',
    async (_label, prose) => {
      // The false positive the service filter closes. This stack has a foreign
      // producer region on record, so the guard is ARMED — and the prose leaf
      // opens `{{resolve:` while yielding no token, which is byte-for-byte the
      // mismatch an `Fn::Join` split produces. Counting the bare opening made
      // the whole stack permanently unscrubbable (exit 2, no bypass flag).
      //
      // The fixture is not merely non-refusing: the OTHER leaf carries a real
      // foreign reference, so the run must still do its job. A guard that
      // stopped refusing by disarming itself would fail that half.
      //
      // The prose goes into the TEMPLATE (`MasterUsername`) as well as into
      // state: this pre-pass walks the template bag, so a prose leaf that
      // existed only in the stored record would never reach the guard — the
      // first draft of these cases did exactly that and passed with the guard
      // mutated.
      useState(makeLeakyState(IRELAND_PASSWORD, 'imports', prose));

      const res = await scrub(PRODUCER_ARN_EXPR, undefined, { MasterUsername: prose });

      expect(res.recordsChanged).toBe(1);
      const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(PRODUCER_ARN_EXPR);
      // The prose is left exactly as it was — it is not a reference.
      expect(saved.resources['Db']!.properties['MasterUsername']).toBe(prose);
      expect(JSON.stringify(saved)).not.toContain(IRELAND_PASSWORD);
    }
  );

  it('a TRAILING Fn::Sub placeholder is DEFERRED here and refused by the resolver (#2157)', async () => {
    // The shape the opening/token count cannot catch: the scan closes one brace
    // short and returns a token, of the right class, one per opening. Only the
    // "a whole token still contains `${`" test spots it — and post-#2157 that
    // test DEFERS rather than refusing, so the truncated token is never
    // classified here at all. The NAME form is genuinely unattributable, so the
    // resolver's own refusal fires on it.
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports'));

    const err = await scrub(TRAILING_SUB_NAME_EXPR).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('DYNAMIC_REFERENCE_REGION_AMBIGUOUS');
    expect(secretSends).toHaveLength(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('the ARN form of that trailing placeholder is routed to the region the ARN NAMES (#2157)', async () => {
    // The discriminating half, and the one case in this group where the
    // relaxation changes the OUTCOME rather than the error code: an ARN names
    // its own region, so there is nothing ambiguous about it and the resolver
    // resolves it — against the PRODUCER's endpoint, which is the property that
    // matters. The pre-#2157 pre-pass refused this leaf outright.
    //
    // The consumer region must NOT be asked. That is the safety claim the old
    // refusal bought, and this asserts it POSITIVELY (which region was asked)
    // rather than as "nobody was asked", so a run that died early cannot pass.
    useState(makeLeakyState(IRELAND_PASSWORD, 'outputReads'));

    const res = await scrub(TRAILING_SUB_ARN_EXPR);

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    // Nothing is scrubbed, and that is NOT a #2157 regression -- it is the
    // outcome this exact leaf already had on `main` in a stack with NO foreign
    // producer region on record. `classifyReplaySecretRegion` verdicts an
    // ARN-form token `named-region` whatever evidence it holds (measured: the
    // `importedProducerRegions` loop is reached only for a region-LESS name),
    // so the pre-#2157 pre-pass fetched this same secret from this same region
    // and reported the same clean result there. The refusal fired ONLY when
    // evidence happened to be on record, which is the inconsistency #2157
    // removes: one shape, one behaviour.
    //
    // The reference is malformed -- a raw string leaf carrying `${Field}` with
    // no `Fn::Sub` to substitute it -- so its truncated token names no JSON key
    // and matches no stored plaintext. A template like this fails at deploy, so
    // no cdkd-written state can position a real secret through it.
    expect(res).toMatchObject({ recordsChanged: 0, secretsFound: 0 });
  });

  it('the COUNT clause defers a leaf that splices a WHOLE token beside a split opening (#2157)', async () => {
    // THE ONLY CASE THAT FENCES THE COUNT CLAUSE, and it was missing until the
    // #2157 review measured the clause inert against the whole suite. Every
    // other assembled fixture yields ZERO tokens, and a zero-token leaf reaches
    // the identity return through the empty-`verdicts` path anyway -- so the
    // clause changes nothing there and a probe cannot tell it apart.
    //
    // Here the two paths DIVERGE, which is what makes the assertion a
    // discriminator rather than a restatement:
    //
    //   - clause ON  (today): 2 openings vs 1 token -> DEFER the whole leaf ->
    //     the primary resolver classifies the complete region-less token and
    //     refuses with `DYNAMIC_REFERENCE_REGION_AMBIGUOUS`.
    //   - clause OFF: the pre-pass classifies that same token itself and
    //     refuses with its OWN `SCRUB_SECRET_REGION_AMBIGUOUS`.
    //
    // Both refuse, so an rc-only or a "did it refuse" assertion would pass
    // either way. The CODE is the observable that separates them.
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports'));

    const err = await scrub(COUNT_ONLY_MIXED_EXPR).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('DYNAMIC_REFERENCE_REGION_AMBIGUOUS');
    // Deferred means the PRE-PASS asked nobody; the refusal is the resolver's.
    expect(secretSends).toHaveLength(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a DEFERRED reference whose lookup FAILS is a warned finding, not a silent clean run (#2157)', async () => {
    // THE RESIDUAL THE FIRST DRAFT OF #2157 SHIPPED, found by three independent
    // reviews. Deferring moves the lookup INSIDE `resolver.resolve`, whose
    // errors land in `scrubStack`'s best-effort `catch { logger.debug }` -- so
    // a producer region that cannot answer became a verbose-only line under a
    // `No plaintext secrets found` summary, over state that still holds the
    // plaintext. The pre-pass's own `SCRUB_CROSS_REGION_SECRET_UNRESOLVED` is
    // loud for exactly this failure on the COMPLETE-token spelling, so the two
    // spellings had diverged in the one direction this command must not.
    //
    // NOT a refusal: the error surfaces from a whole-bag resolution and cannot
    // be attributed to the deferred leaf, so refusing would strand a stack over
    // an unrelated `Ref` failure. A FINDING instead -- warned, counted, and the
    // clean line suppressed.
    prime(PRODUCER_REGION, 'GetSecretValueCommand', new Error('Denied by the producer region'));
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports'));

    const res = await scrub(SUB_ASSEMBLED_FOREIGN_ARN_EXPR);

    // The COUNT is the discriminator: it is non-zero only on this path.
    expect(res.deferredUnresolvedReads).toBe(1);
    const logs = logLines.join('\n');
    expect(logs).toContain('could not resolve a secret reference the intrinsics ASSEMBLE');
    // It names the LEAF, not only the resource -- an assembled reference is one
    // leaf of a bag that can carry hundreds.
    expect(logs).toContain('MasterUserPassword');
    // Neither region's value is echoed by the failure path.
    expect(logs).not.toContain(IRELAND_PASSWORD);
    // NOT asserted here: that the run stops reporting the stack CLEAN. Both
    // clean lines are emitted by `scrubCommand`, and this helper drives
    // `scrubStack`, so `not.toContain('No plaintext secrets found')` could not
    // fail under any mutation -- it was in this test's first cut and is exactly
    // why the aggregate gate shipped unwired (round 2 of the #2157 review). It
    // lives in `scrub-all-refusal-boundary.test.ts`, at command level, where the
    // string can actually be printed.
  });

  it('the shape #2157 UNLOCKS: an Fn::Sub-assembled FOREIGN ARN is scrubbed, not refused', async () => {
    // The case the relaxation exists for, and the discriminator for the whole
    // change: `main` REFUSES this leaf (the raw string opens one reference and
    // the scan finds zero whole tokens, and a foreign producer region is on
    // record), so the stack is unscrubbable with no bypass flag while its
    // state.json still holds the plaintext.
    //
    // Post-#2157 the pre-pass defers, `resolveSub` assembles the complete
    // foreign-ARN reference, and the resolver routes it to the region the ARN
    // NAMES (issue #2134). Both halves are asserted positively: the producer's
    // endpoint answered, the consumer's was never asked, and the plaintext is
    // gone from the saved record.
    useState(makeLeakyState(IRELAND_PASSWORD, 'imports'));

    const res = await scrub(SUB_ASSEMBLED_FOREIGN_ARN_EXPR);

    expect(secretSends.map((s) => s.ctorRegion)).toEqual([PRODUCER_REGION]);
    expect(res.recordsChanged).toBe(1);
    // NEGATIVE CONTROL for the issue #2157 FINDING, and the one this file can
    // give that `scrub-all-refusal-boundary.test.ts` cannot: this leaf WAS
    // deferred, and the resolver answered it. A recorder keyed on "deferred and
    // something threw" -- the first cut -- was silent here only by luck, since
    // nothing else in the bag failed; keying it on whether the raw leaf SURVIVED
    // makes the silence a property of the resolution rather than of the bag.
    expect(res.deferredUnresolvedReads).toBe(0);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(JSON.stringify(saved)).not.toContain(IRELAND_PASSWORD);
    // The EXPRESSION is what replaces it, not merely "not the plaintext" -- a
    // record scrubbed to `undefined` would satisfy the negative alone. It is
    // the ASSEMBLED expression rather than the `Fn::Sub` node: scrub restores
    // what the deploy would persist post-#1934, and the deploy persists the
    // reference, not the intrinsic that built it.
    expect(saved.resources['Db']!.properties['MasterUserPassword']).toBe(PRODUCER_ARN_EXPR);
  });

  it('a partial-resolution DEBUG line masks what it echoes from the resolver', async () => {
    // The leaf splices a FOREIGN reference (which the pin resolves, recording
    // the Ireland plaintext into this resource's map) and a LOCAL one (which
    // the pin leaves for the PRIMARY resolver). The local lookup then fails
    // with a message carrying that plaintext — the site class
    // `unresolvableForeignScrubSecretError` says must mask, reached through the
    // best-effort catch instead of through a refusal.
    prime(
      CONSUMER_REGION,
      'GetSecretValueCommand',
      new Error(`AccessDenied on the local secret; the recorded value is ${IRELAND_PASSWORD}`)
    );
    useState(makeLeakyState(IRELAND_PASSWORD));

    await scrub(`${PRODUCER_ARN_EXPR}|${CONSUMER_ARN_EXPR}`);

    const logs = logLines.join('\n');
    // The line fired, and it kept the ACTIONABLE half.
    expect(logs).toContain('during scrub was partial');
    expect(logs).toContain('AccessDenied on the local secret');
    // ...but not the plaintext this command exists to remove.
    expect(logs).not.toContain(IRELAND_PASSWORD);
    expect(logs).toContain('***');
  });

  it('the Export.Name WARN masks what it echoes — the one of the three at default verbosity', async () => {
    prime(
      CONSUMER_REGION,
      'GetSecretValueCommand',
      new Error(`AccessDenied on the export name; the recorded value is ${IRELAND_PASSWORD}`)
    );
    useState(makeLeakyState('benign-stored-value', 'none', 'admin', { Endpoint: 'public' }));

    await scrub('no-reference-here', {
      Endpoint: {
        Value: PUBLIC_ENDPOINT,
        Export: { Name: { 'Fn::Join': ['-', ['exp', PRODUCER_ARN_EXPR, CONSUMER_ARN_EXPR]] } },
      },
    });

    const warned = logLines.filter((l) => l.startsWith('warn ')).join('\n');
    expect(warned).toContain('could not be resolved during scrub');
    expect(warned).toContain('AccessDenied on the export name');
    expect(warned).not.toContain(IRELAND_PASSWORD);
    expect(warned).toContain('***');
  });

  it('the output-VALUE partial-resolution debug line masks what it echoes', async () => {
    prime(
      CONSUMER_REGION,
      'GetSecretValueCommand',
      new Error(`AccessDenied on the output value; the recorded value is ${IRELAND_PASSWORD}`)
    );
    useState(makeLeakyState('benign-stored-value', 'none', 'admin', { Endpoint: 'public' }));

    await scrub('no-reference-here', {
      Endpoint: { Value: `${PRODUCER_ARN_EXPR}|${CONSUMER_ARN_EXPR}` },
    });

    const logs = logLines.join('\n');
    expect(logs).toContain('Resolution of output Endpoint during scrub was partial');
    expect(logs).toContain('AccessDenied on the output value');
    expect(logs).not.toContain(IRELAND_PASSWORD);
    expect(logs).toContain('***');
  });

  it('an error ESCAPING scrubStack is masked through its whole cause chain', async () => {
    // The per-site masks above cannot close this one: an error that leaves this
    // function is rendered as an OBJECT — `formatError`'s `Caused by:` line and
    // `src/cli/index.ts`'s `console.error` (`util.inspect`, which walks every
    // `[cause]` link and every link's `stack`). So the boundary masks the
    // object. The failure is placed on `saveState`, which runs AFTER the pin
    // has recorded the Ireland plaintext.
    useState(makeLeakyState(IRELAND_PASSWORD, 'none', IRELAND_PASSWORD));
    stateBackend.saveState.mockRejectedValue(
      new Error('failed to write state', {
        cause: new Error(`AccessDenied: PutObject; the value it holds is ${IRELAND_PASSWORD}`),
      })
    );

    const err = await scrub(PRODUCER_ARN_EXPR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    // The generic top message survives, and so does the actionable cause...
    expect((err as Error).message).toBe('failed to write state');
    const cause = (err as { cause?: Error }).cause;
    expect(cause?.message).toContain('AccessDenied: PutObject');
    // ...but the plaintext is gone from EVERY link, and from the traces the
    // inspect-style readers print alongside them.
    expect(cause?.message).not.toContain(IRELAND_PASSWORD);
    expect(cause?.message).toContain('***');
    expect(String(cause?.stack)).not.toContain(IRELAND_PASSWORD);
  });
});
