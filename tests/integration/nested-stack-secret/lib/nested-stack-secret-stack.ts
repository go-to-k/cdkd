import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';

/**
 * The secret flow across a NESTED-STACK boundary, in BOTH directions.
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SSM::Parameter
 * covers: AWS::Events::Rule
 *
 * Issues [#1903](https://github.com/go-to-k/cdkd/issues/1903) (parameters IN),
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055) (outputs OUT),
 * [#2086](https://github.com/go-to-k/cdkd/issues/2086) (the rollback executor
 * binds the same seed), [#2087](https://github.com/go-to-k/cdkd/issues/2087)
 * (the seed is scoped to the resources that actually consumed the parameter)
 * and [#2291](https://github.com/go-to-k/cdkd/issues/2291) (two parameters
 * resolving to ONE plaintext keep DISTINCT expressions across the handoff) and
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327) (the same, for
 * LIST-typed parameters, whose values are ARRAYS by the time redaction runs)
 * and [#2745](https://github.com/go-to-k/cdkd/issues/2745) (a 1-3 character
 * secret the parent embeds in a parameter through a LITERAL frame reaches the
 * child below the carry's needle floor).
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
 * THE ELEVEN RESOURCES, and what each one discriminates:
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
 *  - `HandoffMixed` (child) — THE #2320 ARM. ONE resource mixing an EMBEDDED
 *    leaf (`Description`, an `Fn::Sub` over `MixedSecretA`) with a WHOLE-VALUE
 *    leaf (`Value`, `{Ref: MixedSecretB}`), the two parameters resolving to ONE
 *    plaintext. The resource's bag holds one slot -- whichever `Ref` resolved
 *    LAST, and `Value` resolves after `Description` -- so the value scan wrote
 *    `B`'s expression into the embedded leaf while the diff side rendered
 *    `A`'s: a perpetual UPDATE. Its own JSON key (`mixed`), so no other arm's
 *    leaf shares its plaintext.
 *  - `HandoffSpans` / `HandoffSpansIf` (child) — THE #4446 ARM. `HandoffMixed`'s
 *    shape with an embedding leaf the #2320 template parse REFUSES: an
 *    `Fn::Join` with TWO parts whose text the template cannot state (the
 *    region and stack-name pseudo parameters around `SpanSecretA`) and a
 *    string-selected `Fn::If` part (#4469), and an
 *    `Fn::If` selecting an `Fn::Sub` over it. Each is positioned from the spans
 *    the RESOLVER recorded while substituting the parameter. Its own JSON key
 *    (`spans`); the two resources have a bag each, so they do not collide.
 *  - `FallthroughPair` (child) — THE #2349 ARM. `Description` is
 *    `{Ref: FallConnA}`, a connection string the parent built around TWO
 *    tokens (so no association can certify it), and `Value` is
 *    `{Ref: FallSecretB}`, a whole token of the SAME password. The parent
 *    resolves `FallSecretB` first, so the password's survivor is
 *    `FallConnA`'s spelling; the child resolves `Value` last, so the
 *    resource's slot holds `FallSecretB`'s. The persist walk scanned that
 *    slot while the diff side scanned the parent's bag: a perpetual UPDATE.
 *    Its own JSON keys (`fall`, `falluser`).
 *  - `ListPair` (child) — THE #2327 ARM. The `CommaDelimitedList` twin of
 *    `HandoffPair`: ONE `AWS::Events::Rule` whose two matchers are ARRAYS by
 *    the time redaction runs, beside a PUBLIC list-typed negative control.
 *  - `PinParam` (child) — THE #2745 ARM. Consumes a parameter the parent
 *    built as a LITERAL frame around a 2-character secret
 *    (`port:{{resolve:...:pin::}}` -> `port:q7`). The value is not a whole
 *    key of the inherited bag and its middle sits below `MIN_NEEDLE_LENGTH`,
 *    so neither arm of the child's carry could see it and the child persisted
 *    `port:q7` in the clear -- a perpetual `cdkd diff --recursive` change as
 *    well as a disclosure. The parent's recorder now hands the framed pair
 *    down as a whole-value entry; `ChildPinOutput` is the outputs-pass twin.
 *  - `PinTwinParam` (child) — THE #3079 ARM. A SECOND parameter in the SAME
 *    literal frame around a DIFFERENT token whose value is the SAME two
 *    characters (`port:{{resolve:...:pintwin::}}` -> `port:q7`). The parent's
 *    bag holds one `q7` slot and one `port:q7` entry, so before #3079 the
 *    losing parameter's child leaf persisted the OTHER token's frame -- the
 *    wrong reference `cdkd rollback` / `drift --revert` re-resolve. Each
 *    child `{Ref}` now binds to its own frame through the parent's per-name
 *    association; which of the two lost the slot is not asserted, both
 *    leaves are.
 *  - `PinJoinParam` (child) — THE #3062 ARM. `PinParam`'s shape over a
 *    parameter the parent spelled as an `Fn::Join` with the account `Ref`
 *    INSIDE the token (`port:{{resolve:...:pinjoin::}}` -> `port:k3`). The
 *    #2745 carry required a STRING source, so this child leaf persisted the
 *    framed plaintext while the parent's own row held the frame.
 *  - `PinSsmNeverMatches` (child condition) — THE #3114 ARM. A parameter the
 *    parent spelled as an `Fn::Join` around an `ssm` SecureString token with
 *    the account `Ref` inside it (`port:{{resolve:ssm:...}}` -> `port:m8`).
 *    Before #3114 the child's parameter, `Ref` and `Fn::Join` debug lines
 *    printed `port:m8`; #3114 masked them through the log twin the parent
 *    registered, since the carry refused the frame. Since #3156 the carry
 *    records a whole-value entry for it and the lines are masked whole.
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
      handoffMixedParamName: string;
      handoffSpansParamName: string;
      handoffSpansIfParamName: string;
      fallthroughParamName: string;
      pinParamName: string;
      pinParamDescription: string;
      pinTwinParamName: string;
      pinJoinParamName: string;
      pinJoinParamDescription: string;
      listRuleName: string;
      unrelatedLiteral: string;
      handoffAllowedPattern?: string;
      listRuleDescription: string;
      plainOutputValue: string;
      sharedReferenceA: string;
      sharedReferenceB: string;
      embedReferenceA: string;
      embedReferenceB: string;
      multiReferenceA: string;
      multiReferenceB: string;
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
    // THE #2320 ARM's two inputs: the same two-spellings-one-plaintext shape on
    // its OWN JSON key, so `HandoffPair` / `HandoffSub` keep theirs.
    const mixedA = new cdk.CfnParameter(this, 'MixedSecretA', { type: 'String' });
    mixedA.overrideLogicalId('MixedSecretA');
    const mixedB = new cdk.CfnParameter(this, 'MixedSecretB', { type: 'String' });
    mixedB.overrideLogicalId('MixedSecretB');
    // THE #4446 ARM's two inputs: the same shape again, on its OWN JSON key.
    const spanA = new cdk.CfnParameter(this, 'SpanSecretA', { type: 'String' });
    spanA.overrideLogicalId('SpanSecretA');
    const spanB = new cdk.CfnParameter(this, 'SpanSecretB', { type: 'String' });
    spanB.overrideLogicalId('SpanSecretB');
    // THE #2349 ARM's two inputs, on their OWN JSON keys.
    const fallConn = new cdk.CfnParameter(this, 'FallConnA', { type: 'String' });
    fallConn.overrideLogicalId('FallConnA');
    const fallSecret = new cdk.CfnParameter(this, 'FallSecretB', { type: 'String' });
    fallSecret.overrideLogicalId('FallSecretB');

    // THE #2327 ARM's two inputs. The SAME two-references-one-plaintext shape as
    // the pair above, declared `CommaDelimitedList` -- which
    // `docs/cli-reference.md` names as an ALLOWED spelling for a secret-bearing
    // nested-stack parameter, alongside `String`. `coerceParameterValue` splits
    // the parent's string on `,` before any redaction runs, so the child's leaf
    // is an ARRAY and the string-only halves of the #2291 mechanism could not
    // answer for it at all.
    //
    // A COMMA-FREE plaintext, which is what makes this shape deployable rather
    // than refused: `refuseCoercedInheritedSecret` measures the ACTUAL value and
    // throws when the `,`-split shreds it (the dominant Secrets Manager JSON
    // blob). `verify.sh`'s `list` key holds a bare token for exactly that reason.
    const listA = new cdk.CfnParameter(this, 'ListSecretA', { type: 'CommaDelimitedList' });
    listA.overrideLogicalId('ListSecretA');
    const listB = new cdk.CfnParameter(this, 'ListSecretB', { type: 'CommaDelimitedList' });
    listB.overrideLogicalId('ListSecretB');

    // THE #2327 ARM's NEGATIVE CONTROL. Same declared type, same `{Ref: <Param>}`
    // source spelling, same resource, same walk -- and a PUBLIC value, so it is
    // refused ONE STEP EARLIER than the element rule: the parent records an
    // association only for a parameter whose resolved value IS a recorded
    // plaintext, so this one has none and `associationForSource` refuses before
    // any element is examined. A rule that certified every element of every list
    // leaf would rewrite this one too, which is the issue #2087 / #1915
    // over-redaction class, so this is what makes the three positive assertions
    // mean "certified" rather than "rewritten".
    const listPublic = new cdk.CfnParameter(this, 'ListPublic', { type: 'CommaDelimitedList' });
    listPublic.overrideLogicalId('ListPublic');

    // THE #2745 ARM's input. The PARENT resolves a LITERAL frame around a
    // 2-character secret (`port:{{resolve:...:pin::}}` -> `port:q7`): the
    // value is not a whole key of the inherited bag and its middle sits below
    // `MIN_NEEDLE_LENGTH`, so neither arm of `inheritedSecretsCarriedBy` could
    // see it. `recordNestedStackParameterExpressions` now records the framed
    // pair on the parent's bag as a WHOLE-VALUE entry, which the carry reads
    // at any length.
    const subFloorPin = new cdk.CfnParameter(this, 'SubFloorPin', { type: 'String' });
    subFloorPin.overrideLogicalId('SubFloorPin');
    // THE #3079 ARM's input: the same frame, another token, the same middle.
    const subFloorPinTwin = new cdk.CfnParameter(this, 'SubFloorPinTwin', { type: 'String' });
    subFloorPinTwin.overrideLogicalId('SubFloorPinTwin');
    // THE #3062 ARM's input: a sub-floor frame the parent spells as an
    // `Fn::Join` rather than a literal -- the object spelling the #2745 carry
    // could not reach. Its OWN JSON key and value, never `pin`'s: see the
    // parent's `pinJoinReference`.
    const subFloorPinJoin = new cdk.CfnParameter(this, 'SubFloorPinJoin', { type: 'String' });
    subFloorPinJoin.overrideLogicalId('SubFloorPinJoin');
    // THE #3114 ARM's input: a sub-floor SecureString the parent spells as an
    // `Fn::Join` whose token is `ssm:`. The parent's carry refused that frame
    // until #3156, when the child's inherited bag had no whole-value entry for
    // it. Consumed ONLY by the condition below, never by a resource property:
    // a condition persists nothing, so this arm reads the child's debug lines
    // without a child leaf; the persisted carry of such a frame is the
    // `nested-stack-3level` fixture's #3156 arm.
    const subFloorPinSsm = new cdk.CfnParameter(this, 'SubFloorPinSsm', { type: 'String' });
    subFloorPinSsm.overrideLogicalId('SubFloorPinSsm');
    const pinSsmCondition = new cdk.CfnCondition(this, 'PinSsmNeverMatches', {
      expression: cdk.Fn.conditionEquals(cdk.Fn.join('', ['x-', subFloorPinSsm.valueAsString]), 'never'),
    });
    pinSsmCondition.overrideLogicalId('PinSsmNeverMatches');

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
    // The MIXED shape -- one embedded and one whole-value leaf over the two
    // colliding parameters in ONE resource -- is `HandoffMixed` below (issue
    // #2320), on its own pair of parameters so this arm stays one-parameter.
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

    // THE #2320 ARM: ONE resource, an EMBEDDED leaf over `MixedSecretA` and a
    // WHOLE-VALUE leaf over `MixedSecretB`, the two resolving to ONE plaintext.
    //
    // THE EMBEDDED LEAF MUST RESOLVE FIRST, which is why it is the
    // `Description` and the whole-value leaf the `Value`: CDK renders SSM
    // properties alphabetically and the child resolves them in that order, so
    // `{Ref: MixedSecretB}` is the LAST `Ref` and owns the bag's one slot.
    // Swapped, the slot would hold `A`'s expression and the value scan would
    // already write the right answer -- a vacuous arm. verify.sh asserts the
    // synthesized order as a premise.
    const handoffMixed = new ssm.StringParameter(this, 'HandoffMixed', {
      parameterName: names.handoffMixedParamName,
      stringValue: mixedB.valueAsString,
      description: cdk.Fn.sub('x-${MixedSecretA}'),
      // VARIES BY `CDKD_TEST_UPDATE`, for the reason `HandoffPair`'s does: in
      // the child-property phase this resource must be a real UPDATE, so the
      // child re-resolves both leaves and re-runs the positioning on the
      // UPDATE path rather than carrying the CREATE record over.
      ...(names.handoffAllowedPattern !== undefined && {
        allowedPattern: names.handoffAllowedPattern,
      }),
    });
    ((handoffMixed.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('HandoffMixed');

    // THE #2349 ARM. Both leaves are bare `{Ref}`s, so neither the #2320 nor
    // the #4446 arm applies. `Description` must resolve FIRST (CDK renders SSM
    // properties alphabetically), so the slot holds `FallSecretB`'s expression
    // while the parent's survivor is `FallConnA`'s -- the order that diverged.
    const fallthroughPair = new ssm.StringParameter(this, 'FallthroughPair', {
      parameterName: names.fallthroughParamName,
      stringValue: fallSecret.valueAsString,
      description: fallConn.valueAsString,
    });
    ((fallthroughPair.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('FallthroughPair');

    // THE #4446 ARM: `HandoffMixed` with an embedding leaf the #2320 template
    // parse refuses, so only the resolver's recorded parameter spans can
    // position it. `Description` before `Value` for the reason given above.
    //
    // TWO UNKNOWN PARTS: the region and stack-name pseudo parameters, whose
    // text the template cannot state, on either side of `SpanSecretA`. Plus a
    // string-selected `Fn::If` part (CDK's `Fn.conditionIf(c, '-prod', '')`),
    // whose own record places no span: it is skipped as a gap rather than
    // dropping the leaf's spans (issue #4469).
    const spansOn = new cdk.CfnCondition(this, 'SpansOn', {
      expression: cdk.Fn.conditionEquals('on', 'on'),
    });
    spansOn.overrideLogicalId('SpansOn');
    const handoffSpans = new ssm.StringParameter(this, 'HandoffSpans', {
      parameterName: names.handoffSpansParamName,
      stringValue: spanB.valueAsString,
      description: cdk.Fn.join('', [
        'postgres://',
        cdk.Aws.REGION,
        ':',
        spanA.valueAsString,
        cdk.Fn.conditionIf(spansOn.logicalId, '-prod', '').toString(),
        '@',
        cdk.Aws.STACK_NAME,
      ]),
      ...(names.handoffAllowedPattern !== undefined && {
        allowedPattern: names.handoffAllowedPattern,
      }),
    });
    ((handoffSpans.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('HandoffSpans');
    // A TOP-LEVEL `Fn::If`, which the template parse never reads at all.
    const handoffSpansIf = new ssm.StringParameter(this, 'HandoffSpansIf', {
      parameterName: names.handoffSpansIfParamName,
      stringValue: spanB.valueAsString,
      description: cdk.Fn.conditionIf(
        spansOn.logicalId,
        cdk.Fn.sub('x-${SpanSecretA}'),
        'none'
      ).toString(),
      ...(names.handoffAllowedPattern !== undefined && {
        allowedPattern: names.handoffAllowedPattern,
      }),
    });
    ((handoffSpansIf.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('HandoffSpansIf');

    // THE #2327 ARM. ONE resource, TWO LIST-typed leaves, for the reason
    // `HandoffPair` states and one this arm makes sharper still.
    //
    // `perResourceSecrets` is keyed by logical id, so two resources would give
    // two bags. Today that would STILL discriminate, by accident rather than by
    // design: the #2291 override in `recordInheritedParameterSecrets` could not
    // fire for an array (it gated on `plaintext === value`, never true for one),
    // so both bags kept the collapsed survivor. #2327 fixes that override in the
    // SAME change, at which point a two-resource arm would go vacuous -- each
    // bag would hold its own parameter's expression and redact correctly with or
    // without the position arm. One resource, one bag holding ONE collapsed
    // entry, is the shape where the position arm alone decides the answer, and
    // it stays that shape after the override is fixed.
    //
    // AN `AWS::Events::Rule` rather than another SSM parameter because the leaf
    // has to be a genuine LIST that AWS accepts: an `EventPattern`'s `detail`
    // matcher takes a list of arbitrary exact-match strings, needs no other
    // resource, and the provider round-trips the pattern as an object. No SSM
    // parameter property is list-valued at all.
    const listPair = new events.CfnRule(this, 'ListPair', {
      name: names.listRuleName,
      // VARIES BY `CDKD_TEST_UPDATE`, for the reason `HandoffPair`'s
      // `allowedPattern` does: phase 2c must drive the parent's `Child` row
      // through `NestedStackProvider.update` AND make this resource itself a
      // real UPDATE, or the child treats it as unchanged, never re-resolves its
      // two leaves, and the phase asserts over a state.json nothing rewrote. A
      // THIRD property, because both leaves are what every assertion reads.
      description: names.listRuleDescription,
      eventPattern: {
        source: ['cdkd.integ.nested-stack-secret'],
        detail: {
          // Two leaves of ONE resource, each an ARRAY once the child has coerced
          // its parameter. Under the collapse BOTH persist the survivor's
          // expression and `cdkd drift --revert` / rollback pushes the WRONG
          // version stage to the live rule.
          listA: listA.valueAsList,
          listB: listB.valueAsList,
          // The negative control, beside them in ONE bag so it goes through
          // the same arm on the same walk.
          listPublic: listPublic.valueAsList,
        },
      },
    });
    listPair.overrideLogicalId('ListPair');

    // THE #2745 ARM. A bare `{Ref: SubFloorPin}` leaf carries no expression
    // text for the position pass, so what redacts it is the inherited carry
    // of the framed pair -- whole-value, and at seven characters the substring
    // arm too; a resource of its own because the destination bag is scoped
    // per logical id.
    const pinParam = new ssm.StringParameter(this, 'PinParam', {
      parameterName: names.pinParamName,
      stringValue: subFloorPin.valueAsString,
      // VARIES BY `CDKD_TEST_UPDATE`, for the reason `StageParam`'s does:
      // phase 2c must make this resource a real UPDATE so the child genuinely
      // re-resolves the leaf off the UPDATE call site's recorder, or the
      // phase asserts over a state.json nothing rewrote.
      description: names.pinParamDescription,
    });
    ((pinParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('PinParam');

    // THE #3079 ARM. Its own resource, like `PinParam`: the child's bag is
    // scoped per logical id, so the two leaves land in two bags, and what
    // this arm measures is the per-NAME association the parent hands down,
    // not the plaintext-keyed slot (one bag consuming both would exercise
    // the slot as well; that shape is pinned in the unit suite).
    const pinTwinParam = new ssm.StringParameter(this, 'PinTwinParam', {
      parameterName: names.pinTwinParamName,
      stringValue: subFloorPinTwin.valueAsString,
      description: 'cdkd nested-stack-secret integ - #3079 sub-floor framed twin parameter',
    });
    ((pinTwinParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('PinTwinParam');

    // THE #3062 ARM. `PinParam`'s shape over a parameter the parent spelled as
    // an `Fn::Join`: the carry used to require a STRING source, so the child
    // persisted this leaf's framed plaintext while the parent's own row held
    // the frame. Its own resource for the reason `PinParam` gives.
    const pinJoinParam = new ssm.StringParameter(this, 'PinJoinParam', {
      parameterName: names.pinJoinParamName,
      stringValue: subFloorPinJoin.valueAsString,
      // VARIES BY `CDKD_TEST_UPDATE`, for the reason `PinParam`'s does: phase
      // 2c must make this resource a real UPDATE so the child re-resolves the
      // leaf off the UPDATE call site's recorder.
      description: names.pinJoinParamDescription,
    });
    ((pinJoinParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('PinJoinParam');

    // The OUTPUTS-pass twin of `PinParam`: the child's outputs walk carries
    // the same inherited bag, so a `{Ref: SubFloorPin}` output persists the
    // frame through the same whole-value entry. Deliberately NOT consumed by
    // the parent: a parent `Fn::GetAtt` over it re-resolves to `port:q7`,
    // where the cross-stack seam refuses a non-token and the consumer's own
    // record persists the plaintext -- residual (d) on the recorder's
    // docstring, stated there rather than pinned as behaviour here.
    const pinOutput = new cdk.CfnOutput(this, 'ChildPinOutput', {
      value: subFloorPin.valueAsString,
      description: 'cdkd nested-stack-secret integ - sub-floor framed child output (issue #2745)',
    });
    pinOutput.overrideLogicalId('ChildPinOutput');

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

    // THE #2298 PAIR's producer: the `shared` trick on its OWN JSON key
    // (`embed`), so `SubSecretPair`'s answer never depends on this arm. The
    // parent EMBEDS each in surrounding text (`EmbedSecretPair`).
    const embedOutputA = new cdk.CfnOutput(this, 'ChildEmbedOutputA', {
      value: names.embedReferenceA,
      description:
        'cdkd nested-stack-secret integ - embedded-read secret output, default stage (issue #2298)',
    });
    embedOutputA.overrideLogicalId('ChildEmbedOutputA');

    const embedOutputB = new cdk.CfnOutput(this, 'ChildEmbedOutputB', {
      value: names.embedReferenceB,
      description:
        'cdkd nested-stack-secret integ - the SIBLING, same plaintext, different expression (issue #2298)',
    });
    embedOutputB.overrideLogicalId('ChildEmbedOutputB');

    // THE #4527 PAIR's producer, on its OWN JSON key (`multi`), so neither
    // `EmbedSecretPair` nor this arm's answer depends on the other. The parent
    // embeds each beside TWO pseudo parameters (`MultiUnknownSecretPair`).
    const multiOutputA = new cdk.CfnOutput(this, 'ChildMultiOutputA', {
      value: names.multiReferenceA,
      description:
        'cdkd nested-stack-secret integ - read embedded beside two unknown parts, default stage (issue #4527)',
    });
    multiOutputA.overrideLogicalId('ChildMultiOutputA');

    const multiOutputB = new cdk.CfnOutput(this, 'ChildMultiOutputB', {
      value: names.multiReferenceB,
      description:
        'cdkd nested-stack-secret integ - the SIBLING, same plaintext, different expression (issue #4527)',
    });
    multiOutputB.overrideLogicalId('ChildMultiOutputB');

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
    // The #2327 arm's own phase-2c change, on the same token, for the same
    // reason: `ListPair` must genuinely become an UPDATE in that phase or its
    // assertions pass over a state.json nothing rewrote.
    const listRuleDescription = updateMode.includes('child-property')
      ? 'cdkd nested-stack-secret integ - #2327 list-typed inherited parameter pair (updated)'
      : 'cdkd nested-stack-secret integ - #2327 list-typed inherited parameter pair';
    const stageParamDescription = updateMode.includes('child-property')
      ? 'cdkd nested-stack-secret integ - child consumer of the secretsmanager parameter (updated)'
      : 'cdkd nested-stack-secret integ - child consumer of the secretsmanager parameter';
    // The #2745 arm's own phase-2c change, on the same token, for the same
    // reason: `PinParam` must genuinely become an UPDATE in that phase.
    const pinParamDescription = updateMode.includes('child-property')
      ? 'cdkd nested-stack-secret integ - #2745 sub-floor framed parameter (updated)'
      : 'cdkd nested-stack-secret integ - #2745 sub-floor framed parameter';
    // The #3062 arm's own phase-2c change, on the same token, for the same
    // reason: `PinJoinParam` must genuinely become an UPDATE in that phase.
    const pinJoinParamDescription = updateMode.includes('child-property')
      ? 'cdkd nested-stack-secret integ - #3062 sub-floor Fn::Join framed parameter (updated)'
      : 'cdkd nested-stack-secret integ - #3062 sub-floor Fn::Join framed parameter';

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
    // THE #2298 PAIR, on its OWN JSON key (`embed`), for the reason `mixed` has
    // one. Kept in sync with verify.sh's secret JSON.
    const embedReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:embed::}}`;
    const embedReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:embed:AWSCURRENT:}}`;
    // THE #4527 PAIR, on its OWN JSON key (`multi`). Kept in sync with
    // verify.sh's secret JSON.
    const multiReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:multi::}}`;
    const multiReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:multi:AWSCURRENT:}}`;
    // THE #2291 PAIR. Same two-spellings-one-value trick, on a THIRD JSON key
    // so its plaintext is its own: sharing `stage` or `shared` would drag
    // `StageParam` / `SubSecretPair` into this collapse, which is exactly how
    // the first cut of the #2270 arm broke the #1903 assertion. These two are
    // handed to the child as PARAMETERS.
    const handoffReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:handoff::}}`;
    const handoffReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:handoff:AWSCURRENT:}}`;
    // THE #2320 PAIR, on its OWN JSON key (`mixed`): sharing `handoff` would put
    // `HandoffSub`'s leaf in the same collapse and make its answer depend on
    // which arm resolved last. Kept in sync with verify.sh's secret JSON.
    const mixedReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:mixed::}}`;
    const mixedReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:mixed:AWSCURRENT:}}`;
    // THE #4446 PAIR, on its OWN JSON key (`spans`), for the reason `mixed` has
    // one. Kept in sync with verify.sh's secret JSON.
    const spanReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:spans::}}`;
    const spanReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:spans:AWSCURRENT:}}`;
    // THE #2349 PAIR, on its OWN JSON key (`fall`), plus a `falluser` key for
    // the connection string's second token. Kept in sync with verify.sh's
    // secret JSON.
    const fallReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:fall::}}`;
    const fallReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:fall:AWSCURRENT:}}`;
    const fallUserReference = `{{resolve:secretsmanager:${secretName}:SecretString:falluser::}}`;
    // THE #2327 PAIR. Same two-spellings-one-value trick, on a FOURTH JSON key
    // so its plaintext is its own -- sharing any of `stage` / `shared` /
    // `handoff` would drag that arm's only-leaf premise into this collapse.
    // Handed to the child as LIST-typed `Parameters`.
    const listReferenceA = `{{resolve:secretsmanager:${secretName}:SecretString:list::}}`;
    const listReferenceB = `{{resolve:secretsmanager:${secretName}:SecretString:list:AWSCURRENT:}}`;
    // THE #2745 FRAME. A FIFTH JSON key holding a 2-character value, spelled
    // as a LITERAL string that embeds the token: `port:` + the reference. The
    // parent resolves it to `port:q7` before the child exists. A literal on
    // purpose -- issue #2745 scopes its nested-stack site to this spelling;
    // the `cdk.Fn.join` spelling is `pinJoinReference` below (issue #3062).
    const pinReference = `port:{{resolve:secretsmanager:${secretName}:SecretString:pin::}}`;
    // THE #3062 FRAME. A SEVENTH JSON key (`pinjoin`) with its OWN 2-character
    // value, spelled as an `Fn::Join` that CDK cannot fold: `cdk.Aws.ACCOUNT_ID`
    // is always the `{Ref: AWS::AccountId}` pseudo-parameter, so it lands
    // INSIDE the token as a non-literal part -- the L2 `secretValueFromJson`
    // shape. `account` above is concrete under cdkd's synth and would fold the
    // join into a literal, exercising the #2745 arm instead. Its own value,
    // never `pin`'s: the literal arm's `port:q7` entry would redact a join
    // resolving to the same framed value with the object carry absent.
    // Kept in sync with verify.sh's secret JSON (`pinjoin`).
    const pinJoinReference = cdk.Fn.join('', [
      'port:{{resolve:secretsmanager:cdkd-nested-secret-',
      cdk.Aws.ACCOUNT_ID,
      ':SecretString:pinjoin::}}',
    ]);
    // THE #3114 FRAME. `pinJoinReference`'s shape around an `ssm` SecureString
    // token (verify.sh creates it with a 2-character value). An intrinsic frame
    // whose token spells `ssm:` is one `recordNestedStackParameterExpressions`
    // refused to carry before #3156, when the child read the mask only through
    // the parent's log twin; it now carries it as a whole-value entry. Kept in
    // sync with verify.sh's `PIN_SSM_PARAM_NAME`.
    const pinSsmReference = cdk.Fn.join('', [
      'port:{{resolve:ssm:cdkd-nested-pinssm-',
      cdk.Aws.ACCOUNT_ID,
      '}}',
    ]);
    // THE #3079 TWIN. A SIXTH JSON key holding the SAME two characters as
    // `pin`, in the SAME `port:` frame -- two tokens, one middle, one frame.
    // Kept in sync with verify.sh's secret JSON (`pintwin`).
    const pinTwinReference = `port:{{resolve:secretsmanager:${secretName}:SecretString:pintwin::}}`;
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
        handoffMixedParamName: `cdkd-nested-child-handoffmixed-${account}`,
        handoffSpansParamName: `cdkd-nested-child-handoffspans-${account}`,
        handoffSpansIfParamName: `cdkd-nested-child-handoffspansif-${account}`,
        fallthroughParamName: `cdkd-nested-child-fallthrough-${account}`,
        pinParamName: `cdkd-nested-child-pin-${account}`,
        pinParamDescription,
        pinTwinParamName: `cdkd-nested-child-pintwin-${account}`,
        pinJoinParamName: `cdkd-nested-child-pinjoin-${account}`,
        pinJoinParamDescription,
        listRuleName: `cdkd-nested-child-listpair-${account}`,
        listRuleDescription,
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
        embedReferenceA,
        embedReferenceB,
        multiReferenceA,
        multiReferenceB,
        stageParamDescription,
      },
      {
        parameters: {
          SecretStage: stageReference,
          SecurePassword: secureReference,
          // The #2291 pair. TWO parameters, ONE resolved plaintext.
          HandoffSecretA: handoffReferenceA,
          HandoffSecretB: handoffReferenceB,
          // The #2320 pair. TWO parameters, ONE resolved plaintext, ONE resource.
          MixedSecretA: mixedReferenceA,
          MixedSecretB: mixedReferenceB,
          // The #4446 pair. TWO parameters, ONE resolved plaintext.
          SpanSecretA: spanReferenceA,
          SpanSecretB: spanReferenceB,
          // The #2349 pair. `FallSecretB` FIRST, so the parent resolves
          // `FallConnA`'s password token last and it is the survivor.
          FallSecretB: fallReferenceB,
          FallConnA: `postgres://${fallUserReference}:${fallReferenceA}@host`,
          // The #2327 pair. TWO LIST-typed parameters, ONE resolved plaintext.
          ListSecretA: listReferenceA,
          ListSecretB: listReferenceB,
          // Kept in sync with verify.sh's LIST_PUBLIC_VALUE.
          ListPublic: 'listpublic2327',
          // The #2745 frame: ONE parameter, a literal `port:` + token.
          SubFloorPin: pinReference,
          // The #3079 twin: the same frame around another token.
          SubFloorPinTwin: pinTwinReference,
          // The #3062 frame: an `Fn::Join` with the account `Ref` inside the token.
          SubFloorPinJoin: pinJoinReference,
          // The #3114 frame: an `Fn::Join` around an `ssm` SecureString token.
          SubFloorPinSsm: pinSsmReference,
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

    // THE #2298 ARM -- `SubSecretPair`'s collapse with each read EMBEDDED in
    // surrounding text, the shape `SubSecretPair` deliberately avoids. Such a
    // leaf is not one reference, so no whole-leaf key exists for it and both
    // fell to the plaintext-keyed value scan: each persisted the SURVIVOR's
    // expression inside its frame. Both leaves are embedded, and in the two
    // spellings (`Fn::Sub` placeholder, `Fn::Join` element), so a collapse is
    // visible whichever expression the scan kept. ONE resource, for the reason
    // `SubSecretPair` gives.
    const embedSecretPair = new ssm.StringParameter(this, 'EmbedSecretPair', {
      parameterName: `cdkd-nested-parent-embedpair-${account}`,
      stringValue: cdk.Fn.sub('jdbc:mysql://db:3306/app?password=${Child.Outputs.ChildEmbedOutputA}'),
      // Raw `Fn::GetAtt` so the template carries the `Fn::Join` element spelling.
      description: cdk.Fn.join('', [
        'pw=',
        cdk.Fn.getAtt('Child', 'Outputs.ChildEmbedOutputB').toString(),
      ]),
    });
    ((embedSecretPair.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('EmbedSecretPair');

    // THE #4527 ARM -- `EmbedSecretPair` with each read beside TWO parts whose
    // text the template cannot state (`AWS::Region`, `AWS::AccountId`), and
    // the second under an `Fn::If`. The #2298 template parse aligns at most
    // ONE such part and never reads an `Fn::If`, so both leaves fell to the
    // plaintext-keyed value scan and each persisted the SURVIVOR's expression
    // inside its frame; only the resolver's own span for each read positions
    // them. ONE resource, for the reason `SubSecretPair` gives.
    const multiOn = new cdk.CfnCondition(this, 'MultiOn', {
      expression: cdk.Fn.conditionEquals('on', 'on'),
    });
    multiOn.overrideLogicalId('MultiOn');
    const multiUnknownSecretPair = new ssm.StringParameter(this, 'MultiUnknownSecretPair', {
      parameterName: `cdkd-nested-parent-multipair-${account}`,
      stringValue: cdk.Fn.sub(
        'jdbc:mysql://${AWS::Region}.${AWS::AccountId}.host/?pw=${Child.Outputs.ChildMultiOutputA}'
      ),
      description: cdk.Fn.conditionIf(
        multiOn.logicalId,
        cdk.Fn.join('/', [
          cdk.Aws.REGION,
          cdk.Aws.ACCOUNT_ID,
          cdk.Fn.getAtt('Child', 'Outputs.ChildMultiOutputB').toString(),
        ]),
        'none'
      ).toString(),
    });
    const multiPairCfn = multiUnknownSecretPair.node.defaultChild as ssm.CfnParameter;
    multiPairCfn.overrideLogicalId('MultiUnknownSecretPair');
    // The SWAPPED arrangement on two tag values of the SAME resource: B in the
    // `Fn::Sub` spelling, A under the `Fn::If`. With the two above, each
    // spelling carries each expression, so reverting either half of the fix
    // (the `${Res.Attr}` span, the object-read span) leaves one leaf on the
    // value scan whichever expression it kept. Tag-legal characters only.
    multiPairCfn.addPropertyOverride('Tags', {
      MultiSwapSub: {
        'Fn::Sub': '${AWS::Region}.${AWS::AccountId}:pw=${Child.Outputs.ChildMultiOutputB}',
      },
      MultiSwapIf: {
        'Fn::If': [
          'MultiOn',
          {
            'Fn::Join': [
              '/',
              [
                { Ref: 'AWS::Region' },
                { Ref: 'AWS::AccountId' },
                { 'Fn::GetAtt': ['Child', 'Outputs.ChildMultiOutputA'] },
              ],
            ],
          },
          'none',
        ],
      },
    });
  }
}
