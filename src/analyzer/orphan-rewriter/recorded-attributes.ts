import {
  carriesDynamicReference,
  isImpossibleEmptyStoredAttribute,
  isStalePlaceholderArnAttribute,
} from '../../deployment/intrinsic-function-resolver.js';
import { isAlwaysLiveAttribute } from '../../deployment/intrinsic-resolver/getatt.js';
import { carriesSecretMask, SECRET_MASK } from '../../deployment/secret-redaction.js';
import type { ResourceState } from '../../types/state.js';
import { isSecretValuedAttribute, isSensitiveAttributeName } from '../../utils/stringify.js';
import { isCustomResourceType } from '../../provisioning/custom-resource-secure-references.js';
import { isReadableBag } from '../../types/state.js';
import { isReadableResourceEntry } from '../../state/malformed-resources-bag.js';

/**
 * Why a reference to an orphaned record that is NOT a readable resource record
 * is left in place rather than resolved (go-to-k/cdkd#3350).
 *
 * `cdkd orphan` may drop such a record — refusing to would close the way out of
 * it — but it must not resolve THROUGH one. Measured before this guard: a
 * string or number record made a sibling's `{"Ref": O}` resolve to `undefined`,
 * which the save then dropped from the JSON, and its `Fn::Sub` `${O}` became
 * the literal `x-undefined`. Reported as unresolvable instead, so a plain run
 * aborts naming the site and `--force` leaves the intrinsic untouched — there
 * is no cached value to fall back to either, since the cache lives inside the
 * record that cannot be read.
 */
export const UNREADABLE_ORPHAN_RECORD_REASON =
  "the orphaned resource's state record is not a readable resource record (not an object, " +
  'no resource type, or no physical id), so nothing in it can be substituted';

/**
 * Whether the fetcher may read an orphaned record at all: the ENTRY class's
 * predicate PLUS a non-empty string `physicalId`. The entry predicate stops at
 * `resourceType` on purpose (its own note), but every LIVE value this fetcher
 * produces is derived from the physical id — `{"resourceType": "T"}` alone
 * made `{"Ref": O}` resolve to `undefined` and `Fn::Sub` to `x-undefined`
 * exactly as a string record did, and a type whose `Ref` recovery reads the id
 * threw a bare `TypeError` (review of go-to-k/cdkd#3568). The `--force` cache
 * is skipped for such a record too, deliberately: a record with no identity is
 * not one whose cached values can be trusted to describe a live resource.
 */
export function isResolvableOrphanRecord(entry: unknown): boolean {
  if (!isReadableResourceEntry(entry)) return false;
  const physicalId = (entry as { physicalId?: unknown }).physicalId;
  return typeof physicalId === 'string' && physicalId !== '';
}

/**
 * Whether any OBJECT KEY inside `value`, at any depth, is credential-named: an
 * attribute that is itself innocently named can hold a `{Password: ...}` leaf,
 * and serving it whole would print that leaf in the audit table.
 */
function carriesSensitiveNamedLeaf(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  // An array's entries are its index keys, never sensitive; its elements recurse.
  return Object.entries(value).some(
    ([key, leaf]) => isSensitiveAttributeName(key) || carriesSensitiveNamedLeaf(leaf)
  );
}

/**
 * The orphan's RECORDED value for `attribute`, when the record holds one the
 * deploy-time resolver would serve as-is (go-to-k/cdkd#4186).
 *
 * GATED ON A LIVE ANSWER. The caller takes this value only after the live
 * read returned a defined value for the same attribute, so it never widens
 * what the live-read-only path could substitute and print; see the call site.
 *
 * WHY RECORDED OVER LIVE. The resolver's `resolveGetAtt` serves a
 * `Fn::GetAtt` from this same `attributes` map whenever it holds the key, so
 * this chooses the same value the resolver would — not necessarily the value
 * a rewritten sibling was deployed with (a row still holding its intrinsic
 * never went through the resolver), and not necessarily the value AWS holds
 * today for an attribute AWS changes later (an instance's `PublicIp`). The
 * live `provider.getAttribute(...)` read is addressed by the recorded NAME for
 * most SDK providers, so after the resource was deleted out of band and a
 * DIFFERENT one took its name — the situation `cdkd orphan` is the documented
 * remedy for — it answered with the FOREIGN resource's attribute and planted
 * that into the dependents' state.
 *
 * NOT SERVED, so the live answer (or, when there is none, `--force`'s
 * fallback) still decides,
 * mirroring each arm on which the resolver does not serve the stored value
 * verbatim either:
 * - an absent key, or `''` where `isImpossibleEmptyStoredAttribute` says the
 *   resource cannot hold it — the record predates the attribute;
 * - an attribute the resolver never serves stored (`isAlwaysLiveAttribute`:
 *   the VPC's `Ipv6CidrBlocks`, the Subnet's `Ipv6CidrBlocks`,
 *   `NetworkAclAssociationId` and `BlockPublicAccessStates` or a dotted member
 *   of it), since a change after the create leaves the recorded value stale;
 * - a pre-#1681 placeholder ARN (`isStalePlaceholderArnAttribute`), which the
 *   resolver heals by a re-read;
 * - a value carrying the redaction mask (`SECRET_MASK`): it is all cdkd kept of
 *   the value, and a mask must never become a sibling's property, on this
 *   path or through `--force`'s fallback (go-to-k/cdkd#4602);
 * - a value carrying a `{{resolve:...}}` reference (a nested stack's redacted
 *   output, issue #2055), which the resolver re-resolves in a context this
 *   analyzer pass does not have.
 *
 * And the classes whose recorded value may be a SECRET PLAINTEXT, so it must
 * not replace the live answer — the rewrite audit table prints every
 * substituted value at default verbosity, and the live answer is what the
 * pre-#4186 path printed. (The live-answer gate already keeps a provider that
 * cannot answer, e.g. Cloud Control's whole-model record, out of here.)
 * - an attribute whose NAME is credential-bearing (`isSensitiveAttributeName`,
 *   the predicate the resolver's log redaction uses): `AWS::IAM::AccessKey`
 *   records `SecretAccessKey` in plaintext, and no mask covers it;
 * - every attribute of a custom resource, whose `Data` names certify nothing
 *   and which a record written before `NoEcho` masking holds in plaintext;
 * - an attribute {@link isSecretValuedAttribute} names, a secret the name rule
 *   cannot see, and a value holding a credential-named leaf at any depth.
 * The one reshaping the resolver applies is applied too: a legacy
 * comma-joined Route 53 `NameServers` string becomes the list it stands for.
 * The dotted-path walk over a nested `attributes` object (issue #381) is the
 * resolver's second served arm and is mirrored, OWN keys only.
 */
export function servableRecordedAttribute(
  orphan: ResourceState,
  attribute: string
): { served: true; value: unknown } | { served: false } {
  if (
    isAlwaysLiveAttribute(orphan.resourceType, attribute) ||
    isSensitiveAttributeName(attribute) ||
    isCustomResourceType(orphan.resourceType) ||
    isSecretValuedAttribute(orphan.resourceType, attribute)
  ) {
    return { served: false };
  }
  const bag: unknown = orphan.attributes;
  // An unreadable map holds nothing; `--force`'s fallback says why.
  if (bag === undefined || !isReadableBag(bag)) return { served: false };
  const attributes = bag as Record<string, unknown>;
  const stored = Object.hasOwn(attributes, attribute) ? attributes[attribute] : undefined;
  let value = isImpossibleEmptyStoredAttribute(orphan.resourceType, attribute, stored)
    ? undefined
    : stored;
  if (value !== undefined) {
    if (isStalePlaceholderArnAttribute(orphan.resourceType, attribute, value)) {
      return { served: false };
    }
    if (
      orphan.resourceType === 'AWS::Route53::HostedZone' &&
      attribute === 'NameServers' &&
      typeof value === 'string'
    ) {
      value = value === '' ? [] : value.split(',');
    }
  } else if (attribute.includes('.')) {
    let cursor: unknown = attributes;
    for (const part of attribute.split('.')) {
      if (cursor !== null && typeof cursor === 'object' && Object.hasOwn(cursor, part)) {
        cursor = (cursor as Record<string, unknown>)[part];
      } else {
        cursor = undefined;
        break;
      }
    }
    value = cursor;
  }
  if (
    value === undefined ||
    carriesSecretMask(value) ||
    carriesDynamicReference(value) ||
    carriesSensitiveNamedLeaf(value)
  ) {
    return { served: false };
  }
  return { served: true, value };
}

/**
 * Why `--force`'s cache fallback must NOT splice `cached` for `attribute` of a
 * `resourceType` record, or `undefined` when it may. The same classes
 * {@link servableRecordedAttribute} refuses to serve, minus the two that are
 * about staleness rather than secrecy (go-to-k/cdkd#4602).
 */
export function unsplicableCachedAttribute(
  resourceType: string,
  attribute: string,
  cached: unknown
): string | undefined {
  if (isSensitiveAttributeName(attribute)) return 'a credential-named attribute';
  if (isCustomResourceType(resourceType)) return "a custom resource's attribute";
  if (isSecretValuedAttribute(resourceType, attribute)) {
    return 'a secret-valued attribute';
  }
  if (carriesSecretMask(cached)) return `the redaction mask ('${SECRET_MASK}')`;
  if (carriesDynamicReference(cached)) return 'an unresolved dynamic reference';
  if (carriesSensitiveNamedLeaf(cached)) return 'a value with a credential-named field';
  return undefined;
}
