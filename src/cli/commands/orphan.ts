import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  destroyOptions,
  parseContextOptions,
  stateOptions,
  warnIfDeprecatedRegion,
  parseStackRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, synthesisStatusMessage } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { buildLockContentionMessage } from '../../state/lock-contention-message.js';
import type { LockRecoveryContext } from '../../state/lock-contention-message.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cdk-path.js';
import {
  rewriteResourceReferences,
  type OrphanRewrite,
  type UnresolvableReference,
} from '../../analyzer/orphan-rewriter.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import {
  refuseMalformedOrphansForOrphan,
  refuseMalformedOutputs,
  refuseMalformedResourceAttributesForOrphan,
  refuseMalformedResourceEntriesForOrphan,
  refuseMalformedResourcePropertiesForOrphan,
  refuseMalformedState,
} from '../../state/malformed-resources-bag.js';
import {
  displayAwsMessage,
  displayIdent,
  displaySafe,
  displayStackName,
  STACK_REF_MAX_CODE_POINTS,
} from '../../utils/display-safe.js';

/**
 * `cdkd orphan` renders assembly-derived values — a stack's `stackName` /
 * `displayName`, a template logical id, an `aws:cdk:path` from the template's
 * own `Metadata`, a rewritten template VALUE — plus their state-derived
 * neighbours, in thrown messages AND in default-verbosity `logger.info` lines.
 * All of them go through a display helper
 * ([#3479](https://github.com/go-to-k/cdkd/issues/3479)), and which helper is
 * chosen per SENTENCE rather than per value:
 *
 * - `displaySafe` is the default. It neither quotes nor truncates, so every
 *   legitimate value is byte-identical — including in a message whose own prose
 *   already supplies the quotes (`stack '<name>'`), where `displayIdent` would
 *   double-quote.
 * - `displayIdent` (capped at `STACK_REF_MAX_CODE_POINTS`, so a deep nested path
 *   is not cut) serves every UNQUOTED LIST whose job is the value's IDENTITY —
 *   which names the user could have meant. That is each `Available: ...` list
 *   and, since they share one sentence with one, the `missing` half of
 *   `Resource(s) not in state`. There `displaySafe`
 *   is not enough: it maps the stripped character to a space and then TRIMS, so a
 *   planted `us-east-1` plus a line terminator renders byte-identical to the
 *   genuine `us-east-1` and the message lists the very value it says is missing
 *   (measured). This is the same choice `describeStack` makes for the same class
 *   of sentence. The population is `grep displayIdent` — which catches
 *   `displayIdentList` and `displayRegionList` alike — rather than a count here,
 *   which is what goes stale.
 *
 * A JOINED list sanitizes per ELEMENT — load-bearing for `displayIdent`, whose
 * boundary is per value, and a formatting rule for `displaySafe`; its own doc
 * carries the difference.
 *
 * Deliberately NOT sanitized: `pathArgs` and the `<head>` segment parsed out of
 * one. Those are the operator's own argv echoed back, a different trust bucket
 * from the assembly, and `renderNoStackMatch` renders a user-supplied pattern
 * the same way. The one place argv goes into a PASTEABLE command
 * (`cdkd state orphan <p>`) is `isPasteableIdent`'s class rather than this
 * one — [.claude/rules/pasteable-ident.md](../../../.claude/rules/pasteable-ident.md),
 * tracked on go-to-k/cdkd#3436.
 */

/** Every element sanitized, then joined with the list separator. */
function displaySafeList(values: readonly string[]): string {
  return values.map((value) => displaySafe(value)).join(', ');
}

/**
 * One `Available:` entry per element, each with a visible boundary.
 *
 * **This helper is NOT the identity on every legitimate value**, and the
 * difference is the point: `displayIdent` JSON-quotes anything outside
 * `PLAIN_IDENT`, and a construct id may legitimately carry a space
 * (`new Table(this, 'My Table')` is legal — `constructs` rewrites only `/`), so
 * `MyStack/My Table/Resource` renders quoted in `Available paths:`. Accepted
 * here for the reason `describeStack` accepts it: these sentences exist to say
 * which values are valid, and the alternative passes the spaces and quotes a
 * crafted value needs. It is why `cdkd list`'s PAYLOAD does not use it.
 */
function displayIdentList(values: readonly string[], separator: string): string {
  return values
    .map((value) => displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }))
    .join(separator);
}

/**
 * The `Available regions: ...` lists, which are identity sentences over a
 * STATE-derived region.
 *
 * A REGION has a known ASCII charset, so every OTHER render of one in this file
 * passes `asciiOnly` — the positive allowlist `display-safe.ts`'s own header
 * asks such a caller for, and the only mode with no invisible-formatter
 * residual. Measured: plain `displaySafe` keeps a zero-width space planted
 * inside a region name; `{ asciiOnly: true }` does not. `displayIdent` already
 * applies that allowlist, so these two lists need no second spelling of it.
 *
 * `displayIdent` for a real region and the bare literal for a legacy ref with
 * none. Measured: `displaySafe('us-east-1' + U+0085)` is `'us-east-1'`, so
 * under `displaySafe` a planted state key makes `pickStackRegion` print
 * `Available regions: us-east-1.` in the sentence that just said that region
 * holds no state, and `multiple regions: us-east-1, us-east-1` in the other.
 * THE CAP IS THE 255 DEFAULT, deliberately, and NOT the
 * `STACK_REF_MAX_CODE_POINTS` its sibling `displayIdentList` passes. A region's
 * grammar is ~25 characters, so the default is already generous, and
 * `display-safe.ts` asks each caller to keep the TIGHTEST cap its grammar
 * allows — a region read out of a planted S3 key segment is unbounded, and the
 * tighter cap is what bounds that payload. The wider one was passed here first
 * for symmetry with the path list, which is the wrong reason: a construct path
 * genuinely exceeds 255 and a region never does.
 *
 * `(legacy)` is cdkd's OWN placeholder, not a value read from anywhere, and it
 * is outside `PLAIN_IDENT`, so routing it through the helper would quote a
 * string no attacker controls. **The carve-out is SAFE because of that same
 * fact**: `PLAIN_IDENT` excludes `(` and `)`, so a state key segment literally
 * named `(legacy)` renders QUOTED through `displayIdent` and cannot be mistaken
 * for this bare placeholder. A future widening of `PLAIN_IDENT` to admit
 * parentheses would silently break that, which is why the dependency is written
 * down rather than left to be re-derived.
 *
 * ONE RENDERING CHANGES, recorded rather than implied away: a ref whose `region`
 * is the EMPTY string used to print an empty slot (`us-east-1, , eu-west-1`) and
 * now prints `<unrenderable>`. `s3-state-backend.ts` only sets `region` when the
 * key segment is non-empty, so it is reachable at most from a hand-written
 * record; and an invisible entry in a comma list is the failure `UNRENDERABLE`
 * exists to prevent, so this is the direction to fail in. `undefined` — the
 * shape a legacy ref actually has — is unaffected.
 */
function displayRegionList(refs: readonly { region?: string | undefined }[]): string {
  return refs
    .map((ref) => (ref.region === undefined ? '(legacy)' : displayIdent(ref.region)))
    .join(', ');
}

interface OrphanOptions {
  app?: string;
  output?: string;
  stateBucket?: string;
  statePrefix: string;
  stackRegion?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  yes: boolean;
  force: boolean;
  dryRun: boolean;
  verbose: boolean;
  context?: string[];
}

/**
 * `cdkd orphan <constructPath>...` — per-resource orphan, mirrors upstream
 * `cdk orphan --unstable=orphan`.
 *
 * Removes one or more *resources* from cdkd's state for a single stack,
 * rewriting every sibling resource that referenced an orphan so the next
 * deploy doesn't try to re-create the orphan or fail to resolve a stale
 * Ref/GetAtt. **Does not** delete the underlying AWS resources — they
 * remain in AWS, just no longer tracked by cdkd.
 *
 * Migration note (PR #92): the previous "orphan a whole stack's state
 * record" behavior moved to `cdkd state orphan <stack>`; this command is
 * now per-resource and takes construct paths (`MyStack/MyTable`).
 *
 * Algorithm (mirrors upstream's 3-step CFn deploy via SDK calls):
 *
 *   1. Synth, load state, acquire lock.
 *   2. For each non-orphan resource, find every reference to an orphan
 *      in `properties` / `attributes` / `dependencies`:
 *      - `{Ref: O}` → orphan.physicalId
 *      - `{Fn::GetAtt: [O, attr]}` (and `"O.attr"` form) → live
 *        `provider.getAttribute(...)` value (cached per `(O, attr)`).
 *      - `Fn::Sub` template strings — `${O}` / `${O.attr}` placeholders
 *        substituted in place; unrelated placeholders preserved.
 *      - dependency-array entries equal to `O` removed.
 *   3. Apply rewrites + remove orphans from `state.resources` +
 *      `saveState` (If-Match) + release lock.
 *
 * Failure modes (hard-fail with `--force` escape hatch):
 *
 *   - Path doesn't match any resource — error listing available paths.
 *   - Multiple paths reference different stacks — error.
 *   - Reference can't be resolved (provider doesn't implement that attr,
 *     OR the API call fails) — error listing every unresolvable site at
 *     once. With `--force`: fall back to `state.attributes` cache; if
 *     the cache also lacks the attr, leave the original intrinsic
 *     untouched.
 */
async function orphanCommand(pathArgs: string[], options: OrphanOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  if (pathArgs.length === 0) {
    throw new Error(
      "'cdkd orphan' requires at least one construct path, e.g. 'cdkd orphan MyStack/MyTable'.\n" +
        "       To remove a stack's state record (the previous behavior), use:\n" +
        '         cdkd state orphan MyStack'
    );
  }

  // Detect the pre-PR "stack name only" syntax and redirect with an
  // explicit error rather than silently routing — the new behavior is a
  // breaking change and we want users to make a conscious choice between
  // per-resource orphan and the state-orphan route.
  for (const p of pathArgs) {
    if (!p.includes('/')) {
      throw new Error(
        `'cdkd orphan' now expects a construct path like 'MyStack/MyTable'.\n` +
          `       Got: '${p}'\n` +
          `       To remove a stack's state record (the previous behavior), use:\n` +
          `         cdkd state orphan ${p}`
      );
    }
  }

  const region = namedCliRegion(options.region) ?? 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);

    // Synth — required for orphan: we need the template to resolve construct
    // paths back to logical IDs.
    const appCmd = options.app || resolveApp();
    if (!appCmd) {
      throw new Error(
        "'cdkd orphan' requires a CDK app: pass --app or set it in cdk.json. " +
          'The template is read to resolve construct paths to logical IDs.'
      );
    }

    logger.info(synthesisStatusMessage(appCmd, 'Synthesizing CDK app to read template...'));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const result = await synthesizer.synthesize({
      app: appCmd,
      output: options.output || 'cdk.out',
      ...(Object.keys(context).length > 0 && { context }),
      // Threaded so the macro-expander has a real state bucket for
      // the > 51,200-byte template upload path (Issue #463).
      stateBucket,
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
    });

    // Resolve each path to (stack, logicalId). Every path must reference the
    // same stack — orphan operates on one state file at a time.
    const resolved = resolveConstructPaths(pathArgs, result.stacks);
    const stackInfo = resolved.stack;
    const orphanLogicalIds = resolved.logicalIds;

    const { region: targetRegion, recordRegion } = await pickStackRegion(
      stateBackend,
      stackInfo.stackName,
      stackInfo.region,
      options.stackRegion
    );

    logger.info(
      `Target: ${displaySafe(stackInfo.stackName)} (${displaySafe(targetRegion, { asciiOnly: true })}); ` +
        `orphaning ${orphanLogicalIds.length} resource(s): ${displaySafeList(orphanLogicalIds)}`
    );

    // Acquire lock so a concurrent deploy can't observe the half-rewritten
    // state. Skip in --dry-run to keep dry-run a pure read.
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    // What a pasteable recovery command needs to reach THIS bucket: the lock
    // contention hint and the properties refusal's drop remedy both carry it,
    // because `cdkd force-unlock` / `cdkd state orphan` re-resolve the bucket
    // from the ambient profile (go-to-k/cdkd#2170, go-to-k/cdkd#3363).
    const recovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket,
      statePrefix: options.statePrefix,
    };
    if (!options.dryRun) {
      // Check the boolean (issue #2161): a bare `acquireLock` returns `false`
      // for a live foreign lock without throwing, so the discarded return let
      // orphan rewrite state under a concurrent deploy and then release that
      // deploy's lock. Throwing on `!acquired` aborts before any state write.
      const acquired = await lockManager.acquireLock(
        stackInfo.stackName,
        targetRegion,
        owner,
        'orphan'
      );
      if (!acquired) {
        throw new Error(
          await buildLockContentionMessage({
            lockManager,
            stackName: stackInfo.stackName,
            region: targetRegion,
            recovery,
          })
        );
      }
    }

    try {
      const stateData = await stateBackend.getState(stackInfo.stackName, targetRegion);
      if (!stateData) {
        throw new Error(
          `No state found for stack ${displayStackName(stackInfo.stackName)} ` +
            `(${displaySafe(targetRegion, { asciiOnly: true })}). ` +
            `Nothing to orphan. (Did the stack get deployed?)`
        );
      }
      const { state, etag, migrationPending } = stateData;
      // EVERY refusal below takes `recordRegion`, not `targetRegion`: each
      // text ends on commands or an object path the operator pastes, and those
      // select by the region the record is LISTED under. For a single legacy
      // record with no region in its body the two differ — `targetRegion` is
      // the synthesized region `getState` falls back from — and a
      // `--stack-region` naming it selects nothing (go-to-k/cdkd#3359 for the
      // properties refusal, go-to-k/cdkd#3388 for the two above it).
      //
      // `cdkd orphan` REWRITES and SAVES state, so a record whose resource map
      // cannot be read is refused rather than repaired (go-to-k/cdkd#3018).
      refuseMalformedState(state, stackInfo.stackName, recordRegion, recovery);
      // And the same for the `outputs` bag (go-to-k/cdkd#3192), which the
      // refusal above does NOT cover — a record can be malformed in either
      // container alone. `rewriteResourceReferences` rebuilds the bag from
      // `Object.entries(state.outputs ?? {})` and this command SAVES the
      // result at the `saveState` below, so `outputs: 'abcdef'` is written
      // back as a well-formed `{"0":"a",…,"5":"f"}` and a null one as `{}`
      // (both measured). The damaged record is the only signal anything is
      // wrong; laundering it into a legitimate-looking one is permanent, and
      // the next deploy republishes the fabricated keys into the shared
      // exports index. AT THE LOAD, above every read: the rebuild is far
      // below, and a guard written there would sit under the reads the
      // `missing` check and the rewrite already made.
      refuseMalformedOutputs(state, stackInfo.stackName, recordRegion, recovery);
      // A surviving ENTRY that is not a readable resource record
      // (go-to-k/cdkd#3350) — the one container the rewrite RESHAPES rather
      // than carries: it rebuilds each kept record as `{ ...resource, ... }`,
      // so a string entry is saved as per-character keys and a number as a
      // record with no physical id. Scoped to the survivors, like the
      // properties refusal below and for its reason.
      refuseMalformedResourceEntriesForOrphan(
        state,
        orphanLogicalIds,
        stackInfo.stackName,
        recordRegion,
        recovery
      );
      // And the per-ENTRY `properties` container (go-to-k/cdkd#3318), which
      // neither refusal above covers: `refuseMalformedState` answers a question
      // about the record ROOT, and `unreadableResourcePropertyBags` deliberately
      // returns `[]` for a record whose root bag is unreadable — what a caller
      // must not do is take only one of the two. `rewriteResourceReferences`
      // passes each bag through `rewriteValue`, which returns a non-object
      // VERBATIM, and re-assigns the result through a bare cast, so the record
      // this command SAVES still carries the map it could not read.
      //
      // SCOPED TO THE SURVIVORS by handing it `orphanLogicalIds`. A record this
      // run is dropping cannot be persisted, and refusing on one would close a
      // way out of exactly this state — `cdkd orphan` over the damaged record
      // removes it and repairs the rest. That way out is CONDITIONAL and the
      // refusal says so: `orphanLogicalIds` comes from the SYNTHESIZED
      // template's `aws:cdk:path` index, so a record the app no longer declares
      // can never be exempted, and the message leads with the two remedies that
      // need no CDK app. AT THE LOAD, above the rewrite walk and above the
      // `--dry-run` return.
      refuseMalformedResourcePropertiesForOrphan(
        state,
        orphanLogicalIds,
        stackInfo.stackName,
        recordRegion,
        recovery
      );
      // The same survivors' `attributes` map (go-to-k/cdkd#3345), the
      // `Fn::GetAtt` cache: carried into the save verbatim the way `properties`
      // is, and a list walked into it.
      refuseMalformedResourceAttributesForOrphan(
        state,
        orphanLogicalIds,
        stackInfo.stackName,
        recordRegion,
        recovery
      );
      // And `state.orphans`, which the rewrite spreads through `carriedState`
      // without reading at all (go-to-k/cdkd#3344): the list itself, and each
      // rollback-orphan record's `ResourceState`. NOT scoped by the orphan set —
      // those records are not in `resources`, so this command cannot name one.
      refuseMalformedOrphansForOrphan(state, stackInfo.stackName, recordRegion, recovery);

      // Validate that every requested orphan exists in state — otherwise we
      // would silently no-op while the user expected a removal.
      // OWN keys, matching the rewriter's snapshot: `in` answered true for a
      // template logical id spelled `constructor`, which then died in the
      // rewrite on an internal error instead of being reported here.
      const missing = orphanLogicalIds.filter((id) => !Object.hasOwn(state.resources, id));
      if (missing.length > 0) {
        // Both halves take `displayIdentList`, and for one reason: this is one
        // sentence over one value grammar — `have` is state-derived and
        // `missing` template-derived, but they are the same shape and the reader
        // compares them against each other. Splitting the helpers would accept
        // the quoting cost on one half and leave the other unable to show a
        // boundary. A raw neighbour forges just as well as the value beside it.
        // No `?? {}`: the `in` test two lines above already indexes
        // `state.resources` unguarded, and `refuseMalformedState` at the load
        // refused a record whose bag could not be read — so a fallback here
        // only pretends the two lines disagree about whether it can be absent.
        const have = displayIdentList(Object.keys(state.resources), ', ');
        throw new Error(
          `Resource(s) not in state for stack ${displayStackName(stackInfo.stackName)} ` +
            `(${displaySafe(targetRegion, { asciiOnly: true })}): ` +
            `${displayIdentList(missing, ', ')}.\n` +
            `Available logical IDs: ${have}`
        );
      }

      const providerRegistry = new ProviderRegistry();
      registerAllProviders(providerRegistry);

      const rewriteResult = await rewriteResourceReferences(
        state,
        orphanLogicalIds,
        providerRegistry,
        { force: options.force }
      );

      printRewriteSummary(rewriteResult.rewrites, orphanLogicalIds);

      if (rewriteResult.unresolvable.length > 0 && !options.force) {
        printUnresolvable(rewriteResult.unresolvable);
        throw new Error(
          `Orphan aborted: ${rewriteResult.unresolvable.length} reference(s) could not be resolved.\n` +
            `Re-run with --force to fall back to cached attribute values from state, ` +
            `or fix the underlying provider/AWS issue and retry.`
        );
      }
      if (rewriteResult.unresolvable.length > 0) {
        // --force path: print but don't abort.
        printUnresolvable(rewriteResult.unresolvable);
        logger.warn(
          `--force: continuing despite ${rewriteResult.unresolvable.length} unresolved reference(s); ` +
            `the original intrinsic was left in place where the cache also lacked the value.`
        );
      }

      if (options.dryRun) {
        logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
        return;
      }

      if (!options.yes && !options.force) {
        const ok = await confirmPrompt(
          `Orphan ${orphanLogicalIds.length} resource(s) from cdkd state for ` +
            `${displaySafe(stackInfo.stackName)} (${displaySafe(targetRegion, { asciiOnly: true })})? ` +
            `AWS resources will NOT be deleted.`
        );
        if (!ok) {
          logger.info('Orphan cancelled.');
          return;
        }
      }

      await stateBackend.saveState(stackInfo.stackName, targetRegion, rewriteResult.state, {
        expectedEtag: etag,
        ...(migrationPending && { migrateLegacy: true }),
      });

      logger.info(
        `Orphaned ${orphanLogicalIds.length} resource(s) from state: ` +
          `${displaySafe(stackInfo.stackName)} (${displaySafe(targetRegion, { asciiOnly: true })}). ` +
          `AWS resources are still in AWS; cdkd will no longer manage them.`
      );
    } finally {
      if (!options.dryRun) {
        await lockManager.releaseLock(stackInfo.stackName, targetRegion).catch((err) => {
          // AWS's own text, and it names the lock KEY
          // (`cdkd/{stackName}/{region}/lock.json`), so it echoes the
          // manifest-derived stack name back — the same reason CloudFormation's
          // `StatusReason` and the context-provider failure text take this
          // helper rather than bare `displaySafe`.
          logger.warn(
            `Failed to release lock: ` +
              `${displayAwsMessage(err instanceof Error ? err.message : String(err))}`
          );
        });
      }
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Resolve every user-supplied construct path to a `(stack, logicalId)`
 * pair, enforcing that all paths reference the same stack.
 *
 * The first segment of each path must be a synthesized stack's
 * `displayName` (or `stackName`); the remainder is the path that CDK
 * encodes into the `aws:cdk:path` Metadata tag (e.g.
 * `MyStack/MyTable/Resource`). We index the template by that tag and
 * look the rest up there.
 */
function resolveConstructPaths(
  paths: string[],
  stacks: StackInfo[]
): { stack: StackInfo; logicalIds: string[] } {
  const byStackName = new Map<string, StackInfo>();
  const byDisplayName = new Map<string, StackInfo>();
  for (const s of stacks) {
    byStackName.set(s.stackName, s);
    byDisplayName.set(s.displayName, s);
  }

  let stack: StackInfo | undefined;
  const logicalIds: string[] = [];

  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash <= 0 || slash === p.length - 1) {
      throw new Error(`Invalid construct path '${p}'. Expected '<StackName>/<Path/To/Resource>'.`);
    }
    const head = p.slice(0, slash);
    const candidate = byDisplayName.get(head) ?? byStackName.get(head);
    if (!candidate) {
      const available = displayIdentList(
        stacks.map((s) => s.displayName ?? s.stackName),
        ', '
      );
      throw new Error(
        `Construct path '${p}': stack '${head}' not found in synthesized app. ` +
          `Available: ${available}`
      );
    }
    if (stack === undefined) {
      stack = candidate;
    } else if (stack.stackName !== candidate.stackName) {
      throw new Error(
        `All construct paths must reference the same stack. ` +
          `Got ${displayStackName(stack.stackName)} and ${displayStackName(candidate.stackName)}. ` +
          `Run 'cdkd orphan' once per stack.`
      );
    }

    // Match the input as an L2 path (orphan everything under it) OR an
    // exact L1 path. Mirrors upstream `cdk orphan --unstable=orphan`'s
    // prefix-match strategy so users can pass `MyStack/MyConstruct/Bucket`
    // instead of the synthesized `MyStack/MyConstruct/Bucket/Resource`.
    const index = buildCdkPathIndex(candidate.template);
    const matches = resolveCdkPathToLogicalIds(p, index);
    if (matches.length === 0) {
      const available = displayIdentList([...index.keys()].sort(), '\n  ');
      throw new Error(
        `Construct path '${p}' not found in template for stack ` +
          `${displayStackName(candidate.stackName)}.\n` +
          `Available paths:\n  ${available}`
      );
    }
    for (const { logicalId } of matches) {
      if (!logicalIds.includes(logicalId)) {
        logicalIds.push(logicalId);
      }
    }
  }

  if (!stack) {
    throw new Error('No construct paths supplied.');
  }
  return { stack, logicalIds };
}

/**
 * What {@link pickStackRegion} settled on: the region to LOAD and lock under,
 * and the region the selected record is KEYED under in the listing.
 */
interface PickedStackRegion {
  /** The region `getState` / the lock are called with. */
  region: string;
  /**
   * The selected ref's own `region` — `undefined` for a legacy ref
   * `listStacks` lists with none (its body names no region, or the probe
   * reading it failed). For such a ref `region` is the synthesized region when
   * there is one (`getState` falls back to the legacy key for any region) and
   * `''` when there is not. A remedy command the operator pastes must
   * use THIS one: `cdkd state orphan` / `cdkd state show` select a record by
   * comparing `--stack-region` against the listing, so the synthesized region
   * selects nothing there (go-to-k/cdkd#3359).
   */
  recordRegion: string | undefined;
}

/**
 * Decide which region's state to operate on. Mirrors the disambiguation
 * logic shared with `state resources` / `state show`: prefer the
 * synthesized stack's region, then `--stack-region`, then the single
 * region in state. Errors out with a clear list when ambiguous.
 */
async function pickStackRegion(
  stateBackend: S3StateBackend,
  stackName: string,
  synthRegion: string | undefined,
  flag: string | undefined
): Promise<PickedStackRegion> {
  const refs = (await stateBackend.listStacks()).filter((r) => r.stackName === stackName);
  if (refs.length === 0) {
    // No record is listed, so `getState` below finds none and throws before
    // any remedy text renders; `recordRegion` only has to be well-typed here.
    if (flag) return { region: flag, recordRegion: flag };
    if (synthRegion) return { region: synthRegion, recordRegion: synthRegion };
    throw new Error(
      `No state found for stack ${displayStackName(stackName)}. ` +
        `Run 'cdkd state list' to see available stacks.`
    );
  }
  if (flag) {
    const found = refs.find((r) => r.region === flag);
    if (!found) {
      const seen = displayRegionList(refs);
      throw new Error(
        `No state found for stack ${displayStackName(stackName)} in region '${flag}'. ` +
          `Available regions: ${seen}.`
      );
    }
    return { region: flag, recordRegion: flag };
  }
  if (synthRegion) {
    const found = refs.find((r) => r.region === synthRegion);
    if (found) return { region: synthRegion, recordRegion: synthRegion };
  }
  if (refs.length === 1) {
    const recordRegion = refs[0]!.region;
    return { region: recordRegion ?? synthRegion ?? '', recordRegion };
  }
  const regions = displayRegionList(refs);
  throw new Error(
    `Stack ${displayStackName(stackName)} has state in multiple regions: ${regions}. ` +
      `Re-run with --stack-region <region> to disambiguate.`
  );
}

function printRewriteSummary(rewrites: OrphanRewrite[], orphanLogicalIds: string[]): void {
  const logger = getLogger();
  logger.info('');
  logger.info(
    `Orphaning ${orphanLogicalIds.length} resource(s): ${displaySafeList(orphanLogicalIds)}`
  );
  if (rewrites.length === 0) {
    logger.info('  No sibling references — every reference was already to a non-orphan resource.');
    return;
  }
  logger.info(`Applied ${rewrites.length} rewrite(s):`);
  for (const r of rewrites) {
    const before = stringifyForAudit(r.before);
    const after = r.kind === 'dependency' ? '(dropped)' : stringifyForAudit(r.after);
    logger.info(
      `  [${r.kind}] ${displaySafe(r.logicalId)}.${displaySafe(r.path)}: ${before} → ${after}`
    );
  }
}

function printUnresolvable(unresolvable: UnresolvableReference[]): void {
  const logger = getLogger();
  logger.error(`${unresolvable.length} reference(s) could not be resolved:`);
  for (const u of unresolvable) {
    logger.error(
      `  ${displaySafe(u.logicalId)}.${displaySafe(u.path)}: ` +
        `${displaySafe(u.orphanLogicalId)}.${displaySafe(u.attribute)} — ${displaySafe(u.reason)}`
    );
  }
}

/**
 * A rewrite's before / after is a TEMPLATE value, so it is sanitized after
 * serialization ([#3479](https://github.com/go-to-k/cdkd/issues/3479)).
 * `JSON.stringify` is not the boundary on its own — measured: it escapes C0 but
 * nothing above, so DEL, the C1 range, `U+2028`/`U+2029` and the bidi overrides
 * pass straight through, and `U+009B` is read as CSI by a UTF-8 xterm.
 */
function stringifyForAudit(value: unknown): string {
  // `JSON.stringify` answers `undefined` — not a string — for `undefined`, a
  // function and a symbol, all of which `unknown` admits. `String()` keeps the
  // pre-PR rendering for `undefined`, where `displaySafe` alone would print an
  // EMPTY cell that reads as "nothing was there". It is NOT byte-identical for a
  // function (`String(fn)` prints its source, where the old expression printed
  // `undefined`), which is unreachable for a `JSON.parse`d template value and is
  // recorded rather than special-cased.
  return displaySafe(JSON.stringify(value) ?? String(value));
}

/**
 * `cdkd orphan`'s confirmation prompt. Its only call site is inside the
 * `if (!options.yes && !options.force)` block above, which is what keeps
 * `confirmOrRefuse`'s non-interactive refusal (issue #2275) from firing on a
 * flagged run.
 *
 * Exported for unit testing — internal to the command flow otherwise.
 */
export async function confirmPrompt(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The cdkd orphan confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass -y / --yes (or -f / --force) to confirm the orphan, or run ' +
      'the command from a real terminal.',
  });
}

/**
 * Create the top-level `cdkd orphan` command.
 */
export function createOrphanCommand(): Command {
  const cmd = new Command('orphan')
    .description(
      'Remove one or more resources from cdkd state by construct path (does NOT delete AWS ' +
        "resources). Mirrors aws-cdk-cli's 'cdk orphan --unstable=orphan'. Synth-driven; for " +
        "the previous whole-stack-orphan behavior, use 'cdkd state orphan <stack>'."
    )
    .argument(
      '<paths...>',
      "Construct paths to orphan, e.g. 'MyStack/MyTable'. Multiple paths must reference the same stack."
    )
    .option(
      '--stack-region <region>',
      'Region of the stack record to operate on. Required when the same stack name has state in multiple regions.',
      parseStackRegion
    )
    .option(
      '--dry-run',
      'Compute and print the rewrite audit table without acquiring a lock or saving state.',
      false
    )
    .action(withErrorHandling(orphanCommand));

  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...destroyOptions, // adds -f / --force (escape hatch for unresolvable references + skip confirm)
    ...contextOptions,
  ].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated outside of bootstrap (PR 5).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
