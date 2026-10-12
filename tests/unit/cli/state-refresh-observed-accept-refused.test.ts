import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptRefusedAssertion,
  collectAcceptRefused,
  judgeAcceptRefused,
  readAcceptRefusedTemplate,
  type DeployedShapeContext,
} from '../../../src/cli/commands/state-refresh-observed.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { refusedBaselineRemedy } from '../../../src/cli/commands/refused-baseline-remedy.js';

// Issue #3466: `cdkd state refresh-observed --accept-refused`. The harness is
// `state-refresh-observed.test.ts`'s (logger / config-loader / aws-clients /
// state backend / lock / registry mocks), so the command boot path runs
// without real AWS.

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
// Issue #2944: the import-refusal SUMMARY is a `logger.warn`, deliberately not a
// fourth count on the `info` summary line, so reading it needs its own spy.
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

// The region of the per-stack AWS scope the code runs in (go-to-k/cdkd#4283).
const awsScope = vi.hoisted(() => ({
  region: undefined as string | undefined,
  providerRegion: undefined as string | undefined,
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((config?: { region?: string }) => ({
    configuredRegion: config?.region,
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (clients: { configuredRegion?: string }, fn: () => unknown) => {
    const previous = awsScope.region;
    awsScope.region = clients.configuredRegion;
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        awsScope.region = previous;
      });
    }
    awsScope.region = previous;
    return result;
  },
  getAwsClients: vi.fn(),
}));

const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{ state: StackState; etag: string; migrationPending?: boolean } | null>
  >();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockSaveState =
  vi.fn<
    (
      stackName: string,
      region: string,
      state: StackState,
      options?: { expectedEtag?: string; migrateLegacy?: boolean }
    ) => Promise<string>
  >();

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
// Issue #2170: production calls `getLockInfo` to name the holder. Without it
// on the mock the call THREW, the best-effort catch swallowed it, and the
// assertion below still matched the degraded wording — so the test certified
// nothing about this change.
const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: mockGetLockInfo,
    releaseLock: mockReleaseLock,
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
const mockRegistryShouldSkip = vi.fn<(resourceType: string) => boolean>().mockReturnValue(false);
// #614: state refresh-observed now calls `getProviderFor` (legacy
// `getProvider` is still used by other state subcommands).
const mockRegistryGetProviderFor = vi
  .fn<(input: { resourceType: string }) => unknown>()
  .mockImplementation((input) => ({
    provider: mockRegistryGetProvider(input.resourceType),
    provisionedBy: 'sdk',
  }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  // Each registry remembers the AWS scope region it was CONSTRUCTED in — a
  // provider takes its clients at construction (go-to-k/cdkd#4283) — and
  // publishes it as `awsScope.providerRegion` when it hands out a provider.
  ProviderRegistry: vi.fn().mockImplementation(() => {
    const constructedIn = awsScope.region;
    return {
      getProvider: mockRegistryGetProvider,
      getProviderFor: (input: { resourceType: string }) => {
        awsScope.providerRegion = constructedIn;
        return mockRegistryGetProviderFor(input);
      },
      shouldSkipResource: mockRegistryShouldSkip,
      setCustomResourceResponseBucket: vi.fn(),
    };
  }),
}));

// Issue #2036: the per-stack `PublicSsmProver` the command builds. Faked so
// this file can pin the WIRING — which region and producer-region evidence it is
// built with, which bag it is asked about, and that the bag it returns is the
// one the redaction reads. The prover's own lookup (no-decryption
// `GetParameter`, region, error handling) runs unmocked in
// `tests/unit/deployment/public-ssm-proof.test.ts` and
// `tests/unit/cli/import-public-ssm-proof.test.ts`.
const publicSsmProof = vi.hoisted(() => ({
  proven: new Map<string, string>(),
  built: [] as Array<{
    region: string;
    loadEvidence: () => Promise<{ regions: readonly string[]; complete: boolean }>;
  }>,
  askedAbout: [] as unknown[],
}));
vi.mock('../../../src/deployment/public-ssm-proof.js', async () => {
  const { recordProvenPublicExpression } = await import(
    '../../../src/deployment/secret-redaction/mask-only.js'
  );
  return {
    PublicSsmProver: class {
      constructor(
        region: string,
        loadEvidence: () => Promise<{ regions: readonly string[]; complete: boolean }>
      ) {
        publicSsmProof.built.push({ region, loadEvidence });
      }
      async proofBagFor(source: unknown): Promise<Map<string, string>> {
        publicSsmProof.askedAbout.push(source);
        const bag = new Map<string, string>();
        for (const [token, value] of publicSsmProof.proven) {
          recordProvenPublicExpression(bag, token, value);
        }
        return bag;
      }
    },
  };
});

// The interactive answer, for the TTY arm: `undefined` keeps the real prompt
// (which refuses without a TTY), a boolean answers it.
const promptAnswer = vi.hoisted(() => ({ value: undefined as boolean | undefined, asked: [] as string[] }));
vi.mock('../../../src/cli/commands/confirm-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/commands/confirm-prompt.js')>();
  return {
    ...actual,
    confirmOrRefuse: async (prompt: string, options: Parameters<typeof actual.confirmOrRefuse>[1]) => {
      if (promptAnswer.value === undefined) return actual.confirmOrRefuse(prompt, options);
      promptAnswer.asked.push(prompt);
      return promptAnswer.value;
    },
  };
});

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

/**
 * Drive `createStateCommand()` with the refresh-observed subcommand
 * args. `--yes` is included by default so the confirmation prompt
 * doesn't block on stdin in tests.
 */
async function runRefresh(
  args: string[]
): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(['refresh-observed', '--yes', ...args], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    cap.restore();
  }
  return { output: cap.output.join(''), error };
}

/**
 * The same driver WITHOUT the injected `--yes`, so the confirmation gate at
 * the top of `stateRefreshObservedCommand` is actually reached.
 *
 * NOTE this file mocks NO readline: with issue
 * [#2275](https://github.com/go-to-k/cdkd/issues/2275)'s guard the command
 * never creates an interface, so there is nothing to stub. That is also what
 * makes the case below discriminating in the production shape — remove the
 * guard and it reaches the REAL `node:readline/promises` against vitest's
 * EOF stdin and HANGS, which is the defect itself rather than a proxy for it.
 */
async function runRefreshUnconfirmed(
  args: string[]
): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(['refresh-observed', ...args], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    cap.restore();
  }
  return { output: cap.output.join(''), error };
}

function makeResource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: overrides.physicalId ?? 'phys-id',
    resourceType: overrides.resourceType ?? 'AWS::S3::Bucket',
    properties: overrides.properties ?? {},
    ...(overrides.observedProperties && { observedProperties: overrides.observedProperties }),
    ...(overrides.attributes && { attributes: overrides.attributes }),
    ...(overrides.dependencies && { dependencies: overrides.dependencies }),
    // Schema v10 (issue #2944). Conditional like its siblings: the field must be
    // ABSENT from an unmarked record, not present-and-undefined, because the
    // reader tests `=== true` and the JSON a state file carries has no key.
    ...(overrides.observedBaselineRefused && {
      observedBaselineRefused: overrides.observedBaselineRefused,
    }),
    ...(overrides.observedBaselineRefusalReason && {
      observedBaselineRefusalReason: overrides.observedBaselineRefusalReason,
    }),
  };
}

function makeState(
  resources: Record<string, ResourceState>
): { state: StackState; etag: string; migrationPending?: boolean } {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}


const SECRET_REF = '{{resolve:secretsmanager:db-secret:SecretString:pw}}';
const PLAINTEXT = 'decrypted-3466-needle';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/fn-role';

/**
 * A template whose `Fn` reads the secret through a dynamic reference and its
 * role through `Fn::GetAtt`, and whose `Param` reads a parameter.
 */
function template(
  overrides: { fnEnv?: unknown; fnType?: string; fnExtra?: Record<string, unknown>; parameters?: unknown } = {}
): Record<string, unknown> {
  return {
    ...(overrides.parameters !== null && {
      Parameters: overrides.parameters ?? {
        DbPassword: { Type: 'String', Default: 'CHANGEME-root', NoEcho: true },
        Sizes: { Type: 'CommaDelimitedList', Default: 'small,large' },
        Stage: { Type: 'String', Default: 'dev' },
        Empty: { Type: 'String', Default: '' },
      },
    }),
    Resources: {
      Fn: {
        Type: overrides.fnType ?? 'AWS::Lambda::Function',
        Properties: {
          Handler: 'index.handler',
          Role: { 'Fn::GetAtt': ['FnRole', 'Arn'] },
          Environment: { Variables: { DB_PASSWORD: overrides.fnEnv ?? SECRET_REF } },
          ...overrides.fnExtra,
        },
      },
      FnRole: { Type: 'AWS::IAM::Role', Properties: { Path: '/' } },
      Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { Ref: 'DbPassword' } } },
    },
  };
}

function refusedFn(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'fn-phys',
    resourceType: 'AWS::Lambda::Function',
    properties: {
      Handler: 'index.handler',
      Role: ROLE_ARN,
      Environment: { Variables: { DB_PASSWORD: SECRET_REF } },
    },
    observedBaselineRefused: true,
    observedBaselineRefusalReason: 'unverifiable-parameter',
    ...overrides,
  };
}

function fnRole(): ResourceState {
  return {
    physicalId: 'fn-role',
    resourceType: 'AWS::IAM::Role',
    properties: { Path: '/' },
    attributes: { Arn: ROLE_ARN, RoleId: 'AROAEXAMPLE' },
    observedProperties: { Path: '/', RoleName: 'fn-role' },
  };
}

function stackCtx(fn: ResourceState = refusedFn()): DeployedShapeContext {
  return { stackName: 'TestStack', region: 'us-east-1', resources: { Fn: fn, FnRole: fnRole() } };
}

const judge = (record: ResourceState | undefined, id: string, t: Record<string, unknown>) =>
  judgeAcceptRefused(record, id, t, stackCtx(record));

const reasonOf = (v: ReturnType<typeof judgeAcceptRefused>): string => (v.ok ? '' : v.reason);

describe('judgeAcceptRefused (issue #3466)', () => {
  it('accepts an unverifiable-parameter refusal once the record proves the template is deployed', () => {
    expect(judge(refusedFn(), 'Fn', template())).toEqual({ ok: true, legacy: false });
  });

  it('accepts a REASON-LESS legacy marker, flagged as legacy for the prompt', () => {
    const record = refusedFn();
    delete record.observedBaselineRefusalReason;
    expect(judge(record, 'Fn', template())).toEqual({ ok: true, legacy: true });
    // A reason a later cdkd invented reads the same way: fail closed to the parameter class.
    const future = { ...refusedFn(), observedBaselineRefusalReason: 'later-reason' } as unknown as ResourceState;
    expect(judge(future, 'Fn', template())).toEqual({ ok: true, legacy: true });
  });

  it('refuses an incomplete-resolution refusal (a changing deploy clears that class)', () => {
    const v = judge(refusedFn({ observedBaselineRefusalReason: 'incomplete-resolution' }), 'Fn', template());
    expect(reasonOf(v)).toMatch(/not over a template parameter/);
  });

  it('refuses a record with no refusal, and a logical id the record lacks', () => {
    const unmarked = refusedFn();
    delete unmarked.observedBaselineRefused;
    delete unmarked.observedBaselineRefusalReason;
    expect(reasonOf(judge(unmarked, 'Fn', template()))).toMatch(/nothing to accept/);
    expect(reasonOf(judge(undefined, 'Fn', template()))).toMatch(/has no resource Fn/);
  });

  it('refuses while the template still makes the resource read a parameter (directly)', () => {
    const record = refusedFn({
      resourceType: 'AWS::SSM::Parameter',
      properties: { Type: 'String', Value: 'x' },
    });
    const reason = reasonOf(judge(record, 'Param', template()));
    expect(reason).toMatch(/still depends on a template parameter/);
    expect(reason).not.toContain('CHANGEME-root');
  });

  it('refuses a resource that reads a parameter-tainted resource attribute (Fn::GetAtt)', () => {
    const t = template({ fnEnv: { 'Fn::GetAtt': ['Param', 'Value'] } });
    expect(reasonOf(judge(refusedFn(), 'Fn', t))).toMatch(/still depends on a template parameter/);
  });

  it('refuses when the template lacks the resource, names another type, or cannot be read', () => {
    expect(reasonOf(judge(refusedFn(), 'Fn', { Resources: {} }))).toMatch(/defines no resource Fn/);
    expect(reasonOf(judge(refusedFn(), 'Fn', template({ fnType: 'AWS::SQS::Queue' })))).toMatch(
      /not the resource type/
    );
    expect(reasonOf(judge(refusedFn(), 'Fn', { Resources: 'nope' }))).toMatch(
      /could not be judged \(unreadable-template\)/
    );
    // An inherited member is not a resource definition.
    expect(reasonOf(judge(refusedFn(), 'toString', template()))).toMatch(/defines no resource toString/);
  });

  describe('the record must PROVE the template is the deployed shape (security review B1)', () => {
    const shapeRefusal = /does not hold what this template defines for it/;
    const unprovable = /with a function cdkd cannot work out from the state records/;

    it('refuses an edited, UNDEPLOYED template: parameter deleted, reference added, record still the placeholder', () => {
      // The template reads no parameter and declares none, so neither the
      // dependence check nor the Default check has anything to find.
      const record = refusedFn({
        properties: {
          Handler: 'index.handler',
          Role: ROLE_ARN,
          Environment: { Variables: { DB_PASSWORD: 'placeholder' } },
        },
      });
      const v = judge(record, 'Fn', template({ parameters: null }));
      expect(reasonOf(v)).toMatch(shapeRefusal);
      expect(reasonOf(v)).not.toContain('placeholder');
    });

    it('refuses a literal that differs, a key the template lacks or adds, and a list of another length', () => {
      const base = refusedFn().properties;
      expect(reasonOf(judge(refusedFn({ properties: { ...base, Handler: 'other.handler' } }), 'Fn', template()))).toMatch(
        shapeRefusal
      );
      expect(reasonOf(judge(refusedFn({ properties: { ...base, Timeout: 3 } }), 'Fn', template()))).toMatch(
        shapeRefusal
      );
      const { Handler: _h, ...withoutHandler } = base;
      expect(reasonOf(judge(refusedFn({ properties: withoutHandler }), 'Fn', template()))).toMatch(shapeRefusal);
      const t = template({ fnExtra: { Layers: ['a', 'b'] } });
      expect(reasonOf(judge(refusedFn({ properties: { ...base, Layers: ['a'] } }), 'Fn', t))).toMatch(shapeRefusal);
      expect(judge(refusedFn({ properties: { ...base, Layers: ['a', 'b'] } }), 'Fn', t).ok).toBe(true);
    });

    it('refuses a number recorded where the template spells a string, and the reverse', () => {
      const base = refusedFn().properties;
      const t = template({ fnExtra: { MemorySize: 128 } });
      expect(judge(refusedFn({ properties: { ...base, MemorySize: 128 } }), 'Fn', t).ok).toBe(true);
      expect(judge(refusedFn({ properties: { ...base, MemorySize: '128' } }), 'Fn', t).ok).toBe(false);
      const t2 = template({ fnExtra: { MemorySize: '128' } });
      expect(judge(refusedFn({ properties: { ...base, MemorySize: '128' } }), 'Fn', t2).ok).toBe(true);
      expect(judge(refusedFn({ properties: { ...base, MemorySize: 128 } }), 'Fn', t2).ok).toBe(false);
    });

    it('a deploy-fixable difference names the deploy; a fewer-properties record names replacement too', () => {
      const reason = reasonOf(judge(refusedFn({ properties: { ...refusedFn().properties, Handler: 'x' } }), 'Fn', template()));
      expect(reason).toMatch(/deploy this one and run this again/);
      expect(reason).toMatch(/fewer properties than the template sets/);
    });

    it('evaluates Ref, Fn::GetAtt (both forms), Fn::Join, Fn::Sub and Fn::Select against the stack records', () => {
      const base = refusedFn().properties;
      const t = template({
        fnExtra: {
          Description: {
            'Fn::Join': [
              ':',
              [
                'arn',
                { Ref: 'AWS::Partition' },
                { Ref: 'AWS::Region' },
                { Ref: 'AWS::AccountId' },
                { Ref: 'FnRole' },
                { 'Fn::Select': [1, ['x', { 'Fn::GetAtt': 'FnRole.RoleId' }]] },
              ],
            ],
          },
          KmsKeyArn: { 'Fn::Sub': ['${A}.${AWS::URLSuffix}/${FnRole.Arn}/${!Literal}', { A: 'host' }] },
        },
      });
      const good = {
        ...base,
        Description: 'arn:aws:us-east-1:123456789012:fn-role:AROAEXAMPLE',
        KmsKeyArn: `host.amazonaws.com/${ROLE_ARN}/\${Literal}`,
      };
      expect(judge(refusedFn({ properties: good }), 'Fn', t)).toEqual({ ok: true, legacy: false });
      // The account slot is twelve digits, nothing else.
      const badAccount = { ...good, Description: 'arn:aws:us-east-1:12345:fn-role:AROAEXAMPLE' };
      expect(judge(refusedFn({ properties: badAccount }), 'Fn', t).ok).toBe(false);
      // The whole recorded value must match: nothing before or after it.
      const prefixed = { ...good, Description: `X${good.Description}` };
      expect(judge(refusedFn({ properties: prefixed }), 'Fn', t).ok).toBe(false);
      const suffixed = { ...good, KmsKeyArn: `${good.KmsKeyArn}X` };
      expect(judge(refusedFn({ properties: suffixed }), 'Fn', t).ok).toBe(false);
      // A regex metacharacter in an evaluated value is literal.
      const t2 = template({ fnExtra: { Description: { 'Fn::Join': ['', ['a.b', { Ref: 'AWS::Region' }]] } } });
      expect(judge(refusedFn({ properties: { ...base, Description: 'aXbus-east-1' } }), 'Fn', t2).ok).toBe(false);
      expect(judge(refusedFn({ properties: { ...base, Description: 'a.bus-east-1' } }), 'Fn', t2).ok).toBe(true);
    });

    it('evaluates the forms CDK also emits: string Fn::Sub, string Select index, AWS::StackName', () => {
      const base = refusedFn().properties;
      const t = template({
        fnExtra: {
          Description: { 'Fn::Sub': '${AWS::StackName}-${FnRole}' },
          KmsKeyArn: { 'Fn::Select': ['0', [{ Ref: 'FnRole' }]] },
        },
      });
      const good = { ...base, Description: 'TestStack-fn-role', KmsKeyArn: 'fn-role' };
      expect(judge(refusedFn({ properties: good }), 'Fn', t).ok).toBe(true);
      for (const value of [
        { 'Fn::Select': [1, ['only']] },
        { 'Fn::Select': ['x', ['only']] },
        { 'Fn::GetAtt': 'FnRoleArn' },
      ]) {
        const bad = template({ fnExtra: { Description: value } });
        expect(reasonOf(judge(refusedFn({ properties: { ...base, Description: 'only' } }), 'Fn', bad))).toMatch(
          unprovable
        );
      }
    });

    it('refuses an intrinsic it cannot evaluate, and a Ref or attribute the stack records do not hold', () => {
      const base = refusedFn().properties;
      const reasonFor = (value: unknown) =>
        reasonOf(judge(refusedFn({ properties: { ...base, Description: 'x' } }), 'Fn', template({ fnExtra: { Description: value } })));
      expect(reasonFor({ 'Fn::ImportValue': 'Other-Export' })).toMatch(unprovable);
      // An `Fn::If` names a condition, which the dependence walk cannot clear, so it refuses first.
      expect(reasonFor({ 'Fn::If': ['Cond', 'a', 'b'] })).toMatch(/still depends on a template parameter/);
      // A Ref or attribute the stack does not record YET is a difference a
      // deploy may remove, so it names the deploy, not replacement.
      for (const value of [
        { Ref: 'Missing' },
        { 'Fn::GetAtt': ['FnRole', 'Missing'] },
        { 'Fn::Join': ['', ['a', { Ref: 'Missing' }]] },
        { 'Fn::Sub': '${Missing.Arn}' },
      ]) {
        const reason = reasonFor(value);
        expect(reason).toMatch(shapeRefusal);
        expect(reason).toMatch(/deploy this one and run this again/);
      }
      // A record with no attributes bag, and a Select picking a missing reference.
      const bare = judgeAcceptRefused(
        refusedFn({ properties: { ...base, Description: 'x' } }),
        'Fn',
        template({ fnExtra: { Description: { 'Fn::GetAtt': ['FnRole', 'Arn'] } } }),
        { stackName: 'TestStack', region: 'us-east-1', resources: { FnRole: { ...fnRole(), attributes: undefined } } }
      );
      expect(reasonOf(bare)).toMatch(shapeRefusal);
      expect(reasonFor({ 'Fn::Select': [0, [{ Ref: 'Missing' }]] })).toMatch(shapeRefusal);
      // An unevaluable function beside a missing reference is still unprovable.
      expect(reasonFor({ 'Fn::Join': ['', [{ Ref: 'Missing' }, { 'Fn::GetAZs': '' }]] })).toMatch(unprovable);
      for (const value of [{ Ref: 'AWS::StackId' }, { 'Fn::GetAZs': '' }]) {
        const t = template({ fnExtra: { Description: value } });
        const reason = reasonOf(judge(refusedFn({ properties: { ...base, Description: 'x' } }), 'Fn', t));
        expect(reason).toMatch(unprovable);
        expect(reason).toMatch(/replacing the resource clears the refusal/);
      }
      // Both at once: the unprovable remedy wins, since a deploy cannot help it.
      const both = template({ fnExtra: { Description: { 'Fn::GetAZs': '' } } });
      expect(
        reasonOf(judge(refusedFn({ properties: { ...base, Handler: 'other', Description: 'x' } }), 'Fn', both))
      ).toMatch(unprovable);
    });
  });

  describe('a recorded placeholder Default is refused (maintainer decision)', () => {
    // The template here spells the same literal, so the shape proof passes and
    // the Default check is the one that answers.
    const withDescription = (description: unknown, recorded: unknown) =>
      judge(
        refusedFn({ properties: { ...refusedFn().properties, Description: recorded } }),
        'Fn',
        template({ fnExtra: { Description: description } })
      );

    it('refuses a leaf equal to a declared Default, and names exits for a coincidence', () => {
      const reason = reasonOf(withDescription('CHANGEME-root', 'CHANGEME-root'));
      expect(reason).toMatch(/holds the Default of the template parameter DbPassword/);
      expect(reason).toMatch(/only coincides with that Default/);
      expect(reason).not.toContain('CHANGEME-root');
    });

    it('refuses a Default of 4+ characters embedded in a longer leaf, but not a shorter one', () => {
      expect(reasonOf(withDescription('prefix-CHANGEME-root', 'prefix-CHANGEME-root'))).toMatch(/DbPassword/);
      expect(withDescription('devops', 'devops').ok).toBe(true);
      expect(reasonOf(withDescription('dev', 'dev'))).toMatch(/parameter Stage/);
    });

    it('finds a list-typed item and a number, and ignores an empty Default', () => {
      expect(reasonOf(withDescription('large', 'large'))).toMatch(/parameter Sizes/);
      const t = template({
        fnExtra: { MemorySize: 256 },
        parameters: { Mem: { Type: 'Number', Default: 256 } },
      });
      const numeric = refusedFn({ properties: { ...refusedFn().properties, MemorySize: 256 } });
      expect(judge(numeric, 'Fn', t).ok).toBe(false);
      expect(withDescription('', '').ok).toBe(true);
    });
  });
});

describe('acceptRefusedAssertion (issue #3466)', () => {
  it('states what is asserted, and the legacy reading for a reason-less marker', () => {
    const text = acceptRefusedAssertion('Fn', 'AWS::Lambda::Function', 'TestStack (us-east-1)', false);
    expect(text).toContain('you assert that this template is deployed');
    expect(text).toContain(
      'AWS holds NO secret at any position of this resource that the template does not spell as a dynamic reference'
    );
    expect(text).toContain('written to state.json');
    expect(text).toContain('A deploy does not resend a value the record already holds');
    expect(text).not.toContain('without a reason');
    expect(acceptRefusedAssertion('Fn', 'T', 'S', true)).toContain('recorded without a reason this cdkd recognizes');
  });

  it('renders a hostile logical id through displayIdent', () => {
    expect(acceptRefusedAssertion('Fn\nMigrate with: rm -rf', 'T', 'S', false)).not.toContain('\nMigrate with');
  });
});

describe('--accept-refused option and template reader (issue #3466)', () => {
  it('collectAcceptRefused refuses an empty id and collects the rest', () => {
    expect(() => collectAcceptRefused('', undefined)).toThrow(/takes one logical id/);
    expect(collectAcceptRefused('B', ['A'])).toEqual(['A', 'B']);
  });

  it('reads JSON and YAML, and refuses a missing file, unparsable text and a non-object without echoing either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3466-read-'));
    try {
      const yaml = join(dir, 't.yaml');
      writeFileSync(yaml, 'Resources:\n  Fn:\n    Type: AWS::Lambda::Function\n');
      expect(readAcceptRefusedTemplate(yaml)).toEqual({ Resources: { Fn: { Type: 'AWS::Lambda::Function' } } });
      expect(() => readAcceptRefusedTemplate(join(dir, 'missing-secret-name.json'))).toThrow(/: ENOENT$/);
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{ "Resources": "CHANGEME-root" ');
      expect(() => readAcceptRefusedTemplate(bad)).toThrow(/is not a valid CloudFormation template/);
      try {
        readAcceptRefusedTemplate(bad);
      } catch (e) {
        expect(String(e)).not.toContain('CHANGEME-root');
      }
      const list = join(dir, 'list.json');
      writeFileSync(list, '[1, 2]');
      expect(() => readAcceptRefusedTemplate(list)).toThrow(/is not a valid CloudFormation template/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('refusedBaselineRemedy names the --accept-refused exit (issue #3466)', () => {
  it('for an unverifiable-parameter and a reason-less refusal, not for incomplete-resolution', () => {
    expect(refusedBaselineRemedy(refusedFn())).toContain('--accept-refused');
    expect(refusedBaselineRemedy({ observedBaselineRefused: true })).toContain('--accept-refused');
    expect(
      refusedBaselineRemedy({ observedBaselineRefused: true, observedBaselineRefusalReason: 'incomplete-resolution' })
    ).toBeUndefined();
  });
});

describe('cdkd state refresh-observed --accept-refused (issue #3466)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;
  let templatePath: string;
  const isTTY = process.stdin.isTTY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-3466-'));
    templatePath = join(dir, 'TestStack.template.json');
    writeFileSync(templatePath, JSON.stringify(template()));
    mockGetState.mockReset();
    mockListStacks.mockReset().mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    errorSpy.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    promptAnswer.value = undefined;
    promptAnswer.asked = [];
    // Every case runs without a terminal unless it says otherwise, so a
    // prompt that should not be reached refuses instead of waiting on stdin.
    process.stdin.isTTY = false as never;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.stdin.isTTY = isTTY;
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** The refused `Fn`, a second refused record, and an UNREFUSED role the run must not touch. */
  function stackWithRefusedFn(fn: ResourceState = refusedFn()) {
    return makeState({
      Fn: fn,
      FnRole: fnRole(),
      Param: makeResource({
        physicalId: 'param-phys',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: 'CHANGEME-root' },
        observedBaselineRefused: true,
        observedBaselineRefusalReason: 'unverifiable-parameter',
      }),
    });
  }

  const errors = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const infos = (): string => infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const warns = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** A provider whose readback answers `fn-phys` with the plaintext, recording every physical id read. */
  function plaintextReadback(): string[] {
    const readFor: string[] = [];
    mockRegistryGetProvider.mockImplementation(() => ({
      readCurrentState: async (physicalId: string) => {
        readFor.push(physicalId);
        return physicalId === 'fn-phys'
          ? { Handler: 'index.handler', Role: ROLE_ARN, Environment: { Variables: { DB_PASSWORD: PLAINTEXT } } }
          : { Path: '/', RoleName: 'CHANGED-BY-A-READ' };
      },
    }));
    return readFor;
  }

  function expectAccepted(): StackState {
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]?.[2] as StackState;
    const fn = saved.resources['Fn']!;
    expect('observedBaselineRefused' in fn).toBe(false);
    expect('observedBaselineRefusalReason' in fn).toBe(false);
    // Positioned against the recorded reference: the plaintext AWS echoed is not stored.
    expect(fn.observedProperties).toEqual({
      Handler: 'index.handler',
      Role: ROLE_ARN,
      Environment: { Variables: { DB_PASSWORD: SECRET_REF } },
    });
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
    return saved;
  }

  it('clears BOTH fields and captures a redacted baseline for the named resource ONLY', async () => {
    // `AWS::StackName` in the template pins the stack name the command hands the gate.
    writeFileSync(
      templatePath,
      JSON.stringify(template({ fnExtra: { Description: { 'Fn::Sub': '${AWS::StackName}-fn' } } }))
    );
    mockGetState.mockResolvedValueOnce(
      stackWithRefusedFn(refusedFn({ properties: { ...refusedFn().properties, Description: 'TestStack-fn' } }))
    );
    const readFor = plaintextReadback();

    const { error } = await runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeUndefined();
    // The unrefused role is neither read nor rewritten (test review G1).
    expect(readFor).toEqual(['fn-phys']);
    const saved = expectAccepted();
    expect(saved.resources['FnRole']?.observedProperties).toEqual({ Path: '/', RoleName: 'fn-role' });
    // The other refused record is untouched.
    expect(saved.resources['Param']?.observedBaselineRefused).toBe(true);
    expect(saved.resources['Param']?.observedBaselineRefusalReason).toBe('unverifiable-parameter');
    // Under --yes the assertion is logged, not asked.
    expect(warns()).toContain('By accepting you assert that this template is deployed');
    expect(warns()).toContain('(asserted with --yes)');
    expect(infos()).toContain('Accepted: the observed-baseline refusal on Fn was cleared');
  });

  it('accepts a reason-less legacy marker, naming the legacy reading in the assertion', async () => {
    const fn = refusedFn();
    delete fn.observedBaselineRefusalReason;
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn(fn));
    plaintextReadback();
    const { error } = await runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeUndefined();
    expectAccepted();
    expect(warns()).toContain('recorded without a reason');
  });

  it('asks on a terminal: "yes" writes, the assertion is the question', async () => {
    process.stdin.isTTY = true as never;
    promptAnswer.value = true;
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    plaintextReadback();
    const { error } = await runRefreshUnconfirmed(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeUndefined();
    expect(promptAnswer.asked).toHaveLength(1);
    expect(promptAnswer.asked[0]).toContain('By accepting you assert that this template is deployed');
    expectAccepted();
  });

  it('asks on a terminal: "no" reads, locks and writes nothing', async () => {
    process.stdin.isTTY = true as never;
    promptAnswer.value = false;
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    const readFor = plaintextReadback();
    const { error } = await runRefreshUnconfirmed(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeUndefined();
    expect(promptAnswer.asked).toHaveLength(1);
    expect(infos()).toContain('Aborted.');
    expect(readFor).toEqual([]);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('without --yes, a non-interactive run is refused before the lock', async () => {
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    const readFor = plaintextReadback();
    const { error } = await runRefreshUnconfirmed(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeDefined();
    expect(errors()).toMatch(/--accept-refused confirmation prompt cannot run in a non-interactive/);
    expect(readFor).toEqual([]);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('refuses a record the template still binds to a parameter: no lock, no read, no save', async () => {
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    const readFor = plaintextReadback();
    const { error } = await runRefresh(['TestStack', '--accept-refused', 'Param', '--template', templatePath]);
    expect(error).toBeDefined();
    expect(errors()).toMatch(/still depends on a template parameter/);
    expect(readFor).toEqual([]);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('refuses an undeployed template whose reference the record does not hold (security review B1)', async () => {
    writeFileSync(templatePath, JSON.stringify(template({ parameters: null })));
    mockGetState.mockResolvedValueOnce(
      stackWithRefusedFn(
        refusedFn({
          properties: { Handler: 'index.handler', Role: ROLE_ARN, Environment: { Variables: { DB_PASSWORD: 'placeholder' } } },
        })
      )
    );
    const readFor = plaintextReadback();
    const { error } = await runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeDefined();
    expect(errors()).toMatch(/cannot prove the template was deployed/);
    expect(readFor).toEqual([]);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('keeps BOTH fields and writes nothing when the readback fails (exit 2)', async () => {
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    const read = vi.fn(async (_physicalId: string) => {
      throw new Error('AccessDenied');
    });
    mockRegistryGetProvider.mockImplementation(() => ({ readCurrentState: read }));
    const { error } = await runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeDefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toBe('fn-phys');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('keeps BOTH fields and writes nothing when AWS reports the resource gone (exit 2)', async () => {
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    mockRegistryGetProvider.mockImplementation(() => ({ readCurrentState: async () => RESOURCE_NOT_FOUND }));
    const { error } = await runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('keeps the refusal and says so when the type has no read path, in the run and in the plan', async () => {
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    mockRegistryGetProvider.mockImplementation(() => ({}));
    const { error } = await runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]);
    expect(error).toBeDefined();
    expect(errors()).toMatch(/cannot read Fn back from AWS.*refusal stands/);
    expect(mockSaveState).not.toHaveBeenCalled();

    errorSpy.mockReset();
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    const plan = await runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath, '--dry-run']);
    expect(plan.error).toBeDefined();
    expect(errors()).toMatch(/cannot read Fn back from AWS.*refusal stands/);
  });

  it('--dry-run runs the gate, refuses as the run does, and writes nothing', async () => {
    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    plaintextReadback();
    const ok = await runRefreshUnconfirmed(['TestStack', '--accept-refused', 'Fn', '--template', templatePath, '--dry-run']);
    expect(ok.error).toBeUndefined();
    expect(infos()).toMatch(/1 resource\(s\) would be refreshed/);

    mockGetState.mockResolvedValueOnce(stackWithRefusedFn());
    const refused = await runRefreshUnconfirmed([
      'TestStack',
      '--accept-refused',
      'Param',
      '--template',
      templatePath,
      '--dry-run',
    ]);
    expect(refused.error).toBeDefined();
    expect(errors()).toMatch(/still depends on a template parameter/);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  async function expectRefusedBeforeState(run: Promise<{ error: unknown }>, message: RegExp) {
    const { error } = await run;
    expect(error).toBeDefined();
    expect(errors()).toMatch(message);
    expect(mockGetState).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  }

  it('refuses --all', async () => {
    await expectRefusedBeforeState(
      runRefresh(['--all', '--accept-refused', 'Fn', '--template', templatePath]),
      /one resource of ONE stack/
    );
  });

  it('refuses more than one stack', async () => {
    await expectRefusedBeforeState(
      runRefresh(['A', 'B', '--accept-refused', 'Fn', '--template', templatePath]),
      /one resource of ONE stack/
    );
  });

  it('refuses a second logical id rather than letting the last one win', async () => {
    await expectRefusedBeforeState(
      runRefresh(['TestStack', '--accept-refused', 'Fn', '--accept-refused', 'Param', '--template', templatePath]),
      /exactly one logical id/
    );
  });

  it('requires --template', async () => {
    await expectRefusedBeforeState(runRefresh(['TestStack', '--accept-refused', 'Fn']), /requires --template/);
  });

  it('refuses --template without --accept-refused', async () => {
    await expectRefusedBeforeState(
      runRefresh(['TestStack', '--template', templatePath]),
      /--template is used only with --accept-refused/
    );
  });

  it('refuses an unreadable --template file without echoing the parser message', async () => {
    writeFileSync(templatePath, '{ "Resources": { "Fn": "CHANGEME-root" ');
    await expectRefusedBeforeState(
      runRefresh(['TestStack', '--accept-refused', 'Fn', '--template', templatePath]),
      /is not a valid CloudFormation template/
    );
    expect(errors()).not.toContain('CHANGEME-root');
  });
});
