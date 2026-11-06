import { getLogger } from '../../../utils/logger.js';
import { safeStringify } from '../../../utils/aws-failure-text.js';
import { stackForConstructPath } from '../../cdk-path.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { matchStacks } from '../../stack-matcher.js';
import { plainOrDescribed } from '../../../utils/pasteable-command.js';

/**
 * Route an uncaught exception or unhandled rejection into `start-api`'s
 * graceful shutdown, so the warm containers and the profile credentials tmpdir
 * are still removed.
 *
 * Its own function so a test can drive the real listeners (go-to-k/cdkd#3361).
 * Each one receives whatever value nothing else caught, so it renders that value
 * with `safeStringify`: a bare `String()` throws for a null-prototype object,
 * and a throw from inside an `uncaughtException` listener ends the process at
 * once, skipping the shutdown this exists to run.
 */
export function installFatalShutdownHandlers(
  logger: Pick<ReturnType<typeof getLogger>, 'error'>,
  shutdown: (signal: string, exitCode: number) => Promise<void>
): void {
  process.on('uncaughtException', (err) => {
    logger.error(
      `Uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : safeStringify(err)}`
    );
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : safeStringify(reason)}`
    );
    void shutdown('unhandledRejection', 1);
  });
}

/**
 * The stack pattern a positional start-api target implies, or `undefined`
 * when the target has no `/` (a bare logical id leaves the single-stack
 * auto-pick untouched).
 *
 * It is the STACK whose display path is the LONGEST prefix of the target: a
 * stack under a CDK Stage displays as `MyStage/Api`, so the target's first
 * segment is the Stage id and never names a stack (go-to-k/cdkd#3953). The
 * stack itself is returned, not its name: re-matching a physical name could
 * select a second stack sharing it (a Stage deployed to two environments).
 * A head no stack path prefixes -- a wildcard -- is still returned as a
 * pattern for `matchStacks`.
 *
 * @internal exported for unit tests.
 */
export function targetStackHint(
  target: string | undefined,
  stacks: readonly StackInfo[]
): StackInfo | string | undefined {
  if (target?.includes('/') !== true) return undefined;
  const stack = stackForConstructPath(target, stacks);
  if (stack === undefined) return target.slice(0, target.indexOf('/'));
  // The lookup keeps the FIRST stack on a tie, and only a shared physical name
  // ties: the reversed list then answers with another stack. Return that name
  // as a pattern, which selects every stack carrying it, so the served-union
  // check refuses the clones instead of serving the first (#5175).
  return stackForConstructPath(target, [...stacks].reverse()) === stack ? stack : stack.stackName;
}

/**
 * Match the `--stack` pattern (or single-stack auto-detect) to a list
 * of stacks the route-discovery walks. Mirrors the deploy/diff matcher
 * routing rules.
 *
 * @internal exported for unit tests.
 */
export function pickTargetStacks(
  stacks: StackInfo[],
  pattern: string | undefined,
  cfnStackFallback?: string,
  targetFallback?: StackInfo | string
): StackInfo[] {
  // Resolution chain (first non-empty wins):
  //   1. `--stack <pattern>`                            (explicit)
  //   2. `--from-cfn-stack <explicit-name>`             (PR #44 mirror)
  //   3. positional target's stack-name prefix          (PR #45 mirror)
  //      e.g. `cdkd local start-api MyStack/MyApi` infers `MyStack`;
  //      `targetStackHint` passes the prefix-matched stack itself.
  //
  // CDK apps typically deploy each synth stack under its own stack-name,
  // so any of the three values identifies the synth target unambiguously
  // without the user having to repeat themselves via `--stack`.
  const effective = pattern ?? cfnStackFallback ?? targetFallback;
  if (effective !== undefined && typeof effective !== 'string') return [effective];
  if (effective) {
    // By identity: two stacks sharing a physical name (a Stage deployed twice)
    // are both selected, and `assertServedLogicalIdsUnambiguous` refuses
    // their shared name rather than one being dropped silently (#5175).
    return matchStacks(stacks, [effective], { dedupe: 'identity' });
  }
  if (stacks.length === 1) return stacks;
  if (stacks.length === 0) return [];
  // Multi-stack apps can be served as a union — every stack contributes
  // its routes — but for v1 we require an explicit selection so users
  // don't accidentally serve a side-stack's API.
  throw new Error(
    `Multi-stack app: pass --stack '<name>', --from-cfn-stack '<name>', or a stack-qualified target like "<StackName>/<construct>" to pick a target. Available stacks: ${stacks.map((s) => plainOrDescribed(s.stackName, 'stack name')).join(', ')}.`
  );
}

/**
 * Decide whether the `--from-cfn-stack <name>` redundancy tip should
 * fire for the current invocation. Fires only when:
 *  - `fromCfnStack` is a non-empty STRING (explicit value, not bare `true`)
 *  - exactly ONE stack is routed
 *  - the explicit value equals the routed stack's `stackName`
 *
 * Extracted as a pure function so it can be unit-tested without booting
 * the full server. See improvement A in the start-api UX PR.
 *
 * @internal exported for unit tests.
 */
export function shouldEmitFromCfnRedundancyTip(
  fromCfnStack: string | boolean | undefined,
  routedStackNames: readonly string[]
): boolean {
  if (typeof fromCfnStack !== 'string') return false;
  if (fromCfnStack.length === 0) return false;
  if (routedStackNames.length !== 1) return false;
  return fromCfnStack === routedStackNames[0];
}

/**
 * One-shot wrapper around `shouldEmitFromCfnRedundancyTip` for the
 * `--watch` hot-reload path. `synthesizeAndBuild` re-runs on every
 * reload firing, so without a gate the tip would re-emit on every
 * reload — noisy. This helper consults the caller-supplied ref:
 *  - If the predicate fires AND the ref is still `false`, calls `emit`
 *    and flips the ref to `true`.
 *  - On subsequent invocations the ref is `true` and the helper is a
 *    no-op for the rest of the ref's lifetime.
 *  - When the predicate does NOT fire (no `--from-cfn-stack` value /
 *    intentionally-different value / multi-stack run), the ref stays
 *    `false` so a future reload whose synthesized stacks change in a
 *    way that DOES make the value redundant still emits the tip once.
 *
 * The ref is owned by `localStartApiCommand` (one per server boot), so
 * independent server invocations get independent flags.
 *
 * @internal exported for unit tests.
 */
export function tryEmitFromCfnRedundancyTipOnce(
  fromCfnStack: string | boolean | undefined,
  routedStackNames: readonly string[],
  emittedRef: { value: boolean },
  emit: (routedStackName: string) => void
): void {
  if (emittedRef.value) return;
  if (!shouldEmitFromCfnRedundancyTip(fromCfnStack, routedStackNames)) return;
  const routedStackName = routedStackNames[0];
  if (routedStackName === undefined) return;
  emit(routedStackName);
  emittedRef.value = true;
}
