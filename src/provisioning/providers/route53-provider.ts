import {
  Route53Client,
  CreateHostedZoneCommand,
  DeleteHostedZoneCommand,
  GetHostedZoneCommand,
  ChangeResourceRecordSetsCommand,
  UpdateHostedZoneCommentCommand,
  UpdateHostedZoneFeaturesCommand,
  ChangeTagsForResourceCommand,
  AssociateVPCWithHostedZoneCommand,
  DisassociateVPCFromHostedZoneCommand,
  CreateQueryLoggingConfigCommand,
  DeleteQueryLoggingConfigCommand,
  ListQueryLoggingConfigsCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  ListTagsForResourceCommand,
  HostedZoneAlreadyExists,
  type CreateHostedZoneCommandInput,
  type CreateHostedZoneCommandOutput,
  type HostedZone,
  type ListHostedZonesByNameCommandOutput,
  type ResourceRecordSet,
  type RRType,
  type VPCRegion,
} from '@aws-sdk/client-route-53';
import { getLogger } from '../../utils/logger.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { readConfigString } from '../config-shape.js';
import { acquireIdempotencyToken } from './idempotency-token.js';
import {
  COMPOSITE_ID_SEPARATOR,
  compositeIdSeparatorRefusal,
  packCompositeId,
} from '../composite-id.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';

/**
 * True when Route 53 refused a zone mutation because the zone's
 * AcceleratedRecoveryStatus is mid-transition — the
 * "HostedZone <id> is marked disabled for mutation" rejection (issue #1467).
 * Exported for the delete-path retry in this provider and for tests; the
 * same substring is also in `RETRYABLE_ERROR_MESSAGE_PATTERNS` so the
 * generic retry net covers the create/update paths.
 */
export function isZoneDisabledForMutationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('is marked disabled for mutation');
}

/**
 * A `HostedZoneName` that resolved cleanly but matches no zone.
 *
 * Distinct from "no zone was specified": the DELETE path treats a vanished
 * zone as already-gone (the zone's records went with it) rather than surfacing
 * a misconfiguration error that would block `cdkd destroy`.
 */
class HostedZoneNameNotFoundError extends ProvisioningError {
  constructor(
    message: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string,
    cause?: Error
  ) {
    super(message, resourceType, logicalId, physicalId, cause);
    this.name = 'HostedZoneNameNotFoundError';
    // REQUIRED: `CdkdError`'s constructor chain ends with
    // `Object.setPrototypeOf(this, ProvisioningError.prototype)`, which erases
    // the subclass identity — without re-setting it here, `instanceof
    // HostedZoneNameNotFoundError` is FALSE for an instance of this class and
    // the delete path's skip-as-gone arm silently never fires.
    Object.setPrototypeOf(this, HostedZoneNameNotFoundError.prototype);
  }
}

/** Segment count of cdkd's `AWS::Route53::RecordSet` composite physicalId. */
const RECORD_SET_COMPOSITE_SEGMENTS = 3;

/**
 * Parse cdkd's composite record-set physicalId `<hostedZoneId>|<Name>|<Type>`.
 *
 * Returns `undefined` for anything else — most importantly CloudFormation's
 * OWN physicalId for this type, which is the record name alone (`Ref` on an
 * `AWS::Route53::RecordSet` returns the domain name, and a DNS name can never
 * contain `|`). `cdkd import` stored that scalar verbatim before issue #1658,
 * so state files in the wild carry BOTH shapes and every consumer has to know
 * which one it is holding.
 */
export function parseRecordSetCompositeId(
  physicalId: string
): { hostedZoneId: string; name: string; type: string } | undefined {
  const parts = physicalId.split('|');
  if (parts.length !== RECORD_SET_COMPOSITE_SEGMENTS) return undefined;
  const [hostedZoneId, name, type] = parts as [string, string, string];
  if (!hostedZoneId || !name || !type) return undefined;
  return { hostedZoneId, name, type };
}

/**
 * Octal escapes that must NOT be decoded, because decoding them is not
 * injective — two genuinely different names would compare EQUAL:
 *
 * - `056` is a period INSIDE a label. Route 53 reports the single-label
 *   record `a.b` (period escaped) as `a\\056b.example.com.`, which decodes to
 *   `a.b.example.com.` — identical to the different, two-label record
 *   `a.b.example.com`.
 * - `134` is a literal backslash, which would re-introduce escape ambiguity.
 *
 * A false MATCH is far worse than a false miss here: the compare drives which
 * record `readCurrentState` reports and which hosted zone `create` picks, so
 * collapsing two records would target the wrong one.
 */
const UNDECODABLE_OCTAL_ESCAPES = new Set(['056', '134']);

/**
 * Canonicalize a record name for comparison.
 *
 * Two AWS-side spellings have to be absorbed, and missing either one makes
 * `readCurrentState` return `undefined` — which reads as "drift unknown"
 * rather than as an error:
 *
 * - Route 53 reports every name fully qualified with a TRAILING DOT, while a
 *   template may declare it either way.
 * - Special characters come back OCTAL-ESCAPED: `*.example.com` is reported as
 *   `\\052.example.com.`. That affects every wildcard record, including ones
 *   cdkd created itself, so decoding it here fixes drift for the whole
 *   population rather than only the imported ones.
 *
 * Known bound: Route 53 escapes per BYTE, so a non-ASCII name decodes to
 * latin-1 mojibake and will not match its template spelling. That is a false
 * MISS (drift unknown), never a false match, and CDK emits punycode for
 * internationalized names in practice.
 */
function normalizeRecordName(name: string): string {
  // `\\ddd` -> the character it encodes. Strictly octal digits, and never the
  // structure-significant escapes above.
  const decoded = name.replace(/\\([0-7]{3})/g, (match, oct: string) =>
    UNDECODABLE_OCTAL_ESCAPES.has(oct) ? match : String.fromCharCode(parseInt(oct, 8))
  );
  // DNS is case-insensitive and AWS lowercases what it returns, so compare
  // lowercased. Without this a template spelling `Example.com` fails to match
  // the zone AWS reports as `example.com.` — which, on the delete path, now
  // resolves to "zone is gone" and would DROP the state row while leaving the
  // record live in AWS.
  const lowered = decoded.toLowerCase();
  return lowered.endsWith('.') ? lowered : `${lowered}.`;
}

/**
 * Is this value ONLY an unresolved intrinsic — `{Ref: …}` / `{Fn::If: […]}` —
 * rather than a real object with members?
 *
 * `import.ts` substitutes only single-key `{Ref}` before calling a provider,
 * so an element behind a condition reaches `import()` in this shape.
 */
function isIntrinsicOnly(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || (keys[0] ?? '').startsWith('Fn::'));
}

/**
 * Read a hosted zone's PUBLIC-vs-PRIVATE visibility off its own template
 * properties (issue #1702), for the `import()` name lookup's zone filter.
 *
 * CloudFormation has no `PrivateZone` property — visibility is implied by
 * `VPCs`: a zone associated with at least one VPC is private, one with none is
 * public. So:
 *
 * - `VPCs` ABSENT -> `false` (public). This is the CDK `PublicHostedZone`
 *   shape and by far the common one.
 * - an array carrying at least one element that is NOT purely an unresolved
 *   intrinsic -> `true` (private). Such an element proves the template
 *   attaches a VPC unconditionally, even when the `VPCId` inside it is itself
 *   a `Ref` this provider cannot resolve.
 * - anything else -> `undefined` (do not narrow), and the caller's ambiguity
 *   guard then refuses rather than adopting the wrong zone. Three shapes land
 *   here and each would otherwise be a GUESS: a non-array (an unresolved
 *   intrinsic is a truthy OBJECT); an EMPTY array (more likely a
 *   condition-collapsed value than a deliberate "public"); and — the one that
 *   is easy to miss — an array whose every element is intrinsic-only
 *   (`[{Ref: 'AWS::NoValue'}]`, the CFn spelling of a conditionally-absent
 *   element), which is non-empty yet may resolve to a PUBLIC zone.
 */
function templateZoneVisibility(properties: Record<string, unknown>): boolean | undefined {
  const vpcs = properties['VPCs'];
  if (vpcs == null) return false;
  if (!Array.isArray(vpcs)) return undefined;
  const attachesAVpc = vpcs.some(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && !isIntrinsicOnly(v)
  );
  return attachesAVpc ? true : undefined;
}

/**
 * Canonicalize a name for the QUERY side of a Route 53 list call.
 *
 * `normalizeRecordName` above is the COMPARE-side canonicalizer, and the two
 * are deliberately NOT the same function. Route 53 orders both hosted zones
 * and record sets by reversed labels of the name it STORES — lower-cased and
 * escape-ENCODED — and a `DNSName` / `StartRecordName` start key in any other
 * spelling positions the window somewhere else entirely. So the query side
 * must move TOWARD AWS's spelling (lower-case, encode `*`), where the compare
 * side moves AWS's answer toward the template's (decode escapes).
 *
 * Decoding here would be actively wrong: `*.example.com` sorts at `*` (0x2A)
 * while AWS stores `\052.example.com` and sorts it at `\` (0x5C), so every
 * name whose first label begins with `-` / `+` / a digit / an upper-case
 * letter falls BETWEEN them — with a bounded page, the wildcard record we
 * asked for is skipped straight past.
 */
function canonicalizeQueryName(name: string): string {
  const lowered = name.toLowerCase().replaceAll('*', '\\052');
  return lowered.endsWith('.') ? lowered : `${lowered}.`;
}

/**
 * AWS Route 53 Provider
 *
 * Implements resource provisioning for Route 53 resources:
 * - AWS::Route53::HostedZone
 * - AWS::Route53::RecordSet
 *
 * WHY: Route 53 operations are synchronous - the CC API adds unnecessary polling
 * overhead for operations that complete immediately. This SDK provider eliminates
 * that polling and returns instantly.
 */
export class Route53Provider implements ResourceProvider {
  private route53Client?: Route53Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('Route53Provider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Route53::HostedZone',
      new Set([
        'Name',
        'HostedZoneConfig',
        'HostedZoneTags',
        'VPCs',
        'QueryLoggingConfig',
        'HostedZoneFeatures',
      ]),
    ],
    [
      'AWS::Route53::RecordSet',
      new Set([
        'HostedZoneId',
        'HostedZoneName',
        'Name',
        'Type',
        'TTL',
        'ResourceRecords',
        'AliasTarget',
        'SetIdentifier',
        'Weight',
        'Region',
        'Failover',
        'MultiValueAnswer',
        'HealthCheckId',
        'Comment',
        'GeoLocation',
        'GeoProximityLocation',
        'CidrRoutingConfig',
      ]),
    ],
  ]);

  private getClient(): Route53Client {
    if (!this.route53Client) {
      this.route53Client = new Route53Client({
        ...awsClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.route53Client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.createHostedZone(logicalId, resourceType, properties);
      case 'AWS::Route53::RecordSet':
        return this.createRecordSet(logicalId, resourceType, properties, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.updateHostedZone(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::Route53::RecordSet':
        return this.updateRecordSet(logicalId, physicalId, resourceType, properties, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.deleteHostedZone(logicalId, physicalId, resourceType, context);
      case 'AWS::Route53::RecordSet':
        return this.deleteRecordSet(logicalId, physicalId, resourceType, properties, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.getHostedZoneAttribute(physicalId, attributeName);
      default:
        return undefined;
    }
  }

  // ─── AWS::Route53::HostedZone ──────────────────────────────────────

  private async createHostedZone(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Route 53 hosted zone ${logicalId}`);

    const name = properties['Name'] as string;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for hosted zone ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const hostedZoneConfig = properties['HostedZoneConfig'] as
        | Record<string, unknown>
        | undefined;
      // Refuse a malformed container rather than silently dropping the comment
      // (issue #1493): the truthiness gate below indexes it, so a string /
      // array / unresolved intrinsic would yield `undefined` and no comment.
      const createComment = readConfigString(
        hostedZoneConfig,
        'Comment',
        '',
        'AWS::Route53::HostedZone HostedZoneConfig'
      );

      // VPCs property (for private hosted zones)
      const vpcs = properties['VPCs'] as Array<Record<string, unknown>> | undefined;
      // For CreateHostedZone, only one VPC can be specified; additional VPCs are associated after creation
      const firstVpc = vpcs && vpcs.length > 0 ? vpcs[0] : undefined;

      // Issue #2039. `CallerReference` IS Route 53's idempotency key, and this
      // used to be `${logicalId}-${Date.now()}` — regenerated on every
      // re-invocation of `create()`, which is the worst shape of all: the call
      // LOOKS idempotent while a deploy-engine retry of a 500 whose zone was
      // actually created mints a SECOND hosted zone for the same domain (Route
      // 53 permits that precisely when the caller reference differs), with its
      // own NS delegation set, no state record, and no route to `cdkd destroy`.
      //
      // The token is stable across attempts of THIS create, so the replay is
      // refused with `HostedZoneAlreadyExists` and adopted below. It is
      // released once the zone is recorded, and on the rollback path that
      // deletes it, so a later create of the same logical id starts fresh.
      const callerReferenceToken = acquireIdempotencyToken({
        scope: 'CreateHostedZone',
        logicalId,
        // Route 53 accepts up to 128 characters for CallerReference.
        maxLength: 128,
      });

      const response = await this.createOrAdoptHostedZone({
        Name: name,
        CallerReference: callerReferenceToken.value,
        ...(createComment !== ''
          ? {
              HostedZoneConfig: {
                Comment: createComment,
                // When VPCs are specified, this is a private hosted zone
                ...(firstVpc ? { PrivateZone: true } : {}),
              },
            }
          : firstVpc
            ? { HostedZoneConfig: { PrivateZone: true } }
            : {}),
        ...(firstVpc
          ? {
              VPC: {
                VPCId: firstVpc['VPCId'] as string,
                VPCRegion: firstVpc['VPCRegion'] as VPCRegion | undefined,
              },
            }
          : {}),
      });

      const hostedZone = response.HostedZone;
      if (!hostedZone?.Id) {
        throw new Error('CreateHostedZone did not return HostedZone.Id');
      }

      // Extract zone ID without /hostedzone/ prefix
      const zoneId = hostedZone.Id.replace('/hostedzone/', '');

      // Associate additional VPCs (index 1+) after creation
      if (vpcs && vpcs.length > 1) {
        for (let i = 1; i < vpcs.length; i++) {
          const additionalVpc = vpcs[i]!;
          this.logger.debug(
            `Associating additional VPC ${String(additionalVpc['VPCId'])} with hosted zone ${zoneId}`
          );
          await this.getClient().send(
            new AssociateVPCWithHostedZoneCommand({
              HostedZoneId: zoneId,
              VPC: {
                VPCId: additionalVpc['VPCId'] as string,
                VPCRegion: additionalVpc['VPCRegion'] as VPCRegion | undefined,
              },
            })
          );
        }
      }

      // Apply tags (HostedZoneTags)
      await this.applyHostedZoneTags(zoneId, properties, logicalId);

      // Configure query logging
      await this.applyQueryLoggingConfig(zoneId, properties, logicalId);

      // `HostedZoneFeatures.AcceleratedRecoveryStatus`: post-create
      // control-plane call. CreateHostedZone does NOT accept this field;
      // it requires a separate UpdateHostedZoneFeatures call AFTER the
      // zone is created. Same pattern as RecursiveLoop on Lambda::Function
      // (PR #719). AWS default is DISABLED, so we only call AWS when the
      // template explicitly requests ENABLED (calling with `false` would
      // be a no-op API hit). Failure here triggers `delete-on-post-create-
      // failure` atomicity — delete the just-created hosted zone before
      // bubbling the error, otherwise the next deploy retry sees an orphan
      // zone (live on AWS, not in cdkd state) and CREATE-collides.
      const desiredAcceleratedRecovery = (
        properties['HostedZoneFeatures'] as Record<string, unknown> | undefined
      )?.['AcceleratedRecoveryStatus'] as string | undefined;
      if (desiredAcceleratedRecovery === 'ENABLED') {
        try {
          await this.getClient().send(
            new UpdateHostedZoneFeaturesCommand({
              HostedZoneId: zoneId,
              EnableAcceleratedRecovery: true,
            })
          );
        } catch (uhfError) {
          this.logger.error(
            `UpdateHostedZoneFeatures failed for ${zoneId} after CreateHostedZone — rolling back the hosted zone to keep deploy retry idempotent`
          );
          try {
            // Detach query logging config first (applied above as part of
            // create()). AWS rejects DeleteHostedZone with
            // HostedZoneNotEmpty when a logging config is still attached,
            // so a template that sets BOTH `QueryLoggingConfig` and
            // `HostedZoneFeatures.AcceleratedRecoveryStatus: ENABLED`
            // would leak the zone if the UHF rollback skipped this step.
            await this.deleteQueryLoggingConfigForZone(zoneId, logicalId);
            await this.getClient().send(new DeleteHostedZoneCommand({ Id: zoneId }));
            // Released only after the delete SUCCEEDED, and the ORDER is what
            // matters here rather than the release itself. Route 53 does not
            // retain a DELETED zone's caller reference, so reusing one whose
            // zone is gone would simply create a new zone -- the release on
            // this arm is hygiene (it retires a generation nothing can adopt),
            // and a test cannot distinguish its presence from its absence.
            // Releasing BEFORE the delete is a different matter and is fenced:
            // a delete that FAILS leaves the zone live, and a retry that had
            // lost the caller reference would create a second zone beside an
            // orphan cdkd state never names, where keeping it adopts the zone.
            callerReferenceToken.release();
          } catch (deleteError) {
            this.logger.warn(
              `Best-effort rollback DeleteHostedZone for ${zoneId} also failed: ${
                deleteError instanceof Error ? deleteError.message : String(deleteError)
              } — operator may need to clean up the orphan zone`
            );
          }
          const cause = uhfError instanceof Error ? uhfError : undefined;
          throw new ProvisioningError(
            `Failed to enable Accelerated Recovery on hosted zone ${logicalId} (${zoneId}): ${
              uhfError instanceof Error ? uhfError.message : String(uhfError)
            }`,
            resourceType,
            logicalId,
            zoneId,
            cause
          );
        }
      }

      // Collect name servers
      const nameServers = response.DelegationSet?.NameServers ?? [];

      this.logger.debug(`Successfully created hosted zone ${logicalId}: ${zoneId}`);

      callerReferenceToken.release();
      return {
        physicalId: zoneId,
        attributes: {
          Id: zoneId,
          NameServers: nameServers,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * `CreateHostedZone`, with the retry-replay case ADOPTED rather than failed
   * (issue [#2039](https://github.com/go-to-k/cdkd/issues/2039)).
   *
   * A stable `CallerReference` stops a replayed create from minting a second
   * zone, but on its own it converts the replay into a hard
   * `HostedZoneAlreadyExists` — so the first attempt's zone would still be live
   * and still absent from state, only now the deploy fails as well. Route 53
   * reports the caller reference back on every `HostedZone`, which is what lets
   * the replay find the zone the lost response described and continue with it.
   *
   * The lookup is `ListHostedZonesByName`, which starts at the requested DNS
   * name and returns zones in name order, so the walk stops as soon as the name
   * changes rather than paging the whole account. A `GetHostedZone` follows,
   * because only that call returns the `DelegationSet` whose `NameServers` are
   * the resource's `Fn::GetAtt` value — an adopted zone must return the same
   * attributes a first-attempt create would have.
   *
   * Finding nothing rethrows the original error: a caller reference AWS says is
   * taken but that names no zone we can see is not something to paper over.
   */
  private async createOrAdoptHostedZone(
    input: CreateHostedZoneCommandInput
  ): Promise<Partial<Pick<CreateHostedZoneCommandOutput, 'HostedZone' | 'DelegationSet'>>> {
    try {
      return await this.getClient().send(new CreateHostedZoneCommand(input));
    } catch (error) {
      // `instanceof` alone is not enough: a duplicate `@aws-sdk/client-route-53`
      // anywhere in the tree gives the error a different class object, and the
      // adopt path would then silently never run.
      const isAlreadyExists =
        error instanceof HostedZoneAlreadyExists ||
        (error as { name?: string } | undefined)?.name === 'HostedZoneAlreadyExists';
      if (!isAlreadyExists) {
        throw error;
      }
      // The lookup is best-effort and must never REPLACE the diagnosis. A
      // missing `route53:ListHostedZonesByName` / `route53:GetHostedZone`
      // permission would otherwise surface as `AccessDenied`, sending the next
      // reader after a permissions problem instead of the caller-reference
      // collision that actually happened.
      let adopted: HostedZone | undefined;
      try {
        adopted = await this.findHostedZoneByCallerReference(input.Name!, input.CallerReference!);
      } catch (lookupError) {
        this.logger.warn(
          `CreateHostedZone for ${input.Name} was refused as already-existing, and the lookup that would have adopted the existing zone failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}. Reporting the original error.`
        );
        throw error;
      }
      if (!adopted?.Id) {
        throw error;
      }
      this.logger.warn(
        `CreateHostedZone for ${input.Name} was replayed after a lost response; adopting the hosted zone ${adopted.Id} the previous attempt already created instead of creating a second one`
      );
      try {
        const described = await this.getClient().send(new GetHostedZoneCommand({ Id: adopted.Id }));
        return {
          HostedZone: described.HostedZone ?? adopted,
          ...(described.DelegationSet ? { DelegationSet: described.DelegationSet } : {}),
        };
      } catch (describeError) {
        this.logger.warn(
          `Adopted hosted zone ${adopted.Id} but could not read it back: ${describeError instanceof Error ? describeError.message : String(describeError)}. Reporting the original error rather than returning a zone with no NameServers.`
        );
        throw error;
      }
    }
  }

  /**
   * The hosted zone carrying `callerReference`, or `undefined`.
   *
   * Scoped to zones whose name matches `dnsName`: `ListHostedZonesByName` is
   * ordered by name, so once the name differs no later page can hold ours.
   */
  private async findHostedZoneByCallerReference(
    dnsName: string,
    callerReference: string
  ): Promise<HostedZone | undefined> {
    const wanted = canonicalizeQueryName(dnsName);
    let marker: { DNSName?: string; HostedZoneId?: string } | undefined = { DNSName: wanted };
    while (marker) {
      const page: ListHostedZonesByNameCommandOutput = await this.getClient().send(
        new ListHostedZonesByNameCommand({
          DNSName: marker.DNSName,
          ...(marker.HostedZoneId ? { HostedZoneId: marker.HostedZoneId } : {}),
        })
      );
      for (const zone of page.HostedZones ?? []) {
        if (canonicalizeQueryName(zone.Name ?? '') !== wanted) {
          return undefined;
        }
        if (zone.CallerReference === callerReference) {
          return zone;
        }
      }
      marker =
        page.IsTruncated && page.NextDNSName
          ? {
              DNSName: page.NextDNSName,
              ...(page.NextHostedZoneId ? { HostedZoneId: page.NextHostedZoneId } : {}),
            }
          : undefined;
    }
    return undefined;
  }

  private async updateHostedZone(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Route 53 hosted zone ${logicalId}: ${physicalId}`);

    try {
      const hostedZoneConfig = properties['HostedZoneConfig'] as
        | Record<string, unknown>
        | undefined;
      const comment = readConfigString(
        hostedZoneConfig,
        'Comment',
        '',
        'AWS::Route53::HostedZone HostedZoneConfig'
      );

      await this.getClient().send(
        new UpdateHostedZoneCommentCommand({
          Id: physicalId,
          Comment: comment,
        })
      );

      // Update tags. Passing the PREVIOUS side is what makes this a diff
      // rather than an add-only apply — a tag dropped from the template is
      // sent as a `RemoveTagKeys` entry (issue #1160).
      await this.applyHostedZoneTags(physicalId, properties, logicalId, previousProperties);

      // Update query logging config. The previous side likewise turns an
      // absent desired block from "nothing to do" into a REMOVAL.
      await this.applyQueryLoggingConfig(physicalId, properties, logicalId, previousProperties);

      // Note: VPC associations on update are complex (need to diff current vs desired).
      // For now, we handle VPCs that need to be added. Full diff requires GetHostedZone
      // to compare current VPCs, which we'll do here.
      await this.syncVPCAssociations(physicalId, properties, logicalId);

      // `HostedZoneFeatures.AcceleratedRecoveryStatus`: post-create
      // control-plane call, gated on the BOOLEAN-effective diff (i.e.
      // "is this zone supposed to have AcceleratedRecovery enabled").
      // Comparing the raw strings would fire an unnecessary AWS call for
      // `prev: undefined, next: 'DISABLED'` (both map to disabled — AWS
      // default; no transition needed). Removal of the property is
      // treated as DISABLED so a user dropping the template field
      // implicitly turns the feature off on the next deploy.
      const prevEnabled =
        ((previousProperties['HostedZoneFeatures'] as Record<string, unknown> | undefined)?.[
          'AcceleratedRecoveryStatus'
        ] as string | undefined) === 'ENABLED';
      const nextEnabled =
        ((properties['HostedZoneFeatures'] as Record<string, unknown> | undefined)?.[
          'AcceleratedRecoveryStatus'
        ] as string | undefined) === 'ENABLED';
      if (prevEnabled !== nextEnabled) {
        await this.getClient().send(
          new UpdateHostedZoneFeaturesCommand({
            HostedZoneId: physicalId,
            EnableAcceleratedRecovery: nextEnabled,
          })
        );
      }

      // Retrieve name servers
      const getResponse = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
      const nameServers = getResponse.DelegationSet?.NameServers ?? [];

      this.logger.debug(`Successfully updated hosted zone ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Id: physicalId,
          NameServers: nameServers,
        },
      };
    } catch (error) {
      // Pass a cdkd-typed error through instead of re-labelling it. The two
      // removal paths above now raise their own `ProvisioningError` (a removal
      // that did not land is never retried, so it has to be loud), and
      // re-wrapping would bury that specific, actionable message under a
      // generic "Failed to update hosted zone" — the #1268 defect the
      // `update-wrap-coverage` critic exists to block.
      if (error instanceof CdkdError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteHostedZone(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Route 53 hosted zone ${logicalId}: ${physicalId}`);

    try {
      // Delete query logging config before deleting hosted zone
      await this.deleteQueryLoggingConfigForZone(physicalId, logicalId);

      // AWS rejects DeleteHostedZone when Accelerated Recovery is ENABLED
      // (or ENABLING / any non-DISABLED state) with
      // "Cannot delete a hosted zone with accelerated recovery enabled.
      // Please disable first.". The feature toggle is an async control
      // plane API (UpdateHostedZoneFeatures) and the transition takes
      // ~2-10 minutes to settle. Issue the disable + poll for DISABLED
      // BEFORE attempting the zone delete so the destroy path is closed.
      await this.ensureAcceleratedRecoveryDisabledForDelete(physicalId, logicalId);

      await this.getClient().send(new DeleteHostedZoneCommand({ Id: physicalId }));
      this.logger.debug(`Successfully deleted hosted zone ${logicalId}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchHostedZone') {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Hosted zone ${physicalId} does not exist, skipping deletion`);
        return;
      }
      // Preserve actionable ProvisioningError messages thrown by
      // `ensureAcceleratedRecoveryDisabledForDelete` (e.g. the
      // operator-recovery prompt on `*_FAILED` / timeout) — re-wrapping
      // them with the generic "Failed to delete hosted zone" prefix
      // would bury the actionable text in the `cause` chain. Mirrors
      // the same guard in `createHostedZone`.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Pre-delete guard for `AWS::Route53::HostedZone:HostedZoneFeatures`.
   *
   * AWS rejects `DeleteHostedZone` while AcceleratedRecovery is anything
   * other than DISABLED (the feature uses an async control plane API —
   * `UpdateHostedZoneFeatures` — and AWS won't tear down a zone whose
   * feature state is still in flight). This helper:
   *
   *   1. Reads the current `HostedZone.Features.AcceleratedRecoveryStatus`.
   *      DISABLED / undefined / NoSuchHostedZone → return early (nothing
   *      to do, the delete will proceed normally or hit the existing
   *      NoSuchHostedZone short-circuit).
   *   2. ENABLING / ENABLING_HOSTED_ZONE_LOCKED → wait for the enable to
   *      settle (AWS rejects a disable while enabling is in flight), then
   *      fall through to the disable below.
   *   3. ENABLED → issue `UpdateHostedZoneFeatures(false)` then poll
   *      `GetHostedZone` until the status settles to DISABLED.
   *   4. DISABLING / DISABLING_HOSTED_ZONE_LOCKED → poll without re-issuing
   *      the toggle. The `*_HOSTED_ZONE_LOCKED` states are transient
   *      sub-states of the enable/disable transition (AWS briefly locks the
   *      zone mid-transition) — they settle to ENABLED / DISABLED on their
   *      own, so cdkd waits through them rather than treating them as a
   *      terminal failure.
   *   5. *_FAILED → surface the AWS error to the operator (out of scope for
   *      cdkd to recover automatically).
   *
   * Poll budget: env-overridable timeout (default 10 min) + interval
   * (default 15s; tests override via env to keep runs fast). Failure to
   * settle within the budget throws — the operator can either re-run
   * `cdkd state destroy` (poll resets) or disable manually.
   */
  private async ensureAcceleratedRecoveryDisabledForDelete(
    physicalId: string,
    logicalId: string
  ): Promise<void> {
    const client = this.getClient();
    const pollIntervalMs = Number.parseInt(
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] ?? '15000',
      10
    );
    const timeoutMs = Number.parseInt(
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] ?? '600000',
      10
    );

    const readStatus = async (): Promise<string | undefined> => {
      try {
        const resp = await client.send(new GetHostedZoneCommand({ Id: physicalId }));
        return resp.HostedZone?.Features?.AcceleratedRecoveryStatus;
      } catch (err) {
        if (err instanceof Error && err.name === 'NoSuchHostedZone') return undefined;
        throw err;
      }
    };

    const deadline = Date.now() + timeoutMs;

    // Genuinely terminal failure states — operator-recovery only. The
    // sentinel set is shared by both the initial check below and the
    // in-flight `waitFor` loop (a zone that transitions to `*_FAILED`
    // during the wait must surface the actionable failure error
    // immediately rather than racing the 10-min timeout). NOTE: the
    // `*_HOSTED_ZONE_LOCKED` states are deliberately NOT here — they are
    // transient sub-states of an in-flight enable/disable (AWS briefly
    // locks the zone mid-transition) and settle to ENABLED / DISABLED on
    // their own, so `waitFor` polls through them like any other in-flight
    // status instead of failing the destroy.
    const TERMINAL_FAILED = new Set<string>(['ENABLE_FAILED', 'DISABLE_FAILED']);

    // Helper: poll until status reaches one of `targets`, or throw on
    // timeout / failed-state transition.
    const waitFor = async (
      targets: ReadonlySet<string>,
      label: string
    ): Promise<string | undefined> => {
      while (Date.now() < deadline) {
        const status = await readStatus();
        if (status === undefined || targets.has(status)) return status;
        if (TERMINAL_FAILED.has(status)) {
          throw new ProvisioningError(
            `Cannot delete hosted zone ${logicalId} (${physicalId}): AcceleratedRecoveryStatus transitioned to '${status}' while waiting for ${label} — operator must resolve before destroy can proceed`,
            'AWS::Route53::HostedZone',
            logicalId,
            physicalId
          );
        }
        this.logger.debug(
          `Polling AcceleratedRecoveryStatus for ${physicalId}: ${status} (waiting for ${label}, will re-poll in ~${pollIntervalMs}ms)`
        );
        // Sleep in 1s slices to stay SIGINT-responsive (CTRL-C surfaces
        // within a second) while still respecting the configured
        // `pollIntervalMs` between AWS API hits — break early when the
        // overall deadline runs out.
        const sliceEnd = Math.min(Date.now() + pollIntervalMs, deadline);
        while (Date.now() < sliceEnd) {
          const tick = Math.min(1000, sliceEnd - Date.now());
          if (tick <= 0) break;
          await new Promise<void>((resolve) => setTimeout(resolve, tick));
        }
      }
      throw new ProvisioningError(
        `Timed out after ${timeoutMs}ms waiting for AcceleratedRecoveryStatus to reach ${label} on hosted zone ${logicalId} (${physicalId}); re-run \`cdkd state destroy\` or disable manually via \`aws route53 update-hosted-zone-features --hosted-zone-id ${physicalId} --no-enable-accelerated-recovery\``,
        'AWS::Route53::HostedZone',
        logicalId,
        physicalId
      );
    };

    let current = await readStatus();
    if (current === undefined || current === 'DISABLED') return;

    // Failed / locked states are operator-recovery only.
    if (TERMINAL_FAILED.has(current)) {
      throw new ProvisioningError(
        `Cannot delete hosted zone ${logicalId} (${physicalId}): AcceleratedRecoveryStatus is '${current}' — operator must resolve before destroy can proceed`,
        'AWS::Route53::HostedZone',
        logicalId,
        physicalId
      );
    }

    // Phase 1: if ENABLING, wait for the transition to settle (AWS rejects
    // `UpdateHostedZoneFeatures(false)` while ENABLING is in flight —
    // "Accelerated recovery is already being enabled for this hosted zone").
    if (current === 'ENABLING' || current === 'ENABLING_HOSTED_ZONE_LOCKED') {
      this.logger.debug(
        `Hosted zone ${physicalId} is ${current} (an enabling phase); waiting for it to settle before issuing disable`
      );
      current = await waitFor(new Set(['ENABLED', 'DISABLED']), 'ENABLED or DISABLED');
      if (current === undefined || current === 'DISABLED') return;
    }

    // Phase 2: issue disable when ENABLED, then wait for DISABLED. When
    // already DISABLING (raced with a prior in-flight disable), skip the
    // toggle and just wait.
    if (current === 'ENABLED') {
      this.logger.debug(
        `Hosted zone ${physicalId} is ENABLED; issuing UpdateHostedZoneFeatures(false) before delete`
      );
      await client.send(
        new UpdateHostedZoneFeaturesCommand({
          HostedZoneId: physicalId,
          EnableAcceleratedRecovery: false,
        })
      );
    } else if (current === 'DISABLING' || current === 'DISABLING_HOSTED_ZONE_LOCKED') {
      this.logger.debug(
        `Hosted zone ${physicalId} AcceleratedRecovery is already ${current} (a disabling phase); waiting for settle`
      );
    }

    const settled = await waitFor(new Set(['DISABLED']), 'DISABLED');
    this.logger.debug(
      `Hosted zone ${physicalId} AcceleratedRecoveryStatus settled to ${settled ?? 'undefined (zone gone)'}`
    );
  }

  private async getHostedZoneAttribute(
    physicalId: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'Id':
        return physicalId;
      case 'NameServers': {
        const response = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
        return response.DelegationSet?.NameServers ?? [];
      }
      default:
        return undefined;
    }
  }

  // ─── AWS::Route53::RecordSet ───────────────────────────────────────

  private async createRecordSet(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Route 53 record set ${logicalId}`);

    const hostedZoneId = await this.resolveHostedZoneId(properties, logicalId, resourceType);

    const recordName = properties['Name'] as string;
    const recordType = properties['Type'] as string;

    // Refuse a `|` in any segment BEFORE `ChangeResourceRecordSets` runs
    // (issue #1711, the route53 half of the #1672 sweep). `recordName` is
    // `properties['Name']` — the only TEMPLATE-chosen segment of this type's
    // composite, where `hostedZoneId` and `recordType` are AWS-generated / a
    // fixed enum. The blast radius is milder than the Glue sibling's because
    // `parseRecordSetCompositeId` demands EXACTLY three parts, so a four-part
    // id is REJECTED rather than mis-decoded into a different record — but the
    // deploy still records an id nothing can decode, which is what this guard
    // stops. Computed before the call so a refusal cannot orphan a record AWS
    // has already written.
    const compositeId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'hostedZoneId', value: hostedZoneId },
        { name: 'recordName', value: recordName },
        { name: 'recordType', value: recordType },
      ],
      // A reverse-replacement rollback creates from a STATE record, so the
      // refusal downgrades to a warning — no template edit can repair a value
      // an older binary already recorded.
      {
        // Issue #2176: the refusal QUOTES the offending segment value, on the
        // thrown arm (durable) and the warn arm (terminal) alike, so the masker
        // goes through unconditionally -- it is absent on the paths that have no
        // context, where it degrades to identity.
        maskSecrets: context?.maskSecrets,
        ...(context?.replayingState === true && {
          onRefusal: (message: string) => this.logger.warn(message),
        }),
      }
    );

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      const comment = properties['Comment'] as string | undefined;

      await this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            ...(comment ? { Comment: comment } : {}),
            Changes: [
              {
                Action: 'CREATE',
                ResourceRecordSet: resourceRecordSet,
              },
            ],
          },
        })
      );

      this.logger.debug(`Successfully created record set ${logicalId}: ${compositeId}`);

      return {
        physicalId: compositeId,
        attributes: {},
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create record set ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateRecordSet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Route 53 record set ${logicalId}: ${physicalId}`);

    const hostedZoneId = await this.resolveHostedZoneId(
      properties,
      logicalId,
      resourceType,
      physicalId
    );

    const recordName = properties['Name'] as string;
    const recordType = properties['Type'] as string;

    // The same guard as the create path, but the downgrade is UNCONDITIONAL
    // (issue #1711) — the `updateRoute` precedent, for the reason
    // `.claude/rules/providers.md` records: `update()` takes no
    // `CreateContext`, so it cannot tell a template-borne update from the
    // STATE-borne desired bag that `rollback-executor.ts`'s revert arm and
    // `cdkd drift --revert` both hand it. Refusing would make a record an
    // older binary already wrote under the ambiguous id un-revertable, with
    // no template edit that repairs it. So the pre-guard behavior stands here
    // and the ambiguous id becomes ANNOUNCED rather than silent, while the
    // refusal keeps its teeth on the create path, where the value is always
    // template-borne. Placed before the UPSERT and outside the `try` anyway,
    // so a future arm that DOES throw cannot be re-wrapped as "Failed to
    // update record set".
    const compositeId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'hostedZoneId', value: hostedZoneId },
        { name: 'recordName', value: recordName },
        { name: 'recordType', value: recordType },
      ],
      {
        onRefusal: (message: string) => this.logger.warn(message),
        // Issue #2176 -- see the sibling create site.
        maskSecrets: context?.maskSecrets,
      }
    );

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      const comment = properties['Comment'] as string | undefined;

      await this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            ...(comment ? { Comment: comment } : {}),
            Changes: [
              {
                Action: 'UPSERT',
                ResourceRecordSet: resourceRecordSet,
              },
            ],
          },
        })
      );

      this.logger.debug(`Successfully updated record set ${logicalId}`);

      return {
        physicalId: compositeId,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update record set ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteRecordSet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Route 53 record set ${logicalId}: ${physicalId}`);

    // We need the full record details for DELETE action
    if (!properties) {
      throw new ProvisioningError(
        `Properties required to delete record set ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // Parse composite ID: hostedZoneId|name|type. A physicalId that is NOT
    // the composite is CloudFormation's own form (the record name alone —
    // what `Ref` returns), written into state by `cdkd import` before issue
    // #1658. Throwing there left every migrated stack undestroyable, so fall
    // back to resolving the zone from the recorded properties — the delete
    // only needs segment 1; `Name` / `Type` come from `properties` anyway.
    // The parse is CROSS-CHECKED against the recorded properties (issue #1711):
    // three non-empty segments is not proof of a composite, so a record NAME
    // carrying two pipes — `a|b|c.example.com.`, the CloudFormation physicalId
    // `--migrate-from-cloudformation` pre-populates — decoded to hosted zone
    // `a`, and this delete then issued `ChangeResourceRecordSets` against a
    // zone that does not exist, took the `NoSuchHostedZone` already-deleted arm
    // and reported SUCCESS while the real record stayed live and billing. This
    // is the site where that class actually costs something, which is why the
    // check is applied at all three parse sites rather than only at `import`.
    const parsedComposite = parseRecordSetCompositeId(physicalId);
    const composite =
      parsedComposite && this.compositeAgreesWithTemplate(parsedComposite, properties)
        ? parsedComposite
        : undefined;
    let hostedZoneId: string;
    if (composite) {
      hostedZoneId = composite.hostedZoneId;
    } else {
      try {
        hostedZoneId = await this.resolveHostedZoneId(
          properties,
          logicalId,
          resourceType,
          physicalId,
          {
            // A DELETE resolved from a name must not guess between a public
            // and a private zone of the same name — deleting from the wrong
            // one is unrecoverable, and this fallback is what newly routes
            // delete here.
            requireUnambiguousZoneName: true,
          }
        );
      } catch (error) {
        if (error instanceof HostedZoneNameNotFoundError) {
          // The zone is gone, so its records are too. Delete is idempotent.
          const clientRegion = await this.getClient().config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          // WARN, not debug: this drops the state row, so if the diagnosis is
          // ever wrong the record is silently orphaned in AWS.
          this.logger.warn(
            `Hosted zone "${String(properties?.['HostedZoneName'])}" for record set ${logicalId} ` +
              `(${physicalId}) no longer exists; treating the record as already deleted and ` +
              `dropping it from state.`
          );
          return;
        }
        throw error;
      }
    }

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      const sendDelete = () =>
        this.getClient().send(
          new ChangeResourceRecordSetsCommand({
            HostedZoneId: hostedZoneId,
            ChangeBatch: {
              Changes: [
                {
                  Action: 'DELETE',
                  ResourceRecordSet: resourceRecordSet,
                },
              ],
            },
          })
        );

      try {
        await sendDelete();
      } catch (error) {
        // While the zone's AcceleratedRecoveryStatus is transitioning
        // (ENABLING / DISABLING / *_HOSTED_ZONE_LOCKED), Route 53 refuses
        // EVERY mutation with "HostedZone <id> is marked disabled for
        // mutation" (issue #1467). Record sets are deleted BEFORE the zone
        // in the destroy DAG, so the zone-side pre-delete guard
        // (`ensureAcceleratedRecoveryDisabledForDelete`) never runs first.
        // Wait for the transition to settle (ENABLED is fine — mutations
        // are allowed again; deliberately NOT disabling the feature here,
        // since a record-only delete must not flip a zone-level setting),
        // then retry the change once.
        if (!isZoneDisabledForMutationError(error)) throw error;
        this.logger.info(
          `Hosted zone ${hostedZoneId} is mid AcceleratedRecovery transition (marked disabled for mutation); waiting for it to settle before retrying delete of record set ${logicalId}`
        );
        await this.waitForAcceleratedRecoveryMutable(hostedZoneId, logicalId, resourceType);
        await sendDelete();
      }

      this.logger.debug(`Successfully deleted record set ${logicalId}`);
    } catch (error) {
      // Treat "not found" errors as success for idempotency
      if (
        error instanceof Error &&
        (error.name === 'InvalidChangeBatch' || error.message.includes('it was not found'))
      ) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Record set ${physicalId} does not exist, skipping deletion`);
        return;
      }
      if (error instanceof Error && error.name === 'NoSuchHostedZone') {
        this.logger.debug(
          `Hosted zone for record set ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      // Preserve actionable ProvisioningError messages thrown by
      // `waitForAcceleratedRecoveryMutable` (the `*_FAILED`
      // operator-recovery prompt and the settle timeout) — re-wrapping them
      // with the generic "Failed to delete record set" prefix would bury the
      // actionable text in the `cause` chain and swap the error's physicalId
      // from the zone id to the composite record id. Mirrors the same guard
      // in `deleteHostedZone`.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete record set ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Wait until the hosted zone's AcceleratedRecoveryStatus reaches a state
   * that ALLOWS mutations again (issue #1467).
   *
   * While the feature is transitioning (ENABLING / DISABLING /
   * *_HOSTED_ZONE_LOCKED) Route 53 marks the zone "disabled for mutation" and
   * refuses `ChangeResourceRecordSets`. Unlike the zone-delete guard
   * (`ensureAcceleratedRecoveryDisabledForDelete`) this helper does NOT
   * disable the feature — a record-set mutation is legal on an ENABLED zone,
   * and flipping a zone-level setting from a record delete would be a side
   * effect the template never asked for. It only polls until the status is
   * terminal-stable (ENABLED / DISABLED / zone gone), throwing on the
   * `*_FAILED` operator-recovery states and on timeout. Same env-overridable
   * poll knobs as the zone guard.
   */
  private async waitForAcceleratedRecoveryMutable(
    zoneId: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    const client = this.getClient();
    // Number.isFinite guards: a garbage env value would otherwise make the
    // deadline NaN (loop runs zero times and reports "Timed out after
    // NaNms") or interval 0 a busy-poll.
    const parsedInterval = Number.parseInt(
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] ?? '15000',
      10
    );
    const pollIntervalMs =
      Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 15000;
    const parsedTimeout = Number.parseInt(
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] ?? '600000',
      10
    );
    const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 600000;
    const deadline = Date.now() + timeoutMs;
    const TERMINAL_FAILED = new Set<string>(['ENABLE_FAILED', 'DISABLE_FAILED']);
    const MUTABLE = new Set<string>(['ENABLED', 'DISABLED']);

    while (Date.now() < deadline) {
      let status: string | undefined;
      try {
        const resp = await client.send(new GetHostedZoneCommand({ Id: zoneId }));
        status = resp.HostedZone?.Features?.AcceleratedRecoveryStatus;
      } catch (err) {
        if (err instanceof Error && err.name === 'NoSuchHostedZone') return;
        throw err;
      }
      if (status === undefined || MUTABLE.has(status)) return;
      if (TERMINAL_FAILED.has(status)) {
        throw new ProvisioningError(
          `Cannot mutate hosted zone ${zoneId}: AcceleratedRecoveryStatus is '${status}' — operator must resolve before the record set ${logicalId} can be deleted`,
          resourceType,
          logicalId,
          zoneId
        );
      }
      this.logger.debug(
        `Polling AcceleratedRecoveryStatus for ${zoneId}: ${status} (waiting for a mutable state, will re-poll in ~${pollIntervalMs}ms)`
      );
      // Sleep in 1s slices to stay SIGINT-responsive (same shape as the
      // zone-delete guard's poll loop).
      const sliceEnd = Math.min(Date.now() + pollIntervalMs, deadline);
      while (Date.now() < sliceEnd) {
        const tick = Math.min(1000, sliceEnd - Date.now());
        if (tick <= 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, tick));
      }
    }
    throw new ProvisioningError(
      `Timed out after ${timeoutMs}ms waiting for AcceleratedRecoveryStatus to reach a mutable state on hosted zone ${zoneId} (record set ${logicalId}); re-run the destroy once the transition settles`,
      resourceType,
      logicalId,
      zoneId
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Build a ResourceRecordSet object from CDK properties.
   *
   * Handles conversion of CDK-style ResourceRecords (array of strings)
   * to SDK-style ResourceRecords (array of {Value}).
   * Also handles routing policy properties: Weight, Region, Failover,
   * MultiValueAnswer, GeoLocation, GeoProximityLocation, CidrRoutingConfig,
   * SetIdentifier, and HealthCheckId.
   */
  private buildResourceRecordSet(properties: Record<string, unknown>): ResourceRecordSet {
    const name = properties['Name'] as string;
    const type = properties['Type'] as string;
    const ttl = properties['TTL'] as string | number | undefined;
    const resourceRecords = properties['ResourceRecords'] as unknown[] | undefined;
    const aliasTarget = properties['AliasTarget'] as Record<string, unknown> | undefined;

    const recordSet: ResourceRecordSet = {
      Name: name,
      Type: type as RRType,
    };

    if (aliasTarget) {
      recordSet.AliasTarget = {
        HostedZoneId: aliasTarget['HostedZoneId'] as string,
        DNSName: aliasTarget['DNSName'] as string,
        EvaluateTargetHealth: (aliasTarget['EvaluateTargetHealth'] as boolean) ?? false,
      };
    } else {
      // Standard record with TTL and ResourceRecords
      if (ttl !== undefined) {
        recordSet.TTL = Number(ttl);
      }

      if (resourceRecords) {
        // CDK provides ResourceRecords as array of strings,
        // SDK expects array of {Value: string}
        recordSet.ResourceRecords = resourceRecords.map((record) => {
          if (typeof record === 'string') {
            return { Value: record };
          }
          // Already in {Value: string} format
          return record as { Value: string };
        });
      }
    }

    // Routing policy properties — use `!== undefined` (not truthy) so a
    // valid falsy value from observedProperties (e.g. weight=0) is not
    // silently dropped on `cdkd drift --revert` round-trips.
    const setIdentifier = properties['SetIdentifier'] as string | undefined;
    if (setIdentifier !== undefined) {
      recordSet.SetIdentifier = setIdentifier;
    }

    const weight = properties['Weight'] as number | string | undefined;
    if (weight !== undefined) {
      recordSet.Weight = Number(weight);
    }

    const region = properties['Region'] as string | undefined;
    if (region !== undefined) {
      recordSet.Region = region as ResourceRecordSet['Region'];
    }

    const failover = properties['Failover'] as string | undefined;
    if (failover !== undefined) {
      recordSet.Failover = failover as ResourceRecordSet['Failover'];
    }

    const multiValueAnswer = properties['MultiValueAnswer'] as boolean | string | undefined;
    if (multiValueAnswer !== undefined) {
      recordSet.MultiValueAnswer =
        typeof multiValueAnswer === 'string'
          ? multiValueAnswer.toLowerCase() === 'true'
          : multiValueAnswer;
    }

    const healthCheckId = properties['HealthCheckId'] as string | undefined;
    if (healthCheckId !== undefined) {
      recordSet.HealthCheckId = healthCheckId;
    }

    const geoLocation = properties['GeoLocation'] as Record<string, unknown> | undefined;
    if (geoLocation) {
      recordSet.GeoLocation = {
        ...(geoLocation['ContinentCode'] !== undefined
          ? { ContinentCode: geoLocation['ContinentCode'] as string }
          : {}),
        ...(geoLocation['CountryCode'] !== undefined
          ? { CountryCode: geoLocation['CountryCode'] as string }
          : {}),
        ...(geoLocation['SubdivisionCode'] !== undefined
          ? { SubdivisionCode: geoLocation['SubdivisionCode'] as string }
          : {}),
      };
    }

    // Geoproximity routing — the CFn `GeoProximityLocation` object shares the
    // SDK PascalCase shape (`AWSRegion` / `LocalZoneGroup` /
    // `Coordinates: { Latitude, Longitude }` / `Bias`). Map each sub-field
    // when present (omit-when-absent) so a falsy value (e.g. `Bias: 0`) is not
    // dropped. AWS requires exactly one anchor (AWSRegion / LocalZoneGroup /
    // Coordinates) per request; cdkd forwards whatever the template supplied.
    const geoProximityLocation = properties['GeoProximityLocation'] as
      | Record<string, unknown>
      | undefined;
    if (geoProximityLocation) {
      const gpl: ResourceRecordSet['GeoProximityLocation'] = {};
      if (geoProximityLocation['AWSRegion'] !== undefined) {
        gpl.AWSRegion = geoProximityLocation['AWSRegion'] as string;
      }
      if (geoProximityLocation['LocalZoneGroup'] !== undefined) {
        gpl.LocalZoneGroup = geoProximityLocation['LocalZoneGroup'] as string;
      }
      const coordinates = geoProximityLocation['Coordinates'] as
        | Record<string, unknown>
        | undefined;
      if (coordinates) {
        gpl.Coordinates = {
          Latitude: coordinates['Latitude'] as string,
          Longitude: coordinates['Longitude'] as string,
        };
      }
      if (geoProximityLocation['Bias'] !== undefined) {
        gpl.Bias = Number(geoProximityLocation['Bias']);
      }
      recordSet.GeoProximityLocation = gpl;
    }

    // CIDR routing — the CFn `CidrRoutingConfig` object shares the SDK
    // PascalCase shape (`CollectionId` / `LocationName`). Map each sub-field
    // when present (omit-when-absent). CIDR routing is a routing policy, so a
    // `CidrRoutingConfig` RecordSet REQUIRES a `SetIdentifier` and the named
    // `CollectionId` must reference an existing `AWS::Route53::CidrCollection`
    // (Cloud-Control-provisioned by cdkd); cdkd forwards whatever the template
    // supplied and lets AWS validate.
    const cidrRoutingConfig = properties['CidrRoutingConfig'] as
      | Record<string, unknown>
      | undefined;
    if (cidrRoutingConfig) {
      const crc: ResourceRecordSet['CidrRoutingConfig'] = {} as NonNullable<
        ResourceRecordSet['CidrRoutingConfig']
      >;
      if (cidrRoutingConfig['CollectionId'] !== undefined) {
        crc.CollectionId = cidrRoutingConfig['CollectionId'] as string;
      }
      if (cidrRoutingConfig['LocationName'] !== undefined) {
        crc.LocationName = cidrRoutingConfig['LocationName'] as string;
      }
      recordSet.CidrRoutingConfig = crc;
    }

    return recordSet;
  }

  // ─── HostedZone Helpers ───────────────────────────────────────────

  /**
   * Apply tags to a hosted zone using ChangeTagsForResource.
   * CFn property: HostedZoneTags (array of {Key, Value}).
   *
   * `previousProperties` is passed on the UPDATE path only, and turns this
   * from an add-only apply into a real DIFF (issue #1160). Without it a tag
   * removed from the template stayed on the zone forever — the add-only shape
   * has no way to express a removal, and the `length === 0` early return made
   * clearing ALL tags a silent no-op. `ChangeTagsForResource` takes
   * `RemoveTagKeys` alongside `AddTags` in ONE call, and CloudFormation does
   * untag a removed tag (live A/B, 2026-08-10), so the previous-minus-desired
   * key set is sent as removals. Create keeps passing `undefined` — there is
   * nothing to remove from a zone that did not exist a moment ago.
   */
  private async applyHostedZoneTags(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string,
    previousProperties?: Record<string, unknown>
  ): Promise<void> {
    // A present-but-MALFORMED desired list must not be read as "the user
    // removed every tag". `readHostedZoneTags` collapses anything it cannot
    // use to a SHORTER list, which is indistinguishable from a real removal at
    // the value level — and acting on it would UNTAG a live zone on the
    // strength of an unresolved intrinsic. That is the destructive direction of
    // the "never infer a default from a possibly-malformed value" rule
    // (issues #1471 / #1493).
    //
    // The check is deliberately LOSSY-READ based, not just container-shaped: a
    // per-ELEMENT malformation (`[{ Key: { Ref: 'X' } }]`) is still "genuinely
    // an array", so a container-only guard would let exactly this destructive
    // case through one level down. Any entry the reader had to drop makes the
    // WHOLE list unusable.
    const desiredRaw = properties['HostedZoneTags'];
    if (desiredRaw != null && !Array.isArray(desiredRaw)) {
      this.logger.warn(
        `AWS::Route53::HostedZone HostedZoneTags must be an array on ${logicalId}; ` +
          `ignoring it and leaving the live tags untouched (no tag is added or removed)`
      );
      return;
    }

    const tags = this.readHostedZoneTags(properties);
    if (Array.isArray(desiredRaw) && tags.length !== desiredRaw.length) {
      this.logger.warn(
        `AWS::Route53::HostedZone HostedZoneTags on ${logicalId} carries ` +
          `${desiredRaw.length - tags.length} entr(y|ies) with a non-string Key or Value ` +
          `(check for an unresolved intrinsic); leaving the live tags untouched rather than ` +
          `applying a partial set or removing the tags those entries name`
      );
      return;
    }

    const previousTags = previousProperties
      ? this.readHostedZoneTags(previousProperties)
      : undefined;

    const desiredKeys = new Set(tags.map((t) => t.Key));
    // Removals are the previous side minus the desired side. Computing them
    // this way guarantees no key appears in BOTH lists, which the API would
    // otherwise have to arbitrate. De-duplicated because the previous side is
    // a STATE record and may legitimately carry a repeated key.
    const removeTagKeys = [
      ...new Set(
        (previousTags ?? [])
          .map((t) => t.Key)
          .filter((key) => key.length > 0 && !desiredKeys.has(key))
      ),
    ];

    if (tags.length === 0 && removeTagKeys.length === 0) return;

    try {
      await this.getClient().send(
        new ChangeTagsForResourceCommand({
          ResourceType: 'hostedzone',
          ResourceId: zoneId,
          ...(tags.length > 0 && {
            AddTags: tags.map((t) => ({ Key: t.Key, Value: t.Value })),
          }),
          ...(removeTagKeys.length > 0 && { RemoveTagKeys: removeTagKeys }),
        })
      );
      this.logger.debug(
        `Applied ${tags.length} tag(s) and removed ${removeTagKeys.length} tag(s) on hosted zone ${logicalId}`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A failed ADD is self-healing: the template still declares the tag, so
      // the next deploy retries it. A failed REMOVAL is NOT — this update
      // returns success, state is rewritten WITHOUT the tag, and the next
      // deploy's previous side no longer carries it, so the removal is never
      // attempted again and the tag survives on AWS forever with `cdkd diff`
      // reporting clean. That is precisely the #1160 failure mode this fix
      // exists to close, so a removal failure has to be loud.
      if (removeTagKeys.length > 0) {
        throw new ProvisioningError(
          `Failed to remove tag(s) ${removeTagKeys.join(', ')} from hosted zone ${logicalId}: ` +
            `${detail}. The removal will NOT be retried on the next deploy (state no longer ` +
            `records the tag), so it is reported instead of ignored.`,
          'AWS::Route53::HostedZone',
          logicalId,
          zoneId,
          error instanceof Error ? error : undefined
        );
      }
      this.logger.warn(`Failed to apply tags to hosted zone ${logicalId}: ${detail}`);
    }
  }

  /**
   * Read `HostedZoneTags` off a property bag, dropping entries whose shape an
   * unresolved intrinsic or a hand-authored L1 made unusable. Returns a
   * possibly-SHORTER list rather than throwing — the caller compares the length
   * against the raw input to decide whether the read was lossy, and only the
   * DESIRED side treats a lossy read as a refusal. The previous (state-borne)
   * side stays permissive: a record an older binary wrote must not block an
   * ordinary update, which a rollback replay could not then edit its way out of.
   *
   * `Value` is validated as well as `Key`. Route 53 rejects a tag whose value
   * is absent or non-string, and because Add and Remove ride the SAME
   * `ChangeTagsForResource` call, one bad value would fail the whole request —
   * silently taking the REMOVALS down with it.
   */
  private readHostedZoneTags(
    properties: Record<string, unknown>
  ): Array<{ Key: string; Value: string }> {
    const tags = properties['HostedZoneTags'];
    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is { Key: string; Value: string } => {
      if (typeof t !== 'object' || t === null) return false;
      const entry = t as { Key?: unknown; Value?: unknown };
      return typeof entry.Key === 'string' && typeof entry.Value === 'string';
    });
  }

  /**
   * Apply QueryLoggingConfig to a hosted zone.
   * CFn property: QueryLoggingConfig ({ CloudWatchLogsLogGroupArn }).
   * Only one query logging config per hosted zone is allowed.
   */
  private async applyQueryLoggingConfig(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string,
    previousProperties?: Record<string, unknown>
  ): Promise<void> {
    const cloudWatchLogsLogGroupArn = this.readQueryLogGroupArn(properties);

    // A present-but-MALFORMED desired block must not be read as a REMOVAL —
    // deleting a live query-logging config on the strength of an unresolved
    // intrinsic is the destructive direction of the #1471 / #1493 rule.
    //
    // "Malformed" here means a NON-OBJECT container, or an object whose
    // `CloudWatchLogsLogGroupArn` is PRESENT but unusable (an unresolved
    // intrinsic renders as `{ CloudWatchLogsLogGroupArn: { Ref: … } }`). An
    // object that simply LACKS the key — `{}` — is treated as ABSENT, i.e. a
    // genuine removal, because that is exactly what this provider's own
    // `readHostedZone` emits as the canonical "no live config": `cdkd drift`
    // hands `observedProperties` back as the desired side on `--revert`, so
    // warning on `{}` would fire on every hosted-zone revert and tell the user
    // to omit a block they never wrote.
    const desiredBlock = properties['QueryLoggingConfig'];
    const desiredBlockIsObject =
      typeof desiredBlock === 'object' && desiredBlock !== null && !Array.isArray(desiredBlock);
    const desiredArnPresent =
      desiredBlockIsObject &&
      (desiredBlock as Record<string, unknown>)['CloudWatchLogsLogGroupArn'] !== undefined;
    const desiredUnusable =
      cloudWatchLogsLogGroupArn === undefined &&
      desiredBlock != null &&
      (!desiredBlockIsObject || desiredArnPresent);

    if (desiredUnusable) {
      this.logger.warn(
        `AWS::Route53::HostedZone QueryLoggingConfig on ${logicalId} carries no usable ` +
          `CloudWatchLogsLogGroupArn; leaving the live query logging config untouched ` +
          `(omit the block entirely to delete it)`
      );
      return;
    }

    if (cloudWatchLogsLogGroupArn === undefined) {
      // REMOVAL (issue #1160). `previousProperties` is supplied on the UPDATE
      // path only, so create still returns silently for an absent block.
      // Dropping `QueryLoggingConfig` from the template used to leave the live
      // config in place: query logging kept writing to CloudWatch — and kept
      // billing — with the template saying otherwise and `cdkd diff` reporting
      // no changes, i.e. permanently invisible. CloudFormation deletes it
      // (live A/B, 2026-08-10).
      //
      // Gated on the PREVIOUS side actually having carried a config rather
      // than firing on every update: a `ListQueryLoggingConfigs` probe per
      // hosted-zone update would cost a call on every deploy to discover
      // nothing, and deleting a config cdkd never created is out of scope for
      // a removal reset (that is drift, which `cdkd drift` owns).
      if (previousProperties !== undefined && this.readQueryLogGroupArn(previousProperties)) {
        this.logger.debug(
          `QueryLoggingConfig removed from template for hosted zone ${logicalId}; deleting the live config`
        );
        // `deleteQueryLoggingConfigForZone` swallows its own failures, which is
        // right on the create + delete paths that call it. On the REMOVAL path
        // it is not: this update returns success, state is rewritten without
        // `QueryLoggingConfig`, and the next deploy's previous side no longer
        // carries it — so a swallowed failure means the config keeps writing to
        // CloudWatch, and billing, forever with `cdkd diff` clean. That is the
        // exact #1160 failure mode, so verify the delete actually happened.
        await this.deleteQueryLoggingConfigForZone(zoneId, logicalId);
        const remaining = await this.listQueryLoggingConfigIds(zoneId);
        if (remaining.length > 0) {
          throw new ProvisioningError(
            `QueryLoggingConfig was removed from the template for hosted zone ${logicalId} but ` +
              `the live config (${remaining.join(', ')}) is still present. The removal will NOT ` +
              `be retried on the next deploy (state no longer records the property), so it is ` +
              `reported instead of ignored.`,
            'AWS::Route53::HostedZone',
            logicalId,
            zoneId
          );
        }
      }
      return;
    }

    try {
      // Delete existing query logging config first (only one allowed per zone)
      await this.deleteQueryLoggingConfigForZone(zoneId, logicalId);

      await this.getClient().send(
        new CreateQueryLoggingConfigCommand({
          HostedZoneId: zoneId,
          CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
        })
      );
      this.logger.debug(`Applied query logging config to hosted zone ${logicalId}`);
    } catch (error) {
      // QueryLoggingConfigAlreadyExists is not fatal if we tried to delete first
      if (error instanceof Error && error.name === 'QueryLoggingConfigAlreadyExists') {
        this.logger.debug(`Query logging config already exists for hosted zone ${logicalId}`);
        return;
      }
      this.logger.warn(
        `Failed to apply query logging config to hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Read `QueryLoggingConfig.CloudWatchLogsLogGroupArn` off a property bag,
   * returning `undefined` for an absent block, a malformed container, or a
   * blank / non-string ARN. One helper so the DESIRED and PREVIOUS sides
   * cannot classify the same shape differently — an asymmetry there would
   * make a removal fire (or not) depending on which side was malformed.
   */
  private readQueryLogGroupArn(properties: Record<string, unknown>): string | undefined {
    const config = properties['QueryLoggingConfig'];
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
    const arn = (config as Record<string, unknown>)['CloudWatchLogsLogGroupArn'];
    return typeof arn === 'string' && arn.length > 0 ? arn : undefined;
  }

  /**
   * List the live query-logging config ids for a hosted zone.
   *
   * Used by the REMOVAL path to VERIFY the delete landed, because
   * `deleteQueryLoggingConfigForZone` deliberately swallows its failures and a
   * swallowed removal is permanent (see the call site). A zone that has gone
   * away counts as "no config", so the NotFound shapes resolve to `[]` rather
   * than failing the deploy on a resource that is already absent.
   */
  private async listQueryLoggingConfigIds(zoneId: string): Promise<string[]> {
    try {
      const response = await this.getClient().send(
        new ListQueryLoggingConfigsCommand({ HostedZoneId: zoneId })
      );
      return (response.QueryLoggingConfigs ?? [])
        .map((config) => config.Id)
        .filter((id): id is string => typeof id === 'string');
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'NoSuchHostedZone' || error.name === 'NoSuchQueryLoggingConfig')
      ) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Delete query logging config(s) for a hosted zone.
   */
  private async deleteQueryLoggingConfigForZone(zoneId: string, logicalId: string): Promise<void> {
    try {
      const listResponse = await this.getClient().send(
        new ListQueryLoggingConfigsCommand({ HostedZoneId: zoneId })
      );
      const configs = listResponse.QueryLoggingConfigs ?? [];
      for (const config of configs) {
        if (config.Id) {
          await this.getClient().send(new DeleteQueryLoggingConfigCommand({ Id: config.Id }));
          this.logger.debug(
            `Deleted query logging config ${config.Id} for hosted zone ${logicalId}`
          );
        }
      }
    } catch (error) {
      // NoSuchHostedZone or NoSuchQueryLoggingConfig are not fatal during cleanup
      if (
        error instanceof Error &&
        (error.name === 'NoSuchHostedZone' || error.name === 'NoSuchQueryLoggingConfig')
      ) {
        return;
      }
      this.logger.warn(
        `Failed to delete query logging config for hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Sync VPC associations for a private hosted zone during update.
   * Compares current VPC associations with desired ones and adds/removes as needed.
   */
  private async syncVPCAssociations(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string
  ): Promise<void> {
    const desiredVpcs = properties['VPCs'] as Array<Record<string, unknown>> | undefined;
    if (!desiredVpcs || desiredVpcs.length === 0) return;

    try {
      // Get current VPC associations
      const getResponse = await this.getClient().send(new GetHostedZoneCommand({ Id: zoneId }));
      const currentVpcs = getResponse.VPCs ?? [];

      const currentVpcIds = new Set(currentVpcs.map((v) => v.VPCId));
      const desiredVpcIds = new Set(desiredVpcs.map((v) => v['VPCId'] as string));

      // Associate new VPCs
      for (const vpc of desiredVpcs) {
        const vpcId = vpc['VPCId'] as string;
        if (!currentVpcIds.has(vpcId)) {
          this.logger.debug(`Associating VPC ${vpcId} with hosted zone ${zoneId}`);
          await this.getClient().send(
            new AssociateVPCWithHostedZoneCommand({
              HostedZoneId: zoneId,
              VPC: {
                VPCId: vpcId,
                VPCRegion: vpc['VPCRegion'] as VPCRegion | undefined,
              },
            })
          );
        }
      }

      // Disassociate removed VPCs (but never remove the last one)
      for (const vpc of currentVpcs) {
        if (vpc.VPCId && !desiredVpcIds.has(vpc.VPCId)) {
          // Don't disassociate if it would leave 0 VPCs
          if (currentVpcs.length <= 1) {
            this.logger.warn(
              `Cannot disassociate last VPC ${vpc.VPCId} from hosted zone ${logicalId}`
            );
            continue;
          }
          this.logger.debug(`Disassociating VPC ${vpc.VPCId} from hosted zone ${zoneId}`);
          await this.getClient().send(
            new DisassociateVPCFromHostedZoneCommand({
              HostedZoneId: zoneId,
              VPC: {
                VPCId: vpc.VPCId,
                VPCRegion: vpc.VPCRegion,
              },
            })
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Failed to sync VPC associations for hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ─── RecordSet Helpers ────────────────────────────────────────────

  /**
   * Resolve HostedZoneId from properties.
   * If HostedZoneId is provided, use it directly.
   * If HostedZoneName is provided, resolve it to a HostedZoneId via ListHostedZonesByName.
   *
   * `options.requirePrivateZone` narrows the name match to PRIVATE (`true`) or
   * PUBLIC (`false`) zones before the ambiguity decision below; leave it
   * undefined to match either. Split-horizon DNS is exactly a public and a
   * private zone sharing one name, so a caller that already knows which side
   * it wants resolves cleanly where the ambiguity guard would otherwise
   * refuse. `importHostedZone` is the one caller today, deriving the answer
   * from the template's own `VPCs` (declared = private, absent = public);
   * every RecordSet caller leaves it undefined, since a record set's template
   * says nothing about the zone's visibility.
   *
   * `options.subject` names what is being resolved FOR in the errors this
   * raises, and what remedy to point at. It exists because the messages are
   * user-facing and this helper is no longer RecordSet-only: telling someone
   * adopting a hosted zone to "pass the '<zoneId>|<name>|<type>' composite"
   * names a physicalId shape their resource does not have.
   */
  private async resolveHostedZoneId(
    properties: Record<string, unknown>,
    logicalId: string,
    resourceType: string,
    physicalId?: string,
    options?: {
      requireUnambiguousZoneName?: boolean;
      requirePrivateZone?: boolean | undefined;
      subject?: { noun: string; remedy: string };
    }
  ): Promise<string> {
    const subject = options?.subject ?? {
      noun: 'record set',
      remedy:
        "set HostedZoneId explicitly, or pass the '<zoneId>|<name>|<type>' composite via --resource",
    };
    // Guard the TYPE, not just presence: an unresolved intrinsic
    // (`Fn::ImportValue` / `Fn::GetAtt` / a Parameter `Ref`) is an OBJECT and
    // therefore truthy, so an unguarded read stringifies it to
    // `[object Object]` and sends that to AWS as a zone id.
    const hostedZoneId = properties['HostedZoneId'];
    if (typeof hostedZoneId === 'string' && hostedZoneId) return hostedZoneId;

    // Declared out here because the terminal throw below is outside the
    // branch: a lookup that FAILED must surface its cause rather than the
    // misleading "specify one of these" message.
    let lookupErrorMessage: string | undefined;
    let lookupErrorCause: Error | undefined;

    // Declared outside the try for the same reason the two lookup-error
    // bindings above are: the ambiguity + sound-negative decisions below sit
    // outside it and both read this.
    const narrowing = options?.requirePrivateZone !== undefined;

    const hostedZoneName = properties['HostedZoneName'];
    if (typeof hostedZoneName === 'string' && hostedZoneName) {
      // The lookup keeps its ORIGINAL warn-and-continue catch — a transient
      // failure here must still fall through to the "specify one of these"
      // error below rather than surfacing raw. The ambiguity decision is made
      // AFTER the try deliberately: raising inside it would make this catch a
      // conditional re-throw rather than a swallow, which un-protects the
      // `.send()` for the `update-wrap-coverage` critic (and would be a real
      // hazard if a later edit widened what the try covers).
      let matched: {
        Id?: string | undefined;
        Name?: string | undefined;
        Config?: { PrivateZone?: boolean | undefined } | undefined;
      }[] = [];
      // NOT "the lookup returned" — "an empty result PROVES the zone is gone".
      // Only this flag authorizes the delete path's already-deleted arm, which
      // drops a state row, so it stays false for every answer we cannot read
      // as a sound negative.
      let absenceIsSound = false;
      try {
        const response = await this.getClient().send(
          new ListHostedZonesByNameCommand({
            // Case-folded + encoded: this is the START KEY of AWS's ordering,
            // not a filter. Sending the template's spelling verbatim
            // positions the window by `Example.com` while AWS orders by
            // `example.com.`, so an existing zone can fall outside a bounded
            // page and read as ABSENT — which on the delete path drops the
            // state row and orphans the record. That is the failure the
            // compare-side case fold alone does NOT close.
            DNSName: canonicalizeQueryName(hostedZoneName),
            // Deliberately > 1: split-horizon DNS lets a public and a private
            // zone share one name, and `MaxItems: 1` silently picks whichever
            // AWS lists first. Callers that DELETE through this resolution ask
            // for the ambiguity to be refused instead.
            MaxItems: 5,
          })
        );
        const zones = response.HostedZones ?? [];
        // Normalize BOTH sides — AWS returns the trailing dot and escapes
        // special characters, the template may do neither.
        const normalizedName = normalizeRecordName(hostedZoneName);
        matched = zones.filter((z) => normalizeRecordName(z.Name ?? '') === normalizedName);
        // Visibility narrowing, BEFORE the ambiguity decision below: a
        // split-horizon pair is two zones of one name that differ only in
        // `Config.PrivateZone`, so a caller that knows which side it wants
        // gets a clean resolution instead of a refusal.
        if (narrowing) {
          matched = matched.filter(
            (z) => (z.Config?.PrivateZone ?? false) === options?.requirePrivateZone
          );
        }
        // AWS starts the page AT the requested key, so same-named zones are
        // the first entries and a page that shows a LATER zone has already
        // proven ours is not there. An EMPTY truncated page proves nothing —
        // and neither does a name we could not position confidently, so a
        // template spelling that already carries a backslash escape is
        // refused the negative rather than guessed at.
        //
        // NARROWING CHANGES WHAT "a zone was returned" PROVES. Without it,
        // this line is only ever reached with an EMPTY `matched`, so any
        // returned zone is a LATER one and the run of same-named zones is
        // provably over. With it, `matched` can be emptied by the visibility
        // filter while the whole page is same-named zones of the other side —
        // and if that page is TRUNCATED, the zone we want may be the next
        // entry. Treating that as a sound negative would decline a zone that
        // exists and let the next deploy CREATE a duplicate, so the narrowed
        // case demands the stronger evidence: a DIFFERENT name on the page
        // (the same-named run ended inside it) or an untruncated page.
        const sawLaterName = zones.some(
          (z) => normalizeRecordName(z.Name ?? '') !== normalizedName
        );
        absenceIsSound =
          !hostedZoneName.includes('\\') &&
          (narrowing
            ? sawLaterName || response.IsTruncated !== true
            : zones.length > 0 || response.IsTruncated !== true);
      } catch (error) {
        lookupErrorMessage = error instanceof Error ? error.message : String(error);
        lookupErrorCause = error instanceof Error ? error : undefined;
        this.logger.warn(
          `Failed to resolve HostedZoneName "${hostedZoneName}" for ${logicalId}: ${lookupErrorMessage}`
        );
      }

      if (matched.length > 1 && options?.requireUnambiguousZoneName) {
        // Split-horizon is the usual cause, but ONLY when nothing narrowed the
        // match — after a visibility filter the survivors are all on one side,
        // so naming public/private there would point at the wrong thing.
        const cause = narrowing ? '' : ' (split-horizon public/private DNS)';
        throw new ProvisioningError(
          `HostedZoneName "${hostedZoneName}" matches ${matched.length} hosted zones ` +
            `for ${logicalId}${cause}. Refusing to guess which one is meant — ${subject.remedy}.`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      const matchedZone = matched[0];
      if (matchedZone?.Id) {
        return matchedZone.Id.replace('/hostedzone/', '');
      }

      // A name WAS specified and the lookup returned a SOUND NEGATIVE —
      // materially different from "no zone was specified", and the delete path
      // treats it as already-gone rather than as a misconfiguration.
      if (absenceIsSound) {
        // Name the SIDE when one was required: "matches no hosted zone" would
        // be wrong for a template whose public twin is sitting right there.
        const visibility =
          options?.requirePrivateZone === undefined
            ? ''
            : options.requirePrivateZone
              ? 'private '
              : 'public ';
        throw new HostedZoneNameNotFoundError(
          `HostedZoneName "${hostedZoneName}" matches no ${visibility}hosted zone ` +
            `in this account/region for ${logicalId}`,
          resourceType,
          logicalId,
          physicalId
        );
      }
    }

    // Three ways to land here, and they are NOT the same failure. The middle
    // arm exists because reaching this line with a name in hand is possible
    // (the listing was INCONCLUSIVE — a truncated page that never showed a
    // later name, or a template spelling carrying a backslash escape we will
    // not position against AWS's ordering), and reporting that as "specify a
    // zone" names neither the cause nor a remedy for a user who did specify
    // one.
    throw new ProvisioningError(
      lookupErrorMessage
        ? `Could not resolve HostedZoneName "${String(hostedZoneName)}" for ${subject.noun} ` +
            `${logicalId}: ${lookupErrorMessage}`
        : typeof hostedZoneName === 'string' && hostedZoneName
          ? `Could not determine whether HostedZoneName "${hostedZoneName}" exists for ` +
            `${subject.noun} ${logicalId} — the hosted-zone listing ended before the name ` +
            `could be resolved either way, so cdkd will not assume it is absent. ` +
            `${subject.remedy}.`
          : `Either HostedZoneId or HostedZoneName is required for ${subject.noun} ${logicalId}`,
      resourceType,
      logicalId,
      physicalId,
      lookupErrorCause
    );
  }

  /**
   * Recover `(hostedZoneId, name, type)` for a record set from EITHER shape of
   * physicalId (issue #1658).
   *
   * cdkd's own composite carries all three. CloudFormation's physicalId is the
   * record name alone, so the zone has to be resolved from the recorded
   * properties — which is exactly what `createRecordSet` does, so the answer is
   * the same triple the composite would have held. Returns `undefined` (rather
   * than throwing) when the zone cannot be resolved, because both callers of
   * this helper treat "cannot determine" as "nothing to report" rather than as
   * a failure.
   */
  private async resolveRecordSetIdentity(
    physicalId: string,
    properties?: Record<string, unknown>,
    options?: { requireUnambiguousZoneName?: boolean }
  ): Promise<{ hostedZoneId: string; name: string; type: string } | undefined> {
    // Cross-checked against the template for the same reason `importRecordSet`
    // cross-checks its own early accept (issue #1711): three non-empty segments
    // is not proof of a composite, and a record NAME carrying two pipes decodes
    // to a different zone here just as it does there. Without `properties`
    // there is nothing to check against, so the pre-#1711 behavior stands.
    const composite = parseRecordSetCompositeId(physicalId);
    if (composite && (!properties || this.compositeAgreesWithTemplate(composite, properties))) {
      return composite;
    }
    if (!properties) return undefined;

    const name = typeof properties['Name'] === 'string' ? properties['Name'] : physicalId;
    const type = properties['Type'];
    if (!name || typeof type !== 'string' || !type) return undefined;

    try {
      const hostedZoneId = await this.resolveHostedZoneId(
        properties,
        'RecordSet',
        'AWS::Route53::RecordSet',
        physicalId,
        options
      );
      return { hostedZoneId, name, type };
    } catch (err) {
      // Both callers treat "cannot determine" as "nothing to report" rather
      // than as a failure, but say WHY at debug level — a swallowed throttle
      // or credential error is otherwise indistinguishable from a template
      // that simply does not name a zone.
      this.logger.debug(
        `Cannot resolve record-set identity for '${physicalId}': ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  /**
   * Read the AWS-current Route 53 resource configuration in CFn-property shape.
   *
   * Dispatch per resource type:
   *  - `HostedZone` → `GetHostedZone` (Name, HostedZoneConfig{Comment,
   *    PrivateZone}, VPCs from `VPCs[]`, HostedZoneTags via
   *    `ListTagsForResource(ResourceType=hostedzone, ResourceId=<idTail>)`
   *    with `aws:*` filtered out and the key omitted when empty).
   *    QueryLoggingConfig is surfaced via a follow-up
   *    `ListQueryLoggingConfigs(HostedZoneId)` (filter to the one
   *    config per zone — CFn enforces 0 or 1 — and reshape
   *    `CloudWatchLogsLogGroupArn` to match cdkd state).
   *  - `RecordSet` → `ListResourceRecordSets` filtered to the exact
   *    `(name, type)` pair from the composite physicalId
   *    (`{zoneId}|{name}|{type}`), or — for a state record carrying
   *    CloudFormation's scalar physicalId, written by `cdkd import`
   *    before issue #1658 — from the recorded properties, so drift is
   *    reported for those records instead of silently skipped.
   *    Surfaces TTL, ResourceRecords (with
   *    `[{Value}]` -> string[] re-shape to match cdkd state), AliasTarget,
   *    Weight, Region, Failover, MultiValueAnswer, HealthCheckId,
   *    GeoLocation, GeoProximityLocation, CidrRoutingConfig, SetIdentifier.
   *
   * Returns `undefined` when the parent zone is gone (`NoSuchHostedZone`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.readHostedZone(physicalId);
      case 'AWS::Route53::RecordSet':
        return this.readRecordSet(physicalId, properties);
      default:
        return undefined;
    }
  }

  private async readHostedZone(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let resp;
    try {
      resp = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchHostedZone') return undefined;
      throw err;
    }
    if (!resp.HostedZone) return undefined;

    const result: Record<string, unknown> = {};
    if (resp.HostedZone.Name !== undefined) result['Name'] = resp.HostedZone.Name;
    {
      const cfg: Record<string, unknown> = {
        Comment: resp.HostedZone.Config?.Comment ?? '',
      };
      if (resp.HostedZone.Config?.PrivateZone !== undefined) {
        cfg['PrivateZone'] = resp.HostedZone.Config.PrivateZone;
      }
      result['HostedZoneConfig'] = cfg;
    }
    // `HostedZoneFeatures.AcceleratedRecoveryStatus`: emit-when-present
    // (gated on `!== undefined`, NOT a default-when-absent placeholder).
    // GetHostedZone returns `HostedZone.Features?.AcceleratedRecoveryStatus`
    // only when the feature was explicitly toggled (zones older than the
    // 2025 feature launch may return undefined indefinitely); emitting a
    // phantom `{ AcceleratedRecoveryStatus: 'DISABLED' }` placeholder
    // would force guaranteed drift on every clean run for the typical
    // zone that never opted in.
    if (resp.HostedZone.Features?.AcceleratedRecoveryStatus !== undefined) {
      result['HostedZoneFeatures'] = {
        AcceleratedRecoveryStatus: resp.HostedZone.Features.AcceleratedRecoveryStatus,
      };
    }

    // Class 1: VPCs is a private-zone-only field. AWS rejects
    // AssociateVPCWithHostedZone on public zones, and emitting an empty
    // [] placeholder on a public zone fires false drift against state
    // that has no VPCs key. Gate on PrivateZone === true (the
    // discriminator) so public zones don't carry the placeholder.
    if (resp.HostedZone.Config?.PrivateZone === true) {
      result['VPCs'] = (resp.VPCs ?? []).map((v) => {
        const out: Record<string, unknown> = {};
        if (v.VPCId !== undefined) out['VPCId'] = v.VPCId;
        if (v.VPCRegion !== undefined) out['VPCRegion'] = v.VPCRegion;
        return out;
      });
    }

    // HostedZoneTags via ListTagsForResource. Route 53 ResourceId is the
    // zone id WITHOUT the "/hostedzone/" prefix.
    const idTail = physicalId.replace(/^\/hostedzone\//, '');
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceType: 'hostedzone', ResourceId: idTail })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.ResourceTagSet?.Tags);
      result['HostedZoneTags'] = tags;
    } catch (err) {
      this.logger.debug(
        `Route53 ListTagsForResource(${idTail}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // QueryLoggingConfig via ListQueryLoggingConfigs filtered to this
    // zone. CFn enforces 0 or 1 config per zone. Always-emit `{}`
    // placeholder when AWS has none — the union-walk on the v3
    // observedProperties baseline catches a console-side ADD of a
    // CloudWatchLogsLogGroupArn against the empty placeholder.
    try {
      const qlcResp = await this.getClient().send(
        new ListQueryLoggingConfigsCommand({ HostedZoneId: idTail })
      );
      const qlc = qlcResp.QueryLoggingConfigs?.[0];
      if (qlc?.CloudWatchLogsLogGroupArn) {
        result['QueryLoggingConfig'] = {
          CloudWatchLogsLogGroupArn: qlc.CloudWatchLogsLogGroupArn,
        };
      } else {
        result['QueryLoggingConfig'] = {};
      }
    } catch (err) {
      this.logger.debug(
        `Route53 ListQueryLoggingConfigs(${idTail}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
      result['QueryLoggingConfig'] = {};
    }

    return result;
  }

  private async readRecordSet(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const identity = await this.resolveRecordSetIdentity(physicalId, properties);
    if (!identity) return undefined;
    const { hostedZoneId, name, type } = identity;

    let resp;
    try {
      resp = await this.getClient().send(
        new ListResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          // Encoded start key, for the reason `canonicalizeQueryName`
          // records: AWS orders records on the name it STORES, so a template
          // spelling `*.example.com` positions at `*` (0x2A) while the record
          // sits at `\\052…` (0x5C) — every sibling whose first label starts
          // with `-` / `+` / a digit / an upper-case letter falls between
          // them, and a bounded page skips the record we asked for. Decoding
          // on the COMPARE side alone cannot fix that; the query has to
          // return the record first.
          StartRecordName: canonicalizeQueryName(name),
          StartRecordType: type as RRType,
          // Still > 1 after the encoding fix: a name can also carry escapes
          // this helper does not encode, and a few extra rows are free.
          MaxItems: 5,
        })
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchHostedZone') return undefined;
      throw err;
    }

    // ListResourceRecordSets returns records in lexicographic order starting
    // at StartRecordName/Type; the first match is exact only when both name
    // and type match what we asked for. Compare on the fully-qualified name:
    // AWS always reports the trailing dot, a template may declare it either
    // way, and the composite physicalId carries whatever the template wrote.
    const wantedName = normalizeRecordName(name);
    const recordSet = resp.ResourceRecordSets?.find(
      (r) => r.Name !== undefined && normalizeRecordName(r.Name) === wantedName && r.Type === type
    );
    if (!recordSet) return undefined;

    const result: Record<string, unknown> = {
      HostedZoneId: hostedZoneId,
      Name: name,
      Type: type,
    };
    // Class 1: TTL and ResourceRecords are mutually exclusive with
    // AliasTarget — AWS rejects ChangeResourceRecordSets that carries
    // both. Gate the standard-record fields on `!AliasTarget` so an
    // alias record's observed snapshot does NOT carry placeholder
    // `TTL` / `ResourceRecords: []` that would (a) fire false drift
    // against state which legitimately lacks those keys and (b) round-
    // trip into a structurally-invalid ChangeResourceRecordSets input
    // if buildResourceRecordSet is ever changed to forward both.
    if (!recordSet.AliasTarget) {
      if (recordSet.TTL !== undefined) result['TTL'] = recordSet.TTL;
      // CFn / cdkd state shape is string[]; SDK is [{Value}].
      result['ResourceRecords'] = (recordSet.ResourceRecords ?? [])
        .map((r) => r.Value)
        .filter((v): v is string => typeof v === 'string');
    }
    if (recordSet.AliasTarget) {
      const at: Record<string, unknown> = {};
      if (recordSet.AliasTarget.HostedZoneId !== undefined) {
        at['HostedZoneId'] = recordSet.AliasTarget.HostedZoneId;
      }
      if (recordSet.AliasTarget.DNSName !== undefined) {
        at['DNSName'] = recordSet.AliasTarget.DNSName;
      }
      if (recordSet.AliasTarget.EvaluateTargetHealth !== undefined) {
        at['EvaluateTargetHealth'] = recordSet.AliasTarget.EvaluateTargetHealth;
      }
      result['AliasTarget'] = at;
    }
    if (recordSet.SetIdentifier !== undefined) result['SetIdentifier'] = recordSet.SetIdentifier;
    if (recordSet.Weight !== undefined) result['Weight'] = recordSet.Weight;
    if (recordSet.Region !== undefined) result['Region'] = recordSet.Region;
    if (recordSet.Failover !== undefined) result['Failover'] = recordSet.Failover;
    if (recordSet.MultiValueAnswer !== undefined) {
      result['MultiValueAnswer'] = recordSet.MultiValueAnswer;
    }
    if (recordSet.HealthCheckId !== undefined) result['HealthCheckId'] = recordSet.HealthCheckId;
    if (recordSet.GeoLocation) {
      const geo: Record<string, unknown> = {};
      if (recordSet.GeoLocation.ContinentCode !== undefined) {
        geo['ContinentCode'] = recordSet.GeoLocation.ContinentCode;
      }
      if (recordSet.GeoLocation.CountryCode !== undefined) {
        geo['CountryCode'] = recordSet.GeoLocation.CountryCode;
      }
      if (recordSet.GeoLocation.SubdivisionCode !== undefined) {
        geo['SubdivisionCode'] = recordSet.GeoLocation.SubdivisionCode;
      }
      result['GeoLocation'] = geo;
    }
    if (recordSet.GeoProximityLocation) {
      const gpl: Record<string, unknown> = {};
      if (recordSet.GeoProximityLocation.AWSRegion !== undefined) {
        gpl['AWSRegion'] = recordSet.GeoProximityLocation.AWSRegion;
      }
      if (recordSet.GeoProximityLocation.LocalZoneGroup !== undefined) {
        gpl['LocalZoneGroup'] = recordSet.GeoProximityLocation.LocalZoneGroup;
      }
      if (recordSet.GeoProximityLocation.Coordinates) {
        const coords: Record<string, unknown> = {};
        if (recordSet.GeoProximityLocation.Coordinates.Latitude !== undefined) {
          coords['Latitude'] = recordSet.GeoProximityLocation.Coordinates.Latitude;
        }
        if (recordSet.GeoProximityLocation.Coordinates.Longitude !== undefined) {
          coords['Longitude'] = recordSet.GeoProximityLocation.Coordinates.Longitude;
        }
        gpl['Coordinates'] = coords;
      }
      if (recordSet.GeoProximityLocation.Bias !== undefined) {
        gpl['Bias'] = recordSet.GeoProximityLocation.Bias;
      }
      result['GeoProximityLocation'] = gpl;
    }
    if (recordSet.CidrRoutingConfig) {
      const crc: Record<string, unknown> = {};
      if (recordSet.CidrRoutingConfig.CollectionId !== undefined) {
        crc['CollectionId'] = recordSet.CidrRoutingConfig.CollectionId;
      }
      if (recordSet.CidrRoutingConfig.LocationName !== undefined) {
        crc['LocationName'] = recordSet.CidrRoutingConfig.LocationName;
      }
      result['CidrRoutingConfig'] = crc;
    }
    return result;
  }

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
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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
   * (issue #1711).
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
   */
  private compositeAgreesWithTemplate(
    parsed: { hostedZoneId: string; name: string; type: string },
    properties: Record<string, unknown>
  ): boolean {
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
   * `HostedZoneId` still carrying an unresolved intrinsic (`import.ts`
   * substitutes only single-key `{Ref}` before calling a provider). A
   * split-horizon zone name is refused for safety and lands here too.
   * (Wildcard records used to fail here as well; `normalizeRecordName` now
   * decodes Route 53's octal escapes, so they canonicalize normally.)
   *
   * This stays OVERRIDE-ONLY (see the "sub-resources without a standalone
   * identity" list in docs/import.md): the id is now derived from the template
   * rather than trusted, but an import with no override at all still declines,
   * because a RecordSet has no standalone identity for auto mode to key on.
   */

  private async importRecordSet(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const known = input.knownPhysicalId;
    if (!known) return null;
    // The early accept has to be CROSS-CHECKED against the template, or it
    // becomes the mis-decode this whole guard exists to prevent (issue #1711,
    // found in review). `parseRecordSetCompositeId` only asks for exactly three
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

    // An `import()` neither throws nor adopts an id it knows to be ambiguous
    // (issue #1711) — it takes this method's own escape hatch instead. The
    // verbatim id decodes to nothing, so `delete` / `drift` fall back to
    // resolving the record from the template properties, where the canonical
    // composite would have frozen a mis-arity id into state that nothing can
    // parse. Structurally near-unreachable — `identity.name` is the record
    // name, and Route 53 accepts a `|` in one only as the `\174` escape — so
    // this is the same defense-in-depth the sweep applied to the AWS-generated
    // segments elsewhere.
    const segments = [
      { name: 'hostedZoneId', value: identity.hostedZoneId },
      { name: 'recordName', value: identity.name },
      { name: 'recordType', value: identity.type },
    ];
    const importRefusal = compositeIdSeparatorRefusal(
      input.resourceType,
      input.logicalId,
      segments
    );
    if (importRefusal !== undefined) {
      // ONE warning, not two: `adoptVerbatim` already explains the consequence,
      // so the refusal is folded into its reason the way the EC2 EIP import arm
      // folds its own (`ec2-provider.ts`). The raw sentence is deliberately NOT
      // emitted here — it prescribes "rename the resource, or manage it outside
      // cdkd" and asserts the id "decodes back to a DIFFERENT resource", and
      // neither is true on this path: nothing is refused, the verbatim id
      // decodes to NOTHING, and the import succeeds.
      return adoptVerbatim(
        `the resolved hosted zone + Name + Type would pack an ambiguous id — ` +
          `a segment contains '${COMPOSITE_ID_SEPARATOR}', which cdkd uses as this type's ` +
          `physical-id separator`
      );
    }

    // Cannot throw — the predicate above is the same check `packCompositeId`
    // makes — but it stays the single spelling of the join so this site cannot
    // drift from the create / update ones.
    const compositeId = packCompositeId(input.resourceType, input.logicalId, segments);
    let observed: Record<string, unknown> | undefined;
    try {
      observed = await this.readRecordSet(compositeId);
    } catch (err) {
      return adoptVerbatim(
        `verification failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!observed) {
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
   * than tidy.** `import.ts`'s attribute carry-over is gated on the returned
   * map being NON-empty (`row.attributes && Object.keys(...).length > 0 ?
   * row.attributes : undefined`, then `?? priorAttributes ?? {}`) — a gate
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
  private async hostedZoneImportAttributes(
    zoneId: string,
    logicalId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.getClient().send(new GetHostedZoneCommand({ Id: zoneId }));
      return { Id: zoneId, NameServers: response.DelegationSet?.NameServers ?? [] };
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchHostedZone') return null;
      this.logger.warn(
        `Imported hosted zone ${zoneId} but could not read its NameServers: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `The zone is adopted without them (any attributes already in state for this ` +
          `zone are kept). Re-run ` +
          `\`cdkd import --resource ${logicalId}=${zoneId} --force\` once the permission ` +
          `is granted, or make a template change that forces an UPDATE — a plain ` +
          `\`cdkd deploy\` does NOT heal the record, because an unchanged zone is ` +
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
   * rescues it: `IntrinsicFunctionResolver.resolveGetAtt`'s flat-attribute
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
  private async importHostedZone(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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
            remedy: `pass --resource ${input.logicalId}=<hostedZoneId> to adopt it explicitly`,
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
}
