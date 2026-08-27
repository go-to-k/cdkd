import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * The secret flow across a NESTED-STACK boundary, in BOTH directions.
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SSM::Parameter
 *
 * Issues [#1903](https://github.com/go-to-k/cdkd/issues/1903) (parameters IN),
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055) (outputs OUT),
 * [#2086](https://github.com/go-to-k/cdkd/issues/2086) (the rollback executor
 * binds the same seed), [#2087](https://github.com/go-to-k/cdkd/issues/2087)
 * (the seed is scoped to the resources that actually consumed the parameter)
 * and [#2291](https://github.com/go-to-k/cdkd/issues/2291) (two parameters
 * resolving to ONE plaintext keep DISTINCT expressions across the handoff).
 *
 * Nothing here creates the secret or the SecureString parameter: `verify.sh`
 * puts both in place out of band and deletes them again. CloudFormation cannot
 * create a SecureString at all, and keeping the secretsmanager one out of band
 * too means this stack never has to order a `{{resolve:...}}` consumer behind
 * its own producer — the references are literal strings, so no DAG edge exists
 * to enforce such an ordering.
 *
 * WHY THE PARENT/CHILD SPLIT MATTERS. cdkd's redaction rests on the resolver
 * recording `plaintext -> {{resolve:...}} expression` and the deploy engine
 * reading that at its state-save choke point. A nested stack breaks the chain:
 * the PARENT resolves the child's `Parameters` block, so the child engine
 * receives PLAINTEXT and the child's own template spells the consumption as
 * `{Ref: <ParamName>}` — an intrinsic OBJECT, never a `{{resolve:` string.
 *
 * THE EIGHT RESOURCES, and what each one discriminates:
 *
 *  - `StageParam` (child) — consumes the secretsmanager-backed parameter. Its
 *    persisted `Value` must be the EXPRESSION while the live SSM parameter
 *    holds the plaintext.
 *  - `SecureParam` (child) — the same for a SecureString `{{resolve:ssm:...}}`,
 *    which is a secret by the parameter's TYPE rather than by its spelling
 *    (issue #1901), so it exercises the classification arm as well.
 *  - `UnrelatedParam` (child) — THE #2087 DISCRIMINATOR. An ordinary literal
 *    that CONTAINS the secret plaintext as a SUBSTRING and references no
 *    parameter at all. Its persisted `Value` must stay VERBATIM. The first cut
 *    of #1903 seeded the parent's bag into every child resource's redaction
 *    map, and `redactSecretsForState` substring-matches, so this row persisted
 *    with the expression spliced in — which the desired side never mirrors,
 *    giving a perpetual UPDATE. A literal that did NOT overlap could not see
 *    the defect at all.
 *  - `HandoffPair` (child) — THE #2291 ARM. ONE child resource whose `Value`
 *    and `Description` come from TWO different inherited `Parameters` that
 *    resolve to ONE plaintext. The parent's `inheritedSecrets` bag is keyed by
 *    plaintext, so it collapses the pair BEFORE the child engine exists, and
 *    the child's `{Ref: <Param>}` source leaves carry no expression for the
 *    position pass to certify against — two independent causes, both of which
 *    had to be fixed. Each leaf must persist ITS OWN expression, or
 *    `resolveReplayProps` re-resolves the sibling's version stage and
 *    `cdkd drift --revert` / rollback pushes it to the live resource.
 *  - `HandoffSub` (child) — THE #2291 ROUND-2 ARM. The same inherited pair, but
 *    consumed by an `Fn::Sub` that EMBEDS the losing parameter in a connection
 *    string — the shape `crossStackSourceKey` refuses, so only the
 *    plaintext-keyed value scan can redact it. Round 1 made the DIFF side answer
 *    per parameter and left this side on the survivor, so the two halves
 *    disagreed forever: a perpetual UPDATE, caught here by the
 *    `cdkd diff --recursive --fail` exit code as well as by its persisted value.
 *  - `ParentConsumer` (parent) — reads the child's OUTPUT through
 *    `Fn::GetAtt: [Child, 'Outputs.ChildSecretOutput']`. Since PR #1899 the
 *    child persists that output REDACTED, so before #2055 the parent shipped
 *    the literal `{{resolve:...}}` token to AWS. The live parameter must hold
 *    the resolved secret and the parent's own state must hold the expression.
 *  - `SubConsumer` (parent) — THE #2270 ARM. The same cross-boundary read
 *    spelled as an `Fn::Sub` placeholder (`${Child.Outputs.ChildPlainOutput}`)
 *    rather than an `Fn::GetAtt`. The resolver rejected that three-segment
 *    STRING form, and `Fn::Sub`'s catch turned the rejection into a KEPT
 *    literal, so the parameter was created holding the placeholder TEXT with a
 *    green deploy. It reads a NON-secret output on purpose, so a failure here
 *    is unambiguously about placeholder resolution rather than redaction.
 *
 *  - `SubSecretPair` (parent) — THE #2270 ROUND-3 ARM, and the one
 *    `SubConsumer` cannot see. ONE resource with TWO `Fn::Sub` leaves (its
 *    `Value` and its `Description`) reading two child outputs that resolve to
 *    ONE plaintext through DIFFERENT expressions. Making `${Child.Outputs.X}`
 *    resolve CREATED a collapse population: the leaf now carries a secret and
 *    had no positioning, so both leaves persisted the SURVIVOR's expression and
 *    a rollback applied the wrong one. Each leaf must persist ITS OWN. One
 *    resource, not two, because `perResourceSecrets` is keyed by logical id —
 *    two resources get two bags and would pass either way.
 *
 * Issue [#2270](https://github.com/go-to-k/cdkd/issues/2270) is the `Fn::Sub`
 * spelling of the #2055 read above.
 */
class SecretBearingChild extends cdk.NestedStack {
  /** The child's output, for the parent to consume via `Fn::GetAtt`. */
  public readonly stageOutput: string;

  constructor(
    scope: Construct,
    id: string,
    names: {
      stageParamName: string;
      secureParamName: string;
      unrelatedParamName: string;
      handoffParamName: string;
      handoffSubParamName: string;
      unrelatedLiteral: string;
      handoffAllowedPattern?: string;
      plainOutputValue: string;
      sharedReferenceA: string;
      sharedReferenceB: string;
      stageParamDescription: string;
    },
    props?: cdk.NestedStackProps
  ) {
    super(scope, id, props);

    // Pin the `AWS::CloudFormation::Stack` logical id so the cdkd state key is
    // the documented `<parent>~Child` shape rather than CDK's auto-generated
    // compound, which verify.sh would otherwise have to discover. See
    // `tests/integration/nested-stack` and issue #575.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    // The two inputs the parent resolves on this stack's behalf. Declared with
    // pinned logical ids because the parent's `Parameters` block keys on them
    // and verify.sh asserts against those exact names in the parent's state.
    const stage = new cdk.CfnParameter(this, 'SecretStage', { type: 'String' });
    stage.overrideLogicalId('SecretStage');
    const securePassword = new cdk.CfnParameter(this, 'SecurePassword', { type: 'String' });
    securePassword.overrideLogicalId('SecurePassword');

    // THE #2291 ARM's two inputs. Two references to ONE secret whose
    // EXPRESSIONS differ while their resolved plaintext does not, handed down
    // as PARAMETERS -- the shape `ChildSharedOutputA` below deliberately does
    // NOT cover, and the one that was broken in two independent places.
    const handoffA = new cdk.CfnParameter(this, 'HandoffSecretA', { type: 'String' });
    handoffA.overrideLogicalId('HandoffSecretA');
    const handoffB = new cdk.CfnParameter(this, 'HandoffSecretB', { type: 'String' });
    handoffB.overrideLogicalId('HandoffSecretB');

    const stageParam = new ssm.StringParameter(this, 'StageParam', {
      parameterName: names.stageParamName,
      // `{Ref: SecretStage}` in the child's template — an intrinsic OBJECT, so
      // nothing in the child's own resolution ever sees a `{{resolve:`.
      stringValue: stage.valueAsString,
      // VARIES BY `CDKD_TEST_UPDATE` (see the parent below). Changing a child
      // property is what makes the parent's `Child` row an UPDATE, which is the
      // only way this fixture reaches `NestedStackProvider.update` — the #1903
      // arm for a nested stack that ALREADY exists. Before this the fixture's
      // second deploy was a no-op, so that arm never ran here at all.
      description: names.stageParamDescription,
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((stageParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('StageParam');

    const secureParam = new ssm.StringParameter(this, 'SecureParam', {
      parameterName: names.secureParamName,
      stringValue: securePassword.valueAsString,
      description: 'cdkd nested-stack-secret integ - child consumer of the SecureString parameter',
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((secureParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('SecureParam');

    const unrelatedParam = new ssm.StringParameter(this, 'UnrelatedParam', {
      parameterName: names.unrelatedParamName,
      // NO intrinsic. This value is a plain literal that merely happens to
      // contain the secret plaintext as a substring.
      stringValue: names.unrelatedLiteral,
      description:
        'cdkd nested-stack-secret integ - #2087 discriminator: an unrelated literal containing the secret plaintext',
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((unrelatedParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('UnrelatedParam');

    // THE #2291 ARM. ONE resource, TWO leaves, each fed by a DIFFERENT inherited
    // parameter whose resolved plaintext is the SAME.
    //
    // BOTH LEAVES SIT IN ONE RESOURCE, for the reason `SubSecretPair` states in
    // the parent: `perResourceSecrets` is keyed by logical id, so two separate
    // resources get two separate bags -- each holding a single pair -- and each
    // would redact correctly with or without the fix, making the arm prove
    // nothing. One resource means one bag holding one COLLAPSED entry, which is
    // the only shape where positioning decides the answer.
    //
    // ROUTED THROUGH `Parameters`, which is what makes this arm distinct from
    // `SubSecretPair`. That one's pair is resolved by the CHILD and read by the
    // PARENT, so each source leaf is its own whole token. Here the PARENT
    // resolves both, its `inheritedSecrets` bag collapses them (it is keyed by
    // plaintext), and the child's source leaves are `{Ref: HandoffSecretA}` /
    // `{Ref: HandoffSecretB}` -- intrinsic objects carrying no expression at
    // all. Positioning them needs the per-parameter association the parent
    // records; without it BOTH leaves persist the survivor's expression and
    // `cdkd drift --revert` / rollback pushes the WRONG version stage.
    const handoffPair = new ssm.StringParameter(this, 'HandoffPair', {
      parameterName: names.handoffParamName,
      stringValue: handoffA.valueAsString,
      // The SECOND leaf of the SAME resource. A description rather than another
      // parameter precisely so both land in one bag.
      description: handoffB.valueAsString,
      // VARIES BY `CDKD_TEST_UPDATE`, and it is what makes the phase-2c arm
      // non-vacuous. Phase 2c drives the parent's `Child` row through
      // `NestedStackProvider.update`, i.e. the deploy engine's UPDATE call
      // site -- the SECOND place the parent records the per-parameter
      // expressions this child needs. Without a change on THIS resource the
      // child would treat it as UNCHANGED, never re-resolve its two leaves, and
      // an unrecorded UPDATE site would leave the already-correct state.json
      // untouched: a vacuous pass. A THIRD property rather than one of the two
      // leaves, because both leaves are what every assertion reads.
      ...(names.handoffAllowedPattern !== undefined && {
        allowedPattern: names.handoffAllowedPattern,
      }),
    });
    ((handoffPair.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('HandoffPair');

    // THE #2291 ROUND-2 ARM: the EMBEDDING shape, over the LOSING parameter.
    //
    // `HandoffPair` above spells both leaves as bare `{Ref: <Param>}`, which the
    // persist path positions through the parent's per-parameter association.
    // This leaf is an `Fn::Sub`, so `crossStackSourceKey` refuses it (its
    // `Fn::Sub` arm requires a DOTTED nested-stack-output placeholder) and
    // `intrinsicSkeletonPattern` cannot describe it either -- the ONLY thing
    // that can redact it is the plaintext-keyed VALUE SCAN, which reads the
    // child resource's own bag. The first cut of this fix made
    // `redactParametersForDiff` answer per parameter while that bag still held
    // the collapsed SURVIVOR, so the persisted side said `:AWSCURRENT:` and the
    // desired side said `::` and the two never matched again: a perpetual
    // UPDATE, which this fixture's `cdkd diff --recursive --fail` phase catches
    // by EXIT CODE.
    //
    // ITS OWN RESOURCE, NOT A THIRD LEAF ON `HandoffPair`, and that is
    // correctness rather than tidiness. The destination bag is keyed by
    // plaintext, so a resource consuming BOTH colliding parameters keeps only
    // whichever `Ref` resolved LAST. Putting this leaf beside the pair would
    // make its expected value depend on property iteration order. One parameter
    // in, one pair recorded, one deterministic answer.
    //
    // SO NOTHING LIVE COVERS THE MIXED SHAPE, and that is worth stating rather
    // than leaving as an inference from the paragraph above. A resource holding
    // ONE embedded leaf and ONE whole-value leaf over the two colliding
    // parameters is a case where the persist and diff halves genuinely DISAGREE
    // on this branch (measured; `main` agreed, on the wrong expression), so it
    // is a REGRESSION rather than an unfixed gap -- deferred with its
    // measurement to issue
    // [#2320](https://github.com/go-to-k/cdkd/issues/2320), which also carries
    // the fixture arm it needs. Adding that arm HERE would have made this one
    // order-dependent, which is the trade this split makes deliberately.
    //
    // OVER `HandoffSecretA` -- the LOSER, whose expression is not the survivor.
    // Pointing it at `HandoffSecretB` would pass with the collapse fully intact.
    const handoffSub = new ssm.StringParameter(this, 'HandoffSub', {
      parameterName: names.handoffSubParamName,
      stringValue: cdk.Fn.sub('postgres://u:${HandoffSecretA}@host'),
      description:
        'cdkd nested-stack-secret integ - #2291 round 2: an EMBEDDING leaf over the losing parameter',
    });
    ((handoffSub.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('HandoffSub');

    const output = new cdk.CfnOutput(this, 'ChildSecretOutput', {
      value: stage.valueAsString,
      description: 'cdkd nested-stack-secret integ - secret-derived child output (issue #2055)',
    });
    output.overrideLogicalId('ChildSecretOutput');

    // THE #2270 ARM's producer. A NON-secret output, deliberately: the defect
    // it fences is about an `Fn::Sub` shipping the placeholder TEXT, which has
    // nothing to do with redaction, and routing it through the secret output
    // would make a failure here ambiguous between the two.
    //
    // The literal must not overlap any other needle in this fixture (the
    // #2087 arm is a standing reminder of what an overlapping literal costs),
    // so it carries the issue number and shares no substring with
    // `SECRET_STAGE_VALUE` / `SECURE_PW_VALUE` / any parameter name.
    const plainOutput = new cdk.CfnOutput(this, 'ChildPlainOutput', {
      value: names.plainOutputValue,
      description:
        'cdkd nested-stack-secret integ - non-secret child output read back through Fn::Sub (issue #2270)',
    });
    plainOutput.overrideLogicalId('ChildPlainOutput');

    // THE #2270 ROUND-3 COLLAPSE PREMISE, and it lives ENTIRELY inside the
    // child. Two references to ONE secret whose EXPRESSIONS differ while their
    // resolved plaintext does not: an empty version-stage defaults to
    // `AWSCURRENT`, so `:pw::` and `:pw:AWSCURRENT:` are byte-different strings
    // with one value. That is issue #2059's rotating-secret shape made
    // DETERMINISTIC -- no rotation window to race.
    //
    // THEY ARE LITERAL TOKENS RESOLVED BY THE CHILD, deliberately, NOT values
    // handed down through the child's `Parameters`. Resolved in the child, each
    // output's source leaf IS its own whole token, which the position pass
    // certifies per leaf -- so the child's two outputs persist DISTINCT
    // expressions, which is what the parent's arm then needs.
    //
    // A parameter-borne pair is a DIFFERENT arm rather than an impossible one,
    // and this note used to say the latter (issue
    // [#2291](https://github.com/go-to-k/cdkd/issues/2291)). The parent's
    // `inheritedSecrets` bag really is `Map<plaintext, expression>` and really
    // does collapse such a pair before the child is invoked, and the child's
    // `{Ref: Param}` source leaves really do carry no expression -- both true,
    // and together they were the DEFECT. The parent now records, per child
    // parameter NAME, which expression that parameter was resolved from, and
    // the child positions `{Ref: <Param>}` against it. `HandoffPair` above is
    // that arm.
    //
    // They also use a DIFFERENT JSON key (and so a different plaintext) from
    // `SecretStage`. Sharing that one would drag `StageParam` into the same
    // collapse -- which is exactly what the first cut of this arm did.
    const sharedOutputA = new cdk.CfnOutput(this, 'ChildSharedOutputA', {
      value: names.sharedReferenceA,
      description:
        'cdkd nested-stack-secret integ - shared-plaintext secret output, default stage (issue #2270)',
    });
    sharedOutputA.overrideLogicalId('ChildSharedOutputA');

    const sharedOutputB = new cdk.CfnOutput(this, 'ChildSharedOutputB', {
      value: names.sharedReferenceB,
      description:
        'cdkd nested-stack-secret integ - the SIBLING, same plaintext, different expression (issue #2270)',
    });
    sharedOutputB.overrideLogicalId('ChildSharedOutputB');

    this.stageOutput = cdk.Token.asString(
      (this.nestedStackResource as cdk.CfnResource).getAtt('Outputs.ChildSecretOutput')
    );
  }
}

export class NestedStackSecretStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = cdk.Stack.of(this).account;

    // Phase 2c of `verify.sh` re-deploys with `CDKD_TEST_UPDATE=child-property`
    // so the CHILD template genuinely changes. Two things follow, and the
    // second is the point: the child's `StageParam` takes an in-place UPDATE,
    // and the parent's `AWS::CloudFormation::Stack` row changes with the
    // nested template's asset hash — so the parent's provisioning takes
    // `NestedStackProvider.update`, i.e. the arm whose seed binding (issue
    // #1903, `deploy-engine.ts`'s UPDATE call site) this fixture could not
    // exercise while its second deploy was a no-op.
    //
    // A DESCRIPTION rather than a value: the three child parameters' VALUES are
    // what every redaction assertion is written against, and `UnrelatedParam`'s
    // literal in particular has to stay byte-identical for the #2087 arm.
    const updateMode = process.env['CDKD_TEST_UPDATE'] ?? '';
    // The #2291 arm's own phase-2c change, on the SAME token as the description
    // swap below: `HandoffPair` must genuinely become an UPDATE in that phase,
    // or the assertions there pass over a state.json nothing rewrote.
    const handoffAllowedPattern = updateMode.includes('child-property') ? '^.*$' : undefined;
    const stageParamDescription = updateMode.includes('child-property')
      ? 'cdkd nested-stack-secret integ - child consumer of the secretsmanager parameter (updated)'
      : 'cdkd nested-stack-secret integ - child consumer of the secretsmanager parameter';

    // Fixed, account-scoped names so verify.sh can build the `{{resolve:...}}`
    // strings and read every resource back deterministically. Simple
    // (non-hierarchical) names: a leading-slash SSM name combined with an
    // unresolved account token breaks CDK's ARN-separator derivation.
    const secretName = `cdkd-nested-secret-${account}`;
    const secureParamName = `cdkd-nested-secure-${account}`;

    // The two references the PARENT resolves before handing the values down.
    // Spelled as literal strings rather than through `SecretValue`, so the test
    // exercises the exact dynamic-reference grammar rather than whichever token
    // shape the installed CDK happens to emit.
    const stageReference = `{{resolve:secretsmanager:${secretName}:SecretString:stage::}}`;
    // The SHARED-plaintext pair for the #2270 round-3 arm: a DIFFERENT JSON key
    // (so a different plaintext from `stage`, keeping `StageParam` the only
    // leaf carrying its own), spelled two ways that resolve identically because
    // an empty version-stage defaults to `AWSCURRENT`. Handed to the CHILD as
    // literal output values rather than as `Parameters` -- see the child's
    // `ChildSharedOutputA` for why a parameter-borne pair cannot work.
    const sharedReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:shared::}}`;
    const sharedReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:shared:AWSCURRENT:}}`;
    // THE #2291 PAIR. Same two-spellings-one-value trick, on a THIRD JSON key
    // so its plaintext is its own: sharing `stage` or `shared` would drag
    // `StageParam` / `SubSecretPair` into this collapse, which is exactly how
    // the first cut of the #2270 arm broke the #1903 assertion. These two are
    // handed to the child as PARAMETERS.
    const handoffReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:handoff::}}`;
    const handoffReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:handoff:AWSCURRENT:}}`;
    const secureReference = `{{resolve:ssm:${secureParamName}}}`;

    const child = new SecretBearingChild(
      this,
      'Child',
      {
        stageParamName: `cdkd-nested-child-stage-${account}`,
        secureParamName: `cdkd-nested-child-secure-${account}`,
        unrelatedParamName: `cdkd-nested-child-unrelated-${account}`,
        handoffParamName: `cdkd-nested-child-handoff-${account}`,
        handoffSubParamName: `cdkd-nested-child-handoffsub-${account}`,
        ...(handoffAllowedPattern !== undefined && { handoffAllowedPattern }),
        // Contains the secret's resolved plaintext (`prodstage2087`) as a
        // substring. Kept in sync with verify.sh's SECRET_STAGE_VALUE — and
        // verify.sh now ASSERTS the overlap rather than trusting this comment,
        // because a drift here would leave the #2087 arm passing VACUOUSLY (a
        // non-overlapping literal cannot see the defect at all).
        unrelatedLiteral: 'cdkd-bucket-prodstage2087-logs',
        // Kept in sync with verify.sh's CHILD_PLAIN_OUTPUT_VALUE.
        plainOutputValue: 'plainout2270',
        sharedReferenceA,
        sharedReferenceB,
        stageParamDescription,
      },
      {
        parameters: {
          SecretStage: stageReference,
          SecurePassword: secureReference,
          // The #2291 pair. TWO parameters, ONE resolved plaintext.
          HandoffSecretA: handoffReferenceA,
          HandoffSecretB: handoffReferenceB,
        },
      }
    );

    const parentConsumer = new ssm.StringParameter(this, 'ParentConsumer', {
      parameterName: `cdkd-nested-parent-consumer-${account}`,
      // `Fn::GetAtt: [Child, 'Outputs.ChildSecretOutput']` — the child's
      // persisted output is REDACTED, so this is the read site issue #2055 is
      // about.
      stringValue: child.stageOutput,
      description:
        'cdkd nested-stack-secret integ - parent consumer of the child output (issue #2055)',
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((parentConsumer.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('ParentConsumer');

    // THE #2270 ARM. The SAME cross-boundary reference as `ParentConsumer`,
    // spelled as an `Fn::Sub` placeholder instead of an `Fn::GetAtt`.
    //
    // `resolveGetAtt` used to reject the three-segment STRING form
    // (`Child.Outputs.ChildPlainOutput`) outright. In `Fn::GetAtt` position
    // that throw was loud; inside `Fn::Sub` the surrounding catch turned it
    // into a KEPT literal, so the parameter was CREATED holding the text
    // `sub-${Child.Outputs.ChildPlainOutput}-end` -- SSM accepts any string,
    // so the deploy went green and the only signal was a warn line. That is
    // why the assertion has to read the LIVE parameter: a fix that resolved at
    // persist time but not on the wire would pass a state-only check.
    //
    // Written as a raw `Fn.sub` body rather than through `child.getAtt` so the
    // template really carries the string spelling under test; the DAG edge on
    // `Child` comes from `template-parser.ts`, which reads the same
    // placeholder.
    const subConsumer = new ssm.StringParameter(this, 'SubConsumer', {
      parameterName: `cdkd-nested-parent-sub-${account}`,
      stringValue: cdk.Fn.sub('sub-${Child.Outputs.ChildPlainOutput}-end'),
      description:
        'cdkd nested-stack-secret integ - parent consumer of a child output via Fn::Sub (issue #2270)',
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((subConsumer.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('SubConsumer');

    // THE #2270 ROUND-3 ARM -- the collapse the round-2 fix CREATED.
    //
    // `SubConsumer` above deliberately reads a NON-secret output, which makes
    // it blind to this: once `${Child.Outputs.X}` resolves, a SECRET-bearing
    // one needs POSITIONING, and it had none. `crossStackSourceKey` refused
    // every `Fn::Sub`, and `intrinsicSkeletonPattern`'s `[^}]*` wildcard cannot
    // cross a `{{resolve:...}}` token's own `}}`, so the leaves fell to the
    // plaintext-keyed value scan -- which collapses two references resolving to
    // ONE plaintext onto whichever expression was recorded last, and
    // `resolveReplayProps` then applies the WRONG one to the live resource on a
    // rollback or a `cdkd drift --revert`.
    //
    // BOTH LEAVES SIT IN ONE RESOURCE, and that is load-bearing rather than
    // tidy. `perResourceSecrets` is keyed by logical id, so two SEPARATE
    // resources get two SEPARATE bags, each holding a single pair -- and each
    // would redact correctly with or without the fix, making the arm prove
    // nothing. One resource means one bag holding one collapsed entry, which is
    // the only shape where positioning is what decides the answer.
    //
    // EXACTLY ONE PLACEHOLDER PER LEAF, with nothing around it: that is the
    // shape whose resolved value IS the producer's whole token, so an
    // expression can be persisted for it, and therefore the shape the new key
    // arm accepts. `SubConsumer`'s `sub-...-end` spelling is deliberately the
    // other case.
    const subSecretPair = new ssm.StringParameter(this, 'SubSecretPair', {
      parameterName: `cdkd-nested-parent-subpair-${account}`,
      stringValue: cdk.Fn.sub('${Child.Outputs.ChildSharedOutputA}'),
      // The SECOND leaf of the same resource. A description rather than another
      // parameter precisely so both land in one bag; it holds the same test
      // secret the value does, and the fixture deletes it at teardown.
      description: cdk.Fn.sub('${Child.Outputs.ChildSharedOutputB}'),
    });
    ((subSecretPair.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('SubSecretPair');
  }
}
