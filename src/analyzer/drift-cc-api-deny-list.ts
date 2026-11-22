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
  // AWS::CloudFormation::Stack: `NestedStackProvider` deploys the child's
  // resources itself, so the row's physicalId is a `cdkd-local` placeholder
  // ARN and no CloudFormation stack exists to read; the provider has no
  // `readCurrentState`, so without this entry drift would ask Cloud Control
  // about it. The child's resources are compared as their own
  // `<parent>~<child>` stack (issue #4447).
  'AWS::CloudFormation::Stack':
    'cdkd deploys nested stacks itself: no CloudFormation stack exists, and the physicalId is a cdkd-local placeholder ARN',

  // Left the list once their SDK providers gained a `readCurrentState`
  // (#6769): `AWS::CloudWatch::AnomalyDetector` (a cdkd-derived descriptor as
  // the physicalId, #4668) and `AWS::EMR::InstanceFleetConfig` /
  // `InstanceGroupConfig` (the bare fleet / group id, while Cloud Control
  // needs the composite primaryIdentifier, #5179). `AWS::EC2::LaunchTemplate`
  // left it too: it has no SDK provider, so it is routed to Cloud Control,
  // whose provider reads it, and this list only gates the fallback for an SDK
  // provider with no `readCurrentState` (#6769).
};
