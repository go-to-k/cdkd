import { markNonRetryable } from '../../deployment/retryable-errors.js';
import {
  type CommandArg,
  pasteableCommand,
  plainOrDescribed,
  quotedOrDescribed,
  withheldTargetClause,
} from '../pasteable-command.js';
import { plainIdentOr } from '../display-safe.js';
import { CdkdError } from './base-errors.js';

/**
 * Dependency resolution errors
 */
export class DependencyError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'DEPENDENCY_ERROR', cause);
    this.name = 'DependencyError';
    Object.setPrototypeOf(this, DependencyError.prototype);
  }
}

/**
 * Configuration errors
 */
export class ConfigError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * Signals a partial-failure outcome that should map to exit code 2 (not 1).
 *
 * Used by `cdkd destroy` and `cdkd state destroy` when one or more
 * per-resource deletes failed but the overall command finished its work
 * (state.json is preserved, the rest of the stack was deleted, and the
 * user can re-run to clean up the remaining resources).
 *
 * Exit code conventions:
 *   - 0: command completed successfully, no resources left in error state.
 *   - 1: command-level failure (auth error, bad arguments, synth crash,
 *        unhandled exception). Default for any thrown error.
 *   - 2: partial failure — work completed but some resources are still in
 *        an error state. Re-running typically resolves it. Documented in
 *        docs/cli-reference.md's "Exit codes" section.
 *
 * `handleError` recognizes this class via `instanceof` and uses its
 * `exitCode` instead of the default 1.
 */
export class PartialFailureError extends CdkdError {
  readonly exitCode: number = 2;

  constructor(message: string, cause?: Error) {
    super(message, 'PARTIAL_FAILURE', cause);
    this.name = 'PartialFailureError';
    Object.setPrototypeOf(this, PartialFailureError.prototype);
  }
}

/**
 * Signals that a provider cannot perform an in-place `update` for a
 * resource type — most commonly because the AWS resource is structurally
 * immutable (`AWS::Lambda::LayerVersion`, `AWS::S3Tables::TableBucket` once
 * created, certain `AWS::EC2::*` sub-resources) or because the provider
 * surfaces a sub-resource attachment whose only mutation pattern is
 * delete + add (Lambda permission statements, IAM policy attachments).
 *
 * Surfaced through `cdkd drift --revert`, which calls
 * `provider.update(logicalId, physicalId, type, stateProps, awsProps)` to
 * push cdkd state values back into AWS for every drifted resource. When a
 * provider throws this error, the drift command collects it as a
 * per-resource outcome distinct from a generic AWS update failure: the
 * fix is to re-deploy with `--replace` (or recreate the resource), not to
 * retry the update.
 *
 * Carries the same `exitCode = 2` as {@link PartialFailureError} so a
 * drift run that hits one immutable resource is reported as partial-
 * success rather than fatal — the rest of the drifted resources still
 * had their `update` invoked, and the user has a clear next step printed
 * for the unsupported one.
 *
 * **Marked non-retryable in the constructor** (issue
 * [#1838](https://github.com/go-to-k/cdkd/issues/1838)). This is a
 * deterministic, cdkd-authored refusal — the deploy engine matches it BY
 * CLASS to choose the `--replace` DELETE+CREATE fallback, and `cdkd drift
 * --revert` reports it as its own per-resource outcome — so it can never
 * succeed on a retry, whatever its message happens to say. That last clause
 * is the whole point: the message interpolates the resource's LOGICAL ID,
 * and the retry classifiers match by SUBSTRING, so a perfectly ordinary
 * composite CDK id like `MyDependencyViolationSub` made
 * `isRetryableTransientError` return true (`DependencyViolation` was then the
 * only whitespace-free entry in `RETRYABLE_ERROR_MESSAGE_PATTERNS`; the
 * name-cooldown error CODES `QueueDeletedRecently` / `StateMachineDeleting`
 * joined it under issue #2116, so the hazard is wider, not narrower) and burned the
 * full generic schedule — 8 retries, ~47s of pure sleep — on a path that was
 * never going to succeed, before the fallback the error exists to trigger was
 * even reached.
 *
 * Marking in the CONSTRUCTOR rather than at each `throw` is deliberate: ~20
 * providers raise this from inside the `update()` call `deploy-engine/update-in-place.ts`
 * wraps in `withRetry` (plus `drift.ts`'s `--revert` update), and a per-site
 * marker is one forgotten call away from re-opening the hole for exactly one
 * provider.
 */
export class ResourceUpdateNotSupportedError extends CdkdError {
  readonly exitCode: number = 2;
  public readonly resourceType: string;
  public readonly logicalId: string;
  /**
   * Human-readable hint printed alongside the error. The default is
   * "use cdkd deploy with --replace, or change the resource definition
   * to create a new version" — providers are encouraged to override
   * with a more specific suggestion when one is available (e.g.
   * Lambda::Permission's "delete + add a new statement").
   */
  public readonly suggestion: string | undefined;

  constructor(resourceType: string, logicalId: string, suggestion?: string, cause?: Error) {
    const tail = suggestion
      ? suggestion
      : 'use cdkd deploy with --replace, or change the resource definition to create a new version';
    super(
      `${resourceType} (${logicalId}) cannot be updated in place: ${tail}.`,
      'RESOURCE_UPDATE_NOT_SUPPORTED',
      cause
    );
    this.resourceType = resourceType;
    this.logicalId = logicalId;
    this.suggestion = suggestion;
    this.name = 'ResourceUpdateNotSupportedError';
    Object.setPrototypeOf(this, ResourceUpdateNotSupportedError.prototype);
    // Terminal by construction — see the class JSDoc. Position relative to
    // `setPrototypeOf` is immaterial (the marker is an OWN property and
    // `setPrototypeOf` mutates in place, touching neither own properties nor
    // extensibility); it sits last only for readability. The return value is
    // ignored on purpose: the helper marks in place and returns the same
    // object, for the inline `throw markNonRetryable(...)` spelling other
    // call sites use.
    markNonRetryable(this);
  }
}

/**
 * Signals a refusal to destroy a stack with `terminationProtection: true`:
 * in its CDK manifest (`cdkd destroy`), or in the state record its last
 * deploy wrote (`cdkd destroy` and `cdkd state destroy`, go-to-k/cdkd#5238).
 *
 * Raised BEFORE any lock acquisition or per-resource delete, and again under
 * the lock (a deploy can turn it on while the prompt waits). In multi-stack
 * runs this counts as a per-stack failure and the rest of the targets
 * continue — the aggregated count is wrapped in {@link PartialFailureError}
 * so the command exits with code 2. `--remove-protection` is the bypass.
 */
export class StackTerminationProtectionError extends CdkdError {
  public readonly stackName: string;

  constructor(
    stackName: string,
    cause?: Error,
    /**
     * The run's account flags (go-to-k/cdkd#4648), as
     * {@link NestedStackChildDirectDestroyError} takes them: built by the
     * caller, since this module cannot import `malformed-resources-bag.ts`.
     */
    account?: { args: readonly CommandArg[]; clause: string },
    /**
     * The refusal of a stack whose RECORD carries the setting (go-to-k/cdkd#5238):
     * its last deploy had it, whatever the CDK code says now. `command` is
     * the destroy to retry with `--remove-protection` (`cdkd state destroy`
     * has no CDK code to edit); `root` the protected root stack when
     * `stackName` is a nested child under it; `stackRegion` the record's
     * region, so the pasted command addresses the same record.
     */
    recorded?: {
      command: 'cdkd destroy' | 'cdkd state destroy';
      root?: string;
      stackRegion?: string;
    }
  ) {
    if (recorded !== undefined) {
      const { command, root, stackRegion } = recorded;
      const bypass = pasteableCommand(command, [
        {
          value: stackName,
          hole: 'stack',
          opts: { plainIdent: true, ...(command === 'cdkd destroy' && { patternMatched: true }) },
        },
        ...(stackRegion !== undefined && command === 'cdkd state destroy'
          ? [
              {
                flag: '--stack-region',
                value: stackRegion,
                hole: 'region',
                opts: { plainIdent: true },
              },
            ]
          : []),
        { literal: '--remove-protection' },
        ...(account?.args ?? []),
      ]);
      super(
        (root === undefined
          ? `Stack ${quotedOrDescribed(stackName, 'stack name')} was last deployed with ` +
            `terminationProtection: true and cannot be destroyed.`
          : `Stack ${quotedOrDescribed(stackName, 'stack name')} is nested under ` +
            `${quotedOrDescribed(root, 'stack name')}, which was last deployed with ` +
            `terminationProtection: true, so it cannot be destroyed.`) +
          (command === 'cdkd destroy'
            ? ` Redeploy it with the protection off, or pass --remove-protection to destroy it anyway;`
            : ` To destroy it anyway, pass --remove-protection;`) +
          ` the flag also turns off the deletion protection of each resource it deletes.` +
          withheldTargetClause(bypass, 'stack', command, "This stack's name") +
          (account?.clause ? ` ${account.clause.trimEnd()}` : '') +
          `\nDestroy it with: ${bypass.command}`,
        'STACK_TERMINATION_PROTECTION',
        cause
      );
      this.stackName = stackName;
      this.name = 'StackTerminationProtectionError';
      Object.setPrototypeOf(this, StackTerminationProtectionError.prototype);
      return;
    }
    // Trailing labelled line, gated value (go-to-k/cdkd#3436): the name comes
    // from a state key or an assembly, and inside the sentence's quotes it
    // pasted as shell. `patternMatched`: `cdkd destroy` resolves its argument
    // through `stack-matcher.ts`, so a record named `Prod*` would select every
    // stack it matches. `plainIdent`, and the same predicate in the prose: a
    // name beside a labelled line is named only when it cannot spell one
    // (go-to-k/cdkd#3759).
    const retry = pasteableCommand('cdkd destroy', [
      { value: stackName, hole: 'stack', opts: { patternMatched: true, plainIdent: true } },
      ...(account?.args ?? []),
    ]);
    super(
      `Stack ${quotedOrDescribed(stackName, 'stack name')} has terminationProtection: true ` +
        `and cannot be destroyed. Set terminationProtection: false in the CDK code, redeploy, ` +
        `then retry the destroy.` +
        withheldTargetClause(retry, 'stack', 'cdkd destroy', "This stack's name") +
        (account?.clause ? ` ${account.clause.trimEnd()}` : '') +
        `\nRetry with: ${retry.command}`,
      'STACK_TERMINATION_PROTECTION',
      cause
    );
    this.stackName = stackName;
    this.name = 'StackTerminationProtectionError';
    Object.setPrototypeOf(this, StackTerminationProtectionError.prototype);
  }
}

/**
 * `cdkd destroy <child>` refused because the named stack is a nested
 * child of another stack. Mirrors CloudFormation's `you can't directly
 * destroy a nested stack` semantic — destroying the child without
 * touching the parent would leave the parent's `AWS::CloudFormation::Stack`
 * record pointing at non-existent resources, and the parent's next
 * deploy would silently try to re-create them.
 *
 * Detected by reading the loaded state's v6 `parentStack` field — only
 * state files written by `NestedStackProvider.create` (or by the
 * recursive `cdkd import --migrate-from-cloudformation` walk) carry
 * this field; top-level stacks have `parentStack: undefined` and pass
 * the guard unchanged.
 *
 * Fires from `cdkd destroy` AFTER state load but BEFORE lock
 * acquisition or any per-resource delete, so the refusal is cheap.
 * Surfaced as a per-stack failure (wrapped in {@link PartialFailureError},
 * exit code 2) in multi-stack runs — siblings continue.
 *
 * Bypass paths (both intentional escape hatches):
 *
 *  1. `cdkd destroy <parent>` — the normal cascading-destroy path; the
 *     parent's reverse-DAG walks into the child via
 *     `NestedStackProvider.delete` and removes both layers atomically.
 *  2. `cdkd state destroy <child>` — the SYNTH-FREE destroy, with no parent
 *     coupling check. It deletes the child's AWS resources and then its
 *     record; "state-only" named the wrong thing, and this message's own text
 *     was corrected away from that reading (go-to-k/cdkd#3499 review nits).
 *     `cdkd state orphan` is the record-only command. The state-driven entry point intentionally
 *     bypasses this guard for the same reason `cdkd state destroy`
 *     bypasses `terminationProtection`: it's the "I know what I'm
 *     doing" path for cleaning up state when synth is unavailable or
 *     the user accepts leaving the parent's reference dangling.
 */
export class NestedStackChildDirectDestroyError extends CdkdError {
  public readonly stackName: string;
  public readonly parentStack: string;
  public readonly parentLogicalId?: string;

  constructor(
    stackName: string,
    parentStack: string,
    parentLogicalId?: string,
    cause?: Error,
    /**
     * The run's account flags (go-to-k/cdkd#4648), built by the caller with
     * `accountArgs` / `withheldAccountClause` from `malformed-resources-bag.ts`
     * (which this module cannot import: it imports `CdkdError` from here).
     * Both commands carry them, so a pasted destroy acts on the bucket this run
     * read; `clause` explains any account hole before the labelled lines.
     */
    account?: { args: readonly CommandArg[]; clause: string }
  ) {
    const accountArgs = account?.args ?? [];
    const logicalIdSuffix = parentLogicalId
      ? ` (parent's logical id: ${plainOrDescribed(parentLogicalId, 'logical id')})`
      : '';
    // Hoisted rather than built inline in the template: this message is quoted
    // in `docs/design/459-nested-stacks.md`, and a template whose holes carry
    // object literals is far harder to read beside that quotation. The
    // docs-parity checker handles either spelling now that it takes its literal
    // parts from the TypeScript parser.
    // `plainIdent` on both commands and the same predicate in the prose: a
    // name beside a labelled line is named only when it cannot spell one
    // (go-to-k/cdkd#3759).
    const cascade = pasteableCommand('cdkd destroy', [
      { value: parentStack, hole: 'parent', opts: { patternMatched: true, plainIdent: true } },
      ...accountArgs,
    ]);
    // `cdkd state destroy` deletes the AWS RESOURCES and then the record — it is
    // the synth-free destroy, not a record-only drop (`state.ts`'s own naming
    // note). `cdkd state orphan` is the record-only one, and is NOT what this
    // message offers.
    // NO `patternMatched` here, unlike the cascade above: `cdkd state destroy`
    // resolves each argument by exact membership (`knownStackNames.has(name)` in
    // `state.ts`), so a pattern is not what it would misread. `plainIdent`
    // withholds any non-plain name all the same — `Prod*` included — and no
    // real stack name is one, so no genuine child loses its command
    // (go-to-k/cdkd#3759).
    const childDestroy = pasteableCommand('cdkd state destroy', [
      { value: stackName, hole: 'stack', opts: { plainIdent: true } },
      ...accountArgs,
    ]);
    // Every hole the message prints is explained BEFORE the labelled lines,
    // which stay last. Hoisted, like the commands, so the template stays
    // short enough for the docs-parity checker to derive (it caps the raw
    // template text).
    const withheld =
      withheldTargetClause(cascade, 'parent', 'cdkd destroy', "The parent stack's name") +
      withheldTargetClause(childDestroy, 'stack', 'cdkd state destroy', "The child stack's name") +
      (account?.clause ? ` ${account.clause.trimEnd()}` : '');
    const child = quotedOrDescribed(stackName, 'stack name');
    const parent = quotedOrDescribed(parentStack, 'stack name');
    super(
      `Stack ${child} is a nested child of ${parent}${logicalIdSuffix}; ` +
        `directly destroying a nested stack is not supported. Either cascade-delete this ` +
        `child along with its parent, or destroy the child on its own — which deletes its ` +
        `AWS resources and its record, and leaves the parent's reference dangling (the ` +
        `synth-free escape hatch).${withheld}` +
        `\nCascade-delete with: ${cascade.command}` +
        `\nDestroy the child alone with: ${childDestroy.command}`,
      'NESTED_STACK_CHILD_DIRECT_DESTROY',
      cause
    );
    this.stackName = stackName;
    this.parentStack = parentStack;
    if (parentLogicalId !== undefined) this.parentLogicalId = parentLogicalId;
    this.name = 'NestedStackChildDirectDestroyError';
    Object.setPrototypeOf(this, NestedStackChildDirectDestroyError.prototype);
  }
}

/**
 * One consumer that still references the producer being destroyed via
 * `Fn::ImportValue`. Surfaced inside {@link StackHasActiveImportsError}.
 */
export interface ActiveImportConsumer {
  consumerStack: string;
  consumerRegion: string;
  exportName: string;
}

/**
 * `export '<name>'` when the export name is plain, a description otherwise
 * (go-to-k/cdkd#3950). Plain is {@link plainIdentOr}'s rule, not
 * `isPasteableIdent`'s: a CDK-generated export name carries `:`
 * (`Producer:ExportsOutputRef…`), which the command gate refuses and which is
 * literal inside single quotes.
 */
function exportNamePhrase(exportName: string): string {
  const shown = plainIdentOr(exportName, '');
  return shown ? `export '${shown}'` : 'an export whose name is not a plain identifier';
}

/**
 * `cdkd destroy <producer>` refused because at least one consumer stack
 * still records an `Fn::ImportValue` reference to one of the producer's
 * outputs. This matches CloudFormation's strong-reference semantics —
 * CFn rejects `DeleteStack` for an exporter while an importer exists.
 *
 * cdkd has no `--force` escape hatch for this (intentionally, mirroring
 * CFn). The error message lists every offending consumer and points the
 * user at the two valid resolution paths:
 *
 *  1. Destroy the consumer first: `cdkd destroy <consumer>`
 *  2. Remove the `Fn::ImportValue` from the consumer's template and
 *     redeploy, then retry the producer destroy.
 *
 * Weak-reference consumers (`Fn::GetStackOutput`, cdkd-specific) never
 * trigger this error by design — the producer stays deletable
 * independently of consumers when the user intentionally chose a weak
 * reference at template-authoring time.
 *
 * Exit code 2 (same as `PartialFailureError`) so multi-stack `cdkd
 * destroy --all` runs that partially succeed still surface as
 * non-zero without being indistinguishable from a fatal cdkd error.
 */
export class StackHasActiveImportsError extends CdkdError {
  readonly exitCode: number = 2;
  public readonly producerStack: string;
  public readonly producerRegion: string;
  public readonly consumers: ActiveImportConsumer[];

  constructor(
    producerStack: string,
    producerRegion: string,
    consumers: ActiveImportConsumer[],
    cause?: Error
  ) {
    // Every value here is record-derived: the consumer's name comes from its
    // state KEY, its region from the key (a legacy record's from its body),
    // and `exportName` from its `state.json`, all chosen by a state-bucket
    // writer; the producer may come from the same listing.
    // A plain value prints as before; any other is described, never put
    // inside cdkd's own `'...'` where a `'` in it closes the quote
    // (go-to-k/cdkd#3950, go-to-k/cdkd#4052's convention).
    const lines = consumers.map(
      (c) =>
        `  - ${plainOrDescribed(c.consumerStack, 'stack name')} (${plainOrDescribed(c.consumerRegion, 'region')}): ` +
        `imports ${exportNamePhrase(c.exportName)}`
    );
    super(
      `Cannot destroy stack ${quotedOrDescribed(producerStack, 'stack name')} (${plainOrDescribed(producerRegion, 'region')}): ` +
        `the following stacks still import its outputs via Fn::ImportValue:\n` +
        `${lines.join('\n')}\n\n` +
        `This matches CloudFormation's strong-reference semantics — exports are\n` +
        `protected as long as a consumer references them.\n\n` +
        `To proceed:\n` +
        `  1. Destroy the consumer first: cdkd destroy <consumer-stack>\n` +
        `  2. Or remove the Fn::ImportValue from the consumer's template\n` +
        `     (e.g. inline the value, or refactor) and re-deploy the consumer,\n` +
        `     then retry this destroy.\n\n` +
        `Note: cdkd's Fn::GetStackOutput intrinsic is a weak alternative that\n` +
        `does NOT protect the producer — use it when you intentionally want\n` +
        `the producer to be deletable independently of consumers.`,
      'STACK_HAS_ACTIVE_IMPORTS',
      cause
    );
    this.producerStack = producerStack;
    this.producerRegion = producerRegion;
    this.consumers = consumers;
    this.name = 'StackHasActiveImportsError';
    Object.setPrototypeOf(this, StackHasActiveImportsError.prototype);
  }
}

/**
 * One export a refused deploy would change or remove, with a consumer that
 * still imports it. Surfaced inside {@link ExportInUseError}.
 */
export interface InUseExportChange extends ActiveImportConsumer {
  reason: 'removed' | 'changed';
}

/**
 * `cdkd deploy <producer>` refused before any resource change because its
 * plan would change or remove an export that a stack outside this run still
 * imports via `Fn::ImportValue`, or that a stack whose record cannot be read
 * may import (go-to-k/cdkd#6088). CloudFormation refuses the same update
 * (`Export ... cannot be updated as it is in use by ...`); without the
 * refusal the consumer keeps a value naming a resource the deploy deleted,
 * which `cdkd drift` cannot see.
 *
 * Exit code 1, as every other refused deploy: `cdkd deploy`'s exit 2 means
 * "deployed, and running again usually clears it", and running again never
 * clears this. Non-retryable: the verdict comes from records and the
 * template, which no retry changes.
 *
 * `nested` drops the "Nothing was changed" sentence: a nested child refuses
 * inside its parent's update, after the parent has started provisioning.
 */
export class ExportInUseError extends CdkdError {
  public readonly producerStack: string;
  public readonly producerRegion: string;
  public readonly changes: InUseExportChange[];
  public readonly unreadable: ReadonlyArray<{ stackName: string; region: string }>;

  constructor(
    producerStack: string,
    producerRegion: string,
    changes: InUseExportChange[],
    opts: {
      unreadable?: ReadonlyArray<{ stackName: string; region: string }>;
      affectedExportNames?: readonly string[];
      nested?: boolean;
    } = {}
  ) {
    const unreadable = opts.unreadable ?? [];
    // Record-derived values are printed plain or described, never quoted raw
    // (go-to-k/cdkd#3950), as in StackHasActiveImportsError.
    const lines = changes.map(
      (c) =>
        `  - ${plainOrDescribed(c.consumerStack, 'stack name')} (${plainOrDescribed(c.consumerRegion, 'region')}): ` +
        `imports ${exportNamePhrase(c.exportName)}, which this deploy would ` +
        (c.reason === 'removed' ? 'remove' : 'change')
    );
    const unreadableBlock =
      unreadable.length === 0
        ? ''
        : `The state of these stacks could not be read, so cdkd cannot rule out that they import\n` +
          `${(opts.affectedExportNames ?? []).map((n) => exportNamePhrase(n)).join(', ') || 'an export this deploy changes'}:\n` +
          unreadable
            .map(
              (u) =>
                `  - ${plainOrDescribed(u.stackName, 'stack name')} (${plainOrDescribed(u.region, 'region')})`
            )
            .join('\n') +
          `\nCheck that their records can be read (\`cdkd state show <stack>\`), then retry.\n\n`;
    super(
      `Cannot deploy stack ${quotedOrDescribed(producerStack, 'stack name')} (${plainOrDescribed(producerRegion, 'region')}): ` +
        `this deploy would change or remove exports that other stacks may still import via Fn::ImportValue.\n` +
        (lines.length > 0 ? `${lines.join('\n')}\n\n` : '\n') +
        unreadableBlock +
        (opts.nested === true ? '' : `Nothing was changed. `) +
        `This matches CloudFormation, which refuses to update or\n` +
        `remove an export while another stack imports it.\n\n` +
        `To proceed:\n` +
        `  1. Deploy the consumers in the same run (name them with this stack, or use --all),\n` +
        `     so each one picks up the new value right after this stack.\n` +
        `  2. Or remove the Fn::ImportValue from each consumer's template and re-deploy\n` +
        `     the consumer first, then retry this deploy.`,
      'EXPORT_IN_USE'
    );
    this.unreadable = unreadable;
    this.producerStack = producerStack;
    this.producerRegion = producerRegion;
    this.changes = changes;
    this.name = 'ExportInUseError';
    Object.setPrototypeOf(this, ExportInUseError.prototype);
    markNonRetryable(this);
  }
}
