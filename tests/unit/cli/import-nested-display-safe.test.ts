import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
/**
 * go-to-k/cdkd#3479: `cdkd import` rendered template- and assembly-derived
 * identifiers raw — the nested-stack shape refusal's id lists and parent name,
 * the nested child walk's `Adopting ...` / `state written` lines, the nested
 * template read/parse refusals, the per-stack progress lines, and the
 * intrinsic resolver's echo on the unresolved-intrinsics warning.
 *
 * Every hostile value carries its OWN marker, so one sanitized site cannot
 * pass for another. Built from code points so no control character sits in
 * this file's source. The harness is a trimmed copy of `import.test.ts`'s.
 */
import { setStdinIsTty } from '../../stdin-tty.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { CfnStackResourceTree } from '../../../src/cli/commands/retire-cfn-stack.js';

const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const C1_CSI = String.fromCharCode(0x9b);
const LF = '\n';

/** A newline or any character of the forging class. */
function forging(text: string): string[] {
  return [...text].filter((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      (c < 0x20 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });
}

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'cdk-out'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

const mockCreateAssetRedirectResolver = vi.hoisted(() =>
  vi.fn(() => async (): Promise<unknown> => undefined)
);
vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  createAssetRedirectResolver: mockCreateAssetRedirectResolver,
}));

const stsSend = vi.hoisted(() => vi.fn(async () => ({ Account: '123456789012' })));
const cfnSend = vi.hoisted(() =>
  vi.fn<(command: { input: { StackName?: string } }) => Promise<unknown>>()
);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return { send: cfnSend };
    },
    get sts() {
      return { send: stsSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({
    sts: { send: stsSend },
    secretsManager: { send: vi.fn() },
    ssm: { send: vi.fn() },
  })),
}));

const mockGetCfnResourceTree = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<CfnStackResourceTree>>()
);
const mockTryGetCfnResourceMap = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Map<string, string> | null>>()
);
vi.mock('../../../src/cli/commands/retire-cfn-stack.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/cli/commands/retire-cfn-stack.js')
  >('../../../src/cli/commands/retire-cfn-stack.js');
  return {
    retireCloudFormationStack: vi.fn(async () => ({ outcome: 'retired' })),
    getCloudFormationResourceTree: mockGetCfnResourceTree,
    tryGetCloudFormationResourceMap: mockTryGetCfnResourceMap,
    NESTED_STACK_RESOURCE_TYPE: actual.NESTED_STACK_RESOURCE_TYPE,
  };
});

const mockSaveState = vi.fn<(...args: unknown[]) => Promise<string>>();
const mockGetState = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: vi.fn(async () => undefined),
    getState: mockGetState,
    saveState: mockSaveState,
  })),
}));

const mockReleaseLock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    getLockInfo: vi.fn(async () => null),
    releaseLock: mockReleaseLock,
  })),
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: readlineQuestion, close: vi.fn() })),
}));

const mockSynthesize = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

const mockGetProvider = vi.hoisted(() => vi.fn<(t: string) => unknown>());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    hasProvider: (t: string) => t !== 'AWS::CloudFormation::Stack',
    getProvider: mockGetProvider,
    getProviderFor: ({ resourceType }: { resourceType: string }) => ({
      provider: mockGetProvider(resourceType),
      provisionedBy: 'sdk',
    }),
  })),
}));

import { createImportCommand } from '../../../src/cli/commands/import.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

async function runImport(args: string[]): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createImportCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    process.stdout.write = original;
  }
}

function stackInfo(name: string, tmpl: CloudFormationTemplate, nestedTemplates = {}) {
  return {
    stackName: name,
    displayName: 'Shown',
    artifactId: 'Shown',
    template: tmpl,
    dependencyNames: [],
    region: 'us-east-1',
    nestedTemplates,
  };
}

function tree(
  stackName: string,
  resources: [string, string][],
  nested: [string, CfnStackResourceTree][] = []
): CfnStackResourceTree {
  return { stackName, physicalId: stackName, resources: new Map(resources), nested: new Map(nested) };
}

function allLogLines(): string[] {
  return [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls].map(
    (c) => String(c[0])
  );
}

function expectNoForging(lines: string[]): void {
  for (const line of lines) expect(forging(line), JSON.stringify(line)).toEqual([]);
}

let originalIsTTY: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
let dir: string;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  vi.clearAllMocks();
  mockSaveState.mockResolvedValue('"etag"');
  mockReleaseLock.mockResolvedValue(undefined);
  mockGetState.mockResolvedValue(null);
  mockCreateAssetRedirectResolver.mockImplementation(() => async (): Promise<unknown> => undefined);
  readlineQuestion.mockResolvedValue('n');
  mockGetProvider.mockReturnValue({
    import: vi.fn(async () => ({ physicalId: 'phys', attributes: {} })),
  });
  mockTryGetCfnResourceMap.mockResolvedValue(null);
  cfnSend.mockImplementation(async (command) => {
    const err = new Error(`Stack with id ${command.input.StackName ?? ''} does not exist`);
    err.name = 'ValidationError';
    throw err;
  });
  resetAccountInfoCache();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
  dir = mkdtempSync(join(tmpdir(), 'cdkd-import-display-safe-'));
});
afterEach(() => {
  setStdinIsTty(originalIsTTY);
  exitSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const NESTED = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } };

describe('cdkd import renders template-derived identifiers display-safe (go-to-k/cdkd#3479)', () => {
  it('the nested-stack shape refusal: each id list and the parent stack name', async () => {
    const parent = `P${NEL}PARENTFORGED`;
    const onlyInTemplate = `T${C1_CSI}2KTEMPLATEFORGED`;
    // No space, so only `listMember` gives it a boundary: a bare `A,B` in a
    // `', '`-joined list reads as two ids.
    const listForger = 'A,B';
    const onlyInAws = `W${LF}AWSFORGED`;
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo(parent, {
          Resources: { [onlyInTemplate]: NESTED, [listForger]: NESTED, Plain: NESTED },
        } as CloudFormationTemplate),
      ],
    });
    mockGetCfnResourceTree.mockResolvedValue(
      tree(parent, [], [[onlyInAws, tree('c', [])], ['Plain', tree('c2', [])]])
    );

    await expect(
      runImport(['--app', 'x', '--yes', '--migrate-from-cloudformation', 'CfnStack'])
    ).rejects.toThrow();

    const refusal = errorSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('shape mismatch'));
    expect(refusal).toBeDefined();
    // The refusal's own layout is multi-line; no value may add to it.
    expect(refusal!.split('\n')).toHaveLength(4);
    expectNoForging([refusal!]);
    expect(refusal).toContain('parent stack "P PARENTFORGED" template');
    // Missing from AWS: the forging id quoted, the list-forger quoted (its comma
    // would read as a separator), the plain id bare.
    // `displayIdent`'s ASCII allowlist blanks the C1 introducer itself; the
    // `2K` after it is inert text once nothing introduces it.
    expect(refusal).toContain('["T 2KTEMPLATEFORGED", "A,B"]');
    expect(refusal).toContain('["W AWSFORGED"]');
    // The missing-asset-path row lists every template id, and Plain stays bare.
    expect(refusal).toContain('["T 2KTEMPLATEFORGED", "A,B", Plain]');
  });

  it('the nested child walk: Adopting / state written lines, and a plain child renders unchanged', async () => {
    const child = `Ch'ild${LS}CHILDFORGED`;
    const childPath = join(dir, 'child.json');
    const plainPath = join(dir, 'plain.json');
    const childTemplate = JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } });
    writeFileSync(childPath, childTemplate);
    writeFileSync(plainPath, childTemplate);
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo('P', { Resources: { [child]: NESTED, Kid: NESTED } } as CloudFormationTemplate, {
          [child]: childPath,
          Kid: plainPath,
        }),
      ],
    });
    mockGetCfnResourceTree.mockResolvedValue(
      tree(
        'P',
        [
          [child, 'arn:c'],
          ['Kid', 'arn:k'],
        ],
        [
          [child, tree('arn:c', [['Q', 'q-url']])],
          ['Kid', tree('arn:k', [['Q', 'q-url-2']])],
        ]
      )
    );

    await runImport(['--app', 'x', '--yes', '--migrate-from-cloudformation']);

    const info = infoSpy.mock.calls.map((c) => String(c[0]));
    expectNoForging(info);
    expect(info).toContain(
      `Adopting nested stack "Ch'ild CHILDFORGED" as cdkd stack "P~Ch'ild CHILDFORGED" (us-east-1)...`
    );
    expect(info.some((l) => l.startsWith(`✓ Nested stack state written: "P~Ch'ild CHILDFORGED" (us-east-1)`))).toBe(true);
    // Ordinary polarity: a plain child id and name are byte-identical.
    expect(info).toContain('Adopting nested stack Kid as cdkd stack P~Kid (us-east-1)...');
    expect(info.some((l) => l.startsWith('✓ Nested stack state written: P~Kid (us-east-1)'))).toBe(true);
  });

  it('the nested template parse refusal: the child id and the parse failure text', async () => {
    const child = `C${NEL}CHILDFORGED`;
    const childPath = join(dir, 'bad.json');
    // `JSON.parse` quotes the file's bytes back in its error.
    writeFileSync(childPath, `{"x": nope${LS}PARSEFORGED`);
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo('P', { Resources: { [child]: NESTED } } as CloudFormationTemplate, {
          [child]: childPath,
        }),
      ],
    });
    mockGetCfnResourceTree.mockResolvedValue(
      tree('P', [[child, 'arn:c']], [[child, tree('arn:c', [])]])
    );

    await expect(runImport(['--app', 'x', '--yes', '--migrate-from-cloudformation'])).rejects.toThrow();

    const refusal = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to parse nested-stack template'));
    expect(refusal).toBeDefined();
    expectNoForging([refusal!]);
    expect(refusal).toContain('Failed to parse nested-stack template for "C CHILDFORGED" at ');
    // V8's snippet of the file's own bytes is not echoed.
    expect(refusal).toMatch(/: invalid JSON$/);
    expect(refusal).not.toContain('PARSEFORGED');
  });

  it('the per-stack progress lines name a hostile stack name with a boundary', async () => {
    const name = `S${C1_CSI}2K${LF}STACKFORGED`;
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo(name, { Resources: { Q: { Type: 'AWS::SQS::Queue' } } } as CloudFormationTemplate),
      ],
    });
    mockTryGetCfnResourceMap.mockResolvedValue(new Map([['Q', 'q-url']]));

    await runImport(['--app', 'x', '--yes']);

    const lines = allLogLines();
    expectNoForging(lines);
    const info = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(info).toContain('Target stack: "S 2K STACKFORGED" (us-east-1)');
    expect(info).toContain('✓ State written: "S 2K STACKFORGED" (us-east-1)');
    expect(info.some((l) => l.startsWith('Resolved 1 physical ID(s) from CloudFormation stack "S 2K STACKFORGED". '))).toBe(true);
  });

  it('the nested template read refusal: the child id, the path and the errno text', async () => {
    const child = `C${LS}CHILDFORGED`;
    const missing = join(dir, `gone${NEL}PATHFORGED.json`);
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo('P', { Resources: { [child]: NESTED } } as CloudFormationTemplate, {
          [child]: missing,
        }),
      ],
    });
    mockGetCfnResourceTree.mockResolvedValue(
      tree('P', [[child, 'arn:c']], [[child, tree('arn:c', [])]])
    );

    await expect(runImport(['--app', 'x', '--yes', '--migrate-from-cloudformation'])).rejects.toThrow();

    const refusal = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to read nested-stack template'));
    expect(refusal).toBeDefined();
    // Node's errno text quotes the path a second time; both renders are clean.
    expectNoForging([refusal!]);
    expect(refusal).toContain('Failed to read nested-stack template for "C CHILDFORGED" at ');
    // Named ONCE: the errno text's own copy of the path becomes `<path>`.
    expect(refusal!.split('PATHFORGED')).toHaveLength(2);
    expect(refusal).toMatch(/: ENOENT: no such file or directory, open '<path>'$/);
  });

  it('the nested child lock-release warning: the child stack name and the release error', async () => {
    const child = `K${NEL}CHILDFORGED`;
    const childPath = join(dir, 'child.json');
    writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo('P', { Resources: { [child]: NESTED } } as CloudFormationTemplate, {
          [child]: childPath,
        }),
      ],
    });
    mockGetCfnResourceTree.mockResolvedValue(
      tree('P', [[child, 'arn:c']], [[child, tree('arn:c', [['Q', 'q']])]])
    );
    mockReleaseLock.mockImplementation(async (name: unknown) => {
      if (String(name).includes('~')) throw new Error(`release failed${LF}RELEASEFORGED`);
    });

    await runImport(['--app', 'x', '--yes', '--migrate-from-cloudformation']);

    const warning = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('Failed to release lock for nested stack'));
    expect(warning).toBe(
      'Failed to release lock for nested stack "P~K CHILDFORGED" (us-east-1): release failed RELEASEFORGED'
    );
  });

  it('the migration source name and the no-CloudFormation-stack debug line', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [stackInfo('P', { Resources: {} } as CloudFormationTemplate)],
    });
    mockGetCfnResourceTree.mockResolvedValue(tree('P', []));

    // A literal operand, so the commander-parse convention fence can count it.
    await runImport(['--app', 'x', '--yes', '--migrate-from-cloudformation', 'Cfn\nSOURCEFORGED']);
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Resolving physical IDs from CloudFormation stack "Cfn SOURCEFORGED" (recursive)...'
    );

    const name = `S${NEL}AUTOFORGED`;
    mockSynthesize.mockResolvedValue({
      stacks: [stackInfo(name, { Resources: { Q: { Type: 'AWS::SQS::Queue' } } } as CloudFormationTemplate)],
    });
    mockTryGetCfnResourceMap.mockResolvedValue(null);
    await runImport(['--app', 'x', '--yes']);
    expect(debugSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'No CloudFormation stack named "S AUTOFORGED" — resolving physical IDs per provider.'
    );
    expectNoForging(allLogLines());
  });

  it('the confirmation prompt names a hostile stack name with a boundary', async () => {
    const name = `S${LS}PROMPTFORGED`;
    mockSynthesize.mockResolvedValue({
      stacks: [stackInfo(name, { Resources: { Q: { Type: 'AWS::SQS::Queue' } } } as CloudFormationTemplate)],
    });

    await runImport(['--app', 'x']);

    const prompt = String(readlineQuestion.mock.calls[0]?.[0]);
    expect(forging(prompt)).toEqual([]);
    expect(prompt).toMatch(/^Write state for "S PROMPTFORGED" \(us-east-1\) with 1 resource\(s\)\?/);
  });

  it('a provider failure: the error line and the import plan row keep line breaks but no forging byte', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [stackInfo('S', { Resources: { Q: { Type: 'AWS::SQS::Queue' } } } as CloudFormationTemplate)],
    });
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => {
        throw new Error(`denied${NEL}FAILFORGED${C1_CSI}2K${LF}second line`);
      }),
    });

    await runImport(['--app', 'x', '--yes']).catch(() => undefined);

    const error = errorSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Failed to import'));
    expect(error).toBe('Failed to import Q (AWS::SQS::Queue): denied FAILFORGED\nsecond line');
    const row = infoSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('FAILFORGED'));
    expect(row).toBe('  ✗ Q (AWS::SQS::Queue) — denied FAILFORGED\nsecond line');
  });

  it('the root lock-release warning bounds and sanitizes the release error', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [stackInfo('S', { Resources: { Q: { Type: 'AWS::SQS::Queue' } } } as CloudFormationTemplate)],
    });
    mockReleaseLock.mockRejectedValue(new Error(`release failed${LF}ROOTRELEASEFORGED`));

    await runImport(['--app', 'x', '--yes']);

    expect(warnSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Failed to release lock: release failed ROOTRELEASEFORGED'
    );
  });

  it('the merge plan line and the no-new-physical-ids debug line', async () => {
    const name = `S${NEL}MERGEFORGED`;
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo(name, {
          Resources: { Q: { Type: 'AWS::SQS::Queue' }, R: { Type: 'AWS::SQS::Queue' } },
        } as CloudFormationTemplate),
      ],
    });
    mockGetState.mockResolvedValue({
      state: {
        version: 10,
        stackName: name,
        region: 'us-east-1',
        resources: { R: { physicalId: 'r', resourceType: 'AWS::SQS::Queue', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runImport(['--app', 'x', '--resource', 'Q=q-url', '--yes']);
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Merging into existing state for "S MERGEFORGED" (us-east-1): preserving 1 unlisted resource(s)'
    );

    mockGetState.mockResolvedValue(null);
    mockTryGetCfnResourceMap.mockResolvedValue(new Map([['NotInTemplate', 'x']]));
    await runImport(['--app', 'x', '--yes']);
    expect(debugSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'CloudFormation stack "S MERGEFORGED" contributed no new physical IDs.'
    );
    expectNoForging(allLogLines());
  });

  it('the asset-rewrite lines, at the root and for a nested child', async () => {
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    const cdkBucket = 'cdk-hnb659fds-assets-111111111111-us-east-1';
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
        assetBucket: 'cdkd-assets-111111111111-us-east-1',
        containerRepo: 'cdkd-container-assets-111111111111-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      '111111111111',
      'us-east-1'
    );
    mockCreateAssetRedirectResolver.mockImplementation(() => async () => map);
    const parent = `P${LS}ASSETFORGED`;
    const child = `C${NEL}KIDFORGED`;
    const childPath = join(dir, 'child.json');
    const assetProps = { PolicyName: 'p', DataUrl: `s3://${cdkBucket}/k.zip` };
    writeFileSync(
      childPath,
      JSON.stringify({ Resources: { Pol: { Type: 'AWS::IAM::Policy', Properties: assetProps } } })
    );
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo(
          parent,
          {
            Resources: {
              [child]: NESTED,
              Pol: { Type: 'AWS::IAM::Policy', Properties: assetProps },
            },
          } as CloudFormationTemplate,
          { [child]: childPath }
        ),
      ],
    });
    mockGetCfnResourceTree.mockResolvedValue(
      tree(parent, [[child, 'arn:c'], ['Pol', 'pol']], [[child, tree('arn:c', [['Pol', 'pol']])]])
    );

    await runImport(['--app', 'x', '--yes', '--migrate-from-cloudformation']);

    const info = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(info.some((l) => l.startsWith('Note: 1 asset reference(s) in stack "P ASSETFORGED" are recorded'))).toBe(true);
    expect(
      info.some((l) => l.startsWith('Note: 1 asset reference(s) in nested stack "P ASSETFORGED~C KIDFORGED" are'))
    ).toBe(true);
    expect(debugSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Rewrote 1 asset reference(s) to cdkd asset storage in template of stack "P ASSETFORGED"'
    );
    expectNoForging(allLogLines());
  });

  it('the parameter-resolution failure text is bounded', async () => {
    // Its two siblings are not driven here: `evaluateConditions` catches per
    // condition, so the condition arm needs a throw outside that loop, and
    // the 'Default'-only arm needs the defaults pass to fail as well. Both
    // render through the same `displayAwsMessage` call shape as this one.
    const long = 'Z'.repeat(5000);
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo('S', {
          Parameters: { [`Req${long}`]: { Type: 'String' } },
          Resources: { Q: { Type: 'AWS::SQS::Queue' } },
        } as unknown as CloudFormationTemplate),
      ],
    });

    await runImport(['--app', 'x', '--yes']);

    const debug = debugSpy.mock.calls.map((c) => String(c[0]));
    const param = debug.find((l) => l.startsWith('Template parameter resolution failed'));
    expect(param).toMatch(/\[cut: \d+ more characters withheld\] — retrying/);
  });

  it('the unresolved-intrinsics warning: the resolver echo is bounded and stays on its line', async () => {
    // The resolver already sanitizes the operand it echoes
    // (`displayMasked`), so what this site adds is the BOUND: the echoed
    // target's length is the template's choice, and `displayAwsMessage` cuts
    // it and marks the cut.
    const target = `Missing${'X'.repeat(5000)}`;
    mockSynthesize.mockResolvedValue({
      stacks: [
        stackInfo('S', {
          Resources: {
            Perm: {
              Type: 'AWS::Lambda::Permission',
              Properties: { FunctionName: { 'Fn::GetAtt': [target, 'Arn'] } },
              Metadata: { 'aws:cdk:path': 'S/Perm' },
            },
          },
        } as unknown as CloudFormationTemplate),
      ],
    });

    await runImport(['--app', 'x', '--yes']);

    const warning = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('Failed to resolve intrinsics in Properties'));
    expect(warning).toBeDefined();
    const lines = warning!.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^State will be written with the raw intrinsic shape/);
    expectNoForging([warning!]);
    expect(lines[0]).toMatch(/\[cut: \d+ more characters withheld\]\.$/);
    expect(lines[0]!.length).toBeLessThan(4096 + 200);
  });
});
