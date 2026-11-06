import { Command, Option } from 'commander';
import { commonOptions, deprecatedRegionOption, stateOptions } from '../../options.js';
import { getLogger, reserveStdoutForPayload } from '../../../utils/logger.js';
import { withErrorHandling } from '../../../utils/error-handler.js';
import { S3StateBackend, type StackStateRef } from '../../../state/s3-state-backend.js';
import { displayIdent, safeMsg, stringifyJsonPayload } from '../../../utils/display-safe.js';
import {
  buildStackTree,
  renderStackTreeAscii,
  stackTreeToJson,
  type StackTreeEntry,
  type StackTreeNode,
} from '../state-list-tree.js';
import type { StackState } from '../../../types/state.js';
import {
  type StackDetail,
  LOCK_READ_FAILED_REASON,
  LEGACY_LOCK_READ_FAILED_REASON,
  type StateReadErrorKind,
  STATE_READ_REASONS,
  resourceCountOrNull,
  readOrFailure,
  isoTimestampOrNull,
  formatStackRefSafe,
} from './refs.js';
import { setupStateBackend, sortRefs } from './setup.js';

/**
 * `cdkd state list` command implementation
 *
 * Lists stacks registered in the configured S3 state bucket. Each row is a
 * `(stackName, region)` pair — the same `stackName` deployed to two regions
 * shows up as two rows, which is the whole point of the region-prefixed
 * state key layout introduced in PR 1.
 *
 * - Default: `Stack (region)` per line, sorted alphabetically. Legacy
 *   `version: 1` records (no region) appear as plain `Stack` rows.
 * - `--long`/`-l`: include resource count, last-modified time, and lock status.
 * - `--json`: emit a JSON array (alongside or instead of the long form).
 * - `--tree`: render parent → child stack tree (issue #555 A3). Loads each
 *   state record to read the v6 `parentStack` / `parentRegion` fields, then
 *   reconstructs the hierarchy. Flat default is preserved so tooling that
 *   greps the existing one-per-line shape keeps working.
 */
async function stateListCommand(options: {
  long: boolean;
  json: boolean;
  tree: boolean;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  // Issue #2280: claim stdout for the payload BEFORE anything can print on
  // it. `setupStateBackend` runs `applyRoleArnIfSet`, whose `Assumed role
  // ...` INFO line lives in `src/utils/role-arn.ts` — a module this file
  // cannot route on its own, which is why the reservation is module-level.
  //
  // UNCONDITIONAL since issue #2435, where issue #2280 keyed this on
  // `options.json`. THE DISCRIMINATOR IS THE OUTPUT'S SHAPE, NOT THE FLAG: a
  // line-oriented RECORD SET is a payload; a formatted human VIEW (aligned
  // columns, a rendered tree, a metadata block) is not. `--json` picks the
  // payload's ENCODING — it was never what made stdout a payload stream.
  //
  // `state list`'s DEFAULT mode — no flags at all — writes one
  // `Stack (region)` reference per line, undecorated: the shape
  // `cdkd state list | while read -r ref` consumes, and the same contract as
  // `cdkd list`'s default mode, which issue #2410 made unconditionally
  // reserved. Under the `options.json` gate a default run put the logger's
  // prose (a `--verbose` DEBUG stack trace, `Assumed role ...`) on the same
  // stream as the references, and a consumer read those lines as stack
  // references.
  //
  // Taken here, before the mode is known, so `--long` and `--tree` WITHOUT
  // `--json` are swept along even though their output is a formatted view.
  // That is deliberate and harmless: both still write their view to stdout
  // through `process.stdout.write`, so only interleaved logger prose moves —
  // to stderr, where an operator at a terminal still sees it and where it
  // stops corrupting a redirect to a file. The alternative, a mode-aware
  // `if (!(options.tree && !options.json))`, is the flag-shaped gating this
  // change exists to remove.
  //
  // The other three `state` payload sites keep their `--json` gate by that
  // same discriminator, and unlike `list` they have NO record-set mode behind
  // the flag: `state resources` pads three columns to widths computed from
  // the data, `state show` renders `renderTreeWithChildren` /
  // `renderStateBlock` blocks, and `state info` prints a metadata block. Do
  // not sweep those in without a consumer that reads them.
  reserveStdoutForPayload();

  const setup = await setupStateBackend(options);
  try {
    const refs = sortRefs(await setup.stateBackend.listStacks());

    if (options.tree) {
      await renderTreeMode(refs, setup.stateBackend, options.json);
      return;
    }

    // Default mode: `Stack (region)` per line, sorted. Sanitized BECAUSE a
    // `while read` loop consumes it: `listStacks` does not validate a key, so a
    // planted `cdkd/Decoy<LF>ProdStack (us-east-1)/us-east-1/state.json` would
    // otherwise emit a second, fully formed reference for a stack with no
    // record, and a script would act on it. Since issue #3164 the same helper
    // also makes the ` (region)` BOUNDARY visible, so a planted name carrying
    // cdkd's own annotation no longer renders byte-equal to a genuine row.
    // Both rules are the identity on a plain identifier, and stack names and
    // region codes are, so every legitimate row is byte-identical (issue
    // #3069).
    if (!options.long && !options.json) {
      for (const ref of refs) {
        process.stdout.write(`${formatStackRefSafe(ref)}\n`);
      }
      return;
    }

    // --json without --long: array of `{stackName, region}` records.
    if (options.json && !options.long) {
      const payload = refs.map((r) => ({ stackName: r.stackName, region: r.region ?? null }));
      process.stdout.write(`${stringifyJsonPayload(payload)}\n`);
      return;
    }

    // --long (with or without --json): fetch detail per stack in parallel.
    // Each row's two reads are guarded independently, the precedent being
    // `renderTreeMode` below: one unreadable stack degrades ITS row instead of
    // rejecting the whole listing (issue #3069). The two share an S3 client, so
    // a credential failure usually lands on both, but either can fail alone.
    const details: StackDetail[] = await Promise.all(
      refs.map(async (ref): Promise<StackDetail> => {
        // For legacy refs (no region), passing the legacy region string would
        // miss the legacy key — instead, lookup with whichever region the ref
        // carries (could be `undefined` for very-legacy records). The state
        // backend's getState uses the region as part of the key; for legacy
        // records the region embedded in the file is the one that matches.
        const lookupRegion = ref.region ?? '';
        const [stateRead, lockRead] = await Promise.all([
          readOrFailure(() =>
            lookupRegion
              ? setup.stateBackend.getState(ref.stackName, lookupRegion)
              : Promise.resolve(null)
          ),
          readOrFailure(() => setup.lockManager.isLocked(ref.stackName, ref.region)),
        ]);
        const state = stateRead.ok ? stateRead.value?.state : undefined;
        const resourceCount = !stateRead.ok
          ? null
          : state
            ? resourceCountOrNull(state.resources)
            : 0;
        // Decided ONCE, and the reason derived from it, so `stateReadError`
        // and `stateReadErrorKind` cannot disagree about which failure it was.
        const stateReadErrorKind: StateReadErrorKind | null = !stateRead.ok
          ? 'read-failed'
          : resourceCount === null
            ? 'resources-malformed'
            : null;
        return {
          stackName: ref.stackName,
          region: ref.region ?? null,
          resourceCount,
          lastModified: state ? isoTimestampOrNull(state.lastModified) : null,
          locked: lockRead.ok ? lockRead.value : null,
          stateReadError:
            stateReadErrorKind === null ? null : STATE_READ_REASONS[stateReadErrorKind],
          stateReadErrorKind,
          lockReadError: lockRead.ok
            ? null
            : ref.region
              ? LOCK_READ_FAILED_REASON
              : LEGACY_LOCK_READ_FAILED_REASON,
        };
      })
    );

    // A count only: the listing itself succeeded, and each affected row says
    // why -- which of its two reads failed, or that its `resources` could not
    // be counted. The reservation above routes this line to stderr, so it
    // never lands inside a `--long --json` payload.
    const degraded = details.filter((d) => d.stateReadError !== null || d.lockReadError !== null);
    if (degraded.length > 0) {
      logger.warn(
        safeMsg`${degraded.length} of ${details.length} stack(s) could not be fully read or counted; ` +
          `their rows say why.`
      );
    }

    if (options.json) {
      process.stdout.write(`${stringifyJsonPayload(details)}\n`);
      return;
    }

    // Long human-readable format.
    const lines: string[] = [];
    // The stack name and region go through `formatStackRefSafe`, as in the
    // default mode above: both come from an S3 key segment, which admits a
    // newline or ESC, so a planted key could otherwise forge a `Lock:` line
    // inside another row -- and, since issue #3164, could spoof a genuine
    // header row by carrying this view's own ` (region)` annotation. The
    // `  Region:` line below takes the same boundary: with no surrounding
    // quotes at all, a padded value could carry this view's next row on the
    // same line (go-to-k/cdkd#3179).
    // `--json` does not take this view's replace-and-quote rule, which would
    // change the values a consumer matches on: `stringifyJsonPayload` ESCAPES
    // the dangerous class instead, so the payload parses back to the stored
    // values and carries none of them raw (go-to-k/cdkd#3163).
    for (const detail of details) {
      lines.push(
        formatStackRefSafe({
          stackName: detail.stackName,
          ...(detail.region ? { region: detail.region } : {}),
        })
      );
      lines.push(`  Region: ${detail.region === null ? '(legacy)' : displayIdent(detail.region)}`);
      lines.push(
        `  Resources: ${
          detail.stateReadError !== null
            ? `unknown (${detail.stateReadError})`
            : String(detail.resourceCount)
        }`
      );
      lines.push(`  Last Modified: ${detail.lastModified ?? 'unknown'}`);
      lines.push(
        `  Lock: ${
          detail.lockReadError !== null
            ? `unknown (${detail.lockReadError})`
            : detail.locked
              ? 'locked'
              : 'unlocked'
        }`
      );
      lines.push('');
    }
    if (lines.length > 0) {
      // Drop trailing blank line for tidy output.
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } finally {
    setup.dispose();
  }
}

/**
 * Render the parent → child stack tree for `cdkd state list --tree`.
 *
 * Loads each state record in parallel to read the v6 `parentStack` /
 * `parentLogicalId` / `parentRegion` fields, then hands the enriched flat
 * list to {@link buildStackTree}. A missing state record (NoSuchKey returns
 * `null` from getState) OR an unreadable one (transient S3 503 / throttle /
 * per-stack IAM hiccup throws) degrades to a top-level entry (no parent
 * link) — the row still appears in the tree at the root level rather than
 * vanishing, and one bad record never kills the whole view.
 *
 * `tree --json` emits the nested {@link import('./state-list-tree.js').StackTreeJson}
 * shape; plain `tree` renders `tree(1)`-style box-drawing.
 *
 * The `JSON.stringify` below recurses once per level of the shape it is handed,
 * and so does the box-drawing renderer. Neither needs a depth guard here:
 * `buildStackTree` caps how deep a node may sit
 * ({@link import('./state-list-tree.js').MAX_STACK_TREE_DEPTH}), which bounds
 * both (issue #3155).
 */
async function renderTreeMode(
  refs: readonly StackStateRef[],
  stateBackend: S3StateBackend,
  asJson: boolean
): Promise<void> {
  const entries: StackTreeEntry[] = await Promise.all(
    refs.map(async (ref): Promise<StackTreeEntry> => {
      // Legacy v1 records have no region in the key — getState needs a region
      // arg, so skip the read and treat them as top-level (parent links were
      // introduced in v6 anyway, so legacy state can never carry them).
      if (!ref.region) {
        return { stackName: ref.stackName };
      }
      // One transient S3 error (503, throttle, single-stack IAM hiccup) should
      // not kill the whole `--tree` view — degrade to a no-parent-link entry
      // so the row stays visible at the root level. NoSuchKey returns `null`
      // from getState already; this catch covers the other failure modes.
      let state: StackState | undefined;
      try {
        const result = await stateBackend.getState(ref.stackName, ref.region);
        state = result?.state;
      } catch {
        return { stackName: ref.stackName, region: ref.region };
      }
      // Only STRING parent fields are copied. `parseStateBody` does not type
      // them, and `buildStackTree` interpolates both into a key OUTSIDE this
      // per-row `try`, so a planted `"parentStack": {"toString": null}` threw
      // a TypeError there and emptied the whole view -- the promise this
      // function's JSDoc makes. cdkd writes these fields as strings, so a
      // record it wrote links as before; a hand-edited array such as
      // `["Parent"]`, which interpolation used to coerce into a working link,
      // now lands at the root instead. `parentLogicalId` never reaches a key,
      // but `--tree --json` declares it `string | null`, so it is typed the same
      // way (issue #3069).
      //
      // The link is kept or dropped WHOLE. `refKey` reads a missing region as
      // `''`, the key a legacy region-less record has, so keeping a string
      // `parentStack` while dropping a non-string `parentRegion` would file the
      // stack under an unrelated LEGACY record of the same name instead of at
      // the root. An ABSENT `parentRegion` stays a valid link on purpose: that
      // is how a child names a legacy region-less parent. This does not stop
      // every legacy binding. An explicit `parentRegion: ""` is a string and
      // keys the same way, and a planted legacy-layout key can capture any
      // record that names its stack with no `parentRegion`. Neither shape is
      // reachable from cdkd-written state, since every writer sets a
      // non-empty `parentRegion`, so the captured record is hand-written too.
      const linkIsValid =
        typeof state?.parentStack === 'string' &&
        (state.parentRegion === undefined || typeof state.parentRegion === 'string');
      return {
        stackName: ref.stackName,
        region: ref.region,
        ...(linkIsValid && { parentStack: state!.parentStack }),
        ...(linkIsValid &&
          typeof state?.parentLogicalId === 'string' && {
            parentLogicalId: state.parentLogicalId,
          }),
        ...(linkIsValid &&
          typeof state?.parentRegion === 'string' && { parentRegion: state.parentRegion }),
      };
    })
  );

  const roots = buildStackTree(entries);

  if (asJson) {
    process.stdout.write(`${stringifyJsonPayload(stackTreeToJson(roots))}\n`);
    return;
  }

  if (roots.length === 0) return;
  const rendered = renderStackTreeAscii(roots, (node: StackTreeNode) =>
    // The same formatted-view rule as `--long`'s text rows: sanitized, and
    // since issue #3164 boundary-quoted -- which this view needs on its own
    // account, a label carrying `└── ` being able to fake a sibling connector.
    formatStackRefSafe({
      stackName: node.stackName,
      ...(node.region ? { region: node.region } : {}),
    })
  );
  process.stdout.write(`${rendered}\n`);
}

/**
 * Create the `state list` subcommand.
 */
export function createStateListCommand(): Command {
  // --tree owns a different rendering mode from --long (per-stack indented
  // tree vs per-stack block of metadata); the two don't compose cleanly. Use
  // Commander's built-in `.conflicts()` so the rejection happens at
  // option-parsing time, BEFORE any AWS call.
  const treeOption = new Option(
    '--tree',
    'Render parent → child stack tree (loads each state record to read the v6 parent link)'
  )
    .default(false)
    .conflicts('long');

  const cmd = new Command('list')
    .alias('ls')
    .description('List stacks registered in the cdkd state bucket')
    .option('-l, --long', 'Show resource count, last-modified time, and lock status', false)
    .option('--json', 'Output as JSON', false)
    .addOption(treeOption)
    .action(withErrorHandling(stateListCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
