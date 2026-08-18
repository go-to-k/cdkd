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
    const secureEcho = new ssm.CfnParameter(this, 'SecureEchoParameter', {
      type: 'String',
      name: `${this.stackName}-secure-echo`,
      value: `{{resolve:ssm:${props.secureSourceParameterName}}}`,
      description:
        'Echoes the region-local value of the shared SecureString source parameter (cdkd issue #1933)',
    });

    // The CACHE-HIT resource, and the two things that make it discriminating.
    //
    // ORDER: `addDependency` forces it to be provisioned AFTER `secureEcho`, so
    // its resolution is guaranteed to HIT the cache the first one populated. A
    // second resource alone would not settle this — within a stack cdkd resolves
    // up to `--concurrency` resources at once, so both could take the fresh path
    // and the cache-hit arm would never run.
    //
    // SHAPE: the reference is EMBEDDED in a longer string rather than being the
    // whole value, and that is what makes the persisted state prove something.
    // Redaction is both path-based and value-based (see
    // `src/deployment/secret-redaction.ts`): a leaf whose WHOLE value is the
    // template's `{{resolve:...}}` token is repositioned from the SOURCE and
    // would come out redacted even if the pass recorded nothing, so a bare
    // second reference cannot tell a working cache-hit re-record from a broken
    // one. An embedded occurrence has no such fallback — the surrounding text
    // means the source leaf is not a bare expression, so the only thing that can
    // rewrite the plaintext back out is the VALUE map, which the cache-hit arm
    // is what populates for this resource. Drop the verdict the cache entry
    // carries and this parameter's record persists the decrypted secret.
    const embeddedEcho = new ssm.CfnParameter(this, 'SecureEmbeddedEchoParameter', {
      type: 'String',
      name: `${this.stackName}-secure-embedded-echo`,
      value: `db={{resolve:ssm:${props.secureSourceParameterName}}};mode=test`,
      description:
        'Echoes the SecureString value EMBEDDED in a larger string, resolved on a cache hit (cdkd issue #1933)',
    });
    embeddedEcho.addResourceDependency(secureEcho);
  }
}
