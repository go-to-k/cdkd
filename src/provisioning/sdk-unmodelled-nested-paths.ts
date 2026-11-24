/**
 * Nested CFn members the SDK route cannot send, under a top-level property an
 * SDK provider handles (go-to-k/cdkd#6690): the AWS SDK client cdkd ships does
 * not model them, or the provider does not send them.
 *
 * The SDK v3 serializer drops a member its model lacks, so the SDK route would
 * deploy such a template "successfully" without the value. A declared path
 * present in a resource's properties routes that resource through Cloud
 * Control instead, which forwards the property map verbatim — the nested
 * counterpart of the top-level SDK-unwired route (#614). Read through
 * `findValueRoutedProperties` (routing and the deploy report only), and by the
 * sdk-wire harness, which exempts each declared path from its nested-coverage
 * check and fails one the schema no longer lists.
 *
 * Paths are dotted from the top-level property, array levels implicit (the
 * sdk-wire harness's label form). Declare only on a `sdk-coverage`
 * `STICKY_CC_MIGRATION_EXEMPT` type, so the sticky escape returns a routed
 * resource to the SDK provider once the entry is removed — which is due when
 * the SDK models the member and the provider sends it.
 *
 * A LEAF.
 */
export const SDK_UNMODELLED_NESTED_PATHS: Readonly<Record<string, readonly string[]>> = {
  // @aws-sdk/client-route-53 3.1175.0 models these, but the provider reads
  // only Comment and EnableAcceleratedRecovery off the two blocks, so the SDK
  // route would still drop them.
  'AWS::Route53::HostedZone': [
    'HostedZoneConfig.HostedZoneTier',
    'HostedZoneFeatures.ChangeGuardrails',
    'HostedZoneFeatures.ChangeGuardrails.Name',
    'HostedZoneFeatures.ChangeGuardrails.Status',
    'HostedZoneFeatures.EnablePublicDNSFallback',
  ],
};

/** Rationale of a nested-member route; `path` is the declared dotted path. */
export function sdkUnmodelledNestedRationale(path: string): string {
  // Also the `--prefer-sdk-route` warning's reason, so it names no route.
  return `${path} is not sent by cdkd's SDK provider`;
}

/**
 * The top-level properties whose value holds a declared path, each with the
 * first such path's rationale. A member set to `null` counts as absent, as
 * everywhere else in a resolved bag.
 */
export function findSdkUnmodelledNestedProperties(
  resourceType: string,
  templateProperties: Record<string, unknown> | undefined
): Array<{ property: string; rationale: string }> {
  const declared = SDK_UNMODELLED_NESTED_PATHS[resourceType];
  if (declared === undefined || templateProperties === undefined) return [];
  const routed = new Map<string, string>();
  for (const path of declared) {
    const [top, ...rest] = path.split('.');
    if (routed.has(top!)) continue;
    if (holdsPath(templateProperties[top!], rest)) {
      routed.set(top!, sdkUnmodelledNestedRationale(path));
    }
  }
  return [...routed].map(([property, rationale]) => ({ property, rationale }));
}

function holdsPath(value: unknown, segments: readonly string[]): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => holdsPath(item, segments));
  if (segments.length === 0) return true;
  if (typeof value !== 'object') return false;
  const [head, ...rest] = segments;
  return holdsPath((value as Record<string, unknown>)[head!], rest);
}
