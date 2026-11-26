import * as cdk from 'aws-cdk-lib';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import type { Construct } from 'constructs';

/**
 * Issue #7070: an `AWS::Route53Resolver::ResolverRule` `DomainName` change.
 * The registry schema lists only `RuleType` as create-only, and Cloud Control
 * refuses the in-place update (`NotUpdatable`), while CloudFormation replaces
 * the rule. cdkd now replaces it too, from the measured spec-replacement table.
 *
 * covers: AWS::Route53Resolver::ResolverRule
 *
 * A SYSTEM rule needs no resolver endpoint, so the stack holds the rule alone.
 * `CDKD_TEST_UPDATE=domain` moves it to a second domain.
 */
export class Route53ResolverRuleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const moved = (process.env.CDKD_TEST_UPDATE ?? '').split(',').includes('domain');

    new route53resolver.CfnResolverRule(this, 'Rule', {
      // Per run (verify.sh), so a run sweeps only its own rule.
      name: `cdkd-integ-resolver-rule-7070-${process.env.CDKD_INTEG_RUN_ID ?? 'unset'}`,
      ruleType: 'SYSTEM',
      domainName: moved ? 'cdkd-integ-7070-b.example.internal' : 'cdkd-integ-7070-a.example.internal',
    });
  }
}
