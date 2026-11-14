import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { mockS3Send, mockStsSend, stateBackendMocks, loggerMocks } = vi.hoisted(
  () => ({
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
      listRawObjects: vi.fn(),
      deleteRawObjects: vi.fn(),
      destroyClient: vi.fn(),
      getState: vi.fn(async () => null),
      saveState: vi.fn(),
      listStacks: vi.fn(),
      verifyBucketExists: vi.fn(),
      rotateCreateTokenNonce: vi.fn(),
      loadRollbackJournal: vi.fn(async () => null),
    },
    loggerMocks: {
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  })
);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerMocks, child: () => loggerMocks }),
}));
vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));
vi.mock('../../../src/utils/aws-clients.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/aws-clients.js')>()),
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return { send: mockS3Send, destroy: vi.fn() };
    },
    get sts() {
      return { send: mockStsSend, destroy: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({ sts: { send: mockStsSend }, s3: { send: mockS3Send } }),
  runWithStackAwsClients: (_c: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/state/s3-state-backend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/state/s3-state-backend.js')>()),
  S3StateBackend: vi.fn().mockImplementation(() => stateBackendMocks),
}));
vi.mock('../../../src/state/lock-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/state/lock-manager.js')>()),
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    acquireLockWithRetry: vi.fn(async () => undefined),
    getLockInfo: vi.fn(async () => null),
    isLocked: vi.fn(async () => false),
    releaseLock: vi.fn(async () => undefined),
  })),
}));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-sts')>()),
  STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend, destroy: vi.fn() })),
}));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send, destroy: vi.fn() })),
  };
});
// Let action errors propagate to parseAsync instead of process.exit-ing.
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

import { buildProgram } from '../../../src/cli/program.js';
import { setPasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import { refusedBaselineRemedy } from '../../../src/cli/commands/refused-baseline-remedy.js';
import { resolveSingleRegion } from '../../../src/cli/commands/state/refs.js';
import { nonInteractiveBrowseRefusal } from '../../../src/cli/commands/state-browse.js';
import { blockedMigrationTail } from '../../../src/cli/commands/export/import-plan.js';
import {
  refuseTransientContextIfUnsafe,
  phase2RetryCommand,
} from '../../../src/cli/commands/export/command-helpers.js';
import { resolveRouteDestination } from '../../../src/cli/commands/export/composite-id-shapes.js';
import { orphanCommandFor } from '../../../src/cli/commands/export/render.js';
import { rerunRollback, failedRollbackTail } from '../../../src/cli/commands/rollback/render.js';
import { confirmPrompt as retirementConfirmPrompt } from '../../../src/cli/commands/retire-cfn-stack/prepare.js';
import { judgeAcceptRefused } from '../../../src/cli/commands/state-refresh-observed.js';
import { revertCommandLine } from '../../../src/cli/commands/drift/plan.js';
import { customResourcesWithoutAppMessage } from '../../../src/cli/commands/destroy-runner/emulator-custom-resources.js';
import { unresolvableCrossStackReadError } from '../../../src/cli/commands/scrub/cross-stack-refusals.js';
import { skippedDestroyMessage } from '../../../src/cli/commands/destroy-skip-message.js';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import { createRollbackCommand } from '../../../src/cli/commands/rollback.js';
import { createPublishAssetsCommand } from '../../../src/cli/commands/publish-assets.js';
import { resolveStateBucketWithDefault } from '../../../src/cli/config-loader.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateDestroyCommand } from '../../../src/cli/commands/state/destroy.js';
import { createStateOrphanCommand } from '../../../src/cli/commands/state/orphan.js';
import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { pickStackRegion } from '../../../src/cli/commands/export/command-helpers.js';
import { createImportCommand } from '../../../src/cli/commands/import.js';
import { createGcCommand } from '../../../src/cli/commands/gc.js';
import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';
import { createStateMigrateCommand } from '../../../src/cli/commands/state-migrate.js';
import { createApprovalPrompter } from '../../../src/cli/commands/require-approval.js';
import { printDestroySummary } from '../../../src/cli/commands/destroy-runner/under-lock-steps.js';

/**
 * go-to-k/cdkd#6262, round 2, `src/cli/**` lane: every `cdkd ...` remedy a CLI
 * message tells the operator to run carries the run's typed `--aws-emulator`,
 * and prints byte-identical text when no flag is typed.
 */
const EMU = 'https://127.0.0.1:4599';
const WITH = `--aws-emulator=${EMU}`;

beforeEach(() => {
  buildProgram();
  setPasteableRunFlags({});
});
afterEach(() => {
  setPasteableRunFlags({});
  vi.restoreAllMocks();
});

/** Run `render` with no flag, then with the emulator typed. */
function bothWays<T>(render: () => T): { plain: T; emulated: T } {
  setPasteableRunFlags({});
  const plain = render();
  setPasteableRunFlags({ awsEmulator: EMU });
  const emulated = render();
  setPasteableRunFlags({});
  return { plain, emulated };
}

async function bothWaysAsync<T>(render: () => Promise<T>): Promise<{ plain: T; emulated: T }> {
  setPasteableRunFlags({});
  const plain = await render();
  setPasteableRunFlags({ awsEmulator: EMU });
  const emulated = await render();
  setPasteableRunFlags({});
  return { plain, emulated };
}

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('did not throw');
};

const messageOfAsync = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (process.env.DBG6262) console.log((e as Error).stack);
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('did not reject');
};

describe('state: refs.ts, state-browse.ts, state-refresh-observed.ts, refused-baseline-remedy.ts', () => {
  it('resolveSingleRegion names `cdkd state list` with the flag', () => {
    const { plain, emulated } = bothWays(() => messageOf(() => resolveSingleRegion('S', [], undefined)));
    expect(plain).toContain("Run 'cdkd state list' to see available stacks.");
    expect(emulated).toContain(`Run 'cdkd state list ${WITH}' to see available stacks.`);
  });

  it('nonInteractiveBrowseRefusal names `cdkd state list` with the flag', () => {
    const { plain, emulated } = bothWays(() => nonInteractiveBrowseRefusal().message);
    expect(plain).toContain('use cdkd state list,');
    expect(emulated).toContain(`use cdkd state list ${WITH},`);
  });

  it('judgeAcceptRefused (no refusal to accept) names `cdkd state refresh-observed` with the flag', () => {
    const judge = (): string => {
      const v = judgeAcceptRefused({ type: 'AWS::S3::Bucket' } as never, 'L', {}, {} as never);
      return v.ok ? '' : v.reason;
    };
    const { plain, emulated } = bothWays(judge);
    expect(plain).toContain("Run 'cdkd state refresh-observed' without --accept-refused");
    expect(emulated).toContain(
      `Run 'cdkd state refresh-observed ${WITH}' without --accept-refused`
    );
  });

  it('refusedBaselineRemedy spells the accept-refused command with the flag', () => {
    const remedy = (): string =>
      refusedBaselineRemedy({
        observedBaselineRefused: true,
        observedBaselineRefusalReason: 'unverifiable-parameter',
      }) ?? '';
    const { plain, emulated } = bothWays(remedy);
    expect(plain).toContain(
      "cdkd state refresh-observed '<stack>' --accept-refused '<logicalId>' --template '<file>' records a baseline"
    );
    expect(emulated).toContain(
      `cdkd state refresh-observed '<stack>' --accept-refused '<logicalId>' --template '<file>' ${WITH} records a baseline`
    );
  });
});

describe('rollback: render.ts', () => {
  it('rerunRollback names the re-run with the flag', () => {
    const { plain, emulated } = bothWays(() => rerunRollback('S'));
    expect(plain).toContain('\nRe-run with: cdkd rollback S');
    expect(emulated).toContain(`\nRe-run with: cdkd rollback S ${WITH}`);
  });

  it('failedRollbackTail ends in the re-run command', () => {
    const { plain, emulated } = bothWays(() => failedRollbackTail('S', 'us-east-1', []));
    expect(plain).toContain('Re-run with: cdkd rollback S');
    expect(emulated).toContain(`Re-run with: cdkd rollback S ${WITH}`);
  });
});

describe('export: command-helpers.ts, import-plan.ts, render.ts, composite-id-shapes.ts', () => {
  it('refuseTransientContextIfUnsafe tells the operator to re-run `cdkd export` with the flag', () => {
    const { plain, emulated } = bothWays(() =>
      messageOf(() =>
        refuseTransientContextIfUnsafe({ context: ['k=v'], acceptTransientContext: false })
      )
    );
    expect(plain).toContain('cdkd export without -c.');
    expect(emulated).toContain(`cdkd export ${WITH} without -c.`);
  });

  it('phase2RetryCommand is an aws command, untouched by the run flags', () => {
    const { plain, emulated } = bothWays(() => phase2RetryCommand('Stack'));
    expect(emulated).toBe(plain);
  });

  it('blockedMigrationTail names the destroy and re-export remedies with the flag', () => {
    const generic = [{ logicalId: 'A', resourceType: 'T', reason: 'r' }] as never;
    const { plain, emulated } = bothWays(() => blockedMigrationTail(generic));
    expect(plain).toContain('(cdkd destroy / cdkd state destroy cherry-picked)');
    expect(emulated).toContain(`(cdkd destroy ${WITH} / cdkd state destroy ${WITH} cherry-picked)`);

    const repaired = [{ logicalId: 'A', resourceType: 'T', reason: 'r', repair: 'x' }] as never;
    const again = bothWays(() => blockedMigrationTail(repaired));
    expect(again.plain).toBe("Run each row's 'Repair with:' command, then re-run cdkd export.");
    expect(again.emulated).toBe(
      `Run each row's 'Repair with:' command, then re-run cdkd export ${WITH}.`
    );
  });

  it('orphanCommandFor lists the records with the flag, in both account shapes', () => {
    const { plain, emulated } = bothWays(() => orphanCommandFor('-bad', 'us-east-1').note);
    expect(plain).toContain("List the records with 'cdkd state list --json' and ");
    expect(emulated).toContain(`List the records with 'cdkd state list --json ${WITH}' and `);

    const withAccount = bothWays(
      () => orphanCommandFor('-bad', 'us-east-1', { profile: 'p' } as never).note
    );
    expect(withAccount.plain).toContain("'cdkd state list --json");
    expect(withAccount.emulated).toContain(WITH);
  });

  it('resolveRouteDestination warns with the `cdkd import --resource` remedy and the flag', () => {
    const warn = loggerMocks.warn;
    const run = (): string => {
      warn.mockClear();
      resolveRouteDestination('10.0.0.0/16', { DestinationIpv6CidrBlock: '2001:db8::/32' });
      return warn.mock.calls.map((c) => String(c[0])).join('\n');
    };
    const { plain, emulated } = bothWays(run);
    expect(plain).toContain("through 'cdkd import --resource' with the correct id.");
    expect(emulated).toContain(`through 'cdkd import --resource ${WITH}' with the correct id.`);
  });
});

describe('retire-cfn-stack: prepare.ts', () => {
  it('the non-interactive refusal names `cdkd import --migrate-from-cloudformation` with the flag', async () => {
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(() => retirementConfirmPrompt('Retire?'))
    );
    expect(plain).toContain('Pass -y / --yes on cdkd import --migrate-from-cloudformation. ');
    expect(emulated).toContain(
      `Pass -y / --yes on cdkd import --migrate-from-cloudformation ${WITH}. `
    );
  });
});

describe('drift: plan.ts', () => {
  it('revertCommandLine carries the flag before --revert', () => {
    const { plain, emulated } = bothWays(() => revertCommandLine('S', 'us-east-1'));
    expect(plain).toBe('cdkd drift S --stack-region us-east-1 --revert');
    expect(emulated).toBe(`cdkd drift S --stack-region us-east-1 ${WITH} --revert`);
  });
});

describe('destroy: destroy-runner/emulator-custom-resources.ts, destroy-skip-message.ts', () => {
  it('customResourcesWithoutAppMessage ends in the destroy command with the flag', () => {
    const found = [{ stackName: 'S', customResources: ['CR'] }];
    const { plain, emulated } = bothWays(() => customResourcesWithoutAppMessage(found));
    expect(plain).toContain("\nRun from the app's directory: cdkd destroy S");
    expect(emulated).toContain(`\nRun from the app's directory: cdkd destroy S ${WITH}`);
  });

  it('skippedDestroyMessage re-runs the destroy that was run, with the flag', () => {
    const plainDestroy = bothWays(() => skippedDestroyMessage(1, 0, 'cdkd destroy'));
    expect(plainDestroy.plain).toContain("re-run 'cdkd destroy';");
    expect(plainDestroy.emulated).toContain(`re-run 'cdkd destroy ${WITH}';`);
    const stateDestroy = bothWays(() => skippedDestroyMessage(1, 0, 'cdkd state destroy'));
    expect(stateDestroy.plain).toContain("re-run 'cdkd state destroy';");
    expect(stateDestroy.emulated).toContain(`re-run 'cdkd state destroy ${WITH}';`);
  });
});

describe('scrub: cross-stack-refusals.ts', () => {
  it('unresolvableCrossStackReadError names `cdkd scrub` with the flag', () => {
    const { plain, emulated } = bothWays(
      () =>
        unresolvableCrossStackReadError(
          'o',
          'S',
          'Fn::ImportValue',
          '',
          new Error('x'),
          new Map()
        ).message
    );
    expect(plain).toContain("re-run 'cdkd scrub'.");
    expect(emulated).toContain(`re-run 'cdkd scrub ${WITH}'.`);
  });
});

describe('local-start-api: command.ts', () => {
  it('the --api deprecation names the positional form with the flag', async () => {
    const run = async (): Promise<string> => {
      const warn = loggerMocks.warn;
      warn.mockClear();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      vi.spyOn(Synthesizer.prototype, 'synthesize').mockResolvedValue({ stacks: [] } as never);
      try {
        const cmd = createLocalStartApiCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['--api', 'MyApi', '--app', 'node app.js'], { from: 'user' });
      } catch {
        // the run refuses on an empty assembly; only the warning is read
      }
      const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
      return text;
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain("Use the positional argument instead: cdkd local start-api '<id>'.");
    expect(emulated).toContain(
      `Use the positional argument instead: cdkd local start-api '<id>' ${WITH}.`
    );
  });
});

describe('require-approval.ts', () => {
  it('the non-interactive refusal names `cdkd diff` with the flag', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const request = {
      stackName: 'S',
      level: 'destructive',
      counts: { create: 1, update: 0, delete: 0 },
      destructiveChanges: [],
    } as never;
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(() => createApprovalPrompter({ yes: false })(request))
    );
    expect(plain).toContain("or review the changes with 'cdkd diff'.");
    expect(emulated).toContain(`or review the changes with 'cdkd diff ${WITH}'.`);
  });
});

describe('destroy-runner/under-lock-steps.ts: printDestroySummary', () => {
  const summary = (result: Record<string, unknown>): string => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    printDestroySummary({
      result: {
        deletedCount: 1,
        retainedCount: 0,
        skippedCount: 0,
        blockedCount: 0,
        errorCount: 0,
        guardIndeterminateCount: 0,
        journaledOrphanSkips: 0,
        interrupted: false,
        ...result,
      } as never,
      ctx: {} as never,
      stackName: 'S',
      logger: logger as never,
      preserveState: true,
      guardIndeterminateTargets: new Set(),
      skippedStateTargets: new Set(['L']),
      failedStateTargets: new Set(),
      hintFor: () => '',
      hintHolesClause: () => '',
      journaledOrphanFailures: 0,
    });
    return logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
  };

  it('the interrupted arm re-runs both destroys with the flag', () => {
    const { plain, emulated } = bothWays(() => summary({ interrupted: true }));
    expect(plain).toContain("re-run 'cdkd destroy' / 'cdkd state destroy' to finish.");
    expect(emulated).toContain(
      `re-run 'cdkd destroy ${WITH}' / 'cdkd state destroy ${WITH}' to finish.`
    );
  });

  it('the failed arm re-runs both destroys with the flag', () => {
    const { plain, emulated } = bothWays(() => summary({ errorCount: 1 }));
    expect(plain).toContain("re-run 'cdkd destroy' / 'cdkd state destroy' to clean up.");
    expect(emulated).toContain(
      `re-run 'cdkd destroy ${WITH}' / 'cdkd state destroy ${WITH}' to clean up.`
    );
  });
});

describe('gc/command.ts', () => {
  it('the active-lock refusal re-runs `cdkd gc` with the flag', async () => {
    const run = async (): Promise<string> => {
      stateBackendMocks.getRawObject.mockResolvedValue(
        JSON.stringify({
          assetBucket: 'b',
          containerRepo: 'r',
          assetSupportVersion: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        })
      );
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) =>
        prefix === ''
          ? ['cdkd-bootstrap/us-east-1.json', 'cdkd/LockedStack/us-east-1/lock.json']
          : []
      );
      mockStsSend.mockResolvedValue({ Account: '123456789012' });
      return messageOfAsync(async () => {
        const cmd = createGcCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['--region', 'us-east-1', '--state-bucket', 'sb', '--yes'], {
          from: 'user',
        });
      });
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain("then re-run 'cdkd gc'.");
    expect(emulated).toContain(`then re-run 'cdkd gc ${WITH}'.`);
    expect(plain).toContain("cdkd force-unlock '<stack>'");
  });
});

describe('orphan.ts', () => {
  it('paths spanning two stacks name `cdkd orphan` once per stack with the flag', async () => {
    const stack = (name: string): unknown => ({
      stackName: name,
      displayName: name,
      template: {
        Resources: { R: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': `${name}/R` } } },
      },
      region: 'us-east-1',
    });
    const run = async (): Promise<string> => {
      vi.spyOn(Synthesizer.prototype, 'synthesize').mockResolvedValue({
        stacks: [stack('StackA'), stack('StackB')],
      } as never);
      stateBackendMocks.verifyBucketExists.mockResolvedValue(undefined);
      return messageOfAsync(async () => {
        const cmd = createOrphanCommand();
        cmd.exitOverride();
        await cmd.parseAsync(
          ['StackA/R', 'StackB/R', '--app', 'noop', '--state-bucket', 'sb', '--yes'],
          { from: 'user' }
        );
      });
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain("Run 'cdkd orphan' once per stack.");
    expect(emulated).toContain(`Run 'cdkd orphan ${WITH}' once per stack.`);
  });
});

describe('state-migrate.ts', () => {
  it('the missing-source refusal points at `cdkd state info` with the flag', async () => {
    const run = async (): Promise<string> => {
      mockStsSend.mockResolvedValue({ Account: '123456789012' });
      mockS3Send.mockRejectedValue(
        Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      );
      return messageOfAsync(async () => {
        const cmd = createStateMigrateCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['--region', 'us-east-1', '--yes'], { from: 'user' });
      });
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain('(Tip: run `cdkd state info` to confirm');
    expect(emulated).toContain(`(Tip: run \`cdkd state info ${WITH}\` to confirm`);
  });
});

describe('rollback/command.ts and rollback/replay.ts', () => {
  it('a run with no journal anywhere offers `cdkd deploy` / `cdkd destroy` with the flag', async () => {
    const run = async (): Promise<string> => {
      loggerMocks.info.mockClear();
      stateBackendMocks.listRawKeys.mockResolvedValue([]);
      const cmd = createRollbackCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['--region', 'us-east-1', '--state-bucket', 'sb', '--yes'], {
        from: 'user',
      });
      return loggerMocks.info.mock.calls.map((c) => String(c[0])).join('\n');
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain("Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up.");
    expect(emulated).toContain(
      `Run 'cdkd deploy ${WITH}' to (re)deploy, or 'cdkd destroy ${WITH}' to clean up.`
    );
  });

  it('a stack whose journal is empty says the same, from the replay', async () => {
    const run = async (): Promise<string> => {
      stateBackendMocks.listStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
      return messageOfAsync(async () => {
        const cmd = createRollbackCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['S', '--region', 'us-east-1', '--state-bucket', 'sb', '--yes'], {
          from: 'user',
        });
      });
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain("Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up.");
    expect(emulated).toContain(
      `Run 'cdkd deploy ${WITH}' to (re)deploy, or 'cdkd destroy ${WITH}' to clean up.`
    );
  });
});

describe('config-loader.ts: the legacy state bucket warnings', () => {
  const plan = (newList: 'empty' | 'has-state', newHead: 'ok' | '404'): void => {
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    mockS3Send.mockImplementation(
      async (cmd: { constructor: { name: string }; input: { Bucket: string } }) => {
        const isNew = cmd.input.Bucket === 'cdkd-state-123456789012';
        if (cmd.constructor.name === 'HeadBucketCommand') {
          if (isNew && newHead === '404') {
            throw Object.assign(new Error('NotFound'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 },
            });
          }
          return {};
        }
        return { KeyCount: isNew ? (newList === 'empty' ? 0 : 1) : 1 };
      }
    );
  };

  it('both buckets exist, the new one empty: the warning names `cdkd state migrate`', async () => {
    const run = async (): Promise<string> => {
      plan('empty', 'ok');
      loggerMocks.warn.mockClear();
      await resolveStateBucketWithDefault(undefined, 'us-east-1');
      return loggerMocks.warn.mock.calls.map((c) => String(c[0])).join('\n');
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain('Run `cdkd state migrate --region us-east-1` to copy');
    expect(emulated).toContain(`Run \`cdkd state migrate --region us-east-1 ${WITH}\` to copy`);
  });

  it('only the legacy bucket exists: the warning names `cdkd state migrate`', async () => {
    const run = async (): Promise<string> => {
      plan('empty', '404');
      loggerMocks.warn.mockClear();
      await resolveStateBucketWithDefault(undefined, 'us-east-1');
      return loggerMocks.warn.mock.calls.map((c) => String(c[0])).join('\n');
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain('To migrate, run:\n\n    cdkd state migrate --region us-east-1\n\n');
    expect(emulated).toContain(
      `To migrate, run:\n\n    cdkd state migrate --region us-east-1 ${WITH}\n\n`
    );
  });
});

describe('publish-assets.ts', () => {
  it('with no state bucket, the verbatim-publish notice names `cdkd bootstrap` with the flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-6262-'));
    const manifestPath = join(dir, 'S.assets.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '38.0.0',
        files: {
          aaaa1111: {
            displayName: 'Code',
            source: { path: 'asset.aaaa1111', packaging: 'zip' },
            destinations: { d1: { bucketName: 'cdk-assets', objectKey: 'aaaa1111.zip' } },
          },
        },
        dockerImages: {},
      })
    );
    const run = async (): Promise<string> => {
      loggerMocks.info.mockClear();
      mockStsSend.mockResolvedValue({ Account: '111111111111' });
      mockS3Send.mockRejectedValue(
        Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      );
      vi.spyOn(Synthesizer.prototype, 'synthesize').mockResolvedValue({
        stacks: [
          {
            stackName: 'S',
            artifactId: 'S',
            displayName: 'S',
            template: { Resources: {} },
            dependencyNames: [],
            region: 'us-east-1',
            account: '111111111111',
            assetManifestPath: manifestPath,
          },
        ],
        manifest: {},
        assemblyDir: dir,
      } as never);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const cmd = createPublishAssetsCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['--app', 'noop', '--region', 'us-east-1'], { from: 'user' });
      } catch {
        // publishing itself is out of scope; only the notice is read
      }
      return loggerMocks.info.mock.calls.map((c) => String(c[0])).join('\n');
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain("Run 'cdkd bootstrap' to opt into cdkd-owned");
    expect(emulated).toContain(`Run 'cdkd bootstrap ${WITH}' to opt into cdkd-owned`);
  });
});

describe('state/destroy.ts, state/orphan.ts, drift/command.ts, export/command-helpers.ts', () => {
  const state = (): unknown => {
    stateBackendMocks.listStacks.mockResolvedValue([]);
    return stateBackendMocks;
  };

  it('state destroy: --all refusal names `cdkd state list` and `cdkd destroy --all` with the flag', async () => {
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(async () => {
        const cmd = createStateDestroyCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['--all', '--state-bucket', 'sb', '--region', 'us-east-1'], {
          from: 'user',
        });
      })
    );
    expect(plain).toContain("(cdkd state list shows them), or run cdkd destroy --all from the CDK app");
    expect(emulated).toContain(
      `(cdkd state list ${WITH} shows them), or run cdkd destroy --all ${WITH} from the CDK app`
    );
  });

  it('state destroy: an unknown stack names `cdkd state list` with the flag', async () => {
    state();
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(async () => {
        const cmd = createStateDestroyCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['Nope', '--yes', '--state-bucket', 'sb', '--region', 'us-east-1'], {
          from: 'user',
        });
      })
    );
    expect(plain).toContain("Run 'cdkd state list' to see available stacks.");
    expect(emulated).toContain(`Run 'cdkd state list ${WITH}' to see available stacks.`);
  });

  it('state orphan: a listed stack with no record names `cdkd state list` with the flag', async () => {
    stateBackendMocks.listStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
    stateBackendMocks.getState.mockResolvedValue(null);
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(async () => {
        const cmd = createStateOrphanCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['S', '--resource', 'L', '--yes', '--state-bucket', 'sb', '--region', 'us-east-1'], {
          from: 'user',
        });
      })
    );
    expect(plain).toContain("Run 'cdkd state list' to see available stacks.");
    expect(emulated).toContain(`Run 'cdkd state list ${WITH}' to see available stacks.`);
  });

  it('drift: an empty state bucket names `cdkd deploy` with the flag', async () => {
    state();
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(async () => {
        const cmd = createDriftCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['--state-bucket', 'sb', '--region', 'us-east-1'], {
          from: 'user',
        });
      })
    );
    expect(plain).toContain('Run `cdkd deploy` first, or pass --all explicitly.');
    expect(emulated).toContain(`Run \`cdkd deploy ${WITH}\` first, or pass --all explicitly.`);
  });

  it('drift: an unknown stack names `cdkd state list` with the flag', async () => {
    state();
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(async () => {
        const cmd = createDriftCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['Nope', '--state-bucket', 'sb', '--region', 'us-east-1'], {
          from: 'user',
        });
      })
    );
    expect(plain).toContain("Run 'cdkd state list' to see available stacks.");
    expect(emulated).toContain(`Run 'cdkd state list ${WITH}' to see available stacks.`);
  });

  it('export: pickStackRegion names `cdkd state list` with the flag', async () => {
    state();
    const { plain, emulated } = await bothWaysAsync(() =>
      messageOfAsync(() => pickStackRegion(stateBackendMocks as never, 'S', undefined, undefined))
    );
    expect(plain).toContain("Run 'cdkd state list' to see available stacks.");
    expect(emulated).toContain(`Run 'cdkd state list ${WITH}' to see available stacks.`);
  });
});

describe('import/command.ts', () => {
  it('--migrate-from-cloudformation with --dry-run points at plain `cdkd import --dry-run` with the flag', async () => {
    const run = async (): Promise<string> => {
      vi.spyOn(Synthesizer.prototype, 'synthesize').mockResolvedValue({
        stacks: [
          {
            stackName: 'S',
            artifactId: 'S',
            displayName: 'S',
            template: { Resources: {} },
            dependencyNames: [],
            region: 'us-east-1',
          },
        ],
      } as never);
      return messageOfAsync(async () => {
        const cmd = createImportCommand();
        cmd.exitOverride();
        await cmd.parseAsync(
          [
            'S',
            '--app',
            'noop',
            '--state-bucket',
            'sb',
            '--migrate-from-cloudformation',
            '--dry-run',
          ],
          { from: 'user' }
        );
      });
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain('Use plain `cdkd import --dry-run` to preview');
    expect(emulated).toContain(`Use plain \`cdkd import --dry-run ${WITH}\` to preview`);
  });
});
