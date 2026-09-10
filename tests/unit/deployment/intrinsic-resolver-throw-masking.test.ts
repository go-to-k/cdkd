/**
 * Issues [#2827](https://github.com/go-to-k/cdkd/issues/2827) (mask at the
 * THROW) and [#2759](https://github.com/go-to-k/cdkd/issues/2759) (a value
 * TRANSFORMED during resolution is invisible to a literal needle).
 *
 * `IntrinsicFunctionResolver` masked a resolved value when it LOGGED it and
 * left it bare when it THREW. The throw is the copy that travels: it crosses
 * into every caller, and a caller that masks at its own boundary can only mask
 * against ITS bag — which is why three separate issues each fixed one boundary
 * (#2728 `DeployEngine.handleOutputResolutionFailure`, #2803 `cdkd import`,
 * #2748 `evaluateConditions`) and the class kept recurring. This file pins the
 * PRODUCER end, site by site.
 *
 * WHY THE REAL RESOLVER OVER A FAKED SDK. The exposure depends on what the
 * resolver ECHOES, so a fake that throws a message already containing a
 * plaintext would be manufacturing the thing under test. Every case below
 * drives the real resolver over a shape it ASSEMBLES itself: an `Fn::Sub`
 * whose variable resolves the secret's key, so the resolved PLAINTEXT lands in
 * the position the throw names.
 *
 * FOUR fakes DO echo an input back, and each echoes it the way the real service
 * does — an earlier draft of this paragraph claimed there was one, and a
 * reviewer's grep refuted it: EC2 `DescribeAvailabilityZones` (the region it
 * was called with), Secrets Manager's AccessDenied (the resource it refused),
 * CloudFormation's AccessDenied (the `StackName` it was asked about), and the
 * exports-index parse failure (the INDEX key, deliberately NOT the export name
 * — see that case). Echoing an INPUT is not manufacturing a leak.
 *
 * ONE fake goes further, and it is named here rather than only at its case:
 * `DescribeVpcs` returns a test-supplied plaintext as the VPC's IPv6 CIDR (see
 * `vpcBehaviour`). That is a plaintext hard-coded into a fake's DATA, which the
 * paragraph above used to say nothing does. It is legitimate and it is not a
 * fence for a reachable leak: the case it drives is labelled DEFENCE IN DEPTH,
 * and what it pins is the ENCODING ORDER at that site, not that a secret can
 * arrive there. A fake's message is a different matter — none manufactures one.
 *
 * THREE THINGS EVERY SITE GETS, per the issues' verification plans:
 *
 * 1. the masked assertion — the plaintext is absent, `***` is present, and the
 *    surrounding diagnosis SURVIVES (so a mask-everything regression is not
 *    what makes the case pass);
 * 2. a CONTROL in the same position with an UNRECORDED value, which must come
 *    through verbatim — the mask is a needle set, not a blanket;
 * 3. for the two TRUNCATING sites (`Fn::GetAZs`, `Fn::GetStackOutput`'s region
 *    gate) a LONG-needle arm, > 64 characters. A short-needle fixture there
 *    passes against a mask applied AFTER `stripControlChars().slice(0, 64)`
 *    and proves nothing; the long one fails unless the mask runs FIRST.
 *
 * WHAT IS DELIBERATELY NOT CLOSED, and is asserted as a residual rather than
 * described: a sub-`MIN_NEEDLE_LENGTH` plaintext sitting INSIDE a longer
 * segment (`key-${Pw}`). The raw value is then a SUPERSTRING of the needle, so
 * the mask falls to the substring arm where the floor drops it — at the throw
 * and at every boundary alike (#2827 comment 4). That case lives in
 * `tests/unit/cli/import-resolver-error-masking.test.ts` beside its
 * now-CLOSED whole-segment twin.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const SECRET_ID = 'cdkd-throw-mask-probe';

/** The ordinary needle: long enough for the substring arm, mixed case. */
const PASSWORD = 'Zk7pQw2mVx';

/**
 * 80 characters, the length the `Fn::GetAZs` measurement in #2827's comment 1
 * used. Two properties are load-bearing: it is longer than the 64-character
 * truncation, so an after-truncation mask cannot match it; and it FAILS
 * `isClientSafeRegion` (`/^[a-z0-9][a-z0-9-]{0,30}$/`) on length, so the
 * region gates it is fed to actually throw.
 */
const LONG_PASSWORD = 'zk7pqw2mvxabcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz012345ab';

/**
 * REGION-SHAPED, so it clears `isClientSafeRegion` and reaches the two
 * `Fn::GetAZs` throws BEYOND the gate. That gate is only
 * `/^[a-z0-9][a-z0-9-]{0,30}$/`, which a real plaintext can satisfy — which is
 * why those two throws are in the class at all.
 */
const REGION_PASSWORD = 'ap-southeast-9zz';

/**
 * Carries a `"` and a `\`, the two characters `JSON.stringify` ESCAPES. This
 * is the #2759 shape: after encoding, the plaintext no longer OCCURS in the
 * text, so a mask over the encoded string matches nothing however long the
 * needle is.
 */
const QUOTED_PASSWORD = 'pa"ss\\word12';

/**
 * A needle SPLIT by an invisible. `stripControlChars` DELETES rather than
 * replaces, so masking BEFORE it misses this (the split copy is not the needle)
 * and the strip then RECONSTITUTES the plaintext contiguous — the reason the
 * two truncating gates mask in BOTH string spaces. Long enough that the
 * stripped form is still over the 64-char truncation, so the case cannot be
 * satisfied by truncation alone.
 */
const SPLIT_PASSWORD = `zk7pqw2mvx\u200eabcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz012345ab`;
/** What `stripControlChars` turns `SPLIT_PASSWORD` into — the contiguous secret. */
const SPLIT_PASSWORD_STRIPPED = SPLIT_PASSWORD.replace('\u200e', '');

/** Never recorded — the CONTROL value every site is also driven with. */
const UNRECORDED = 'plain-unrecorded-marker';

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: logSpies.debug,
    info: logSpies.info,
    warn: logSpies.warn,
    error: logSpies.error,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const ec2Behaviour = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'empty' | 'throw' }));
/**
 * What `DescribeVpcs` reports as the VPC's associated IPv6 CIDR. `undefined`
 * means the command is never expected, and the fake says so rather than
 * answering a shape the caller would misread.
 */
const vpcBehaviour = vi.hoisted(() => ({ ipv6Block: undefined as string | undefined }));
const ssmBehaviour = vi.hoisted(() => ({ value: undefined as string | undefined }));

/**
 * The cross-stack cases fall through to the CloudFormation fallback (on by
 * default), which builds its OWN `CloudFormationClient` — a mock of
 * `src/utils/aws-clients.js` does not reach it, and the suite's AWS fence
 * catches the escape. The fallback answers EMPTY so the resolver reaches the
 * not-found throws these cases are about.
 */
const cfnBehaviour = vi.hoisted(() => ({ mode: 'empty' as 'empty' | 'throw' }));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: vi.fn(
        async (command: {
          constructor: { name: string };
          input?: { StackName?: string };
        }) => {
          if (cfnBehaviour.mode === 'throw') {
            // AWS's own AccessDenied wording, which quotes the RESOURCE it was
            // asked about — so an assembled name is in the message because the
            // resource name is, not because the fake put it there.
            const denied = new Error(
              `User: arn:aws:iam::123456789012:user/cdkd is not authorized to perform: ` +
                `cloudformation:DescribeStacks on resource: ${command.input?.StackName ?? 'exports'}`
            );
            denied.name = 'AccessDeniedException';
            throw denied;
          }
          if (command.constructor.name === 'ListExportsCommand') return { Exports: [] };
          if (command.constructor.name === 'DescribeStacksCommand') return { Stacks: [] };
          throw new Error(`unexpected CloudFormation command: ${command.constructor.name}`);
        }
      ),
      destroy: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: {
      send: vi.fn(async (command: {
        constructor: { name: string };
        input: { Filters?: Array<{ Values?: string[] }> };
      }) => {
        if (command.constructor.name === 'DescribeVpcsCommand') {
          if (vpcBehaviour.ipv6Block === undefined) {
            throw new Error('unexpected DescribeVpcs: set vpcBehaviour.ipv6Block first');
          }
          return {
            Vpcs: [
              {
                Ipv6CidrBlockAssociationSet: [
                  {
                    Ipv6CidrBlock: vpcBehaviour.ipv6Block,
                    Ipv6CidrBlockState: { State: 'associated' },
                  },
                ],
              },
            ],
          };
        }
        // The region the CALL carried, echoed the way EC2 echoes it in a real
        // rejection. Not a manufactured leak: the region IS the input, and an
        // assembled one is the plaintext by construction.
        const region = command.input.Filters?.[0]?.Values?.[0] ?? '?';
        if (ec2Behaviour.mode === 'throw') {
          throw new Error(`The region '${region}' is not subscribed on this account`);
        }
        if (ec2Behaviour.mode === 'empty') return { AvailabilityZones: [] };
        return { AvailabilityZones: [{ ZoneName: `${region}a` }] };
      }),
    },
    ssm: {
      send: vi.fn(async () =>
        ssmBehaviour.value === undefined
          ? { Parameter: {} }
          : { Parameter: { Value: ssmBehaviour.value, Type: 'String' } }
      ),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        const id = command.input?.SecretId;
        if (id === SECRET_ID) {
          return {
            SecretString: JSON.stringify({
              password: PASSWORD,
              longpw: LONG_PASSWORD,
              regionpw: REGION_PASSWORD,
              quotepw: QUOTED_PASSWORD,
              splitpw: SPLIT_PASSWORD,
            }),
          };
        }
        // An id ASSEMBLED from a plaintext resolves to a real secret that
        // carries only a BINARY value, which is what reaches the resolver's
        // `secret '<id>' does not contain a SecretString value` throw. Without
        // this arm the lookup takes `ResourceNotFoundException` and that throw
        // is never reached.
        if (id === PASSWORD) return { SecretBinary: new Uint8Array([1, 2, 3]) };
        // ...and one that is NOT valid JSON, for the third secretsmanager
        // throw. Keyed on the CONTROL value so the JSON-parse case can be
        // driven with a recorded plaintext id too (below).
        if (id === `${PASSWORD}-notjson` || id === `${UNRECORDED}-notjson`) {
          return { SecretString: 'not-json-at-all' };
        }
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { redactSecretsForState } = await import('../../../src/deployment/secret-redaction.js');

type Resolver = InstanceType<typeof IntrinsicFunctionResolver>;

const ref = (jsonKey: string): string =>
  `{{resolve:secretsmanager:${SECRET_ID}:SecretString:${jsonKey}}}`;

/**
 * An `Fn::Sub` that resolves to the PLAINTEXT of `jsonKey` while recording it
 * as a needle — the assembly every case uses to put a decrypted value in the
 * position a throw names. Built FRESH per call: `resolveSub` resolves the
 * variable map IN PLACE, so a shared literal would carry an already-resolved
 * value into the next case.
 */
const assembled = (jsonKey: string): unknown => ({
  'Fn::Sub': ['${Pw}', { Pw: ref(jsonKey) }],
});

/** The CONTROL twin of `assembled`: the same shape, nothing recorded. */
const literal = (value: string): unknown => value;

interface Harness {
  resolver: Resolver;
  secrets: Map<string, string>;
  context: {
    template: CloudFormationTemplate;
    resources: Record<string, never>;
    stackName: string;
    recordedSecretValues: Map<string, string>;
    stateBackend?: S3StateBackend;
  };
}

function makeHarness(
  template: CloudFormationTemplate = { Resources: {} },
  stateBackend?: S3StateBackend
): Harness {
  const secrets = new Map<string, string>();
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  return {
    resolver,
    secrets,
    context: {
      template,
      resources: {},
      stackName: 'Consumer',
      recordedSecretValues: secrets,
      ...(stateBackend && { stateBackend }),
    },
  };
}

/**
 * The message of whatever `resolve` rejected with — the sink under test.
 *
 * THE SENTINEL IS A DISTINCT TYPE, and that is the whole point. This used to
 * build an `Error` on the SUCCESS path and then assert `toBeInstanceOf(Error)`,
 * which that very sentinel satisfied — so the "must actually throw" guard could
 * never fire, and a case whose input RESOLVED instead of throwing ran all its
 * assertions against the harness's own string. One did: the `Fn::Cidr` case,
 * where `resolveCidr` coerces a non-CIDR `ipBlock` to `0.0.0.0` and RETURNS.
 * Found in review round 2.
 */
const RESOLVED_INSTEAD = Symbol('resolved instead of throwing');

async function messageOf(h: Harness, value: unknown): Promise<string> {
  const thrown = await h.resolver.resolve(h.context ? value : value, h.context as never).then(
    (resolved) => ({ [RESOLVED_INSTEAD]: JSON.stringify(resolved) }) as const,
    (reason: unknown) => reason
  );
  if (typeof thrown === 'object' && thrown !== null && RESOLVED_INSTEAD in thrown) {
    throw new Error(
      `the site must actually throw, or the case is vacuous — it RESOLVED to ` +
        `${(thrown as Record<symbol, string>)[RESOLVED_INSTEAD]}`
    );
  }
  expect(thrown, 'the rejection must be an Error to have a message').toBeInstanceOf(Error);
  return (thrown as Error).message;
}

/** Every line the resolver logged, at any level. */
function loggedText(): string {
  return [logSpies.debug, logSpies.info, logSpies.warn, logSpies.error]
    .flatMap((spy) => spy.mock.calls.map((c) => String(c[0])))
    .join('\n');
}

/** cdkd state backend double: no stacks, so every cross-stack read misses. */
function emptyBackend(): S3StateBackend {
  return {
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
  } as unknown as S3StateBackend;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountInfoCache();
  ec2Behaviour.mode = 'ok';
  vpcBehaviour.ipv6Block = undefined;
  ssmBehaviour.value = undefined;
  cfnBehaviour.mode = 'empty';
});

describe('#2827 — dynamic-reference throws mask the RAW value they interpolate', () => {
  it('the JSON-KEY position is masked, and the diagnosis around it survives', async () => {
    const h = makeHarness();
    const message = await messageOf(h, {
      'Fn::Sub': [`{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${Pw}}}`, { Pw: ref('password') }],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("key '***' not found");
    // The CONTROL inside the masked span: the secret ID is not a needle here
    // and must come through, so a mask-everything regression reds.
    expect(message).toContain(`not found in secret '${SECRET_ID}'`);
  });

  it('the SECRET-ID position is a different throw, masked there too', async () => {
    const h = makeHarness();
    const message = await messageOf(h, {
      'Fn::Sub': [`{{resolve:secretsmanager:\${Pw}:SecretString:password}}`, { Pw: ref('password') }],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("secret '***' does not contain a SecretString value");
  });

  it('the not-valid-JSON throw masks BOTH of its interpolations', async () => {
    const h = makeHarness();
    const message = await messageOf(h, {
      'Fn::Sub': [
        `{{resolve:secretsmanager:\${Pw}-notjson:SecretString:\${Pw}}}`,
        { Pw: ref('password') },
      ],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain('is not valid JSON but JSON_KEY');
    expect(message).toContain('***');
  });

  it('CONTROL: an UNRECORDED id and key are reported verbatim', async () => {
    const h = makeHarness();
    const message = await messageOf(
      h,
      `{{resolve:secretsmanager:${UNRECORDED}-notjson:SecretString:${UNRECORDED}}}`
    );

    expect(message).toContain(`secret '${UNRECORDED}-notjson' is not valid JSON`);
    expect(message).toContain(`JSON_KEY '${UNRECORDED}'`);
    expect(message).not.toContain('***');
  });

  it('the SSM parameter-name throw is masked', async () => {
    const h = makeHarness();
    const message = await messageOf(h, {
      'Fn::Sub': ['{{resolve:ssm:${Pw}}}', { Pw: ref('password') }],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("SSM parameter '***' not found or has no value");
  });

  it('CONTROL: an UNRECORDED SSM parameter name is reported verbatim', async () => {
    const h = makeHarness();
    const message = await messageOf(h, `{{resolve:ssm:${UNRECORDED}}}`);

    expect(message).toContain(`SSM parameter '${UNRECORDED}' not found or has no value`);
    expect(message).not.toContain('***');
  });
});

describe('#2827 — cross-stack throws mask the resolved names they interpolate', () => {
  it("Fn::ImportValue's not-found throw masks the export name", async () => {
    const h = makeHarness({ Resources: {} }, emptyBackend());
    const message = await messageOf(h, { 'Fn::ImportValue': assembled('password') });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("export '***' not found in any stack");
    // The rest of the diagnosis, which is not a needle.
    expect(message).toContain('Make sure the exporting stack has been deployed');
  });

  it('CONTROL: an UNRECORDED export name is reported verbatim', async () => {
    const h = makeHarness({ Resources: {} }, emptyBackend());
    const message = await messageOf(h, { 'Fn::ImportValue': literal(UNRECORDED) });

    expect(message).toContain(`export '${UNRECORDED}' not found in any stack`);
    expect(message).not.toContain('***');
  });

  it("Fn::GetStackOutput's stack-not-found throw masks the stack name", async () => {
    const h = makeHarness({ Resources: {} }, emptyBackend());
    const message = await messageOf(h, {
      'Fn::GetStackOutput': { StackName: assembled('password'), OutputName: 'Anything' },
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("stack '***' not found in region");
    expect(message, 'the remedy sentence is not a needle and must survive').toContain(
      'Make sure the producer stack'
    );
  });

  it("Fn::GetStackOutput's output-not-found throw masks stack AND output name", async () => {
    const backend = {
      listStacks: vi.fn(async () => [{ stackName: PASSWORD, region: 'us-east-1' }]),
      getState: vi.fn(async (stackName: string) =>
        stackName === PASSWORD
          ? {
              state: {
                version: 9,
                stackName,
                region: 'us-east-1',
                resources: {},
                outputs: { PublicOne: 'v' },
                lastModified: 1,
              },
              etag: 'e',
            }
          : null
      ),
    } as unknown as S3StateBackend;
    const h = makeHarness({ Resources: {} }, backend);
    const message = await messageOf(h, {
      'Fn::GetStackOutput': {
        StackName: assembled('password'),
        OutputName: assembled('password'),
      },
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("output '***' not found in stack '***'");
    // The available-output list is a CONTROL: those names are not needles.
    expect(message).toContain('PublicOne');
  });

  it("Fn::GetStackOutput's REGION is masked past the gate, in every throw that names it", async () => {
    // ROUND-1 REVIEW FINDING. Every other case here used `us-east-1`, so
    // `loggedRegion` and its five consumers were unwatched: a region-shaped
    // plaintext CLEARS `isClientSafeRegion` (`/^[a-z0-9][a-z0-9-]{0,30}$/`)
    // and then flows into the state key, the client, and three throws.
    const h = makeHarness({ Resources: {} }, emptyBackend());
    const message = await messageOf(h, {
      'Fn::GetStackOutput': {
        StackName: 'Producer',
        OutputName: 'Anything',
        Region: assembled('regionpw'),
      },
    });

    expect(message, 'the region cleared the gate, so this is the not-found throw').toContain(
      'not found in region'
    );
    expect(message).not.toContain(REGION_PASSWORD);
    expect(message).toContain("not found in region '***'");
    // The CONTROL inside the same message: the stack name is not a needle.
    expect(message).toContain("stack 'Producer'");
  });

  it('...and in the Resolving / DescribeStacks lines that name it too', async () => {
    cfnBehaviour.mode = 'throw';
    const h = makeHarness({ Resources: {} }, emptyBackend());
    await messageOf(h, {
      'Fn::GetStackOutput': {
        StackName: 'Producer',
        OutputName: 'Anything',
        Region: assembled('regionpw'),
      },
    });

    const text = loggedText();
    expect(text, 'the resolving line must be present, or this is vacuous').toContain(
      'Resolving Fn::GetStackOutput:'
    );
    expect(text).not.toContain(REGION_PASSWORD);
    expect(text).toContain('Region=***');
  });

  it("Fn::GetStackOutput's own-stack refusal masks the stack name it echoes", async () => {
    // Fires BEFORE the masked names further down are bound, so this site had
    // to mask its own raw values.
    const h = makeHarness({ Resources: {} }, emptyBackend());
    h.context.stackName = PASSWORD;
    const message = await messageOf(h, {
      'Fn::GetStackOutput': { StackName: assembled('password'), OutputName: 'Anything' },
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("cannot reference own stack '***'");
  });
});

describe('#2827 — the warn sites mask the CAUGHT message, not only the identifier', () => {
  /** Only the `warn` channel — these four print at DEFAULT verbosity. */
  function warnedText(): string {
    return logSpies.warn.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('the exports-index lookup failure masks the export NAME — its caught-message half is unreachable', async () => {
    // CORRECTED IN REVIEW ROUND 2. The first version of this case had the fake
    // throw `AccessDenied reading cdkd/exports/<name>/index.json`, a key shape
    // production cannot emit: the real key is
    // `<prefix>/_index/<region>/exports.json` and `ExportIndexStore.lookup`'s
    // only two throws name that key or the index version — never the export
    // name. So the case manufactured the very thing it claimed to catch, and
    // presented an unreachable mask as a closed leak.
    //
    // The fake now throws the message production ACTUALLY produces. What the
    // case pins is the half that IS reachable and IS a closed leak: the export
    // name beside it. Same disposition as the `ListExports` twin below.
    const h = makeHarness({ Resources: {} }, emptyBackend());
    (h.context as { exportIndex?: unknown }).exportIndex = {
      lookup: vi.fn(async () => {
        throw new Error(
          'Exports index at cdkd/_index/us-east-1/exports.json could not be parsed'
        );
      }),
    };
    await messageOf(h, { 'Fn::ImportValue': assembled('password') });

    const warned = warnedText();
    expect(warned, 'the warn must have fired, or this is vacuous').toContain(
      'Exports index lookup failed'
    );
    expect(warned).not.toContain(PASSWORD);
    expect(warned, 'the real AWS wording survives — not a blanket mask').toContain(
      'could not be parsed'
    );
    expect(warned, 'the export name is masked').toContain("failed for '***'");
  });

  it('the state-scan failure masks BOTH the stack name and the error text', async () => {
    // The one warn of the four that masked NEITHER operand.
    const backend = {
      listStacks: vi.fn(async () => [{ stackName: PASSWORD, region: 'us-east-1' }]),
      getState: vi.fn(async (stackName: string) => {
        throw new Error(`AccessDenied reading cdkd/${stackName}/us-east-1/state.json`);
      }),
    } as unknown as S3StateBackend;
    const h = makeHarness({ Resources: {} }, backend);
    // Record the needle first — the export name itself is a plain literal
    // here, since the SCAN is what must be reached.
    await h.resolver.resolve(assembled('password'), h.context as never);
    await messageOf(h, { 'Fn::ImportValue': 'SomeExport' });

    const warned = warnedText();
    expect(warned, 'the warn must have fired').toContain('Failed to read state for stack');
    expect(warned).not.toContain(PASSWORD);
    expect(warned).toContain('AccessDenied reading');
    expect(warned).toContain('***');
  });

  it('the ListExports fallback failure masks the export NAME — its caught-message half is unreachable', async () => {
    // MEASURED, and the measurement is the point of the wording. A mutation
    // probe removing the caught-message mask at this ONE site reds nothing,
    // because `ListExportsCommand` carries only a `NextToken`: no
    // template-derived value is in the request, so AWS has nothing to quote
    // back and the caught text cannot hold a plaintext. Its `DescribeStacks`
    // twin below IS reachable and its probe reds.
    //
    // What this case therefore pins is the EXPORT NAME's mask, which does
    // discriminate (removing it reds this case and the not-found throw). Said
    // out loud rather than left as an assertion that looks like it covers the
    // caught message too.
    cfnBehaviour.mode = 'throw';
    const h = makeHarness({ Resources: {} }, emptyBackend());
    await messageOf(h, { 'Fn::ImportValue': assembled('password') });

    const warned = warnedText();
    expect(warned, 'the warn must have fired').toContain('ListExports fallback failed');
    expect(warned).not.toContain(PASSWORD);
    expect(warned, 'the AWS wording survives — not a blanket mask').toContain(
      'is not authorized to perform'
    );
    expect(warned, 'the export name is masked').toContain("for export '***'");
  });

  it('the DescribeStacks fallback failure masks the caught message and the region', async () => {
    cfnBehaviour.mode = 'throw';
    const h = makeHarness({ Resources: {} }, emptyBackend());
    await messageOf(h, {
      'Fn::GetStackOutput': { StackName: assembled('password'), OutputName: 'Anything' },
    });

    const warned = warnedText();
    expect(warned, 'the warn must have fired').toContain('DescribeStacks fallback failed');
    expect(warned).not.toContain(PASSWORD);
    expect(warned).toContain('is not authorized to perform');
    expect(warned).toContain('***');
  });

  it('CONTROL: with nothing recorded, all four print verbatim', async () => {
    cfnBehaviour.mode = 'throw';
    const h = makeHarness({ Resources: {} }, emptyBackend());
    await messageOf(h, { 'Fn::ImportValue': literal(UNRECORDED) });

    const warned = warnedText();
    expect(warned).toContain('ListExports fallback failed');
    expect(warned).toContain(UNRECORDED);
    expect(warned).not.toContain('***');
  });
});

describe('#2827 — Fn::FindInMap masks all three of its resolved keys', () => {
  const MAPPINGS = { RealMap: { RealTop: { RealSecond: 'v' } } };

  it('the mapping name is masked', async () => {
    const h = makeHarness({ Resources: {}, Mappings: MAPPINGS });
    const message = await messageOf(h, {
      'Fn::FindInMap': [assembled('password'), 'RealTop', 'RealSecond'],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("mapping '***' not found in Mappings section");
  });

  it('the top-level key is masked, and the mapping name beside it survives', async () => {
    const h = makeHarness({ Resources: {}, Mappings: MAPPINGS });
    const message = await messageOf(h, {
      'Fn::FindInMap': ['RealMap', assembled('password'), 'RealSecond'],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("top-level key '***'");
    expect(message).toContain("not found in mapping 'RealMap'");
  });

  it('the second-level key is masked', async () => {
    const h = makeHarness({ Resources: {}, Mappings: MAPPINGS });
    const message = await messageOf(h, {
      'Fn::FindInMap': ['RealMap', 'RealTop', assembled('password')],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("second-level key '***'");
    expect(message).toContain("'RealMap' -> 'RealTop'");
  });

  it('CONTROL: UNRECORDED keys are reported verbatim', async () => {
    const h = makeHarness({ Resources: {}, Mappings: MAPPINGS });
    const message = await messageOf(h, {
      'Fn::FindInMap': ['RealMap', 'RealTop', literal(UNRECORDED)],
    });

    expect(message).toContain(`second-level key '${UNRECORDED}'`);
    expect(message).not.toContain('***');
  });
});

describe('#2827 — the two TRUNCATING region gates mask BEFORE they truncate', () => {
  it('Fn::GetAZs: an 80-character needle does not print its first 64 characters', async () => {
    // THE LONG-NEEDLE ARM. `stripControlChars(...).slice(0, 64)` rewrites the
    // text a literal needle has to match, so a mask applied to the FINISHED
    // message cannot match an 80-character secret at all — it would print 64
    // characters of decrypted plaintext at default verbosity, which is the
    // measurement in #2827's comment 1. A short-needle fixture here passes
    // either way and proves nothing.
    const h = makeHarness();
    const message = await messageOf(h, { 'Fn::GetAZs': assembled('longpw') });

    expect(message).not.toContain(LONG_PASSWORD);
    expect(message, 'and no PREFIX of it either — truncation is the whole hazard').not.toContain(
      LONG_PASSWORD.slice(0, 64)
    );
    expect(message).toContain("Fn::GetAZs: '***' is not a valid AWS region name");
  });

  it('Fn::GetStackOutput: the same, at its own region gate', async () => {
    const h = makeHarness({ Resources: {} }, emptyBackend());
    const message = await messageOf(h, {
      'Fn::GetStackOutput': {
        StackName: 'Producer',
        OutputName: 'Anything',
        Region: assembled('longpw'),
      },
    });

    expect(message).not.toContain(LONG_PASSWORD);
    expect(message).not.toContain(LONG_PASSWORD.slice(0, 64));
    expect(message).toContain("Fn::GetStackOutput: '***' is not a valid AWS region name");
  });

  it('a needle carrying an invisible is masked BEFORE the strip destroys it', async () => {
    // ROUND-1 REVIEW FINDING. `stripControlChars` DELETES rather than
    // replaces, so the ORDER of mask and strip decides whether a plaintext
    // carrying a control character is caught: the resolver records the value
    // it resolved, invisible included, so the needle IS the split form and a
    // mask that runs AFTER the strip has nothing left to match.
    //
    // WHAT THIS CASE PROVES, exactly: deleting the FIRST mask (leaving
    // `mask(strip(v))`) reds it. Deleting the SECOND leaves it green —
    // measured — and that is stated at `maskThenStripThenMask` rather than
    // papered over: the second mask covers a bag/value disagreement this
    // resolver cannot produce, so it is defence in depth with no case behind
    // it, not a fenced guarantee.
    const h = makeHarness();
    const message = await messageOf(h, { 'Fn::GetAZs': assembled('splitpw') });

    expect(message, 'the split form must not print').not.toContain(SPLIT_PASSWORD);
    expect(
      message,
      'and neither must the STRIPPED form — that is the one the old order reconstituted'
    ).not.toContain(SPLIT_PASSWORD_STRIPPED);
    expect(
      message,
      'nor a 64-char prefix of it, since this site truncates'
    ).not.toContain(SPLIT_PASSWORD_STRIPPED.slice(0, 64));
    expect(message).toContain("Fn::GetAZs: '***' is not a valid AWS region name");
  });

  it('CONTROL: an UNRECORDED bad region is still shown, truncated as before', async () => {
    const h = makeHarness();
    const badRegion = `${UNRECORDED}-${'x'.repeat(80)}`;
    const message = await messageOf(h, { 'Fn::GetAZs': literal(badRegion) });

    expect(message).toContain(UNRECORDED);
    expect(message).not.toContain('***');
    expect(message, 'the 64-character truncation is unchanged for a non-needle').toContain(
      badRegion.slice(0, 64)
    );
    expect(message).not.toContain(badRegion);
  });
});

describe('#2827 — the Fn::GetAZs throws BEYOND the region gate', () => {
  it('a describe failure masks the region AND the AWS message that echoes it', async () => {
    // `region` here has CLEARED `isClientSafeRegion`, which is only
    // `/^[a-z0-9][a-z0-9-]{0,30}$/` — a real plaintext passes it. AWS quotes
    // the region back, so masking the interpolated variable alone would leave
    // the plaintext one interpolation over.
    ec2Behaviour.mode = 'throw';
    const h = makeHarness();
    const message = await messageOf(h, { 'Fn::GetAZs': assembled('regionpw') });

    expect(message).not.toContain(REGION_PASSWORD);
    expect(message).toContain('failed to describe availability zones');
    expect(message, 'the AWS wording survives — not a blanket mask').toContain(
      'is not subscribed on this account'
    );
    expect(message).toContain('***');
  });

  it('an empty AZ list masks the region it names', async () => {
    ec2Behaviour.mode = 'empty';
    const h = makeHarness();
    const message = await messageOf(h, { 'Fn::GetAZs': assembled('regionpw') });

    expect(message).not.toContain(REGION_PASSWORD);
    expect(message).toContain("no availability zones returned for region '***'");
    expect(message).toContain('opt-in regions must be enabled before use');
  });

  it('CONTROL: an UNRECORDED region-shaped value survives both throws', async () => {
    ec2Behaviour.mode = 'empty';
    const h = makeHarness();
    const message = await messageOf(h, { 'Fn::GetAZs': literal('ap-southeast-9zz') });

    expect(message).toContain("no availability zones returned for region 'ap-southeast-9zz'");
    expect(message).not.toContain('***');
  });
});

describe('#2827 review — the SUCCESS-path log lines beside every masked throw', () => {
  // ROUND-1 REVIEW FINDING (two independent reviewers). The original sweep
  // stopped at `throw`, so the resolver masked a refusal and then printed the
  // same resolved value at `--verbose` one line away. The population was
  // re-derived from the CODE — every `logger.*` statement interpolating a
  // binding that came back from `resolveValue` — rather than from the four
  // sites the reviewers happened to name.
  function loggedLines(): string[] {
    return loggedText().split('\n');
  }

  // A CONTROL, and titled as one since review round 4: it asserts that the
  // NON-needle keys and the NON-needle mapped value come through verbatim, which
  // is what makes the masking cases below non-vacuous. It contains no masking
  // assertion and passes with `maskSecretsForLog` neutered — an earlier title
  // said "AND the mapped value masked", which is exactly the looks-covered
  // reading this file exists to prevent. The mapped value's own mask is fenced
  // by the `Fn::FindInMap` case in the leaf-mask block further down.
  it('CONTROL: Fn::FindInMap logs its three resolved keys and mapped value verbatim', async () => {
    const h = makeHarness({
      Resources: {},
      Mappings: { RealMap: { RealTop: { RealSecond: 'plain-mapped-value' } } },
    });
    // The mapping is REAL here, so the lookup SUCCEEDS — this drives the
    // success path, which is what the throws' siblings print on.
    const recorded = await h.resolver.resolve(assembled('password'), h.context as never);
    expect(recorded, 'the needle must be recorded first').toBe(PASSWORD);
    await h.resolver.resolve(
      { 'Fn::FindInMap': ['RealMap', 'RealTop', 'RealSecond'] },
      h.context as never
    );

    const lines = loggedLines().filter((l) => l.includes('Resolved Fn::FindInMap:'));
    expect(lines, 'the resolver must have logged it, or this is vacuous').toHaveLength(1);
    expect(lines[0], 'the non-needle keys survive — not a blanket mask').toContain(
      'RealMap.RealTop.RealSecond'
    );
    expect(lines[0]).toContain('plain-mapped-value');
  });

  it('...and masks a key that IS a needle', async () => {
    // `Fn::FindInMap` resolves its arguments, so an assembled key reaches the
    // log line as the plaintext. Driven against a mapping keyed BY that
    // plaintext so the lookup succeeds and the SUCCESS line is what prints.
    const h = makeHarness({
      Resources: {},
      Mappings: { RealMap: { [PASSWORD]: { RealSecond: 'plain-mapped-value' } } },
    });
    await h.resolver.resolve(
      { 'Fn::FindInMap': ['RealMap', assembled('password'), 'RealSecond'] },
      h.context as never
    );

    const lines = loggedLines().filter((l) => l.includes('Resolved Fn::FindInMap:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(PASSWORD);
    expect(lines[0]).toContain('RealMap.***.RealSecond');
  });

  it('Fn::GetAZs logs the resolved region masked, on the success path and on the cache hit', async () => {
    const h = makeHarness();
    await h.resolver.resolve({ 'Fn::GetAZs': assembled('regionpw') }, h.context as never);
    // A SECOND resolve takes the module-global cache arm, which has its own
    // line — the two are separate interpolations and both were bare.
    await h.resolver.resolve({ 'Fn::GetAZs': assembled('regionpw') }, h.context as never);

    const lines = loggedLines().filter((l) => l.includes('Resolved Fn::GetAZs'));
    expect(lines.length, 'both the fresh and the cached line must be present').toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes('from cache'))).toBe(true);
    for (const line of lines) expect(line).not.toContain(REGION_PASSWORD);
    for (const line of lines) expect(line).toContain('***');
  });

  it('Fn::Cidr logs its resolved ipBlock masked, on the path that RESOLVES', async () => {
    // REWRITTEN IN REVIEW ROUND 2. This used to go through `messageOf` on the
    // premise that a non-CIDR `ipBlock` throws. It does not: `resolveCidr`
    // coerces each octet with a `Number()` that yields `NaN` -> 0 and RETURNS
    // `["0.0.0.0/24", ...]`. So the case asserted on the harness's own sentinel
    // string and fenced nothing — invisible until the sentinel was made a
    // distinct type. The log line IS emitted on this path, before the return,
    // so that is what the case now drives.
    const h = makeHarness();
    const resolved = await h.resolver.resolve(
      { 'Fn::Cidr': [assembled('password'), 2, 8] },
      h.context as never
    );
    expect(resolved, 'the premise: this input RESOLVES rather than throwing').toEqual([
      '0.0.0.0/24',
      '0.0.1.0/24',
    ]);

    const lines = loggedLines().filter((l) => l.includes('Resolving Fn::Cidr:'));
    expect(lines, 'the line must be present, or the negative below is free').toHaveLength(1);
    expect(lines[0]).not.toContain(PASSWORD);
    expect(lines[0]).toContain('ipBlock="***"');
  });

  it("Fn::Cidr's ipBlock TYPE refusal masks the value it echoes", async () => {
    // The other Fn::Cidr site, and the one that does throw: a NON-STRING
    // `ipBlock` reaches the refusal, which renders it through
    // `maskValueLeaves`. Reached with an `Fn::Split`, whose result is an array.
    const h = makeHarness();
    const message = await messageOf(h, {
      'Fn::Cidr': [{ 'Fn::Split': [',', assembled('quotepw')] }, 2, 8],
    });

    expect(message).toContain('ipBlock must be a string');
    expect(message).not.toContain(QUOTED_PASSWORD);
    expect(
      message,
      'nor its JSON-ENCODED form — the leaf is masked BEFORE the encoding'
    ).not.toContain(JSON.stringify(QUOTED_PASSWORD).slice(1, -1));
    expect(message).toContain('***');
  });

  it('Fn::GetAtt logs a resolved ATTRIBUTE NAME masked', async () => {
    // `Fn::GetAtt`'s attribute name goes through `resolveValue`, so an
    // assembled one is a needle in every line naming it — including the
    // success line, which prints at `--verbose` on an ordinary deploy.
    //
    // WHICH OF THE FOUR `Fn::GetAtt` log lines this fences: the
    // ATTRIBUTES-BAG one (`Resolved Fn::GetAtt from attributes`), which is the
    // branch this fixture takes — probed, red. The other three (the legacy
    // NameServers normalisation, the nested-attributes walk, and the
    // CONSTRUCTED-attribute line) take the identical one-line edit and are
    // covered by inspection only; a probe on the constructed line came back
    // green precisely because this case does not reach it, which is a fact
    // about the fixture and is recorded rather than left as a false claim.
    const h = makeHarness({
      Resources: { Target: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });
    h.context.resources = {
      Target: {
        physicalId: 'q-phys',
        resourceType: 'AWS::SQS::Queue',
        attributes: { [PASSWORD]: 'plain-attribute-value' },
      },
    } as never;
    await h.resolver.resolve({ 'Fn::GetAtt': ['Target', assembled('password')] }, h.context as never);

    const lines = loggedLines().filter((l) => l.includes('Fn::GetAtt'));
    expect(lines.length, 'the resolver must have logged it').toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(line).not.toContain(PASSWORD);
    expect(lines.some((l) => l.includes('***'))).toBe(true);
  });

  it('the secretsmanager echo masks the VERSION fields too, not only id and key', async () => {
    // REGRESSION GUARD. Before issue #2827 this line was masked as a whole
    // MESSAGE, which covered `versionStage` / `versionId` incidentally; the
    // per-value rewrite covered `secretId` / `jsonKey` and left those two
    // bare. They come from the same assembled reference text, so an `Fn::Sub`
    // can put a plaintext in either.
    //
    // ALSO REWRITTEN IN ROUND 2, and by the same fence: this went through
    // `messageOf` too, and the reference RESOLVES (the fake ignores
    // `VersionStage`, as a real lookup would for a valid stage). The echo is
    // emitted before the lookup either way, so the case drives the resolve and
    // reads the log, which is where the regression would show.
    const h = makeHarness();
    const resolved = await h.resolver.resolve(
      {
        'Fn::Sub': [
          `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password:\${Pw}}}`,
          { Pw: ref('password') },
        ],
      },
      h.context as never
    );
    expect(resolved, 'the premise: this shape RESOLVES').toBe(PASSWORD);

    const echoes = loggedLines().filter((l) =>
      l.includes('Resolving dynamic reference: secretsmanager:')
    );
    expect(echoes.length, 'the echo must be in the log, or this is vacuous').toBeGreaterThanOrEqual(2);
    for (const line of echoes) expect(line).not.toContain(PASSWORD);
  });

  it("CONTROL: with nothing recorded, every one of those lines prints in full", async () => {
    const h = makeHarness({
      Resources: {},
      Mappings: { RealMap: { RealTop: { RealSecond: UNRECORDED } } },
    });
    await h.resolver.resolve(
      { 'Fn::FindInMap': ['RealMap', 'RealTop', 'RealSecond'] },
      h.context as never
    );
    await h.resolver.resolve({ 'Fn::GetAZs': literal('ap-southeast-9zz') }, h.context as never);

    const text = loggedText();
    expect(text).toContain('RealMap.RealTop.RealSecond');
    expect(text).toContain(UNRECORDED);
    expect(text).toContain('ap-southeast-9zz');
    expect(text, 'nothing was recorded, so nothing may be masked').not.toContain('***');
  });
});

describe("#2827 review — the throws the first sweeps missed, and BL1's ~40-site default arm", () => {
  it('guardedPhysicalIdFallback masks the attribute name in its DEFAULT-VERBOSITY warn', async () => {
    // THE MOST REACHABLE INTERPOLATION IN THE FILE, and missed by two sweeps:
    // this helper is the `default:` arm of 38 `Fn::GetAtt` call sites, and this
    // warn — unlike its two sibling throws, which need a shape mismatch or
    // `--strict-getatt` — fires on every unenriched attribute.
    const h = makeHarness({
      Resources: { Target: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });
    h.context.resources = {
      Target: { physicalId: 'q-phys', resourceType: 'AWS::SQS::Queue' },
    } as never;
    const resolved = await h.resolver.resolve(
      { 'Fn::GetAtt': ['Target', assembled('password')] },
      h.context as never
    );
    expect(resolved, 'the premise: this falls back to the physical id').toBe('q-phys');

    const warned = logSpies.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned, 'the warn must have fired, or this is vacuous').toContain('Unknown attribute');
    expect(warned).not.toContain(PASSWORD);
    expect(warned).toContain('Unknown attribute ***');
  });

  it('...and in the --strict-getatt refusal, along with the physical id', async () => {
    const h = makeHarness({
      Resources: { Target: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });
    h.context.resources = {
      Target: { physicalId: PASSWORD, resourceType: 'AWS::SQS::Queue' },
    } as never;
    const strict = new IntrinsicFunctionResolver('us-east-1', { strictGetAtt: true });
    // Record the needle on the SAME bag the strict resolver will mask against.
    await strict.resolve(assembled('password'), h.context as never);
    const thrown = await strict
      .resolve({ 'Fn::GetAtt': ['Target', 'SomeUnenrichedAttr'] }, h.context as never)
      .then(
        () => undefined,
        (r: unknown) => r
      );

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('--strict-getatt');
    expect(message, 'the PHYSICAL ID is masked too — it is a needle here').not.toContain(PASSWORD);
    expect(message).toContain('***');
  });
});

describe('#2827 review — guardedPhysicalIdFallback arm 1, the shape refusal', () => {
  it('masks both operands in the *Arn/*Url shape refusal', async () => {
    // The third of the helper's three arms, and the one with no test until
    // review round 3. It needs an attribute whose name ends `Arn` over a
    // physical id that is not ARN-shaped.
    const h = makeHarness({
      Resources: { Target: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });
    h.context.resources = {
      Target: { physicalId: PASSWORD, resourceType: 'AWS::SQS::Queue' },
    } as never;
    await h.resolver.resolve(assembled('password'), h.context as never);

    const message = await messageOf(h, { 'Fn::GetAtt': ['Target', 'SomeArn'] });
    expect(message, 'the premise: this is the shape-refusal arm').toContain('is not an ARN');
    expect(message, 'the physical id is a needle here and must not print').not.toContain(PASSWORD);
    expect(message).toContain('***');
  });
});

/**
 * `maskValueLeaves` is PRIVATE, and rounds 1-3 all reached it through a caller.
 * Every such route runs `resolveValue` first, and `resolveValue` REBUILDS the
 * structure — so the two properties that only a shared object reference can
 * exhibit (the memo's DAG arm and its CYCLE arm) were unreachable from every
 * test in this file. Measured in round 3: reverting the memo to the round-1
 * visited-`Set` left this file 52/52 green, and replacing the memo HIT with a
 * `throw` left all 21,171 unit tests green.
 *
 * A TypeScript `private` is a compile-time annotation, so the walk is callable
 * from here. Nothing else in this file needs it — the caller-driven cases below
 * are the right instrument for what a caller can produce; this is the only
 * instrument for what it cannot.
 */
type MaskLeaves = (value: unknown, context?: unknown) => unknown;
function maskValueLeavesDirectly(h: Harness, value: unknown): unknown {
  const walk = (h.resolver as unknown as { maskValueLeaves: MaskLeaves }).maskValueLeaves;
  expect(typeof walk, 'the premise: the private walk is reachable under this name').toBe(
    'function'
  );
  return walk.call(h.resolver, value, h.context);
}

describe('#2827 review — maskValueLeaves, directly', () => {
  // NO DIRECT TEST until review round 2. Everything below was reachable only
  // through a caller, so the round-1 visited-SET regression (a repeated
  // non-cyclic sub-object rendering as `null`) had nothing watching it.
  // `maskValueLeaves` is private, so these drive it through the one call site
  // whose rendering is a pure function of it: `Fn::Split`'s debug line.
  function splitRender(h: Harness): string {
    const line = loggedText()
      .split('\n')
      .filter((l) => l.includes('Resolved Fn::Split:'));
    expect(line, 'the line must be present').toHaveLength(1);
    return line[0] ?? '';
  }

  // Every case below drives an OBJECT through `maskValueLeaves`, via the
  // `Fn::Cidr` ipBlock TYPE refusal — the one site that renders a non-string
  // resolved value. The two cases these replace routed through `Fn::Split`,
  // whose result is a `string[]`: `walk` returns at the string arm, so the
  // object branch, the key mask, the memo and the cycle guard were ALL
  // unexecuted, and deleting the key mask reddened nothing. Found in review
  // round 3.
  async function cidrRefusal(h: Harness, ipBlock: unknown): Promise<string> {
    return await messageOf(h, { 'Fn::Cidr': [ipBlock, 2, 8] });
  }

  it('masks a needle in KEY position', async () => {
    const h = makeHarness();
    const recorded = await h.resolver.resolve(assembled('password'), h.context as never);
    expect(recorded, 'the premise: the needle is recorded on this bag').toBe(PASSWORD);

    const message = await cidrRefusal(h, { [PASSWORD]: 'inner' });
    expect(message).toContain('ipBlock must be a string');
    expect(message, 'the KEY is masked, not only values').not.toContain(PASSWORD);
    expect(message).toContain('"***"');
    expect(message, 'the non-secret value survives').toContain('inner');
  });

  it('renders a repeated NON-cyclic sub-object twice, not as null', async () => {
    // THE ROUND-1 REGRESSION, pinned at last. A visited-`Set` cannot tell a DAG
    // from a cycle, so the second occurrence became `null`. Two references to
    // ONE object are required, and THREE rounds failed to supply them the same
    // way: the round-1 case used two equal STRINGS (which never touch the memo),
    // and rounds 2-3 routed one object through an intrinsic, where `resolveValue`
    // rebuilds it into two. The call has to be direct.
    const h = makeHarness();
    const recorded = await h.resolver.resolve(assembled('password'), h.context as never);
    expect(recorded, 'the premise: the needle is recorded on this bag').toBe(PASSWORD);

    const shared = { k: PASSWORD };
    const masked = maskValueLeavesDirectly(h, { a: shared, b: shared }) as Record<string, unknown>;

    // Under the visited-`Set` this reads `{"a":{"k":"***"},"b":null}` — the
    // whole point of the round-1 fix, and the leaf mask in the same breath.
    expect(JSON.stringify(masked)).toBe('{"a":{"k":"***"},"b":{"k":"***"}}');
    // ...and the rendering alone cannot tell a memo HIT from a second WALK, which
    // is why the round-3 `throw`-at-the-hit probe stayed green everywhere. One
    // shared input must yield one shared replacement.
    expect(masked['b'], 'one shared input, one shared replacement').toBe(masked['a']);
  });

  it('terminates on a CYCLE, closing it on the replacement', async () => {
    // The memo's OTHER arm, disclosed as untested in round 3 and reachable here
    // for the same reason the DAG case now is. Without the memo this recurses
    // until the stack dies, so the case fails LOUDLY rather than subtly.
    const h = makeHarness();
    const recorded = await h.resolver.resolve(assembled('password'), h.context as never);
    expect(recorded, 'the premise: the needle is recorded on this bag').toBe(PASSWORD);

    const cyclic: Record<string, unknown> = { k: PASSWORD };
    cyclic['self'] = cyclic;
    const masked = maskValueLeavesDirectly(h, cyclic) as Record<string, unknown>;

    expect(masked['k'], 'the leaves are still masked on the way down').toBe('***');
    expect(masked['self'], 'the cycle closes on the REPLACEMENT, not on the input').toBe(masked);
  });

  it('memoizes inside an ARRAY too — a repeat and a self-reference', async () => {
    // The array arm registers its replacement BEFORE walking its items, and that
    // ordering is what makes a self-referential array terminate. Nothing reached
    // it either: an array arriving through `resolveValue` is rebuilt element by
    // element.
    const h = makeHarness();
    const shared = { k: 'v' };
    const cyclic: unknown[] = [shared, shared];
    cyclic.push(cyclic);

    const masked = maskValueLeavesDirectly(h, cyclic) as unknown[];

    expect(masked, 'a fresh array, not the input').not.toBe(cyclic);
    expect(masked[1], 'the repeat takes the memo').toBe(masked[0]);
    expect(masked[2], 'the self-reference closes on the replacement').toBe(masked);
  });

  it('keeps an own `__proto__` key instead of writing through the prototype', async () => {
    // The `Object.assign(out, { [key]: v })` bug (review round 3). `Object.assign`
    // invokes `Object.prototype.__proto__`'s SETTER, so this field left no own
    // key and `JSON.stringify` rendered `{}` — the value silently absent from the
    // diagnostic. `Object.create(null)` has no such setter to reach.
    const h = makeHarness();
    const withProto = JSON.parse('{"__proto__": {"k":"v"}, "sibling": "s"}') as Record<
      string,
      unknown
    >;
    expect(
      Object.hasOwn(withProto, '__proto__'),
      'the premise: JSON.parse makes it an OWN key'
    ).toBe(true);

    const message = await cidrRefusal(h, withProto);
    expect(message, 'the field survives the walk').toContain('__proto__');
    expect(message).toContain('"k":"v"');
    expect(message, 'and its sibling is unaffected').toContain('"sibling":"s"');
  });

  it('leaves a value with nothing recorded byte-identical', async () => {
    const h = makeHarness();
    await h.resolver.resolve({ 'Fn::Split': [',', 'a,b,c'] }, h.context as never);
    expect(splitRender(h)).toBe('Resolved Fn::Split: split by "," -> ["a","b","c"]');
  });
});

/**
 * ONE CASE PER `maskValueLeaves` CALL SITE THAT NOTHING ELSE WATCHED.
 *
 * Review round 4 mutated four of the thirteen call sites — stripping the walk
 * and leaving the raw value — and found that none of them reddened anything.
 * RE-RUNNING THAT MUTATION OVER THE WHOLE POPULATION found three more: the
 * placeholder-ARN refusal, `Fn::Cidr`'s ipBlock debug line, and — the tell that
 * the four were an enumeration and not a sweep — the SECOND operand of
 * `Fn::Equals`, whose first operand was already fenced one expression away.
 * Measured against `tests/unit/deployment` + `tests/unit/cli`, 6,144 cases,
 * all green under each strip.
 *
 * Twelve of the thirteen now red under it. The thirteenth is `Fn::Cidr`'s RESULT
 * line and it is a CONTROL below rather than a fence, for a reason recorded at
 * the site: no input can separate its leaf mask from the outer one.
 *
 * THE DISCRIMINATOR IS THE SECRET'S BYTES, not its length. Where the site keeps
 * an OUTER `maskSecretsForLog` over the finished JSON, an ordinary alphanumeric
 * plaintext is masked by that outer call whether or not the leaf walk ran — so
 * such a case passes under the mutation and proves nothing. `QUOTED_PASSWORD`
 * carries a `"` and a `\`, which `JSON.stringify` ESCAPES, so after encoding the
 * plaintext no longer OCCURS and only the leaf walk can have masked it. That is
 * issue #2759's shape, one layer in.
 */
describe('#2827 review round 4 — the leaf-mask call sites nothing fenced', () => {
  /**
   * THE PREMISE EVERY OUTER-MASKED CASE BELOW RESTS ON, asserted per case rather
   * than once. Review measured the cost of sharing it: with the premise living
   * in ONE case, swapping `QUOTED_PASSWORD` for a plain alphanumeric left the
   * VPC case GREEN under its own strip mutation — vacuous — while only the case
   * holding the premise reddened. A premise that guards a sibling has to be
   * asserted in the sibling.
   */
  function requireEncodingHidesIt(secret: string): void {
    expect(
      JSON.stringify(secret),
      'the premise: `JSON.stringify` rewrites this plaintext, so no literal needle matches the encoded form and only a LEAF mask can have masked it'
    ).not.toContain(secret);
  }

  /** The escaped body of `secret`, which must not survive either. */
  const escapedForm = (secret: string): string => JSON.stringify(secret).slice(1, -1);

  function lineContaining(needle: string): string {
    const lines = loggedText()
      .split('\n')
      .filter((l) => l.includes(needle));
    expect(lines, `exactly one \`${needle}\` line, or the case is vacuous`).toHaveLength(1);
    return lines[0] ?? '';
  }

  it('Fn::Select masks the ELEMENT it picked — the only mask on that line', async () => {
    // THE HIGH ONE. This debug line has NO outer `maskSecretsForLog`, so with
    // the leaf walk stripped it prints the plaintext verbatim and nothing in the
    // suite reddened. An ordinary needle is enough here for exactly that reason.
    const h = makeHarness();
    const picked = await h.resolver.resolve(
      { 'Fn::Select': [1, ['public-a', assembled('password')]] },
      h.context as never
    );
    expect(picked, 'the premise: the picked element IS the plaintext').toBe(PASSWORD);

    const line = lineContaining('Resolved Fn::Select:');
    expect(line).toContain('index 1');
    expect(line, 'nothing else masks this line').not.toContain(PASSWORD);
    expect(line).toContain('***');
  });

  it('CONTROL: Fn::Select prints an UNRECORDED element verbatim, with a LIVE needle bag', async () => {
    // The bag is deliberately NON-empty. With nothing recorded, `not.toContain
    // ('***')` is satisfied by a masker that has no needles to match rather than
    // by one that correctly declined — the control would then pass against a
    // blanket mask that simply had nothing to work with.
    const h = makeHarness();
    const recorded = await h.resolver.resolve(assembled('password'), h.context as never);
    expect(recorded, 'the premise: a needle IS recorded, so declining is a decision').toBe(
      PASSWORD
    );

    await h.resolver.resolve({ 'Fn::Select': [0, [UNRECORDED, 'other']] }, h.context as never);

    const line = lineContaining('Resolved Fn::Select:');
    expect(line).toContain(UNRECORDED);
    expect(line, 'the mask is a needle set, not a blanket').not.toContain('***');
  });

  it('Fn::FindInMap masks the MAPPED VALUE, before the encoding', async () => {
    // The three KEYS are masked by the outer calls beside them and are fenced
    // above. The mapped VALUE is leaf-masked, and that call was unwatched: with
    // an alphanumeric needle the surviving outer mask covers for it, so the case
    // has to be driven with a plaintext `JSON.stringify` rewrites.
    const h = makeHarness({
      Resources: {},
      Mappings: { RealMap: { RealTop: { RealSecond: QUOTED_PASSWORD } } },
    });
    const recorded = await h.resolver.resolve(assembled('quotepw'), h.context as never);
    expect(recorded, 'the premise: the quoted needle is recorded').toBe(QUOTED_PASSWORD);
    requireEncodingHidesIt(QUOTED_PASSWORD);

    await h.resolver.resolve(
      { 'Fn::FindInMap': ['RealMap', 'RealTop', 'RealSecond'] },
      h.context as never
    );

    const line = lineContaining('Resolved Fn::FindInMap:');
    expect(line, 'the keys are a CONTROL — not a blanket mask').toContain(
      'RealMap.RealTop.RealSecond'
    );
    expect(line, 'the escaped form must not survive either').not.toContain(
      escapedForm(QUOTED_PASSWORD)
    );
    expect(line).toContain('"***"');
  });

  it("the VPC Ipv6CidrBlocks line masks each block before the encoding", async () => {
    // DEFENCE IN DEPTH, like the `Fn::FindInMap` case above and on the same
    // terms — an `Ipv6CidrBlockAssociationSet` entry is AWS-assigned, and
    // `Fn::FindInMap`'s mapped value is read verbatim out of the template, so
    // neither is reachable by a resolved secret today. Both are labelled so
    // rather than one of them, because the asymmetry read as a claim that the
    // other one WAS reachable. What each case pins is the ENCODING ORDER at its
    // site — mask the leaves, then `JSON.stringify` — which the surviving outer
    // mask cannot supply and which reverted silently under review round 4's
    // mutation.
    const h = makeHarness({
      Resources: { Vpc: { Type: 'AWS::EC2::VPC', Properties: {} } },
    });
    h.context.resources = {
      Vpc: { physicalId: 'vpc-0123456789abcdef0', resourceType: 'AWS::EC2::VPC' },
    } as never;
    const recorded = await h.resolver.resolve(assembled('quotepw'), h.context as never);
    expect(recorded, 'the premise: the quoted needle is recorded').toBe(QUOTED_PASSWORD);
    requireEncodingHidesIt(QUOTED_PASSWORD);
    vpcBehaviour.ipv6Block = QUOTED_PASSWORD;

    const blocks = await h.resolver.resolve(
      { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] },
      h.context as never
    );
    expect(blocks, 'the premise: the walk really ran over this value').toEqual([QUOTED_PASSWORD]);

    const line = lineContaining('Resolved VPC Ipv6CidrBlocks');
    expect(line, 'the VPC id is a CONTROL, not a needle').toContain('vpc-0123456789abcdef0');
    expect(line, 'the escaped form is what the outer mask cannot see').not.toContain(
      escapedForm(QUOTED_PASSWORD)
    );
    expect(line).toContain('"***"');
  });

  it('Fn::Equals masks its SECOND operand, not only its first', async () => {
    // FOUND BY RE-RUNNING THE MUTATION OVER THE WHOLE POPULATION rather than
    // over the four sites review named. `resolved1` is fenced elsewhere and
    // `resolved2` — the other half of the SAME statement — was not: stripping
    // its walk left all 6,144 cases in `tests/unit/deployment` +
    // `tests/unit/cli` green. This line has NO outer mask either, so that was a
    // plain leak.
    const h = makeHarness();
    const equal = await h.resolver.resolve(
      { 'Fn::Equals': ['public-left', assembled('password')] },
      h.context as never
    );
    expect(equal, 'the premise: the two operands really differ').toBe(false);

    const line = lineContaining('Resolved Fn::Equals:');
    expect(line, 'the LEFT operand is a CONTROL').toContain('public-left');
    expect(line, 'nothing else masks this line').not.toContain(PASSWORD);
    expect(line).toContain('"***"');
  });

  it('the Fn::Cidr ipBlock DEBUG line masks before the encoding', async () => {
    // The sibling one line below `Fn::Cidr`'s ipBlock REFUSAL, which is fenced.
    // The refusal fires on a non-string; this line prints the STRING case, which
    // is the reachable one, and its walk was unwatched.
    const h = makeHarness();
    const recorded = await h.resolver.resolve(assembled('quotepw'), h.context as never);
    expect(recorded, 'the premise: the quoted needle is recorded').toBe(QUOTED_PASSWORD);
    requireEncodingHidesIt(QUOTED_PASSWORD);

    await h.resolver.resolve(
      { 'Fn::Cidr': [assembled('quotepw'), 1, 8] },
      h.context as never
    );

    const line = lineContaining('Resolving Fn::Cidr: ipBlock=');
    expect(line, 'the structural operands are a CONTROL').toContain('count=1, cidrBits=8');
    expect(line, 'the escaped form is what the outer mask cannot see').not.toContain(
      escapedForm(QUOTED_PASSWORD)
    );
    expect(line).toContain('"***"');
  });

  it('the placeholder-ARN refusal masks the recorded value it quotes', async () => {
    // `rejectPlaceholderArnAttribute` reads the value off the STATE record and
    // quotes it with no outer mask, so stripping its walk prints it verbatim —
    // green across the whole deployment + cli suite before this case. A
    // placeholder ARN is an unlikely needle, and the fence is cheap; what it
    // pins is that the one mask on this line stays.
    const placeholder = 'arn:aws:appsync:*:*:apis/abc/datasources/Ds';
    const h = makeHarness({
      Resources: { Ds: { Type: 'AWS::AppSync::DataSource', Properties: {} } },
    });
    h.context.resources = {
      Ds: {
        physicalId: 'ds-1',
        resourceType: 'AWS::AppSync::DataSource',
        attributes: { DataSourceArn: placeholder },
      },
    } as never;
    h.secrets.set(placeholder, `{{resolve:secretsmanager:${SECRET_ID}:SecretString:arn}}`);

    const message = await messageOf(h, { 'Fn::GetAtt': ['Ds', 'DataSourceArn'] });
    expect(message, 'the premise: this is the placeholder refusal').toContain('is a placeholder');
    expect(message, 'the diagnosis around it survives').toContain('AWS::AppSync::DataSource');
    expect(message).not.toContain(placeholder);
    expect(message).toContain('***');
  });

  it('CONTROL: the Fn::Cidr result line masks a recorded subnet — by one of two mutually redundant masks', async () => {
    // NOT A FENCE FOR EITHER MASK ON THAT LINE, and labelled so rather than
    // shipped as one. Review round 4 measured BOTH directions: stripping the
    // leaf walk reds nothing, stripping the outer `maskSecretsForLog` reds
    // nothing, only removing both reds. `resolveCidr` COMPUTES its results —
    // dotted-decimal or colon-hex strings, minimum length 9, never a byte
    // `JSON.stringify` rewrites — so every needle either mask could match also
    // occurs verbatim in the other's string space, and no input separates them.
    // Both stay as defence in depth against a change to what `results` holds;
    // this case pins the OBSERVABLE, which is that a recorded subnet does not
    // print.
    const h = makeHarness();
    const secret = '10.0.1.0/24';
    h.secrets.set(secret, `{{resolve:secretsmanager:${SECRET_ID}:SecretString:cidr}}`);

    await h.resolver.resolve({ 'Fn::Cidr': ['10.0.0.0/16', 4, 8] }, h.context as never);

    const line = lineContaining('Fn::Cidr result:');
    expect(line, 'the premise: the computed range really contains it').not.toContain(secret);
    expect(line, 'the siblings are a CONTROL').toContain('10.0.0.0/24');
    expect(line).toContain('***');
  });
});

describe('#2827 review — the throws the first sweeps missed', () => {
  it("the nested-stack Outputs refusal masks the resolved attribute name", async () => {
    const h = makeHarness({
      Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
    });
    h.context.resources = {
      Child: {
        physicalId: 'child-phys',
        resourceType: 'AWS::CloudFormation::Stack',
        attributes: { 'Outputs.Real': 'v' },
      },
    } as never;
    const message = await messageOf(h, {
      'Fn::GetAtt': [
        'Child',
        { 'Fn::Sub': ['Outputs.${Pw}', { Pw: ref('password') }] },
      ],
    });

    expect(message).not.toContain(PASSWORD);
    expect(message).toContain('declares no output named');
    expect(message, 'the available-output list is a CONTROL').toContain('Real');
    expect(message).toContain('***');
  });
});

describe('#2759 — a value TRANSFORMED during resolution gets a derived needle', () => {
  it('Fn::Base64 registers its OUTPUT, so state.json holds no decodable secret', async () => {
    const h = makeHarness();
    const encoded = await h.resolver.resolve({ 'Fn::Base64': assembled('password') }, h.context as never);

    // THE PREMISE, measured rather than assumed: the encoding really does
    // carry the secret, and the raw needle really does not match it.
    expect(typeof encoded).toBe('string');
    expect(Buffer.from(encoded as string, 'base64').toString()).toBe(PASSWORD);
    expect(encoded as string).not.toContain(PASSWORD);

    // The bug: `redactSecretsForState` scans with the same literal needles, so
    // before the derived needle the encoded secret was persisted verbatim.
    const persisted = redactSecretsForState({ UserData: encoded }, h.secrets) as {
      UserData: string;
    };
    expect(persisted.UserData).not.toBe(encoded);
    expect(Buffer.from(persisted.UserData, 'base64').toString()).not.toBe(PASSWORD);
    expect(persisted.UserData).toBe('***');
  });

  it('...and the debug line no longer masks the input and prints the output', async () => {
    const h = makeHarness();
    const encoded = (await h.resolver.resolve(
      { 'Fn::Base64': assembled('password') },
      h.context as never
    )) as string;

    const text = loggedText();
    const base64Lines = text.split('\n').filter((l) => l.includes('Resolved Fn::Base64:'));
    expect(base64Lines, 'the resolver must have logged the line, or this is vacuous').toHaveLength(1);
    expect(base64Lines[0]).not.toContain(encoded);
    expect(base64Lines[0]).not.toContain(PASSWORD);
    expect(base64Lines[0]).toBe('Resolved Fn::Base64: *** -> ***');
  });

  it('an ASSEMBLED input counts too: base64 of a string that CONTAINS a secret', async () => {
    // The ordinary CloudFormation spelling — an `Fn::Sub` building a UserData
    // script around a reference. The whole encoding decodes back to a document
    // holding the plaintext, so the whole encoding is the needle.
    const h = makeHarness();
    const encoded = (await h.resolver.resolve(
      { 'Fn::Base64': { 'Fn::Sub': ['#!/bin/bash\nPW=${Pw}\n', { Pw: ref('password') }] } },
      h.context as never
    )) as string;

    expect(Buffer.from(encoded, 'base64').toString()).toContain(PASSWORD);
    const persisted = redactSecretsForState({ UserData: encoded }, h.secrets) as {
      UserData: string;
    };
    expect(Buffer.from(persisted.UserData, 'base64').toString()).not.toContain(PASSWORD);
  });

  it('CONTROL: base64 of a value nothing recorded is persisted as itself', async () => {
    // The other end of the property. Registering the OUTPUT unconditionally
    // would mask every `Fn::Base64` result in the stack — a `UserData` script
    // with no secret in it would come back `***` and never be recoverable.
    const h = makeHarness();
    const encoded = (await h.resolver.resolve(
      { 'Fn::Base64': literal('#!/bin/bash\necho hello\n') },
      h.context as never
    )) as string;

    const persisted = redactSecretsForState({ UserData: encoded }, h.secrets) as {
      UserData: string;
    };
    expect(persisted.UserData).toBe(encoded);
    expect(persisted.UserData).not.toBe('***');
  });

  it('a JSON-ESCAPED echo is masked, because the LEAVES are masked before encoding', async () => {
    // The other half of #2759's transform class. `Fn::Split` yields an ARRAY,
    // which `Fn::GetAtt`'s attribute-name refusal renders with
    // `stringifyValue` — and the plaintext carries `"` and `\`, so after
    // encoding it does not OCCUR in the text and no needle can match it.
    const h = makeHarness({
      Resources: { Target: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });
    const message = await messageOf(h, {
      'Fn::GetAtt': ['Target', { 'Fn::Split': [',', assembled('quotepw')] }],
    });

    expect(message).not.toContain(QUOTED_PASSWORD);
    expect(message, 'nor its JSON-ENCODED form, which is the shape that used to print').not.toContain(
      JSON.stringify(QUOTED_PASSWORD).slice(1, -1)
    );
    expect(message).toContain('must resolve to a string');
    expect(message).toContain('***');
  });

  it('CONTROL: an UNRECORDED array in the same position is rendered verbatim', async () => {
    const h = makeHarness({
      Resources: { Target: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });
    const message = await messageOf(h, {
      'Fn::GetAtt': ['Target', { 'Fn::Split': [',', literal(`${UNRECORDED},second`)] }],
    });

    expect(message).toContain(UNRECORDED);
    expect(message).toContain('second');
    expect(message).not.toContain('***');
  });

  it('the Fn::Split debug line keeps its JSON rendering while masking the leaf', async () => {
    // The RENDERING is part of the contract: masking the leaves must not turn
    // a JSON array into a bare string, which is how the first cut of this fix
    // broke a `cdkd scrub` assertion.
    const h = makeHarness();
    await h.resolver.resolve({ 'Fn::Split': [',', assembled('quotepw')] }, h.context as never);

    const splitLines = loggedText()
      .split('\n')
      .filter((l) => l.includes('Resolved Fn::Split:'));
    expect(splitLines).toHaveLength(1);
    expect(splitLines[0]).not.toContain(QUOTED_PASSWORD);
    expect(splitLines[0]).toContain('["***"]');
  });
});
