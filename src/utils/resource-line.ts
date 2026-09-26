import { bold, gray, green, red, yellow } from './colors.js';
import { displaySafe } from './display-safe.js';

/**
 * The per-resource operations whose status line deploy / destroy print.
 */
export type ResourceOp = 'created' | 'updated' | 'deleted' | 'skipped';

/**
 * Format the per-resource status line printed by `cdkd deploy` / `cdkd destroy`.
 *
 * All three operations share the layout `<glyph> <id> (<type>) <verb>`; callers
 * prepend their own prefix (a two-space indent, or a `[current/total] ` counter).
 *
 * Every successful op uses a green/colored check (✓), NOT a cross (✗): the op
 * succeeded, and a red ✗ reads as a failure — which is exactly what the separate
 * "✗ Failed to delete" error path prints. The op is distinguished by COLOR, not
 * glyph: green = created, yellow = updated, green-check-with-red-verb = deleted
 * (the verb stays red to keep the destructive nature of the delete visible).
 *
 * `'skipped'` (issue [#1752](https://github.com/go-to-k/cdkd/issues/1752)) is
 * the one op that is NEITHER success nor failure, so it is the one op that does
 * not get a check: cdkd did not touch the resource and cannot say what state it
 * is in. It renders a yellow `⚠` — the same glyph the destroy summary already
 * uses for a partial / interrupted run — so it can never be misread as either
 * the `✓ deleted` success line or the `✗ Failed to delete` failure line. Pass
 * the reason via `verbOverride` (e.g. `'skipped (malformed physicalId)'`).
 *
 * `verbOverride` replaces the default verb word (e.g. `'updated (metadata)'` for
 * a metadata-only update) while keeping the op's glyph and color.
 *
 * The logical id, the type and the verb each render through `displaySafe`: a
 * logical id or type can come from a state record or template, and a skip
 * reason can carry an AWS message, so a newline in any of them must not start
 * a line of its own (go-to-k/cdkd#3773).
 */
export function formatResourceLine(
  op: ResourceOp,
  logicalId: string,
  resourceType: string,
  verbOverride?: string
): string {
  const body = `${bold(displaySafe(logicalId))} ${gray(`(${displaySafe(resourceType)})`)}`;
  const verb = verbOverride === undefined ? undefined : displaySafe(verbOverride);
  switch (op) {
    case 'created':
      return `${green('✓')} ${body} ${green(verb ?? 'created')}`;
    case 'updated':
      return `${yellow('✓')} ${body} ${yellow(verb ?? 'updated')}`;
    case 'deleted':
      return `${green('✓')} ${body} ${red(verb ?? 'deleted')}`;
    case 'skipped':
      return `${yellow('⚠')} ${body} ${yellow(verb ?? 'skipped')}`;
  }
}
