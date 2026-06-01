import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { Command } from 'commander';

/**
 * `cdkd local invoke-agentcore --watch` (follows cdk-local #270).
 *
 * cdkd owns its own watch loop (`src/local/invoke-agentcore-watch-loop.ts`) on
 * top of cdk-local's exported watch primitives — the same pattern
 * `cdkd local start-api --watch` uses. Coverage here:
 *
 *   1. Option surface — `--watch` is registered on the command + defaults to
 *      false.
 *   2. MCP / A2A no-op WARN — `--watch` is a no-op WARN for those protocols
 *      (the single shot proceeds). Asserted at the pure-helper level by
 *      checking the eligibility predicate the command uses.
 *   3. Classifier dispatch — `runAgentCoreWatchLoop` routes a `soft-reload`
 *      verdict through the softReload callback and a `rebuild` verdict (or a
 *      classifier failure) through the rebuild callback.
 *   4. Reload-chain serialization — two rapid firings never run two reloads in
 *      parallel.
 *   5. Clean WS abort on reload — the active invocation's abort signal fires on
 *      a reload so the socket closes cleanly before the swap.
 *   6. Soft-reload helper — `softReloadAgentContainer` reads `Config.WorkingDir`,
 *      runs `docker cp <src>/. <id>:<workdir>/`, then `docker restart <id>`.
 */

// `node:child_process` is dynamically imported inside `softReloadAgentContainer`
// via `promisify(execFile)`; intercept at the module registry (ESM `node:`
// namespaces are non-configurable, so `vi.spyOn` does not work).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const cmd = rest[0] as string;
    const args = rest[1] as string[];
    const result = execFileMock(cmd, args);
    if (result instanceof Error) {
      cb(result, { stdout: '', stderr: '' });
    } else {
      cb(null, { stdout: (result as string) ?? '', stderr: '' });
    }
  },
}));

import {
  runAgentCoreWatchLoop,
  softReloadAgentContainer,
  loadAgentCoreAssetContext,
  type AgentCoreWatchInvokeOutcome,
} from '../../../src/local/invoke-agentcore-watch-loop.js';
import {
  createLocalInvokeAgentCoreCommand,
  isAgentCoreWatchEligible,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import {
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_AGUI_PROTOCOL,
  AGENTCORE_HTTP_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
} from 'cdk-local/internal';
import type {
  ReloadAssetContext,
  ResolvedAgentCoreRuntime,
  FileWatcher,
} from 'cdk-local/internal';
import type { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

describe('invoke-agentcore --watch option surface', () => {
  it('registers --watch on the command, defaulting to false', () => {
    const cmd = createLocalInvokeAgentCoreCommand();
    const flags = cmd.options
      .map((o) => o.long)
      .filter((l): l is string => typeof l === 'string');
    expect(flags).toContain('--watch');
    const watch = cmd.options.find((o) => o.long === '--watch');
    expect(watch?.defaultValue).toBe(false);
  });

  it('is eligible for HTTP / AGUI and a no-op for MCP / A2A', () => {
    // The command logs a no-op WARN + lets the single shot proceed for the
    // ineligible protocols; this predicate is the gate it consults.
    expect(isAgentCoreWatchEligible(AGENTCORE_HTTP_PROTOCOL)).toBe(true);
    expect(isAgentCoreWatchEligible(AGENTCORE_AGUI_PROTOCOL)).toBe(true);
    expect(isAgentCoreWatchEligible(AGENTCORE_MCP_PROTOCOL)).toBe(false);
    expect(isAgentCoreWatchEligible(AGENTCORE_A2A_PROTOCOL)).toBe(false);
  });
});

describe('runAgentCoreWatchLoop — classifier dispatch', () => {
  let rebuild: ReturnType<typeof vi.fn>;
  let softReload: ReturnType<typeof vi.fn>;
  let waitForPing: ReturnType<typeof vi.fn>;
  let onChangeRef: ((paths: readonly string[]) => void) | undefined;
  let watcher: FileWatcher;
  let synthesizer: Synthesizer;

  beforeEach(() => {
    onChangeRef = undefined;
    rebuild = vi.fn();
    softReload = vi.fn();
    waitForPing = vi.fn().mockResolvedValue(undefined);
    watcher = { close: vi.fn().mockResolvedValue(undefined) };
    synthesizer = {
      synthesize: vi.fn().mockResolvedValue({ stacks: [] }),
    } as unknown as Synthesizer;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function baseRuntime(): ResolvedAgentCoreRuntime {
    return {
      stack: { stackName: 'App' } as ResolvedAgentCoreRuntime['stack'],
      logicalId: 'ChatAgent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: undefined,
      environmentVariables: {},
      protocol: 'HTTP',
      codeArtifact: {
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        codeAssetHash: 'OLDHASH',
      },
    } as unknown as ResolvedAgentCoreRuntime;
  }

  /**
   * Build an `invokeOnce` that resolves on abort the first time (a reload
   * fired), then resolves naturally on the second call (loop exits). The first
   * call schedules the watcher firing on nextTick so the reload is triggered
   * while the first invoke is pending.
   */
  function wireOneReloadThenEnd(): ReturnType<typeof vi.fn> {
    return vi
      .fn()
      .mockImplementationOnce(
        async ({ abortSignal }: { abortSignal: AbortSignal }): Promise<AgentCoreWatchInvokeOutcome> => {
          process.nextTick(() => onChangeRef?.(['/abs/handler.py']));
          await new Promise<void>((res) => {
            abortSignal.addEventListener('abort', () => res());
          });
          return { pendingReload: abortSignal.aborted };
        }
      )
      .mockImplementationOnce(
        async (): Promise<AgentCoreWatchInvokeOutcome> => ({ pendingReload: false })
      );
  }

  const baseArgs = () => ({
    containerHost: '127.0.0.1',
    hostPort: 9001,
    options: { output: 'cdk.out' },
    resolvedTarget: 'ChatAgent',
    resolved: baseRuntime(),
    synthesizer,
    synthOpts: {} as never,
    stacks: [] as StackInfo[],
  });

  it('routes a soft-reload verdict through the softReload callback (no rebuild)', async () => {
    const invokeOnce = wireOneReloadThenEnd();
    softReload.mockResolvedValue({ stacks: [] });
    const softReloadAssetCtx: ReloadAssetContext = {
      oldAssetHash: 'OLDHASH',
      newAssetHash: 'NEWHASH',
      newAssetSourceDir: '/cdk.out/asset.NEWHASH',
      dockerFile: '.cdkd-agentcore-generated-Dockerfile',
    };

    await runAgentCoreWatchLoop({
      ...baseArgs(),
      invokeOnce,
      rebuild,
      softReload,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => softReloadAssetCtx,
    });

    expect(softReload).toHaveBeenCalledTimes(1);
    expect(softReload.mock.calls[0]?.[0]).toBe('/cdk.out/asset.NEWHASH');
    expect(rebuild).not.toHaveBeenCalled();
    expect(invokeOnce).toHaveBeenCalledTimes(2);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('routes a rebuild verdict through the rebuild callback (classifier ctx undefined)', async () => {
    const invokeOnce = wireOneReloadThenEnd();
    rebuild.mockResolvedValue({ containerId: 'newId', hostPort: 9002, stacks: [] });

    await runAgentCoreWatchLoop({
      ...baseArgs(),
      invokeOnce,
      rebuild,
      softReload,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => undefined,
    });

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(softReload).not.toHaveBeenCalled();
    expect(invokeOnce).toHaveBeenCalledTimes(2);
  });

  it('falls back to rebuild when the classifier context build throws', async () => {
    const invokeOnce = wireOneReloadThenEnd();
    rebuild.mockResolvedValue({ containerId: 'newId', hostPort: 9099, stacks: [] });

    await runAgentCoreWatchLoop({
      ...baseArgs(),
      invokeOnce,
      rebuild,
      softReload,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => {
        throw new Error('synth boom');
      },
    });

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(softReload).not.toHaveBeenCalled();
  });

  it('aborts the active invocation on a reload firing (clean WS close before swap)', async () => {
    // The first invoke records whether its abort signal fired. A reload firing
    // must abort it so the socket closes cleanly before the container swap.
    let firstAbortFired = false;
    const invokeOnce = vi
      .fn()
      .mockImplementationOnce(
        async ({ abortSignal }: { abortSignal: AbortSignal }): Promise<AgentCoreWatchInvokeOutcome> => {
          process.nextTick(() => onChangeRef?.(['/abs/handler.py']));
          await new Promise<void>((res) => {
            abortSignal.addEventListener('abort', () => {
              firstAbortFired = true;
              res();
            });
          });
          return { pendingReload: abortSignal.aborted };
        }
      )
      .mockImplementationOnce(
        async (): Promise<AgentCoreWatchInvokeOutcome> => ({ pendingReload: false })
      );
    rebuild.mockResolvedValue({ containerId: 'newId', hostPort: 9002, stacks: [] });

    await runAgentCoreWatchLoop({
      ...baseArgs(),
      invokeOnce,
      rebuild,
      softReload,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => undefined,
    });

    expect(firstAbortFired).toBe(true);
  });

  it('serializes two rapid reload firings (no parallel reloads)', async () => {
    // Track concurrent rebuild executions; the reload chain must never run two
    // at once even when two firings land back-to-back.
    let inFlight = 0;
    let maxInFlight = 0;
    rebuild.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return { containerId: 'newId', hostPort: 9002, stacks: [] };
    });
    const invokeOnce = vi
      .fn()
      .mockImplementationOnce(
        async ({ abortSignal }: { abortSignal: AbortSignal }): Promise<AgentCoreWatchInvokeOutcome> => {
          // Fire TWO changes nearly simultaneously.
          process.nextTick(() => {
            onChangeRef?.(['/abs/a.py']);
            onChangeRef?.(['/abs/b.py']);
          });
          await new Promise<void>((res) => {
            abortSignal.addEventListener('abort', () => res());
          });
          return { pendingReload: abortSignal.aborted };
        }
      )
      .mockImplementation(async (): Promise<AgentCoreWatchInvokeOutcome> => ({ pendingReload: false }));

    await runAgentCoreWatchLoop({
      ...baseArgs(),
      invokeOnce,
      rebuild,
      softReload,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => undefined,
    });

    expect(maxInFlight).toBe(1);
  });

  it('exits the loop when the rebuild callback rejects (no hang on stale port)', async () => {
    let pingCalls = 0;
    waitForPing = vi.fn().mockImplementation(async () => {
      pingCalls += 1;
    });
    const invokeOnce = vi
      .fn()
      .mockImplementationOnce(
        async ({ abortSignal }: { abortSignal: AbortSignal }): Promise<AgentCoreWatchInvokeOutcome> => {
          process.nextTick(() => onChangeRef?.(['/abs/handler.py']));
          await new Promise<void>((res) => {
            abortSignal.addEventListener('abort', () => res());
          });
          return { pendingReload: abortSignal.aborted };
        }
      );
    rebuild.mockRejectedValue(new Error('build failed: missing Dockerfile'));

    await runAgentCoreWatchLoop({
      ...baseArgs(),
      invokeOnce,
      rebuild,
      softReload,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => undefined,
    });

    expect(rebuild).toHaveBeenCalledTimes(1);
    // Exactly one waitForPing (before the first session); the loop must NOT
    // enter a second iteration that would ping the stale port.
    expect(pingCalls).toBe(1);
    expect(invokeOnce).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('exits on a benign close with no pending reload', async () => {
    const invokeOnce = vi
      .fn()
      .mockResolvedValue({ pendingReload: false } satisfies AgentCoreWatchInvokeOutcome);

    await runAgentCoreWatchLoop({
      ...baseArgs(),
      invokeOnce,
      rebuild,
      softReload,
      __waitForPing: waitForPing,
      __watcherFactory: () => watcher,
      __classifierContext: async () => undefined,
    });

    expect(invokeOnce).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(softReload).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalled();
  });
});

describe('loadAgentCoreAssetContext — code-artifact path', () => {
  it('returns undefined for a fromS3 bundle (no local source tree → rebuild)', async () => {
    const resolved = {
      logicalId: 'ChatAgent',
      stack: { stackName: 'App' },
      containerUri: undefined,
      codeArtifact: {
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        codeAssetHash: 'H',
        s3Source: { bucket: 'b', key: 'k' },
      },
    } as unknown as ResolvedAgentCoreRuntime;
    const ctx = await loadAgentCoreAssetContext({
      resolvedTarget: 'ChatAgent',
      resolved,
      stacks: [{ stackName: 'App' } as StackInfo],
      cdkOutDir: 'cdk.out',
      assetLoader: { loadManifest: vi.fn() } as never,
    });
    expect(ctx).toBeUndefined();
  });
});

describe('softReloadAgentContainer — docker cp + docker restart wiring', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('inspects WORKDIR, then docker cp <src>/. <id>:<workdir>/, then docker restart <id>', async () => {
    execFileMock.mockImplementation((_cmd: string, argv: string[]) =>
      argv[0] === 'inspect' ? '/srv/app\n' : ''
    );

    await softReloadAgentContainer('cidXYZ', '/cdk.out/asset.HASH');

    expect(execFileMock).toHaveBeenCalledTimes(3);
    const argvOf = (n: number): string[] => (execFileMock.mock.calls[n] as [string, string[]])[1];
    expect(argvOf(0)).toEqual(['inspect', '--format', '{{.Config.WorkingDir}}', 'cidXYZ']);
    expect(argvOf(1)).toEqual(['cp', '/cdk.out/asset.HASH/.', 'cidXYZ:/srv/app/']);
    expect(argvOf(2)).toEqual(['restart', 'cidXYZ']);
  });

  it('defaults WORKDIR to `/` (single trailing slash) when docker inspect returns empty', async () => {
    execFileMock.mockImplementation((_cmd: string, argv: string[]) =>
      argv[0] === 'inspect' ? '\n' : ''
    );

    await softReloadAgentContainer('cidEmpty', '/cdk.out/asset.HASH');

    const argvOf = (n: number): string[] => (execFileMock.mock.calls[n] as [string, string[]])[1];
    expect(argvOf(1)).toEqual(['cp', '/cdk.out/asset.HASH/.', 'cidEmpty:/']);
  });

  it('surfaces a docker cp failure as a typed CdkdError (restart not run)', async () => {
    execFileMock.mockImplementation((_cmd: string, argv: string[]) =>
      argv[0] === 'cp' ? new Error('cp: permission denied') : '/srv/app\n'
    );

    await expect(softReloadAgentContainer('cid', '/src')).rejects.toThrow(/docker cp/);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('preserves docker stderr inside the wrapped error message', async () => {
    execFileMock.mockImplementation((_cmd: string, argv: string[]) => {
      if (argv[0] === 'cp') {
        return Object.assign(new Error('Command failed with exit code 1'), {
          stderr: 'Error: No such container: cid_gone\n',
        });
      }
      return '/srv/app\n';
    });

    await expect(softReloadAgentContainer('cid_gone', '/src')).rejects.toThrow(
      /No such container: cid_gone/
    );
  });
});
