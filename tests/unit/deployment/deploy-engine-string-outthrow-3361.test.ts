import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-v6';

const logSpy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { ...logSpy, setLevel: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import { persistStateAfterOutputFailure } from '../../../src/deployment/deploy-engine/execute.js';
import { handleOutputResolutionFailure } from '../../../src/deployment/deploy-engine/outputs.js';
import {
  deleteRollbackJournalBestEffort,
  settleJournalAfterCleanRollback,
  writeRollbackJournalSegment,
} from '../../../src/deployment/deploy-engine/rollback.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor/types.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the deploy
 * engine and `cdkd diff` slice: a handler that stringified its caught value
 * with `x instanceof Error ? x.message : String(x)` threw from inside itself
 * when the value could not be converted -- `String(Object.create(null))`
 * throws `TypeError: Cannot convert object to primitive value` -- so a
 * best-effort journal or state write turned into a hard failure, and a
 * provider rejection was replaced by that `TypeError`.
 *
 * Every behavior case rejects with exactly that value and asserts the
 * DEGRADATION still happens (the call resolves, or the original value is the
 * one carried on), plus the placeholder in the log line, so a fix that
 * swallowed the failure without reporting it would not pass.
 */

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const STACK = 'MyStack';

function logged(spy: ReturnType<typeof vi.fn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

function makeEngine(
  stateBackend: Record<string, unknown>,
  provider?: ResourceProvider
): InstanceType<typeof DeployEngine> {
  return new DeployEngine(
    stateBackend as unknown as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as never,
    {} as unknown as never,
    {} as unknown as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    } as unknown as never,
    {},
    'us-east-1'
  );
}

const failedOp: FailedOperation = {
  logicalId: 'Queue',
  resourceType: 'AWS::SQS::Queue',
  changeType: 'CREATE',
} as unknown as FailedOperation;

describe('rollback journal best-effort writes (#3361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deleteRollbackJournalBestEffort: an unconvertible delete AND mark failure still resolve false', async () => {
    const backend = {
      deleteRollbackJournal: vi.fn().mockRejectedValue(unconvertible()),
      markRollbackJournalSuperseded: vi.fn().mockRejectedValue(unconvertible()),
    };
    const engine = makeEngine(backend);
    await expect(
      deleteRollbackJournalBestEffort(engine.rollbackDeps(), STACK, ['Queue'])
    ).resolves.toBe(false);
    // The mark is reached only when the delete handler degraded.
    expect(backend.markRollbackJournalSuperseded).toHaveBeenCalledTimes(1);
    const debug = logged(logSpy.debug);
    expect(debug).toContain(`Failed to delete rollback journal for ${STACK}: ${PLACEHOLDER}`);
    expect(debug).toContain(`superseded logical ids on the rollback journal for ${STACK}: ${PLACEHOLDER}`);
  });

  it('settleJournalAfterCleanRollback (no failed ops): an unconvertible pop failure resolves false', async () => {
    const backend = { popRollbackJournalSegment: vi.fn().mockRejectedValue(unconvertible()) };
    const engine = makeEngine(backend);
    await expect(
      settleJournalAfterCleanRollback(engine.rollbackDeps(), STACK, [], false)
    ).resolves.toBe(false);
    expect(logged(logSpy.debug)).toContain(
      `Failed to pop the rollback journal segment after the clean rollback: ${PLACEHOLDER}`
    );
  });

  it('settleJournalAfterCleanRollback (failed ops): an unconvertible pop failure warns and resolves false', async () => {
    const backend = {
      popRollbackJournalSegment: vi.fn().mockRejectedValue(unconvertible()),
      appendRollbackJournalSegment: vi.fn(),
    };
    const engine = makeEngine(backend);
    await expect(
      settleJournalAfterCleanRollback(engine.rollbackDeps(), STACK, [failedOp], false)
    ).resolves.toBe(false);
    expect(backend.appendRollbackJournalSegment).not.toHaveBeenCalled();
    expect(logged(logSpy.warn)).toContain(
      `Failed to settle the rollback journal after the clean rollback: ${PLACEHOLDER}. `
    );
  });

  it('writeRollbackJournalSegment: an unconvertible append failure warns and resolves false', async () => {
    const backend = { appendRollbackJournalSegment: vi.fn().mockRejectedValue(unconvertible()) };
    const engine = makeEngine(backend);
    await expect(
      writeRollbackJournalSegment(engine.rollbackDeps(), STACK, [], [failedOp], 'no-rollback-failure', false)
    ).resolves.toBe(false);
    expect(backend.appendRollbackJournalSegment).toHaveBeenCalledTimes(1);
    expect(logged(logSpy.warn)).toContain(`Failed to write rollback journal: ${PLACEHOLDER}. `);
  });
});

describe('persistStateAfterOutputFailure (#3361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('an unconvertible save AND retry failure still resolve, retrying once and warning', async () => {
    const backend = {
      saveState: vi.fn().mockRejectedValue(unconvertible()),
      getState: vi.fn().mockResolvedValue(null),
    };
    const engine = makeEngine(backend);
    const current: StackState = {
      version: 1,
      stackName: STACK,
      resources: {},
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    await expect(
      persistStateAfterOutputFailure(engine, STACK, current, {}, 'etag-1', false)
    ).resolves.toBeUndefined();
    // The retry is reached only when the first handler degraded.
    expect(backend.saveState).toHaveBeenCalledTimes(2);
    expect(logged(logSpy.debug)).toContain(
      `Retrying state save after output resolution failure (ETag mismatch): ${PLACEHOLDER}`
    );
    expect(logged(logSpy.warn)).toContain(
      `Failed to save state after output resolution failure: ${PLACEHOLDER} — `
    );
  });
});

describe('handleOutputResolutionFailure (#3361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('an unconvertible failure off --strict-getatt still warns and skips the output', () => {
    const warn = vi.fn();
    const outputs: Record<string, unknown> = { BucketArn: 'stale' };
    // Not a catch binding: the value arrives as a PARAMETER, from the catches
    // around output resolution, and the warn arm is the degradation.
    expect(() =>
      handleOutputResolutionFailure(
        { options: {}, logger: { warn } } as unknown as Parameters<
          typeof handleOutputResolutionFailure
        >[0],
        unconvertible(),
        'BucketArn',
        outputs,
        new Map(),
        new Map()
      )
    ).not.toThrow();
    expect(outputs).toHaveProperty('BucketArn', undefined);
    expect(logged(warn)).toContain(`Failed to resolve output BucketArn: ${PLACEHOLDER}`);
  });
});

describe('a template-removal DELETE rejected with an unconvertible value (#3361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is reported as a ProvisioningError for the resource, not replaced by a TypeError', async () => {
    const reason = unconvertible();
    const provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockRejectedValue(reason),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
    const engine = makeEngine({ getState: vi.fn(), saveState: vi.fn() }, provider);
    const change: ResourceChange = {
      logicalId: 'MyQueue',
      changeType: 'DELETE',
      resourceType: 'AWS::SQS::Queue',
      currentProperties: {},
    };
    const stateResources = {
      MyQueue: {
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
        resourceType: 'AWS::SQS::Queue',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
    };
    let caught: unknown;
    try {
      await provisionResource(engine, 'MyQueue', change, stateResources, STACK, { Resources: {} });
    } catch (e) {
      caught = e;
    }
    // delete.ts's not-found classifier rethrows the ORIGINAL value, and
    // provision.ts's per-resource handler wraps it; before the fix the first
    // of the two threw `TypeError: Cannot convert object to primitive value`.
    expect(caught).toBeInstanceOf(ProvisioningError);
    expect((caught as Error).message).toBe('Failed to delete resource MyQueue');
    expect(provider.delete).toHaveBeenCalled();
    expect(logged(logSpy.error)).toContain(`Failed to delete MyQueue: ${PLACEHOLDER}`);
    // The record is not dropped as "already deleted".
    expect(stateResources.MyQueue).toBeDefined();
  });
});

/**
 * The handlers above are the ones an exported entry reaches with a small
 * harness. The rest (the per-resource state saves and lock release inside
 * `executeDeployment` / `doDeployWithPrefetch`, the replacement and
 * update-by-replacement paths, the create-name probe, the observed-properties
 * readback, `cdkd diff`'s partial parameter binding and skipped condition
 * evaluation) sit deep inside the engine's flows, so the files are scanned
 * instead: no `catch` clause, `.catch(cb)` handler or `.then(ok, onRejected)`
 * rejection handler in them may convert its own binding implicitly or through
 * `String(...)`, and no `x instanceof Error ? ... : String(x)` ternary may
 * remain anywhere (that one also covers a thrown value passed on as a
 * PARAMETER, like `handleOutputResolutionFailure`'s).
 */
describe('no handler in the slice stringifies its caught value with String() (#3361)', () => {
  type Shape = 'catchClause' | 'catchCallback' | 'thenRejection';
  /**
   * File -> the handler count per shape on the tree this PR was written
   * against, as a floor, so a parse that saw nothing -- or a shape the walk
   * stopped recognising -- cannot pass.
   */
  const FILES: Readonly<Record<string, Readonly<Partial<Record<Shape, number>>>>> = {
    'src/deployment/deploy-engine/create.ts': { catchClause: 3 },
    'src/deployment/deploy-engine/delete.ts': { catchClause: 1 },
    'src/deployment/deploy-engine/deploy-flow.ts': { catchClause: 8 },
    'src/deployment/deploy-engine/execute.ts': { catchClause: 10 },
    'src/deployment/deploy-engine/observed-capture.ts': { thenRejection: 1 },
    'src/deployment/deploy-engine/outputs.ts': { catchClause: 2 },
    'src/deployment/deploy-engine/provision.ts': { catchClause: 1 },
    'src/deployment/deploy-engine/replacement.ts': { catchClause: 5 },
    'src/deployment/deploy-engine/rollback.ts': { catchClause: 6 },
    'src/deployment/deploy-engine/update-in-place.ts': { catchClause: 3 },
    'src/deployment/deploy-engine/update-replace.ts': { catchClause: 3 },
    'src/cli/commands/diff-recursive.ts': { catchClause: 4 },
  };

  function scan(file: string): { handlers: Record<Shape, number>; offenders: string[] } {
    const text = readFileSync(join(process.cwd(), file), 'utf-8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const handlers: Record<Shape, number> = { catchClause: 0, catchCallback: 0, thenRejection: 0 };
    const offenders: string[] = [];
    const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const isBinding = (n: ts.Node | undefined, binding: string): boolean =>
      n !== undefined && ts.isIdentifier(n) && n.text === binding;
    const check = (shape: Shape, binding: string, body: ts.Node): void => {
      handlers[shape]++;
      const walk = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 'String' &&
          n.arguments.length === 1 &&
          isBinding(n.arguments[0], binding)
        ) {
          offenders.push(`${file}:${at(n)}`);
        }
        // The implicit conversions throw for the same value: `${x}`, `'' + x` and `s += x`.
        if (ts.isTemplateSpan(n) && isBinding(n.expression, binding)) {
          offenders.push(`${file}:${at(n)} (template)`);
        }
        if (
          ts.isBinaryExpression(n) &&
          (n.operatorToken.kind === ts.SyntaxKind.PlusToken ||
            n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
          (isBinding(n.left, binding) || isBinding(n.right, binding))
        ) {
          offenders.push(`${file}:${at(n)} (concatenation)`);
        }
        ts.forEachChild(n, walk);
      };
      walk(body);
    };
    const handlerParam = (cb: ts.Node | undefined): string | undefined =>
      cb !== undefined &&
      (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
      cb.parameters.length === 1 &&
      ts.isIdentifier(cb.parameters[0]!.name)
        ? cb.parameters[0]!.name.text
        : undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isConditionalExpression(node) &&
        ts.isBinaryExpression(node.condition) &&
        node.condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        node.condition.right.getText(sf) === 'Error' &&
        ts.isCallExpression(node.whenFalse) &&
        ts.isIdentifier(node.whenFalse.expression) &&
        node.whenFalse.expression.text === 'String' &&
        node.whenFalse.arguments.length === 1 &&
        node.whenFalse.arguments[0]!.getText(sf) === node.condition.left.getText(sf)
      ) {
        offenders.push(`${file}:${at(node)} (ternary)`);
      }
      if (
        ts.isCatchClause(node) &&
        node.variableDeclaration !== undefined &&
        ts.isIdentifier(node.variableDeclaration.name)
      ) {
        check('catchClause', node.variableDeclaration.name.text, node.block);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const cb =
          method === 'catch' && node.arguments.length === 1
            ? node.arguments[0]
            : method === 'then' && node.arguments.length === 2
              ? node.arguments[1]
              : undefined;
        const param = handlerParam(cb);
        if (param !== undefined) {
          const fn = cb as ts.ArrowFunction | ts.FunctionExpression;
          check(method === 'catch' ? 'catchCallback' : 'thenRejection', param, fn.body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { handlers, offenders };
  }

  it.each(Object.entries(FILES))('%s', (file, floors) => {
    const { handlers, offenders } = scan(file);
    for (const [shape, floor] of Object.entries(floors)) {
      expect(handlers[shape as Shape], shape).toBeGreaterThanOrEqual(floor);
    }
    expect(offenders).toEqual([]);
  });
});
