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

/**
 * The state-bucket prefix `CustomResourceProvider` PUTs its response
 * placeholders under, one object per invocation
 * (`custom-resource-responses/{requestId}.json`).
 *
 * Homed here for the same layering reason as {@link DEFAULT_STATE_PREFIX}: the
 * PRODUCER is `src/provisioning/providers/custom-resource-provider.ts` and the
 * COLLECTOR is `src/cli/commands/gc/candidates.ts`, so a copy in either would be a copy
 * the other could drift from — and the two spellings would then disagree about
 * which objects exist, which is the only way a sweeper can miss the family it
 * was written for (issue #2052). `src/cli/commands/state-file-keys.ts`
 * re-exports it so gc reads it alongside the other state-key constants.
 *
 * Note this is only the DEFAULT: `ProviderRegistry` can be configured with a
 * different `responsePrefix`, so a sweep scoped to this value is a sweep of the
 * default layout. gc has no access to a non-default one — nothing persists it —
 * which is stated at the sweep's own call site rather than implied here.
 */
export const CUSTOM_RESOURCE_RESPONSE_PREFIX = 'custom-resource-responses';

/**
 * The state-bucket prefix a `AWS::CloudFormation::WaitConditionHandle`'s
 * pre-signed signal URL points under, one key per handle
 * (`wait-condition-signals/{logicalId}-{uuid}.json`, go-to-k/cdkd#6694). Each
 * `cfn-signal` PUT lands as a new object VERSION of that key; the handle's
 * delete removes the key and its versions. No lifecycle rule expires it: the
 * handle URL must stay writable for as long as the handle exists.
 */
export const WAIT_CONDITION_SIGNAL_PREFIX = 'wait-condition-signals';
