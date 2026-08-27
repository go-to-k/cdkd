import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
// Type-only import — erased at runtime, so it does NOT trigger the
// `vi.mock('../../../src/cli/commands/retire-cfn-stack.js', ...)` factory
// below. Re-typing the hoisted `mockGetCfnResourceTree` spy against the
// real `CfnStackResourceTree` interface keeps the mock and source in
// sync — drift between the mocked tree shape and the real interface
// would otherwise surface as a runtime crash only when a test exercises
// a yet-unmocked field.
import type { CfnStackResourceTree } from '../../../src/cli/commands/retire-cfn-stack.js';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
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
  resolveApp: vi.fn(() => 'cdk-out'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

// Issue #1002 PR 2 — the import command consults the asset-redirect resolver
// right after stack selection. Most tests use fixture stacks with no asset
// manifest, so the default resolver reports "no redirect"; the rewrite-wiring
// test overrides it with a real §6 mapping table (rewriteTemplateAssetReferences
// stays REAL via the importOriginal spread).
const { mockCreateAssetRedirectResolver } = vi.hoisted(() => ({
  mockCreateAssetRedirectResolver: vi.fn(() => async (): Promise<unknown> => undefined),
}));
vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  createAssetRedirectResolver: mockCreateAssetRedirectResolver,
}));

// Mock AWS clients. The `sts` field is needed by
// IntrinsicFunctionResolver.getAccountInfo (run during the
// post-import property resolution pass for issue #328) — without it
// the resolver throws on the first `Fn::GetAtt` that needs an ARN
// constructed from accountId/region/partition (e.g. Lambda Permission's
// FunctionName). `getAwsClients` returns the same shape `AwsClients`
// produces.
const stsSend = vi.hoisted(() =>
  vi.fn(async () => ({ Account: '123456789012' }))
);
// SecretsManager send for the import-time property resolution pass — a
// `{{resolve:secretsmanager:...}}` in an imported resource's Properties fetches
// through here. Defaults to a benign value; the redaction test overrides it.
const smSend = vi.hoisted(() => vi.fn(async () => ({ SecretString: 'unused-default' })));
// SSM send for `resolveParameters`' `AWS::SSM::Parameter::Value<...>` default
// lookup (issue #2321's retry re-enters that method, so the SSM arm is live on
// the import path). `clientsForRegion` returns this ambient double unchanged —
// it has no `withRegion`, which that method's first reuse arm handles — so an
// absent `ssm` key would surface as a TypeError rather than as the
// `GetParameter` rejection production actually raises. Defaults to resolving;
// the fallback-arm case overrides it to reject.
const ssmSend = vi.hoisted(() =>
  vi.fn(async () => ({ Parameter: { Value: 'ssm-resolved-value' } }))
);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return {};
    },
    get sts() {
      return { send: stsSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({
    sts: { send: stsSend },
    secretsManager: { send: smSend },
    ssm: { send: ssmSend },
  })),
}));

const mockRetireCloudFormationStack = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ outcome: string }>>()
);
// Mock for the recursive tree walker added in PR for issue #464. Typed
// directly against the real `CfnStackResourceTree` interface (imported
// type-only above) so any drift between the source shape and what tests
// stub here is caught at compile time. Every test that doesn't exercise
// nested-stack rows can rely on the default empty-tree return wired up
// in `beforeEach` below (the import.ts dispatch loop only fires
// nested-stack short-circuit logic when `tree.nested.size > 0`, so an
// empty Map keeps the existing test surface unchanged).
const mockGetCfnResourceTree = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<CfnStackResourceTree>>()
);
// Auto mode consults CloudFormation before the per-provider lookups (#1128).
// Defaults to `null` ("no CFn stack of that name") in `beforeEach`, which is
// the shape every pre-#1128 test was implicitly written against.
const mockTryGetCfnResourceMap = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Map<string, string> | null>>()
);
vi.mock('../../../src/cli/commands/retire-cfn-stack.js', async () => {
  // Pull the real module's `NESTED_STACK_RESOURCE_TYPE` constant via
  // `vi.importActual` so the test mock can't silently drift from the
  // production value — any change to the constant in retire-cfn-stack.ts
  // is automatically reflected here.
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/retire-cfn-stack.js')>(
    '../../../src/cli/commands/retire-cfn-stack.js'
  );
  return {
    retireCloudFormationStack: mockRetireCloudFormationStack,
    getCloudFormationResourceTree: mockGetCfnResourceTree,
    tryGetCloudFormationResourceMap: mockTryGetCfnResourceMap,
    NESTED_STACK_RESOURCE_TYPE: actual.NESTED_STACK_RESOURCE_TYPE,
  };
});

const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockGetState = vi.fn<
  (
    s: string,
    r: string
  ) => Promise<{ state: unknown; etag: string; migrationPending?: boolean } | null>
>();
const mockSaveState = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mockVerifyBucketExists,
    getState: mockGetState,
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

const mockSynthesize = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// Provider registry: hoisted spies so each test can configure has/get + provider.import.
const mockHasProvider = vi.hoisted(() => vi.fn<(t: string) => boolean>());
const mockGetProvider = vi.hoisted(() => vi.fn<(t: string) => unknown>());
// #614: import.ts now consults `getProviderFor` for the observed-properties
// capture path (legacy `getProvider` is still used for `provider.import()`).
// Wrap the existing get-by-type mock so test fixtures stay declarative.
const mockGetProviderFor = vi.hoisted(() =>
  vi.fn<(input: { resourceType: string }) => unknown>()
);
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    hasProvider: mockHasProvider,
    getProvider: mockGetProvider,
    getProviderFor: mockGetProviderFor,
  })),
}));

// readline confirmation prompt — scriptable via readlineQuestion.mockResolvedValue.
const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createImportCommand } from '../../../src/cli/commands/import.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

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

async function runImport(args: string[]): Promise<string> {
  // When parseAsync is called directly on the import command (vs through the
  // parent program), the leading 'import' would be treated as the [stack]
  // positional arg. Drop it so the test args read naturally as the user
  // would type them.
  const realArgs = args[0] === 'import' ? args.slice(1) : args;
  const cap = captureStdout();
  try {
    const cmd = createImportCommand();
    cmd.exitOverride();
    await cmd.parseAsync(realArgs, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

function template(resources: CloudFormationTemplate['Resources']): CloudFormationTemplate {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: resources,
  };
}

function stackInfo(name: string, tmpl: CloudFormationTemplate, region = 'us-east-1') {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: tmpl,
    dependencyNames: [],
    region,
  };
}

describe('cdkd import', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    mockGetState.mockReset();
    mockGetState.mockResolvedValue(null);
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue('"new-etag"');
    mockAcquireLock.mockReset();
    mockAcquireLock.mockResolvedValue(true);
    mockReleaseLock.mockReset();
    mockReleaseLock.mockResolvedValue();
    mockSynthesize.mockReset();
    mockHasProvider.mockReset();
    mockGetProvider.mockReset();
    mockGetProviderFor.mockReset();
    // Default routing for the #614 observed-properties pass: every
    // resource type proxies through the test's `mockGetProvider` mock and
    // is recorded as SDK-managed (matches every test's expectation).
    mockGetProviderFor.mockImplementation(({ resourceType }: { resourceType: string }) => ({
      provider: mockGetProvider(resourceType),
      provisionedBy: 'sdk',
    }));
    readlineQuestion.mockReset();
    readlineClose.mockReset();
    mockRetireCloudFormationStack.mockReset();
    mockRetireCloudFormationStack.mockResolvedValue({ outcome: 'retired' });
    mockGetCfnResourceTree.mockReset();
    mockGetCfnResourceTree.mockResolvedValue({
      stackName: 'S',
      physicalId: 'S',
      resources: new Map(),
      nested: new Map(),
    });
    // Default: no CloudFormation stack of that name, so auto mode falls
    // straight through to the per-provider lookups — the behavior every
    // pre-#1128 test in this file was written against.
    mockTryGetCfnResourceMap.mockReset();
    mockTryGetCfnResourceMap.mockResolvedValue(null);
    errorSpy.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    stsSend.mockClear();
    // Restored EXPLICITLY rather than left to `mockClear`: the fallback-arm
    // case replaces the implementation with a rejection, and `mockClear` keeps
    // implementations (only `mockReset` drops them, which would leave a bare
    // `vi.fn()` returning `undefined` and break the readback below).
    ssmSend.mockReset();
    ssmSend.mockImplementation(async () => ({ Parameter: { Value: 'ssm-resolved-value' } }));
    // Reset the IntrinsicFunctionResolver's cached account info so each
    // test starts from a clean slate (otherwise the cache survives
    // across tests and a later test's region override wouldn't reset).
    resetAccountInfoCache();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('rejects when CDK app is not configured', async () => {
    // Override resolveApp to return undefined (no cdk.json).
    const cl = await import('../../../src/cli/config-loader.js');
    (cl.resolveApp as unknown as { mockReturnValueOnce: (v: undefined) => void }).mockReturnValueOnce(undefined);

    await expect(runImport(['import'])).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/requires a CDK app/);
  });

  // Issue #2161: `acquireLock` reports contention by RESOLVING false (not
  // throwing). Import must refuse rather than write state under the foreign
  // lock and then release it. Fences the `!acquired` check.
  it('refuses when the lock is held (acquireLock resolves false)', async () => {
    const cdkBucket = 'cdk-hnb659fds-assets-111111111111-us-east-1';
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: { BucketName: 'b', DataUrl: `s3://${cdkBucket}/k.zip` },
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockImplementation(() => ({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    }));
    mockAcquireLock.mockResolvedValue(false);
    mockGetLockInfo.mockResolvedValue({
      owner: 'other@host:1',
      operation: 'deploy',
      expiresAt: Date.now() + 600_000,
    });

    await expect(runImport(['import', '--app', 'x', '--yes'])).rejects.toThrow();
    // The LOCK error surfaced (not some other abort).
    const importMsg = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(importMsg).toMatch(/Could not acquire lock/);
    // The holder is NAMED and the command is QUALIFIED (issue #2170) -- the
    // bare `/Could not acquire lock/` above was true before this change too.
    expect(importMsg).toContain('held by other@host:1');
    // `--state-bucket` is what `recovery` supplies; `--stack-region` does NOT,
    // so asserting only the region left `recovery: {...}` droppable — the
    // probe for that came back green until this line named the bucket.
    expect(importMsg).toMatch(/cdkd force-unlock \S+ --stack-region \S+ --state-bucket test-bucket/);
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('rejects auto-mode import when state already exists without --force', async () => {
    const tmpl = template({
      MyBucket: { Type: 'AWS::S3::Bucket', Properties: {}, Metadata: { 'aws:cdk:path': 'S/MyBucket' } },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockGetState.mockResolvedValueOnce({
      state: {
        version: 2,
        stackName: 'S',
        region: 'us-east-1',
        resources: {},
        outputs: {},
        lastModified: 0,
      },
      etag: '"existing-etag"',
    });

    // No --resource overrides → auto / whole-stack mode → destructive →
    // --force required.
    await expect(runImport(['import', '--app', 'x'])).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/State already exists.*--force/);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/--resource <id>=<physicalId>/);
  });

  it('records the PRE-rewrite asset references in state while still rewriting the template (#1652)', async () => {
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    const cdkBucket = 'cdk-hnb659fds-assets-111111111111-us-east-1';
    const cdkdBucket = 'cdkd-assets-111111111111-us-east-1';
    const map = buildAssetRedirectMap(
      {
        version: '38.0.0',
        files: {
          aaaa1111: {
            displayName: 'Code',
            source: { path: 'asset.aaaa1111', packaging: 'zip' },
            destinations: { d1: { bucketName: cdkBucket, objectKey: 'k.zip' } },
          },
        },
        dockerImages: {},
      },
      {
        assetBucket: cdkdBucket,
        containerRepo: 'cdkd-container-assets-111111111111-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      '111111111111',
      'us-east-1'
    );
    mockCreateAssetRedirectResolver.mockReturnValueOnce(async () => map);

    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: { BucketName: 'b', DataUrl: `s3://${cdkBucket}/k.zip` },
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockImplementation(() => ({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    }));

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , state] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      { resources: Record<string, { properties: Record<string, unknown> }> },
    ];
    // Issue #1652: state records what AWS actually holds for the adopted
    // resource (the CDK bootstrap bucket), NOT the rewritten value — so the
    // next `cdkd deploy` diff sees a real change and issues the corrective
    // UPDATE instead of classifying NO_CHANGE and leaving the live resource
    // pointing at CDK bootstrap storage forever.
    expect(state.resources['MyBucket']!.properties['DataUrl']).toBe(`s3://${cdkBucket}/k.zip`);
    // The deploy-side template IS still rewritten in place (that is what
    // makes assets resolve against cdkd storage) — only the state snapshot
    // is taken beforehand.
    expect(
      (tmpl.Resources['MyBucket']!.Properties as Record<string, unknown>)['DataUrl']
    ).toBe(`s3://${cdkdBucket}/k.zip`);
    // And the user is told why the next deploy will show a change.
    const noticeCall = infoSpy.mock.calls.find((c) =>
      String(c[0]).includes('recorded in state at their pre-rewrite')
    );
    expect(noticeCall).toBeDefined();
  });

  // The rewrite walks Parameters too, and `resolveImportedProperties` binds a
  // Parameter's `Default` before resolving `{Ref: …}` in a resource. So passing
  // the REWRITTEN template to that call instead of the pre-rewrite snapshot
  // re-injects the cdkd bucket into state through the parameter — invisible to
  // a fixture whose asset reference is a literal string. Legacy CDK templates
  // carry exactly this shape (`AssetParameters<hash>S3Bucket`), so this pins
  // the argument rather than the property.
  it('records the PRE-rewrite value when the asset reference comes from a Parameter Default (#1652)', async () => {
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    const cdkBucket = 'cdk-hnb659fds-assets-111111111111-us-east-1';
    const cdkdBucket = 'cdkd-assets-111111111111-us-east-1';
    const map = buildAssetRedirectMap(
      {
        version: '38.0.0',
        files: {
          aaaa1111: {
            displayName: 'Code',
            source: { path: 'asset.aaaa1111', packaging: 'zip' },
            destinations: { d1: { bucketName: cdkBucket, objectKey: 'k.zip' } },
          },
        },
        dockerImages: {},
      },
      {
        assetBucket: cdkdBucket,
        containerRepo: 'cdkd-container-assets-111111111111-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      '111111111111',
      'us-east-1'
    );
    mockCreateAssetRedirectResolver.mockReturnValueOnce(async () => map);

    const tmpl: CloudFormationTemplate = {
      AWSTemplateFormatVersion: '2010-09-09',
      Parameters: {
        AssetParametersaaaa1111S3Bucket: { Type: 'String', Default: cdkBucket },
      },
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: 'b',
            AssetBucket: { Ref: 'AssetParametersaaaa1111S3Bucket' },
          },
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      },
    };
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockImplementation(() => ({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    }));

    await runImport(['import', '--app', 'x', '--yes']);

    const [, , state] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      { resources: Record<string, { properties: Record<string, unknown> }> },
    ];
    expect(state.resources['MyBucket']!.properties['AssetBucket']).toBe(cdkBucket);
    // The deploy-side template's Parameter IS rewritten, as for any other
    // reference — only the state snapshot predates it.
    expect(tmpl.Parameters!['AssetParametersaaaa1111S3Bucket']!.Default).toBe(cdkdBucket);
  });

  it('persists the {{resolve:...}} expression, not the plaintext, for an imported secret property (GHSA fix)', async () => {
    // `cdkd import` resolves intrinsics in the imported resource's Properties so
    // state carries concrete values — but a {{resolve:secretsmanager:...}}
    // reference must persist as the EXPRESSION, never the fetched plaintext
    // (the same disclosure class the deploy path fixes).
    const secretPlaintext = 'imported-super-secret';
    // The payload must be valid JSON because the reference names a JSON_KEY.
    // With a bare string the resolver REFUSES the reference, `resolveImported-
    // Properties` catches it and persists the RAW template shape — which equals
    // the redacted form, so every assertion below passed while redaction never
    // ran at all. The `expect(smSend).toHaveBeenCalled()` guard did not catch
    // that: the fetch DID happen, it was the parse after it that refused.
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ client_secret: secretPlaintext }),
    });

    const secretExpr = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';
    const tmpl: CloudFormationTemplate = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        Idp: {
          Type: 'AWS::Cognito::UserPoolIdentityProvider',
          Properties: {
            ProviderName: 'oidc',
            ProviderDetails: { client_id: 'public-id', client_secret: secretExpr },
          },
          Metadata: { 'aws:cdk:path': 'S/Idp' },
        },
      },
    };
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockImplementation(() => ({
      import: vi.fn(async () => ({ physicalId: 'idp-phys', attributes: {} })),
    }));

    await runImport(['import', '--app', 'x', '--yes']);

    const [, , state] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      { resources: Record<string, { properties: Record<string, unknown> }> },
    ];
    // Non-vacuity guard: the reference must have RESOLVED, not merely been
    // fetched. The raw form equals the redacted form, so anything that leaves
    // the intrinsic unresolved satisfies the assertions below without redaction
    // running — and a refusal AFTER the fetch does exactly that, which is why
    // asserting the fetch alone was not enough.
    expect(smSend).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain(
      'Failed to resolve intrinsics in Properties'
    );

    const details = state.resources['Idp']!.properties['ProviderDetails'] as Record<string, unknown>;
    // The secret member holds the expression; the public sibling is untouched.
    // With the fetch proven above, the only path back to the expression is
    // redaction of the resolved plaintext.
    expect(details['client_secret']).toBe(secretExpr);
    expect(details['client_id']).toBe('public-id');
    // Hard invariant: the plaintext appears NOWHERE in the persisted state.
    expect(JSON.stringify(state)).not.toContain(secretPlaintext);
  });

  it('keeps each imported leaf on ITS OWN expression when two references share a value (#1910)', async () => {
    // `cdkd import` was the fourth sibling writer passing no position source:
    // two references resolving to one value collapsed onto whichever the
    // resolver recorded last, so the freshly imported state disagreed with the
    // template at one leaf and the very next `cdkd deploy` reported a change.
    const secretPlaintext = 'imported-super-secret';
    // TWO DISTINCT secrets that happen to hold the same value — a shared
    // password rotated into two places. Distinct ids rather than two version
    // stages of one id on purpose: the resolver resolves a stage-qualified
    // reference off the same fetch, so a stage pair yields ONE call and the
    // second leaf would silently stay raw, making the assertion vacuous.
    smSend.mockResolvedValueOnce({ SecretString: secretPlaintext });
    smSend.mockResolvedValueOnce({ SecretString: secretPlaintext });

    const exprPlain = '{{resolve:secretsmanager:secret-one:SecretString::}}';
    const exprStaged = '{{resolve:secretsmanager:secret-two:SecretString::}}';
    const tmpl: CloudFormationTemplate = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        Idp: {
          Type: 'AWS::Cognito::UserPoolIdentityProvider',
          Properties: {
            ProviderName: 'oidc',
            ProviderDetails: { plain: exprPlain, staged: exprStaged },
          },
          Metadata: { 'aws:cdk:path': 'S/Idp' },
        },
      },
    };
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockImplementation(() => ({
      import: vi.fn(async () => ({ physicalId: 'idp-phys', attributes: {} })),
    }));

    await runImport(['import', '--app', 'x', '--yes']);

    const [, , state] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      { resources: Record<string, { properties: Record<string, unknown> }> },
    ];
    // Non-vacuity guards. The call COUNT alone is not enough and is the same
    // class as the bug fixed above: a refusal AFTER the fetch keeps the count
    // at 2 and still leaves both leaves raw, which equals the expected values.
    // So assert the count (both references were reached) AND that neither
    // resolution was refused.
    expect(smSend).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain(
      'Failed to resolve intrinsics in Properties'
    );

    const details = state.resources['Idp']!.properties['ProviderDetails'] as Record<string, unknown>;
    expect(details['plain']).toBe(exprPlain);
    expect(details['staged']).toBe(exprStaged);
    expect(JSON.stringify(state)).not.toContain(secretPlaintext);
  });

  it('leaves state untouched by the rewrite for nested-stack children (#1652)', async () => {
    // The recursive `--migrate-from-cloudformation` child walk reads each
    // nested template from its own file and applies the same §7 rewrite, so
    // it needs the same pre-rewrite state snapshot as the root walk.
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    const cdkBucket = 'cdk-hnb659fds-assets-111111111111-us-east-1';
    const cdkdBucket = 'cdkd-assets-111111111111-us-east-1';
    const map = buildAssetRedirectMap(
      {
        version: '38.0.0',
        files: {
          aaaa1111: {
            displayName: 'Code',
            source: { path: 'asset.aaaa1111', packaging: 'zip' },
            destinations: { d1: { bucketName: cdkBucket, objectKey: 'k.zip' } },
          },
        },
        dockerImages: {},
      },
      {
        assetBucket: cdkdBucket,
        containerRepo: 'cdkd-container-assets-111111111111-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      '111111111111',
      'us-east-1'
    );
    mockCreateAssetRedirectResolver.mockReturnValueOnce(async () => map);

    const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-asset-'));
    try {
      const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          Resources: {
            ChildPolicy: {
              Type: 'AWS::IAM::Policy',
              Properties: { PolicyName: 'p', DataUrl: `s3://${cdkBucket}/k.zip` },
            },
          },
        })
      );
      const tmpl = template({
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
      });
      mockSynthesize.mockResolvedValue({
        stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
      });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
      // Named rather than inline so the DESIRED side is inspectable below:
      // `provider.import()` receives the child's REWRITTEN properties, which is
      // the half a state-only assertion cannot see.
      // The parameter is DECLARED (not `async () =>`) so `mock.calls` carries a
      // 1-tuple: an argument-less mock types its calls as `[]`, and indexing
      // `[0]` is then a compile error `vp run test` alone would not surface.
      const childProviderImport = vi.fn(
        async (_input: { logicalId: string; properties: Record<string, unknown> }) => ({
          physicalId: 'p',
          attributes: {},
        })
      );
      mockGetProvider.mockReturnValue({ import: childProviderImport });
      const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
      mockGetCfnResourceTree.mockResolvedValue({
        stackName: 'P',
        physicalId: 'P',
        resources: new Map([['Child', childArn]]),
        nested: new Map([
          [
            'Child',
            {
              stackName: childArn,
              physicalId: childArn,
              resources: new Map([['ChildPolicy', 'p']]),
              nested: new Map(),
            },
          ],
        ]),
      });

      await runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      const childSave = mockSaveState.mock.calls.find(
        (c) => (c as unknown[])[0] === 'P~Child'
      ) as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      expect(childSave).toBeDefined();
      expect(childSave[2].resources['ChildPolicy']!.properties['DataUrl']).toBe(
        `s3://${cdkBucket}/k.zip`
      );

      // BOTH polarities. The assertion above alone passes if the child rewrite
      // is deleted outright — which would silently break child asset
      // resolution, the thing the rewrite exists for. So also pin that the
      // child TEMPLATE (what `provider.import()` and the next deploy consume)
      // WAS rewritten to the cdkd bucket. The two must disagree; that
      // disagreement IS the fix.
      const childImportCall = childProviderImport.mock.calls.find(
        (c) => c[0].logicalId === 'ChildPolicy'
      );
      expect(childImportCall).toBeDefined();
      expect(childImportCall![0].properties['DataUrl']).toBe(`s3://${cdkdBucket}/k.zip`);

      // The per-CHILD notice, not just the root one. Under
      // --migrate-from-cloudformation the assets can live entirely in nested
      // children, so the root count is 0 and the root notice never fires —
      // which would leave the user with unexplained UPDATEs on the next
      // deploy. Without this assertion, deleting the whole child notice block
      // leaves every test green.
      const childNotice = infoSpy.mock.calls.find(
        (c) =>
          String(c[0]).includes('nested stack') &&
          String(c[0]).includes('recorded in state at their pre-rewrite')
      );
      expect(childNotice).toBeDefined();
      expect(String(childNotice![0])).toContain('P~Child');
    } finally {
      rmSync(tmpdirPath, { recursive: true, force: true });
    }
  });

  // Issue #2161: the NESTED-child acquire (import.ts:1936) has its own
  // `!acquired` check. Here the root acquire succeeds but the child's returns
  // false — import must refuse the child rather than write its state and
  // release the foreign child lock. Fences the child-side check independently
  // of the top-level one above.
  it('refuses a nested child when its lock is held (child acquireLock resolves false)', async () => {
    const cdkBucket = 'cdk-hnb659fds-assets-111111111111-us-east-1';
    const cdkdBucket = 'cdkd-assets-111111111111-us-east-1';
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    mockCreateAssetRedirectResolver.mockReturnValueOnce(
      async () =>
        buildAssetRedirectMap(
          { version: '38.0.0', files: {}, dockerImages: {} },
          {
            assetBucket: cdkdBucket,
            containerRepo: 'cdkd-container-assets-111111111111-us-east-1',
            assetSupportVersion: 1,
            createdAt: '2026-07-15T00:00:00.000Z',
          },
          '111111111111',
          'us-east-1'
        )
    );
    const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-lock-'));
    try {
      const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          Resources: {
            ChildPolicy: {
              Type: 'AWS::IAM::Policy',
              Properties: { PolicyName: 'p', DataUrl: `s3://${cdkBucket}/k.zip` },
            },
          },
        })
      );
      const tmpl = template({
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
      });
      mockSynthesize.mockResolvedValue({
        stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
      });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'p', attributes: {} })),
      });
      const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
      mockGetCfnResourceTree.mockResolvedValue({
        stackName: 'P',
        physicalId: 'P',
        resources: new Map([['Child', childArn]]),
        nested: new Map([
          [
            'Child',
            {
              stackName: childArn,
              physicalId: childArn,
              resources: new Map([['ChildPolicy', 'p']]),
              nested: new Map(),
            },
          ],
        ]),
      });
      // Root acquire succeeds; the CHILD acquire reports contention.
      mockAcquireLock.mockReset();
      mockAcquireLock.mockResolvedValueOnce(true).mockResolvedValue(false);

      await expect(
        runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation'])
      ).rejects.toThrow();

      // The child state was NOT written under the foreign child lock, and the
      // child's lock was NOT released.
      const childSave = mockSaveState.mock.calls.find((c) => (c as unknown[])[0] === 'P~Child');
      expect(childSave).toBeUndefined();
      expect(mockReleaseLock).not.toHaveBeenCalledWith('P~Child', expect.anything());
      // POSITIVE markers so the fence cannot go inert on a fixture change: the
      // CHILD acquire was actually attempted, and the CHILD lock error (not a
      // root-side failure in the hand-built tree) is what surfaced.
      expect(mockAcquireLock).toHaveBeenCalledWith(
        'P~Child',
        expect.any(String),
        expect.any(String),
        'import'
      );
      expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toMatch(
        /Could not acquire lock for nested stack/
      );
    } finally {
      rmSync(tmpdirPath, { recursive: true, force: true });
    }
  });

  it('rejects when stack name is unknown', async () => {
    const tmpl = template({});
    mockSynthesize.mockResolvedValue({
      stacks: [stackInfo('A', tmpl), stackInfo('B', tmpl)],
    });

    await expect(runImport(['import', 'NonExistent', '--app', 'x'])).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/Stack 'NonExistent' not found/);
  });

  it('reports import outcomes per resource and writes state', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
      MyFn: {
        Type: 'AWS::Lambda::Function',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyFn' },
      },
      Untouched: {
        Type: 'AWS::Foo::Bar', // unsupported
        Properties: {},
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });

    mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
    mockGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return { import: vi.fn(async () => ({ physicalId: 'my-bucket-name', attributes: {} })) };
      }
      if (t === 'AWS::Lambda::Function') {
        return { import: vi.fn(async () => null) }; // not found
      }
      return {};
    });

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , state] = mockSaveState.mock.calls[0] as unknown as [string, string, { resources: Record<string, unknown> }];
    expect(Object.keys(state.resources)).toEqual(['MyBucket']);

    // Summary line should reflect the 1/1/1 split.
    const summaryCall = infoSpy.mock.calls.find((c) => String(c[0]).startsWith('Summary:'));
    expect(String(summaryCall?.[0])).toMatch(/1 imported, 1 not found, 1 unsupported/);
  });

  it('populates observedProperties for each imported resource by calling provider.readCurrentState', async () => {
    // After import, the saved state must carry an observedProperties
    // baseline for every successfully-imported resource — same shape as
    // a fresh `cdkd deploy` produces — so the very first
    // `cdkd drift` run after adoption has a real AWS-current snapshot
    // and not just the user's template intent.
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
      MyFn: {
        Type: 'AWS::Lambda::Function',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyFn' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });

    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return {
          import: vi.fn(async () => ({ physicalId: 'my-bucket-name', attributes: {} })),
          readCurrentState: vi.fn(async () => ({ BucketName: 'my-bucket-name', Tags: [] })),
        };
      }
      if (t === 'AWS::Lambda::Function') {
        return {
          import: vi.fn(async () => ({ physicalId: 'my-fn', attributes: {} })),
          // No readCurrentState — falls back to undefined observedProperties.
        };
      }
      return {};
    });

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , state] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      { resources: Record<string, { observedProperties?: Record<string, unknown> }> },
    ];
    expect(state.resources['MyBucket']?.observedProperties).toEqual({
      BucketName: 'my-bucket-name',
      Tags: [],
    });
    // Provider without readCurrentState leaves observedProperties unset.
    expect(state.resources['MyFn']?.observedProperties).toBeUndefined();
  });

  it('does not abort the import when one resource\'s readCurrentState throws', async () => {
    // Same defensive shape as deploy: a single readCurrentState
    // failure must not fail the import. The affected resource just
    // lands without observedProperties; the next deploy populates it.
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
      MyFn: {
        Type: 'AWS::Lambda::Function',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyFn' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });

    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return {
          import: vi.fn(async () => ({ physicalId: 'my-bucket-name', attributes: {} })),
          readCurrentState: vi.fn(async () => ({ BucketName: 'my-bucket-name' })),
        };
      }
      if (t === 'AWS::Lambda::Function') {
        return {
          import: vi.fn(async () => ({ physicalId: 'my-fn', attributes: {} })),
          readCurrentState: vi.fn(async () => {
            throw new Error('AccessDenied');
          }),
        };
      }
      return {};
    });

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , state] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      { resources: Record<string, { observedProperties?: Record<string, unknown> }> },
    ];
    expect(state.resources['MyBucket']?.observedProperties).toEqual({
      BucketName: 'my-bucket-name',
    });
    expect(state.resources['MyFn']?.observedProperties).toBeUndefined();
  });

  it('passes --resource overrides through as knownPhysicalId', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    const importSpy = vi.fn(async () => ({ physicalId: 'manual-bucket', attributes: {} }));
    mockGetProvider.mockReturnValue({ import: importSpy });

    await runImport(['import', '--app', 'x', '--resource', 'MyBucket=manual-bucket', '--yes']);

    expect(importSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalId: 'MyBucket',
        knownPhysicalId: 'manual-bucket',
      })
    );
  });

  it('--dry-run skips state save and the confirmation prompt', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    });

    await runImport(['import', '--app', 'x', '--dry-run']);

    expect(mockSaveState).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/--dry-run: state will NOT be written/)
    );
  });

  it('respects "n" at the confirmation prompt', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    });
    readlineQuestion.mockResolvedValue('n');

    await runImport(['import', '--app', 'x']);

    expect(mockSaveState).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('Import cancelled.');
  });

  it('does not write state when zero resources were successfully imported', async () => {
    const tmpl = template({
      OnlyUnsupported: {
        Type: 'AWS::Foo::Bar',
        Properties: {},
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(false);

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/No resources were successfully imported/)
    );
  });

  it('rejects malformed --resource values', async () => {
    const tmpl = template({});
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });

    await expect(
      runImport(['import', '--app', 'x', '--resource', 'badformat', '--yes'])
    ).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/expects 'logicalId=physicalId'/);
  });

  it('lock is released even when the import fails mid-flight', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => {
        throw new Error('AWS API blew up');
      }),
    });

    await runImport(['import', '--app', 'x', '--yes']);

    // Provider failure becomes a 'failed' row, not a thrown error — so the
    // command still completes. saveState is skipped (no successful imports).
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  describe('selective vs auto mode (CDK CLI parity)', () => {
    const tmpl3 = () =>
      template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        MyFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyFn' },
        },
        MyTable: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyTable' },
        },
      });

    it('selective mode: --resource imports ONLY listed resources, others go out-of-scope', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      const bucketImport = vi.fn(async () => ({ physicalId: 'manual-bucket', attributes: {} }));
      const fnImport = vi.fn(async () => ({ physicalId: 'tagged-fn', attributes: {} }));
      const tableImport = vi.fn(async () => ({ physicalId: 'tagged-table', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        if (t === 'AWS::Lambda::Function') return { import: fnImport };
        if (t === 'AWS::DynamoDB::Table') return { import: tableImport };
        return {};
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=manual-bucket', '--yes']);

      // Only MyBucket should have hit a provider — MyFn and MyTable are
      // skipped at the dispatcher, never reaching the provider.
      expect(bucketImport).toHaveBeenCalledTimes(1);
      expect(fnImport).not.toHaveBeenCalled();
      expect(tableImport).not.toHaveBeenCalled();

      // State carries only MyBucket.
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, unknown> },
      ];
      expect(Object.keys(state.resources)).toEqual(['MyBucket']);

      // Summary calls out the out-of-scope count.
      const summaryCall = infoSpy.mock.calls.find((c) => String(c[0]).startsWith('Summary:'));
      expect(String(summaryCall?.[0])).toMatch(/2 out of scope/);
    });

    it('--auto with --resource: explicit ID for listed, tag-import for the rest', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      const bucketImport = vi.fn(async () => ({ physicalId: 'manual-bucket', attributes: {} }));
      const fnImport = vi.fn(async () => ({ physicalId: 'tagged-fn', attributes: {} }));
      const tableImport = vi.fn(async () => ({ physicalId: 'tagged-table', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        if (t === 'AWS::Lambda::Function') return { import: fnImport };
        if (t === 'AWS::DynamoDB::Table') return { import: tableImport };
        return {};
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=manual-bucket',
        '--auto',
        '--yes',
      ]);

      // All three providers hit. MyBucket gets explicit knownPhysicalId; the
      // others go through tag-based lookup with no override.
      expect(bucketImport).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'manual-bucket' })
      );
      // The other two have no `knownPhysicalId` key at all (the spread
      // omits it when no override exists) — they go through tag-based
      // lookup. Use `not.toHaveProperty` to assert absence.
      expect(fnImport).toHaveBeenCalledWith(expect.objectContaining({ logicalId: 'MyFn' }));
      expect((fnImport.mock.calls[0]! as unknown[])[0]).not.toHaveProperty('knownPhysicalId');
      expect(tableImport).toHaveBeenCalledWith(expect.objectContaining({ logicalId: 'MyTable' }));
      expect((tableImport.mock.calls[0]! as unknown[])[0]).not.toHaveProperty('knownPhysicalId');

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, unknown> },
      ];
      expect(Object.keys(state.resources).sort()).toEqual(['MyBucket', 'MyFn', 'MyTable']);
    });

    it('no flags: auto-imports every resource via tags (cdkd default)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      const bucketImport = vi.fn(async () => ({ physicalId: 'b', attributes: {} }));
      const fnImport = vi.fn(async () => ({ physicalId: 'f', attributes: {} }));
      const tableImport = vi.fn(async () => ({ physicalId: 't', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        if (t === 'AWS::Lambda::Function') return { import: fnImport };
        if (t === 'AWS::DynamoDB::Table') return { import: tableImport };
        return {};
      });

      await runImport(['import', '--app', 'x', '--yes']);

      expect(bucketImport).toHaveBeenCalledTimes(1);
      expect(fnImport).toHaveBeenCalledTimes(1);
      expect(tableImport).toHaveBeenCalledTimes(1);
    });

    it('rejects --resource with a logical ID not in the template', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport(['import', '--app', 'x', '--resource', 'TypoLogicalId=foo', '--yes'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/'TypoLogicalId'.*not in the synthesized template/);
    });
  });

  describe('provider-returned attributes (issue #1098)', () => {
    it('persists provider-returned attributes into the written state', async () => {
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation(() => ({
        import: vi.fn(async () => ({
          physicalId: 'my-bucket-name',
          attributes: {
            Arn: 'arn:aws:s3:::my-bucket-name',
            DomainName: 'my-bucket-name.s3.amazonaws.com',
          },
        })),
      }));

      await runImport(['import', '--app', 'x', '--yes']);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { attributes: Record<string, unknown> }> },
      ];
      // Pre-fix this was hardcoded `{}`, so an adopted resource could not
      // back `Fn::GetAtt` the way a deployed one can.
      expect(state.resources['MyBucket']!.attributes).toEqual({
        Arn: 'arn:aws:s3:::my-bucket-name',
        DomainName: 'my-bucket-name.s3.amazonaws.com',
      });
    });

    it('leaves attributes as {} when the provider returns none', async () => {
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      // No `attributes` key at all — the optional field is absent.
      mockGetProvider.mockImplementation(() => ({
        import: vi.fn(async () => ({ physicalId: 'my-bucket-name' })),
      }));

      await runImport(['import', '--app', 'x', '--yes']);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { attributes: Record<string, unknown> }> },
      ];
      expect(state.resources['MyBucket']!.attributes).toEqual({});
    });

    // Second-order effect of persisting attributes. `resolveImportedProperties`
    // runs the real IntrinsicFunctionResolver against `stackState.resources`
    // and overwrites each imported resource's persisted `properties`, so a
    // populated `attributes` map changes what a downstream `Fn::GetAtt`
    // resolves to.
    //
    // AWS::CodeCommit::Repository is the discriminating case: its physicalId
    // is the repository NAME, and `constructAttribute` has no branch for the
    // type, so its terminal `default: return physicalId` silently produced
    // the bare name where an ARN belongs. Observed values for this exact
    // input: pre-fix `{"Queues":["my-repo"]}`, post-fix
    // `{"Queues":["arn:aws:codecommit:us-east-1:123456789012:my-repo"]}`.
    // The fix is therefore a CORRECTION of a silently-wrong persisted
    // property, and it converges import's stored shape on what `cdkd deploy`
    // would have written.
    it('populated attributes let a downstream Fn::GetAtt resolve into persisted properties', async () => {
      const tmpl = template({
        MyRepo: {
          Type: 'AWS::CodeCommit::Repository',
          Properties: { RepositoryName: 'my-repo' },
          Metadata: { 'aws:cdk:path': 'S/MyRepo' },
        },
        MyPolicy: {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: { Queues: [{ 'Fn::GetAtt': ['MyRepo', 'Arn'] }] },
          Metadata: { 'aws:cdk:path': 'S/MyPolicy' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::CodeCommit::Repository') {
          return {
            import: vi.fn(async () => ({
              physicalId: 'my-repo',
              attributes: { Arn: 'arn:aws:codecommit:us-east-1:123456789012:my-repo' },
            })),
          };
        }
        return { import: vi.fn(async () => ({ physicalId: 'policy-1' })) };
      });

      await runImport(['import', '--app', 'x', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        {
          resources: Record<
            string,
            { properties: Record<string, unknown>; attributes: Record<string, unknown> }
          >;
        },
      ];
      // Pre-fix this was the bare physical id `'my-repo'` (constructAttribute's
      // `default: return physicalId` fallback), silently persisting a name
      // where the template asked for an ARN.
      expect(state.resources['MyPolicy']!.properties).toEqual({
        Queues: ['arn:aws:codecommit:us-east-1:123456789012:my-repo'],
      });
      // The imported producer itself carries the attribute map that made it
      // resolvable.
      expect(state.resources['MyRepo']!.attributes).toEqual({
        Arn: 'arn:aws:codecommit:us-east-1:123456789012:my-repo',
      });
    });
  });

  describe('--resource-mapping-inline', () => {
    const oneResource = () =>
      template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });

    it('parses inline JSON and applies it as knownPhysicalId (selective mode)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'inline-bucket', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource-mapping-inline',
        '{"MyBucket":"inline-bucket"}',
        '--yes',
      ]);

      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'inline-bucket' })
      );
    });

    it('accepts an empty JSON object (no overrides) — falls back to auto mode', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'tagged-bucket', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });

      await runImport(['import', '--app', 'x', '--resource-mapping-inline', '{}', '--yes']);

      // Empty object -> no overrides -> auto mode dispatches all resources
      // through tag-based lookup with no knownPhysicalId.
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect((importSpy.mock.calls[0]! as unknown[])[0]).not.toHaveProperty('knownPhysicalId');
    });

    it('rejects malformed inline JSON with a clear error', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport([
          'import',
          '--app',
          'x',
          '--resource-mapping-inline',
          '{not valid json}',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /Failed to parse --resource-mapping-inline as JSON/
      );
    });

    it('rejects inline JSON that is not an object (e.g. an array)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport(['import', '--app', 'x', '--resource-mapping-inline', '["a","b"]', '--yes'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /--resource-mapping-inline must be a JSON object/
      );
    });

    it('rejects inline JSON with non-string values', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport([
          'import',
          '--app',
          'x',
          '--resource-mapping-inline',
          '{"MyBucket":123}',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /--resource-mapping-inline: value for 'MyBucket' must be a string/
      );
    });

    it('rejects when both --resource-mapping and --resource-mapping-inline are passed', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport([
          'import',
          '--app',
          'x',
          '--resource-mapping',
          'some-file.json',
          '--resource-mapping-inline',
          '{"MyBucket":"x"}',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /--resource-mapping and --resource-mapping-inline are mutually exclusive/
      );
    });

    it('lets --resource override an entry from --resource-mapping-inline (CLI wins)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'cli-bucket', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource-mapping-inline',
        '{"MyBucket":"inline-bucket"}',
        '--resource',
        'MyBucket=cli-bucket',
        '--yes',
      ]);

      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'cli-bucket' })
      );
    });
  });

  it('auto-selects the single stack when no positional arg is given', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('OnlyOne', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    });

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).toHaveBeenCalledWith(
      'OnlyOne',
      'us-east-1',
      expect.objectContaining({ stackName: 'OnlyOne', region: 'us-east-1' }),
      // saveState now also receives an options object — empty when no
      // existing state was found (no etag to forward, no migration pending).
      {}
    );
  });

  describe('--record-resource-mapping', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cdkd-record-mapping-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const tmpl3 = () =>
      template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        MyFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyFn' },
        },
        UntouchedUnsupported: {
          Type: 'AWS::Foo::Bar',
          Properties: {},
        },
      });

    it('writes the resolved mapping with only `imported` rows (skips not-found / unsupported / failed)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'my-bucket-name', attributes: {} })) };
        }
        if (t === 'AWS::Lambda::Function') {
          // skipped-not-found
          return { import: vi.fn(async () => null) };
        }
        return {};
      });

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--yes']);

      const body = readFileSync(file, 'utf-8');
      // Pretty-printed (2-space indent) + trailing newline.
      expect(body.endsWith('\n')).toBe(true);
      expect(body).toContain('  "MyBucket": "my-bucket-name"');
      const parsed = JSON.parse(body) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'my-bucket-name' });
      // skipped / unsupported rows must NOT appear in the file.
      expect(parsed).not.toHaveProperty('MyFn');
      expect(parsed).not.toHaveProperty('UntouchedUnsupported');
    });

    it('writes `{}` when zero resources were imported (file is still produced)', async () => {
      const tmpl = template({
        OnlyUnsupported: { Type: 'AWS::Foo::Bar', Properties: {} },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(false);

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--yes']);

      const body = readFileSync(file, 'utf-8');
      expect(body).toBe('{}\n');
    });

    it('writes the mapping even when the user says "no" to the confirmation prompt', async () => {
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'declined-but-still-recorded', attributes: {} })),
      });
      readlineQuestion.mockResolvedValue('n');

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file]);

      // State NOT written (user said no), but the record file IS — that's
      // the whole point: the resolved data should not be thrown away.
      expect(mockSaveState).not.toHaveBeenCalled();
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'declined-but-still-recorded' });
    });

    it('writes the mapping under --dry-run (state save still skipped)', async () => {
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
      });

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--dry-run']);

      expect(mockSaveState).not.toHaveBeenCalled();
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'b' });
    });

    it('logs an error but does NOT abort the import when the file path is unwritable', async () => {
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
      });

      // Parent directory does not exist — writeFileSync raises ENOENT.
      const unwritable = join(tmpDir, 'does', 'not', 'exist', 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', unwritable, '--yes']);

      // The import itself completed and state was written — only the
      // record file write failed.
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const errorMessages = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(errorMessages.some((m) => /Failed to write --record-resource-mapping/.test(m))).toBe(
        true
      );
    });

    it('records resolved physical IDs from --auto tag-based lookup (the typical use case)', async () => {
      // This is the user-facing scenario the flag exists for: cdkd looked
      // up the physical IDs via tags, and we want that resolved mapping
      // to disk so a non-interactive CI re-run can replay it via
      // --resource-mapping.
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'auto-bucket', attributes: {} })) };
        }
        if (t === 'AWS::Lambda::Function') {
          return { import: vi.fn(async () => ({ physicalId: 'auto-fn', attributes: {} })) };
        }
        return {};
      });

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--yes']);

      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'auto-bucket', MyFn: 'auto-fn' });
    });
  });

  describe('merge into existing state (selective mode)', () => {
    // The user reported regression: importing a single bucket into a stack
    // whose state already contained Queue + Topic dropped the Queue + Topic
    // entries from state. Selective mode is supposed to be non-destructive
    // for unlisted resources.
    function existingState(extra: Record<string, unknown> = {}) {
      return {
        version: 2 as const,
        stackName: 'S',
        region: 'us-east-1',
        resources: {
          MyQueue: {
            physicalId: 'queue-arn',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'q' },
            attributes: { Arn: 'queue-arn' },
            dependencies: [],
          },
          MyTopic: {
            physicalId: 'topic-arn',
            resourceType: 'AWS::SNS::Topic',
            properties: { TopicName: 't' },
            attributes: { TopicArn: 'topic-arn' },
            dependencies: [],
          },
          ...extra,
        },
        outputs: { ExistingOutput: 'preserved' },
        lastModified: 100,
      };
    }

    function templateWithBucket() {
      return template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        MyQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: { QueueName: 'q' },
          Metadata: { 'aws:cdk:path': 'S/MyQueue' },
        },
        MyTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: 't' },
          Metadata: { 'aws:cdk:path': 'S/MyTopic' },
        },
      });
    }

    it('selective merge preserves unlisted existing resources without --force', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState(),
        etag: '"existing-etag"',
      });
      mockHasProvider.mockReturnValue(true);
      const bucketImport = vi.fn(async () => ({ physicalId: 'cdkd-test-my-bucket', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        return { import: vi.fn(async () => null) };
      });

      // No --force: this is the user's bug-report scenario.
      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=cdkd-test-my-bucket',
        '--yes',
      ]);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state, options] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        {
          resources: Record<string, { physicalId: string; resourceType: string }>;
          outputs: Record<string, string>;
        },
        { expectedEtag?: string; migrateLegacy?: boolean },
      ];

      // The bug we are fixing: all three logical IDs must be in state.
      expect(Object.keys(state.resources).sort()).toEqual(['MyBucket', 'MyQueue', 'MyTopic']);
      expect(state.resources['MyBucket']?.physicalId).toBe('cdkd-test-my-bucket');
      // Existing entries preserved verbatim — physical IDs still point at AWS.
      expect(state.resources['MyQueue']?.physicalId).toBe('queue-arn');
      expect(state.resources['MyTopic']?.physicalId).toBe('topic-arn');
      // Outputs inherited from existing state (the import flow never derives them).
      expect(state.outputs).toEqual({ ExistingOutput: 'preserved' });
      // Optimistic-lock etag is forwarded so a concurrent write loses cleanly.
      expect(options.expectedEtag).toBe('"existing-etag"');
    });

    it('carries the existing record export set forward with its outputs (#2193)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: { ...existingState(), exportNames: ['ExistingOutput'] },
        etag: '"existing-etag"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket')
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        return { import: vi.fn(async () => null) };
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=b', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { outputs: Record<string, string>; exportNames?: string[] },
      ];
      expect(state.outputs).toEqual({ ExistingOutput: 'preserved' });
      expect(state.exportNames).toEqual(['ExistingOutput']);
    });

    it('does not invent an export set for a pre-v9 existing record (#2193)', async () => {
      // `existingState()` predates the field; writing `[]` here would deny
      // every consumer of this producer's outputs on the next Fn::ImportValue.
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({ state: existingState(), etag: '"existing-etag"' });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket')
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        return { import: vi.fn(async () => null) };
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=b', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { exportNames?: string[] },
      ];
      expect('exportNames' in state).toBe(false);
    });

    it('logs the merge plan with the preserved-resource count', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState(),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        }
        return { import: vi.fn(async () => null) };
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=b', '--yes']);

      const mergeLog = infoSpy.mock.calls.find((c) => /Merging into existing state/.test(String(c[0])));
      expect(mergeLog).toBeTruthy();
      expect(String(mergeLog?.[0])).toMatch(/preserving 2 unlisted resource/);
      // No "overwriting N listed entry(ies)" suffix when there are no conflicts.
      expect(String(mergeLog?.[0])).not.toMatch(/overwriting/);
    });

    it('rejects without --force when a listed override would overwrite an existing entry', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'old-bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'new-bucket-name', attributes: {} })),
      });

      await expect(
        runImport(['import', '--app', 'x', '--resource', 'MyBucket=new-bucket-name', '--yes'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /would overwrite resource\(s\) already in state: MyBucket/
      );
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/--force/);
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('overwrites the listed entry and preserves unlisted ones with --force', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'old-bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'new-bucket-name', attributes: {} })),
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=new-bucket-name',
        '--force',
        '--yes',
      ]);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { physicalId: string }> },
      ];
      // Listed entry overwritten; unlisted preserved.
      expect(state.resources['MyBucket']?.physicalId).toBe('new-bucket-name');
      expect(state.resources['MyQueue']?.physicalId).toBe('queue-arn');
      expect(state.resources['MyTopic']?.physicalId).toBe('topic-arn');
    });

    // Attribute carry-over on re-import. A re-imported row REPLACES the whole
    // ResourceState, so without the same-physical-id fallback in
    // buildStackState a provider whose import() returns no attributes would
    // wipe a map that a prior deploy / import had populated.
    it('re-importing at the SAME physical id preserves previously-stored attributes', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            // Populated by a prior `cdkd deploy`.
            attributes: { Arn: 'arn:aws:s3:::bucket-name' },
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      // Provider returns an EXPLICIT empty map — the realistic shape. Almost
      // every shipped provider spells it `attributes: {}` rather than
      // omitting the field (ssm-parameter-provider.ts:495 / :516,
      // s3-bucket-provider.ts, lambda-function-provider.ts, ...), so a stub
      // returning `{ physicalId }` alone would exercise a path no real
      // provider reaches. `{}` is not `undefined`, which is why
      // buildStackState normalizes empty-to-absent before the coalesce.
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'bucket-name', attributes: {} })),
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=bucket-name',
        '--force',
        '--yes',
      ]);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { attributes: Record<string, unknown> }> },
      ];
      expect(state.resources['MyBucket']!.attributes).toEqual({
        Arn: 'arn:aws:s3:::bucket-name',
      });
    });

    // The two arms below pin the EMPTINESS GATE the carry-over rests on
    // (`row.attributes && Object.keys(row.attributes).length > 0`). Both
    // existing arms above hand back a fully-empty `{}`, so they are
    // structurally blind to a PARTIAL map — which is exactly the shape a
    // provider produces when its attribute read degrades (issue #1875:
    // `Route53Provider`'s hosted-zone import returns `{}` rather than a
    // partial `{ Id }` BECAUSE of this gate).
    it('a DEGRADED import reporting an EMPTY map preserves the stored attributes', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            // A prior successful import / deploy read these.
            attributes: { Id: 'bucket-name', NameServers: ['ns-1.example.com'] },
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      // The shape a best-effort attribute read degrades to when the follow-up
      // AWS call fails.
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'bucket-name', attributes: {} })),
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=bucket-name',
        '--force',
        '--yes',
      ]);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { attributes: Record<string, unknown> }> },
      ];
      expect(state.resources['MyBucket']!.attributes).toEqual({
        Id: 'bucket-name',
        NameServers: ['ns-1.example.com'],
      });
    });

    it('a PARTIAL map is non-empty, so it REPLACES the stored attributes wholesale', async () => {
      // Not a bug in the gate — the gate cannot distinguish "the provider
      // read everything and this type has one attribute" from "the provider
      // kept what it could". It is the reason a degrade arm must report `{}`:
      // a partial map silently DROPS every key it omits.
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: { Id: 'bucket-name', NameServers: ['ns-1.example.com'] },
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({
          physicalId: 'bucket-name',
          attributes: { Id: 'bucket-name' },
        })),
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=bucket-name',
        '--force',
        '--yes',
      ]);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { attributes: Record<string, unknown> }> },
      ];
      expect(state.resources['MyBucket']!.attributes).toEqual({ Id: 'bucket-name' });
      expect(state.resources['MyBucket']!.attributes['NameServers']).toBeUndefined();
    });

    it('re-importing at a DIFFERENT physical id does NOT carry stale attributes over', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'old-bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            // These describe the OLD physical bucket.
            attributes: { Arn: 'arn:aws:s3:::old-bucket-name' },
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        // Explicit `{}` — the shape virtually every shipped provider returns.
        import: vi.fn(async () => ({ physicalId: 'new-bucket-name', attributes: {} })),
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=new-bucket-name',
        '--force',
        '--yes',
      ]);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { physicalId: string; attributes: Record<string, unknown> }> },
      ];
      // Carrying `old-bucket-name`'s Arn onto the new physical id would feed
      // a stale value to Fn::GetAtt — worse than an empty map.
      expect(state.resources['MyBucket']!.physicalId).toBe('new-bucket-name');
      expect(state.resources['MyBucket']!.attributes).toEqual({});
    });

    it('selective merge leaves an unlisted existing resource\'s own attributes intact', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({ state: existingState(), etag: '"e"' });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return {
            import: vi.fn(async () => ({ physicalId: 'cdkd-test-my-bucket', attributes: {} })),
          };
        }
        return { import: vi.fn(async () => null) };
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=cdkd-test-my-bucket',
        '--yes',
      ]);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { attributes: Record<string, unknown> }> },
      ];
      // MyQueue / MyTopic were never re-imported (the loop `continue`s on a
      // non-`imported` outcome), so their maps come through untouched.
      expect(state.resources['MyQueue']!.attributes).toEqual({ Arn: 'queue-arn' });
      expect(state.resources['MyTopic']!.attributes).toEqual({ TopicArn: 'topic-arn' });
    });

    it('forwards migrateLegacy when the existing state was loaded from the v1 layout', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState(),
        etag: '"legacy-etag"',
        migrationPending: true,
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        }
        return { import: vi.fn(async () => null) };
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=b', '--yes']);

      const [, , , options] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        unknown,
        { expectedEtag?: string; migrateLegacy?: boolean },
      ];
      expect(options.expectedEtag).toBe('"legacy-etag"');
      expect(options.migrateLegacy).toBe(true);
    });

    it('auto-mode --force on existing state still wipes unlisted entries (whole-stack semantics)', async () => {
      // This is the existing destructive-overwrite path; --force is the
      // user's acknowledgement that they want the state rebuilt from the
      // template. Selective merge is a separate path (see above).
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          DriftedResource: {
            physicalId: 'orphan',
            resourceType: 'AWS::Foo::Bar',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        }
        if (t === 'AWS::SQS::Queue') {
          return { import: vi.fn(async () => ({ physicalId: 'q', attributes: {} })) };
        }
        if (t === 'AWS::SNS::Topic') {
          return { import: vi.fn(async () => ({ physicalId: 't', attributes: {} })) };
        }
        return {};
      });

      await runImport(['import', '--app', 'x', '--force', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, unknown>; outputs: Record<string, string> },
      ];
      // DriftedResource is NOT in the template, so auto-mode rebuild drops it.
      expect(Object.keys(state.resources).sort()).toEqual(['MyBucket', 'MyQueue', 'MyTopic']);
      expect(state.resources['DriftedResource']).toBeUndefined();
      // Outputs are still inherited (they are never derived from the import flow,
      // so the auto-mode rebuild has no reason to wipe them).
      expect(state.outputs).toEqual({ ExistingOutput: 'preserved' });
    });
  });

  describe('dependencies persisted to state (#1032)', () => {
    it('filters template Parameter names from imported dependencies', async () => {
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: { Env: { Type: 'String', Default: 'dev' } },
        Resources: {
          MyQueue: {
            Type: 'AWS::SQS::Queue',
            Properties: { QueueName: 'q' },
            Metadata: { 'aws:cdk:path': 'S/MyQueue' },
          },
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { Ref: 'Env' },
              Tag: { Ref: 'MyQueue' },
            },
            Metadata: { 'aws:cdk:path': 'S/MyBucket' },
          },
        },
      };
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => ({
        import: vi.fn(async () =>
          t === 'AWS::S3::Bucket'
            ? { physicalId: 'bucket-phys', attributes: {} }
            : { physicalId: 'queue-phys', attributes: {} }
        ),
      }));

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=bucket-phys',
        '--resource',
        'MyQueue=queue-phys',
        '--yes',
      ]);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { dependencies: string[] }> },
      ];
      // The Ref to the Env parameter is dropped; the resource edge survives.
      expect(state.resources['MyBucket']?.dependencies).toEqual(['MyQueue']);
      expect(state.resources['MyQueue']?.dependencies).toEqual([]);
    });
  });

  describe('--migrate-from-cloudformation', () => {
    const oneResource = () =>
      template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });

    function setupHappyPath(cfnPhysical = 'cfn-resolved-bucket'): {
      importSpy: ReturnType<typeof vi.fn>;
    } {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: cfnPhysical, attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });
      // Migration code path consumes `tree.resources` from the recursive
      // `getCloudFormationResourceTree` walker. Top-level migration tests
      // don't exercise nesting, so `nested` stays empty.
      mockGetCfnResourceTree.mockResolvedValue({
        stackName: 'S',
        physicalId: 'S',
        resources: new Map([['MyBucket', cfnPhysical]]),
        nested: new Map(),
      });
      return { importSpy };
    }

    // Issue #1128: auto mode's per-resource fallback is an `aws:cdk:path` tag
    // walk, and that tag cannot exist on AWS (AWS rejects `aws:`-prefixed tag
    // writes; CloudFormation keeps the value in template `Metadata`). So a
    // resource whose physical name CloudFormation generated came back
    // `not found`. Auto mode now asks CloudFormation directly first.
    describe('auto-mode CloudFormation lookup (#1128)', () => {
      it('uses the CFn physical id when a stack of the same name exists', async () => {
        const { importSpy } = setupHappyPath();
        mockTryGetCfnResourceMap.mockResolvedValue(new Map([['MyBucket', 'cfn-derived-bucket']]));

        await runImport(['import', '--app', 'x', '--yes']);

        // The provider must receive the CFn-resolved id as knownPhysicalId,
        // so its own name/tag lookup is never needed.
        expect(importSpy.mock.calls[0]![0]).toMatchObject({
          knownPhysicalId: 'cfn-derived-bucket',
        });
      });

      it('does not flip into selective mode on CFn-derived ids', async () => {
        // Selective mode is keyed on user-supplied overrides. CFn-derived ids
        // are not user intent to narrow scope -- treating them as such would
        // mark every other template resource `out of scope`.
        setupHappyPath();
        mockTryGetCfnResourceMap.mockResolvedValue(new Map([['MyBucket', 'cfn-derived-bucket']]));

        await runImport(['import', '--app', 'x', '--yes']);

        expect(infoSpy.mock.calls.flat().join(' ')).not.toContain('Selective mode');
      });

      it('lets a user --resource override win over the CFn-derived id', async () => {
        const { importSpy } = setupHappyPath();
        mockTryGetCfnResourceMap.mockResolvedValue(new Map([['MyBucket', 'cfn-derived-bucket']]));

        await runImport(['import', '--app', 'x', '--yes', '--auto', '--resource', 'MyBucket=mine']);

        expect(importSpy.mock.calls[0]![0]).toMatchObject({ knownPhysicalId: 'mine' });
      });

      it('falls through to the per-provider lookup when no CFn stack exists', async () => {
        const { importSpy } = setupHappyPath();
        mockTryGetCfnResourceMap.mockResolvedValue(null);

        await runImport(['import', '--app', 'x', '--yes']);

        // No knownPhysicalId -> the provider does its own name/tag lookup,
        // exactly as before #1128.
        expect(importSpy.mock.calls[0]![0].knownPhysicalId).toBeUndefined();
      });

      it('skips the lookup entirely in selective mode', async () => {
        // Selective mode already has every id the user cares about; a
        // speculative DescribeStackResources would be a wasted call.
        setupHappyPath();
        await runImport(['import', '--app', 'x', '--yes', '--resource', 'MyBucket=mine']);
        expect(mockTryGetCfnResourceMap).not.toHaveBeenCalled();
      });

      it('skips the lookup when --migrate-from-cloudformation already resolves ids', async () => {
        setupHappyPath('cfn-bucket-physical');
        await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);
        expect(mockTryGetCfnResourceMap).not.toHaveBeenCalled();
        expect(mockGetCfnResourceTree).toHaveBeenCalledTimes(1);
      });
    });

    it('does not walk the CFn tree or retire when the flag is omitted', async () => {
      // Auto mode DOES consult CloudFormation for physical ids (#1128), but
      // only via the flat, non-throwing lookup. The recursive tree walk and
      // the retirement remain exclusive to --migrate-from-cloudformation:
      // adopting a stack must never silently delete the CFn stack behind it.
      setupHappyPath();
      await runImport(['import', '--app', 'x', '--yes']);
      expect(mockGetCfnResourceTree).not.toHaveBeenCalled();
      expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
      expect(mockTryGetCfnResourceMap).toHaveBeenCalledTimes(1);
    });

    it('resolves CFn physical IDs and retires using the cdkd stack name by default', async () => {
      const { importSpy } = setupHappyPath('cfn-bucket-physical');
      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      // Physical IDs resolved from CFn before the import loop.
      expect(mockGetCfnResourceTree).toHaveBeenCalledTimes(1);
      expect(mockGetCfnResourceTree.mock.calls[0]![0]).toBe('S');
      // Each provider import received the CFn-resolved physical id as
      // `knownPhysicalId` — without --resource on the CLI.
      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalId: 'MyBucket',
          knownPhysicalId: 'cfn-bucket-physical',
        })
      );
      // Retirement runs with the same stack name and is given the
      // resolved cdkd state bucket so the >51,200-byte TemplateURL
      // fallback can write its transient template there.
      expect(mockRetireCloudFormationStack).toHaveBeenCalledTimes(1);
      const arg = mockRetireCloudFormationStack.mock.calls[0]![0] as {
        cfnStackName: string;
        yes: boolean;
        stateBucket: string;
      };
      expect(arg.cfnStackName).toBe('S');
      expect(arg.yes).toBe(true);
      expect(arg.stateBucket).toBeDefined();
      expect(arg.stateBucket.length).toBeGreaterThan(0);
    });

    it('uses the explicit value when --migrate-from-cloudformation <name> is given', async () => {
      setupHappyPath();
      await runImport([
        'import',
        '--app',
        'x',
        '--yes',
        '--migrate-from-cloudformation',
        'LegacyCfnName',
      ]);

      // Both CFn calls target the explicit name.
      expect(mockGetCfnResourceTree.mock.calls[0]![0]).toBe('LegacyCfnName');
      const retireArg = mockRetireCloudFormationStack.mock.calls[0]![0] as {
        cfnStackName: string;
      };
      expect(retireArg.cfnStackName).toBe('LegacyCfnName');
    });

    it('user --resource overrides take precedence over CFn-derived physical IDs', async () => {
      const tmpl = oneResource();
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'user-said', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });
      mockGetCfnResourceTree.mockResolvedValue({
        stackName: 'S',
        physicalId: 'S',
        resources: new Map([['MyBucket', 'cfn-said']]),
        nested: new Map(),
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=user-said',
        '--migrate-from-cloudformation',
        '--yes',
      ]);

      // The provider gets the user-supplied id, not the CFn-derived one.
      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'user-said' })
      );
    });

    it('does not flip into selective mode when only --migrate-from-cloudformation is set', async () => {
      // Two template resources, both resolved by CFn. Without selective-mode
      // suppression, the populated `overrides` would otherwise force
      // selective mode and skip everything as out-of-scope.
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        MyTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyTopic' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      const bucketImport = vi.fn(async () => ({ physicalId: 'b', attributes: {} }));
      const topicImport = vi.fn(async () => ({ physicalId: 't', attributes: {} }));
      mockGetProvider.mockImplementation((type: string) => {
        if (type === 'AWS::S3::Bucket') return { import: bucketImport };
        if (type === 'AWS::SNS::Topic') return { import: topicImport };
        return {};
      });
      mockGetCfnResourceTree.mockResolvedValue({
        stackName: 'S',
        physicalId: 'S',
        resources: new Map([
          ['MyBucket', 'b-physical'],
          ['MyTopic', 't-physical'],
        ]),
        nested: new Map(),
      });

      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      // Both providers ran (auto mode), neither resource was reported
      // out-of-scope.
      expect(bucketImport).toHaveBeenCalledTimes(1);
      expect(topicImport).toHaveBeenCalledTimes(1);
      const summaryCall = infoSpy.mock.calls.find((c) =>
        String(c[0]).startsWith('Summary:')
      );
      expect(String(summaryCall?.[0])).toMatch(/0 out of scope/);
    });

    it('orders the calls correctly: CFn mapping → import → save → retire', async () => {
      const { importSpy } = setupHappyPath();
      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      const mapOrder = mockGetCfnResourceTree.mock.invocationCallOrder[0]!;
      const importOrder = importSpy.mock.invocationCallOrder[0]!;
      const saveOrder = mockSaveState.mock.invocationCallOrder[0]!;
      const retireOrder = mockRetireCloudFormationStack.mock.invocationCallOrder[0]!;

      expect(mapOrder).toBeLessThan(importOrder);
      expect(importOrder).toBeLessThan(saveOrder);
      expect(saveOrder).toBeLessThan(retireOrder);
    });

    it('does not retire when state write was skipped (zero successful imports)', async () => {
      // Empty template ⇒ zero imports ⇒ no state write ⇒ no retirement.
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', template({}))] });
      mockHasProvider.mockReturnValue(false);

      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      // CFn mapping still resolved (we paid the round-trip), but neither
      // saveState nor retire ran.
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
    });

    it('warns when a partial import leaves resources unmanaged after retirement', async () => {
      // Two-resource template, only one provider; the unimported resource
      // becomes an AWS orphan once the CFn stack is retired.
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        Untouched: {
          Type: 'AWS::Foo::Bar', // no provider
          Properties: {},
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
      });
      mockGetCfnResourceTree.mockResolvedValue({
        stackName: 'S',
        physicalId: 'S',
        resources: new Map([
          ['MyBucket', 'b-physical'],
          ['Untouched', 'u-physical'],
        ]),
        nested: new Map(),
      });

      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/1 of 2 template resource\(s\) were NOT imported/)
      );
      // Retirement still runs (warning is informational, not a refusal).
      expect(mockRetireCloudFormationStack).toHaveBeenCalledTimes(1);
    });

    it('rejects --dry-run combined with --migrate-from-cloudformation', async () => {
      setupHappyPath();

      await expect(
        runImport(['import', '--app', 'x', '--migrate-from-cloudformation', '--dry-run'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/not compatible with --dry-run/);
      // Reject at parse time — never hit AWS.
      expect(mockGetCfnResourceTree).not.toHaveBeenCalled();
      expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
    });

    // ---- Issue #464: recursive nested-stack support ----
    describe('nested-stack recursive walk (issue #464)', () => {
      it('short-circuits AWS::CloudFormation::Stack rows to cdkd-local synth ARN (no provider.import)', async () => {
        // Parent template carries one nested-stack row + one leaf bucket.
        // The dispatch loop must NOT call provider.import for the nested
        // row (NestedStackProvider has no import()) and must record the
        // synthesized cdkd-local ARN in state — matching what
        // NestedStackProvider.create would write at deploy time.
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          const childTemplateBody = { Resources: { ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } };
          // Write the child template so the per-child walk can read it.
          (await import('node:fs')).writeFileSync(childTemplatePath, JSON.stringify(childTemplateBody));

          const tmpl = template({
            Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          const stackInfoWithNested = {
            ...stackInfo('S', tmpl),
            nestedTemplates: { Child: childTemplatePath },
          };
          mockSynthesize.mockResolvedValue({ stacks: [stackInfoWithNested] });
          mockHasProvider.mockImplementation(
            (t: string) => t !== 'AWS::CloudFormation::Stack'
          );
          const bucketImport = vi.fn(async () => ({ physicalId: 'bucket-real', attributes: {} }));
          const childBucketImport = vi.fn(async () => ({
            physicalId: 'child-bucket-real',
            attributes: {},
          }));
          mockGetProvider.mockImplementation((t: string) => {
            if (t === 'AWS::S3::Bucket') {
              // Both the root Bucket and the ChildBucket land here — the
              // per-child walk uses the same provider registry.
              return { import: bucketImport.mock.calls.length === 0 ? bucketImport : childBucketImport };
            }
            return {};
          });

          const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
          mockGetCfnResourceTree.mockResolvedValue({
            stackName: 'S',
            physicalId: 'S',
            resources: new Map([
              ['Bucket', 'bucket-real'],
              ['Child', childArn],
            ]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: childArn,
                  physicalId: childArn,
                  resources: new Map([['ChildBucket', 'child-bucket-real']]),
                  nested: new Map(),
                },
              ],
            ]),
          });

          await runImport(['import', 'S', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

          // Root state save: 2 entries (Bucket + Child). Child's
          // physicalId is the synth cdkd-local ARN (NOT the AWS child ARN).
          expect(mockSaveState).toHaveBeenCalled();
          const rootSave = mockSaveState.mock.calls.find(
            (c) => (c as unknown[])[0] === 'S'
          ) as unknown as [
            string,
            string,
            { resources: Record<string, { physicalId: string; resourceType: string }> },
          ];
          expect(rootSave).toBeDefined();
          expect(rootSave[2].resources['Child']!.physicalId).toMatch(
            /^arn:cdkd-local:.*:nested-stack\/S\/Child$/
          );
          expect(rootSave[2].resources['Child']!.resourceType).toBe('AWS::CloudFormation::Stack');
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it("writes the child's state under cdkd/<parent>~<child>/<region>/state.json with parentStack populated", async () => {
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          writeFileSync(
            childTemplatePath,
            JSON.stringify({
              Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
            })
          );
          const tmpl = template({
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          mockSynthesize.mockResolvedValue({
            stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
          });
          mockHasProvider.mockImplementation(
            (t: string) => t !== 'AWS::CloudFormation::Stack'
          );
          mockGetProvider.mockReturnValue({
            import: vi.fn(async () => ({ physicalId: 'b-real', attributes: {} })),
          });
          const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
          mockGetCfnResourceTree.mockResolvedValue({
            stackName: 'P',
            physicalId: 'P',
            resources: new Map([['Child', childArn]]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: childArn,
                  physicalId: childArn,
                  resources: new Map([['Bucket', 'b-real']]),
                  nested: new Map(),
                },
              ],
            ]),
          });

          await runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

          // Child state save: keyed by `P~Child`, carries parent-link fields.
          const childSave = mockSaveState.mock.calls.find(
            (c) => (c as unknown[])[0] === 'P~Child'
          ) as unknown as [
            string,
            string,
            {
              parentStack?: string;
              parentLogicalId?: string;
              parentRegion?: string;
              resources: Record<string, unknown>;
              version: number;
            },
          ];
          expect(childSave).toBeDefined();
          expect(childSave[1]).toBe('us-east-1');
          expect(childSave[2].parentStack).toBe('P');
          expect(childSave[2].parentLogicalId).toBe('Child');
          expect(childSave[2].parentRegion).toBe('us-east-1');
          expect(Object.keys(childSave[2].resources)).toContain('Bucket');
          // Per-child lock acquired + released.
          const childLockAcquire = mockAcquireLock.mock.calls.find(
            (c) => (c as unknown[])[0] === 'P~Child'
          );
          const childLockRelease = mockReleaseLock.mock.calls.find(
            (c) => (c as unknown[])[0] === 'P~Child'
          );
          expect(childLockAcquire).toBeDefined();
          expect(childLockRelease).toBeDefined();
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it("passes the pre-built resourceTree to retireCloudFormationStack", async () => {
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          writeFileSync(
            childTemplatePath,
            JSON.stringify({
              Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
            })
          );
          const tmpl = template({
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          mockSynthesize.mockResolvedValue({
            stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
          });
          mockHasProvider.mockImplementation(
            (t: string) => t !== 'AWS::CloudFormation::Stack'
          );
          mockGetProvider.mockReturnValue({
            import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
          });
          const tree = {
            stackName: 'P',
            physicalId: 'P',
            resources: new Map([['Child', 'arn:...:stack/Child/u']]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: 'arn:...:stack/Child/u',
                  physicalId: 'arn:...:stack/Child/u',
                  resources: new Map([['B', 'b']]),
                  nested: new Map(),
                },
              ],
            ]),
          };
          mockGetCfnResourceTree.mockResolvedValue(tree);

          await runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

          expect(mockRetireCloudFormationStack).toHaveBeenCalledTimes(1);
          const arg = mockRetireCloudFormationStack.mock.calls[0]![0] as { resourceTree?: unknown };
          expect(arg.resourceTree).toBe(tree);
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it('releases the per-child lock in finally even when provider.import throws mid-walk', async () => {
        // Memory rule `feedback_destructive_state_test_coverage.md`:
        // failure paths of state-mutating code must verify the cleanup
        // contract holds. Here: `importNestedStackChildrenRecursive`
        // acquires the child's lock before its per-resource dispatch
        // loop and releases it in `finally` — if `importOne` (via
        // `provider.import`) throws mid-walk, the lock MUST still be
        // released before the error propagates up.
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-failure-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          writeFileSync(
            childTemplatePath,
            JSON.stringify({
              Resources: {
                Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
              },
            })
          );
          const tmpl = template({
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          mockSynthesize.mockResolvedValue({
            stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
          });
          mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
          // Make the child's import throw — `importOne` catches at the
          // provider level and returns a `failed` row (not a thrown
          // exception), so we need to fail in a way that bubbles UP
          // past the dispatch loop. Easiest: throw from `provider.import`
          // BUT the `importOne` catch wraps it as `failed`, never
          // throws. So instead force a state-save failure (downstream
          // of the dispatch loop, inside the lock-protected scope) by
          // making mockSaveState throw on the child stack name.
          const bucketImportSpy = vi.fn(async () => ({ physicalId: 'b', attributes: {} }));
          mockGetProvider.mockReturnValue({ import: bucketImportSpy });
          mockGetCfnResourceTree.mockResolvedValue({
            stackName: 'P',
            physicalId: 'P',
            resources: new Map([['Child', 'arn:..:stack/Child/u']]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: 'arn:..:stack/Child/u',
                  physicalId: 'arn:..:stack/Child/u',
                  resources: new Map([['Bucket', 'b']]),
                  nested: new Map(),
                },
              ],
            ]),
          });
          // saveState throws ONLY for the child stack (parent's save
          // succeeds first); the child's `finally` should still release
          // the child's lock before the error propagates to runImport's
          // outer finally.
          mockSaveState.mockImplementation((stackName: unknown) => {
            if (stackName === 'P~Child') {
              return Promise.reject(new Error('synthetic child saveState failure'));
            }
            return Promise.resolve('etag');
          });

          await expect(
            runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation'])
          ).rejects.toThrow();

          // Per-child lock was acquired then released, even though
          // child saveState threw — this is the load-bearing assertion.
          const childAcquires = mockAcquireLock.mock.calls.filter(
            (c) => (c as unknown[])[0] === 'P~Child'
          );
          const childReleases = mockReleaseLock.mock.calls.filter(
            (c) => (c as unknown[])[0] === 'P~Child'
          );
          expect(childAcquires).toHaveLength(1);
          expect(childReleases).toHaveLength(1);
          // Root lock also released (runImport's outer finally).
          const rootReleases = mockReleaseLock.mock.calls.filter(
            (c) => (c as unknown[])[0] === 'P'
          );
          expect(rootReleases).toHaveLength(1);
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it("applies the Default-only retry to the NESTED CHILD's own parameters too (issue #2321)", async () => {
        // COVERAGE for the SECOND call site of `resolveImportedProperties`
        // (the recursive child walk). Every other #2321 case drives only the
        // ROOT site, so a fix applied at one and not the other would pass
        // them all -- the helper is shared today, and this case is what keeps
        // the two from diverging.
        //
        // The CHILD template carries the mixed parameter shape: `VpcId`
        // required (so the child's own `resolveParameters` throws) plus
        // `Stage` defaulted. A nested child is exactly where this bites in
        // practice, since CDK threads parent values down as child Parameters.
        //
        // THE DISCRIMINATOR is the value in the CHILD's state record:
        // `child-dev-bucket` versus the verbatim `child-${Stage}-bucket`.
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-2321-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          writeFileSync(
            childTemplatePath,
            JSON.stringify({
              Parameters: {
                VpcId: { Type: 'String' },
                Stage: { Type: 'String', Default: 'dev' },
              },
              Resources: {
                ChildBucket: {
                  Type: 'AWS::S3::Bucket',
                  Properties: { BucketName: { 'Fn::Sub': 'child-${Stage}-bucket' } },
                },
              },
            })
          );
          const tmpl = template({
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          mockSynthesize.mockResolvedValue({
            stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
          });
          mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
          mockGetProvider.mockReturnValue({
            import: vi.fn(async () => ({ physicalId: 'child-bucket-real', attributes: {} })),
          });
          const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
          mockGetCfnResourceTree.mockResolvedValue({
            stackName: 'P',
            physicalId: 'P',
            resources: new Map([['Child', childArn]]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: childArn,
                  physicalId: childArn,
                  resources: new Map([['ChildBucket', 'child-bucket-real']]),
                  nested: new Map(),
                },
              ],
            ]),
          });

          await runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

          const childSave = mockSaveState.mock.calls.find(
            (c) => (c as unknown[])[0] === 'P~Child'
          ) as unknown as [
            string,
            string,
            { resources: Record<string, { properties: Record<string, unknown> }> },
          ];
          expect(childSave).toBeDefined();
          expect(childSave[2].resources['ChildBucket']?.properties['BucketName']).toBe(
            'child-dev-bucket'
          );
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it('errors with clear message when STS GetCallerIdentity returns no Account', async () => {
        // The recursive nested-stack flow needs the caller's AWS account ID
        // to synthesize the cdkd-local ARN it writes into the parent's
        // state for the nested-stack row (mirrors what
        // `NestedStackProvider.create` does at deploy time — issue #464).
        // When STS returns no `Account`, the flow must abort up front with
        // an actionable message instead of silently writing a malformed
        // ARN downstream.
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-sts-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          writeFileSync(
            childTemplatePath,
            JSON.stringify({
              Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
            })
          );
          const tmpl = template({
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          mockSynthesize.mockResolvedValue({
            stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
          });
          mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
          mockGetProvider.mockReturnValue({
            import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
          });
          const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
          mockGetCfnResourceTree.mockResolvedValue({
            stackName: 'P',
            physicalId: 'P',
            resources: new Map([['Child', childArn]]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: childArn,
                  physicalId: childArn,
                  resources: new Map([['B', 'b']]),
                  nested: new Map(),
                },
              ],
            ]),
          });
          // Override the STS GetCallerIdentity response for this single
          // call — return an empty object (no `Account` field).
          stsSend.mockResolvedValueOnce({} as never);

          await expect(
            runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation'])
          ).rejects.toThrow();
          const lastError = String(errorSpy.mock.calls.at(-1)?.[0]);
          expect(lastError).toMatch(/STS GetCallerIdentity returned no Account/);
          // Bail-out happens before any state write or retire round-trip.
          expect(mockSaveState).not.toHaveBeenCalled();
          expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it('writes child state recursively for depth-2 (grandchild) nested stacks', async () => {
        // Verifies `importNestedStackChildrenRecursive` recurses past the
        // first level — for a Parent → Child → Grandchild tree, three
        // `saveState` calls must land: one for the root, one for the
        // child (keyed `P~Child`), one for the grandchild (keyed
        // `P~Child~Grandchild`). Each child carries the v6 parent-link
        // fields pointing one level up.
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-d2-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          const grandchildTemplatePath = join(tmpdirPath, 'Grandchild.nested.template.json');
          // Grandchild leaf template.
          writeFileSync(
            grandchildTemplatePath,
            JSON.stringify({
              Resources: {
                GrandchildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
              },
            })
          );
          // Child template carries one leaf bucket + the grandchild
          // nested-stack row. Metadata['aws:asset:path'] is what
          // `indexGrandchildTemplatePaths` reads to find the grandchild
          // file on disk — use the leaf filename so `path.join(dir, ...)`
          // resolves to the actual file.
          writeFileSync(
            childTemplatePath,
            JSON.stringify({
              Resources: {
                ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
                Grandchild: {
                  Type: 'AWS::CloudFormation::Stack',
                  Properties: { TemplateURL: 'x' },
                  Metadata: { 'aws:asset:path': 'Grandchild.nested.template.json' },
                },
              },
            })
          );
          const tmpl = template({
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          mockSynthesize.mockResolvedValue({
            stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
          });
          mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
          mockGetProvider.mockReturnValue({
            import: vi.fn(async () => ({ physicalId: 'phys', attributes: {} })),
          });
          const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid-c';
          const grandchildArn =
            'arn:aws:cloudformation:us-east-1:123:stack/Grandchild/uuid-g';
          mockGetCfnResourceTree.mockResolvedValue({
            stackName: 'P',
            physicalId: 'P',
            resources: new Map([['Child', childArn]]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: childArn,
                  physicalId: childArn,
                  resources: new Map([
                    ['ChildBucket', 'cb-real'],
                    ['Grandchild', grandchildArn],
                  ]),
                  nested: new Map([
                    [
                      'Grandchild',
                      {
                        stackName: grandchildArn,
                        physicalId: grandchildArn,
                        resources: new Map([['GrandchildBucket', 'gb-real']]),
                        nested: new Map(),
                      },
                    ],
                  ]),
                },
              ],
            ]),
          });

          await runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

          // Three saveState calls — root, child, grandchild.
          const saveCalls = mockSaveState.mock.calls.map((c) => (c as unknown[])[0]);
          expect(saveCalls).toContain('P');
          expect(saveCalls).toContain('P~Child');
          expect(saveCalls).toContain('P~Child~Grandchild');

          // Region is propagated parent → child → grandchild.
          const grandSave = mockSaveState.mock.calls.find(
            (c) => (c as unknown[])[0] === 'P~Child~Grandchild'
          ) as unknown as [
            string,
            string,
            {
              parentStack?: string;
              parentLogicalId?: string;
              parentRegion?: string;
              resources: Record<string, unknown>;
            },
          ];
          expect(grandSave[1]).toBe('us-east-1');
          // Parent-link fields point one level up (NOT to the root).
          expect(grandSave[2].parentStack).toBe('P~Child');
          expect(grandSave[2].parentLogicalId).toBe('Grandchild');
          expect(grandSave[2].parentRegion).toBe('us-east-1');
          expect(Object.keys(grandSave[2].resources)).toContain('GrandchildBucket');
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it('rejects absolute aws:asset:path on grandchild nested templates', async () => {
        // `indexGrandchildTemplatePaths` refuses absolute paths on
        // grandchild nested-stack rows — `path.join(dir, '/abs/foo')`
        // would silently bypass the cloud assembly's directory and
        // point outside cdk.out, so the recursive walker fails up front
        // with a clear error.
        const tmpdirPath = mkdtempSync(join(tmpdir(), 'cdkd-import-nested-abs-'));
        try {
          const childTemplatePath = join(tmpdirPath, 'Child.nested.template.json');
          // Child carries a grandchild nested-stack row with an absolute
          // `aws:asset:path`.
          writeFileSync(
            childTemplatePath,
            JSON.stringify({
              Resources: {
                Grandchild: {
                  Type: 'AWS::CloudFormation::Stack',
                  Properties: { TemplateURL: 'x' },
                  Metadata: { 'aws:asset:path': '/abs/foo.json' },
                },
              },
            })
          );
          const tmpl = template({
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          });
          mockSynthesize.mockResolvedValue({
            stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
          });
          mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
          mockGetProvider.mockReturnValue({
            import: vi.fn(async () => ({ physicalId: 'phys', attributes: {} })),
          });
          const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
          const grandchildArn =
            'arn:aws:cloudformation:us-east-1:123:stack/Grandchild/uuid';
          mockGetCfnResourceTree.mockResolvedValue({
            stackName: 'P',
            physicalId: 'P',
            resources: new Map([['Child', childArn]]),
            nested: new Map([
              [
                'Child',
                {
                  stackName: childArn,
                  physicalId: childArn,
                  resources: new Map([['Grandchild', grandchildArn]]),
                  nested: new Map([
                    [
                      'Grandchild',
                      {
                        stackName: grandchildArn,
                        physicalId: grandchildArn,
                        resources: new Map(),
                        nested: new Map(),
                      },
                    ],
                  ]),
                },
              ],
            ]),
          });

          await expect(
            runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation'])
          ).rejects.toThrow();
          const lastError = String(errorSpy.mock.calls.at(-1)?.[0]);
          expect(lastError).toMatch(/grandchild nested-stack/);
          expect(lastError).toMatch(/absolute/);
          expect(lastError).toMatch(/Grandchild/);
        } finally {
          rmSync(tmpdirPath, { recursive: true, force: true });
        }
      });

      it('rejects when synth template ↔ AWS tree have mismatched nested-stack ids', async () => {
        const tmpl = template({
          AOnly: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
        });
        mockSynthesize.mockResolvedValue({
          stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { AOnly: '/tmp/x' } }],
        });
        mockHasProvider.mockReturnValue(false);
        // AWS reports a DIFFERENT nested child than the synth template.
        mockGetCfnResourceTree.mockResolvedValue({
          stackName: 'P',
          physicalId: 'P',
          resources: new Map(),
          nested: new Map([
            [
              'BOnly',
              {
                stackName: 'arn:..b',
                physicalId: 'arn:..b',
                resources: new Map(),
                nested: new Map(),
              },
            ],
          ]),
        });

        await expect(
          runImport(['import', 'P', '--app', 'x', '--yes', '--migrate-from-cloudformation'])
        ).rejects.toThrow();
        // The error names BOTH directions of the mismatch.
        const lastError = String(errorSpy.mock.calls.at(-1)?.[0]);
        expect(lastError).toMatch(/AOnly/);
        expect(lastError).toMatch(/BOnly/);
        expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
      });
    });
  });

  // Closes issue #328: pre-fix, `buildStackState` wrote the synth
  // template's Properties literal into `state.properties` verbatim —
  // intrinsics (Ref / Fn::GetAtt / Fn::Sub) and all — which broke
  // `cdkd destroy` for sub-resource types whose `delete()` reads
  // properties at delete time (e.g. AWS::Lambda::Permission whose
  // `FunctionName` is `{Fn::GetAtt: [..., 'Arn']}`). After import,
  // every resource's `state.properties` must hold resolved values, the
  // same shape `cdkd deploy` writes.
  describe('intrinsic resolution in state.properties (issue #328)', () => {
    it('resolves Fn::GetAtt: [..., "Arn"] in Lambda Permission FunctionName to the function ARN', async () => {
      // Canonical bug repro: AWS::Lambda::Permission.FunctionName carries
      // `{Fn::GetAtt: [MyFn, 'Arn']}` in the synth template. After
      // import, state.properties.FunctionName must be the resolved ARN
      // string, NOT the intrinsic object — otherwise `cdkd destroy`
      // passes the raw `{Fn::GetAtt: ...}` to RemovePermission's
      // FunctionName field and AWS rejects with `1 validation error
      // detected: ... failed to satisfy constraint`.
      const tmpl = template({
        MyFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyFn' },
        },
        MyPerm: {
          Type: 'AWS::Lambda::Permission',
          Properties: {
            FunctionName: { 'Fn::GetAtt': ['MyFn', 'Arn'] },
            Action: 'lambda:InvokeFunction',
            Principal: 'apigateway.amazonaws.com',
          },
          Metadata: { 'aws:cdk:path': 'S/MyPerm' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::Lambda::Function') {
          return { import: vi.fn(async () => ({ physicalId: 'my-fn-1234ABCD', attributes: {} })) };
        }
        if (t === 'AWS::Lambda::Permission') {
          return { import: vi.fn(async () => ({ physicalId: 'my-fn-1234ABCD/perm-id', attributes: {} })) };
        }
        return {};
      });

      await runImport(['import', '--app', 'x', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      // The Lambda function arn is constructed deterministically by
      // `constructAttribute` from the resolved Lambda physicalId.
      // Without an STS mock, the resolver's getAccountInfo falls back
      // to '123456789012' / 'us-east-1' / 'aws'.
      expect(state.resources['MyPerm']?.properties['FunctionName']).toBe(
        'arn:aws:lambda:us-east-1:123456789012:function:my-fn-1234ABCD'
      );
      // Untouched literal properties survive the resolver pass.
      expect(state.resources['MyPerm']?.properties['Action']).toBe('lambda:InvokeFunction');
      expect(state.resources['MyPerm']?.properties['Principal']).toBe('apigateway.amazonaws.com');
    });

    it('resolves Ref to a sibling resource\'s physical ID', async () => {
      // IAM Policy on a Role: `Roles: [{Ref: MyRole}]` → resolves to
      // `Roles: [<physicalId>]` after import. Same shape that `cdkd
      // deploy` writes.
      const tmpl = template({
        MyRole: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Statement: [] } },
          Metadata: { 'aws:cdk:path': 'S/MyRole' },
        },
        MyPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'my-policy',
            PolicyDocument: { Statement: [] },
            Roles: [{ Ref: 'MyRole' }],
          },
          Metadata: { 'aws:cdk:path': 'S/MyPolicy' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::IAM::Role') {
          return { import: vi.fn(async () => ({ physicalId: 'my-role-physical', attributes: {} })) };
        }
        if (t === 'AWS::IAM::Policy') {
          return { import: vi.fn(async () => ({ physicalId: 'my-policy-physical', attributes: {} })) };
        }
        return {};
      });

      await runImport(['import', '--app', 'x', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      expect(state.resources['MyPolicy']?.properties['Roles']).toEqual(['my-role-physical']);
      expect(state.resources['MyPolicy']?.properties['PolicyName']).toBe('my-policy');
    });

    it('leaves literal properties untouched (no intrinsics is a no-op pass)', async () => {
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: 'my-bucket-12345',
            VersioningConfiguration: { Status: 'Enabled' },
          },
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'my-bucket-12345', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      expect(state.resources['MyBucket']?.properties).toEqual({
        BucketName: 'my-bucket-12345',
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    it('names the UNBINDABLE PARAMETER in the warn, and persists the raw Fn::Sub rather than the literal (issue #2285)', async () => {
      // The end-to-end shape of issue #2285. `resolveParameters` throws on
      // `Stage` (declared, no `Default`), and `resolveImportedProperties`
      // catches it and resolves anyway on a context that is NOT `bestEffort`,
      // so the `Fn::Sub` reaches the resolver unbindable. This template
      // declares NOTHING but that one parameter, so issue #2321's
      // `Default`-only retry has nothing to bind and the bag stays EMPTY --
      // which is what keeps this arm a test of the refusal rather than of the
      // bag.
      //
      // THE DISCRIMINATOR is what lands in state. Before the fix the resolver
      // kept the placeholder and `topic-${Stage}` was persisted as a literal
      // STRING -- which then becomes the desired bag of the next `cdkd deploy`
      // and the bag `cdkd destroy` hands a provider. It must now be the raw
      // intrinsic OBJECT instead.
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: { Stage: { Type: 'String' } },
        Resources: {
          MyTopic: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: { 'Fn::Sub': 'topic-${Stage}' } },
            Metadata: { 'aws:cdk:path': 'S/MyTopic' },
          },
        },
      } as unknown as CloudFormationTemplate;
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'topic-arn', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      const topicName = state.resources['MyTopic']?.properties['TopicName'];
      expect(topicName).toEqual({ 'Fn::Sub': 'topic-${Stage}' });
      expect(topicName).not.toBe('topic-${Stage}');

      const warned = warnSpy.mock.calls.flat().join('\n');
      // The parameter is NAMED, so the operator knows which one to give a
      // `Default`; `cdkd import` has no flag that could bind it.
      expect(warned).toContain(
        "declares parameter(s) with no 'Default' that an import cannot bind (Stage)"
      );
      // The pre-existing sibling-shaped guidance is NOT replaced -- both
      // causes reach this catch.
      expect(warned).toContain("remove this resource via 'cdkd state orphan'");
    });

    it("binds a sibling parameter's own Default when another parameter is unbindable, so its Fn::Sub is RESOLVED not persisted verbatim (issue #2321)", async () => {
      // Issue #2321. `resolveParameters` is all-or-nothing: it throws on
      // `VpcId` (declared, no `Default`), and `resolveImportedProperties` used
      // to continue with an EMPTY bag -- discarding `Stage`'s `Default` along
      // with it. Issue #2285's refusal cannot close that hole, because `Stage`
      // HAS a `Default` and is therefore correctly OUT of the unbound
      // population, so the placeholder was kept and laundered.
      //
      // THE DISCRIMINATOR is the recorded value of a property built from the
      // DEFAULTED parameter. Pre-fix it is the literal STRING
      // `app-${Stage}-topic` (the placeholder verbatim, which then becomes the
      // desired bag of the next `cdkd deploy` and the bag `cdkd destroy` hands
      // a provider); post-fix it is `app-dev-topic`, the template's own
      // declared default. A test asserting only that the import SUCCEEDS would
      // pass in both worlds.
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          VpcId: { Type: 'String' },
          Stage: { Type: 'String', Default: 'dev' },
        },
        Resources: {
          MyTopic: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: { 'Fn::Sub': 'app-${Stage}-topic' } },
            Metadata: { 'aws:cdk:path': 'S/MyTopic' },
          },
        },
      } as unknown as CloudFormationTemplate;
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'topic-arn', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      expect(state.resources['MyTopic']?.properties['TopicName']).toBe('app-dev-topic');
      // Nothing failed for this resource, so no per-resource warning at all --
      // the pre-fix world reached the SAME `saveState` with a laundered value
      // and no warning either, which is why the assertion above is on the
      // recorded VALUE and not on the absence of a warn.
      expect(warnSpy.mock.calls.flat().join('\n')).not.toContain(
        "Failed to resolve intrinsics in Properties for imported resource 'MyTopic'"
      );
    });

    it('still refuses the UNBINDABLE parameter and names only it, while its Default-carrying sibling resolves (issues #2285 + #2321)', async () => {
      // The two behaviours have to hold in the SAME template, because the
      // #2321 remedy is a partially-bound bag and the obvious wrong version of
      // it -- binding every declared parameter to something -- would move
      // `VpcId` out of `isUnboundTemplateParameter`'s population and silently
      // undo #2285.
      //
      // DISCRIMINATORS, one per resource:
      //   - MyTopic: `app-dev-topic` vs the pre-#2321 literal `app-${Stage}-topic`.
      //   - MyQueue: the raw `Fn::Sub` OBJECT plus a warn clause naming
      //     `(VpcId)` and NOT `Stage` -- a bag that over-bound would drop the
      //     clause entirely and record a bound-to-junk `app-<x>-queue` string.
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          VpcId: { Type: 'String' },
          Stage: { Type: 'String', Default: 'dev' },
        },
        Resources: {
          MyTopic: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: { 'Fn::Sub': 'app-${Stage}-topic' } },
            Metadata: { 'aws:cdk:path': 'S/MyTopic' },
          },
          MyQueue: {
            Type: 'AWS::SQS::Queue',
            Properties: { QueueName: { 'Fn::Sub': 'app-${VpcId}-queue' } },
            Metadata: { 'aws:cdk:path': 'S/MyQueue' },
          },
        },
      } as unknown as CloudFormationTemplate;
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::SNS::Topic') {
          return { import: vi.fn(async () => ({ physicalId: 'topic-arn', attributes: {} })) };
        }
        return { import: vi.fn(async () => ({ physicalId: 'queue-url', attributes: {} })) };
      });

      await runImport(['import', '--app', 'x', '--yes']);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      // The defaulted parameter binds.
      expect(state.resources['MyTopic']?.properties['TopicName']).toBe('app-dev-topic');
      // NEGATIVE CONTROL: the unbindable one is still REFUSED, so the raw
      // intrinsic object is what reaches state -- issue #2285 is not weakened.
      expect(state.resources['MyQueue']?.properties['QueueName']).toEqual({
        'Fn::Sub': 'app-${VpcId}-queue',
      });

      const warned = warnSpy.mock.calls.flat().join('\n');
      expect(warned).toContain(
        "Failed to resolve intrinsics in Properties for imported resource 'MyQueue'"
      );
      // The warn arm still enumerates EXACTLY the genuinely unbound
      // parameters. Asserted on the parsed clause rather than by substring, so
      // a list that grew to `VpcId, Stage` cannot pass on the `VpcId` match.
      const clause = /declares parameter\(s\) with no 'Default' that an import cannot bind \(([^)]*)\)/.exec(
        warned
      );
      expect(clause?.[1]).toBe('VpcId');
    });

    it("binds a FALSY Default -- the `'Default' in definition` presence test, not truthiness (issue #2321)", async () => {
      // FENCE for the spelling `defaultOnlyParameterTemplate` uses. The filter
      // asks `'Default' in definition`; the two natural rewrites are
      // `Boolean(d.Default)` and `d.Default !== undefined`, and BOTH pass every
      // other case in this file, so without this pair the spelling is free to
      // drift into a bug.
      //
      // `Default: ''` is the standard CFn idiom for an optional String (as are
      // `Default: 0` and `Default: false`), and `resolveParameters` binds it
      // faithfully. Under `Boolean(d.Default)` the parameter is filtered OUT of
      // the retry template, so it is unbound at the resolver, carries a
      // `Default` (hence is NOT in issue #2285's refusable population), and its
      // placeholder is kept -- issue #2321's exact defect, re-opened.
      //
      // THE DISCRIMINATOR is `app--topic` (the empty default actually
      // substituted) versus the verbatim `app-${Suffix}-topic`.
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          VpcId: { Type: 'String' },
          Suffix: { Type: 'String', Default: '' },
        },
        Resources: {
          MyTopic: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: { 'Fn::Sub': 'app-${Suffix}-topic' } },
            Metadata: { 'aws:cdk:path': 'S/MyTopic' },
          },
        },
      } as unknown as CloudFormationTemplate;
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'topic-arn', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      expect(state.resources['MyTopic']?.properties['TopicName']).toBe('app--topic');
    });

    it("treats a PRESENT `Default: undefined` key as a binding, matching resolveParameters (issue #2321)", async () => {
      // The other half of the fence above, aimed at `d.Default !== undefined`.
      // A key PRESENT with an `undefined` value is a BINDING for both
      // `resolveParameters` (it falls through to the `Default` branch and
      // assigns `undefined`) and `isUnboundTemplateParameter` (`'Default' in
      // definition` short-circuits), which is exactly what the helper's JSDoc
      // claims -- so the claim needs a case.
      //
      // THE DISCRIMINATOR is `app-undefined-topic`. That string is
      // `resolveRef`'s own long-standing contract for a key bound to
      // `undefined` (documented as deliberately unchanged by issue #2285), and
      // it is reachable ONLY when the retry template kept the parameter. Under
      // `d.Default !== undefined` the parameter is dropped from the retry, so
      // nothing binds it and the placeholder survives as the verbatim
      // `app-${Ghost}-topic` instead.
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          VpcId: { Type: 'String' },
          Ghost: { Type: 'String', Default: undefined },
        },
        Resources: {
          MyTopic: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: { 'Fn::Sub': 'app-${Ghost}-topic' } },
            Metadata: { 'aws:cdk:path': 'S/MyTopic' },
          },
        },
      } as unknown as CloudFormationTemplate;
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'topic-arn', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      expect(state.resources['MyTopic']?.properties['TopicName']).toBe('app-undefined-topic');
      expect(state.resources['MyTopic']?.properties['TopicName']).not.toBe('app-${Ghost}-topic');
    });

    it('resolves an SSM-typed Default through the retry, which is why the retry re-enters resolveParameters (issue #2321)', async () => {
      // FENCE for the `{ ...template, Parameters: defaulted }` SPREAD, and for
      // the design claim that re-entering `resolveParameters` (rather than
      // hand-binding each `Default`) keeps the SSM arm identical to the happy
      // path. Both were unexercised: dropping the spread to
      // `{ Parameters: defaulted }` passed every other case in this file.
      //
      // The spread is load-bearing because `resolveParameters` decides whether
      // an `AWS::SSM::Parameter::Value<...>` default is worth a `GetParameter`
      // by walking the template's RESOURCES for references to it. Without the
      // spread the retry template has no `Resources`, so the parameter looks
      // unreferenced, the lookup is SKIPPED, and it never enters the bag.
      //
      // THE DISCRIMINATOR is two-part: the recorded `app-ami-0abc-topic` (the
      // SSM VALUE substituted, not the path), and `ssmSend` having actually
      // been called. A hand-binding implementation would have recorded the raw
      // path `app-/my/image/id-topic`, and the no-spread mutation records the
      // verbatim `app-${ImageId}-topic`.
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          VpcId: { Type: 'String' },
          ImageId: {
            Type: 'AWS::SSM::Parameter::Value<String>',
            Default: '/my/image/id',
          },
        },
        Resources: {
          MyTopic: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: { 'Fn::Sub': 'app-${ImageId}-topic' } },
            Metadata: { 'aws:cdk:path': 'S/MyTopic' },
          },
        },
      } as unknown as CloudFormationTemplate;
      ssmSend.mockImplementation(async () => ({ Parameter: { Value: 'ami-0abc' } }));
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'topic-arn', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      expect(state.resources['MyTopic']?.properties['TopicName']).toBe('app-ami-0abc-topic');
      // Direct evidence the SSM arm ran, rather than inferring it from the
      // value: a hand-binding implementation would record the PATH and this
      // assertion is what separates the two.
      expect(ssmSend).toHaveBeenCalled();
    });

    it('falls back to an empty bag when the Default-only retry ITSELF throws, and still writes state (issue #2321)', async () => {
      // FENCE for the inner catch. Replacing `parameters = {}` with
      // `throw defaultsErr` passed every other case in this file, so the
      // promise that a failed retry does not abort an import that already
      // succeeded against AWS was unverified -- and the work it would lose is
      // real AWS-side adoption that cannot be undone.
      //
      // The reachable trigger is an SSM-typed default whose `GetParameter` is
      // rejected. The rejection is shaped like the real one (a named
      // `ParameterNotFound`), not a bare `Error`, because the arm is reached
      // by whatever `resolveParameters` propagates.
      //
      // THE DISCRIMINATOR is that `saveState` is still called once. Under the
      // `throw` mutation the import aborts and state is never written.
      //
      // This case ALSO pins the KNOWN RESIDUAL that `import.ts` records at
      // that fallback and that `isUnboundTemplateParameter`'s JSDoc cites as
      // its live producer: on this arm the bag is empty, so `import.ts` omits
      // the `parameters` key, the context carries `parameters: undefined`, and
      // a `Default`-carrying parameter is NOT in issue #2285's refusable
      // population -- so `${Stage}` is written verbatim, exactly the #2321
      // defect, surviving on this one path. It is asserted rather than merely
      // described so the residual cannot widen unnoticed and the resolver's
      // claim about this arm cannot go stale.
      const tmpl: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          VpcId: { Type: 'String' },
          ImageId: {
            Type: 'AWS::SSM::Parameter::Value<String>',
            Default: '/missing/image/id',
          },
          Stage: { Type: 'String', Default: 'dev' },
        },
        Resources: {
          MyTopic: {
            Type: 'AWS::SNS::Topic',
            Properties: {
              TopicName: { 'Fn::Sub': 'app-${Stage}-topic' },
              DisplayName: { 'Fn::Sub': 'img-${ImageId}' },
            },
            Metadata: { 'aws:cdk:path': 'S/MyTopic' },
          },
        },
      } as unknown as CloudFormationTemplate;
      const notFound = Object.assign(
        new Error('Parameter /missing/image/id not found.'),
        { name: 'ParameterNotFound' }
      );
      ssmSend.mockImplementation(async () => {
        throw notFound;
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'topic-arn', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      // The import is NOT aborted: the resource is already adopted on the AWS
      // side, so the state write must still happen.
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      // The pinned residual, and the live counter-example the resolver's
      // exclusion rests on.
      expect(state.resources['MyTopic']?.properties['TopicName']).toBe('app-${Stage}-topic');
    });

    it('warns and leaves raw intrinsic in place when reference cannot be resolved', async () => {
      // Permission references a Lambda that wasn't in the importable
      // set (e.g. a sibling resource type without an `import()` impl,
      // or out-of-scope in selective mode). The resolver throws; the
      // import flow must NOT abort — log + leave the intrinsic shape
      // intact so the eventual destroy failure is narrowed to this
      // one resource rather than blowing up the whole adoption flow.
      const tmpl = template({
        MyPerm: {
          Type: 'AWS::Lambda::Permission',
          Properties: {
            FunctionName: { 'Fn::GetAtt': ['NotImportedFn', 'Arn'] },
            Action: 'lambda:InvokeFunction',
          },
          Metadata: { 'aws:cdk:path': 'S/MyPerm' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'fn-arn/perm-id', attributes: {} })),
      });

      await runImport(['import', '--app', 'x', '--yes']);

      // State write still happens (import succeeded against AWS) but
      // the unresolvable property carries a warn.
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to resolve intrinsics in Properties for imported resource 'MyPerm'/)
      );
      // NEGATIVE CONTROL for the parameter-shaped arm added with issue #2285:
      // this template declares NO parameters, so the failure is purely
      // sibling-shaped and the parameter clause must not appear. Without this
      // assertion a clause appended unconditionally would pass every case.
      expect(warnSpy.mock.calls.flat().join('\n')).not.toContain(
        "declares parameter(s) with no 'Default'"
      );
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { properties: Record<string, unknown> }> },
      ];
      // Raw intrinsic preserved — the resource is on AWS, the user can
      // re-import after adopting NotImportedFn, or `cdkd state orphan`
      // to scrub it.
      expect(state.resources['MyPerm']?.properties['FunctionName']).toEqual({
        'Fn::GetAtt': ['NotImportedFn', 'Arn'],
      });
    });
  });
});

describe('cdkd import --help text (issue #1664)', () => {
  // The `aws:cdk:path` tag walk was removed in issue #1134 (AWS reserves the
  // `aws:` tag prefix, so the tag can never exist on a real resource and the
  // walk could not match), but the CLI help kept describing it — and the help
  // is the copy a user reads first. These assert the FEARED shape is gone
  // rather than only that today's wording is present: any re-introduction of
  // the tag-walk vocabulary fails, whatever the surrounding sentence says.
  const help = () => createImportCommand().helpInformation();

  it('never describes a tag walk / tag-import anywhere in the help', () => {
    expect(help()).not.toMatch(/aws:cdk:path|tag-import|tag-based|tag-resolved|by tag\b/i);
  });

  it("states auto mode's real resolution order (physical name, then DescribeStackResources)", () => {
    const text = help();
    expect(text).toMatch(/physical-name property/);
    expect(text).toMatch(/DescribeStackResources/);
    // The order matters: the property is consulted first, the CFn stack second.
    expect(text.indexOf('physical-name property')).toBeLessThan(text.indexOf('DescribeStackResources'));
  });

  it('describes --auto as auto-resolving the rest, not tag-importing it', () => {
    const autoOption = createImportCommand()
      .options.find((o) => o.long === '--auto');
    expect(autoOption?.description).toMatch(/auto-resolve/);
    expect(autoOption?.description).not.toMatch(/tag/i);
  });

  it('describes --record-resource-mapping without the tag vocabulary', () => {
    const opt = createImportCommand()
      .options.find((o) => o.long === '--record-resource-mapping');
    expect(opt?.description).toMatch(/auto-resolution/);
    expect(opt?.description).not.toMatch(/tag/i);
  });
});
