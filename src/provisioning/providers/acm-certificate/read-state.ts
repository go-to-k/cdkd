import type { ACMCertificateProvider } from '../acm-certificate-provider.js';
import {
  DescribeCertificateCommand,
  ListTagsForCertificateCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-acm';
import {
  isPlainImportValue,
  normalizeAwsTagsToCfn,
  VALUE_NOT_SHOWN,
} from '../../import-helpers.js';
import { logicalIdShown } from '../../composite-id.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';

/**
 * Read the AWS-current certificate properties in CFn-property shape.
 *
 * Coverage:
 *  - `DomainName`, `SubjectAlternativeNames`, `KeyAlgorithm` straight from
 *    `DescribeCertificate.Certificate.*`.
 *  - `CertificateTransparencyLoggingPreference` extracted from the nested
 *    `Options` field and flattened to match CFn shape.
 *  - `Tags` via `ListTagsForCertificate`, with the `aws:cdk:path` etc.
 *    auto-tags filtered out by `normalizeAwsTagsToCfn`.
 *  - `ValidationMethod` / `DomainValidationOptions` are intentionally NOT
 *    surfaced — the deployed cert's validation state is observation-only;
 *    cdkd state stores the request-time input, which can legitimately
 *    diverge from the observed state without indicating drift.
 *
 * Returns `RESOURCE_NOT_FOUND` when the cert is gone (`ResourceNotFoundException`).
 */
export async function readCurrentState(
  this: ACMCertificateProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  _properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let cert;
  try {
    const resp = await this.acmClient.send(
      new DescribeCertificateCommand({ CertificateArn: physicalId })
    );
    cert = resp.Certificate;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!cert) return undefined;

  const result: Record<string, unknown> = {};
  if (cert.DomainName !== undefined) result['DomainName'] = cert.DomainName;
  if (Array.isArray(cert.SubjectAlternativeNames)) {
    result['SubjectAlternativeNames'] = cert.SubjectAlternativeNames;
  }
  if (cert.KeyAlgorithm !== undefined) result['KeyAlgorithm'] = cert.KeyAlgorithm;
  if (cert.CertificateAuthorityArn !== undefined) {
    result['CertificateAuthorityArn'] = cert.CertificateAuthorityArn;
  }
  if (cert.Options?.CertificateTransparencyLoggingPreference !== undefined) {
    result['CertificateTransparencyLoggingPreference'] =
      cert.Options.CertificateTransparencyLoggingPreference;
  }
  if (cert.Options?.Export !== undefined) {
    result['CertificateExport'] = cert.Options.Export;
  }

  try {
    const tagsResp = await this.acmClient.send(
      new ListTagsForCertificateCommand({ CertificateArn: physicalId })
    );
    result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }

  return result;
}

/**
 * Adopt an existing certificate into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override (must be an ARN — ACM has no other unique id).
 */
export async function importImpl(
  this: ACMCertificateProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    const arn = input.knownPhysicalId;
    if (!arn.startsWith('arn:')) {
      // Names the `--resource` flag, so the logical id and the supplied id
      // are shown only when plain (go-to-k/cdkd#4273): inside cdkd's own
      // `'...'`, a `'` in the id closed the quote and the rest ran when pasted.
      throw new Error(
        `--resource override for ${logicalIdShown(input.logicalId)} must be an ARN (got ${isPlainImportValue(arn) ? `'${arn}'` : VALUE_NOT_SHOWN}). ACM certificates have no human-readable physical id.`
      );
    }
    try {
      await this.acmClient.send(new DescribeCertificateCommand({ CertificateArn: arn }));
      return { physicalId: arn, attributes: { Arn: arn, CertificateArn: arn } };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // certificate reaching here needs an explicit `--resource` override.
  return null;
}
