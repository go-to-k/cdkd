import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #3522, end to end through the context-provider loop: the REAL
// `ContextProviderRegistry` and the REAL `ContextStore` (writing a real
// `cdk.context.json` in a temp directory), with only the CDK app, the manifest
// read, the AZ lookup and STS stubbed. A context key named `__proto__` used to
// be dropped by both the registry and the store, so the app asked for it again
// and the loop refused with "Context resolution made no progress" for a lookup
// that SUCCEEDED.

const mockExecute = vi.fn();
const mockAzResolve = vi.fn();

vi.mock('../../../src/synthesis/app-executor.js', () => ({
  AppExecutor: vi.fn().mockImplementation(() => ({ execute: mockExecute })),
}));

/** The context the app received on its most recent run. */
function lastContext(): Record<string, unknown> {
  const calls = mockExecute.mock.calls;
  return calls[calls.length - 1]![0].context as Record<string, unknown>;
}

// The app asks for `__proto__` until its context carries it as an OWN key —
// which is what CDK's own `JSON.parse` of `CDK_CONTEXT_JSON` would see.
vi.mock('../../../src/synthesis/assembly-reader.js', () => ({
  AssemblyReader: vi.fn().mockImplementation(() => ({
    readManifest: () => ({
      version: '38.0.0',
      artifacts: {},
      missing: Object.prototype.hasOwnProperty.call(lastContext(), '__proto__')
        ? []
        : [
            {
              key: '__proto__',
              provider: 'availability-zones',
              props: { account: '123456789012', region: 'us-east-1' },
            },
          ],
    }),
    readAssembly: () => ({ stacks: [], failedStages: [] }),
  })),
}));

vi.mock('../../../src/synthesis/context-providers/az-provider.js', () => ({
  AZContextProvider: vi.fn().mockImplementation(() => ({ resolve: mockAzResolve })),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: () => null,
  loadUserCdkJson: () => null,
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '123456789012' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { Synthesizer } from '../../../src/synthesis/synthesizer.js';

describe('Synthesizer context loop: a context key named __proto__ (#3522)', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'cdkd-3522-'));
    // `ContextStore` reads and writes `cdk.context.json` under the cwd.
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    mockExecute.mockResolvedValue(undefined);
    mockAzResolve.mockResolvedValue(['us-east-1a']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('resolves it, persists it, and re-runs the app with it as an OWN key', async () => {
    const result = await new Synthesizer().synthesize({
      app: 'node app.js',
      output: join(projectDir, 'cdk.out'),
      region: 'us-east-1',
    });

    expect(result.stacks).toEqual([]);
    // One lookup, then exactly one re-run that no longer asks for the key.
    expect(mockAzResolve).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(Object.getOwnPropertyDescriptor(lastContext(), '__proto__')?.value).toEqual([
      'us-east-1a',
    ]);

    const saved = JSON.parse(readFileSync(join(projectDir, 'cdk.context.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(saved)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(saved, '__proto__')?.value).toEqual(['us-east-1a']);
  });
});
