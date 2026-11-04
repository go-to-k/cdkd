/**
 * S3 addressing style for every S3 client cdkd builds (issue
 * [#5745](https://github.com/go-to-k/cdkd/issues/5745)).
 *
 * WHY THIS EXISTS
 *
 * The AWS SDK for JavaScript v3 honours an S3 endpoint override
 * (`AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`, a profile's `endpoint_url` or its
 * `services` section) but keeps building VIRTUAL-HOSTED URLs against it:
 * `http://<bucket>.s3:4566/<key>`. Against an S3 emulator that name resolves
 * nowhere — and the custom-resource `ResponseURL` cdkd pre-signs is PUT by a
 * Lambda that cannot reach it, so the custom resource never completes. The SDK
 * does not read a profile's `s3 = addressing_style = path` at all, and has no
 * environment knob for path-style.
 *
 * THE RULE IS THE AWS CLI'S (botocore `args.py`), applied to EVERY S3 client:
 *
 *   forcePathStyle = addressing_style === 'path'
 *                 || (endpoint override configured && addressing_style !== 'virtual')
 *
 * plus the AWS CDK CLI's `CDK_S3_FORCE_PATH_STYLE`, with its exact semantics:
 * ANY non-empty value forces path-style ON — `false` and `0` included, since
 * the CDK CLI tests the variable's truthiness — and it wins over
 * `addressing_style = virtual`. It never turns path-style OFF.
 *
 * `addressing_style` is read the way botocore builds its scoped config: the
 * profile's `s3` section from the config file, REPLACED WHOLE by the same
 * profile's `s3` section in the shared credentials file when that file has one
 * (botocore `session.py` merges credentials-file profiles with `dict.update`,
 * so the credentials file wins, and its `s3` dict replaces the config's).
 *
 * When it says no, {@link s3ClientDefaults} returns `{}` — the key is ABSENT,
 * so a run with no override and no profile setting builds byte-for-byte the
 * client it built before this module existed.
 *
 * `forcePathStyle` changes nothing for an S3 Express (`--x-s3`) bucket — the
 * SDK's endpoint rules ignore it there — and an override combined with FIPS,
 * dual-stack or accelerate is already an SDK error with or without it
 * (`tests/unit/utils/s3-client-defaults-sdk-contract.test.ts` pins both). The
 * one shape it newly REFUSES is a top-level `Bucket` that is an ARN (an access
 * point): the SDK throws "Path-style addressing cannot be used with ARN
 * buckets". No cdkd S3 request carries one: every top-level `Bucket` it sends is
 * a bucket NAME (the state bucket, an asset bucket, or a template property
 * CloudFormation documents as a name); the `Bucket: ...Arn` members in the S3
 * bucket providers are destinations inside configuration blobs, which S3 reads
 * as data, not request addresses.
 *
 * WHEN IT IS DECIDED
 *
 * The override can come from the profile, and profile config reaches the SDK
 * only through `AWS_PROFILE`, which `buildProgram`'s `preAction`
 * (`src/cli/program.ts`) sets from `--profile`. That hook therefore awaits
 * {@link resolveS3ClientDefaults} right after it, ONCE per process, before any
 * command action builds a client. The override is resolved by the SDK's own
 * resolver (`S3Client.config.serviceConfiguredEndpoint()`), so its precedence
 * and `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` are the SDK's.
 *
 * A LIBRARY caller never runs that hook. It resolves once itself, after
 * setting `AWS_PROFILE` (if it selects a profile) and before building any
 * client through cdkd's exports:
 *
 *   import { resolveS3ClientDefaults } from '@cdkd/cli';
 *   await resolveS3ClientDefaults({ profile: process.env.AWS_PROFILE });
 *
 * A client built before resolution gets an ENVIRONMENT-only approximation
 * instead (no profile `endpoint_url` or `addressing_style`), and one debug line
 * says so. The result is memoized once per process: a later call with another
 * profile does not re-resolve.
 *
 * This module sits in the literal-`.ts` import closure
 * `scripts/audit-provider-coverage.ts` resolves (`aws-clients.ts` imports it),
 * so it imports nothing relative except with the `.ts` spelling, and it cannot
 * reach `logger.ts`: messages go through {@link setS3ClientDefaultsDebugLog}.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { getProfileName, loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { awsClientDefaults } from './aws-client-defaults.ts';

/** The values botocore accepts for `s3.addressing_style`. */
export type S3AddressingStyle = 'auto' | 'path' | 'virtual';

/** The key `@smithy/shared-ini-file-loader` flattens `s3 =\n  addressing_style = x` into. */
export const ADDRESSING_STYLE_INI_KEY = 's3.addressing_style';

/** The AWS CDK CLI's path-style switch, honoured with its exact semantics. */
export const CDK_FORCE_PATH_STYLE_ENV = 'CDK_S3_FORCE_PATH_STYLE';

/**
 * `if (process.env.CDK_S3_FORCE_PATH_STYLE)` in the CDK CLI: any non-empty
 * value, `false` and `0` included, is ON. Read when a decision is made: the
 * resolved decision memoizes it with the rest, the fallback re-reads it.
 */
function forcedByCdkEnv(): boolean {
  return Boolean(process.env[CDK_FORCE_PATH_STYLE_ENV]);
}

export interface S3AddressingDecision {
  /** The profile's `s3.addressing_style`; `auto` when absent or unrecognized. */
  readonly addressingStyle: S3AddressingStyle;
  /** Whether an S3 endpoint override is configured. */
  readonly endpointOverride: boolean;
  /** `CDK_S3_FORCE_PATH_STYLE` is set (any non-empty value). */
  readonly forcedByCdkEnv: boolean;
  /** The rule's answer for a client that sets no `endpoint` of its own. */
  readonly forcePathStyle: boolean;
  /** `resolved` from the SDK's resolver, or the pre-resolution `env-fallback`. */
  readonly source: 'resolved' | 'env-fallback';
}

/** The botocore rule. Pure: the one place it is spelled. */
export function pathStyleRule(
  addressingStyle: S3AddressingStyle,
  endpointOverride: boolean
): boolean {
  return addressingStyle === 'path' || (endpointOverride && addressingStyle !== 'virtual');
}

let resolved: S3AddressingDecision | undefined;
let resolving: Promise<S3AddressingDecision> | undefined;
/**
 * Bumped by {@link resetS3ClientDefaults}, so a resolution still in flight
 * across a reset cannot commit its stale decision or notices afterwards.
 */
let generation = 0;
/** True only while the resolver builds its own probe client. */
let buildingProbe = false;
let fallbackNoticed = false;
let debugLog: ((message: string) => void) | undefined;

/** Where this module's debug lines go; `buildProgram` points it at cdkd's logger. */
export function setS3ClientDefaultsDebugLog(sink: ((message: string) => void) | undefined): void {
  debugLog = sink;
}

/**
 * The environment-only APPROXIMATION, for a client built before resolution.
 * Spelled to match the SDK on the environment it reads: the ignore flag counts
 * only as the exact string `true` (the SDK accepts `true` / `false` and throws
 * on anything else), and an override is any non-empty value. A profile
 * `endpoint_url`, `services` section or `addressing_style` is invisible here.
 */
function envFallbackDecision(): S3AddressingDecision {
  const ignored = process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] === 'true';
  const endpointOverride =
    !ignored && Boolean(process.env['AWS_ENDPOINT_URL_S3'] || process.env['AWS_ENDPOINT_URL']);
  const forced = forcedByCdkEnv();
  return {
    addressingStyle: 'auto',
    endpointOverride,
    forcedByCdkEnv: forced,
    forcePathStyle: forced || pathStyleRule('auto', endpointOverride),
    source: 'env-fallback',
  };
}

/**
 * Lines decided during resolution, emitted at the first client build after it:
 * resolution runs in `preAction`, BEFORE a command applies `--verbose`, so a
 * debug line written there would be dropped.
 */
let pendingNotices: string[] = [];

function currentDecision(): S3AddressingDecision {
  if (resolved !== undefined) {
    if (pendingNotices.length > 0) {
      const lines = pendingNotices;
      pendingNotices = [];
      for (const line of lines) debugLog?.(line);
    }
    return resolved;
  }
  const fallback = envFallbackDecision();
  // The resolver's own probe never sends a request, so its addressing never
  // matters and a notice for it would be noise. Any OTHER early client is
  // reported, even one built while resolution is in flight.
  if (!buildingProbe && !fallbackNoticed) {
    fallbackNoticed = true;
    debugLog?.(
      'S3 client built before the S3 addressing style was resolved: using the ' +
        `environment-only answer (path-style ${fallback.forcePathStyle ? 'on' : 'off'}).`
    );
  }
  return fallback;
}

export interface S3ClientDefaultsOptions {
  /**
   * The client sets its OWN `endpoint`, which the rule counts as an override
   * (the `CDKD_CR_S3_ENDPOINT_URL` presign client).
   */
  explicitEndpoint?: boolean;
}

/**
 * `{ forcePathStyle: true }` when the rule says so, otherwise `{}`. Spread it in
 * EVERY `new S3Client({...})` literal under `src/**`, after the
 * `awsClientDefaults(...)` spread (`scripts/check-aws-client-defaults.ts`
 * enforces it). Never a function-valued `forcePathStyle`: the value is decided
 * when the client is built.
 */
export function s3ClientDefaults(options: S3ClientDefaultsOptions = {}): { forcePathStyle?: true } {
  const decision = currentDecision();
  const forcePathStyle =
    options.explicitEndpoint === true
      ? decision.forcedByCdkEnv || pathStyleRule(decision.addressingStyle, true)
      : decision.forcePathStyle;
  return forcePathStyle ? { forcePathStyle: true } : {};
}

/** The decision {@link s3ClientDefaults} applies right now (tests, diagnostics). */
export function s3AddressingDecision(): S3AddressingDecision {
  return currentDecision();
}

async function readAddressingStyle(
  profile: string | undefined,
  notices: string[]
): Promise<S3AddressingStyle> {
  const { configFile, credentialsFile } = await loadSharedConfigFiles();
  const name = getProfileName({ ...(profile !== undefined && profile !== '' && { profile }) });
  // botocore: the credentials file's profile `dict.update`s the config's, so a
  // credentials-file `s3` section REPLACES the config's whole `s3` section.
  const fromCredentials = credentialsFile[name];
  const credentialsHasS3 =
    fromCredentials !== undefined && Object.keys(fromCredentials).some((k) => k.startsWith('s3.'));
  const raw = (credentialsHasS3 ? fromCredentials : configFile[name])?.[ADDRESSING_STYLE_INI_KEY];
  if (raw === undefined) return 'auto';
  const value = raw.trim();
  if (value === 'path' || value === 'virtual' || value === 'auto') return value;
  notices.push(
    'Ignoring an unrecognized s3 addressing_style in the AWS config (expected path, virtual or auto).'
  );
  return 'auto';
}

async function hasConfiguredEndpoint(): Promise<boolean> {
  // A probe that never sends a request: it exists to ask the SDK's resolver.
  // No `profile` key: the SDK's configured-endpoint lookup ignores it and reads
  // `AWS_PROFILE` alone — as it does for every real client, so this agrees.
  buildingProbe = true;
  let probe: S3Client;
  try {
    probe = new S3Client({ ...awsClientDefaults(), ...s3ClientDefaults() });
  } finally {
    buildingProbe = false;
  }
  try {
    const endpoint = await probe.config.serviceConfiguredEndpoint?.();
    return endpoint !== undefined && endpoint !== null && String(endpoint) !== '';
  } finally {
    probe.destroy();
  }
}

async function resolveOnce(
  profile: string | undefined,
  notices: string[]
): Promise<S3AddressingDecision> {
  try {
    const [addressingStyle, endpointOverride] = await Promise.all([
      readAddressingStyle(profile, notices),
      hasConfiguredEndpoint(),
    ]);
    const forced = forcedByCdkEnv();
    return {
      addressingStyle,
      endpointOverride,
      forcedByCdkEnv: forced,
      forcePathStyle: forced || pathStyleRule(addressingStyle, endpointOverride),
      source: 'resolved',
    };
  } catch (error) {
    // A malformed config or proxy variable fails the real clients later with
    // its own message; resolution must not pre-empt that with a different one.
    notices.push(
      'Could not read the S3 endpoint / addressing configuration ' +
        `(${error instanceof Error ? error.name : 'non-Error'}); using the environment-only answer.`
    );
    return envFallbackDecision();
  }
}

function describe(decision: S3AddressingDecision): string | undefined {
  if (!decision.forcePathStyle) return undefined;
  if (decision.forcedByCdkEnv) {
    return (
      `S3 path-style addressing enabled: ${CDK_FORCE_PATH_STYLE_ENV} is set (any non-empty ` +
      'value turns it on, as in the AWS CDK CLI). Unset it to turn it off.'
    );
  }
  const why =
    decision.addressingStyle === 'path'
      ? 'the AWS profile sets s3 addressing_style = path'
      : 'an S3 endpoint override is configured (AWS_ENDPOINT_URL_S3, AWS_ENDPOINT_URL, or endpoint_url / a services section in the AWS config)';
  const optOut =
    decision.addressingStyle === 'path'
      ? ''
      : ' To keep virtual-hosted URLs, set "addressing_style = virtual" under "s3 =" in the profile.';
  return `S3 path-style addressing enabled: ${why}.${optOut}`;
}

/**
 * Decide the addressing style once for this process. Never rejects. `profile`
 * selects the profile `addressing_style` is read from: the run's `--profile`,
 * which `preAction` has also mirrored into `AWS_PROFILE` (what the SDK's
 * endpoint lookup reads); without it the SDK's default (`AWS_PROFILE`, else
 * `default`) applies.
 */
export async function resolveS3ClientDefaults(
  options: { profile?: string | undefined } = {}
): Promise<S3AddressingDecision> {
  if (resolved !== undefined) return resolved;
  if (resolving === undefined) {
    const mine = generation;
    const notices: string[] = [];
    resolving = resolveOnce(options.profile, notices).then((decision) => {
      if (mine !== generation) return decision;
      resolved = decision;
      const line = describe(decision);
      pendingNotices.push(...notices, ...(line !== undefined ? [line] : []));
      return decision;
    });
  }
  return resolving;
}

/** Drop the memoized decision. Test seam; mirrors `resetAwsClientDefaults()`. */
export function resetS3ClientDefaults(): void {
  resolved = undefined;
  resolving = undefined;
  generation++;
  buildingProbe = false;
  fallbackNoticed = false;
  pendingNotices = [];
}
