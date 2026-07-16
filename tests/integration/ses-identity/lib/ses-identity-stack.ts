import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ses from 'aws-cdk-lib/aws-ses';

/**
 * Integ probe for SES — the "app that sends email" pattern. A DOMAIN
 * EmailIdentity (the resource is creatable without the domain verifying)
 * plus a ConfigurationSet the identity is bound to.
 *
 * Phase 1 (no env): ConfigurationSet with reputation metrics off; identity
 * bound to it, no Mail-From.
 * Phase 2 (CDKD_TEST_UPDATE=true): reputation metrics flip on
 * (ConfigurationSet UPDATE) and a Mail-From domain is attached to the
 * identity (EmailIdentity UPDATE) — both must be in-place updates.
 *
 * Both types route via Cloud Control (no SDK provider), so this also guards
 * the CC-API UPDATE patch path on SES types.
 *
 * covers: AWS::SES::ConfigurationSet
 * covers: AWS::SES::EmailIdentity
 * Confirmed CLEAN by a /hunt-bugs sweep (2026-07-17); this fixture is the
 * regression guard.
 */
export class SesIdentityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const configSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: 'cdkd-integ-ses-config-set',
      reputationMetrics: update ? true : false,
      sendingEnabled: true,
    });

    const identity = new ses.EmailIdentity(this, 'Identity', {
      identity: ses.Identity.domain('cdkd-integ-ses.example.com'),
      configurationSet: configSet,
      mailFromDomain: update ? 'mail.cdkd-integ-ses.example.com' : undefined,
    });

    new cdk.CfnOutput(this, 'IdentityName', { value: identity.emailIdentityName });
  }
}
