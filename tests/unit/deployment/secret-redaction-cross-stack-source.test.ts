import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  redactSecretsForState,
  crossStackSourceKey,
  recordCrossStackExpression,
  clearRecordedSecretExpressions,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';

/**
 * POSITION certification for a CROSS-STACK source leaf (issue
 * [#2059](https://github.com/go-to-k/cdkd/issues/2059)).
 *
 * `intrinsicSkeletonPattern` recognises only `Fn::Join` and `Fn::Sub`, so an
 * `Fn::ImportValue` / `Fn::GetStackOutput` source leaf could not be positioned
 * at all and fell to the plaintext-keyed value scan. Two leaves whose resolved
 * plaintexts COINCIDE — an `:AWSCURRENT` and an `:AWSPREVIOUS` export of one
 * secret, momentarily equal during a rotation — therefore collapsed onto
 * whichever expression was recorded last, and `resolveReplayProps` then applied
 * the WRONG reference to the live resource on a rollback or a
 * `cdkd drift --revert`.
 *
 * WHICH CASES DRIVE THE RESOLVER, AND WHICH HAND-FILL THE STORE. The store's
 * whole claim is that a WRITER populates it on the real deploy path; a consumer
 * arm whose store no writer fills is a guard that cannot change an answer, and a
 * test that calls the writer itself proves only that the map works. So every
 * case asserting the arm FIRES drives the resolver — the four under
 * `Fn::ImportValue` / `Fn::GetStackOutput`, plus the cross-stack regression case
 * — with ONE exception, the "re-recording the SAME association is not a
 * conflict" case, whose subject is the WRITE-side dedup and which therefore has
 * to write twice by hand. The other SEVEN hand-filled cases are all REFUSALS,
 * where hand-filling only strengthens the assertion: it grants the store a more
 * favourable entry than a resolver pass would produce and the arm still declines
 * to use it. Their subjects are the store's own contract — conflict poisoning,
 * the process-wide/per-resource pairing, bag/source misalignment — which one
 * resolver pass cannot reach.
 *
 * THE DISCRIMINATING SHAPE IS TWO LEAVES, and only two. A single leaf passes
 * with the collapse fully intact — with one needle there is nothing to collapse
 * onto — so every behavioural case pairs two producers whose stored expressions
 * DIFFER while their resolved plaintexts do not, and asserts that EACH leaf
 * redacts back to ITS OWN expression.
 */

const mockSecretsManagerSend = vi.fn();
const mockSSMSend = vi.fn();

vi.mock('../../../src/utils/logger.js', () => {
  const noop = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => noop,
  };
  return { getLogger: () => noop };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '111122223333' }) },
    ec2: { send: vi.fn().mockResolvedValue({ AvailabilityZones: [] }) },
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: mockSSMSend },
  }),
}));

const REGION = 'us-east-1';
const SECRET_ID = 'prod/db/cred';

/**
 * The producer's OWN spelling of each reference, i.e. exactly what PR #1899
 * persists into `state.outputs` / the exports index for a secret-bearing
 * output. The two differ ONLY in the staging label, which is what makes them
 * two references to one secret whose values coincide until the rotation
 * completes.
 */
const EXPR_CURRENT = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password:AWSCURRENT}}`;
const EXPR_PREVIOUS = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password:AWSPREVIOUS}}`;
const SHARED = 'sh4red-r0tation-window-p4ssw0rd';

/**
 * A SECOND stack's secret, in a second region. A Secrets Manager secret is
 * regional, so two stacks legitimately hold different passwords — which is what
 * makes "whose expression got certified" observable.
 */
const WEST_SECRET_ID = 'west/db/cred';
const WEST_PASSWORD = 'west-r3gion-p4ssw0rd';
const EXPR_WEST = `{{resolve:secretsmanager:${WEST_SECRET_ID}:SecretString:password}}`;

const template: CloudFormationTemplate = { Resources: {} };

/** Exports-index double carrying the surface the resolver consults. */
function mockIndex(
  hits: Record<string, { value: unknown; producerStack: string; producerRegion: string }>
): ExportIndexStore {
  return {
    lookup: vi.fn(async (name: string) => hits[name]),
    patchEntry: vi.fn(async () => undefined),
  } as unknown as ExportIndexStore;
}

/** State-backend double for `Fn::GetStackOutput` and for the index-miss scan. */
function mockBackend(
  stacks: Array<{ stackName: string; region: string; outputs: Record<string, unknown> }> = []
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

function buildContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return { template, resources: {}, stackName: 'Consumer', ...overrides };
}

describe('secret-redaction - cross-stack source leaf (issue #2059)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver(REGION);
    resetAccountInfoCache();
    clearRecordedSecretExpressions();
    mockSecretsManagerSend.mockReset();
    mockSSMSend.mockReset();
    // ONE secret behind both staging labels, which is the rotation window: the
    // two references are genuinely distinct and their values genuinely equal.
    // Keyed by `SecretId` rather than a flat resolved value, so a second stack
    // can hold a DIFFERENT password behind a different secret — which is what
    // the cross-stack regression case below needs.
    mockSecretsManagerSend.mockImplementation((command: { input?: { SecretId?: string } }) =>
      Promise.resolve({
        SecretString: JSON.stringify({
          password: command.input?.SecretId === WEST_SECRET_ID ? WEST_PASSWORD : SHARED,
        }),
      })
    );
  });

  afterEach(() => {
    resetAccountInfoCache();
    clearRecordedSecretExpressions();
  });

  describe('the canonical key', () => {
    it('is derivable from a LITERAL source leaf, and separates two export names', () => {
      const one = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' });
      const two = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:PreviousPw' });
      expect(one).toBeTypeOf('string');
      expect(two).toBeTypeOf('string');
      expect(one).not.toBe(two);
    });

    it('REFUSES an export name that is itself an intrinsic', () => {
      // The persist path holds the UNRESOLVED template, so it cannot compute
      // what this resolves to. Refusing is the honest answer; guessing is not.
      expect(crossStackSourceKey({ 'Fn::ImportValue': { 'Fn::Sub': '${AWS::StackName}:Pw' } })).toBeUndefined();
      expect(crossStackSourceKey({ 'Fn::ImportValue': { Ref: 'ExportNameParam' } })).toBeUndefined();
      expect(crossStackSourceKey({ 'Fn::ImportValue': '' })).toBeUndefined();
    });

    it('separates the Fn::GetStackOutput slots, and keys an ABSENT optional as its own value', () => {
      const base = { StackName: 'Producer', OutputName: 'Pw' };
      const noRegion = crossStackSourceKey({ 'Fn::GetStackOutput': base });
      const withRegion = crossStackSourceKey({
        'Fn::GetStackOutput': { ...base, Region: REGION },
      });
      const otherOutput = crossStackSourceKey({
        'Fn::GetStackOutput': { ...base, OutputName: 'PwPrevious', Region: REGION },
      });
      const withRole = crossStackSourceKey({
        'Fn::GetStackOutput': { ...base, Region: REGION, RoleArn: 'arn:aws:iam::1:role/r' },
      });
      const keys = [noRegion, withRegion, otherOutput, withRole];
      expect(keys.every((k) => typeof k === 'string')).toBe(true);
      expect(new Set(keys).size).toBe(4);
    });

    it('REFUSES a non-literal Fn::GetStackOutput slot, and a non-cross-stack source', () => {
      const base = { StackName: 'Producer', OutputName: 'Pw' };
      expect(
        crossStackSourceKey({ 'Fn::GetStackOutput': { ...base, StackName: { Ref: 'P' } } })
      ).toBeUndefined();
      expect(
        crossStackSourceKey({ 'Fn::GetStackOutput': { ...base, Region: { Ref: 'R' } } })
      ).toBeUndefined();
      expect(crossStackSourceKey({ 'Fn::GetStackOutput': 'not-an-object' })).toBeUndefined();
      // The skeleton pass's own shapes stay ITS business.
      expect(crossStackSourceKey({ 'Fn::Join': ['', ['a']] })).toBeUndefined();
      expect(crossStackSourceKey({ Name: '', Value: 'an-unrelated-literal' })).toBeUndefined();
    });
  });

  describe('Fn::ImportValue', () => {
    const SOURCE = {
      Variables: {
        CURRENT: { 'Fn::ImportValue': 'Producer:CurrentPw' },
        PREVIOUS: { 'Fn::ImportValue': 'Producer:PreviousPw' },
      },
    };

    function importIndex(): ExportIndexStore {
      return mockIndex({
        'Producer:CurrentPw': {
          value: EXPR_CURRENT,
          producerStack: 'Producer',
          producerRegion: REGION,
        },
        'Producer:PreviousPw': {
          value: EXPR_PREVIOUS,
          producerStack: 'Producer',
          producerRegion: REGION,
        },
      });
    }

    function importContext(recordedSecretValues: RecordedSecretValues): ResolverContext {
      return buildContext({
        exportIndex: importIndex(),
        stateBackend: mockBackend(),
        recordedSecretValues,
      });
    }

    it('keeps each leaf on ITS OWN expression when two imports resolve to one plaintext', async () => {
      const recordedSecretValues: RecordedSecretValues = new Map();
      const resolved = (await resolver.resolve(SOURCE, importContext(recordedSecretValues))) as {
        Variables: Record<string, string>;
      };

      // The collapse is REAL, and pinned here so the assertion below is
      // measured against something rather than assumed.
      expect(resolved.Variables['CURRENT']).toBe(SHARED);
      expect(resolved.Variables['PREVIOUS']).toBe(SHARED);
      expect(recordedSecretValues.size).toBe(1);

      const redacted = redactSecretsForState(resolved, recordedSecretValues, SOURCE) as {
        Variables: Record<string, string>;
      };

      expect(redacted.Variables['CURRENT']).toBe(EXPR_CURRENT);
      expect(redacted.Variables['PREVIOUS']).toBe(EXPR_PREVIOUS);
      expect(JSON.stringify(redacted)).not.toContain(SHARED);
    });

    it('is not POISONED by the diff pass that runs before the deploy in the same process', async () => {
      // `skipDynamicReferences` (the diff / no-op comparison) deliberately
      // leaves a known secret UNRESOLVED, so the re-resolution hands back the
      // expression itself. Recording that would associate the key with a
      // "plaintext" that is really the token — and the DEPLOY pass that follows
      // in the SAME process then records the real plaintext under the same key,
      // which is a conflict, which POISONS it. The certification would be dead
      // for exactly the pair this issue exists for, and no test of a single pass
      // could see it. The presence test on `recordedSecretValues` is what keeps
      // the skip path from writing at all.
      // ONE bag across both resolutions, which is what puts them in the SAME
      // association bucket now that the store is pass-scoped. That is the shape
      // the presence test defends: nothing forbids a caller reusing its
      // `recordedSecretValues` across a comparison resolve and the deploy
      // resolve, and the guard has to hold if one does.
      const sharedSecrets: RecordedSecretValues = new Map();
      const diffResolved = await resolver.resolve(
        SOURCE,
        buildContext({
          exportIndex: importIndex(),
          stateBackend: mockBackend(),
          recordedSecretValues: sharedSecrets,
          skipDynamicReferences: true,
        })
      );
      // The premise: the diff pass fetched nothing and holds no plaintext.
      expect(sharedSecrets.size).toBe(0);
      expect(diffResolved).toEqual({ Variables: { CURRENT: EXPR_CURRENT, PREVIOUS: EXPR_PREVIOUS } });

      // Now the deploy pass, same process, same bag.
      const resolved = (await new IntrinsicFunctionResolver(REGION).resolve(
        SOURCE,
        importContext(sharedSecrets)
      )) as { Variables: Record<string, string> };

      const redacted = redactSecretsForState(resolved, sharedSecrets, SOURCE) as {
        Variables: Record<string, string>;
      };
      expect(redacted.Variables['CURRENT']).toBe(EXPR_CURRENT);
      expect(redacted.Variables['PREVIOUS']).toBe(EXPR_PREVIOUS);
    });

    it('certifies the index-MISS scan arm too, not only the index hit', async () => {
      // The scan arm is the one `cdkd scrub` actually takes — it deliberately
      // supplies no `exportIndex` — so a seam wired only into the index arm
      // would leave exactly that population collapsed.
      const recordedSecretValues: RecordedSecretValues = new Map();
      const context = buildContext({
        stateBackend: mockBackend([
          {
            stackName: 'Producer',
            region: REGION,
            outputs: { 'Producer:CurrentPw': EXPR_CURRENT, 'Producer:PreviousPw': EXPR_PREVIOUS },
          },
        ]),
        recordedSecretValues,
      });

      const resolved = (await resolver.resolve(SOURCE, context)) as {
        Variables: Record<string, string>;
      };
      expect(recordedSecretValues.size).toBe(1);

      const redacted = redactSecretsForState(resolved, recordedSecretValues, SOURCE) as {
        Variables: Record<string, string>;
      };
      expect(redacted.Variables['CURRENT']).toBe(EXPR_CURRENT);
      expect(redacted.Variables['PREVIOUS']).toBe(EXPR_PREVIOUS);
    });

    it('still certifies when the PRODUCER is in another region (the guest resolver)', async () => {
      // The producer-region resolver is a GUEST, and `pinSecretVerdict`
      // deliberately writes NOTHING process-wide from a guest (issue #1934's
      // review), so `recordedSecretExpressions` never learns these expressions.
      // The seam's verdict test must therefore keep the SPELLING arm:
      // `isRecordedSecretExpression` alone answers false for every cross-region
      // `secretsmanager` import, which would silently disable this fix for
      // exactly the shape `reresolveCrossStackValue` exists to serve.
      const PRODUCER_REGION = 'eu-west-1';
      const recordedSecretValues: RecordedSecretValues = new Map();
      const resolved = (await resolver.resolve(
        SOURCE,
        buildContext({
          exportIndex: mockIndex({
            'Producer:CurrentPw': {
              value: EXPR_CURRENT,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
            'Producer:PreviousPw': {
              value: EXPR_PREVIOUS,
              producerStack: 'Producer',
              producerRegion: PRODUCER_REGION,
            },
          }),
          stateBackend: mockBackend(),
          recordedSecretValues,
        })
      )) as { Variables: Record<string, string> };

      expect(recordedSecretValues.size).toBe(1);
      const redacted = redactSecretsForState(resolved, recordedSecretValues, SOURCE) as {
        Variables: Record<string, string>;
      };
      expect(redacted.Variables['CURRENT']).toBe(EXPR_CURRENT);
      expect(redacted.Variables['PREVIOUS']).toBe(EXPR_PREVIOUS);
    });

    it('REFUSES when the export name is an intrinsic, falling back to today’s behaviour', async () => {
      // No key is computable from the source leaf, so nothing is recorded and
      // the value scan answers exactly as it does today: both leaves take the
      // collapse survivor. Asserted rather than left implicit, because "refuses"
      // has to mean "no worse", not "no answer".
      const subSource = {
        Variables: {
          CURRENT: { 'Fn::ImportValue': { 'Fn::Sub': 'Producer:CurrentPw' } },
          PREVIOUS: { 'Fn::ImportValue': { 'Fn::Sub': 'Producer:PreviousPw' } },
        },
      };
      const recordedSecretValues: RecordedSecretValues = new Map();
      const resolved = (await resolver.resolve(
        subSource,
        importContext(recordedSecretValues)
      )) as { Variables: Record<string, string> };

      const redacted = redactSecretsForState(resolved, recordedSecretValues, subSource) as {
        Variables: Record<string, string>;
      };

      const survivor = recordedSecretValues.get(SHARED);
      expect(survivor).toBeTypeOf('string');
      expect(redacted.Variables['CURRENT']).toBe(survivor);
      expect(redacted.Variables['PREVIOUS']).toBe(survivor);
      // Still not a plaintext disclosure — the fallback redacts, it just cannot
      // separate the pair.
      expect(JSON.stringify(redacted)).not.toContain(SHARED);
    });

    it('does NOT record a PUBLIC ssm reference read across the stack boundary', async () => {
      // A producer output holding a public `{{resolve:ssm:...}}` must never come
      // back as an expression to persist: state holds such a reference RESOLVED
      // (issue #1901), and persisting the expression is the perpetual-UPDATE
      // class. The seam is gated on the resolution's OWN secret verdict, so a
      // `String` parameter is never associated with its leaf.
      const PUBLIC_EXPR = '{{resolve:ssm:/app/public-endpoint}}';
      const PUBLIC_VALUE = 'endpoint.example.com';
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: PUBLIC_VALUE, Type: 'String' },
      });

      const recordedSecretValues: RecordedSecretValues = new Map();
      const source = { Endpoint: { 'Fn::ImportValue': 'Producer:Endpoint' } };
      const resolved = await resolver.resolve(
        source,
        buildContext({
          exportIndex: mockIndex({
            'Producer:Endpoint': {
              value: PUBLIC_EXPR,
              producerStack: 'Producer',
              producerRegion: REGION,
            },
          }),
          stateBackend: mockBackend(),
          recordedSecretValues,
        })
      );
      expect(resolved).toEqual({ Endpoint: PUBLIC_VALUE });
      expect(recordedSecretValues.size).toBe(0);

      // Redacted with the resolver's OWN bag, which is what puts the seam's
      // writes and this read in the same association bucket — handing over a
      // separately built map would put them in different ones and the case would
      // assert nothing about the seam. The public value must survive RESOLVED:
      // persisting the expression instead is issue #1901's perpetual-UPDATE
      // class, and it is what happens if the seam records a public reference and
      // condition 1 stops refusing the leaf.
      const redacted = redactSecretsForState(
        resolved,
        recordedSecretValues,
        source
      ) as Record<string, string>;
      expect(redacted['Endpoint']).toBe(PUBLIC_VALUE);
      expect(redacted['Endpoint']).not.toBe(PUBLIC_EXPR);
    });
    it('does NOT record a PUBLIC ssm reference whose value COINCIDES with a recorded secret', () => {
      // The gate cannot be a PRESENCE test on `recordedSecretValues`. That map
      // is shared across the whole pass, so a public reference whose resolved
      // value happens to equal a secret already recorded passes such a test —
      // and coinciding plaintexts are this issue's own premise, not a contrived
      // path. The expression would then be persisted in place of a resolved
      // value, which is issue #1901's perpetual-UPDATE class. What settles it is
      // a verdict about THIS token: `secretsmanager` by spelling, or an `ssm`
      // reference PROVEN to be a `SecureString`.
      const PUBLIC_EXPR = '{{resolve:ssm:/app/public-endpoint}}';
      const EXPR_SM = '{{resolve:secretsmanager:app/token:SecretString:password}}';
      const COINCIDING = 'both-of-these-resolve-to-this';

      mockSSMSend.mockResolvedValue({ Parameter: { Value: COINCIDING, Type: 'String' } });
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ password: COINCIDING }),
      });

      const source = {
        // Resolved FIRST, so the plaintext is already in the map by the time the
        // import below is re-resolved — which is what makes the presence test
        // answer `true` for a public reference.
        Token: EXPR_SM,
        Endpoint: { 'Fn::ImportValue': 'Producer:Endpoint' },
      };
      const recordedSecretValues: RecordedSecretValues = new Map();

      return resolver
        .resolve(
          source,
          buildContext({
            exportIndex: mockIndex({
              'Producer:Endpoint': {
                value: PUBLIC_EXPR,
                producerStack: 'Producer',
                producerRegion: REGION,
              },
            }),
            stateBackend: mockBackend(),
            recordedSecretValues,
          })
        )
        .then((resolved) => {
          // The premise: one plaintext, and it IS in the map — so a presence
          // test would have said yes.
          expect(recordedSecretValues.get(COINCIDING)).toBe(EXPR_SM);

          const redacted = redactSecretsForState(resolved, recordedSecretValues, source) as Record<
            string,
            string
          >;
          // The value scan answers with the SECRET's expression, and the public
          // ssm reference is never handed back to be persisted.
          expect(redacted['Endpoint']).toBe(EXPR_SM);
          expect(redacted['Endpoint']).not.toBe(PUBLIC_EXPR);
        });
    });
  });

  describe('a SECOND stack sharing one key (the process-wide store regression)', () => {
    // The store is process-wide; the `secrets` maps it is consulted beside are
    // PER-RESOURCE. An `Fn::ImportValue` key carries no region at all and an
    // `Fn::GetStackOutput` that omits `Region` keys it empty, so one
    // `cdkd deploy --all` can put two stacks in two regions on ONE key —
    // `deploy.ts` builds a resolver per stack region.
    //
    // The dangerous shape is the one where NO conflict can be seen: the second
    // stack's producer still holds the PLAINTEXT (the issue #2133 / #2146
    // population), so `carriesDynamicReference` short-circuits before any
    // recording and the key is never poisoned. With only an expression stored,
    // the second stack's leaf was certified with the FIRST stack's expression —
    // and the value scan gets that case RIGHT today, so this was a NEW wrong
    // answer rather than a missed improvement.
    const SHARED_SOURCE = {
      'Fn::GetStackOutput': { StackName: 'Shared', OutputName: 'DbPassword' },
    };

    it('refuses a FOREIGN association even when the two regions resolve to the SAME value', async () => {
      // THE ROUND-2 RESIDUAL, and why the pairing check could not be the whole
      // answer. Pairing refuses a foreign entry only when the two plaintexts
      // DIFFER; a Secrets Manager multi-region replica and a shared API key both
      // make them coincide, and then a foreign association still certified. The
      // west leaf got the EAST region's expression, which `resolveReplayProps`
      // and `drift --revert` re-resolve against the EAST region — correct only
      // while replication holds, which is a property nobody declared and nothing
      // enforces. Scoping the store to the pass removes the reach entirely.
      const COINCIDE = 'the-same-value-in-both-regions';
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ password: COINCIDE }),
      });

      const east = new IntrinsicFunctionResolver(REGION);
      const eastSecrets: RecordedSecretValues = new Map();
      await east.resolve(
        { Pw: SHARED_SOURCE },
        buildContext({
          stackName: 'StackA',
          stateBackend: mockBackend([
            { stackName: 'Shared', region: REGION, outputs: { DbPassword: EXPR_CURRENT } },
          ]),
          recordedSecretValues: eastSecrets,
        })
      );
      expect(eastSecrets.get(COINCIDE)).toBe(EXPR_CURRENT);

      // West: producer still holds a PLAINTEXT (nothing recorded, nothing
      // poisoned), and its own sibling reference resolves to the SAME value.
      const WEST_REGION = 'us-west-2';
      const west = new IntrinsicFunctionResolver(WEST_REGION);
      const westSecrets: RecordedSecretValues = new Map();
      const westSource = { Pw: SHARED_SOURCE, Other: EXPR_WEST };
      const westResolved = (await west.resolve(
        westSource,
        buildContext({
          stackName: 'StackB',
          stateBackend: mockBackend([
            { stackName: 'Shared', region: WEST_REGION, outputs: { DbPassword: COINCIDE } },
          ]),
          recordedSecretValues: westSecrets,
        })
      )) as Record<string, string>;

      // The premise the pairing check cannot see: ONE plaintext, two regions.
      expect(westResolved['Pw']).toBe(COINCIDE);
      expect(westSecrets.get(COINCIDE)).toBe(EXPR_WEST);

      const redacted = redactSecretsForState(westResolved, westSecrets, westSource) as Record<
        string,
        string
      >;
      expect(redacted['Pw']).toBe(EXPR_WEST);
      expect(redacted['Pw']).not.toBe(EXPR_CURRENT);
    });

    it('refuses an association recorded by ANOTHER stack under the identical key', async () => {
      // Stack A, us-east-1: its producer IS redacted, so it records the key.
      const east = new IntrinsicFunctionResolver(REGION);
      const eastSecrets: RecordedSecretValues = new Map();
      const eastSource = { Pw: SHARED_SOURCE };
      const eastResolved = await east.resolve(
        eastSource,
        buildContext({
          stackName: 'StackA',
          stateBackend: mockBackend([
            { stackName: 'Shared', region: REGION, outputs: { DbPassword: EXPR_CURRENT } },
          ]),
          recordedSecretValues: eastSecrets,
        })
      );
      expect(eastResolved).toEqual({ Pw: SHARED });

      // Stack B, us-west-2, SAME process and SAME key. Its producer's state
      // still holds a PLAINTEXT, so nothing is recorded and nothing is poisoned.
      const WEST_REGION = 'us-west-2';
      const west = new IntrinsicFunctionResolver(WEST_REGION);
      const westSecrets: RecordedSecretValues = new Map();
      const westSource = { Pw: SHARED_SOURCE, Other: EXPR_WEST };
      const westResolved = (await west.resolve(
        westSource,
        buildContext({
          stackName: 'StackB',
          stateBackend: mockBackend([
            {
              stackName: 'Shared',
              region: WEST_REGION,
              outputs: { DbPassword: WEST_PASSWORD },
            },
          ]),
          recordedSecretValues: westSecrets,
        })
      )) as Record<string, string>;

      // B's leaf holds ITS OWN region's password, and that value is a recorded
      // plaintext here because a sibling reference resolved to it — so
      // condition 1 passes and only the pairing check stands between this leaf
      // and the east expression.
      expect(westResolved['Pw']).toBe(WEST_PASSWORD);
      expect(westSecrets.get(WEST_PASSWORD)).toBe(EXPR_WEST);

      const redacted = redactSecretsForState(westResolved, westSecrets, westSource) as Record<
        string,
        string
      >;

      // B keeps its OWN expression, which is what the value scan already gave.
      expect(redacted['Pw']).toBe(EXPR_WEST);
      // The failure this closes: the EAST secret's reference on a WEST resource,
      // which `resolveReplayProps` / `drift --revert` would push to AWS.
      expect(redacted['Pw']).not.toBe(EXPR_CURRENT);
      expect(JSON.stringify(redacted)).not.toContain(WEST_PASSWORD);
    });
  });

  describe('Fn::GetStackOutput', () => {
    const SOURCE = {
      Variables: {
        CURRENT: {
          'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'CurrentPw', Region: REGION },
        },
        PREVIOUS: {
          'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'PreviousPw', Region: REGION },
        },
      },
    };

    it('keeps each leaf on ITS OWN expression when two outputs resolve to one plaintext', async () => {
      const recordedSecretValues: RecordedSecretValues = new Map();
      const context = buildContext({
        stateBackend: mockBackend([
          {
            stackName: 'Producer',
            region: REGION,
            outputs: { CurrentPw: EXPR_CURRENT, PreviousPw: EXPR_PREVIOUS },
          },
        ]),
        recordedSecretValues,
      });

      const resolved = (await resolver.resolve(SOURCE, context)) as {
        Variables: Record<string, string>;
      };

      expect(resolved.Variables['CURRENT']).toBe(SHARED);
      expect(resolved.Variables['PREVIOUS']).toBe(SHARED);
      expect(recordedSecretValues.size).toBe(1);

      const redacted = redactSecretsForState(resolved, recordedSecretValues, SOURCE) as {
        Variables: Record<string, string>;
      };

      expect(redacted.Variables['CURRENT']).toBe(EXPR_CURRENT);
      expect(redacted.Variables['PREVIOUS']).toBe(EXPR_PREVIOUS);
      expect(JSON.stringify(redacted)).not.toContain(SHARED);
    });

    it('REFUSES when a slot is an intrinsic, falling back to today’s behaviour', async () => {
      const refSource = {
        Variables: {
          CURRENT: {
            'Fn::GetStackOutput': {
              StackName: 'Producer',
              OutputName: { 'Fn::Sub': 'CurrentPw' },
              Region: REGION,
            },
          },
          PREVIOUS: {
            'Fn::GetStackOutput': {
              StackName: 'Producer',
              OutputName: { 'Fn::Sub': 'PreviousPw' },
              Region: REGION,
            },
          },
        },
      };
      const recordedSecretValues: RecordedSecretValues = new Map();
      const resolved = (await resolver.resolve(
        refSource,
        buildContext({
          stateBackend: mockBackend([
            {
              stackName: 'Producer',
              region: REGION,
              outputs: { CurrentPw: EXPR_CURRENT, PreviousPw: EXPR_PREVIOUS },
            },
          ]),
          recordedSecretValues,
        })
      )) as { Variables: Record<string, string> };

      const redacted = redactSecretsForState(resolved, recordedSecretValues, refSource) as {
        Variables: Record<string, string>;
      };
      const survivor = recordedSecretValues.get(SHARED);
      expect(redacted.Variables['CURRENT']).toBe(survivor);
      expect(redacted.Variables['PREVIOUS']).toBe(survivor);
      expect(JSON.stringify(redacted)).not.toContain(SHARED);
    });
  });

  describe('what the certification will NOT do', () => {
    // Issue #1915's fences rejected an earlier attempt that took the SOURCE
    // subtree whenever the bag could not be vouched for, because it rewrote a
    // pair whose value is an ordinary literal. This arm must not reopen that,
    // and the guard is condition 1: the bag leaf has to be a plaintext THIS
    // pass recorded.
    // Both #1915 fences are set up ADVERSARIALLY, and the setup is the point.
    // The store is hand-filled with the literal ITSELF as the recorded plaintext
    // — i.e. another stack's secret resolved to exactly this string, which is
    // this issue's own coinciding-plaintext premise — so the pairing check
    // (condition 2) cannot refuse and condition 1 is the ONLY guard standing. A
    // probe deleting condition 1 therefore turns this pair red instead of being
    // masked by a neighbour. The secrets map is EMPTY for the same reason it is
    // realistic: the issue #1900 / #1926 population, an UNCHANGED resource that
    // was never resolved this deploy and so has no `perResourceSecrets` entry.
    const UNRELATED = 'an-unrelated-literal';

    it('leaves an unrelated literal alone even when its source leaf IS a recorded import', () => {
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      const secrets: RecordedSecretValues = new Map();
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, UNRELATED);

      const source = { Name: '', Value: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const bag = { Name: '', Value: UNRELATED };

      const redacted = redactSecretsForState(bag, secrets, source);
      expect(redacted).toEqual(bag);
    });

    it('leaves the #1915 ARRAY shape alone', () => {
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      const secrets: RecordedSecretValues = new Map();
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, UNRELATED);

      const source = [{ Name: '', Value: { 'Fn::ImportValue': 'Producer:CurrentPw' } }];
      const bag = [{ Name: '', Value: UNRELATED }];

      const redacted = redactSecretsForState(bag, secrets, source);
      expect(redacted).toEqual(bag);
    });

    // The poisoning fence needs BOTH polarities, and this pair is what makes it
    // two-sided. Each case picks the value scan's answer so that "poisoned,
    // refuse" differs from ONE of the two ways of not poisoning — the first from
    // KEEP-LAST (overwrite), the second from KEEP-FIRST (never overwrite). With
    // only the first, a mutant that simply stops poisoning and keeps the first
    // recording stayed green while still certifying one of two contradicting
    // associations, which is exactly what the poison forbids.
    const CONFLICT_KEY = (): string =>
      crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;

    it('REFUSES a key recorded against two DIFFERENT expressions (vs KEEP-LAST)', () => {
      const key = CONFLICT_KEY();
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_CURRENT]]);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);
      recordCrossStackExpression(secrets, key, EXPR_PREVIOUS, SHARED);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: SHARED }, secrets, source) as Record<
        string,
        string
      >;

      // Falls through to the value scan, i.e. today's behaviour. A keep-LAST
      // mutant would answer EXPR_PREVIOUS here.
      expect(redacted['P']).toBe(EXPR_CURRENT);
    });

    it('REFUSES a key recorded against two DIFFERENT expressions (vs KEEP-FIRST)', () => {
      const key = CONFLICT_KEY();
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);
      recordCrossStackExpression(secrets, key, EXPR_PREVIOUS, SHARED);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: SHARED }, secrets, source) as Record<
        string,
        string
      >;

      // A keep-FIRST mutant would answer EXPR_CURRENT here.
      expect(redacted['P']).toBe(EXPR_PREVIOUS);
    });

    it('REFUSES a key recorded against two different PLAINTEXTS for one expression', () => {
      // The other half of the conflict test: one reference answering differently
      // in two regions (the issue #1933 shape). The expression matches, so an
      // expression-only conflict test would accept it.
      const key = CONFLICT_KEY();
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, 'a-different-region-password');

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: SHARED }, secrets, source) as Record<
        string,
        string
      >;

      expect(redacted['P']).toBe(EXPR_PREVIOUS);
    });

    it('re-recording the SAME association is not a conflict', () => {
      const key = CONFLICT_KEY();
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: SHARED }, secrets, source) as Record<
        string,
        string
      >;

      expect(redacted['P']).toBe(EXPR_CURRENT);
    });

    it('REFUSES an association recorded against a DIFFERENT plaintext than this bag', () => {
      // Condition 2, hand-filled: the readback bag carries a DIFFERENT secret's
      // plaintext while the source leaf still spells this import. The WRITER
      // recorded this expression against SHARED, so the association is not about
      // this bag and is refused before anything else is consulted.
      const key = CONFLICT_KEY();

      const OTHER_PLAINTEXT = 'a-completely-different-secret';
      const OTHER_EXPR = '{{resolve:secretsmanager:other:SecretString:v}}';
      // `EXPR_CURRENT` is deliberately ABSENT from this map, which is what makes
      // condition 2 the only guard standing: condition 3 can refuse only an
      // expression it can SEE resolve elsewhere, and absence is exactly what it
      // must accept (the collapsed loser is absent too). A probe deleting the
      // pairing therefore turns this red instead of being masked by its
      // neighbour.
      const secrets: RecordedSecretValues = new Map([[OTHER_PLAINTEXT, OTHER_EXPR]]);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: OTHER_PLAINTEXT }, secrets, source) as Record<
        string,
        string
      >;

      expect(redacted['P']).toBe(OTHER_EXPR);
    });

    it('REFUSES when THIS PASS saw the association’s expression resolve elsewhere', () => {
      // Condition 3, and it is NOT subsumed by condition 2: the writer's
      // plaintext DOES equal this bag, so the pairing passes, but this pass's own
      // map says the same expression resolved to something else — one reference
      // answering differently in two regions (issue #1933). Condition 2 compares
      // what the WRITER recorded; condition 3 compares what THIS PASS holds.
      const key = CONFLICT_KEY();

      const ELSEWHERE = 'the-other-regions-password';
      const secrets: RecordedSecretValues = new Map([
        [SHARED, EXPR_PREVIOUS],
        [ELSEWHERE, EXPR_CURRENT],
      ]);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: SHARED }, secrets, source) as Record<
        string,
        string
      >;

      expect(redacted['P']).toBe(EXPR_PREVIOUS);
    });

    it('REFUSES to store an association whose expression is not a whole token', () => {
      // The two payload parameters are both `string`, so the type system cannot
      // see a SWAPPED call — and a swap is not merely a wrong answer: the reader
      // returns `expression`, so a stored `{expression: <plaintext>}` writes a
      // SECRET into `state.json`. The setup is what a swap looks like when the
      // reader would otherwise ACCEPT it: the swapped `plaintext` slot holds the
      // real EXPRESSION, so it equals a bag leaf that is a token-shaped value
      // this pass recorded (the issue #1917 shape), satisfying conditions 1 and
      // 2, while condition 3 has nothing to say about the plaintext now sitting
      // in the expression slot.
      //
      // WHAT THE INVARIANT DOES NOT CATCH, stated rather than left to be
      // discovered: a swap whose plaintext is ITSELF a complete
      // `{{resolve:...}}` token passes the shape test, because #1917 exists
      // precisely because a secret's VALUE can look like one and nothing can
      // tell the two apart from the string alone. The guard narrows a swap from
      // "any secret" to "a secret that happens to be token-shaped"; the caller
      // guard at the seam is what covers the rest.
      const PLAINTEXT = 'ordinary-plaintext-secret-value';
      const OWN_EXPR = '{{resolve:secretsmanager:owner:SecretString:v}}';
      const key = CONFLICT_KEY();
      const secrets: RecordedSecretValues = new Map([[EXPR_CURRENT, OWN_EXPR]]);

      // SWAPPED on purpose: the plaintext lands in the `expression` slot.
      recordCrossStackExpression(secrets, key, PLAINTEXT, EXPR_CURRENT);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: EXPR_CURRENT }, secrets, source) as Record<
        string,
        string
      >;

      expect(redacted['P']).not.toBe(PLAINTEXT);
      expect(redacted['P']).toBe(OWN_EXPR);
    });

    it('leaves a leaf that merely EMBEDS the secret to the value scan', () => {
      // The certification answers with one complete token, so a leaf with
      // surrounding text is not this shape and must keep going to the scan,
      // which rewrites just the substring. TWO guards hold this independently —
      // condition 1 (the URL is not a recorded plaintext) and condition 2 (the
      // writer recorded SHARED, not the URL) — so it takes a combined probe to
      // turn it red, which is the honest reading of a leaf no single guard owns.
      const key = CONFLICT_KEY();
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, key, EXPR_CURRENT, SHARED);

      const source = { Url: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState(
        { Url: `postgres://user:${SHARED}@host/db` },
        secrets,
        source
      ) as Record<string, string>;

      expect(redacted['Url']).toBe(`postgres://user:${EXPR_PREVIOUS}@host/db`);
    });
  });
});
