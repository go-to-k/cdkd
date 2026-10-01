import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

/**
 * Verifies cdkd's ACMCertificateProvider against real AWS.
 *
 * Uses a synthetic test domain (`cdkd-integ-<rand>.example.test`) that is NOT
 * a real DNS zone. The integ runs with `CDKD_NO_WAIT=true` so create() returns
 * immediately on PENDING_VALIDATION without waiting for the never-arriving DNS
 * validation. Destroy then deletes the still-PENDING_VALIDATION certificate.
 *
 * What this exercises end-to-end:
 *   - RequestCertificate (real AWS call) returns ARN.
 *   - cdkd state records the cert with the ARN as physicalId.
 *   - DeleteCertificate succeeds against a PENDING_VALIDATION cert.
 *   - The --no-wait code path returns immediately + warns the user.
 *
 * What this DOES NOT exercise:
 *   - The poll-until-ISSUED path (would need a real DNS zone the test account
 *     controls; ship a follow-up integ once the test environment grows one).
 *
 * The synthetic domain uses `example.test` (RFC 2606 reserved TLD for testing)
 * to avoid any chance of collision with a real domain.
 */
export class AcmCertificateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Stack-name-derived suffix → stable across runs of the SAME stack name,
    // but distinct from any other test deploy in this account.
    const domain = `cdkd-integ-${this.stackName.toLowerCase()}.example.test`;

    // `CDKD_TEST_UPDATE=validation` flips ValidationMethod DNS -> EMAIL, which
    // is the ONE property that reaches the ACM provider's own create-then-delete
    // replacement -- the code path issue #1819's `'partial'` outcome lives on.
    //
    // The choice is forced, not stylistic. The provider treats six fields as
    // immutable, but the deploy engine classifies a change as a replacement
    // FIRST, from the CloudFormation registry's `createOnlyProperties`, and
    // does its own DELETE -> CREATE without ever calling `provider.update()`.
    // For this type that list is SubjectAlternativeNames /
    // DomainValidationOptions / KeyAlgorithm / DomainName /
    // CertificateAuthorityArn / CertificateExport -- five of the provider's six.
    // `ValidationMethod` is the only one absent from it, so it is the only
    // change the engine hands to `update()` for the provider to replace itself.
    // Picking any of the others silently tests the engine's path instead, which
    // is exactly what the first version of this arm did.
    // Set through the L1 escape hatch rather than `CertificateValidation
    // .fromEmail()`, because that L2 helper ALSO emits DomainValidationOptions
    // -- which IS createOnly, so the engine would classify the replacement and
    // intercept it exactly as SubjectAlternativeNames did. The template must
    // differ in ValidationMethod and NOTHING else for this arm to reach the
    // provider. (It also emitted a validationDomain AWS rejects for a
    // `.example.test` name, which is how that attempt surfaced.)
    const updateMode = process.env['CDKD_TEST_UPDATE'] ?? '';
    const cert = new acm.Certificate(this, 'TestCertificate', {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(),
    });
    if (updateMode.includes('validation')) {
      const cfnCert = cert.node.defaultChild as acm.CfnCertificate;
      cfnCert.validationMethod = 'EMAIL';
      cfnCert.domainValidationOptions = undefined;
    }

    // Phase 4 (go-to-k/cdkd#4275): a second certificate whose DomainName comes
    // from a Secrets Manager secret, present only while verify.sh names the
    // secret. cdkd records the `{{resolve:secretsmanager:...}}` expression and
    // hands `update()` the resolved name, which the provider used to read as a
    // DomainName change and REPLACE the certificate on any update.
    // `CDKD_TEST_SECRET_CERT_TAG` is that update: a Tags-only change. L1, so the
    // template carries DomainName / ValidationMethod / Tags and nothing else.
    const secretName = process.env['CDKD_TEST_SECRET_NAME'];
    if (secretName !== undefined && secretName !== '') {
      new acm.CfnCertificate(this, 'SecretCertificate', {
        domainName: cdk.SecretValue.secretsManager(secretName, {
          jsonField: 'domain',
        }).unsafeUnwrap(),
        validationMethod: 'DNS',
        tags: [{ key: 'phase', value: process.env['CDKD_TEST_SECRET_CERT_TAG'] ?? 'v1' }],
      });
    }

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: cert.certificateArn,
      description: 'ARN of the test ACM certificate (PENDING_VALIDATION — synthetic domain)',
    });
  }
}
