import type { ACMCertificateProvider } from '../acm-certificate-provider.js';
import {
  AddTagsToCertificateCommand,
  RemoveTagsFromCertificateCommand,
  UpdateCertificateOptionsCommand,
  type CertificateOptions,
} from '@aws-sdk/client-acm';
import { safeStringify } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import { withRemovalDefaults } from '../../update-removal.js';
import { replacedDeleteFailureVerdict } from '../../../deployment/rollback-executor/replaced-survivor.js';
import { certificateInUseByName, isCertificateInUseError } from './shared.js';

export async function update(
  this: ACMCertificateProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating ACM certificate ${logicalId}: ${physicalId}`);
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  // ACM certs are largely immutable. The fields that ARE mutable are
  // Tags and Options.CertificateTransparencyLoggingPreference. Anything
  // else → replace. `CertificateExport` cannot be updated after creation
  // (ACM `CertificateOptions.Export`; CloudFormation: Replacement), so a
  // change or removal of it replaces rather than being dropped.
  const immutableFields = [
    'DomainName',
    'ValidationMethod',
    'SubjectAlternativeNames',
    'DomainValidationOptions',
    'CertificateAuthorityArn',
    'CertificateExport',
    'KeyAlgorithm',
  ] as const;
  // A secret-derived value is recorded as its `{{resolve:...}}` reference
  // and handed here resolved, which is no change, so it must not REPLACE the
  // certificate (go-to-k/cdkd#4275). The physical id is the certificate ARN,
  // which carries none of these values, so the masker arm decides, and only
  // on a key the engine itself replaces on any change; ValidationMethod is
  // not one, so a secret-derived one still replaces. The writes below
  // address the certificate by its ARN and never send these keys.
  let changedImmutable: (typeof immutableFields)[number] | undefined;
  for (const k of immutableFields) {
    if (JSON.stringify(properties[k]) === JSON.stringify(previousProperties[k])) continue;
    // An absent CertificateExport IS `DISABLED` (CloudFormation's default),
    // and a readback can omit `Options.Export`: the pair is no change, so it
    // must not replace the certificate (a `drift --revert` reaches here).
    if (
      k === 'CertificateExport' &&
      (properties[k] ?? 'DISABLED') === (previousProperties[k] ?? 'DISABLED')
    ) {
      continue;
    }
    if (
      await unchangedBehindSecretReference({
        resourceType,
        key: k,
        desired: properties[k],
        previous: previousProperties[k],
        maskSecrets: context?.maskSecrets,
      })
    ) {
      continue;
    }
    changedImmutable = k;
    break;
  }
  if (changedImmutable) {
    this.logger.debug(`${changedImmutable} changed, replacing ACM certificate: ${physicalId}`);
    // Issue #2169 covers this call too, for free: if the new certificate's
    // ISSUED wait fails, `create()`'s own catch retires it before the error
    // leaves, so the replacement aborts with the OLD certificate still live,
    // still in state, and no orphan. Recording the new one instead was never
    // available here — the state record for this logical id names the old
    // certificate, which cdkd must stay able to delete — which is a second
    // reason the delete policy is the right one for this provider rather
    // than a merely convenient one.
    const createResult = await this.create(
      logicalId,
      resourceType,
      properties,
      context?.maskSecrets ? { maskSecrets: context.maskSecrets } : undefined
    );
    // What the inner delete left behind, if anything. `undefined` means the
    // old certificate is genuinely gone; a string is the short reason that
    // rides out on the update's `'partial'` outcome (issue #1819) so the
    // deploy engine can record and count the survivor instead of the
    // warn-only treatment that preceded it (issue #1922).
    let orphanReason: string | undefined;
    // go-to-k/cdkd#4911: what the failed delete proves about the old one.
    let oldResourceSurvivor: 'kept' | 'unconfirmed' = 'unconfirmed';
    try {
      // go-to-k/cdkd#2007: the update's masker reaches the inner delete.
      const deleteResult = await this.delete(
        logicalId,
        physicalId,
        resourceType,
        previousProperties,
        context?.maskSecrets ? { maskSecrets: context.maskSecrets } : undefined
      );
      // Issue #1778: a SKIP is a non-throwing "I did not address this
      // resource", so it sails straight past the catch below — the one path
      // that would have told the user the old certificate is still there.
      if (deleteResult?.outcome === 'skipped') {
        orphanReason = `old certificate ${physicalId} was not deleted: ${deleteResult.reason}`;
        this.logger.warn(
          `Skipped deleting old ACM certificate ${physicalId} during replacement: ${deleteResult.reason}. ` +
            `The old certificate may be orphaned and require manual cleanup.`
        );
      }
    } catch (error) {
      // Issue #1922: the in-use rejection is the COMMON case here, not an
      // anonymous failure. ACM refuses to delete a certificate a consumer
      // still references — typically a CloudFront distribution in another
      // stack not yet updated to the new certificate — so the rejection is
      // usually an ordering artifact rather than a permanent block. Either
      // way the new certificate already exists, so the replacement cannot be
      // aborted: the honest outcome is "updated, and the old certificate
      // survives", which is what `'partial'` says.
      const inUse = isCertificateInUseError(error);
      // go-to-k/cdkd#4911: ACM's in-use refusal leaves the certificate whole
      // with no deletion running (the delete is one synchronous call), so a
      // rollback may re-adopt it; by AWS error name only, never the message.
      oldResourceSurvivor = certificateInUseByName(error)
        ? 'kept'
        : replacedDeleteFailureVerdict(error);
      orphanReason = inUse
        ? `old certificate ${physicalId} is still in use by another resource and was not deleted`
        : `old certificate ${physicalId} could not be deleted: ${safeStringify(error)}`;
      this.logger.warn(
        `Failed to delete old ACM certificate ${physicalId} during replacement: ${safeStringify(error)}. ` +
          (inUse
            ? `This usually means a consumer (e.g. a CloudFront distribution) still references it; ` +
              `it can be deleted once DescribeCertificate.InUseBy is empty. `
            : '') +
          `The old certificate may be orphaned and require manual cleanup.`
      );
    }
    const base = {
      physicalId: createResult.physicalId,
      wasReplaced: true as const,
      ...(createResult.attributes ? { attributes: createResult.attributes } : {}),
    };
    // The old physical id travels in the reason, because the state record
    // now points at the NEW certificate — nothing else downstream still
    // knows the ARN that survived.
    return orphanReason !== undefined
      ? {
          ...base,
          outcome: 'partial',
          reason: orphanReason,
          ...(oldResourceSurvivor === 'kept' && { oldResourceSurvivor }),
        }
      : base;
  }

  try {
    // CertificateTransparencyLoggingPreference maps to the nested SDK
    // `Options.*` and routes through UpdateCertificateOptions. A removal
    // arrives here as the declared `ENABLED` reset (removalDefaults).
    const newCt = properties['CertificateTransparencyLoggingPreference'] as string | undefined;
    const oldCt = previousProperties['CertificateTransparencyLoggingPreference'] as
      | string
      | undefined;
    if (newCt && newCt !== oldCt) {
      const options: CertificateOptions = {
        CertificateTransparencyLoggingPreference:
          newCt as CertificateOptions['CertificateTransparencyLoggingPreference'],
      };
      await this.acmClient.send(
        new UpdateCertificateOptionsCommand({ CertificateArn: physicalId, Options: options })
      );
      this.logger.debug(`Updated certificate Options on ${physicalId}`);
    }

    // Tags: diff and Add/Remove.
    await this.updateTags(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags']
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: physicalId,
        CertificateArn: physicalId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update ACM certificate ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Diff the recorded and desired Tags into Remove / Add calls. Both sides are
 * read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record
 * untags nothing.
 */
export async function updateTags(
  this: ACMCertificateProvider,
  certificateArn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const tagsToRemove: Array<{ Key: string; Value?: string }> = plan.remove.map((Key) => ({
    Key,
  }));
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));

  if (tagsToRemove.length > 0) {
    await this.acmClient.send(
      new RemoveTagsFromCertificateCommand({ CertificateArn: certificateArn, Tags: tagsToRemove })
    );
  }
  if (tagsToAdd.length > 0) {
    await this.acmClient.send(
      new AddTagsToCertificateCommand({ CertificateArn: certificateArn, Tags: tagsToAdd })
    );
  }
}
