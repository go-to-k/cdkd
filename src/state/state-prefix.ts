/**
 * The default S3 key prefix for cdkd state.
 *
 * Homed in the STATE layer rather than in `src/cli/commands/state-file-keys.ts`
 * (which re-exports it, so its four existing importers are unchanged) because
 * `src/state/lock-contention-message.ts` needs it to decide whether a recovery
 * hint should spell `--state-prefix` at all, and a `src/state/**` module
 * importing from `src/cli/commands/**` inverts the layering — the CLI sits
 * ABOVE the state layer in the 7-layer architecture, not below it.
 *
 * Note this is only the DEFAULT. Other commands accept `--state-prefix`, so
 * whole-bucket listings deliberately do not scope to it.
 */
export const DEFAULT_STATE_PREFIX = 'cdkd';
