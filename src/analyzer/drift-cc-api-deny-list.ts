/**
 * Resource types that should NOT use the Cloud Control API fallback for
 * `cdkd drift` because their CC API `GetResource` shape diverges from the
 * CFn template shape that cdkd state stores in `properties`.
 *
 * Without this guard, drift detection through CC API for these types would
 * fire **false-positive drift on every run** even on a clean stack — every
 * `cdkd drift` invocation would surface noise, which is worse than no
 * coverage at all (users learn to ignore the report).
 *
 * Types in this map fall through to "drift unknown" instead of CC API,
 * mirroring the behavior for resource types whose SDK provider hasn't yet
 * implemented `readCurrentState`. The fix path for any type listed here is
 * a first-class SDK-provider `readCurrentState` (see PR D's batches), not
 * an entry tweak — once the provider implements it, the deny-list entry
 * becomes unreachable because `provider.readCurrentState` is consulted
 * before the CC API fallback.
 *
 * **Curation policy**: only list types where the divergence is verified
 * against AWS documentation or empirical observation. When in doubt, leave
 * the type out — drift will use CC API for everything we don't know is
 * broken, and we can iterate on user reports. Better to under-deny (some
 * users see noise we can fix on their report) than to over-deny (block
 * legitimate CC API coverage we'd otherwise get for free).
 *
 * Each entry's value is the human-readable reason for divergence — surfaced
 * nowhere in the runtime today, but kept inline as documentation for the
 * next person to revisit this file (and so the map shape stays
 * `Record<string, string>` for trivial JSON serialization if ever needed).
 */
export const CC_API_FALLBACK_DENY_LIST: Record<string, string> = {
  // AWS::IAM::ManagedPolicy: PolicyDocument round-trips through CC API
  // URL-encoded; cdkd state stores it as a parsed JSON object. Without
  // a per-type decoder, every comparison sees a string-vs-object
  // mismatch and fires drift on every run. The IAM Role provider's
  // first-class readCurrentState handles its inline AssumeRolePolicy
  // the same way (URL-decode + JSON-parse); the same fix pattern is
  // needed for ManagedPolicy when an SDK provider is added.
  'AWS::IAM::ManagedPolicy':
    'PolicyDocument is URL-encoded JSON in CC API responses, but cdkd state stores it as a parsed object — needs per-type decode',

  // AWS::ApiGateway::RestApi: the `Body` property (OpenAPI spec object
  // when supplied via `Body` rather than `BodyS3Location`) is write-only
  // — `GetRestApi` does NOT return it, but cdkd state preserves the
  // object the user passed in. CC API GetResource inherits this — the
  // returned shape omits `Body`, so every drift run flags it as
  // missing-on-AWS. Comparison silently dropping it would also be
  // wrong; the right move is a dedicated SDK provider that knows to
  // skip `Body` entirely.
  'AWS::ApiGateway::RestApi':
    'Body / BodyS3Location are write-only inputs not returned by CC API GetResource; cdkd state preserves them',

  // AWS::CloudFormation::Stack: nested stacks aren't supported by cdkd's
  // provider registry at all; the deploy / destroy paths reject them.
  // Listing here is defense-in-depth — if a user manually crafts state
  // with one, drift via CC API would compare CFn-template-input
  // properties against CC API's stack-output shape (CC API's
  // `AWS::CloudFormation::Stack` reports outputs / status, not the
  // template parameters cdkd would have stored).
  'AWS::CloudFormation::Stack':
    'CC API returns runtime stack state (outputs/status), not the template parameters cdkd state stores',

  // AWS::EC2::LaunchTemplate: `LaunchTemplateData` ships with deeply
  // structured sub-objects that CC API normalizes into a versioned shape
  // — every UpdateLaunchTemplate (and even GetLaunchTemplate) bumps the
  // returned default version, and CC API attaches a synthetic
  // `LatestVersionNumber` / `DefaultVersionNumber` next to the template
  // data that drift would surface as drift on the parent. Until an SDK
  // provider strips those, deny.
  'AWS::EC2::LaunchTemplate':
    'CC API returns version-bumped LaunchTemplateData with synthetic LatestVersionNumber that diverges from the CFn input shape',
};
