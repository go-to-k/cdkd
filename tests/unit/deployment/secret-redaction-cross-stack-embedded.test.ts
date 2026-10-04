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
  intrinsicLeafResolutionOf,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { wholeReferenceSpans } from '../../../src/deployment/intrinsic-resolver/string-functions.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';

/**
 * A cross-stack secret reference EMBEDDED in a leaf's text (issue
 * [#2298](https://github.com/go-to-k/cdkd/issues/2298)).
 *
 * `crossStackSourceKey` keys only a leaf that IS one cross-stack reference, so a
 * leaf such as `pre-${Child.Outputs.Cur}-post` (or its `Fn::Join` spelling) fell
 * to the plaintext-keyed value scan. With a sibling leaf of the SAME resource
 * resolving to the same plaintext, that scan wrote the sibling's expression into
 * the embedded leaf, and `resolveReplayProps` would re-resolve it on a rollback
 * or `cdkd drift --revert`, pushing the wrong secret version to AWS.
 *
 * Every behavioural case drives the REAL resolver, so the associations come from
 * the writer, and holds both leaves in ONE resource bag: `perResourceSecrets`
 * is keyed by logical id, so two resources would get two bags and pass with or
 * without the fix. Each case asserts the collapse is live (one needle for two
 * references) before asserting each leaf persists its OWN expression. The pair
 * is run in BOTH arrangements (embedded = CURRENT and embedded = PREVIOUS):
 * whichever expression the map keeps, one arrangement persists the sibling's
 * without the fix.
 */

const mockSecretsManagerSend = vi.fn();

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
    ssm: { send: vi.fn() },
  }),
}));

const REGION = 'us-east-1';
const SECRET_ID = 'prod/db/cred';
const EXPR_CURRENT = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password:AWSCURRENT}}`;
const EXPR_PREVIOUS = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password:AWSPREVIOUS}}`;
const SHARED = 'sh4red-r0tation-window-p4ssw0rd';

const template: CloudFormationTemplate = { Resources: {} };

const EXPR_OF = { Current: EXPR_CURRENT, Previous: EXPR_PREVIOUS } as const;
type Stage = keyof typeof EXPR_OF;

/** One context that can answer all three cross-stack readers. */
function buildContext(recordedSecretValues: RecordedSecretValues): ResolverContext {
  const exportIndex = {
    lookup: vi.fn(async (name: string) =>
      name === 'Producer:CurrentPw' || name === 'Producer:PreviousPw'
        ? {
            value: name === 'Producer:CurrentPw' ? EXPR_CURRENT : EXPR_PREVIOUS,
            producerStack: 'Producer',
            producerRegion: REGION,
          }
        : undefined
    ),
    patchEntry: vi.fn(async () => undefined),
  } as unknown as ExportIndexStore;
  const stateBackend = {
    listStacks: vi.fn(async () => [{ stackName: 'Producer', region: REGION }]),
    getState: vi.fn(async (stackName: string, region: string) =>
      stackName === 'Producer' && region === REGION
        ? {
            state: {
              version: 8,
              stackName,
              region,
              resources: {},
              outputs: { CurrentPw: EXPR_CURRENT, PreviousPw: EXPR_PREVIOUS },
              lastModified: 1,
            },
            etag: 'e',
          }
        : null
    ),
  } as unknown as S3StateBackend;
  return {
    template,
    stackName: 'Consumer',
    exportIndex,
    stateBackend,
    recordedSecretValues,
    resources: {
      Child: {
        physicalId: `arn:cdkd-local:${REGION}:111122223333:nested-stack/Parent/Child`,
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: { 'Outputs.CurrentPw': EXPR_CURRENT, 'Outputs.PreviousPw': EXPR_PREVIOUS },
      },
      // A SAME-stack resource: its attributes get a span (every `Fn::GetAtt`
      // is keyed) but no association, so they must stay text.
      Db: {
        physicalId: 'db-4527',
        resourceType: 'AWS::RDS::DBInstance',
        properties: {},
        attributes: { 'Endpoint.Address': 'db.internal', 'Endpoint.Port': '3306' },
      },
    } as unknown as ResolverContext['resources'],
  };
}

/** The three whole-token spellings of one stage's reference. */
const WHOLE = {
  getAtt: (stage: Stage) => ({ 'Fn::GetAtt': ['Child', `Outputs.${stage}Pw`] }),
  importValue: (stage: Stage) => ({ 'Fn::ImportValue': `Producer:${stage}Pw` }),
  stackOutput: (stage: Stage) => ({
    'Fn::GetStackOutput': { StackName: 'Producer', OutputName: `${stage}Pw`, Region: REGION },
  }),
};

/**
 * Resolve `{ Embedded, Sibling }` in one pass over one bag, assert the
 * collapse is live, and return the persisted bag.
 */
async function persist(
  resolver: IntrinsicFunctionResolver,
  source: Record<string, unknown>,
  conditions?: Record<string, boolean>
): Promise<{ resolved: Record<string, unknown>; redacted: Record<string, unknown> }> {
  const secrets: RecordedSecretValues = new Map();
  const context = buildContext(secrets);
  if (conditions !== undefined) context.conditions = conditions;
  const resolved = (await resolver.resolve(source, context)) as Record<
    string,
    unknown
  >;
  // The premise: ONE needle for two distinct references. Without it the case
  // passes with the defect fully intact.
  expect(secrets.size).toBe(1);
  expect(secrets.has(SHARED)).toBe(true);
  const redacted = redactSecretsForState(resolved, secrets, source) as Record<string, unknown>;
  expect(JSON.stringify(redacted)).not.toContain(SHARED);
  return { resolved, redacted };
}

const OTHER: Record<Stage, Stage> = { Current: 'Previous', Previous: 'Current' };
const STAGES: Stage[] = ['Current', 'Previous'];

describe('secret-redaction - cross-stack secret EMBEDDED in a leaf (issue #2298)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver(REGION);
    resetAccountInfoCache();
    clearRecordedSecretExpressions();
    mockSecretsManagerSend.mockReset();
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: SHARED }),
    });
  });

  afterEach(() => {
    resetAccountInfoCache();
    clearRecordedSecretExpressions();
  });

  describe.each(STAGES)('embedded = %s', (stage) => {
    const own = EXPR_OF[stage];
    const sibling = OTHER[stage];

    it('Fn::Sub with surrounding text, nested-stack output placeholder', async () => {
      const { resolved, redacted } = await persist(resolver, {
        Embedded: { 'Fn::Sub': `jdbc:mysql://db:3306/app?password=\${Child.Outputs.${stage}Pw}` },
        Sibling: WHOLE.getAtt(sibling),
      });
      expect(resolved['Embedded']).toBe(`jdbc:mysql://db:3306/app?password=${SHARED}`);
      expect(redacted['Embedded']).toBe(`jdbc:mysql://db:3306/app?password=${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('Fn::Join over a nested-stack output', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: { 'Fn::Join': ['', ['pre-', WHOLE.getAtt(stage), '-post']] },
        Sibling: WHOLE.getAtt(sibling),
      });
      expect(redacted['Embedded']).toBe(`pre-${own}-post`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('Fn::Join over an Fn::ImportValue, with a non-empty delimiter', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: { 'Fn::Join': [':', ['user', WHOLE.importValue(stage)]] },
        Sibling: WHOLE.importValue(sibling),
      });
      expect(redacted['Embedded']).toBe(`user:${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('Fn::Join over an Fn::GetStackOutput', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: { 'Fn::Join': ['', ['pw=', WHOLE.stackOutput(stage)]] },
        Sibling: WHOLE.stackOutput(sibling),
      });
      expect(redacted['Embedded']).toBe(`pw=${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('2-arg Fn::Sub binding a variable to an Fn::ImportValue (CDK’s Fn.sub shape)', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: { 'Fn::Sub': ['pw=${V};', { V: WHOLE.importValue(stage) }] },
        Sibling: WHOLE.importValue(sibling),
      });
      expect(redacted['Embedded']).toBe(`pw=${own};`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('a sibling that is itself embedded', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: { 'Fn::Sub': `a-\${Child.Outputs.${stage}Pw}` },
        Sibling: { 'Fn::Join': ['', ['b-', WHOLE.importValue(sibling)]] },
      });
      expect(redacted['Embedded']).toBe(`a-${own}`);
      expect(redacted['Sibling']).toBe(`b-${EXPR_OF[sibling]}`);
    });
  });

  it('positions TWO references embedded in one leaf, each on its own expression', async () => {
    const { redacted } = await persist(resolver, {
      Embedded: { 'Fn::Sub': '${Child.Outputs.CurrentPw}|${Child.Outputs.PreviousPw}' },
    });
    expect(redacted['Embedded']).toBe(`${EXPR_CURRENT}|${EXPR_PREVIOUS}`);
  });

  it('keeps one UNKNOWN part (a pseudo parameter) verbatim beside the certified one', async () => {
    const { redacted } = await persist(resolver, {
      Embedded: { 'Fn::Sub': '${AWS::Region}/${Child.Outputs.CurrentPw}' },
      Sibling: WHOLE.getAtt('Previous'),
    });
    expect(redacted['Embedded']).toBe(`${REGION}/${EXPR_CURRENT}`);
    expect(redacted['Sibling']).toBe(EXPR_PREVIOUS);
  });

  // Issue #4527: TWO OR MORE parts beside the read whose text the template
  // cannot state (pseudo parameters, same-stack intrinsics), and an `Fn::If`
  // selecting such a leaf. The template parse aligns at most one unknown part
  // and never reads an `Fn::If`, so these fell to the value scan; the
  // resolver's own span for the read answers them. Both arrangements again,
  // so one of them persists the sibling's expression without the fix.
  describe.each(STAGES)('beside two or more unknown parts, embedded = %s (issue #4527)', (stage) => {
    const own = EXPR_OF[stage];
    const sibling = OTHER[stage];
    const host = `${REGION}.111122223333`;

    it('Fn::Sub with two pseudo parameters and a nested-stack output placeholder', async () => {
      const { resolved, redacted } = await persist(resolver, {
        Embedded: {
          'Fn::Sub': `jdbc:mysql://\${AWS::Region}.\${AWS::AccountId}.host/?pw=\${Child.Outputs.${stage}Pw}`,
        },
        Sibling: WHOLE.getAtt(sibling),
      });
      expect(resolved['Embedded']).toBe(`jdbc:mysql://${host}.host/?pw=${SHARED}`);
      expect(redacted['Embedded']).toBe(`jdbc:mysql://${host}.host/?pw=${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('the issue probe: two pseudo parameters adjacent to the read', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: { 'Fn::Sub': `\${AWS::Region}.\${AWS::AccountId}/\${Child.Outputs.${stage}Pw}` },
        Sibling: WHOLE.getAtt(sibling),
      });
      expect(redacted['Embedded']).toBe(`${host}/${own}`);
    });

    it('Fn::Join over two pseudo-parameter Refs and an Fn::ImportValue', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: {
          'Fn::Join': [
            '',
            [
              { Ref: 'AWS::Region' },
              '.',
              { Ref: 'AWS::AccountId' },
              '/pw=',
              WHOLE.importValue(stage),
            ],
          ],
        },
        Sibling: WHOLE.importValue(sibling),
      });
      expect(redacted['Embedded']).toBe(`${host}/pw=${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('Fn::Join over two pseudo parameters and an Fn::GetStackOutput', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: {
          'Fn::Join': [':', [{ Ref: 'AWS::Region' }, { Ref: 'AWS::AccountId' }, WHOLE.stackOutput(stage)]],
        },
        Sibling: WHOLE.stackOutput(sibling),
      });
      expect(redacted['Embedded']).toBe(`${REGION}:111122223333:${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('2-arg Fn::Sub binding the read beside two pseudo parameters', async () => {
      const { redacted } = await persist(resolver, {
        Embedded: {
          'Fn::Sub': ['${AWS::Region}.${AWS::AccountId}/${V}', { V: WHOLE.importValue(stage) }],
        },
        Sibling: WHOLE.importValue(sibling),
      });
      expect(redacted['Embedded']).toBe(`${host}/${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('an Fn::If selecting an embedding Fn::Sub', async () => {
      const { redacted } = await persist(
        resolver,
        {
          Embedded: {
            'Fn::If': ['IsProd', { 'Fn::Sub': `pw=\${Child.Outputs.${stage}Pw}` }, 'none'],
          },
          Sibling: WHOLE.getAtt(sibling),
        },
        { IsProd: true }
      );
      expect(redacted['Embedded']).toBe(`pw=${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('an Fn::If selecting an Fn::Join over two pseudo parameters and the read', async () => {
      const { redacted } = await persist(
        resolver,
        {
          Embedded: {
            'Fn::If': [
              'IsProd',
              {
                'Fn::Join': [
                  '/',
                  [{ Ref: 'AWS::Region' }, { Ref: 'AWS::AccountId' }, WHOLE.getAtt(stage)],
                ],
              },
              'none',
            ],
          },
          Sibling: WHOLE.getAtt(sibling),
        },
        { IsProd: true }
      );
      expect(redacted['Embedded']).toBe(`${REGION}/111122223333/${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('beside two SAME-stack attributes, whose spans have no association', async () => {
      const { resolved, redacted } = await persist(resolver, {
        Embedded: {
          'Fn::Join': [
            ':',
            [
              { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] },
              { 'Fn::GetAtt': ['Db', 'Endpoint.Port'] },
              WHOLE.importValue(stage),
            ],
          ],
        },
        Sibling: WHOLE.importValue(sibling),
      });
      expect(resolved['Embedded']).toBe(`db.internal:3306:${SHARED}`);
      expect(redacted['Embedded']).toBe(`db.internal:3306:${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('a whole leaf that is an Fn::If selecting the read itself', async () => {
      // The `Fn::If` lends the read's own record now that it has one, so the
      // span arm answers it with the read's association, as a whole leaf of
      // the read would be.
      const { redacted } = await persist(
        resolver,
        {
          Embedded: { 'Fn::If': ['IsProd', WHOLE.importValue(stage), 'none'] },
          Sibling: WHOLE.importValue(sibling),
        },
        { IsProd: true }
      );
      expect(redacted['Embedded']).toBe(own);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });

    it('an Fn::Join part that is an Fn::If selecting the read itself', async () => {
      const { redacted } = await persist(
        resolver,
        {
          Embedded: {
            'Fn::Join': [
              '/',
              [
                { Ref: 'AWS::Region' },
                { Ref: 'AWS::AccountId' },
                { 'Fn::If': ['IsProd', WHOLE.importValue(stage), 'none'] },
              ],
            ],
          },
          Sibling: WHOLE.importValue(sibling),
        },
        { IsProd: true }
      );
      expect(redacted['Embedded']).toBe(`${REGION}/111122223333/${own}`);
      expect(redacted['Sibling']).toBe(EXPR_OF[sibling]);
    });
  });

  it('records the read\'s span under its own key, the one the association store uses', async () => {
    const secrets: RecordedSecretValues = new Map();
    const leaf = { 'Fn::Sub': '${AWS::Region}.${AWS::AccountId}/${Child.Outputs.CurrentPw}' };
    const resolved = await resolver.resolve(leaf, buildContext(secrets));
    const record = intrinsicLeafResolutionOf(secrets, leaf);
    expect(record?.output).toBe(resolved);
    expect(record?.parameterSpans).toEqual([
      {
        start: `${REGION}.111122223333/`.length,
        length: SHARED.length,
        key: crossStackSourceKey({ 'Fn::GetAtt': 'Child.Outputs.CurrentPw' }),
      },
    ]);
  });

  describe('wholeReferenceSpans', () => {
    const IMPORT = { 'Fn::ImportValue': 'Producer:CurrentPw' };

    it('spans the whole value under the raw intrinsic\'s key', () => {
      expect(wholeReferenceSpans(IMPORT, 'abc')).toEqual([
        { start: 0, length: 3, key: crossStackSourceKey(IMPORT) },
      ]);
    });

    it.each([
      ['an empty value', IMPORT, ''],
      ['a non-string value', IMPORT, ['a', 'b']],
      ['a source with no key (a non-literal attribute name)', { 'Fn::GetAtt': ['Child', { Ref: 'X' }] }, 'abc'],
    ])('places no span for %s', (_label, source, value) => {
      expect(wholeReferenceSpans(source as Record<string, unknown>, value)).toEqual([]);
    });
  });

  describe('what it will NOT certify (each falls to the value scan)', () => {
    // Hand-filled refusals: the store gets a MORE favourable entry than a
    // resolver pass would write, and the arm must still decline it.
    const KEY = crossStackSourceKey({ 'Fn::GetAtt': 'Child.Outputs.CurrentPw' })!;

    it('a placeholder the 2-arg map BINDS, even though its name spells a keyed output', () => {
      // The writer never sees `Child.Outputs.CurrentPw` here: the map's literal
      // wins, so the association under that key is about some OTHER leaf.
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, KEY, EXPR_CURRENT, SHARED);
      const source = {
        P: { 'Fn::Sub': ['x-${Child.Outputs.CurrentPw}', { 'Child.Outputs.CurrentPw': SHARED }] },
      };
      const redacted = redactSecretsForState({ P: `x-${SHARED}` }, secrets, source) as Record<
        string,
        string
      >;
      expect(redacted['P']).toBe(`x-${EXPR_PREVIOUS}`);
    });

    it('a leaf the template and the association do not reassemble', () => {
      // A readback bag holding different text than the source renders: the
      // literal frame does not match, so nothing is positioned.
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, KEY, EXPR_CURRENT, SHARED);
      const source = { P: { 'Fn::Sub': 'pre-${Child.Outputs.CurrentPw}' } };
      const redacted = redactSecretsForState({ P: `PRE-${SHARED}` }, secrets, source) as Record<
        string,
        string
      >;
      expect(redacted['P']).toBe(`PRE-${EXPR_PREVIOUS}`);
    });

    it('a bag whose embedded value is not the association’s plaintext (reassembly + condition 1)', () => {
      // Condition 2 cannot refuse in this arm: each part is certified over the
      // association's OWN plaintext, so the pairing it checks is always true.
      // What stands in for it is the reassembly test (literals + association
      // plaintexts must rebuild the bag), plus condition 1: the association's
      // plaintext must be one this pass recorded.
      const OTHER_PLAINTEXT = 'a-completely-different-secret';
      const OTHER_EXPR = '{{resolve:secretsmanager:other:SecretString:v}}';
      const secrets: RecordedSecretValues = new Map([[OTHER_PLAINTEXT, OTHER_EXPR]]);
      recordCrossStackExpression(secrets, KEY, EXPR_CURRENT, SHARED);
      const source = { P: { 'Fn::Sub': 'pre-${Child.Outputs.CurrentPw}' } };
      const redacted = redactSecretsForState(
        { P: `pre-${OTHER_PLAINTEXT}` },
        secrets,
        source
      ) as Record<string, string>;
      expect(redacted['P']).toBe(`pre-${OTHER_EXPR}`);
    });

    it('an expression THIS PASS saw resolve to another value (condition 3)', () => {
      const ELSEWHERE = 'the-other-regions-password';
      const secrets: RecordedSecretValues = new Map([
        [SHARED, EXPR_PREVIOUS],
        [ELSEWHERE, EXPR_CURRENT],
      ]);
      recordCrossStackExpression(secrets, KEY, EXPR_CURRENT, SHARED);
      const source = { P: { 'Fn::Sub': 'pre-${Child.Outputs.CurrentPw}' } };
      const redacted = redactSecretsForState({ P: `pre-${SHARED}` }, secrets, source) as Record<
        string,
        string
      >;
      expect(redacted['P']).toBe(`pre-${EXPR_PREVIOUS}`);
    });

    it('a poisoned key', () => {
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, KEY, EXPR_CURRENT, SHARED);
      recordCrossStackExpression(secrets, KEY, EXPR_PREVIOUS, SHARED);
      const source = { P: { 'Fn::Join': ['', ['pre-', { 'Fn::GetAtt': 'Child.Outputs.CurrentPw' }]] } };
      const redacted = redactSecretsForState({ P: `pre-${SHARED}` }, secrets, source) as Record<
        string,
        string
      >;
      expect(redacted['P']).toBe(`pre-${EXPR_PREVIOUS}`);
    });

    it('a recorded plaintext left in the template’s own literal text', () => {
      // The certified span becomes an expression, but the frame still holds a
      // second copy of the secret; the value scan would rewrite it, so the arm
      // refuses rather than persist the leaf half-scanned.
      const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PREVIOUS]]);
      recordCrossStackExpression(secrets, KEY, EXPR_CURRENT, SHARED);
      const source = { P: { 'Fn::Sub': `${SHARED}-\${Child.Outputs.CurrentPw}` } };
      const redacted = redactSecretsForState(
        { P: `${SHARED}-${SHARED}` },
        secrets,
        source
      ) as Record<string, string>;
      expect(redacted['P']).toBe(`${EXPR_PREVIOUS}-${EXPR_PREVIOUS}`);
    });
  });
});
