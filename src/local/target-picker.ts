/**
 * Shim: re-exports cdk-local's interactive `clack`-backed target picker for
 * `cdkd local invoke-agentcore` (and any future cdkd local-* command that
 * adopts the missing-target prompt UX). `resolveSingleTarget` returns the
 * user-provided value as-is, prompts in a TTY when omitted, or calls
 * `onMissing()` (the command's required-arg error) when no TTY is available.
 * The implementation lives in cdk-local and cdkd consumes it verbatim instead
 * of carrying a byte-identical copy. See cdk-local's
 * `src/local/target-picker.ts`.
 */
export { resolveSingleTarget } from 'cdk-local/internal';
