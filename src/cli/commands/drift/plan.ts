/**
 * `cdkd drift`: the `--accept` / `--revert` plans and the confirmation prompt.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { confirmOrRefuse } from '../confirm-prompt.js';
import { accountArgs, withheldAccountClause } from '../../../state/malformed-resources-bag.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { isPasteableIdent } from '../../../utils/display-safe.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { refusedBaselineRemedy } from '../refused-baseline-remedy.js';
import { maskSecretsInText } from '../../../deployment/secret-redaction.js';
import { type StackDriftReport, matchOutcome, type DriftedOutcome } from './outcome.js';
import { acceptRefusalReason } from './redaction.js';
import { findRevertPreservedTagKeys, findRevertUnbaselinedAwsKeys } from './revert-merge.js';
import {
  reportResource,
  reportPath,
  displayDriftPath,
  reportPlanChangeLine,
  displayDriftValue,
  reportHeading,
} from './report.js';

/**
 * Where this file's own human-facing text goes.
 *
 * Issue [#2230](https://github.com/go-to-k/cdkd/issues/2230). The plan
 * printers and the confirmation prompt write to `process.stdout` DIRECTLY,
 * so — unlike the `logger.info` lines, which
 * {@link reserveStdoutForPayload} re-routes wholesale — they have to be
 * routed per call site. Under `--json` stdout carries the payload and
 * nothing else, so they move to stderr.
 *
 * MOVED, never dropped. A `--json --accept` run still shows the operator
 * the plan, the prompt and the summary on their terminal; what changes is
 * only which stream a pipe reads. Suppressing them instead would pass a
 * "stdout parses" assertion while losing the information the confirmation
 * is asking about, which is the worse of the two failures.
 *
 * THE TWO MEMBERS BIND AT DIFFERENT TIMES, and the asymmetry is deliberate.
 * `write` is a closure, so `process.stderr.write` is looked up per CALL — a
 * test that swaps the stream method after the sink was built still observes
 * every write. `stream` is the stream OBJECT, captured eagerly, because
 * `readline.createInterface` takes a sink once and holds it for the interface's
 * lifetime; there is no later lookup for a closure to serve. That costs
 * nothing, since swapping a stream's `write` METHOD (what a test does) leaves
 * the captured object identity intact, and replacing `process.stderr` WHOLESALE
 * is not something either the CLI or its tests do. It does mean a test fences
 * `stream` by asserting the IDENTITY handed to `createInterface`, not by
 * capturing bytes.
 */
export interface HumanTextSink {
  /** Write raw text. The caller supplies its own newlines. */
  write(chunk: string): void;
  /** The stream an interactive prompt should be attached to. */
  readonly stream: NodeJS.WritableStream;
}

export function humanTextSink(json: boolean | undefined): HumanTextSink {
  return json
    ? {
        write: (chunk: string): void => {
          process.stderr.write(chunk);
        },
        stream: process.stderr,
      }
    : {
        write: (chunk: string): void => {
          process.stdout.write(chunk);
        },
        stream: process.stdout,
      };
}

/**
 * Print the planned state mutations for `--accept` (no AWS calls). One
 * line per resource per property path, mirroring the human report's
 * +/- diff format but flipped: the value on disk after this command
 * runs is the `+` side.
 *
 * Every record- or readback-derived value goes through the report's row
 * helpers (issue go-to-k/cdkd#3949), as in `writeHumanReport`. Exported for
 * unit testing.
 */
export function printAcceptPlan(reports: StackDriftReport[], out: HumanTextSink): void {
  for (const report of reports) {
    // Issue #2135: the plan asks the same exhaustive question `runAccept` does —
    // a plan that silently omits a variant the real run acts on (or vice versa)
    // is worse than either behaviour alone.
    const drifted = report.outcomes.flatMap((o) =>
      matchOutcome<DriftedOutcome[]>(o, {
        drifted: (d) => [d],
        clean: () => [],
        // Named, not defaulted: there is no state write to plan for a resource
        // whose properties were never compared.
        notCompared: () => [],
        unsupported: () => [],
        skipped: () => [],
        // Refused by name before this runs (`refuseDeletedForRemediation`,
        // go-to-k/cdkd#4283): there is no AWS-current value for a resource
        // AWS reports gone, and nothing here can recreate one.
        deleted: () => [],
      })
    );
    if (drifted.length === 0) continue;
    // BUFFERED so the header can describe what the body actually says (issue
    // #1958). Every change of every drifted resource can be refused, and the
    // header still announced `update cdkd state for <stack>` over a body that is
    // nothing but `SKIPPED` lines — a plan promising a write the real run will
    // not make, which is the one property `acceptRefusalReason` is shared to
    // prevent.
    const lines: string[] = [];
    let plannedWrites = 0;
    for (const o of drifted) {
      // Issue #2944, and the same property issue #1914 established for the
      // per-PATH refusals below: a `--dry-run` that promises a write the real
      // run will refuse is worse than either behaviour alone. `runAccept`
      // declines a resource carrying `observedBaselineRefused` OUTRIGHT, so the
      // plan must not list its paths as `old -> new`. It is asked per RESOURCE
      // rather than folded into `acceptRefusalReason`, which answers per path.
      if (report.state.resources[o.logicalId]?.observedBaselineRefused === true) {
        lines.push(
          `  ~ ${reportResource(o)}\n` +
            `    SKIPPED — a 'cdkd import' run refused this resource's observed-properties ` +
            `baseline; accepting would write a baseline positioned against properties it already ` +
            `found untrustworthy. ` +
            (refusedBaselineRemedy(report.state.resources[o.logicalId]) ??
              `Deploy a change to this resource first.`) +
            `\n`
        );
        continue;
      }
      lines.push(`  ~ ${reportResource(o)}\n`);
      for (const change of o.changes) {
        // Issue #1914: a `--dry-run` that promises a write the real run will
        // refuse is worse than either behaviour alone, so the plan asks the
        // same predicate `runAccept` does.
        const refusal = acceptRefusalReason(change, o.maskedPaths);
        if (refusal !== undefined) {
          lines.push(`    ${reportPath(displayDriftPath(o, change.path))}: SKIPPED — ${refusal}\n`);
          continue;
        }
        plannedWrites++;
        lines.push(
          reportPlanChangeLine(
            displayDriftPath(o, change.path),
            displayDriftValue(o, change.stateValue),
            displayDriftValue(o, change.awsValue)
          )
        );
      }
    }
    // The resources are still LISTED in both cases: the refusal reason on each
    // line is the actionable half, and suppressing the block entirely would
    // leave a user who ran `--accept --dry-run` with no output at all over a
    // stack that really does have drift.
    //
    // "no ACCEPTED VALUES will be written", not "NOTHING will be written"
    // (issue #1958 review). The real run over this same input still takes the
    // lock, bumps `lastModified`, rotates the ETag and rewrites the stored bag
    // through the positioned re-redaction — so a plan promising an untouched
    // `state.json` is the same class of false claim as the summary above it,
    // arriving from the other side. The parenthetical is what keeps the two
    // messages saying one thing.
    out.write(
      plannedWrites === 0
        ? `\nPlan (--accept): no accepted values will be written to cdkd state for ` +
            `${reportHeading(report)} — every drifted change below is refused ` +
            `(the run still writes the positioned re-redaction):\n`
        : `\nPlan (--accept): update cdkd state for ${reportHeading(report)}:\n`
    );
    for (const line of lines) out.write(line);
  }
}

/**
 * The gated `cdkd drift ... --revert` line for a block that also carries
 * untrusted values, or `undefined` when either identifier cannot be named.
 *
 * go-to-k/cdkd#3307's remedy for its sites 2 and 3, closed through
 * go-to-k/cdkd#3436's fold-in and on exactly the derivation site 4 uses.
 *
 * The corrected go-to-k/cdkd#3486 criterion says a rendered block carrying
 * untrusted values carries no pasteable command, and both of these blocks do —
 * a property path and a resource type at one, a state-write error message at
 * the other. What makes the command printable anyway is the rule `main` has
 * for naming a target BESIDE such a block
 * (`.claude/rules/state-malformed-containers.md`, go-to-k/cdkd#3328):
 * exactness keeps a space and a `:`, so an identifier can spell one of the
 * block's own labels and forge it once the terminal wraps, and the answer is
 * `isPasteableIdent` in CONJUNCTION with the command gate, on BOTH
 * identifiers.
 *
 * Withheld means NOT PRINTED rather than printed with a hole: both blocks
 * already display the stack name, so a hole beside it invites the operator to
 * fill it from a name the block shows — the misdirection the criterion
 * forbids. The prose keeps its own `for this stack` wording in that case:
 * it still names the command, as the fixed literal `'cdkd drift --revert'`,
 * but no TARGET, so nothing in it came from the record.
 *
 * `exact` is not consulted: `isPasteableIdent` is strictly stronger on every
 * arm of the gate — it starts at an alphanumeric so is never option-shaped,
 * admits no `*` or `/`, cannot be empty, and its `displayIdent` compare
 * carries both the alteration test and the cap.
 */
function mayNameTarget(stackName: string, region: string): boolean {
  return isPasteableIdent(stackName) && isPasteableIdent(region);
}

/**
 * The gated `cdkd drift ... --revert` line, or `undefined` when
 * {@link mayNameTarget} refuses either identifier.
 */
export function revertCommandLine(stackName: string, region: string): string | undefined {
  if (!mayNameTarget(stackName, region)) return undefined;
  const built = pasteableCommand('cdkd drift', [
    { value: stackName, hole: 'stack' },
    { flag: '--stack-region', value: region, hole: 'region' },
  ]);
  return `${built.command} --revert`;
}

/**
 * Print the planned `provider.update` calls for `--revert` (no AWS calls).
 * One line per resource summarising how many property paths will be
 * overwritten on the AWS side.
 *
 * Printed directly above the confirmation prompt, so every record- or
 * readback-derived value goes through the report's row helpers (issue
 * go-to-k/cdkd#3949): a forged row here misstates what the operator confirms.
 * Exported for unit testing.
 */
export function printRevertPlan(
  reports: StackDriftReport[],
  out: HumanTextSink,
  /**
   * The run's account flags (go-to-k/cdkd#4648), carried on the
   * `cdkd state refresh-observed` command the plan offers: it WRITES, so a
   * pasted one must reach the bucket this run read. A refused value is a hole
   * the line above it explains.
   */
  recovery?: LockRecoveryContext
): void {
  for (const report of reports) {
    // Issue #2135: same exhaustive question `runRevert` asks, for the same
    // reason the accept plan asks it.
    const drifted = report.outcomes.flatMap((o) =>
      matchOutcome<DriftedOutcome[]>(o, {
        drifted: (d) => [d],
        clean: () => [],
        // Named, not defaulted: nothing is pushed back for a resource cdkd
        // could not resolve, and `runRevert` refuses it there too.
        notCompared: () => [],
        unsupported: () => [],
        skipped: () => [],
        // Refused by name before this runs (`refuseDeletedForRemediation`,
        // go-to-k/cdkd#4283): there is no AWS-current value for a resource
        // AWS reports gone, and nothing here can recreate one.
        deleted: () => [],
      })
    );
    if (drifted.length === 0) continue;
    out.write(
      `\nPlan (--revert): push cdkd state values back into AWS for ${reportHeading(report)}:\n`
    );
    for (const o of drifted) {
      // Issue #2944. `runRevert` declines a marked resource before it reaches
      // `provider.update`, so announcing an update here would put a write this
      // run never makes in front of the CONFIRMATION PROMPT — the one place
      // the user decides on what the plan says.
      if (report.state.resources[o.logicalId]?.observedBaselineRefused === true) {
        out.write(
          `  ! ${reportResource(o)}: NOT reverted — a 'cdkd import' run refused ` +
            `this resource's observed-properties baseline, so the only baseline available is ` +
            `the one that refusal already found untrustworthy. ` +
            (refusedBaselineRemedy(report.state.resources[o.logicalId]) ??
              `Deploy a change to this resource first.`) +
            `\n`
        );
        continue;
      }
      const word = o.changes.length === 1 ? 'property path' : 'property paths';
      out.write(
        `  → provider.update on ${reportResource(o)}: revert ${o.changes.length} ${word}\n`
      );
      for (const change of o.changes) {
        out.write(
          reportPlanChangeLine(
            displayDriftPath(o, change.path),
            displayDriftValue(o, change.awsValue),
            displayDriftValue(o, change.stateValue)
          )
        );
      }
      // Issue #1478. Printed as part of the PLAN, not at update time, so it
      // is visible before the confirmation prompt AND under `--dry-run` —
      // a warning the user only sees after the writes have happened is not
      // a warning.
      const stateResource = report.state.resources[o.logicalId];
      // Issue #1501, printed for the same reason: a tag AWS added
      // out-of-band SURVIVES the revert, so say so before the user confirms.
      // Not gated on the observed-capture baseline — the diff semantic
      // applies on both baselines.
      if (stateResource) {
        const preserved = findRevertPreservedTagKeys(
          o.changes,
          stateResource.observedProperties ?? stateResource.properties ?? {},
          o.awsProperties
        );
        // Issue #1914 (minor): these lists are masked with `o.secrets`, which
        // cannot answer for a reference cdkd never resolved — so a
        // secret-carrying key would print unmasked, exactly the case the
        // masking exists for. The offline path seed cannot help either: it
        // locates positions, and masking a KEY needs the VALUE. Suppress the
        // lists instead and say why.
        //
        // Keyed on `notComparedCause` rather than on an empty map: a resource
        // with one resolvable reference and one survivor has a non-empty map
        // that still cannot mask the survivor's position. BOTH causes withhold
        // — the question here is whether the map can name what the position
        // holds, which a refusal and a surviving token answer the same way.
        //
        // Keyed on the carried FACT, not on the single `notComparedCause`: an
        // `uncertifiedBaseline` outranks a surviving token there (issue #3595),
        // while its own map is complete — see `secretsIncomplete`.
        const cannotMaskKeys = o.secretsIncomplete;
        if (cannotMaskKeys && preserved.length > 0) {
          out.write(
            `    ! ${preserved.length} AWS-authored tag(s) will be preserved, but cdkd could not ` +
              `resolve this resource's dynamic reference(s), so their names are withheld — they ` +
              `come from the live readback and cannot be checked for secrets without them.\n`
          );
          // `else if` below, not a second mirrored `if` (issue #1958). The two
          // arms answer ONE question -- can the key names be masked? -- and the
          // unbaselined-value block twenty lines below already spells that
          // decision as `if / else if`. Two shapes for one decision is what
          // makes a reader check whether they can both fire.
        } else if (preserved.length > 0) {
          const tagWord = preserved.length === 1 ? 'tag' : 'tags';
          out.write(
            `    ! reverting this tag list KEEPS ${preserved.length} AWS-authored ` +
              `${tagWord} the baseline does not carry:\n`
          );
          for (const path of preserved) {
            // Issue #1914: these names are built from `o.awsProperties`, the
            // one bag on this path that is deliberately unredacted — so a
            // readback answering with a map KEYED by a secret would print the
            // plaintext here, the exact case `redactDriftChanges` masks for the
            // diff lines. Masked at the point of printing rather than at the
            // point of building, so the callers that use these lists as
            // KEY SETS keep the real keys.
            out.write(
              `        ${reportPath(displayDriftPath(o, maskSecretsInText(path, o.secrets)))}\n`
            );
          }
          // "Every other tag reverts normally" is only true on the
          // observed-capture baseline. Under #1626's raw-TEMPLATE baseline
          // EVERY untemplated tag is preserved, and the block printed just
          // below says so — leaving this sentence unconditional made the plan
          // contradict itself two lines apart.
          const othersRevert =
            stateResource.observedProperties === undefined
              ? ''
              : `Every other tag reverts normally. `;
          out.write(
            `      ${othersRevert}A service may require these ` +
              `(ECS needs AmazonECSManaged for managed scaling); 'aws:'-prefixed keys are ` +
              `AWS-reserved and cannot be removed by hand.\n`
          );
        }
      }
      if (stateResource && stateResource.observedProperties === undefined) {
        const unbaselined = findRevertUnbaselinedAwsKeys(
          o.changes,
          stateResource.properties ?? {},
          o.awsProperties
        );
        if (o.secretsIncomplete && unbaselined.length > 0) {
          // Same withholding as the tag list above, and it must say something:
          // silently skipping the block left the user with no signal at all.
          out.write(
            `    ! ${unbaselined.length} AWS-authored value(s) will be left untouched, but cdkd ` +
              `could not resolve this resource's dynamic reference(s), so their paths are ` +
              `withheld — they come from the live readback and cannot be checked for secrets ` +
              `without them.\n`
          );
        } else if (unbaselined.length > 0) {
          const word = unbaselined.length === 1 ? 'value' : 'values';
          out.write(
            `    ! this resource has no observed-capture baseline, so the revert ` +
              `pushes the raw TEMPLATE and LEAVES ${unbaselined.length} AWS-authored ${word} ` +
              `untouched:\n`
          );
          for (const path of unbaselined) {
            // Masked for the same reason as the preserved-tag list above.
            out.write(
              `        ${reportPath(displayDriftPath(o, maskSecretsInText(path, o.secrets)))}\n`
            );
          }
          // The SENTENCE is gated with its command, not separately. A first
          // cut printed "with the command below" unconditionally, so a
          // withheld target left the reader looking for a line that was never
          // written -- the arm's own test asserted the command's ABSENCE and
          // was satisfied by the contradiction. Review caught it.
          const refresh = mayNameTarget(report.stackName, report.region)
            ? pasteableCommand('cdkd state refresh-observed', [
                { value: report.stackName, hole: 'stack' },
                { flag: '--stack-region', value: report.region, hole: 'region' },
                ...accountArgs(recovery),
              ])
            : undefined;
          const refreshAccountNote =
            refresh === undefined
              ? ''
              : withheldAccountClause(recovery, 'the command below prints').trimEnd();
          out.write(
            `      The template does not declare these, so cdkd cannot tell an AWS-authored ` +
              `value from an out-of-band change and will not reset either. ` +
              (refresh === undefined
                ? `Re-deploy if you want them reverted too; this record's identity cannot be ` +
                  `named safely in a command, so none is offered.\n`
                : `Populate observedProperties with the command below, or re-deploy, if you ` +
                  `want them reverted too.${refreshAccountNote === '' ? '' : ` ${refreshAccountNote}`}\n`)
          );
          // go-to-k/cdkd#3307's `--stack-region` requirement for this site,
          // closed through go-to-k/cdkd#3436's fold-in. The issue's stated
          // harm is that `for this stack` gives the operator neither NAME nor
          // REGION, and a name held in several regions is ambiguous.
          //
          // Naming a target here needs MORE than the command gate, and the
          // rule is `.claude/rules/state-malformed-containers.md`'s
          // (go-to-k/cdkd#3328): exactness keeps a space and a `:`, so an
          // identifier can spell one of this block's own labels and forge it
          // once the terminal wraps. `isPasteableIdent` in CONJUNCTION with the
          // gate is what that rule requires, on BOTH identifiers. Withheld,
          // the command is not printed at all rather than printed with a hole
          // the operator fills from a name this block also displays — which is
          // the misdirection the corrected go-to-k/cdkd#3486 criterion forbids.
          // The SAME predicate the two prose sites use, not a second spelling
          // of it. Three sites deciding "may I name this target" by three
          // hand-built conditions is the defect go-to-k/cdkd#3499 closed one
          // module over; one predicate means one probe can red all three.
          // `refresh !== undefined`, not `refresh.exact === true`: the IDENTITY
          // half of `.exact` is subsumed by `mayNameTarget`, and its other half
          // is the account holes (go-to-k/cdkd#4648), which must not suppress
          // the command -- a refused `--profile` is a hole the note above
          // explains, never a reason to drop the remedy. `isPasteableIdent` requires
          // `^[A-Za-z0-9][A-Za-z0-9~_.-]*$` plus `displayIdent(v) === v`, which
          // is strictly stronger than the command gate on every arm — it starts
          // at an alphanumeric (no option), admits no `*` or `/` (no pattern),
          // cannot be empty, and the `displayIdent` compare carries both the
          // alteration test and the cap. A line that reads as a guard while
          // guarding nothing is the shape go-to-k/cdkd#3436's fence work keeps
          // finding; stating the subsumption is better than keeping a
          // belt-and-braces check nothing can check.
          if (refresh !== undefined) {
            // Six spaces, matching the block's other lines. The labelled
            // line was flush-left while everything around it was indented
            // (go-to-k/cdkd#3613's M3), which reads as belonging to the outer
            // report rather than to this resource's arm.
            out.write(`      Populate with: ${refresh.command}\n`);
          }
        }
      }
    }
  }
}

/**
 * Run a list of zero-arg async tasks with a concurrency cap. Tasks are
 * allowed to throw; failure handling is the caller's responsibility (the
 * revert path catches per-task errors inside the task body).
 */
export async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  const queue = [...tasks];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push(
      (async (): Promise<void> => {
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) break;
          await task();
        }
      })()
    );
  }
  await Promise.all(workers);
}

/**
 * `cdkd drift --accept` / `--revert`'s confirmation prompt: ask the operator to
 * confirm a mutation. Both call sites sit inside an `if (!options.yes)` block,
 * which is what keeps `confirmOrRefuse`'s non-interactive refusal (issue
 * #2275) from firing on a `--yes` run.
 *
 * Issue #2230 is why this site passes an explicit `output`: the prompt is
 * written to `out.stream`, not unconditionally to `process.stdout` — under
 * `--json` that stream carries the payload, and a bare `[y/N] ` spliced into
 * it is the same corruption as a status line, so the sink is `process.stderr`
 * there. The prompt is still SHOWN; only its stream changes. See the
 * `HumanTextSink` doc above for why the STREAM (not a closure) is what gets
 * handed to `createInterface`.
 *
 * Exported for unit testing — internal to the command flow otherwise.
 */
export async function confirmPrompt(prompt: string, out: HumanTextSink): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    output: out.stream,
    refusal:
      'The cdkd drift confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass -y / --yes to confirm, or run the command from a real ' +
      'terminal.',
  });
}
