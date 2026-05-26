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

    const cert = new acm.Certificate(this, 'TestCertificate', {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(),
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: cert.certificateArn,
      description: 'ARN of the test ACM certificate (PENDING_VALIDATION — synthetic domain)',
    });
  }
}
