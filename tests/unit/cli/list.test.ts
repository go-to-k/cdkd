import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Mock Synthesizer — list.ts only uses Synthesizer.synthesize().
const mockSynthesize = vi.fn();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

// Mock config-loader so we don't read real cdk.json.
const mockResolveApp = vi.fn();
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: (cliApp?: string) => mockResolveApp(cliApp),
}));

// Mock logger so noise doesn't pollute test output.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

import { createListCommand } from '../../../src/cli/commands/list.js';

/**
 * Helper to build a StackInfo with sane defaults.
 */
function makeStack(overrides: Partial<StackInfo> & { stackName: string }): StackInfo {
  return {
    artifactId: overrides.stackName,
    displayName: overrides.displayName ?? overrides.stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
    ...overrides,
  };
}

/**
 * Run the list command via Commander and capture stdout.
 *
 * Use parseAsync with `from: 'user'` so the array is treated as the
 * subcommand's own argv (no node/script prefix). exitOverride prevents
 * Commander from calling process.exit on parse errors.
 */
async function runList(args: string[]): Promise<{ stdout: string; error?: Error }> {
  const cmd = createListCommand();
  cmd.exitOverride();

  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__process.exit__');
  }) as never);
  const errorLogSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  let error: Error | undefined;
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e as Error;
  }

  const stdout = writeSpy.mock.calls.map((c) => String(c[0])).join('');

  writeSpy.mockRestore();
  exitSpy.mockRestore();
  errorLogSpy.mockRestore();

  return { stdout, ...(error && { error }) };
}

describe('cdkd list', () => {
  beforeEach(() => {
    mockSynthesize.mockReset();
    mockResolveApp.mockReset();
    mockResolveApp.mockReturnValue('npx ts-node app.ts');
  });

  it('prints CDK display id per line by default, with physical name in parens when it differs', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        // displayName === stackName: just the display path
        makeStack({ stackName: 'StackA', displayName: 'StackA' }),
        // displayName !== stackName (Stage-scoped): parens form
        makeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout, error } = await runList([]);

    expect(error).toBeUndefined();
    expect(stdout).toBe('StackA\nMyStage/Api (MyStage-Api)\n');
  });

  it('orders stacks by dependency (deps first)', async () => {
    // StackA depends on StackB, so StackB must come first.
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({ stackName: 'StackA', dependencyNames: ['StackB'] }),
        makeStack({ stackName: 'StackB' }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout } = await runList([]);
    expect(stdout).toBe('StackB\nStackA\n');
  });

  it('emits YAML records with --long', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({
          stackName: 'MyStage-Api',
          displayName: 'MyStage/Api',
          account: '123456789012',
          region: 'us-west-2',
        }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout } = await runList(['--long']);

    expect(stdout).toContain('id: MyStage/Api');
    expect(stdout).toContain('name: MyStage-Api');
    expect(stdout).toContain('account: 123456789012');
    expect(stdout).toContain('region: us-west-2');
    // No dependencies key without --show-dependencies
    expect(stdout).not.toContain('dependencies:');
  });

  it('emits JSON records with --long --json', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({
          stackName: 'StackA',
          displayName: 'StackA',
          account: '111111111111',
          region: 'us-east-1',
          dependencyNames: ['StackB'],
        }),
        makeStack({
          stackName: 'StackB',
          displayName: 'StackB',
          account: '111111111111',
          region: 'us-east-1',
        }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout } = await runList(['--long', '--show-dependencies', '--json']);

    const parsed = JSON.parse(stdout) as Array<{
      id: string;
      name: string;
      environment: { account: string; region: string };
      dependencies: string[];
    }>;
    expect(parsed).toEqual([
      {
        id: 'StackB',
        name: 'StackB',
        environment: { account: '111111111111', region: 'us-east-1' },
        dependencies: [],
      },
      {
        id: 'StackA',
        name: 'StackA',
        environment: { account: '111111111111', region: 'us-east-1' },
        dependencies: ['StackB'],
      },
    ]);
  });

  it('emits dependency-only records with --show-dependencies (no --long)', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({ stackName: 'StackA', dependencyNames: ['StackB'] }),
        makeStack({ stackName: 'StackB' }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout } = await runList(['--show-dependencies', '--json']);

    const parsed = JSON.parse(stdout) as Array<{ id: string; dependencies: string[] }>;
    expect(parsed).toEqual([
      { id: 'StackB', dependencies: [] },
      { id: 'StackA', dependencies: ['StackB'] },
    ]);
  });

  it('filters stacks by physical-name pattern', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' }),
        makeStack({ stackName: 'MyStage-Db', displayName: 'MyStage/Db' }),
        makeStack({ stackName: 'OtherStage-Api', displayName: 'OtherStage/Api' }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout } = await runList(['MyStage-*']);
    expect(stdout).toBe('MyStage/Api (MyStage-Api)\nMyStage/Db (MyStage-Db)\n');
  });

  it('filters stacks by display-path wildcard', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' }),
        makeStack({ stackName: 'OtherStage-Api', displayName: 'OtherStage/Api' }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout } = await runList(['MyStage/*']);
    expect(stdout).toBe('MyStage/Api (MyStage-Api)\n');
  });

  it('--show-dependencies (no --long) carries the parens form in id', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({
          stackName: 'MyStage-Api',
          displayName: 'MyStage/Api',
          dependencyNames: ['MyStage-Db'],
        }),
        makeStack({ stackName: 'MyStage-Db', displayName: 'MyStage/Db' }),
      ],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { stdout } = await runList(['--show-dependencies', '--json']);

    const parsed = JSON.parse(stdout) as Array<{ id: string; dependencies: string[] }>;
    expect(parsed).toEqual([
      { id: 'MyStage/Db (MyStage-Db)', dependencies: [] },
      { id: 'MyStage/Api (MyStage-Api)', dependencies: ['MyStage-Db'] },
    ]);
  });

  it('errors when no stacks match the pattern', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack({ stackName: 'StackA', displayName: 'StackA' })],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });

    const { error } = await runList(['DoesNotExist']);
    // withErrorHandling calls process.exit(1); our spy throws so the
    // command's exception bubbles back as the sentinel error.
    expect(error).toBeDefined();
    expect(error?.message).toBe('__process.exit__');
  });

  it('errors when --app cannot be resolved', async () => {
    mockResolveApp.mockReturnValue(undefined);

    const { error } = await runList([]);
    expect(error).toBeDefined();
    expect(error?.message).toBe('__process.exit__');
  });
});
