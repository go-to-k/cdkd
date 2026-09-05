import { Command, Option } from 'commander';
import {
  commonOptions,
  deprecatedRegionOption,
  parseDuration,
  stateOptions,
  warnIfDeprecatedRegion,
  parseStackRegion,
} from '../options.js';
import { getLogger, reserveStdoutForPayload } from '../../utils/logger.js';
import { bold, cyan, gray, green, red, yellow } from '../../utils/colors.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { CdkdError, withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import {
  DeploymentEventsReader,
  DEPLOYMENT_EVENTS_MAX_INDEX_RUNS,
} from '../../state/deployment-events-store.js';
import type { DeploymentEvent, DeploymentRunSummary } from '../../types/deployment-events.js';
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import { displaySafe } from '../../utils/display-safe.js';
import { UNRENDERABLE } from '../../state/lock-contention-message.js';

/**
 * Issue [#2438](https://github.com/go-to-k/cdkd/issues/2438): every string
 * `cdkd events` renders on its HUMAN path comes back out of a durable store
 * (`deployments/{runId}.jsonl` and `deployments/index.json`), and several of
 * those fields are provider- or template-authored — a logical id, a resource
 * type, a `reason` that interpolates a user-chosen physical name, an AWS error
 * message. `JSON.stringify` escapes control bytes on the way IN, so the store
 * is well-formed, but the reader is a plain `JSON.parse` that restores the
 * original bytes verbatim. Without a sanitising pass here an ESC-bracket
 * sequence stored in any of them re-forges the terminal of the one command
 * whose entire purpose is to be BELIEVED after a run.
 *
 * Three helpers rather than one, because the field classes have different
 * correct answers:
 *
 * - {@link safeId} is for values with a KNOWN ASCII charset (a run id, a
 *   logical id, a CFn resource type, a region, an event type, a version
 *   string). `asciiOnly` is a positive allowlist and therefore has no residual
 *   at all — the right fence when nothing legitimate is lost.
 * - {@link safeText} is for free PROSE (`reason`, `error.name`,
 *   `error.message`). A legitimate AWS error message may carry non-ASCII, and
 *   `asciiOnly` would mangle it — so prose gets the control-character denylist,
 *   accepting `display-safe.ts`'s documented residual.
 *
 * The wrap goes around the VALUE, never around the colorized token: sanitising
 * `red(x)` would strip cdkd's OWN ANSI and leave the row uncolored.
 */
const safeId = (value: unknown): string => displaySafe(value, { asciiOnly: true });

/** Free-prose counterpart of {@link safeId}. See that helper's block comment. */
const safeText = (value: unknown): string => displaySafe(value);

/**
 * Numeric counterpart of {@link safeId}, for the stored COUNTER fields.
 *
 * Their declared `number` type is the WRITER's guarantee; the value rendered
 * here came back through `JSON.parse` and can be any JSON scalar. Sanitising
 * would be the wrong tool — it would still render the forged text, merely
 * stripped — so a value that is not a number is not renderable as one and
 * becomes `?`. Mirrors the pre-existing `typeof e.durationMs === 'number'`
 * guard, which is why that one line needed no change.
 */
const safeCount = (value: unknown): string => (typeof value === 'number' ? String(value) : '?');

/**
 * Options accepted by `cdkd events`. `stateBucket` / `statePrefix` /
 * `region` / `profile` / `verbose` come from the shared option blocks
 * (`commonOptions` + `stateOptions` + the deprecated region option).
 */
interface EventsCommandOptions {
  stateBucket?: string;
  statePrefix?: string;
  region?: string;
  profile?: string;
  verbose?: boolean;
  json?: boolean;
  /** Read a single run's full event stream instead of the run listing. */
  run?: string;
  /** Disambiguate a stack with deployment-event history in >1 region. */
  stackRegion?: string;
}

/**
 * `cdkd events <stack>` — read back the structured deployment events
 * (issue #808) cdkd persists per deploy / destroy run, the local
 * equivalent of CloudFormation's `DescribeStackEvents`.
 *
 * Two modes:
 *   - No `--run`: list the recorded runs for the stack, newest first
 *     (runId, command, cdkd version, result, started/finished, event count).
 *   - `--run <id>`: print the full ordered event stream for that one run.
 *
 * `--format json` (alias `--json`) emits machine-readable JSON for tooling
 * / AI-agent hand-off. Events survive `cdkd destroy` (they live under a
 * separate `deployments/` key family from `state.json`), so a destroyed
 * stack's failure history stays readable.
 */
export async function eventsCommand(
  stackName: string,
  options: EventsCommandOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  const asJson = options.json === true;
  // Issue #2280: claim stdout for the payload BEFORE anything can print on
  // it — `--json --verbose` otherwise mixes debug prose from the state
  // backend's `child()` loggers into the payload stream, and those modules
  // are not reachable from this file (the reservation is module-level for
  // exactly that reason).
  if (asJson) {
    reserveStdoutForPayload();
  }

  warnIfDeprecatedRegion(options);
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const region = namedCliRegion(options.region) ?? 'us-east-1';
    const bucket = await resolveStateBucketWithDefault(options.stateBucket, region);
    const prefix = options.statePrefix ?? 'cdkd';
    const stateBackend = new S3StateBackend(
      awsClients.s3,
      { bucket, prefix },
      {
        region,
        ...(options.profile && { profile: options.profile }),
      }
    );
    await stateBackend.verifyBucketExists();

    const reader = new DeploymentEventsReader(stateBackend);

    // Resolve the region holding this stack's deployment-event history.
    // Region discovery is derived from the raw key listing (not state.json)
    // so a destroyed stack's events are still discoverable.
    const targetRegion = await resolveEventsRegion(reader, stackName, options.stackRegion);

    if (options.run) {
      const events = await reader.readRunEvents(stackName, targetRegion, options.run);
      if (events === null) {
        throw new CdkdError(
          `No deployment-event stream found for run '${safeId(options.run) || UNRENDERABLE}' ` +
            `of stack '${safeId(stackName) || UNRENDERABLE}' ` +
            `in region '${safeId(targetRegion) || UNRENDERABLE}'.`,
          'EVENTS_RUN_NOT_FOUND'
        );
      }
      // Issue #2438: the JSON payload is deliberately NOT routed through
      // `displaySafe`. It is a machine-consumed stream whose whole contract is
      // byte-fidelity with the store — replacing a character inside a value
      // would corrupt what tooling reads back, and the escaping this path DOES
      // need is already `JSON.stringify`'s: it escapes the WHOLE C0 range
      // (U+0000-U+001F), which is where ESC, CR and every other line-forging
      // mechanism lives, so a human `cat`-ing the payload sees the escape
      // spelled out rather than executed. Do NOT restate that as one FORM:
      // the output MIXES two-character short forms (`\b` `\t` `\n` `\f`
      // `\r`) with six-character `\u00XX` for the other 27 (ESC among them),
      // and an earlier revision of this comment named `\u00XX` alone while
      // citing CR as its example — which is exactly the case that takes the
      // short form. This is `QuoteJSONString` in ECMA-262, not a Node
      // implementation detail, so it does not need re-measuring per runtime.
      //
      // Residual, recorded rather than implied away and measured in the same
      // probe: `JSON.stringify` does NOT escape U+007F (DEL), U+0085 (NEL),
      // the C1 range (U+009B is CSI in UTF-8), U+2028 / U+2029, OR the
      // Trojan-Source bidi overrides and isolates U+202A-U+202E /
      // U+2066-U+2069 — the last of which `displaySafe` strips precisely
      // because they visually REORDER a line, so a reader told the residual is
      // "NEL, C1 and the line separators" would not expect a reordered
      // `reason` here. All of them reach a terminal raw. That list is what
      // JSON leaves relative to `displaySafe`'s strip set; `display-safe.ts`'s
      // OWN residual (the invisible formatters U+200B-U+200D / U+FEFF and the
      // bidi MARKS U+200E / U+200F / U+061C) survives on BOTH paths and is
      // documented there rather than restated here. Sanitising would break the
      // payload for its actual consumer, so the answer for a human reading
      // `--json` is a pager or `jq`, not a lossy transform.
      if (asJson) {
        process.stdout.write(JSON.stringify(events, null, 2) + '\n');
        return;
      }
      printRunEvents(stackName, targetRegion, options.run, events);
      return;
    }

    const runs = await reader.listRuns(stackName, targetRegion);
    // Issue #2438: unsanitised on purpose — same reasoning as the `--run`
    // payload above.
    if (asJson) {
      process.stdout.write(
        JSON.stringify({ stackName, region: targetRegion, runs }, null, 2) + '\n'
      );
      return;
    }
    printRunList(stackName, targetRegion, runs);
  } finally {
    awsClients.destroy();
  }
}

/**
 * Pick the region whose `deployments/` key family holds this stack's run
 * history. When `--stack-region` is supplied it is honored verbatim;
 * otherwise the single discovered region is used, and an ambiguous (>1)
 * or missing (0) history surfaces an actionable error.
 */
async function resolveEventsRegion(
  reader: DeploymentEventsReader,
  stackName: string,
  explicitRegion?: string
): Promise<string> {
  if (explicitRegion) return explicitRegion;
  const regions = await reader.listRegions(stackName);
  if (regions.length === 0) {
    throw new CdkdError(
      `No deployment-event history found for stack '${safeId(stackName) || UNRENDERABLE}'. ` +
        `Events are recorded by 'cdkd deploy' / 'cdkd destroy' (issue #808); ` +
        `a stack deployed by an older cdkd version has none.`,
      'EVENTS_NOT_FOUND'
    );
  }
  if (regions.length > 1) {
    // Issue #2438: `regions` is derived from a raw S3 key listing, so each
    // entry is stored text rather than a value cdkd chose at this call.
    throw new CdkdError(
      `Stack '${safeId(stackName) || UNRENDERABLE}' has deployment-event history in ` +
        `multiple regions: ${regions.map((r) => safeId(r) || UNRENDERABLE).join(', ')}. ` +
        `Re-run with '--stack-region <region>' to disambiguate.`,
      'EVENTS_REGION_AMBIGUOUS'
    );
  }
  return regions[0]!;
}

/**
 * Options accepted by `cdkd events prune`. Inherits the same state-bucket /
 * region / profile blocks as `cdkd events`; adds the retention knobs.
 */
interface EventsPruneCommandOptions {
  stateBucket?: string;
  statePrefix?: string;
  region?: string;
  profile?: string;
  verbose?: boolean;
  stackRegion?: string;
  /** Retain only the newest N runs. */
  keep?: number;
  /** Delete runs older than this duration; units are s/m/h (e.g. 24h, 90m). */
  olderThan?: string;
  /** Delete EVERY recorded run + the index. */
  all?: boolean;
  /** Skip the interactive confirmation. */
  yes?: boolean;
}

/**
 * `cdkd events prune <stack>` — reclaim S3 space by deleting old per-run
 * `{runId}.jsonl` event streams (issue #885). `cdkd destroy` deliberately
 * keeps event history as post-mortem context, so this is the explicit way
 * to purge it; the deploy/destroy writer also self-bounds to the last
 * {@link DEPLOYMENT_EVENTS_MAX_INDEX_RUNS} runs automatically.
 *
 * Retention selection:
 *   - `--all`              purge every run + the index.
 *   - `--keep <N>`         retain the newest N runs.
 *   - `--older-than <dur>` delete runs older than the duration.
 *   - both keep+older-than: delete runs that are BOTH beyond newest-N AND
 *                           older than the cutoff.
 *   - none of the above:   default to keeping the newest
 *                          {@link DEPLOYMENT_EVENTS_MAX_INDEX_RUNS}.
 */
export async function eventsPruneCommand(
  stackName: string,
  options: EventsPruneCommandOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }
  warnIfDeprecatedRegion(options);
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);

  if (options.all === true && (options.keep !== undefined || options.olderThan !== undefined)) {
    throw new CdkdError(
      "'--all' purges every run and cannot be combined with '--keep' / '--older-than'.",
      'EVENTS_PRUNE_BAD_FLAGS'
    );
  }
  const olderThanMs =
    options.olderThan !== undefined ? parseDuration(options.olderThan) : undefined;

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const region = namedCliRegion(options.region) ?? 'us-east-1';
    const bucket = await resolveStateBucketWithDefault(options.stateBucket, region);
    const prefix = options.statePrefix ?? 'cdkd';
    const stateBackend = new S3StateBackend(
      awsClients.s3,
      { bucket, prefix },
      {
        region,
        ...(options.profile && { profile: options.profile }),
      }
    );
    await stateBackend.verifyBucketExists();

    const reader = new DeploymentEventsReader(stateBackend);
    const targetRegion = await resolveEventsRegion(reader, stackName, options.stackRegion);
    // Issue #2438: `targetRegion` is discovered from a raw S3 key listing, so
    // it is stored text like every field the reader renders. Sanitised once
    // here, alongside the stack name, and used by all four lines below —
    // leaving one of the two functions in this file unsanitised is exactly the
    // per-site drift `display-safe.ts`'s header was written against.
    const safeStack = safeId(stackName) || UNRENDERABLE;
    const safeRegion = safeId(targetRegion) || UNRENDERABLE;

    // Preview what would be deleted before touching anything.
    const runs = await reader.listRuns(stackName, targetRegion);
    const totalRuns = runs.length;
    const scope = options.all
      ? `ALL ${totalRuns} run(s)`
      : options.keep !== undefined && olderThanMs !== undefined
        ? // No `|| UNRENDERABLE` on either `olderThan` arm, and that is a
          // CROSS-FILE invariant worth naming rather than reading as drift:
          // `parseDuration` has already accepted this string against
          // `^\d+(\.\d+)?[smh]$`, so every surviving character is printable
          // ASCII and `safeId` is the identity here modulo `.trim()`.
          `runs beyond the newest ${options.keep} AND older than ${safeId(options.olderThan)}`
        : options.keep !== undefined
          ? `runs beyond the newest ${options.keep}`
          : olderThanMs !== undefined
            ? `runs older than ${safeId(options.olderThan)}`
            : `runs beyond the newest ${DEPLOYMENT_EVENTS_MAX_INDEX_RUNS}`;

    if (options.yes !== true) {
      // Issue #2454: this used to guard the prompt HERE, with its own `isTTY`
      // check that logged a refusal and RETURNED — so a non-interactive run
      // exited 0, and a CI job could not tell "cdkd refused" from "cdkd pruned
      // nothing". It now goes through the same `confirmOrRefuse` as the nine
      // prompts issue #2275 folded, which throws `NON_INTERACTIVE_CONFIRM` and
      // exits 1. That also removes the TENTH copy of the byte-identical
      // helper this file still carried — the duplication that let #2259's fix
      // miss nine sites in the first place.
      const ok = await confirmPrompt(
        `Prune deployment-event history for ${cyan(safeStack)} ${gray(`(${safeRegion})`)}: ${scope}?`
      );
      if (!ok) {
        logger.info(gray('Aborted; nothing was deleted.'));
        return;
      }
    }

    const result = await reader.pruneRuns(stackName, targetRegion, {
      ...(options.all === true && { all: true }),
      ...(options.keep !== undefined && { keep: options.keep }),
      ...(olderThanMs !== undefined && { olderThanMs }),
    });

    if (result.deletedRunIds.length === 0) {
      logger.info(
        gray(
          result.indexDeleted
            ? `Removed the empty deployment-event index for ${safeStack} (${safeRegion}); no run streams to delete.`
            : `No runs matched the prune criteria for ${safeStack} (${safeRegion}).`
        )
      );
      return;
    }
    logger.info(
      `${green('Pruned')} ${result.deletedRunIds.length} deployment-event run(s) for ` +
        `${cyan(safeStack)} ${gray(`(${safeRegion})`)}; ` +
        `${result.remainingRunIds.length} retained` +
        (result.indexDeleted ? gray(' (index removed)') : '') +
        '.'
    );
  } finally {
    awsClients.destroy();
  }
}

/**
 * Minimal `(y/N)` prune confirmation, delegating to the shared guarded helper.
 *
 * Exported for unit testing, matching the nine siblings issue #2275 folded —
 * `tests/unit/cli/non-interactive-confirm-guards.test.ts` drives each command's
 * wrapper directly, which is how the refusal wording and the never-settling
 * hang fence are checked per site.
 */
export async function confirmPrompt(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The cdkd events prune confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass -y / --yes to confirm the prune, or run the command from a ' +
      'real terminal. Nothing has been deleted.',
  });
}

/**
 * Human-readable run listing (newest first).
 *
 * Issue #2438: every `run.*` field here comes back out of
 * `deployments/index.json` via a plain `JSON.parse`, so its declared type is a
 * claim about the writer, not about the bytes on disk — each one goes through
 * {@link safeId}. `result` is sanitised BEFORE the colour decision so the
 * colour matches the text the user actually sees.
 */
function printRunList(stackName: string, region: string, runs: DeploymentRunSummary[]): void {
  const logger = getLogger();
  const safeStack = safeId(stackName) || UNRENDERABLE;
  logger.info(
    `${bold('Deployment runs for')} ${cyan(safeStack)} ${gray(`(${safeId(region) || UNRENDERABLE})`)}`
  );
  if (runs.length === 0) {
    logger.info(gray('  (no runs recorded)'));
    return;
  }
  for (const run of runs) {
    const result = safeId(run.result) || UNRENDERABLE;
    const resultColored =
      result === 'SUCCEEDED'
        ? green(result)
        : // `UNRENDERABLE` joins `UNKNOWN` in the neutral arm rather than the
          // red one. `DeploymentRunSummaryResult` says a result that is not
          // definitively known must NOT be fabricated as `FAILED`, and a
          // result cdkd could not RENDER is not one it knows — colouring it
          // like a failure states the thing that type comment forbids.
          result === 'UNKNOWN' || result === UNRENDERABLE
          ? gray(result)
          : red(result);
    logger.info(
      `  ${cyan(safeId(run.runId) || UNRENDERABLE)}  ${safeId(run.command) || UNRENDERABLE}  ` +
        `${resultColored}  ` +
        // These two keep `'?'` for BOTH the absent and the sanitised-away
        // case, deliberately. `summarizeRunFromJsonl` writes `''` here when
        // it rebuilds the run list from the JSONL keys, so absent is the
        // COMMON case, and `'?'` already meant "not shown" on this line. An
        // earlier revision gave them the present-versus-consumed split the
        // error line has; generalising that distinction is what review found
        // re-making a false claim on a new input class every round, so it now
        // lives at exactly one site. Recorded in docs/deployment-events.md.
        `${gray(safeId(run.startedAt) || '?')} -> ${gray(safeId(run.finishedAt) || '?')}  ` +
        `${gray(`cdkd ${safeId(run.cdkdVersion) || UNRENDERABLE}`)}  ` +
        `${gray(`${safeCount(run.eventCount)} events`)}`
    );
  }
  logger.info(gray(`\nUse 'cdkd events ${safeStack} --run <runId>' to read one run's events.`));
}

/** Human-readable single-run event stream (in recorded order). */
/**
 * Render one run's event stream. Exported for unit-test coverage — the
 * `counts.skipped` / `reason` rendering is the whole value of those fields
 * (issue #1752), so it needs a direct fence rather than only `--json` coverage.
 */
export function printRunEvents(
  stackName: string,
  region: string,
  runId: string,
  events: DeploymentEvent[]
): void {
  const logger = getLogger();
  logger.info(
    `${bold('Events for run')} ${cyan(safeId(runId) || UNRENDERABLE)} ` +
      `${gray(`(${safeId(stackName) || UNRENDERABLE}, ${safeId(region) || UNRENDERABLE})`)}`
  );
  if (events.length === 0) {
    logger.info(gray('  (no events)'));
    return;
  }
  for (const e of events) {
    // Issue #2438: every field below is restored by `JSON.parse` from the
    // durable JSONL stream, so each is sanitised at the point of render.
    // `UNRENDERABLE` stands in where the original was truthy but sanitising
    // left nothing — an empty column would read as "cdkd recorded no id",
    // which is a different (and false) statement.
    const parts: string[] = [
      gray(safeId(e.timestamp) || UNRENDERABLE),
      colorizeEventType(e.eventType),
    ];
    if (e.logicalId) {
      const logicalId = safeId(e.logicalId) || UNRENDERABLE;
      const resourceType = e.resourceType ? ` (${safeId(e.resourceType) || UNRENDERABLE})` : '';
      parts.push(`${logicalId}${resourceType}`);
    }
    if (e.operation) parts.push(gray(safeId(e.operation) || UNRENDERABLE));
    // Issue #2301: WHICH guard could not answer. On its own column rather than
    // folded into the reason line below, because it is the stable
    // machine-readable half — a reader grepping their event history for one
    // guard is grepping this, while `reason` is prose that varies per cause.
    if (e.guard) parts.push(gray(`guard=${safeId(e.guard) || UNRENDERABLE}`));
    if (e.provisionedBy) parts.push(gray(`[${safeId(e.provisionedBy) || UNRENDERABLE}]`));
    if (e.command) parts.push(gray(safeId(e.command) || UNRENDERABLE));
    if (e.region) parts.push(gray(safeId(e.region) || UNRENDERABLE));
    if (e.cdkdVersion) parts.push(gray(`cdkd ${safeId(e.cdkdVersion) || UNRENDERABLE}`));
    if (e.result) {
      // Sanitise BEFORE the colour decision, so the colour describes the text
      // that is actually printed — and give `UNRENDERABLE` the neutral arm for
      // the same reason `printRunList` does (see the comment there): a result
      // cdkd could not RENDER is not a result it knows, and red asserts a
      // failure. The two views show the SAME field, so a value reading gray in
      // the run listing and red one screen later would be the renderer
      // disagreeing with itself.
      const result = safeId(e.result) || UNRENDERABLE;
      parts.push(
        result === 'SUCCEEDED'
          ? green(result)
          : result === UNRENDERABLE
            ? gray(result)
            : red(result)
      );
    }
    if (typeof e.durationMs === 'number') parts.push(gray(`${e.durationMs}ms`));
    if (e.counts) {
      // Issue #2438: counters go through `safeCount`, not `safeId` — see that
      // helper.
      parts.push(
        gray(
          `+${safeCount(e.counts.created)}/~${safeCount(e.counts.updated)}/-${safeCount(e.counts.deleted)}` +
            (e.counts.failed ? ` !${safeCount(e.counts.failed)}` : '') +
            // Issue #1752: without this a skip-only destroy renders
            // `RUN_FINISHED FAILED +0/~0/-2` — a failed run naming nothing that
            // failed, which is the exact symptom `counts.skipped` exists to
            // remove. `⚠` matches the glyph the destroy status line uses.
            (e.counts.skipped ? ` ⚠${safeCount(e.counts.skipped)}` : '')
        )
      );
    }
    logger.info(`  ${parts.join('  ')}`);
    // Issue #1752: a RESOURCE_SKIPPED event's whole value is WHY cdkd could not
    // address the resource. Rendered on its own line, mirroring the error block
    // below, because the reason is a sentence rather than a column.
    //
    // Issue #2301 shares this line for `RESOURCE_GUARD_INDETERMINATE`, whose
    // `reason` is likewise the whole value of the row: the OUTCOME (cdkd
    // proceeded) is already carried by the event type, so the only thing left
    // to say is why the guard could not answer. Keyed off the FIELD, not off a
    // type list, so a third `reason`-bearing type renders without an edit here.
    if (e.reason) {
      // `safeText`, not `safeId`: provider prose may legitimately carry
      // non-ASCII, and the positive allowlist would mangle it.
      logger.info(`      ${yellow(safeText(e.reason) || UNRENDERABLE)}`);
    }
    if (e.error) {
      const code = e.error.awsErrorCode ? ` (${safeId(e.error.awsErrorCode) || UNRENDERABLE})` : '';
      const reqId = e.error.requestId
        ? gray(` requestId=${safeId(e.error.requestId) || UNRENDERABLE}`)
        : '';
      const name = safeText(e.error.name) || UNRENDERABLE;
      // `e.error.message` is the ONE field here that is legitimately EMPTY
      // without anyone forging anything: `extractDeploymentEventError` defaults
      // `name` (`err.name || 'Error'`) but copies `message` verbatim, so the
      // commonest possible error — a bare `new Error()` — stores `''`. Every
      // other field on this line needs store-write access to be blank, and at
      // that point the whole record is forged anyway.
      //
      // So this site alone distinguishes the two empties, and it does it the
      // way the rest of the file already does: a guard on the RAW value. An
      // earlier revision generalised this into a presence-tracking helper
      // applied across the renderer, and review found it re-made the same
      // false claim on a different input class each round — `<unrenderable>`
      // is a statement about the INPUT, and the cheapest correct way to make
      // it is to ask whether there WAS an input, once, where it matters.
      const message = e.error.message ? `: ${safeText(e.error.message) || UNRENDERABLE}` : '';
      logger.info(`      ${red(`${name}${code}${message}`)}${reqId}`);
    }
  }
}

/**
 * Color the event-type token by its lifecycle phase.
 *
 * Exported for unit-test coverage (matching `destroy-runner.ts`'s
 * `PROTECTION_PROPERTY_BY_TYPE` convention) — it is pure, so testing it
 * directly beats driving it through the renderer's log output.
 *
 * Issue #2438: the declared union is what the WRITER emits; the value handed
 * here was restored by `JSON.parse` from the stored stream and is therefore
 * arbitrary text. It is sanitised once, up front, and every arm below both
 * classifies AND colorizes the sanitised token — classifying the raw value
 * while printing the sanitised one would let the two disagree. The token is
 * a known-ASCII discriminator, so `safeId`'s positive allowlist loses nothing.
 */
export function colorizeEventType(eventType: DeploymentEvent['eventType']): string {
  const token = safeId(eventType) || UNRENDERABLE;
  if (token.endsWith('FAILED')) return red(token);
  if (token.endsWith('SUCCEEDED') || token === 'RUN_FINISHED') return green(token);
  // Issue #1752: a SKIPPED resource is one cdkd could not address, so it may
  // still be alive — yellow, not the neutral cyan the default arm gives every
  // informational token. Deliberately NOT extended to `RESOURCE_RETAINED`,
  // which is the opposite case: keeping that resource is what the user ASKED
  // for via `DeletionPolicy: Retain`, so it stays informational.
  if (token === 'RESOURCE_SKIPPED') return yellow(token);
  // Issue #2301: a suppressed pre-flight guard is a WARNING, for the same
  // reason as the line above — cdkd proceeded without the protection, so the
  // outcome is unconfirmed rather than merely informational. Without this arm
  // it would fall to the default `cyan` (it ends in neither `FAILED` nor
  // `SUCCEEDED`), reading exactly like a routine lifecycle token.
  if (token === 'RESOURCE_GUARD_INDETERMINATE') return yellow(token);
  if (token.startsWith('ROLLBACK')) return yellow(token);
  return cyan(token);
}

/**
 * Create the `cdkd events` command.
 */
export function createEventsCommand(): Command {
  const cmd = new Command('events')
    .description(
      "Read back structured deployment events (cdkd's DescribeStackEvents equivalent, issue #808)"
    )
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .option('--run <runId>', "Read a single run's full event stream instead of the run listing")
    .option(
      '--stack-region <region>',
      'Disambiguate a stack with event history in multiple regions',
      parseStackRegion
    )
    .option('--json', 'Output as JSON', false)
    .option('--format <format>', "Output format ('json' is equivalent to --json)")
    .action(
      withErrorHandling((stack: string, options: EventsCommandOptions & { format?: string }) => {
        // `--format json` is the issue's spelling; map it onto the boolean.
        const merged: EventsCommandOptions = {
          ...options,
          json: options.json === true || options.format === 'json',
        };
        return eventsCommand(stack, merged);
      })
    );

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);

  cmd.addCommand(createEventsPruneCommand());

  return cmd;
}

/**
 * Create the `cdkd events prune <stack>` subcommand (issue #885).
 *
 * Only the prune-SPECIFIC options (`--keep` / `--older-than` / `--all`) are
 * declared here. The shared option blocks (`commonOptions` + `stateOptions`
 * + the deprecated region option) and `--stack-region` are inherited from
 * the parent `events` command — declaring the same flag on BOTH parent and
 * child makes Commander route a post-subcommand flag (`events prune X --yes`)
 * to the PARENT's storage, leaving the child's value at its default. The
 * action therefore reads the merged view via `command.optsWithGlobals()`.
 */
export function createEventsPruneCommand(): Command {
  const cmd = new Command('prune')
    .description('Delete old per-run deployment-event streams to reclaim S3 space')
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .addOption(
      new Option('--keep <N>', 'Retain only the newest N runs').argParser((v) => {
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`Invalid --keep value "${safeId(v)}": expected a non-negative integer.`);
        }
        return n;
      })
    )
    .option('--older-than <duration>', 'Delete runs older than this duration (e.g. 24h, 90m)')
    .option('--all', 'Delete every recorded run and the index (full purge)', false)
    .action(
      withErrorHandling((stack: string, _options: unknown, command: Command) =>
        eventsPruneCommand(stack, command.optsWithGlobals() as EventsPruneCommandOptions)
      )
    );

  return cmd;
}
