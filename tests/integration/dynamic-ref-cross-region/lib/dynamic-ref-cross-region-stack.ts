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
  /**
   * A THIRD shared name whose TYPE differs between the regions: a plain
   * `String` in region A and a `SecureString` in region B (issue
   * [#1957](https://github.com/go-to-k/cdkd/issues/1957) acceptance criterion
   * 3). The two arms above share a TYPE across regions, so a lookup answered by
   * the wrong region still produces a value of the right KIND and only the
   * value is wrong; here the wrong region also produces the wrong CLASSIFICATION,
   * which is what decides whether the resolved value is persisted in plaintext.
   */
  readonly mixedTypeSourceParameterName: string;
  /**
   * The FULL ARN of the OTHER region's copy of `sourceParameterName` (issue
   * [#2134](https://github.com/go-to-k/cdkd/issues/2134)). Set on region A's
   * stack only, so "foreign" is unambiguous.
   *
   * Undefined leaves the arm out entirely, which is what keeps region B's
   * stack a control rather than a second copy of the same case.
   */
  readonly foreignParameterArn?: string;
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

    // The MIXED-TYPE arm (issue #1957 acceptance criterion 3), and the only one
    // whose failure mode is a DISCLOSURE rather than a wrong value.
    //
    // `verify.sh` seeds this one name as a plain `String` in region A and as a
    // `SecureString` in region B. Because secret-ness is decided by the
    // parameter's TYPE rather than by the reference's spelling (issue #1901),
    // a lookup answered by the WRONG region misclassifies as well as
    // mis-resolves: region B's reference, answered by region A, reports `String`
    // — so cdkd treats the value as public config and persists it RESOLVED
    // instead of persisting the expression. That is the shape `cdkd scrub --all`
    // hits (it installs its clients once and then resolves stacks in several
    // regions) and it is the reason #1957 is a security defect rather than only
    // a correctness one.
    //
    // The other two arms cannot show it: they are `SecureString` in BOTH
    // regions, so a cross-region answer still classifies as secret and the
    // redaction path runs either way.
    // THE ASSEMBLED-FOREIGN arm (issue
    // [#2134](https://github.com/go-to-k/cdkd/issues/2134)), and the only one
    // here whose reference does not EXIST in the raw template text.
    //
    // `Fn::Sub` contributes the parameter id, so the leaf cdkd's pre-pass sees
    // is `{{resolve:ssm:${TargetArn}}}` -- an opening with no ARN behind it.
    // The pre-#2134 pre-pass scanned exactly that text, found nothing it could
    // attribute to a region, and returned the leaf untouched; `resolveSub` then
    // re-entered `resolveDynamicReferences` with the ASSEMBLED expression on
    // the PRIMARY resolver, so the foreign ARN was looked up against THIS
    // stack's regional endpoint.
    //
    // THE DISCRIMINATOR is which region's value lands in this parameter. The
    // ARN names region B while the stack is in region A, and `verify.sh` seeds
    // the two regions with DIFFERENT values -- so pre-fix this echoes region
    // A's value and post-fix region B's. Both paths SUCCEED, which is why the
    // assertion has to be the value rather than the absence of an error.
    //
    // Deliberately NOT a `SecureString`: this arm is about WHICH REGION
    // ANSWERED, and the plain `String` source lets `verify.sh` assert the
    // resolved value directly instead of inferring it.
    if (props.foreignParameterArn !== undefined) {
      new ssm.CfnParameter(this, 'AssembledForeignEchoParameter', {
        type: 'String',
        name: `${this.stackName}-assembled-foreign-echo`,
        value: cdk.Fn.sub('{{resolve:ssm:${TargetArn}}}', {
          TargetArn: props.foreignParameterArn,
        }),
        description:
          "Echoes the OTHER region's value through an Fn::Sub-ASSEMBLED reference (cdkd issue #2134)",
      });
    }

    new ssm.CfnParameter(this, 'MixedTypeEchoParameter', {
      type: 'String',
      name: `${this.stackName}-mixed-echo`,
      value: `{{resolve:ssm:${props.mixedTypeSourceParameterName}}}`,
      description:
        'Echoes a name that is String in region A and SecureString in region B (cdkd issue #1957)',
    });
  }
}

/** Props for {@link AssembledForeignSecretStack}. */
export interface AssembledForeignSecretStackProps extends cdk.StackProps {
  /**
   * The FULL ARN of the OTHER region's copy of the SECURE (SecureString)
   * source parameter.
   */
  readonly foreignSecureParameterArn: string;
}

/**
 * The `cdkd scrub` arm for issue
 * [#2157](https://github.com/go-to-k/cdkd/issues/2157): ONE assembled,
 * foreign-ARN, SECRET reference and nothing else.
 *
 * WHY IT IS A SEPARATE STACK rather than another parameter on region A's.
 * `scrub`'s pre-pass refuses FIRST over the whole leaf set, and every leaf on
 * {@link DynamicRefCrossRegionStack} spells its reference region-LESSLY. Once
 * `verify.sh` seeds a foreign `outputReads` entry -- which this arm needs,
 * because the guard #2157 relaxed was gated on foreign-region evidence being on
 * record -- those region-less leaves classify `ambiguous` and refuse before the
 * assembled one is ever reached. The arm would then measure the ambiguity
 * refusal instead of the relaxation, in BOTH polarities, i.e. silently. Keeping
 * the evidence on a stack that has no region-less reference is what makes the
 * assembled leaf the only thing scrub can answer.
 *
 * THE SHAPE UNDER TEST. The raw template leaf is
 * `{"Fn::Sub": ["{{resolve:ssm:${TargetArn}}}", {...}]}`. MEASURED rather than
 * reasoned about, because the obvious reading is wrong: `[^}]+` stops at the
 * `}` of `${TargetArn}` and the following `}}` closes the match ONE BRACE
 * SHORT, so the scan returns exactly ONE whole-looking token for ONE opening --
 * the COUNT clause of `isAssembledSecretReference` does NOT see this leaf. What
 * catches it is the second clause: a whole token that still contains `${`. (The
 * count clause's own shape is the MID-string placeholder, covered by the unit
 * suite's `SUB_ASSEMBLED_FOREIGN_ARN_EXPR` and by its splice-beside-a-split
 * case.)
 *
 * Pre-#2157 a hit on either clause, plus a
 * foreign producer region on record, threw
 * `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE` -- exit 2, no bypass flag, the whole
 * stack unscrubbable while its state.json still held the plaintext. Post-#2157
 * the leaf is deferred to the resolver, which sees the ASSEMBLED expression,
 * routes it to the region the ARN names (issue #2134) and answers.
 *
 * SECURE, not the plain `String` source the #2134 arm uses: `cdkd scrub`'s
 * subject is a SECRET, and a plain `String` parameter is public config that
 * cdkd stores RESOLVED by design (issue #1901) -- so a plaintext seeded at
 * such a leaf is not something scrub would ever rewrite, and the arm would pass
 * vacuously in both directions.
 */
export class AssembledForeignSecretStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AssembledForeignSecretStackProps) {
    super(scope, id, props);

    new ssm.CfnParameter(this, 'AssembledForeignSecretEcho', {
      type: 'String',
      name: `${this.stackName}-assembled-foreign-secret-echo`,
      value: cdk.Fn.sub('{{resolve:ssm:${TargetArn}}}', {
        TargetArn: props.foreignSecureParameterArn,
      }),
      description:
        "Echoes the OTHER region's SecureString through an Fn::Sub-ASSEMBLED reference " +
        '(cdkd issues 2134 and 2157)',
    });
  }
}
