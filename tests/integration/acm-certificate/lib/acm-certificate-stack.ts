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

    // `CDKD_TEST_UPDATE=validation` flips ValidationMethod DNS -> EMAIL. ACM
    // cannot change it and the AWS CDK CLI's diff calls it a replacement, but
    // the registry schema leaves it out of `createOnlyProperties`, so cdkd's
    // replacement rules list it (go-to-k/cdkd#6513) and the ENGINE replaces
    // the certificate; phase 2 asserts the diff reports that.
    // Set through the L1 escape hatch rather than `CertificateValidation
    // .fromEmail()`, because that L2 helper ALSO emits DomainValidationOptions
    // -- so the template would differ in more than ValidationMethod, and the
    // arm would no longer show that ValidationMethod alone is a replacement.
    // (It also emitted a validationDomain AWS rejects for a `.example.test`
    // name, which is how that attempt surfaced.)
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

    // Phase 5 (go-to-k/cdkd#6799): an Amazon N2 certificate, present only
    // under `CDKD_TEST_N2=1`. Both properties are create-only and were
    // SDK-unwired, so the resource used to route through Cloud Control.
    // `CertificateUsage` is accepted with an N2 RootHierarchyType only, and
    // ACM requires DNS validation for one. The domain contains
    // `cdkd-integ-<stack>`, so the trap's leak sweep covers it. A
    // `CfnResource`: `CfnCertificate` (aws-cdk-lib 2.276) models neither
    // property yet.
    if (process.env['CDKD_TEST_N2'] === '1') {
      new cdk.CfnResource(this, 'N2Certificate', {
        type: 'AWS::CertificateManager::Certificate',
        properties: {
          DomainName: `n2.${domain}`,
          ValidationMethod: 'DNS',
          RootHierarchyType: 'N2_AMAZON_MANAGED',
          CertificateUsage: 'CLIENT_AUTH_ONLY',
        },
      });
    }

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: cert.certificateArn,
      description: 'ARN of the test ACM certificate (PENDING_VALIDATION — synthetic domain)',
    });
  }
}
