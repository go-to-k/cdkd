import { bold, gray, green, red, yellow } from './colors.js';

/**
 * The per-resource operations whose status line deploy / destroy print.
 */
export type ResourceOp = 'created' | 'updated' | 'deleted';

/**
 * Format the per-resource status line printed by `cdkd deploy` / `cdkd destroy`.
 *
 * All three operations share the layout `<glyph> <id> (<type>) <verb>`; callers
 * prepend their own prefix (a two-space indent, or a `[current/total] ` counter).
 *
 * Deletion uses a green check (✓), NOT a red cross (✗): the resource WAS removed
 * successfully, and a red ✗ reads as a failure — which is exactly what the
 * separate "✗ Failed to delete" error path prints. The verb itself stays red to
 * keep the destructive nature of the op visible, so a clean delete is still
 * distinguishable at a glance from a create (all green) or update (all yellow).
 */
export function formatResourceLine(
  op: ResourceOp,
  logicalId: string,
  resourceType: string
): string {
  const body = `${bold(logicalId)} ${gray(`(${resourceType})`)}`;
  switch (op) {
    case 'created':
      return `${green('✓')} ${body} ${green('created')}`;
    case 'updated':
      return `${yellow('~')} ${body} ${yellow('updated')}`;
    case 'deleted':
      return `${green('✓')} ${body} ${red('deleted')}`;
  }
}
