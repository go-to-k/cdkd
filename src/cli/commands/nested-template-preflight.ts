import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { SynthesisError } from '../../utils/error-handler.js';
import {
  findNestedTemplateTreeDefect,
  renderNestedTemplateTreeDefect,
} from '../../utils/nested-template-cycle.js';

/** The two `StackInfo` fields the pre-flight reads. */
export interface NestedTemplatePreflightStack {
  stackName: string;
  nestedTemplates?: Readonly<Record<string, string>> | undefined;
}

/**
 * Refuse a malformed nested-template tree (a cycle, an absolute
 * `aws:asset:path` below the top level, a chain too deep or a tree too large
 * to deploy) for every SELECTED stack, before `cdkd deploy` does anything a
 * refusal would have to undo (issue go-to-k/cdkd#3449).
 *
 * `NestedStackProvider` runs the same walk per nested-stack row
 * (go-to-k/cdkd#3247), which is the earliest point the provider owns: by then
 * the stack's assets are published, its lock is held, and any root resource
 * that does not depend on the nested row may already be created and must be
 * rolled back. Everything the walk reads is on disk as soon as synth returns,
 * so the CLI asks first and the deploy never starts. The provider call stays
 * as the guard for a context this command did not build.
 *
 * Read-only and synchronous: a few file reads per nested template, none at all
 * for a stack without nested-stack rows. One walk covers all of a stack's
 * top-level rows, so the walker's row budget is per STACK here and per row in
 * the provider; no CDK-generated assembly comes near either.
 *
 * The root template's own path is not seeded into the walk (`StackInfo` does
 * not carry it). Detection does not depend on the seed: a child that points
 * back at the root template is followed once around and refused when the walk
 * re-enters the first nested template it saw.
 *
 * `SynthesisError` because the defect is in the synthesized assembly, like the
 * absolute-path refusal `AssemblyReader` raises for a top-level row.
 * `markNonRetryable` because the message carries template-controlled text the
 * substring-matching retry classifier must never read, wherever the error ends
 * up being caught.
 */
export function refuseMalformedNestedTemplateTrees(
  stacks: readonly NestedTemplatePreflightStack[]
): void {
  for (const stack of stacks) {
    if (!stack.nestedTemplates) continue;
    const defect = findNestedTemplateTreeDefect(stack.nestedTemplates);
    if (!defect) continue;
    throw markNonRetryable(
      new SynthesisError(
        renderNestedTemplateTreeDefect(
          defect,
          stack.stackName,
          'start the deploy; nothing has been published or provisioned'
        )
      )
    );
  }
}
