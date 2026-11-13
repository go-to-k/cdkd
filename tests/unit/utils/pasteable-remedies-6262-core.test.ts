import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { buildProgram } from '../../../src/cli/program.js';
import { setPasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import {
  pasteableCommand,
  withheldTargetClause,
} from '../../../src/utils/pasteable-command.js';
import { missingStateBucketRemedy } from '../../../src/utils/missing-state-bucket-remedy.js';
import {
  ExportInUseError,
  ResourceUpdateNotSupportedError,
  StackHasActiveImportsError,
} from '../../../src/utils/error-handler.js';
import { watchCommandInterrupt } from '../../../src/utils/interrupt-signals.js';
import { movedToHint } from '../../../src/analyzer/refactor-hints.js';
import { differingRemedy } from '../../../src/analyzer/refactor-pairing.js';
import { refactorMarkerRefusalMessage } from '../../../src/state/refactor-marker.js';
import { membershipSecretDerivedRepair } from '../../../src/provisioning/providers/iam-user-group/shared.js';
import { policySecretDerivedRepair } from '../../../src/provisioning/providers/iam-policy/shared.js';
import { unresolvedTokenDeleteRemedy } from '../../../src/provisioning/providers/custom-resource/delete-skip-reasons.js';
import { staleRecordRemedy } from '../../../src/deployment/intrinsic-resolver/getatt-heal.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { refuseMarkedNoEchoRecreate } from '../../../src/deployment/rollback-executor/replay-noecho.js';
import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver/target.js';
import { importRemedyCommand } from '../../../src/provisioning/import-helpers.js';

/**
 * go-to-k/cdkd#6262, core lane: every `cdkd ...` remedy a provider, deployment,
 * state, analyzer or utils message tells the operator to run carries the run's
 * typed `--aws-emulator`, and prints byte-identical text when no flag is typed.
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
function bothWays(render: () => string): { plain: string; emulated: string } {
  setPasteableRunFlags({});
  const plain = render();
  setPasteableRunFlags({ awsEmulator: EMU });
  const emulated = render();
  setPasteableRunFlags({});
  return { plain, emulated };
}

describe('bootstrap', () => {
  it('missingStateBucketRemedy names the real-AWS bootstrap with the typed flag', () => {
    const { plain, emulated } = bothWays(() => missingStateBucketRemedy('it'));
    expect(plain).toBe("Run 'cdkd bootstrap' to create it.");
    expect(emulated).toBe(`Run 'cdkd bootstrap ${WITH}' to create it.`);
  });
});

describe('refactor', () => {
  it('movedToHint and differingRemedy and the marker refusal carry the flag', () => {
    const hint = bothWays(() => movedToHint({ stackName: 'S', logicalId: 'L' }));
    expect(hint.plain).toBe(" (moved to S.L, run 'cdkd refactor' to keep it)");
    expect(hint.emulated).toBe(` (moved to S.L, run 'cdkd refactor ${WITH}' to keep it)`);

    const remedy = bothWays(() => differingRemedy(['Properties.X']));
    expect(remedy.plain).toContain('revert the property change, run cdkd refactor, then deploy');
    expect(remedy.emulated).toContain(
      `revert the property change, run cdkd refactor ${WITH}, then deploy`
    );

    const marker = bothWays(() =>
      refactorMarkerRefusalMessage(
        {
          kind: 'moves',
          moves: [
            {
              fromStack: 'Old',
              fromRegion: 'us-east-1',
              from: 'A',
              toStack: 'New',
              toRegion: 'us-east-1',
              to: 'B',
            },
          ],
        } as never,
        'Old',
        'us-east-1',
        'cdkd deploy'
      ) ?? ''
    );
    expect(marker.plain).toContain("Run 'cdkd refactor Old' to finish the move, then re-run.");
    expect(marker.emulated).toContain(
      `Run 'cdkd refactor Old ${WITH}' to finish the move, then re-run.`
    );
  });
});

describe('orphan', () => {
  it('prints the construct path as a quoted hole, then the flag', () => {
    const { plain, emulated } = bothWays(() => membershipSecretDerivedRepair());
    expect(plain).toContain("drop this record with cdkd orphan '<constructPath>' so the next");
    expect(emulated).toContain(
      `drop this record with cdkd orphan '<constructPath>' ${WITH} so the next`
    );
    const policy = bothWays(() => policySecretDerivedRepair(false));
    expect(policy.plain).toContain("then drop this record with cdkd orphan '<constructPath>' so");
    expect(policy.emulated).toContain(
      `then drop this record with cdkd orphan '<constructPath>' ${WITH} so`
    );
  });
});

describe('import / state orphan', () => {
  it('unresolvedTokenDeleteRemedy re-runs cdkd import with the flag', () => {
    const { plain, emulated } = bothWays(() =>
      unresolvedTokenDeleteRemedy({ stackDestroy: true } as never, 'Res')
    );
    expect(plain).toMatch(/^re-run 'cdkd import', or drop the record with /);
    expect(emulated).toMatch(new RegExp(`^re-run 'cdkd import ${WITH}', or drop the record with `));
  });
});

describe('deploy', () => {
  it('ResourceUpdateNotSupportedError names cdkd deploy with the flag', () => {
    const { plain, emulated } = bothWays(
      () => new ResourceUpdateNotSupportedError('AWS::X::Y', 'L').message
    );
    expect(plain).toContain('use cdkd deploy with --replace, or change the resource definition');
    expect(emulated).toContain(`use cdkd deploy ${WITH} with --replace, or change the resource`);
  });

  it('staleRecordRemedy names cdkd deploy (and import) with the flag', () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { plain, emulated } = bothWays(() => staleRecordRemedy(resolver, undefined));
    expect(plain).toContain("Run 'cdkd deploy': it re-reads");
    expect(plain).toContain("re-import it with 'cdkd import'");
    expect(emulated).toContain(`Run 'cdkd deploy ${WITH}': it re-reads`);
    expect(emulated).toContain(`re-import it with 'cdkd import ${WITH}'`);
  });

  it('refuseMarkedNoEchoRecreate names cdkd deploy with the flag', () => {
    const thrown = (): string => {
      try {
        refuseMarkedNoEchoRecreate({ P: '***' }, [['P']] as never, 'Res');
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    const { plain, emulated } = bothWays(thrown);
    expect(plain).toContain("Restore the stack with 'cdkd deploy', which sends");
    expect(emulated).toContain(`Restore the stack with 'cdkd deploy ${WITH}', which sends`);
  });
});

describe('drift', () => {
  it('staleRecordRemedy names cdkd drift with the flag on a not-found read', () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { plain, emulated } = bothWays(() =>
      staleRecordRemedy(resolver, { kind: 'not-found' } as never)
    );
    expect(plain).toContain("Check it with 'cdkd drift', then re-create it");
    expect(emulated).toContain(`Check it with 'cdkd drift ${WITH}', then re-create it`);
  });
});

describe('destroy', () => {
  it('StackHasActiveImportsError names cdkd destroy with the consumer hole and the flag', () => {
    const { plain, emulated } = bothWays(
      () =>
        new StackHasActiveImportsError('Producer', 'us-east-1', [
          { consumerStack: 'Consumer', consumerRegion: 'us-east-1', exportName: 'Producer:X' },
        ]).message
    );
    expect(plain).toContain("Destroy the consumer first: cdkd destroy '<consumer-stack>'\n");
    expect(emulated).toContain(
      `Destroy the consumer first: cdkd destroy '<consumer-stack>' ${WITH}\n`
    );
  });
});

describe('state show / state list', () => {
  it('ExportInUseError names cdkd state show with the flag', () => {
    const { plain, emulated } = bothWays(
      () =>
        new ExportInUseError('Producer', 'us-east-1', [], {
          unreadable: [{ stackName: 'Consumer', region: 'us-east-1' }],
        }).message
    );
    expect(plain).toContain("(cdkd state show '<stack>'), then retry.");
    expect(emulated).toContain(`(cdkd state show '<stack>' ${WITH}), then retry.`);
  });

  it('withheldTargetClause names cdkd state list --long with the flag', () => {
    const built = pasteableCommand('cdkd destroy', [{ value: 'a b', hole: 'stack' }]);
    const { plain, emulated } = bothWays(() =>
      withheldTargetClause(built, 'stack', 'cdkd destroy')
    );
    expect(plain).toContain("as stored with 'cdkd state list --long' and act on");
    expect(emulated).toContain(`as stored with 'cdkd state list --long ${WITH}' and act on`);
  });
});

describe('force-unlock', () => {
  it('the force-quit notice prints the stack-name hole, then the flag', () => {
    const run = (): string => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const output: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as typeof process.stderr.write;
      const watch = watchCommandInterrupt({ command: 'cdkd destroy' });
      try {
        process.emit('SIGINT', 'SIGINT');
        process.emit('SIGINT', 'SIGINT');
      } finally {
        watch.dispose();
        process.stderr.write = original;
        exit.mockRestore();
      }
      return output.join('');
    };
    const { plain, emulated } = bothWays(run);
    expect(plain).toContain("release it with: cdkd force-unlock '<stack-name>'\n");
    expect(emulated).toContain(`release it with: cdkd force-unlock '<stack-name>' ${WITH}\n`);
  });
});

describe('local invoke', () => {
  it('names cdkd local invoke with the flag when a Lambda is given to run-task', () => {
    const stacks = [
      {
        stackName: 'S',
        displayName: 'S',
        template: { Resources: { Fn: { Type: 'AWS::Lambda::Function' } } },
      },
    ] as never;
    const render = (): string => {
      try {
        resolveEcsTaskTarget('S:Fn', stacks);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    const { plain, emulated } = bothWays(render);
    expect(plain).toContain('Use `cdkd local invoke` for Lambda;');
    expect(emulated).toContain(`Use \`cdkd local invoke ${WITH}\` for Lambda;`);
  });
});

describe('import (bucket-policy remedy)', () => {
  it('names a plain stack and assignment, then the flag', () => {
    const { plain, emulated } = bothWays(() => importRemedyCommand('MyStack', 'Policy=my-bucket'));
    expect(plain).toBe('cdkd import MyStack --resource Policy=my-bucket');
    expect(emulated).toBe(`cdkd import MyStack --resource Policy=my-bucket ${WITH}`);
  });

  it('quotes every placeholder, so no bare < > swallows the appended flag', () => {
    const { emulated } = bothWays(() => importRemedyCommand('a b', '<logicalId>=<bucketName>'));
    expect(emulated).toBe(`cdkd import '<stackName>' --resource '<logicalId>'='<bucketName>' ${WITH}`);
  });
});
