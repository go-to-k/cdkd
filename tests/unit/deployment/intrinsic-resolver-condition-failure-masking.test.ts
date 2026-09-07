/**
 * `IntrinsicFunctionResolver.evaluateConditions` masks the resolver error it
 * renders when a condition fails to evaluate (issue
 * [#2748](https://github.com/go-to-k/cdkd/issues/2748)).
 *
 * The catch downgrades a failed condition to `false` rather than aborting the
 * deploy, and prints the error at **warn** — so it is reached on an ordinary
 * `cdkd deploy` with no `--verbose`, unlike the `logger.debug` lookup echoes
 * issue [#2728](https://github.com/go-to-k/cdkd/issues/2728) covers -- which is
 * still OPEN, its fix in flight. This sink was missed there because it lives in
 * a different method and renders ANY error, not only a lookup echo.
 *
 * WHY THE ERROR CAN CARRY A PLAINTEXT: condition evaluation reaches
 * `resolveDynamicReferences`, and `resolveSub` / `resolveJoin` re-enter it with
 * the ASSEMBLED string. So a `Conditions` entry whose `Fn::Sub` variable
 * resolves a secret, and whose body then uses that value as the JSON KEY of a
 * second reference, makes the lookup fail NAMING the password —
 * `key '<password>' not found in secret '<id>'`, thrown unmasked by
 * construction because every other consumer of that throw masks at ITS own
 * boundary.
 *
 * THE ASSERTIONS ARE FULL LINES, not `toContain('***')`. A shape check passes
 * on an unmasked line that happens to carry a mask elsewhere; the pair
 * "exact masked line" + "no log level carries the password" is what makes each
 * case fail when the mask is removed. The unrecorded control is the other
 * half — the mask is a NEEDLE SET, not a blanket, and a case asserting only
 * that `***` appears would pass for a blanket `'***'` replacement too.
 *
 * Every literal below is invented for this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// Module-level spies rather than a factory returning a fresh object: `getLogger()`
// is called per resolver instance, and a per-call object makes the warn
// unobservable (the same reasoning as `dynamic-references.test.ts`).
const { mockLoggerWarn, mockLoggerDebug, mockLoggerInfo, mockLoggerError, mockSecretsManagerSend } =
  vi.hoisted(() => ({
    mockLoggerWarn: vi.fn(),
    mockLoggerDebug: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerError: vi.fn(),
    mockSecretsManagerSend: vi.fn(),
  }));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: mockLoggerDebug,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: vi.fn().mockResolvedValue({ AvailabilityZones: [] }) },
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: vi.fn() },
  }),
}));

/** Long enough to clear the redaction needle-length floor. */
const PASSWORD = 'pw-2748-never-logged';
const SECRET_ID = 'cdkd-2748-secret';

/** The reference whose resolution RECORDS the password into the pass map. */
const PW_REF = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`;

beforeEach(() => {
  vi.clearAllMocks();
  // One secret, one key. The assembled reference below asks for a key named by
  // the RESOLVED password, which this document does not have -- so the resolver
  // throws its own `key '<k>' not found` naming it. The SDK is never the one
  // that names the plaintext here; the resolver is.
  mockSecretsManagerSend.mockResolvedValue({
    SecretString: JSON.stringify({ password: PASSWORD }),
  });
});

/**
 * A `Conditions` entry built FRESH per case.
 *
 * `resolveSub` resolves the variable map IN PLACE, so a shared literal would
 * carry the resolved password into the next case's template and the second case
 * would measure the first one's state.
 */
function leakingTemplate(): CloudFormationTemplate {
  return {
    Resources: {},
    Conditions: {
      Leak: {
        'Fn::Equals': [
          {
            'Fn::Sub': [
              `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${Pw}}}`,
              { Pw: PW_REF },
            ],
          },
          'never-equal',
        ],
      },
    },
  } as unknown as CloudFormationTemplate;
}

function ctx(template: CloudFormationTemplate, overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    template,
    resources: {},
    recordedSecretValues: new Map() as RecordedSecretValues,
    ...overrides,
  } as ResolverContext;
}

/**
 * Every WARN / INFO / ERROR line this pass emitted, joined.
 *
 * DEBUG IS DELIBERATELY EXCLUDED, and the exclusion is the point rather than a
 * convenience. `resolveSecretsManagerReference`'s
 * `Resolving dynamic reference: secretsmanager:<id>:SecretString:<key>` echo
 * prints the ASSEMBLED key -- the resolved password -- and on this base it is
 * still unmasked. That is issue #2728's site, not this one's: it is a
 * `logger.debug`, so it needs `--verbose` to be seen, and the fix for it is in
 * flight on go-to-k/cdkd#2742. Widening this negative to `debug` would make
 * this file fail on `main` and pass only once ANOTHER pull request merges,
 * which is a cross-PR dependency dressed up as coverage.
 *
 * What this lane owns is the DEFAULT-verbosity sink, so that is what the
 * negative covers. When go-to-k/cdkd#2742 lands, add `mockLoggerDebug` here.
 */
function nonDebugLogLines(): string {
  const spies = [mockLoggerWarn, mockLoggerInfo, mockLoggerError];
  return spies
    .flatMap((spy) => (spy.mock.calls as unknown[][]).map((call) => call.map(String).join(' ')))
    .join('\n');
}

/** The `Failed to evaluate condition` warn lines, in order. */
function conditionWarns(): string[] {
  return (mockLoggerWarn.mock.calls as unknown[][])
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('Failed to evaluate condition '));
}

describe('evaluateConditions masks the resolver error it renders (issue #2748)', () => {
  it('masks a plaintext the same pass resolved, on the exact warn line', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const template = leakingTemplate();
    const context = ctx(template);

    const conditions = await resolver.evaluateConditions(context);

    // PREMISE: the arm ran at all. Without this a mask assertion passes
    // vacuously on a pass that never reached the catch.
    expect(conditionWarns()).toHaveLength(1);
    // PREMISE: the pass really did record the password, so there was a needle
    // to mask against -- otherwise the masked line below would prove nothing.
    expect(context.recordedSecretValues?.has(PASSWORD)).toBe(true);

    expect(conditionWarns()[0]).toBe(
      `Failed to evaluate condition Leak: Dynamic reference: key '***' not found in secret '${SECRET_ID}', assuming false`
    );
    // ...and nowhere else a default-verbosity run would show.
    expect(nonDebugLogLines()).not.toContain(PASSWORD);
    // Behaviour preserved: a failed condition is still downgraded to false.
    expect(conditions['Leak']).toBe(false);
  });

  it('masks a plaintext that is only in the INHERITED bag', async () => {
    // A nested-stack CHILD never resolves a `{{resolve:` of its own -- the
    // PARENT resolved its `Parameters` block -- so the plaintext sits in
    // `inheritedSecrets` until some `{Ref: <Param>}` copies it across (issue
    // #1903). A one-bag mask here would print it; `maskSecretsForLog` reads
    // both, inherited first, which is why the fix routes through it rather
    // than calling `maskSecretsInText` on the pass map alone.
    const inheritedOnly = 'inherited-2748-plaintext';
    const resolver = new IntrinsicFunctionResolver();
    const template = {
      Resources: {},
      Conditions: {
        Inherited: {
          'Fn::Equals': [
            {
              'Fn::Sub': [
                `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${Pw}}}`,
                { Pw: inheritedOnly },
              ],
            },
            'never-equal',
          ],
        },
      },
    } as unknown as CloudFormationTemplate;

    const context = ctx(template, {
      inheritedSecrets: new Map([[inheritedOnly, '{{resolve:ssm-secure:/parent/param}}']]) as RecordedSecretValues,
    });

    await resolver.evaluateConditions(context);

    expect(conditionWarns()).toHaveLength(1);
    // The pass map stayed empty, so only the inherited bag could have masked it.
    expect(context.recordedSecretValues?.size).toBe(0);
    expect(conditionWarns()[0]).toBe(
      `Failed to evaluate condition Inherited: Dynamic reference: key '***' not found in secret '${SECRET_ID}', assuming false`
    );
    expect(nonDebugLogLines()).not.toContain(inheritedOnly);
  });

  it('leaves a message that names nothing recorded exactly as it was', async () => {
    // The control for a BLANKET replacement. The mask is a needle set: a
    // failure naming a value no bag holds must survive verbatim, or an
    // operator loses the only diagnostic the warn carries.
    const resolver = new IntrinsicFunctionResolver();
    const template = {
      Resources: {},
      Conditions: {
        // A self-referencing condition: the cycle guard throws, and its message
        // names only the condition, which is not a secret.
        Cycle: { 'Fn::Not': [{ Condition: 'Cycle' }] },
      },
    } as unknown as CloudFormationTemplate;
    const context = ctx(template, {
      recordedSecretValues: new Map([[PASSWORD, PW_REF]]) as RecordedSecretValues,
    });

    const conditions = await resolver.evaluateConditions(context);

    expect(conditionWarns()).toHaveLength(1);
    // The FULL line, not `toContain('Cycle')`: that needle is a substring of
    // the prefix `conditionWarns()` already filters on, so it would pass on a
    // line whose message had been replaced wholesale.
    expect(conditionWarns()[0]).toBe(
      'Failed to evaluate condition Cycle: Circular condition reference detected involving condition "Cycle", assuming false'
    );
    expect(conditionWarns()[0]).not.toContain('***');
    expect(conditions['Cycle']).toBe(false);
  });

  it('masks even when the CALLER brought no bag at all', async () => {
    // THE CASE THAT MATTERS, and the one an earlier revision of this file got
    // wrong: it built exactly this context and asserted only "does not throw",
    // which PINS the hole instead of closing it. Reviewers and a live
    // `cdkd diff` against a real secret each found the same leak.
    //
    // This is the shape `cli/commands/diff-recursive.ts` and
    // `cli/commands/import.ts` hand in -- a context literal with neither
    // `recordedSecretValues` nor `inheritedSecrets`. `maskSecretsForLog` is a
    // no-op against absent bags, so before the fix the resolved password
    // printed in full at DEFAULT verbosity on an ordinary `cdkd diff`.
    // `evaluateConditions` now supplies a private bag for exactly this caller.
    const resolver = new IntrinsicFunctionResolver();
    const template = leakingTemplate();
    const context = { template, resources: {} } as ResolverContext;

    const conditions = await resolver.evaluateConditions(context);

    expect(conditionWarns()).toHaveLength(1);
    expect(conditionWarns()[0]).toBe(
      `Failed to evaluate condition Leak: Dynamic reference: key '***' not found in secret '${SECRET_ID}', assuming false`
    );
    expect(nonDebugLogLines()).not.toContain(PASSWORD);
    // The private bag must NOT be handed back: `outputs-export-alias.ts` records
    // why a conditions bag must not reach an outputs bag. The caller's context
    // is untouched, so nothing downstream inherits a condition's needles.
    expect((context as { recordedSecretValues?: unknown }).recordedSecretValues).toBeUndefined();
    expect(conditions['Leak']).toBe(false);
  });

  it('keeps the INHERITED bag when the caller brought only that one', async () => {
    // The ternary keys off `recordedSecretValues` ALONE, so this is its one
    // untested branch: a caller with `inheritedSecrets` and no pass map takes
    // the spread arm, and the spread has to carry the inherited bag through or
    // the private map replaces the only needles there were. Unreachable in-tree
    // today (`buildResolverContext` always allocates a pass map), which is
    // exactly why it needs a test — nothing else would notice the spread being
    // dropped. It is the nested-stack-child shape issue #1903 is about.
    const inheritedOnly = 'inherited-only-2748-plaintext';
    const resolver = new IntrinsicFunctionResolver();
    const template = {
      Resources: {},
      Conditions: {
        InheritedOnly: {
          'Fn::Equals': [
            {
              'Fn::Sub': [
                `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${Pw}}}`,
                { Pw: inheritedOnly },
              ],
            },
            'never-equal',
          ],
        },
      },
    } as unknown as CloudFormationTemplate;

    // NO `recordedSecretValues` -- the shape `ctx()` never produces.
    const context = {
      template,
      resources: {},
      inheritedSecrets: new Map([
        [inheritedOnly, '{{resolve:ssm-secure:/parent/param}}'],
      ]) as RecordedSecretValues,
    } as ResolverContext;

    const conditions = await resolver.evaluateConditions(context);

    expect(conditionWarns()).toHaveLength(1);
    expect(conditionWarns()[0]).toBe(
      `Failed to evaluate condition InheritedOnly: Dynamic reference: key '***' not found in secret '${SECRET_ID}', assuming false`
    );
    expect(nonDebugLogLines()).not.toContain(inheritedOnly);
    // The private map went into the spread copy, not the caller's object.
    expect((context as { recordedSecretValues?: unknown }).recordedSecretValues).toBeUndefined();
    expect(conditions['InheritedOnly']).toBe(false);
  });

  it('masks a non-Error thrown value too', async () => {
    // The `String(error)` arm of the rendered template. A rejection that is not
    // an `Error` still reaches the same warn, so it needs the same needle.
    const resolver = new IntrinsicFunctionResolver();
    mockSecretsManagerSend.mockRejectedValue(`raw rejection naming ${PASSWORD}`);
    const template = leakingTemplate();
    const context = ctx(template, {
      recordedSecretValues: new Map([[PASSWORD, PW_REF]]) as RecordedSecretValues,
    });

    const conditions = await resolver.evaluateConditions(context);

    expect(conditionWarns()).toHaveLength(1);
    expect(conditionWarns()[0]).toBe(
      'Failed to evaluate condition Leak: raw rejection naming ***, assuming false'
    );
    expect(nonDebugLogLines()).not.toContain(PASSWORD);
    expect(conditions['Leak']).toBe(false);
  });
});
