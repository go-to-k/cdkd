import type { Route53Provider } from '../route53-provider.js';
import { GetHostedZoneCommand } from '@aws-sdk/client-route-53';
import { isPlainImportValue, remedyLogicalId, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import {
  cdkdRemedy,
  commandHole,
  pasteableCommand,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import {
  COMPOSITE_ID_SEPARATOR,
  canonicalizeRoute53QueryName as canonicalizeQueryName,
} from '../../composite-id.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { isPasteableIdent } from '../../../utils/display-safe.js';
import {
  HostedZoneNameNotFoundError,
  parseRecordSetCompositeId,
  recordSetCompositeId,
  templateZoneVisibility,
} from './shared.js';

/**
 * Adopt an existing Route 53 resource into cdkd state.
 *
 * Supported types: `AWS::Route53::HostedZone` (AUTO-RESOLVED from the
 * template's `Name` since issue #1702, with an explicit `--resource`
 * override still taking precedence);
 * `AWS::Route53::RecordSet` (override-only — the supplied id is
 * CANONICALIZED rather than trusted, using the template's
 * `HostedZoneId` / `HostedZoneName` + `Name` + `Type` and verified
 * against AWS, but an import with no override still declines because
 * a RecordSet has no standalone identity for auto mode to key on).
 */
export async function importImpl(
  this: Route53Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::Route53::HostedZone':
      return this.importHostedZone(input);
    case 'AWS::Route53::RecordSet':
      return this.importRecordSet(input);
    default:
      return null;
  }
}

/**
 * Does a parsed composite agree with the properties recorded alongside it?
 *
 * Called from all THREE sites that split a stored id back apart —
 * `importRecordSet`'s early accept, `resolveRecordSetIdentity`, and
 * `deleteRecordSet` — because `parseRecordSetCompositeId` asks only for three
 * NON-EMPTY segments, which a record NAME carrying two pipes satisfies
 * (issue #1711), and places a name carrying `|` only as a candidate (#3890).
 *
 * Each check is applied only when the template side is a usable string, so an
 * unresolved intrinsic or an absent field leaves the pre-#1711 behavior
 * exactly as it was. When BOTH are unusable this returns `true` and the
 * mis-decode is still reachable — an accepted bound, since the alternative is
 * refusing every id on a bag cdkd cannot read, and the identity resolution the
 * fall-through leads to needs those same fields anyway.
 *
 * The NAME check is what catches the residual the TYPE check alone leaves: a
 * name like `a|b|A` on a record whose `Type` really is `A` agrees on the type
 * and still decodes to the wrong zone. The TYPE check is in turn the sole
 * discriminator only where the NAME is unusable, which is why both are here.
 *
 * **A false REJECTION is what this must not do, and the argument is
 * REACHABILITY rather than cost.** The cost differs per caller and is not
 * uniformly small: at `deleteRecordSet` the fall-through re-resolves the zone
 * with `requireUnambiguousZoneName`, which THROWS on a split-horizon
 * `HostedZoneName` and would turn a working destroy into a failed one. It
 * cannot fire, because every composite is packed from the same
 * `properties['Name']` / `['Type']` the engine records beside it — create,
 * update and the import canonicalization all use one bag — so a genuine
 * composite always agrees with the bag it is stored with. `Type` being
 * updateable does not break that: `update()` returns the RE-PACKED id, which
 * is recorded together with the new properties. The one real divergence is
 * cosmetic and absorbed on purpose — `canonicalizeQueryName` makes the name
 * compare case- and trailing-dot-insensitive, so a template spelling the name
 * without CDK's dot is not rejected.
 *
 * Note two of the three callers pass a STATE-borne bag rather than a template
 * one; the reachability argument above is what covers them.
 *
 * **A name carrying `|` is the exception to "usable only" (issue #3890).**
 * Such a parse is only the first-and-last-separator CANDIDATE, so it is
 * accepted only when BOTH `Name` and `Type` are usable strings and agree.
 * The `Name` match is what makes that sound: the middle of a longer id is
 * strictly shorter than the id, so CloudFormation's scalar physicalId (the
 * record name itself, recorded beside the same `Name`) can never pass, and
 * neither can an id whose zone or type segment held a stray `|`. An
 * unanchored candidate falls through to the identity resolution from the
 * recorded properties, which never reads the id's segments.
 */
export function compositeAgreesWithTemplate(
  this: Route53Provider,
  parsed: { hostedZoneId: string; name: string; type: string; nameCarriesSeparator: boolean },
  properties: Record<string, unknown>
): boolean {
  const usable = (value: unknown): boolean => typeof value === 'string' && value !== '';
  if (parsed.nameCarriesSeparator && !(usable(properties['Type']) && usable(properties['Name']))) {
    return false;
  }
  const templateType = properties['Type'];
  if (typeof templateType === 'string' && templateType && parsed.type !== templateType) {
    return false;
  }
  const templateName = properties['Name'];
  if (
    typeof templateName === 'string' &&
    templateName &&
    canonicalizeQueryName(parsed.name) !== canonicalizeQueryName(templateName)
  ) {
    return false;
  }
  return true;
}

/**
 * Adopt an existing record set (issue #1658).
 *
 * cdkd's physicalId is the composite `<hostedZoneId>|<Name>|<Type>` that
 * `createRecordSet` returns, but CloudFormation's is the record NAME alone.
 * In auto / `--migrate-from-cloudformation` mode `knownPhysicalId` is NOT a
 * user choice — the overrides are pre-populated from the CFn stack's
 * `DescribeStackResources` — so storing it verbatim wrote an id this
 * provider's own `delete` could not parse, and the migrated stack became
 * undestroyable with the defect only surfacing after the CFn stack had
 * already been retired.
 *
 * So re-canonicalize instead, the way `AWS::EC2::EIP` already does: an
 * already-composite override passes through (the documented
 * `--resource 'Id=zone|name|type'` form), anything else is rebuilt from the
 * template properties and VERIFIED against AWS.
 *
 * **Canonicalization is BEST-EFFORT and never drops the row.** When the
 * identity cannot be resolved or verified, the supplied id is adopted
 * VERBATIM with a warning rather than returning `null`. Returning `null`
 * there would be strictly worse than the bug this fixes: `import.ts` only
 * aborts when ZERO resources import, so under
 * `--migrate-from-cloudformation` the run proceeds to `UpdateStack(Retain)`
 * + `DeleteStack` and the record ends up in NEITHER CloudFormation nor cdkd
 * state — after which the next deploy CREATEs over a live RRSet and fails.
 * Adopting verbatim is safe now precisely because `deleteRecordSet` and
 * `readRecordSet` both accept the scalar form (the other half of this fix).
 *
 * The ordinary shape that makes verification legitimately fail is a
 * `HostedZoneId` still carrying an unresolved intrinsic: `import.ts`
 * pre-resolves only literal / pseudo-parameter `Ref` / `Fn::Join` /
 * `Fn::Sub` (`resolvePseudoParameterIntrinsics`) and a `{Ref}` to an
 * overridden resource (`substituteOverrideRefs`) before calling a provider,
 * so a `{Ref}` to a zone that is not overridden, or an `Fn::GetAtt`, stays
 * an object. A split-horizon zone name is refused for safety and lands here
 * too.
 * (Wildcard records used to fail here as well; `normalizeRecordName` now
 * decodes Route 53's octal escapes, so they canonicalize normally.)
 *
 * This stays OVERRIDE-ONLY (see the "sub-resources without a standalone
 * identity" list in docs/import.md): the id is now derived from the template
 * rather than trusted, but an import with no override at all still declines,
 * because a RecordSet has no standalone identity for auto mode to key on.
 */
export async function importRecordSet(
  this: Route53Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const known = input.knownPhysicalId;
  if (!known) return null;
  // The early accept has to be CROSS-CHECKED against the template, or it
  // becomes the mis-decode this whole guard exists to prevent (issue #1711,
  // found in review). `parseRecordSetCompositeId` only asks for three
  // non-empty segments — so a record NAME carrying two pipes,
  // `a|b|c.example.com.`, which is precisely the CloudFormation physicalId
  // `--migrate-from-cloudformation` pre-populates from
  // `DescribeStackResources`, parses as a "valid" composite and is adopted as
  // zone `a`, name `b`, type `c.example.com.`. `deleteRecordSet` then calls
  // `ChangeResourceRecordSets` against zone `a`, takes the `NoSuchHostedZone`
  // arm and reports SUCCESS while the real record stays live — the
  // silent-wrong-resource class, reached one layer above the packing sites.
  // A genuine composite agrees with the template on both segments it shares
  // with it; a disagreement means `known` is a raw name that merely looks
  // composite, so fall through and let the identity resolution below decide.
  const parsedKnown = parseRecordSetCompositeId(known);
  if (parsedKnown && this.compositeAgreesWithTemplate(parsedKnown, input.properties)) {
    return { physicalId: known, attributes: {} };
  }

  const adoptVerbatim = (reason: string): ResourceImportResult => {
    this.logger.warn(
      `Record set ${input.logicalId}: could not canonicalize physical id '${known}' (${reason}). ` +
        `Adopting it as-is — delete and drift both accept this form, but a later deploy that ` +
        `UPDATEs the record will rewrite it to cdkd's '<zoneId>|<name>|<type>' composite.`
    );
    return { physicalId: known, attributes: {} };
  };

  // A non-composite override IS CloudFormation's physicalId, i.e. the record
  // name; the template properties carry the same name plus the zone, so they
  // are the authoritative source either way.
  // The ambiguity guard matters MORE here than on delete: canonicalizing to
  // the wrong split-horizon zone FREEZES it into state, after which delete
  // parses the composite and never re-resolves — so the delete-time guard
  // can never fire. Verification cannot catch it either, because both zones
  // hold a record of that name. `resolveRecordSetIdentity` swallows the
  // refusal into `undefined`, which lands on the safe verbatim fallback.
  const identity = await this.resolveRecordSetIdentity(known, input.properties, {
    requireUnambiguousZoneName: true,
  });
  if (!identity) {
    return adoptVerbatim(
      'the template does not unambiguously resolve to a hosted zone + Name + Type'
    );
  }

  // A composite whose name carries `|` is decoded only by anchoring that name
  // on the recorded `Name`, so it is minted only when the template `Name` is
  // a usable string. Otherwise `identity.name` IS the verbatim id (an
  // unresolved intrinsic leaves nothing else to name the record by), every
  // later read would reject the candidate, and drift would read nothing --
  // so keep that id, as before issue #3890.
  const templateName = input.properties['Name'];
  if (
    identity.name.includes(COMPOSITE_ID_SEPARATOR) &&
    !(typeof templateName === 'string' && templateName !== '')
  ) {
    return adoptVerbatim(
      `the record name contains '${COMPOSITE_ID_SEPARATOR}' and the template Name is not a ` +
        `plain string to anchor it on`
    );
  }

  // A record name carrying `|` packs like any other (issue #3890): Route 53
  // accepts one, written either as the character or as the `\174` escape
  // ("DNS domain name format", Route 53 Developer Guide), and every reader
  // anchors the name on the recorded `Name` / `Type`. The verification reads
  // by the RESOLVED identity rather than re-parsing the id, which with no bag
  // beside it would not trust a name carrying `|`.
  const compositeId = recordSetCompositeId(identity.hostedZoneId, identity.name, identity.type);
  let observed: Record<string, unknown> | ResourceNotFound | undefined;
  try {
    observed = await this.readRecordSetAt(identity);
  } catch (err) {
    // The class at warn, AWS's text at debug (go-to-k/cdkd#2319).
    const head = `Record set ${input.logicalId}: verification of '${known}' failed: `;
    return adoptVerbatim(
      `verification failed: ${this.warnFailureText(head, err, undefined).replace(/\.$/, '')}`
    );
  }
  if (!observed || observed === RESOURCE_NOT_FOUND) {
    return adoptVerbatim('the record was not found under the resolved hosted zone');
  }

  return { physicalId: compositeId, attributes: {} };
}

/**
 * The attribute set for a hosted zone adopted through the NAME-lookup
 * branch (issue #1875). `null` means DECLINE the row.
 *
 * Unlike the `knownPhysicalId` branch — whose verification call already
 * carries the delegation set — this branch resolves the zone through
 * `ListHostedZonesByName`, which does NOT return one, so the attributes
 * cost one extra `GetHostedZone`.
 *
 * **A vanished zone DECLINES, it does not degrade.** `NoSuchHostedZone`
 * between the list and this read is exactly the condition the
 * `knownPhysicalId` branch answers with `null` / `skipped-not-found`, and
 * adopting a zone that demonstrably no longer exists is worse than
 * declining it — the next deploy would compare against a record for
 * something AWS does not have. The two branches must agree; everything
 * else degrades.
 *
 * **The degraded answer is the EMPTY map, and that is load-bearing rather
 * than tidy.** `import.ts`'s attribute carry-over (`reimportedAttributes`)
 * keeps the stored map only when the returned map is EMPTY — a gate
 * that exists precisely because almost every provider spells
 * `attributes: {}` explicitly. So a partial `{ Id }` is NON-empty, takes
 * the row branch, and OVERWRITES a previously-recorded good map: a zone
 * imported successfully once and re-imported while `route53:GetHostedZone`
 * is denied would LOSE its stored `NameServers`, leaving state strictly
 * worse than before this fix. `{}` falls through and preserves it. Do NOT
 * "improve" this into keeping what it can — that is the one change that
 * makes the failure path destructive.
 *
 * NEVER throws otherwise, matching the convention the neighbouring
 * adoption paths already use (`AppSyncProvider.childImportAttributes`,
 * issue #1728, and `importRecordSet`'s canonicalization, which adopts
 * VERBATIM rather than declining): an import must not hard-fail because
 * one optional attribute could not be read. `import.ts` only aborts when
 * ZERO resources import, so under `--migrate-from-cloudformation` a throw
 * here would cost the row at exactly the moment the CloudFormation stack
 * is being retired — the resource would end up in NEITHER CloudFormation
 * nor cdkd state.
 */
export async function hostedZoneImportAttributes(
  this: Route53Provider,
  zoneId: string,
  logicalId: string
): Promise<Record<string, unknown> | null> {
  try {
    const response = await this.getClient().send(new GetHostedZoneCommand({ Id: zoneId }));
    return { Id: zoneId, NameServers: response.DelegationSet?.NameServers ?? [] };
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchHostedZone') return null;
    // The command names the logical id and the zone id only when plain, and
    // AWS's message ends its own line so the command starts the next one
    // (go-to-k/cdkd#4226). `zoneId` is the id AWS's own listing returned,
    // gated all the same, as every other value on a command line is.
    const zoneShown = isPlainImportValue(zoneId) ? zoneId : VALUE_NOT_SHOWN;
    const zoneArg = isPasteableIdent(zoneId) ? zoneId : commandHole('hostedZoneId');
    const importCommand = pasteableCommand('cdkd import', [
      { literal: '--resource' },
      { literal: `${remedyLogicalId(logicalId)}=${zoneArg}` },
      { literal: '--force' },
    ]).command;
    const head = `Imported hosted zone ${zoneShown} but could not read its NameServers: `;
    this.logger.warn(
      head +
        `${this.warnFailureText(head, error, undefined)}\n` +
        `The zone is adopted without them (any attributes already in state for this ` +
        `zone are kept). Re-run ` +
        `${proseQuoted(importCommand, '`')} once the permission ` +
        `is granted, or make a template change that forces an UPDATE — a plain ` +
        `${proseQuoted(cdkdRemedy('cdkd deploy'), '`')} does NOT heal the record, because an unchanged zone is ` +
        `NO_CHANGE and never calls update().`
    );
    return {};
  }
}

/**
 * Adopt an existing hosted zone (issue #1702).
 *
 * An explicit `--resource` id is ground truth and is only VERIFIED. With no
 * override, the zone is resolved from the template's `Name` via
 * `ListHostedZonesByName` — the physical-name route docs/import.md's
 * Auto-resolved section documents, which this method declined to take until
 * now, so a type the table listed as auto-resolved silently reported
 * `skipped-not-found` and (under `--migrate-from-cloudformation`) was left
 * out of state after the CloudFormation stack had already been retired.
 *
 * Three properties of the lookup matter and none of them is incidental:
 * the query name is canonicalized to AWS's ordering key
 * (`canonicalizeQueryName`) so a bounded page cannot skip past the zone; a
 * name matching MORE than one zone is REFUSED rather than guessed at
 * (split-horizon DNS), except that the template's own `VPCs` first narrows
 * the match to the public or private side (`templateZoneVisibility`), which
 * is what makes the ordinary split-horizon pair resolve cleanly; and the
 * two ways of failing are kept DISTINCT — a proven absence returns `null`
 * (`skipped-not-found`, the next deploy creates the zone) while an
 * ambiguous name or a failed lookup throws, which `importOne` records as
 * `failed` for this row alone.
 *
 * BOTH branches record the same `{ Id, NameServers }` attribute set a
 * `cdkd deploy` CREATE records (issue #1875). Recording `attributes: {}`
 * left an adopted zone with no `NameServers` in state, and nothing else
 * rescues it: `resolveGetAtt`'s (`deployment/intrinsic-resolver/getatt.ts`) flat-attribute
 * branch misses (so PR #1868's legacy comma-string normalization, which
 * lives in that branch, never runs either), `constructAttribute` has no
 * `AWS::Route53::HostedZone` case, and resolution falls through to
 * `guardedPhysicalIdFallback`, which hands back the zone id STRING — so a
 * downstream `Fn::Join` threw `second argument must be a list` and the
 * Output was silently dropped. `provider.getAttribute` does return the list
 * but is only reached from the orphan-rewriter path, never from ordinary
 * template resolution.
 *
 * The delegation set is normalized `?? []` — a LIST, never a comma string —
 * exactly as `createHostedZone` / `updateHostedZone` / `getHostedZoneAttribute`
 * do, so an imported zone and a deployed one resolve IDENTICALLY. A
 * divergence here would be a phantom-drift hazard as well as a resolution
 * one.
 *
 * **A plain `cdkd deploy` does NOT rewrite these attributes**, so do not
 * offer one as the remedy when a read fails. `deploy-engine.ts` `continue`s
 * on `NO_CHANGE`, so an unchanged zone never reaches `update()` and its
 * `attributes` are never rewritten; `kickOffAutoRefreshObservedProperties`
 * refreshes `observedProperties`, a different field. What DOES rewrite the
 * record is re-running the import for that row
 * (`cdkd import --resource <logicalId>=<zoneId> --force`, which re-enters
 * this method) or a template change that forces a real UPDATE.
 */
export async function importHostedZone(
  this: Route53Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      // The verification call is ALSO the attribute read — the delegation
      // set rides the response cdkd already awaits, so this branch adds no
      // AWS call and no new failure mode. A `NoSuchHostedZone` still means
      // "not found" and anything else still propagates, unchanged.
      const response = await this.getClient().send(
        new GetHostedZoneCommand({ Id: input.knownPhysicalId })
      );
      return {
        physicalId: input.knownPhysicalId,
        attributes: {
          // STRIPPED with the same `replace` `createHostedZone` uses. The
          // override is accepted in either spelling — the SDK's
          // `idNormalizerMiddleware` removes the prefix on the wire, so
          // `--resource MyZone=/hostedzone/Z123` verifies fine — and
          // recording it verbatim would persist `Id: '/hostedzone/Z123'`
          // where a deploy records `Z123`, i.e. the "identical attribute
          // set" this method promises would be false for that form.
          // `physicalId` is deliberately left as SUPPLIED: normalizing it
          // changes the recorded identity of already-adopted zones, which
          // is a separate decision from the attribute's shape.
          Id: input.knownPhysicalId.replace('/hostedzone/', ''),
          NameServers: response.DelegationSet?.NameServers ?? [],
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchHostedZone') return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). What IS available is the template's own physical-name
  // property — a hosted zone's `Name` — which is the FIRST of the two
  // auto-resolution routes docs/import.md documents, and the route this
  // provider declined to take until issue #1702.
  const zoneName = input.properties['Name'];
  if (typeof zoneName !== 'string' || !zoneName) return null;

  try {
    const zoneId = await this.resolveHostedZoneId(
      { HostedZoneName: zoneName },
      input.logicalId,
      input.resourceType,
      undefined,
      {
        requireUnambiguousZoneName: true,
        requirePrivateZone: templateZoneVisibility(input.properties),
        subject: {
          noun: 'hosted zone',
          // The fragment names the logical id only when plain, and the
          // placeholder is a quoted hole: a bare `<hostedZoneId>` redirects
          // when the line is pasted (go-to-k/cdkd#4226).
          remedy: `pass --resource ${remedyLogicalId(input.logicalId)}=${commandHole('hostedZoneId')} to adopt it explicitly`,
        },
      }
    );
    const attributes = await this.hostedZoneImportAttributes(zoneId, input.logicalId);
    // `null` = the zone vanished between the lookup and the read. Decline
    // the row, exactly as the `knownPhysicalId` branch does for the same
    // condition, rather than adopting a zone AWS no longer has.
    if (attributes === null) return null;
    return { physicalId: zoneId, attributes };
  } catch (error) {
    // A SOUND negative is an ordinary not-found: `import.ts` reports
    // `skipped-not-found` and the next deploy CREATEs the zone, which is
    // exactly right for a template describing a zone that does not exist.
    if (error instanceof HostedZoneNameNotFoundError) return null;

    // Everything else PROPAGATES, matching the `knownPhysicalId` branch
    // above. `importOne` in `import.ts` catches per resource and records
    // `outcome: 'failed'` with the message, so a throw costs this ONE row
    // and never aborts the run — which makes it strictly better than
    // declining: an ambiguous name and a denied `route53:ListHostedZonesByName`
    // are both reported as what they are, instead of being flattened into
    // `skipped-not-found`'s "no matching AWS resource" (misleading for the
    // first, wrong for the second, and under `--migrate-from-cloudformation`
    // wrong at exactly the moment the CFn stack is being retired). Both
    // messages already name the `--resource` remedy via `subject.remedy`.
    throw error;
  }
}
