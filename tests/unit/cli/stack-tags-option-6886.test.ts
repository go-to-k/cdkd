/**
 * go-to-k/cdkd#6886: `--tags KEY=VALUE` (alias `-t`, repeatable) on
 * `cdkd deploy` / `cdkd diff`, matching `cdk deploy --tags`: the tags REPLACE
 * each selected stack's own when at least one is given, cdk.json's top-level
 * `"tags"` (`[{Key, Value}]`) is the fallback, an argument without `=` is
 * warned about and dropped, and an empty key or value is refused as
 * CloudFormation refuses it. The `cdkd diff` wiring is driven through the
 * real command (harness: `diff-fail-on.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLoggerWarn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

const cdkJson = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: vi.fn(() => cdkJson.value),
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUpdatePolicy: vi.fn(() => undefined),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  runWithStackAwsClients: vi.fn((_clients: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: vi.fn(async () => null),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: vi.fn(),
    getProviderFor: vi.fn(() => ({ provisionedBy: 'sdk' })),
    ccRouteUnavailableReason: vi.fn(),
  })),
}));

/** The stack tags the diff merges, observed where it merges them. */
const applyStackTagsSpy = vi.hoisted(() =>
  vi.fn(async (template: unknown, _stackTags?: unknown) => template)
);
vi.mock('../../../src/provisioning/stack-tag-targets.js', () => ({
  applyStackTagsToTemplate: applyStackTagsSpy,
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';
import { createDeployCommand } from '../../../src/cli/commands/deploy.js';
import { parseTagsArgs, resolveStackTagsOverride } from '../../../src/cli/options/stack-tags.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

describe('parseTagsArgs / resolveStackTagsOverride (go-to-k/cdkd#6886)', () => {
  it('splits each argument at the first =, the last of a repeated key winning', () => {
    const warn = vi.fn();
    expect(parseTagsArgs(['team=a', 'url=x=y', 'team=b'], warn)).toEqual({
      team: 'b',
      url: 'x=y',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about and drops an argument without =, and ignores empty strings', () => {
    const warn = vi.fn();
    expect(parseTagsArgs(['', 'MyStack', 'team=a'], warn)).toEqual({ team: 'a' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('MyStack');
  });

  it('names no tags for no flag, only empty strings, or only non-assignments', () => {
    const warn = vi.fn();
    expect(parseTagsArgs(undefined, warn)).toBeUndefined();
    expect(parseTagsArgs([''], warn)).toBeUndefined();
    expect(parseTagsArgs(['nope'], warn)).toBeUndefined();
  });

  it.each([['=v'], ['k=']])('refuses %s: CloudFormation refuses an empty key or value', (arg) => {
    expect(() => parseTagsArgs([arg], vi.fn())).toThrow(CdkdError);
    expect(() => parseTagsArgs([arg], vi.fn())).toThrow(/non-empty key and value/);
  });

  it('keeps a __proto__ key as an own key', () => {
    const tags = parseTagsArgs(['__proto__=x'], vi.fn());
    expect(Object.keys(tags!)).toEqual(['__proto__']);
    expect(tags!['__proto__']).toBe('x');
  });

  it('falls back to cdk.json "tags", the flag winning', () => {
    const json = { tags: [{ Key: 'team', Value: 'json' }] };
    expect(resolveStackTagsOverride(undefined, vi.fn(), json)).toEqual({ team: 'json' });
    expect(resolveStackTagsOverride(['team=flag'], vi.fn(), json)).toEqual({ team: 'flag' });
    expect(resolveStackTagsOverride(undefined, vi.fn(), { tags: [] })).toBeUndefined();
    expect(resolveStackTagsOverride(undefined, vi.fn(), null)).toBeUndefined();
  });

  it.each([
    [{ team: 'a' }],
    [[{ Key: 'team' }]],
    [[{ Key: 'team', Value: 1 }]],
    [[{ Key: '', Value: 'a' }]],
    [[null]],
  ])('refuses a malformed cdk.json "tags": %j', (tags) => {
    expect(() => resolveStackTagsOverride(undefined, vi.fn(), { tags })).toThrow(CdkdError);
  });
});

describe('the --tags option (go-to-k/cdkd#6886)', () => {
  function parsed(create: () => import('commander').Command, args: string[]): unknown {
    const cmd = create();
    cmd.exitOverride();
    cmd.action(() => {});
    cmd.parse(args, { from: 'user' });
    return cmd.opts()['tags'];
  }

  it.each([
    ['deploy', createDeployCommand],
    ['diff', createDiffCommand],
  ] as const)('%s: repeatable, with the -t alias', (_name, create) => {
    expect(parsed(create, ['--tags', 'a=1', '-t', 'b=2'])).toEqual(['a=1', 'b=2']);
    expect(parsed(create, [])).toBeUndefined();
  });
});

describe('cdkd diff --tags replaces the stack tags it previews (go-to-k/cdkd#6886)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cdkJson.value = null;
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'S',
          displayName: 'S',
          artifactId: 'S',
          template: { Resources: { Q: { Type: 'AWS::SQS::Queue' } } },
          dependencyNames: [],
          assets: [],
          tags: { team: 'manifest', owner: 'm' },
        },
      ],
    });
  });

  async function previewedTags(argv: string[]): Promise<unknown> {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__process_exit__');
    }) as never);
    try {
      await createDiffCommand().exitOverride().parseAsync(['S', ...argv], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
    } finally {
      exitSpy.mockRestore();
    }
    expect(applyStackTagsSpy).toHaveBeenCalled();
    return applyStackTagsSpy.mock.calls[0]![1];
  }

  it('previews the --tags tags in place of the stack own', async () => {
    expect(await previewedTags(['--tags', 'team=flag', '-t', 'env=prod'])).toEqual({
      team: 'flag',
      env: 'prod',
    });
  });

  it("previews the stack's own tags without the flag", async () => {
    expect(await previewedTags([])).toEqual({ team: 'manifest', owner: 'm' });
  });

  it('previews cdk.json "tags" without the flag', async () => {
    cdkJson.value = { tags: [{ Key: 'team', Value: 'json' }] };
    expect(await previewedTags([])).toEqual({ team: 'json' });
  });
});
