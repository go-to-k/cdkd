import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface DynamicRefCrossRegionStackProps extends cdk.StackProps {
  /**
   * The SSM parameter NAME both stacks reference through the SAME
   * `{{resolve:ssm:<name>}}` expression. `verify.sh` creates one parameter
   * under this name in EACH region, holding a DIFFERENT value.
   */
  readonly sourceParameterName: string;
  /**
   * The `SecureString` counterpart, again one parameter under this name in EACH
   * region holding a DIFFERENT value. Created out of band by `verify.sh`:
   * CloudFormation cannot create a `SecureString`, so the fixture only
   * REFERENCES it — the same shape `secrets-dynamic-ref` uses.
   */
  readonly secureSourceParameterName: string;
}

/**
 * One half of the `dynamic-ref-cross-region` fixture (issue #1933).
 *
 * The stack is deliberately trivial — the fixture is about WHERE the
 * dynamic reference resolves, not about the resources. Each stack:
 *
 *   - is placed in its OWN region (`env.region`, set by `bin/app.ts`),
 *   - declares an SSM String parameter whose `Value` is a literal
 *     `{{resolve:ssm:<sourceParameterName>}}` expression.
 *
 * Both stacks use the SAME parameter name, so the expression STRING is
 * byte-identical between them while the value behind it is not: SSM
 * parameters are regional, so `verify.sh` seeds region A's copy with one
 * value and region B's with another.
 *
 * cdkd resolves the expression itself (`resolveDynamicReferences` in
 * `src/deployment/intrinsic-function-resolver.ts`) before the value reaches
 * the provider, so what lands in each region's echo parameter is exactly the
 * value cdkd resolved for that stack. Before issue #1933 the resolved-value
 * cache was a process-global map keyed by the expression alone, so whichever
 * stack ran first won the expression for the whole run and the second stack's
 * echo parameter carried the OTHER region's value.
 */
export class DynamicRefCrossRegionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DynamicRefCrossRegionStackProps) {
    super(scope, id, props);

    new ssm.CfnParameter(this, 'EchoParameter', {
      type: 'String',
      name: `${this.stackName}-echo`,
      // The whole point of the fixture: a literal dynamic reference that both
      // stacks spell identically.
      value: `{{resolve:ssm:${props.sourceParameterName}}}`,
      description:
        'Echoes the region-local value of the shared source parameter (cdkd issue #1933)',
    });

    // The SECRET arm. A plain `{{resolve:ssm:...}}` reference to a
    // `SecureString` resolves with `WithDecryption`, so cdkd hands the
    // provider the plaintext while persisting the unresolved expression
    // (issue #1901). That is the path whose verdict the resolved-value cache
    // now carries per entry, so without this arm the whole verdict-carrying
    // half of the #1933 fix has no real-AWS coverage — the `String` arm above
    // exercises only the value, which is never redacted.
    new ssm.CfnParameter(this, 'SecureEchoParameter', {
      type: 'String',
      name: `${this.stackName}-secure-echo`,
      value: `{{resolve:ssm:${props.secureSourceParameterName}}}`,
      description:
        'Echoes the region-local value of the shared SecureString source parameter (cdkd issue #1933)',
    });
  }
}
