import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger, reserveStdoutForPayload } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption } from '../region-options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { resolveApp } from '../config-loader.js';
import { matchStacks, renderNoStackMatch } from '../stack-matcher.js';
import { toYaml } from '../../utils/yaml.js';
import { displaySafe } from '../../utils/display-safe.js';

/**
 * Long-form stack record matching CDK CLI's `cdk list --long` shape.
 *
 * See aws-cdk-cli/packages/aws-cdk/lib/cli/cdk-toolkit.ts (`list` method).
 */
interface LongStackRecord {
  id: string;
  name: string;
  environment: {
    account: string;
    region: string;
  };
  dependencies?: string[];
}

/**
 * Compact dependency record used when only `--show-dependencies` is set
 * (without `--long`).
 */
interface DependencyRecord {
  id: string;
  dependencies: string[];
}

/**
 * Sort stacks in dependency (topological) order so a stack always appears
 * AFTER the stacks it depends on. Falls back to discovery order on cycles
 * (which the synthesizer would have rejected anyway).
 */
function sortByDependency(stacks: StackInfo[]): StackInfo[] {
  const byName = new Map(stacks.map((s) => [s.stackName, s]));
  const visited = new Set<string>();
  const result: StackInfo[] = [];

  const visit = (stack: StackInfo, ancestors: Set<string>): void => {
    if (visited.has(stack.stackName)) return;
    if (ancestors.has(stack.stackName)) return; // cycle guard
    ancestors.add(stack.stackName);
    for (const depName of stack.dependencyNames) {
      const dep = byName.get(depName);
      if (dep) visit(dep, ancestors);
    }
    ancestors.delete(stack.stackName);
    if (!visited.has(stack.stackName)) {
      visited.add(stack.stackName);
      result.push(stack);
    }
  };

  for (const stack of stacks) {
    visit(stack, new Set());
  }

  return result;
}

/**
 * Convert a StackInfo to its `--long` JSON representation.
 *
 * Every field is manifest-derived, so each renders through `displaySafe`
 * ([#3479](https://github.com/go-to-k/cdkd/issues/3479)). **The encoder is not
 * the boundary here** — measured per character rather than assumed: **neither
 * `JSON.stringify` nor `yaml` escapes DEL, the C1 range, `U+2028`/`U+2029` or
 * the bidi overrides.** So a `displayName` carrying `U+009B` reached the
 * terminal as a CSI byte inside what looks like a machine-readable document, on
 * stdout at default verbosity.
 *
 * Stated as the weakest claim that carries the argument, because the stronger
 * one was wrong twice: the two encoders do NOT agree on C0 (`JSON.stringify`
 * escapes all of it; `yaml` escapes NUL, CR and ESC, emits TAB raw and renders a
 * value containing LF as a literal block scalar). That half was never what this
 * rests on.
 *
 * Fidelity costs nothing: `displaySafe` neither quotes nor truncates, so every
 * legitimate name, account, region and dependency name is byte-identical, and
 * the only values it changes are ones no assembly should produce.
 *
 * One residual this does NOT close, recorded rather than implied away: a value
 * with nothing renderable left sanitizes to the EMPTY string, so a control-only
 * `displayName` emits `id: ""` here and a BLANK line in the default mode — which
 * reads as absent rather than as unrenderable. `UNRENDERABLE` is the repo's
 * answer for a field slot, and picking between them per slot is the open
 * "Helper choice, not only helper presence" row on
 * [#3479](https://github.com/go-to-k/cdkd/issues/3479), which covers the same
 * question for `assembly-reader.ts`. Deciding it here alone would leave the two
 * disagreeing.
 *
 * THE RESIDUAL THAT MATTERS HERE IS A COLLISION, not the empty string. This is
 * a MACHINE-READABLE payload, and sanitizing is many-to-one: `Prod<U+0085>Stack`
 * and a genuine `Prod Stack` both emit `name: "Prod Stack"`, and so do `Prod`
 * and `Prod ` (the trim). Pre-PR their bytes differed. So
 * `jq 'select(.name=="Prod Stack") | .environment.account'` can return TWO
 * accounts for what reads as one stack, and a script taking the first may take
 * the planted one. It fails safe for SELECTION — `matchStacks` matches the RAW
 * name, so `cdkd deploy` still resolves to the genuine stack and never the
 * planted one — which is why this is recorded rather than blocking, and why
 * `UNRENDERABLE`-vs-empty-vs-collision is one question rather than three. It is
 * folded into the open "Helper choice, not only helper presence" row on
 * [#3479](https://github.com/go-to-k/cdkd/issues/3479).
 */
function toLongRecord(stack: StackInfo, includeDeps: boolean): LongStackRecord {
  const record: LongStackRecord = {
    id: displaySafe(stack.displayName),
    name: displaySafe(stack.stackName),
    environment: {
      // `asciiOnly` on both: an AWS account id and a region have a KNOWN ASCII
      // charset, and `display-safe.ts`'s header asks such a caller for the
      // positive allowlist, which is the only mode with no
      // invisible-formatter residual. Measured: plain `displaySafe` keeps a
      // zero-width space planted inside a region name; `asciiOnly` does not.
      account: displaySafe(stack.account ?? 'unknown-account', { asciiOnly: true }),
      region: displaySafe(stack.region ?? 'unknown-region', { asciiOnly: true }),
    },
  };
  if (includeDeps) {
    record.dependencies = stack.dependencyNames.map((name) => displaySafe(name));
  }
  return record;
}

/**
 * List command implementation
 */
async function listCommand(
  patterns: string[],
  options: {
    app?: string;
    output: string;
    verbose: boolean;
    region?: string;
    profile?: string;
    roleArn?: string;
    context?: string[];
    long: boolean;
    showDependencies: boolean;
    json: boolean;
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Claim stdout for the payload BEFORE anything can print on it. The worst
  // offender needs no flags at all: `app-executor.ts` re-emits the CDK app's
  // stderr (bundling progress, warnings) at INFO on a DEFAULT run, so
  // `cdkd list` corrupts whenever the app writes to stderr. Lines are MOVED
  // to stderr, not suppressed (the `diff.ts` level-demotion alternative):
  // bundling warnings are still information an operator wants to see.
  //
  // UNCONDITIONAL since issue #2410, where issue #2280 keyed this on
  // `options.json`. EVERY `cdkd list` mode writes a machine-consumable
  // document to stdout, not just the `--json` spellings: `--long` /
  // `--show-dependencies` emit YAML through `emitStructured`, and the default
  // mode emits one display id per line — the shape a shell loop reads. The
  // `--json` flag selects the payload's ENCODING; it was never what made
  // stdout a payload stream, so keying the reservation on it left the other
  // three modes corruptible by exactly the chatter the comment above
  // describes.
  reserveStdoutForPayload();

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }

  logger.debug('Listing stacks...');
  logger.debug('App command:', app);

  // Synthesize CDK app
  const synthesizer = new Synthesizer();
  const context = parseContextOptions(options.context);
  const synthOptions: SynthesisOptions = {
    app,
    output: options.output,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
    // Issue #1150: listing needs only names / display paths /
    // dependency edges from the manifest — never expanded templates —
    // so a macro app lists without an AWS region or CloudFormation
    // access.
    deferMacroExpansion: true,
  };

  const result = await synthesizer.synthesize(synthOptions);
  const allStacks = result.stacks;

  if (allStacks.length === 0) {
    // A Stage that failed to load dropped every stack under it, and an app
    // whose only stacks live in that Stage lists as empty (issue
    // go-to-k/cdkd#3482). Same renderer as the no-match case below, which
    // picks the empty-assembly wording from `allStacks` being empty.
    throw new Error(renderNoStackMatch(patterns, allStacks, result));
  }

  // Filter by patterns if provided. Patterns match against displayName (when
  // they contain '/') or stackName (otherwise) — same routing rules as
  // deploy / diff / destroy (see src/cli/stack-matcher.ts).
  const selected = patterns.length > 0 ? matchStacks(allStacks, patterns) : allStacks;

  if (selected.length === 0) {
    throw new Error(renderNoStackMatch(patterns, allStacks, result));
  }

  // Sort by dependency order so output is deterministic and a stack never
  // precedes a stack it depends on.
  const sorted = sortByDependency(selected);

  // Output mode selection (mirrors CDK CLI):
  // - --long → full record per stack (id, name, environment, [dependencies])
  // - --show-dependencies (without --long) → {id, dependencies} per stack
  // - default → CDK-style display id, one per line
  // - --json switches the structured outputs to JSON instead of YAML.
  if (options.long) {
    const records = sorted.map((s) => toLongRecord(s, options.showDependencies));
    emitStructured(records, options.json);
    return;
  }

  if (options.showDependencies) {
    const records: DependencyRecord[] = sorted.map((s) => ({
      id: formatDisplayId(s),
      dependencies: s.dependencyNames.map((name) => displaySafe(name)),
    }));
    emitStructured(records, options.json);
    return;
  }

  for (const stack of sorted) {
    process.stdout.write(`${formatDisplayId(stack)}\n`);
  }
}

/**
 * Render a stack as it appears in default `cdkd list` output, matching CDK
 * CLI's "display id" format.
 *
 * If the hierarchical display path differs from the physical CloudFormation
 * stack name (e.g. for a stack inside a CDK Stage), append the physical name
 * in parens: `MyStage/MyStack (MyStage-MyStack)`. Otherwise just the display
 * path. CDK CLI does this in `CloudFormationArtifact.displayName`; see
 * aws-cdk-cli/packages/@aws-cdk/cloud-assembly-api/lib/artifacts/cloudformation-artifact.ts.
 *
 * Both names come from the Cloud Assembly and this is the MOST reachable render
 * of either in cdkd: the default mode writes one of these per line to stdout at
 * default verbosity, no error path involved, so `cdkd list -a ./cdk.out` over
 * someone else's assembly prints it. Hence `displaySafe`
 * ([#3479](https://github.com/go-to-k/cdkd/issues/3479)).
 *
 * `displaySafe`, and deliberately NOT `describeStack` from
 * `src/cli/stack-matcher.ts`, which sanitizes the same two fields for every
 * other command. Two reasons, either of which alone decides it:
 *
 * - `describeStack` renders `<stackName> (<displayName>)`; this format is the
 *   other way round, because it is CDK CLI's "display id" and a `cdkd list`
 *   line is fed back to `cdkd deploy`. Routing through the shared helper would
 *   silently swap the two fields in a payload.
 * - `describeStack` uses `displayIdent`, which QUOTES a value that is not a
 *   plain identifier — correct in the prose it serves ("which stack did you
 *   mean"), wrong here: `new Stack(app, 'My Stack')` is legal and would start
 *   printing `"My Stack"` into a stream a shell loop reads.
 *
 * Two residuals, shared with `describeStack` and recorded there too.
 * `displaySafe` TRIMS, so a construct id with a leading or trailing space
 * prints without it and the printed line is then not re-usable verbatim as a
 * pattern. And because sanitizing is MANY-TO-ONE, two distinct manifest entries
 * can print one identical line here — `MyStage/<U+0085>Api` and a genuine
 * `MyStage/ Api` both emit `MyStage/ Api`, so a `sort -u` over this stream
 * collapses them and a per-line consumer sees one stack where the assembly
 * declared two. `matchStacks` matches the RAW name, so SELECTION is unaffected
 * and a pasted line still resolves to the genuine stack; the collision is
 * recorded at `toLongRecord` and folded into the open helper-choice row on
 * [#3479](https://github.com/go-to-k/cdkd/issues/3479).
 */
function formatDisplayId(stack: StackInfo): string {
  const displayName = displaySafe(stack.displayName);
  // The "are these two fields the same?" test stays on the RAW values. Comparing
  // the sanitized forms would collapse two names that genuinely differ in the
  // manifest into one printed name, hiding the difference instead of showing it.
  return stack.displayName === stack.stackName
    ? displayName
    : `${displayName} (${displaySafe(stack.stackName)})`;
}

/**
 * Emit a structured payload as either YAML (default, CDK CLI parity) or
 * JSON. Routed via stdout so `cdkd list` output is pipeable.
 */
function emitStructured(payload: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // Issue #2421 decided the leading-newline contract inside `toYaml`: it
  // returns a document starting at column 0, so the `.replace(/^\n/, '')`
  // that used to sit here is gone. `synth.ts` writes the same value verbatim
  // — one serializer, one contract, rather than each consumer patching the
  // output it happened to dislike.
  process.stdout.write(toYaml(payload));
}

/**
 * Create list command
 *
 * Mirrors `cdk list` / `cdk ls` from the AWS CDK CLI. Default output is one
 * stack id (display path) per line; `--long` / `--show-dependencies` switch
 * to a structured YAML payload (or JSON with `--json`).
 */
export function createListCommand(): Command {
  const cmd = new Command('list')
    .alias('ls')
    .description('List all stacks in the CDK app')
    .argument(
      '[stacks...]',
      "Stack name pattern(s). Accepts physical CloudFormation names (e.g. 'MyStage-Api') or CDK display paths (e.g. 'MyStage/Api'). Supports wildcards (e.g. 'MyStage/*')."
    )
    .option('-l, --long', 'Display environment information for each stack', false)
    .option('-d, --show-dependencies', 'Display stack dependency information for each stack', false)
    .option('--json', 'Output as JSON instead of YAML for --long / --show-dependencies', false)
    .action(withErrorHandling(listCommand));

  // Reuse standard options. Note: list doesn't need --state-bucket / --stack
  // / deploy options — it's a pure local synth + render command.
  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for list (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
