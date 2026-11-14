import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { buildProgram } from '../../../src/cli/program.js';
import { setPasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { deletedOutsideCdkdMessage } from '../../../src/deployment/deleted-outside-cdkd.js';
import { unaddressableFailedCreateMessage } from '../../../src/deployment/deploy-engine/rollback/applied-nothing.js';
import { refuseRedactedAttributeReads } from '../../../src/deployment/deploy-engine/masking/noecho-attributes.js';
import { generatedReplacementHolderAdvice } from '../../../src/deployment/deploy-engine/name-collision.js';
import {
  requireRestorableBaseline,
  secretDerivedNamePairs as _unused,
} from '../../../src/deployment/rollback-executor/names.js';
import { refuseMaskedReplayBaseline } from '../../../src/deployment/rollback-executor/replay-props.js';
import {
  skipUnaddressableReplay,
  rerunRollbackPhrase,
} from '../../../src/deployment/rollback-executor/messages.js';
import { refuseUnprovenReplaySecret } from '../../../src/deployment/rollback-executor/replay-secrets.js';
import { journaledOrphanKeepReason } from '../../../src/deployment/rollback-executor/replay-failed-checks.js';
import { restoreHeldInlinePolicies } from '../../../src/deployment/rollback-executor/replay-inline-policy-restore.js';
import { writeRollbackJournalSegment } from '../../../src/deployment/deploy-engine/rollback/journal-write.js';
import {
  replayFailedOperations,
  replayRollback,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  resolvePendingCloudControlRequests,
  type AbandonedRequestReader,
} from '../../../src/deployment/cc-pending-requests.js';
import {
  markCreatedBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { staleRecordRemedy } from '../../../src/deployment/intrinsic-resolver/getatt-heal.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor/types.js';

void _unused;

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/final-snapshot.js')>();
  return { ...actual, ccRoutedInstanceTakesNoSnapshot: vi.fn(async () => false) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: vi.fn() }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/**
 * go-to-k/cdkd#6262, round 2, `deploy` lane (`src/deployment/**`): every `cdkd ...`
 * remedy a deployment message tells the operator to run carries the run's typed
 * `--aws-emulator`, and prints the old text when no flag is typed.
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

/** The message a throwing `render` throws. */
function thrown(render: () => unknown): string {
  try {
    render();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

function failedOp(overrides: Partial<FailedOperation> = {}): FailedOperation {
  return {
    logicalId: 'Q',
    changeType: 'UPDATE',
    resourceType: 'AWS::SQS::Queue',
    provisionedBy: 'sdk',
    physicalId: 'phys-Q',
    ...overrides,
  } as FailedOperation;
}

describe('deleted-outside-cdkd.ts', () => {
  it('a kept segment names the revert-failed drop with the typed flag', () => {
    const { plain, emulated } = bothWays(() => deletedOutsideCdkdMessage(failedOp(), false));
    expect(plain).toContain(" and 'cdkd rollback --revert-failed' drops its record.");
    expect(emulated).toContain(` and 'cdkd rollback --revert-failed ${WITH}' drops its record.`);
  });
});

describe('deploy-engine/rollback/applied-nothing.ts', () => {
  it('the unaddressable failed CREATE names the revert-failed command with the typed flag', () => {
    const { plain, emulated } = bothWays(() => unaddressableFailedCreateMessage(failedOp()));
    expect(plain).toContain("so 'cdkd rollback --revert-failed' cannot address it");
    expect(emulated).toContain(`so 'cdkd rollback --revert-failed ${WITH}' cannot address it`);
  });
});

describe('deploy-engine/masking/noecho-attributes.ts', () => {
  it('the cross-stack NoEcho refusal names the one-run deploy with the typed flag', () => {
    const context = {
      redactedAttributeReads: [
        {
          kind: 'cross-stack',
          display: "Fn::ImportValue 'Shared' (producer Producer / us-east-1)",
        },
      ],
    };
    const { plain, emulated } = bothWays(() =>
      thrown(() => refuseRedactedAttributeReads('Consumer', 'AWS::SSM::Parameter', context as never))
    );
    expect(plain).toContain("(cdkd deploy --all, or cdkd deploy '**' when either is inside a CDK Stage)");
    expect(emulated).toContain(
      `(cdkd deploy --all ${WITH}, or cdkd deploy '**' ${WITH} when either is inside a CDK Stage)`
    );
  });
});

describe('deploy-engine/masking/remedy.ts', () => {
  const remedyFor = (reads: unknown[], resources: Record<string, unknown>): string =>
    (
      DeployEngine as unknown as {
        maskedRecordRemedyFor(reads: unknown[], resources: Record<string, unknown>): string;
      }
    ).maskedRecordRemedyFor(reads, resources);
  const reads = [
    {
      kind: 'attribute',
      logicalId: "Bob's-Table",
      key: 'Arn',
      display: "Bob's-Table.Arn",
    },
  ];

  it('the withheld re-import names state show and the import line with the typed flag', () => {
    const { plain, emulated } = bothWays(() =>
      remedyFor(reads, { "Bob's-Table": { resourceType: 'AWS::SQS::Queue' } })
    );
    expect(plain).toContain("Read the id from 'cdkd state show' and quote it yourself, in ");
    expect(plain).toContain("cdkd import '<stack>' --resource '<id>'='<physicalId>' --force.");
    expect(emulated).toContain(`Read the id from 'cdkd state show ${WITH}' and quote it yourself, in `);
    expect(emulated).toContain(
      `cdkd import '<stack>' --resource '<id>'='<physicalId>' --force ${WITH}.`
    );
  });
});

describe('deploy-engine/name-collision.ts', () => {
  const advice = (stackName: string) =>
    generatedReplacementHolderAdvice({
      stackName,
      logicalId: 'Q',
      change: { desiredName: 'App-Q-abc', generated: true },
      oldPhysicalId: 'old-Q',
      mask: (text) => text,
    });

  it('a nested child adopts through the top-level stack with the typed flag', () => {
    const { plain, emulated } = bothWays(() => advice('Parent~Child'));
    expect(plain).toContain('adopt it through the top-level stack with `cdkd import` (then delete');
    expect(emulated).toContain(
      `adopt it through the top-level stack with \`cdkd import ${WITH}\` (then delete`
    );
  });

  it('a top-level stack names the full import command with the typed flag', () => {
    const { plain, emulated } = bothWays(() => advice('App'));
    expect(plain).toContain("adopt it with cdkd import App --resource 'Q=App-Q-abc' (using");
    expect(emulated).toContain(`adopt it with cdkd import App --resource 'Q=App-Q-abc' ${WITH} (using`);
  });
});

describe('rollback-executor/names.ts', () => {
  it('an unusable baseline names the fix-forward and destroy remedies with the typed flag', () => {
    const logger = { warn: vi.fn() };
    const { plain, emulated } = bothWays(() =>
      thrown(() =>
        requireRestorableBaseline('not-a-bag', logger as never, {
          logicalId: 'L',
          consequence: 'x',
          remedy: 'r',
          retry: 'retry it',
        })
      )
    );
    expect(plain).toContain('fix forward with `cdkd deploy`, or remove the stack with `cdkd destroy`.');
    expect(emulated).toContain(
      `fix forward with \`cdkd deploy ${WITH}\`, or remove the stack with \`cdkd destroy ${WITH}\`.`
    );
  });
});

describe('rollback-executor/replay-props.ts', () => {
  it('the masked baseline refusal quotes each import placeholder and carries the flag', () => {
    const { plain, emulated } = bothWays(() =>
      thrown(() => refuseMaskedReplayBaseline({ P: '***' }, 'L'))
    );
    expect(plain).toContain("cdkd import '<stack>' --resource '<logicalId>'='<physicalId>' --force,");
    expect(plain).toContain("restore the property with 'cdkd deploy' AFTER");
    expect(emulated).toContain(
      `cdkd import '<stack>' --resource '<logicalId>'='<physicalId>' --force ${WITH},`
    );
    expect(emulated).toContain(`restore the property with 'cdkd deploy ${WITH}' AFTER`);
  });
});

describe('rollback-executor/messages.ts', () => {
  it('an unaddressable record names state show and deploy with the typed flag', () => {
    const run = (): string => {
      const logger = { warn: vi.fn() };
      const scope = {
        ctx: {},
        stackName: 'S',
        result: { warnings: 0, skipped: 0 },
        mask: (t: string) => t,
      };
      skipUnaddressableReplay(
        scope as never,
        logger as never,
        { logicalId: 'L', resourceType: 'AWS::SQS::Queue', changeType: 'UPDATE' },
        'revert',
        'record'
      );
      return String(logger.warn.mock.calls[0]![0]);
    };
    const { plain, emulated } = bothWays(run);
    expect(plain).toContain('(inspect it with `cdkd state show`), then re-converge it with `cdkd deploy`.');
    expect(emulated).toContain(
      `(inspect it with \`cdkd state show ${WITH}\`), then re-converge it with \`cdkd deploy ${WITH}\`.`
    );
  });

  it('rerunRollbackPhrase prints the builder it is handed at top level only', () => {
    expect(rerunRollbackPhrase({ nestedChildStack: undefined }, 'X')).toBe('X');
  });
});

describe('rollback-executor/replay-secrets.ts', () => {
  it('a region-less secret in a nested child names the top-level re-run with the typed flag', () => {
    const run = () =>
      thrown(() =>
        refuseUnprovenReplaySecret(
          '{{resolve:secretsmanager:my-secret:SecretString}}',
          'Prop',
          'L',
          { producerRegionsIncomplete: true, region: 'us-east-1' } as never
        )
      );
    const { plain, emulated } = bothWays(run);
    expect(plain).toContain("then re-run 'cdkd rollback'.");
    expect(emulated).toContain(`then re-run 'cdkd rollback ${WITH}'.`);
  });
});

// ---- the rollback replay harness (mirrors rollback-executor-command-beside-display.test.ts) ----

const QUEUE = 'AWS::SQS::Queue';

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: QUEUE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

/** A replay context whose every log line and recorded refusal lands in `texts`. */
function makeCtx(provider: Record<string, unknown>): {
  ctx: RollbackExecutorContext;
  texts: () => string;
} {
  const lines: string[] = [];
  const push = (m: unknown): void => {
    lines.push(String(m));
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(push),
    warn: vi.fn(push),
    error: vi.fn(push),
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => lines.push(e.error?.message ?? '', e.reason ?? ''),
  };
  return { ctx, texts: () => lines.join('\n') };
}

/** Run `scenario` once per flag state; the text it returns is the whole replay output. */
async function replayBothWays(
  scenario: () => Promise<string>
): Promise<{ plain: string; emulated: string }> {
  setPasteableRunFlags({});
  const plain = await scenario();
  setPasteableRunFlags({ awsEmulator: EMU });
  const emulated = await scenario();
  setPasteableRunFlags({});
  if (process.env.R2DBG) console.log('EMU>>', emulated.slice(0, 2500));
  return { plain, emulated };
}

const reverseOp = (physicalId: string, previous: Partial<ResourceState>) => ({
  logicalId: 'B',
  changeType: 'UPDATE' as const,
  resourceType: QUEUE,
  physicalId,
  previousState: res({ physicalId: `${physicalId}-old`, properties: { QueueName: 'q', a: 1 }, ...previous }),
});

describe('rollback-executor/recreate.ts and replay-reverse-replacement.ts', () => {
  it('the name-holder refusal re-runs the rollback with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const create = vi.fn().mockRejectedValue(awsSdkError('Queue x already exists'));
      const { ctx, texts } = makeCtx({ create, delete: vi.fn() });
      await replayRollback(
        [reverseOp('phys-new', {})],
        { B: res({ physicalId: 'phys-new', properties: { QueueName: 'q2', a: 2 } }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      return texts();
    });
    expect(plain).toContain('then re-run cdkd rollback, which proceeds');
    expect(emulated).toContain(`then re-run cdkd rollback ${WITH}, which proceeds`);
  });

  it('the Retain-pinned collision refusal re-runs the rollback with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
      const { ctx, texts } = makeCtx({ create, delete: vi.fn() });
      await replayRollback(
        [reverseOp('phys-new', {})],
        {
          B: res({
            physicalId: 'phys-new',
            properties: { QueueName: 'q', a: 2 },
            updateReplacePolicy: 'Retain',
          }),
        },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      return texts();
    });
    expect(plain).toContain('then re-run cdkd rollback — the journal is kept');
    expect(emulated).toContain(`then re-run cdkd rollback ${WITH} — the journal is kept`);
  });

  it('an unrestorable baseline on a replacement names the re-run with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const { ctx, texts } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      await replayRollback(
        [reverseOp('phys-new', { properties: 'abc' as never })],
        { B: res({ physicalId: 'phys-new', properties: { a: 2 } }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      return texts();
    });
    expect(plain).toContain('re-running `cdkd rollback` retries this op');
    expect(emulated).toContain(`re-running \`cdkd rollback ${WITH}\` retries this op`);
  });

  it('an unproven surviving old resource re-runs the rollback with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const { ctx, texts } = makeCtx({ create: vi.fn(), delete: vi.fn(), readCurrentState: vi.fn().mockRejectedValue(new Error('read failed')) });
      await replayRollback(
        [{ ...reverseOp('phys-new', {}), oldResourceMaySurvive: true } as never],
        { B: res({ physicalId: 'phys-new', properties: { QueueName: 'q', a: 2 } }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      return texts();
    });
    expect(plain).toContain('re-running cdkd rollback');
    expect(emulated).toContain(`re-running cdkd rollback ${WITH}`);
  });
});

describe('rollback-executor/replay-reverse-replacement/finish.ts', () => {
  const op = {
    logicalId: 'B',
    changeType: 'UPDATE' as const,
    resourceType: QUEUE,
    provisionedBy: 'sdk' as const,
    physicalId: 'phys-new',
    previousState: res({ physicalId: 'phys-old', properties: { QueueName: 'q', a: 1 } }),
  };

  it('an adopted live new resource names drift and deploy with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const create = vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} });
      const { ctx, texts } = makeCtx({ create, delete: vi.fn() });
      await replayRollback(
        [op],
        { B: res({ physicalId: 'phys-new', properties: { QueueName: 'q', a: 2 } }) },
        'S',
        ctx
      );
      return texts();
    });
    expect(plain).toContain("run 'cdkd deploy' to reconcile");
    expect(plain).toContain('with `cdkd drift` and run `cdkd deploy` to reconcile.');
    expect(emulated).toContain(`run 'cdkd deploy ${WITH}' to reconcile`);
    expect(emulated).toContain(
      `with \`cdkd drift ${WITH}\` and run \`cdkd deploy ${WITH}\` to reconcile.`
    );
  });
});

describe('rollback-executor/replay-reverse-replacement/finish.ts (deferred delete)', () => {
  const ROLE = 'AWS::IAM::Role';
  const INLINE = 'AWS::IAM::Policy';
  const OLD_ROLE = 'App-Role-7b29ef5fc296';
  const NEW_ROLE = 'App-Role-gen2-0a1b2c3d4e5f';
  const DOC = { Version: '2012-10-17', Statement: [] };
  const rec = (physicalId: string, resourceType: string, properties: Record<string, unknown>) => ({
    physicalId,
    resourceType,
    properties,
    attributes: {},
    dependencies: resourceType === INLINE ? ['Role'] : [],
    provisionedBy: 'sdk' as const,
  });

  it('a new role another record now holds is kept and names drift with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const provider = {
        create: vi.fn(async () => ({ physicalId: OLD_ROLE, attributes: {} })),
        update: vi.fn(async (_l: string, physicalId: string) => ({ physicalId, wasReplaced: false })),
        delete: vi.fn(),
      };
      const { ctx, texts } = makeCtx(provider);
      await replayRollback(
        [
          {
            logicalId: 'Role',
            changeType: 'UPDATE',
            resourceType: ROLE,
            provisionedBy: 'sdk',
            physicalId: NEW_ROLE,
            previousState: rec(OLD_ROLE, ROLE, { AssumeRolePolicyDocument: DOC }),
            oldResourceRetained: false,
          },
          {
            logicalId: 'Policy',
            changeType: 'UPDATE',
            resourceType: INLINE,
            provisionedBy: 'sdk',
            physicalId: 'App-Role-DefaultPolicy',
            previousState: rec('App-Role-DefaultPolicy', INLINE, {
              PolicyName: 'P',
              PolicyDocument: DOC,
              Roles: [OLD_ROLE],
            }),
          },
        ],
        {
          Role: rec(NEW_ROLE, ROLE, { AssumeRolePolicyDocument: DOC }),
          Policy: rec('App-Role-DefaultPolicy', INLINE, {
            PolicyName: 'P',
            PolicyDocument: DOC,
            Roles: [NEW_ROLE],
          }),
          Other: rec(NEW_ROLE, ROLE, { AssumeRolePolicyDocument: DOC }),
        },
        'App',
        ctx
      );
      return texts();
    });
    expect(plain).toContain('physical id. Check it with cdkd drift.');
    expect(emulated).toContain(`physical id. Check it with cdkd drift ${WITH}.`);
  });
});

describe('rollback-executor/replay-revert.ts', () => {
  it('the unrestorable-baseline throw names the re-run with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const { ctx, texts } = makeCtx({ update: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: 'phys',
            previousState: { ...res(), properties: 'abc' } as unknown as ResourceState,
          },
        ],
        { B: res({ properties: { a: 1 } }) },
        'S',
        ctx
      );
      return texts();
    });
    expect(plain).toContain('re-running `cdkd rollback` retries this op');
    expect(emulated).toContain(`re-running \`cdkd rollback ${WITH}\` retries this op`);
  });

  it('the unaddressable new copy of a retained replacement names the repair with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const texts: string[] = [];
      for (const physicalId of ['phys-new', undefined]) {
        const { ctx, texts: out } = makeCtx({ create: vi.fn(), delete: vi.fn() });
        await replayRollback(
          [
            {
              logicalId: 'B',
              changeType: 'UPDATE',
              resourceType: QUEUE,
              ...(physicalId !== undefined && { physicalId }),
              previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
              oldResourceRetained: true,
            } as never,
          ],
          { B: res({ physicalId: ' ', properties: { a: 2 } }) },
          'S',
          ctx,
          { isInterrupted: () => false }
        );
        texts.push(out());
      }
      return texts.join('\n');
    });
    expect(plain).toContain('inspect it with `cdkd state show`');
    expect(plain).toContain('Then re-run `cdkd rollback`');
    expect(emulated).toContain(`inspect it with \`cdkd state show ${WITH}\``);
    expect(emulated).toContain(`Then re-run \`cdkd rollback ${WITH}\``);
  });
});

describe('rollback-executor/replay-failed.ts', () => {
  it('a failed type-change update names drift and deploy with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const { ctx, texts } = makeCtx({ update: vi.fn() });
      await replayFailedOperations(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: 'phys',
            previousState: res({ resourceType: 'AWS::SNS::Topic', properties: { a: 1 } }),
            attemptedProperties: { a: 2 },
          },
        ],
        { B: res({ properties: { a: 2 } }) },
        'S',
        ctx
      );
      return texts();
    });
    expect(plain).toContain('Inspect it with `cdkd drift` and re-converge with `cdkd deploy`. Skipping.');
    expect(emulated).toContain(
      `Inspect it with \`cdkd drift ${WITH}\` and re-converge with \`cdkd deploy ${WITH}\`. Skipping.`
    );
  });
});

describe('rollback-executor/replay-failed.ts (journaled orphan)', () => {
  it('an unreadable foreign holder keeps the orphan and names the drop-failed with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(async () => {
      const { ctx, texts } = makeCtx({ delete: vi.fn(), resourceIdentity: vi.fn() });
      ctx.foreignHolder = async () => ({ kind: 'unreadable', what: 'the state record of stack C' });
      await replayFailedOperations(
        [
          {
            logicalId: 'Orders',
            changeType: 'CREATE',
            resourceType: 'AWS::Kinesis::Stream',
            physicalId: 'orders-stream',
            provisionedBy: 'sdk',
            physicalIdRecoveredFromError: true,
            createdResourceIdentity: 'tok',
            attemptedProperties: {},
          },
        ],
        {},
        'A',
        ctx,
        {}
      );
      return texts();
    });
    expect(plain).toContain('a re-run; `cdkd rollback --drop-failed` removes only that record');
    expect(emulated).toContain(
      `a re-run; \`cdkd rollback --drop-failed ${WITH}\` removes only that record`
    );
  });
});

describe('rollback-executor/replay-failed-checks.ts', () => {
  it('an unreadable foreign-holder answer names state show with the typed flag', async () => {
    const run = async (): Promise<string> => {
      const verdict = await journaledOrphanKeepReason(
        { logicalId: 'B', resourceType: QUEUE, changeType: 'CREATE', physicalId: 'p' } as never,
        async () => {
          throw new Error('scan failed');
        },
        {} as never
      );
      return (verdict as { retry: string }).retry;
    };
    const { plain, emulated } = await replayBothWays(run);
    expect(plain).toContain('inspect it with `cdkd state show`, or retry');
    expect(emulated).toContain(`inspect it with \`cdkd state show ${WITH}\`, or retry`);
  });
});

describe('rollback-executor/replay-inline-policy-restore.ts', () => {
  it('the unsettled-holder warning names the drift revert with the typed flag', async () => {
    const run = async (): Promise<string> => {
      const warn = vi.fn();
      const writers = {
        takeHeldRemovals: () => [
          { kind: 'role', holders: [{ logicalId: 'Old' }], unreadable: [], unsettled: ['New'] },
        ],
      };
      await restoreHeldInlinePolicies(
        writers as never,
        {},
        'S',
        { logger: { warn } } as never,
        { warnings: 0 }
      );
      return String(warn.mock.calls[0]![0]);
    };
    const { plain, emulated } = await replayBothWays(run);
    expect(plain).toContain("or cdkd drift '<stack>' --revert restores it");
    expect(emulated).toContain(`or cdkd drift '<stack>' --revert ${WITH} restores it`);
  });
});

describe('deploy-engine/rollback/journal-write.ts', () => {
  it('a failed journal write names deploy and destroy with the typed flag', async () => {
    const run = async (): Promise<string> => {
      const warn = vi.fn();
      const deps = {
        options: {},
        stackRegion: 'us-east-1',
        stateBackend: { appendRollbackJournalSegment: vi.fn().mockRejectedValue(new Error('boom')) },
        logger: { debug: vi.fn(), warn },
      };
      await writeRollbackJournalSegment(deps as never, 'S', [], [], 'no-rollback-failure', false, {});
      if (process.env.R2DBG) console.log('JW>>', warn.mock.calls[0]![0]);
      return String(warn.mock.calls[0]![0]);
    };
    const { plain, emulated } = await replayBothWays(run);
    expect(plain).toContain("use 'cdkd deploy' to resume or 'cdkd destroy' to clean up.");
    expect(emulated).toContain(
      `use 'cdkd deploy ${WITH}' to resume or 'cdkd destroy ${WITH}' to clean up.`
    );
  });
});

describe('cc-pending-requests.ts', () => {
  const run = async (
    outcome: { status: 'succeeded'; identifier: string } | { status: 'not-found' },
    extra: { identifierUnique?: boolean } = {}
  ): Promise<string> => {
    const warn = vi.fn();
    const journal = {
      loadRollbackJournal: vi.fn(async () => null),
      rewriteRollbackJournalFailedOperations: vi.fn(async () => 0),
    };
    const op = {
      logicalId: 'Logs',
      changeType: 'CREATE',
      resourceType: 'AWS::Logs::LogGroup',
      provisionedBy: 'cc-api',
      deletionPolicy: 'Delete',
      attemptedProperties: { RetentionInDays: 1 },
      pendingCloudControlRequest: { requestToken: 't1', abandonedAt: 1 },
    };
    const loaded = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        { timestamp: 1, reason: 'auto-rollback-clean', initialDeploy: false, operations: [], failedOperations: [op] },
      ],
    };
    const reader: AbandonedRequestReader = {
      resumeAbandonedRequest: vi.fn(async () => outcome),
      buildResumeCommand: async () => 'aws cloudcontrol get-resource-request-status',
    } as never;
    await resolvePendingCloudControlRequests({
      stackName: 'S',
      stackInstanceId: undefined,
      region: 'us-east-1',
      command: 'deploy',
      identifierUnique: () => Promise.resolve(extra.identifierUnique ?? true),
      journal: journal as never,
      loaded: loaded as never,
      reader: () => reader,
      logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() } as never,
      ...(extra.identifierUnique === false && { stateResources: {}, resume: () => true }),
    } as never);
    return warn.mock.calls.map((c) => String(c[0])).join('\n');
  };

  it('a made, provably-unique orphan names destroy and revert-failed with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(() =>
      run({ status: 'succeeded', identifier: 'my-group' })
    );
    expect(plain).toContain(
      'deploy created: cdkd destroy, cdkd rollback --revert-failed and the next successful deploy '
    );
    expect(emulated).toContain(
      `deploy created: cdkd destroy ${WITH}, cdkd rollback --revert-failed ${WITH} and the next successful deploy `
    );
  });

  it('a made, non-unique resource names the import adopt with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(() =>
      run({ status: 'succeeded', identifier: 'my-group' }, { identifierUnique: false })
    );
    expect(plain).toContain('Adopt it with cdkd import (--resource');
    expect(emulated).toContain(`Adopt it with cdkd import ${WITH} (--resource`);
  });

  it('a request that is gone names the import adopt with the typed flag', async () => {
    const { plain, emulated } = await replayBothWays(() => run({ status: 'not-found' }));
    expect(plain).toContain('adopt it with cdkd import or delete it by hand.');
    expect(emulated).toContain(`adopt it with cdkd import ${WITH} or delete it by hand.`);
  });
});

describe('retry.ts', () => {
  it('a retried create that made another resource names the revert-failed record with the typed flag', async () => {
    const RETRYABLE =
      'User: arn:aws:iam::123456789012:user/deployer is not authorized to perform: iam:UpdateAccessKey';
    const marked = (id: string): Error =>
      markCreatedBeforeFailure(new Error(RETRYABLE), 'MyKey', 'AWS::IAM::AccessKey', id);
    const { withRetry: realWithRetry } = await vi.importActual<
      typeof import('../../../src/deployment/retry.js')
    >('../../../src/deployment/retry.js');
    const run = async (): Promise<string> => {
      const errors = [marked('key-1'), marked('key-2'), marked('key-3')];
      let attempts = 0;
      const warns: string[] = [];
      await realWithRetry(
        () => {
          const next = errors[attempts++];
          return next ? Promise.reject(next) : Promise.resolve('ok');
        },
        'MyKey',
        {
          sleep: () => Promise.resolve(),
          logger: { debug: vi.fn(), warn: (m: string) => warns.push(m) },
        }
      ).catch(() => undefined);
      return warns.join('\n');
    };
    const { plain, emulated } = await replayBothWays(run);
    expect(plain).toContain('is recorded for `cdkd rollback --revert-failed`. Find the earlier one');
    expect(emulated).toContain(
      `is recorded for \`cdkd rollback --revert-failed ${WITH}\`. Find the earlier one`
    );
  });
});

describe('intrinsic-resolver/getatt-heal.ts', () => {
  it('the stale-record remedy names deploy and import with the typed flag', () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { plain, emulated } = bothWays(() => staleRecordRemedy(resolver, undefined));
    expect(plain).toContain("Run 'cdkd deploy': it re-reads");
    expect(emulated).toContain(`Run 'cdkd deploy ${WITH}': it re-reads`);
    expect(emulated).toContain(`re-import it with 'cdkd import ${WITH}'`);
  });
});
