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
  clearRecordedCrossStackExpressions,
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
 * WHY EVERY BEHAVIOURAL CASE HERE DRIVES THE RESOLVER rather than calling
 * `recordCrossStackExpression` from the test. The store's whole claim is that a
 * WRITER populates it on the real deploy path; a consumer arm whose store no
 * writer fills is a guard that cannot change an answer, and a test that calls
 * the writer itself proves only that the map works. The three cases below that
 * call the writer directly are about the store's OWN contract (key conflicts,
 * bag/source misalignment), which is not reachable from one resolver pass.
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
    clearRecordedCrossStackExpressions();
    mockSecretsManagerSend.mockReset();
    mockSSMSend.mockReset();
    // ONE secret behind both staging labels, which is the rotation window: the
    // two references are genuinely distinct and their values genuinely equal.
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: SHARED }),
    });
  });

  afterEach(() => {
    resetAccountInfoCache();
    clearRecordedSecretExpressions();
    clearRecordedCrossStackExpressions();
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

    function importContext(recordedSecretValues: RecordedSecretValues): ResolverContext {
      return buildContext({
        exportIndex: mockIndex({
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
        }),
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

      // The discriminator: hand the redactor a bag in which the PUBLIC value is
      // (implausibly, but this is the fence) a recorded needle. If the seam had
      // associated the public expression with this leaf, the certification would
      // hand back `PUBLIC_EXPR`; gated, it falls to the value scan.
      const OTHER = '{{resolve:secretsmanager:other:SecretString:v}}';
      const redacted = redactSecretsForState(
        { Endpoint: PUBLIC_VALUE },
        new Map([[PUBLIC_VALUE, OTHER]]),
        source
      ) as Record<string, string>;
      expect(redacted['Endpoint']).toBe(OTHER);
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
    // The secrets map is EMPTY on purpose. That is the issue #1900 / #1926
    // population — an UNCHANGED resource is never resolved this deploy, so it
    // has no `perResourceSecrets` entry — and it is also what leaves condition 1
    // as the ONLY guard standing here: with no recorded plaintexts the
    // misalignment test below has nothing to contradict, so a probe that deletes
    // condition 1 turns this pair red instead of being masked by its neighbour.
    it('leaves an unrelated literal alone even when its source leaf IS a recorded import', () => {
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      recordCrossStackExpression(key, EXPR_CURRENT);

      const source = { Name: '', Value: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const bag = { Name: '', Value: 'an-unrelated-literal' };

      const redacted = redactSecretsForState(bag, new Map(), source);
      expect(redacted).toEqual(bag);
    });

    it('leaves the #1915 ARRAY shape alone', () => {
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      recordCrossStackExpression(key, EXPR_CURRENT);

      const source = [{ Name: '', Value: { 'Fn::ImportValue': 'Producer:CurrentPw' } }];
      const bag = [{ Name: '', Value: 'an-unrelated-literal' }];

      const redacted = redactSecretsForState(bag, new Map(), source);
      expect(redacted).toEqual(bag);
    });

    it('REFUSES a key recorded against two DIFFERENT expressions', () => {
      // One export name in one region names one stored value, so a conflict
      // means the premise this rests on does not hold — guessing between the
      // two would be the collapse, one step over.
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      recordCrossStackExpression(key, EXPR_CURRENT);
      recordCrossStackExpression(key, EXPR_PREVIOUS);

      // The value scan's answer is deliberately the FIRST recording, so that
      // "poisoned, refuse" and "last write wins" give different results — with
      // the two the same the case cannot tell them apart at all.
      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState(
        { P: SHARED },
        new Map([[SHARED, EXPR_CURRENT]]),
        source
      ) as Record<string, string>;

      // Falls through to the value scan, i.e. today's behaviour.
      expect(redacted['P']).toBe(EXPR_CURRENT);
    });

    it('re-recording the SAME expression is not a conflict', () => {
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      recordCrossStackExpression(key, EXPR_CURRENT);
      recordCrossStackExpression(key, EXPR_CURRENT);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState(
        { P: SHARED },
        new Map([[SHARED, EXPR_PREVIOUS]]),
        source
      ) as Record<string, string>;

      expect(redacted['P']).toBe(EXPR_CURRENT);
    });

    it('REFUSES an association DEMONSTRABLY recorded against another plaintext', () => {
      // Bag/source misalignment: the readback bag carries a DIFFERENT secret's
      // plaintext while the source leaf still spells this import. The pass can
      // see that this expression resolved to something else, so it refuses
      // rather than certifying a position it can prove wrong.
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      recordCrossStackExpression(key, EXPR_CURRENT);

      const OTHER_PLAINTEXT = 'a-completely-different-secret';
      const OTHER_EXPR = '{{resolve:secretsmanager:other:SecretString:v}}';
      const secrets: RecordedSecretValues = new Map([
        [SHARED, EXPR_CURRENT],
        [OTHER_PLAINTEXT, OTHER_EXPR],
      ]);

      const source = { P: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState({ P: OTHER_PLAINTEXT }, secrets, source) as Record<
        string,
        string
      >;

      expect(redacted['P']).toBe(OTHER_EXPR);
    });

    it('leaves a leaf that merely EMBEDS the secret to the value scan', () => {
      // Condition 1 is a WHOLE-value test: the certification answers with one
      // complete token, so a leaf with surrounding text is not this shape and
      // must keep going to the scan, which rewrites just the substring.
      const key = crossStackSourceKey({ 'Fn::ImportValue': 'Producer:CurrentPw' })!;
      recordCrossStackExpression(key, EXPR_CURRENT);

      const source = { Url: { 'Fn::ImportValue': 'Producer:CurrentPw' } };
      const redacted = redactSecretsForState(
        { Url: `postgres://user:${SHARED}@host/db` },
        new Map([[SHARED, EXPR_PREVIOUS]]),
        source
      ) as Record<string, string>;

      expect(redacted['Url']).toBe(`postgres://user:${EXPR_PREVIOUS}@host/db`);
    });
  });
});
