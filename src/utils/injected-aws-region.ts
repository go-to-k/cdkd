/**
 * The `AWS_REGION` value cdkd copied into its own environment, and what the
 * variable held before (go-to-k/cdkd#2100).
 *
 * `exportInferredRegionForSdk` (`src/cli/region-options.ts`) copies a region
 * inferred from `AWS_DEFAULT_REGION` into `AWS_REGION`, the variable the JS SDK
 * reads, so cdkd's own region-less clients agree with the state. That copy is
 * cdkd's alone:
 *
 * - a CHILD process — the CDK app, a docker build — gets the user's original
 *   environment ({@link withoutInjectedAwsRegion} / {@link injectedAwsRegionOverride}).
 *   An app reading `process.env.AWS_REGION` into `env: { region }` would
 *   otherwise be PINNED to the copied value and escape the hold that keeps a
 *   pre-upgrade us-east-1 stack where it lives. The AWS CDK CLI does not set
 *   it for the app either.
 * - a second `resolveEffectiveRegion` in the same process reads the copy as the
 *   inference it came from ({@link injectedAwsRegionValue}), not as a region
 *   the user named, so the hold still applies.
 *
 * A leaf module (no cdkd imports) so `src/synthesis` and `src/assets` can use
 * it without reaching into `src/cli`.
 */

let injected: { value: string; original: string | undefined } | undefined;

/** Copy `region` into `AWS_REGION`, remembering what the variable held first. */
export function injectAwsRegion(region: string): void {
  injected ??= { value: region, original: process.env['AWS_REGION'] };
  injected.value = region;
  process.env['AWS_REGION'] = region;
}

/** The value cdkd injected, or `undefined` when it injected none. */
export function injectedAwsRegionValue(): string | undefined {
  return injected?.value;
}

/** `env` minus the injected `AWS_REGION`: the user's own value, or none. */
export function withoutInjectedAwsRegion<T extends Record<string, string | undefined>>(env: T): T {
  if (injected === undefined || env['AWS_REGION'] !== injected.value) return env;
  const out: Record<string, string | undefined> = { ...env };
  if (injected.original === undefined) delete out['AWS_REGION'];
  else out['AWS_REGION'] = injected.original;
  return out as T;
}

/**
 * The override a spawn helper that MERGES onto `process.env` needs to undo the
 * injection (`undefined` deletes the key), or `undefined` when there is none.
 */
export function injectedAwsRegionOverride(): { AWS_REGION: string | undefined } | undefined {
  if (injected === undefined || process.env['AWS_REGION'] !== injected.value) return undefined;
  return { AWS_REGION: injected.original };
}

/** Test hook: forget an injected `AWS_REGION` between cases. */
export function resetInjectedAwsRegionForTests(): void {
  injected = undefined;
}
