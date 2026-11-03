// Injected at build time by tsdown `define` from package.json (see the
// `define` block in vite.config.ts). It does NOT exist under vitest or under
// `node --experimental-strip-types`, where the define never runs, so every
// read must go through the `typeof` guard below.
declare const __CDKD_VERSION__: string;

/** Dev sentinel reported when the build-time define has not run. */
export const DEV_VERSION_SENTINEL = '0.0.0-dev';

/**
 * The build-time cdkd version, with a dev fallback for non-built contexts.
 *
 * This module deliberately has NO imports. `src/cli/index.ts` reads the
 * version on a fast path that must not pull the command tree (see
 * `isVersionOnlyInvocation`), and any import here would put a module graph
 * back on that path.
 */
export function getCdkdVersion(): string {
  return typeof __CDKD_VERSION__ === 'string' ? __CDKD_VERSION__ : DEV_VERSION_SENTINEL;
}

/** The two spellings commander registers for `.version()`. */
const VERSION_FLAGS = new Set(['--version', '-V']);

/**
 * True when the whole invocation is nothing but a version flag.
 *
 * Deliberately narrower than "the argv contains a version flag", and the
 * reason is CONSERVATISM rather than a known disagreement. Measured against
 * commander 12.1.0 on 2026-08-25, every multi-token shape tried still printed
 * the version and exited 0 — `cdkd -c --version`, `cdkd deploy -c --version`,
 * `cdkd --profile -V` — so commander gives a standalone version flag priority
 * and does not consume it as an option value. An earlier draft of this comment
 * asserted the opposite; it was wrong, and a review measured it.
 *
 * The narrow rule is still the right one, for two reasons that survive that
 * correction. It does not DEPEND on that precedence, which is commander's
 * behaviour rather than cdkd's and can change across a major; and a wider rule
 * would be a second spelling of commander's parse, which is the class of bug
 * where two predicates answer one question and disagree at an edge nobody
 * enumerated. A single-token argv has no such edge — there is no subcommand to
 * route to and no option that could be consuming it.
 *
 * Everything this refuses falls through to the full commander parse with its
 * behaviour unchanged, so the cost of refusing too much is only that those
 * invocations stay slow.
 */
export function isVersionOnlyInvocation(userArgs: readonly string[]): boolean {
  return userArgs.length === 1 && VERSION_FLAGS.has(userArgs[0] as string);
}
