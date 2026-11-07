import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayMasked, logRender, maskValueLeaves } from '../masking-display.js';
import { logTextOfLeaf, regionLogText } from '../masking.js';
import { markNonRetryable, markRedactedCause } from '../../retryable-errors.js';
import { injectiveKey } from '../../../state/record-keys.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../../utils/ambient-client-defaults.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import {
  type ResolverContext,
  cachedAvailabilityZones,
  effectiveAccountInfoRegion,
  isClientSafeRegion,
  quotedRender,
} from '../support.js';
import { SECRET_MASK } from '../../secret-redaction.js';
import { DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { namedRequestMasks } from '../stack-output.js';

/**
 * Resolve Fn::GetAZs intrinsic function
 *
 * Fn::GetAZs: region
 * Returns a list of availability zones for the specified region.
 * If region is empty string or {"Ref": "AWS::Region"}, uses the current region.
 * Results are cached per region to avoid repeated API calls.
 */
export async function resolveGetAZs(
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): Promise<string[]> {
  // Recursively resolve the value first (it could be a Ref or other intrinsic function)
  const resolvedValue = await resolver.resolveValue(value, context);

  let region: string;
  /**
   * Which region's clients answer the `DescribeAvailabilityZones` below.
   *
   * `DescribeAvailabilityZones` lists the AZs of the region the CLIENT is
   * pointed at; the `region-name` filter narrows that listing, it does not
   * widen it to another region. So a foreign-region client returns an EMPTY
   * list, which this method then caches and hands back as the resolved value
   * of `Fn::GetAZs` — silently, since an empty list is not an error here
   * (issue #1957).
   *
   * When the template names a region explicitly, THAT is the region to talk
   * to. Otherwise fall back to the resolver's own — but only when it was
   * given explicitly (see {@link explicitRegion}).
   */
  let clientRegion: string | undefined;
  // How `region` is printed (issue #3150): a template-supplied region takes
  // its raw value's log text; the account's own region has none.
  let loggedRegionText: string | undefined;
  if (typeof resolvedValue === 'string' && resolvedValue !== '') {
    // REFUSE a template-derived region that is not region-shaped, BEFORE it
    // can reach `clientsForRegion` (issue #1957 review).
    //
    // This argument is the only attacker-influenceable value in this class
    // that now selects an SDK ENDPOINT: it is template-derived and can arrive
    // through an `Fn::ImportValue` or a parameter, so it is not necessarily
    // written by whoever runs the deploy. Before dynamic-reference lookups
    // were bound to a region it only fed the `region-name` FILTER below and
    // could not build a client; binding made it reachable, so the gate ships
    // with the binding. The measured escape is `evil.example.com#`, which the
    // SSM endpoint ruleset turns into
    // `https://ssm.evil.example.com/#.amazonaws.com` — a SigV4-SIGNED request
    // (access key id + signature) to an attacker-controlled host.
    //
    // THROW rather than fall back to the resolver's own region. Substituting
    // a different region's AZ names would be a silent wrong answer that
    // propagates into subnet placement, which is worse than a stopped deploy;
    // and a template asking for the AZs of a non-region is a bug or an
    // attack, never something to paper over. `clientsForRegion` keeps its own
    // softer backstop for any FUTURE caller, but this path is the one that is
    // reachable today and it fails loudly.
    const requested = canonicalizeRegion(resolvedValue);
    if (!isClientSafeRegion(requested)) {
      // MASKED BEFORE THE TRANSFORM (issue
      // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `resolvedValue`
      // comes back from `resolveValue`, so an `Fn::Sub`-assembled region
      // position can BE a decrypted secret; masking the finished message
      // instead would be decorative, because `stripControlChars` and
      // `.slice(0, 64)` both rewrite the text a literal needle has to match
      // — a measured 80-character secret printed its first 64 characters at
      // default verbosity with the needle recorded and a boundary mask
      // applied. Masking the RAW value also reaches the whole-value arm,
      // which has no {@link MIN_NEEDLE_LENGTH} floor.
      throw markNonRetryable(
        new Error(
          // `the value` LEADS the clause: after `: ` a quoted value would be
          // the pasted clause's COMMAND, and `QUOTABLE_RENDER` admits a path
          // (`'/usr/bin/touch' is not …` runs touch; go-to-k/cdkd#4100 M2).
          `Fn::GetAZs: the value ${quotedRender(displayMasked(resolver, logTextOfLeaf(resolver, resolvedValue, context) !== resolvedValue ? SECRET_MASK : resolvedValue, context).slice(0, 64), "'")} is not a valid AWS ` +
            `region name. A region is substituted into the AWS service hostname, so cdkd will ` +
            `not build a client from it.`
        )
      );
    }
    region = requested;
    clientRegion = requested;
    loggedRegionText = regionLogText(resolver, resolvedValue, context);
  } else {
    // Empty string or non-string: use current region. The SAME value
    // `AWS::Region` answers, and like it, with no STS hop: an AZ list needs no
    // account, so an STS outage must not refuse it (issue #1730).
    region = effectiveAccountInfoRegion(resolver.resolverRegion);
    clientRegion = resolver.explicitRegion;
  }

  // Check cache. The key is read HERE, synchronously beside the
  // `clientsForRegion` selection below, and reused at the `set`, so the list is
  // filed under the identity whose client read it (issue #3660). Never log it.
  const azCacheKey = injectiveKey(credentialFingerprint(ambientCredentialConfig()), region);
  const cached = cachedAvailabilityZones.get(azCacheKey);
  if (cached) {
    // `region` masked for the reason the two throws below state: it has
    // cleared `isClientSafeRegion`, which a real plaintext can (issue #2827
    // review).
    resolver.logger.debug(
      `Resolved Fn::GetAZs from cache: ${logRender(resolver, loggedRegionText ?? region, context)} resolved to ${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, cached, context)), context, { structured: true })}`
    );
    return cached;
  }

  // Call EC2 DescribeAvailabilityZones
  const ec2Client = resolver.clients.clientsForRegion(
    clientRegion,
    loggedRegionText === undefined ? undefined : displayMasked(resolver, loggedRegionText, context)
  ).ec2;

  // The try wraps ONLY the call. The empty-list refusal below deliberately
  // sits outside it: inside, the catch would rewrap it into
  // `failed to describe ...: no availability zones returned ...` — a doubled
  // prefix, and a "failed to describe" on a call that SUCCEEDED.
  let azNames: string[];
  try {
    const response = await ec2Client.send(
      new DescribeAvailabilityZonesCommand({
        Filters: [
          {
            Name: 'region-name',
            Values: [region],
          },
          {
            Name: 'state',
            Values: ['available'],
          },
        ],
      })
    );

    azNames = (response.AvailabilityZones || [])
      .map((az) => az.ZoneName)
      .filter((name): name is string => name !== undefined)
      .sort();
  } catch (error) {
    // BOTH halves masked, and per raw value (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `region` has
    // cleared `isClientSafeRegion`, which is only
    // `/^[a-z0-9][a-z0-9-]{0,30}$/` — a real plaintext passes it — and the
    // caught AWS message quotes the region back.
    //
    // The AWS text takes the region's POSITIONAL mask first (go-to-k/cdkd#3171):
    // the needle mask alone cannot see a sub-floor secret an `Fn::Sub`
    // assembled into the region, and the SDK quotes the region as SENT —
    // canonicalized, which is why the pair keys on `region` rather than on
    // the raw value `loggedRegionText` was derived from.
    const loggedRegion = displayMasked(resolver, loggedRegionText ?? region, context);
    const masks = namedRequestMasks(resolver, [[region, loggedRegion]], context);
    // go-to-k/cdkd#2319: a thrown message is persisted to
    // `deployments/{runId}.jsonl`, and an EC2 `UnauthorizedOperation` names
    // the caller's ARN. An AWS-authored failure is named by its class plus the
    // `--verbose` pointer, AWS's text goes to `debug` masked, and the masked
    // error rides as `cause`, stamped so the retry classifiers read it. A
    // cdkd-authored or transport error, or a non-`Error` value (#3361), keeps
    // its text.
    const failure = describeAwsFailure(error);
    const message = (text: string): string =>
      `Fn::GetAZs: failed to describe availability zones for region ` +
      `${quotedRender(loggedRegion, "'")}: ${masks.text(text)}`;
    if (!(error instanceof Error) || !failure.redacted) throw new Error(message(failure.detail));
    resolver.logger.debug(message(failure.detail));
    const masked = masks.error(error);
    const wrapped = new Error(
      message(failure.summary),
      masked instanceof Error ? { cause: masked } : undefined
    );
    throw masked instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  // An EMPTY list is never a legitimate answer: every enabled AWS region has
  // at least one availability zone. It means the call was answered by the
  // wrong region's endpoint (the `region-name` filter narrows a listing, it
  // does not redirect one), or the region is opt-in and not enabled on this
  // account. Neither is a value to hand back — and it must certainly not be
  // CACHED, because `cachedAvailabilityZones` is module-global, so one
  // degenerate answer would be replayed as the resolved value of every later
  // `Fn::GetAZs` for that region and identity in the process (issue #1957
  // review).
  if (azNames.length === 0) {
    throw markNonRetryable(
      new Error(
        `Fn::GetAZs: no availability zones returned for region ` +
          `${quotedRender(displayMasked(resolver, loggedRegionText ?? region, context), "'")}. Either the region ` +
          `is not enabled on this account (opt-in regions must be enabled before use), or the ` +
          `request was answered by a different region's endpoint.`
      )
    );
  }

  cachedAvailabilityZones.set(azCacheKey, azNames);
  resolver.logger.debug(
    `Resolved Fn::GetAZs: ${logRender(resolver, loggedRegionText ?? region, context)} resolved to ${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, azNames, context)), context, { structured: true })}`
  );
  return azNames;
}
