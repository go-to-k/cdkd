/**
 * `cdkd destroy`: which stacks a run destroys, and in what order. Split out
 * of `../destroy.ts`.
 */
import { Synthesizer } from '../../../synthesis/synthesizer.js';
import { StageLoadError } from '../../../synthesis/failed-stages.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { ConsoleLogger } from '../../../utils/logger.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { displaySafe } from '../../../utils/display-safe.js';
import { safeStringify } from '../../../utils/aws-failure-text.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import {
  inferCrossStackStackDeps,
  type CrossStackScanStack,
} from '../../../analyzer/cross-stack-deps.js';
import { parseContextOptions } from '../../options.js';
import { resolveApp } from '../../config-loader.js';
import {
  matchStacks,
  refuseStackNameRegionCollisions,
  stackMatchesPattern,
  describeStack,
  partitionTopLevel,
  renderAllLeftOutStageStacks,
  renderStacksNoLongerSelected,
  stacksNoLongerSelected,
  renderAllNoTopLevelStacks,
  renderNotInAppWarning,
  renderUnmatchedPatternsWarning,
  unmatchedPatterns,
  type StackLike,
} from '../../stack-matcher.js';
import { orderConsumersBeforeProducers } from './helpers.js';

// Local extension of `StackLike` that also carries the synth-derived
// region and the manifest's `terminationProtection` flag. Stack-matcher
// only reads stackName/displayName, so this is backwards-compatible
// everywhere matchStacks is used. `terminationProtection` is consulted
// in the per-stack loop below to refuse destroying protected stacks
// before any lock or per-resource delete fires.
export type AppStack = StackLike & {
  region?: string;
  // go-to-k/cdkd#5176: two Stages pinned to different accounts never share a record.
  account?: string;
  terminationProtection?: boolean;
  // go-to-k/cdkd#4682: what a delete re-resolves a NoEcho coordinate from.
  template?: CloudFormationTemplate;
  nestedTemplates?: Record<string, string>;
};

// The stacks to destroy, each with the app stack it was selected as (none
// on the state-only fallback). Carried as the stack, not its name: two
// Stages deployed to different regions share a physical name, and the
// region each destroys is its own (#5176).
export type DestroyTarget = { stackName: string; synth: AppStack | undefined };

/** What {@link selectDestroyTargets} hands back to the command. */
export interface DestroySelection {
  appStacks: AppStack[];
  synthScanStacks: CrossStackScanStack[];
  stackPatterns: string[];
  allStateRefs: Awaited<ReturnType<S3StateBackend['listStacks']>>;
  targets: DestroyTarget[];
  namesAppStack: Set<string>;
}

/**
 * Step 2 of `cdkd destroy`: synthesize the app (falling back to state), then
 * select the stacks to destroy. `undefined` when the run has nothing to
 * destroy and ends without an error.
 */
export async function selectDestroyTargets(
  stackArgs: string[],
  options: { app?: string; output?: string; context?: string[]; all?: boolean; stack?: string },
  stateBackend: S3StateBackend,
  logger: ConsoleLogger
): Promise<DestroySelection | undefined> {
  // 2. Resolve stacks to destroy (CDK CLI compatible behavior)
  // Always synth to determine which stacks belong to this CDK app.
  const appCmd = options.app || resolveApp();
  let appStacks: AppStack[] = [];
  // Synthesized templates kept for cross-stack ordering inference (see the
  // reverse-edge sort below). Only populated when synth succeeds; on the
  // state-only fallback path we have no templates and skip the inference.
  let synthScanStacks: CrossStackScanStack[] = [];
  let synthesized = false;
  // Why synth failed, carried to the refusals below as their `cause` so the
  // operator sees what to fix. Unset when synth succeeded or no app is
  // configured at all.
  let synthError: Error | undefined;

  if (appCmd) {
    try {
      const synthesizer = new Synthesizer();
      const context = parseContextOptions(options.context);
      const result = await synthesizer.synthesize({
        app: appCmd,
        output: options.output || 'cdk.out',
        ...(Object.keys(context).length > 0 && { context }),
        // Issue #1150: destroy never consumes expanded templates —
        // the destroy engine works off cdkd STATE, and the synth
        // result feeds only stack-name matching plus the cross-stack
        // ordering scan below. Author-written Fn::ImportValue /
        // Fn::GetStackOutput markers are textually present in the
        // raw template; a marker that only exists in a macro's
        // expansion output is not seen (known limitation, same
        // trade-off as deploy's post-selection expansion). Skipping
        // expansion entirely means a macro-carrying stack stays
        // destroyable even when the CFn expansion round-trip would
        // fail (issue #1151).
        deferMacroExpansion: true,
        // A failed context lookup is not refused here, as `cdk destroy`
        // does not refuse one (go-to-k/cdkd#5807); a stack or import that
        // depends on the lookup's value is read with its dummy value.
        failedLookupsCheckedByCaller: true,
      });
      appStacks = result.stacks.map((s) => ({
        stackName: s.stackName,
        displayName: s.displayName,
        ...(s.stagePath !== undefined && { stagePath: s.stagePath }),
        ...(s.region && { region: s.region }),
        ...(s.account && { account: s.account }),
        ...(s.terminationProtection !== undefined && {
          terminationProtection: s.terminationProtection,
        }),
        template: s.template,
        ...(s.nestedTemplates !== undefined && { nestedTemplates: s.nestedTemplates }),
      }));
      synthScanStacks = result.stacks.map((s) => ({
        stackName: s.stackName,
        template: s.template,
      }));
      synthesized = true;
    } catch (error) {
      // A CDK Stage that failed to load is FATAL, as in the AWS CDK CLI and
      // every other cdkd command: the app is there but incomplete, so even
      // an exact name does not fall back to state (#3507). `cdkd state
      // destroy` needs no app and stays the way to reach a stack by name, so
      // the error names it.
      if (error instanceof StageLoadError) {
        const named = new StageLoadError(
          `${error.message} To destroy a deployed stack without the app: ` +
            `cdkd state destroy ${commandHole('stack')}.`
        );
        // Keep the reader's frames under the new header, so `--verbose`
        // points at where the Stage failed, not at this re-raise.
        if (typeof error.stack === 'string') {
          const headerLines = `${error.name}: ${error.message}`.split('\n').length;
          const frames = error.stack.split('\n').slice(headerLines).join('\n');
          if (frames.length > 0) named.stack = `${named.name}: ${named.message}\n${frames}`;
        }
        throw named;
      }
      synthError = error instanceof Error ? error : new Error(safeStringify(error));
      logger.debug('Could not synthesize app, falling back to state-based stack list');
    }
  }

  const stackPatterns = stackArgs.length > 0 ? stackArgs : options.stack ? [options.stack] : [];
  const wildcardPatterns = stackPatterns.filter((p) => p.includes('*') || p.includes('?'));
  // --all and a wildcard select among the stacks the APP synthesizes. With no
  // app stack to select among, the state fallback below would widen either
  // one to every stack in the bucket, other apps' included, so both are
  // refused here -- before the bucket is even listed. An exact physical name
  // still resolves through the fallback: it names one stack, and it is how a
  // stack is reached without a working app.
  if (appStacks.length === 0 && (options.all || wildcardPatterns.length > 0)) {
    // The operator's own argv, but rendered as text all the same.
    const selector = options.all ? '--all' : wildcardPatterns.map((p) => displaySafe(p)).join(', ');
    if (synthesized) {
      // The app synthesized NO stacks.
      throw new Error(
        `${selector} selects among the stacks this app synthesizes, and it synthesized none; ` +
          'refusing to fall back to every stack in state.'
      );
    }
    // No synthesized app -- synth failed, or no app is configured -- so there
    // is no app scope at all (#3839). The hint names no batch form: every
    // batch over state is cross-app.
    const hole = commandHole('stack');
    throw new CdkdError(
      `${selector} selects among the stacks this app synthesizes, and ` +
        (synthError ? 'the app could not be synthesized' : 'no app is configured') +
        '; refusing to fall back to every stack in state, which spans every app ' +
        'sharing this state bucket. ' +
        (synthError
          ? 'Fix the app so it synthesizes'
          : 'Configure the app with --app or cdk.json') +
        `, or name each stack exactly: cdkd destroy ${hole}, or cdkd state destroy ${hole}, ` +
        'which needs no app.',
      'DESTROY_NO_APP_SCOPE',
      synthError
    );
  }

  // `--all` over a stage-only APP is refused, as the AWS CDK CLI refuses it
  // (#4474), before the bucket is listed. An app whose top-level stacks are
  // merely not deployed selects nothing below, with the hint.
  if (options.all && appStacks.length > 0) {
    const app = partitionTopLevel(appStacks);
    if (app.topLevel.length === 0) throw new Error(renderAllNoTopLevelStacks(app.inStages));
  }

  // Determine candidate stacks. State only carries physical names + regions
  // (no display path), so when synth is unavailable we fall back to a
  // stackName-only candidate list (display-path patterns like
  // "MyStage/MyStack" simply will not match anything in that mode).
  const allStateRefs = await stateBackend.listStacks();
  // Map stackName -> first region (collision warning emitted later if a
  // stack has multiple region keys). Synth-driven destroy is single-region:
  // if synth.region matches one of the records we use it; otherwise we
  // surface a clear error.
  let candidateStacks: StackLike[];
  if (appStacks.length > 0) {
    // App synth succeeded: only consider stacks from this app
    const stateNames = new Set(allStateRefs.map((r) => r.stackName));
    candidateStacks = appStacks.filter((s) => stateNames.has(s.stackName));
  } else if (stackArgs.length > 0 || options.stack) {
    // No app stacks but explicit exact names given (--all and wildcards were
    // refused above): use state stacks
    // (deduplicate by name so a stack with two region records appears once
    // — the per-stack loop handles the multi-region case explicitly)
    const seen = new Set<string>();
    candidateStacks = [];
    for (const ref of allStateRefs) {
      if (seen.has(ref.stackName)) continue;
      seen.add(ref.stackName);
      candidateStacks.push({ stackName: ref.stackName });
    }
  } else {
    // No app stacks and no stack named: refuse to guess. Reached whether
    // synth failed, found no app, or synthesized zero stacks, so the code
    // names the missing SELECTION rather than a missing app. `--all` is
    // refused above in every one of those cases, so it is never offered here.
    throw new CdkdError(
      'Could not determine which stacks belong to this app. ' +
        'Specify stack names explicitly, or ensure --app / cdk.json is configured.',
      'DESTROY_NO_STACK_SELECTED',
      synthError
    );
  }

  const appStackSet = new Set<StackLike>(appStacks);
  const toTarget = (s: StackLike): DestroyTarget => ({
    stackName: s.stackName,
    synth: appStackSet.has(s) ? (s as AppStack) : undefined,
  });
  let targets: DestroyTarget[];
  // Patterns that name a stack of this app by its CDK path (or exact
  // physical name) whether or not it is deployed. Filled by the pattern arm.
  const namesAppStack = new Set<string>();
  if (options.all) {
    // --all: the app's TOP-LEVEL stacks that are in state, as the AWS CDK
    // CLI's `destroy --all` (#4474). A Stage's stacks are left running and
    // named in one line, so the narrower set is never silent.
    const { topLevel, inStages } = partitionTopLevel(candidateStacks);
    if (inStages.length > 0) logger.warn(renderAllLeftOutStageStacks(inStages));
    targets = topLevel.map(toTarget);
  } else if (stackPatterns.length > 0) {
    // Explicit stack names or wildcards. Resolved against the WHOLE app
    // and only then narrowed to what is in state: a pattern that is one
    // stack's CDK id selects that stack, as the AWS CDK CLI does, even when
    // it is not deployed and another deployed stack's physical name equals
    // the pattern -- that other stack must not be destroyed instead (#4474).
    const selectFrom = appStacks.length > 0 ? appStacks : candidateStacks;
    const inState = new Set(candidateStacks.map((s) => s.stackName));
    // Every selected stack, two sharing a physical name included (#5176).
    targets = matchStacks(selectFrom, stackPatterns, { dedupe: 'identity' })
      .filter((s) => inState.has(s.stackName))
      .map(toTarget);
    // A deployed stack a pattern used to select by a physical-name wildcard
    // and no longer does is named, not dropped silently (#4474) -- also when
    // the pattern now matches only undeployed stacks and selects nothing.
    if (appStacks.length > 0) {
      const gone = stacksNoLongerSelected(
        candidateStacks,
        stackPatterns,
        new Set(targets.map((t) => t.stackName))
      );
      if (gone.stacks.length > 0) {
        logger.warn(renderStacksNoLongerSelected(gone.patterns, gone.stacks));
      }
    }
    // Every pattern that matched nothing is warned about, as the AWS CDK
    // CLI's destroy does (one warning per pattern, whether or not another
    // matched), rather than dropped silently: a typo must not pass for a
    // stack that was destroyed (#3507).
    //
    // An exact name that IS a state record but not one of this app's stacks
    // (a nested child, or another app's stack sharing the bucket) gets its
    // own sentence -- "no stack in state" would be false. When NOTHING
    // matched, the by-name special case below handles it instead (a nested
    // child is refused there), so it is not warned about twice.
    const stateNames = new Set(allStateRefs.map((r) => r.stackName));
    const unmatched = unmatchedPatterns(selectFrom, stackPatterns, (s) => inState.has(s.stackName));
    if (appStacks.length > 0) {
      for (const p of stackPatterns) {
        if (appStacks.some((s) => stackMatchesPattern(s, p))) namesAppStack.add(p);
      }
    }
    // A pattern naming an app stack that is not deployed is "not in state",
    // even when it also spells another stack's state record.
    const inStateOnly = unmatched.filter((p) => stateNames.has(p) && !namesAppStack.has(p));
    const absent = unmatched.filter((p) => !inStateOnly.includes(p));
    if (absent.length > 0) {
      logger.warn(renderUnmatchedPatternsWarning(absent, 'in state'));
    }
    if (targets.length > 0 && inStateOnly.length > 0) {
      logger.warn(renderNotInAppWarning(inStateOnly));
    }
  } else if (candidateStacks.length === 1) {
    // Single stack: auto-select (CDK CLI compatible). A Stage that failed
    // to load never gets here: synthesis failed on it above (#3507).
    targets = candidateStacks.map(toTarget);
  } else if (candidateStacks.length === 0) {
    logger.info('No stacks found in state');
    return;
  } else {
    throw new Error(
      `Multiple stacks found: ${candidateStacks.map(describeStack).join(', ')}. ` +
        `Specify stack name(s) or use --all (top-level stacks; '**' for every stack)`
    );
  }

  return { appStacks, synthScanStacks, stackPatterns, allStateRefs, targets, namesAppStack };
}

/**
 * Order the selected stacks (consumers before producers), pick each shared
 * name's region and log what will be destroyed.
 */
export async function orderDestroyTargets(
  targets: DestroyTarget[],
  appStacks: AppStack[],
  synthScanStacks: CrossStackScanStack[],
  regionForStack: (stackName: string) => Promise<string>,
  logger: ConsoleLogger
): Promise<{
  targets: DestroyTarget[];
  uniqueNames: string[];
  strictRegion: Map<DestroyTarget, string>;
  describeTarget: (t: DestroyTarget) => string;
}> {
  // Order stacks so that a consumer is destroyed BEFORE its producer.
  // CDK's manifest dependency graph is unavailable here (state carries no
  // dependency info and the per-stack loop never used it), but a raw
  // cross-stack reference — `cdk.Fn.importValue('<exportName>')` or
  // `Fn::GetStackOutput` — means destroying the producer first would trip
  // cdkd's `StackHasActiveImportsError` and leave the consumer orphaned.
  // We infer those consumer → producer edges from the synthesized templates
  // and topologically sort so each consumer precedes its producers (the
  // REVERSE of deploy order). Only edges between stacks both in this destroy
  // set count. When synth was unavailable (state-only fallback) there are no
  // templates to scan, so `inferred` is empty and the original order stands.
  // The edges are by name, so the NAMES are ordered and each name's
  // targets follow in selection order.
  const uniqueNames = [...new Set(targets.map((t) => t.stackName))];
  if (synthScanStacks.length > 0 && uniqueNames.length > 1) {
    const inSet = new Set(uniqueNames);
    const inferred = inferCrossStackStackDeps(
      synthScanStacks.filter((s) => inSet.has(s.stackName))
    );
    const ordered = orderConsumersBeforeProducers(uniqueNames, inferred);
    targets = ordered.flatMap((name) => targets.filter((t) => t.stackName === name));
  }

  // A name two app stacks share (one Stage per region, #5176) is destroyed
  // only in the region its selected stack names: its synthesized region, or
  // the resolved one for an env-agnostic stack. Never the single record's
  // region whatever it is, as an unshared name may be, since that record
  // can belong to the OTHER stack of the name.
  const sharedAppNames = new Set(
    appStacks.map((s) => s.stackName).filter((name, i, names) => names.indexOf(name) !== i)
  );
  const strictRegion = new Map<DestroyTarget, string>();
  for (const target of targets) {
    if (!sharedAppNames.has(target.stackName) || target.synth === undefined) continue;
    strictRegion.set(target, target.synth.region ?? (await regionForStack(target.stackName)));
  }
  // A selected stack whose name and region another selected stack shares, or
  // an unselected one pinned to a possibly-equal account,
  // maps to that stack's state record too; refused before any lock or delete
  // rather than destroying it under whichever template comes first. The
  // env-agnostic case is the one that bites: the #2100 hold resolves it to
  // us-east-1 when a record of its name is there, which can be a sibling
  // Stage's pinned stack (#5176). An unselected stack is compared only when
  // it pins a region; where an unselected env-agnostic one lives depends on
  // the run that deployed it.
  const strictBySynth = new Map(
    targets.flatMap((t) =>
      t.synth !== undefined && strictRegion.has(t) ? [[t.synth, strictRegion.get(t)!] as const] : []
    )
  );
  const strictNames = new Set([...strictBySynth.keys()].map((s) => s.stackName));
  refuseStackNameRegionCollisions(
    appStacks.filter(
      (s) => strictBySynth.has(s) || (strictNames.has(s.stackName) && s.region !== undefined)
    ),
    (s) => strictBySynth.get(s) ?? s.region,
    new Set(strictBySynth.keys())
  );
  // Shown with its CDK path only where a name is shared, so it says which.
  const describeTarget = (t: DestroyTarget): string =>
    t.synth !== undefined && strictRegion.has(t)
      ? `${describeStack(t.synth)} in ${displaySafe(strictRegion.get(t)!)}`
      : displaySafe(t.stackName);

  logger.info(
    `Found ${targets.length} stack(s) to destroy: ${targets.map(describeTarget).join(', ')}`
  );

  return { targets, uniqueNames, strictRegion, describeTarget };
}
