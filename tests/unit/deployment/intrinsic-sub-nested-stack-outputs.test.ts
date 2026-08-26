import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

/**
 * Issue [#2270](https://github.com/go-to-k/cdkd/issues/2270). TWO separable
 * changes, and this file keeps their fences separable too — reverting either
 * one alone must red a DIFFERENT set of cases below, which is the only way to
 * know both are actually held:
 *
 *  1. `resolveGetAtt`'s STRING spelling splits on the FIRST dot, so
 *     `Child.Outputs.Foo` parses as `["Child", "Outputs.Foo"]` — matching
 *     CloudFormation, matching the ARRAY spelling, and matching the split
 *     `template-parser.ts` already uses to draw the DAG edge for the identical
 *     `Fn::Sub` placeholder. Fenced by "resolves ..." below.
 *  2. `resolveSub`'s catch no longer launders a STRUCTURAL failure into a kept
 *     literal. A placeholder whose head segment names a resource this template
 *     DECLARES is a reference, not text, so its failure re-throws. Fenced by
 *     "refuses ..." below, whose premise (a declared resource ABSENT from
 *     state) change 1 cannot resolve.
 *
 * The counter-cases are load-bearing in the other direction: change 2 narrows
 * what `Fn::Sub` accepts, and a guard with no over-tightening cases would not
 * notice it had started refusing input cdkd has always accepted.
 */
describe('Fn::Sub / Fn::GetAtt over a nested stack Outputs reference (issue #2270)', () => {
  const CHILD_OUTPUT = 'child-output-value-2270';

  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    warnSpy.mockClear();
  });

  /** Parent template declaring the nested stack plus one ordinary resource. */
  const template: CloudFormationTemplate = {
    Resources: {
      Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} },
      Cluster: { Type: 'AWS::RDS::DBCluster', Properties: {} },
    },
  } as unknown as CloudFormationTemplate;

  /**
   * `Child` present in STATE with the flat `Outputs.<Key>` dot-key
   * `NestedStackProvider.buildOutputsAttributes` writes.
   */
  const deployed = (): ResolverContext => ({
    template,
    resources: {
      Child: {
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:stack/Parent~Child',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: { 'Outputs.Foo': CHILD_OUTPUT },
        dependencies: [],
      },
      Cluster: {
        physicalId: 'my-cluster',
        resourceType: 'AWS::RDS::DBCluster',
        properties: {},
        attributes: { 'Endpoint.Address': 'my-cluster.rds.amazonaws.com' },
        dependencies: [],
      },
    },
  });

  /**
   * The change-2 premise: `Child` is DECLARED by the template but is not in
   * state, so every resolution of it fails structurally. Change 1 cannot make
   * this one resolve, which is what keeps the two fences apart.
   */
  const declaredButNotDeployed = (): ResolverContext => ({ template, resources: {} });

  /** A template DECLARING `name` (and nothing in state), for the retry-mark cases. */
  const declaredWithout = (name: string): ResolverContext => ({
    template: {
      Resources: { [name]: { Type: 'AWS::Example::Widget', Properties: {} } },
    } as unknown as CloudFormationTemplate,
    resources: {},
  });

  // ---------------------------------------------------------------------
  // Change 1 — the three-segment STRING form resolves.
  // ---------------------------------------------------------------------

  it('resolves an Fn::Sub over ${Child.Outputs.Foo} instead of keeping the literal', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'value=${Child.Outputs.Foo}!' },
      deployed()
    );
    // The DISCRIMINATOR is the substituted value. Asserting only "no
    // placeholder text" would also pass on a resolver that returned an empty
    // string, and asserting only "throws" would pass on the refusal half.
    expect(result).toBe(`value=${CHILD_OUTPUT}!`);
    expect(result).not.toContain('${Child.Outputs.Foo}');
  });

  it('resolves the bare Fn::GetAtt STRING spelling of the same reference', async () => {
    const result = await resolver.resolve({ 'Fn::GetAtt': 'Child.Outputs.Foo' }, deployed());
    expect(result).toBe(CHILD_OUTPUT);
  });

  it('the STRING and ARRAY spellings of one reference agree', async () => {
    const context = deployed();
    const asString = await resolver.resolve({ 'Fn::GetAtt': 'Child.Outputs.Foo' }, context);
    const asArray = await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.Foo'] },
      context
    );
    expect(asString).toBe(asArray);
  });

  it('resolves a dotted NON-nested-stack attribute too (Cluster.Endpoint.Address)', async () => {
    // `Outputs.` is not a special case in the split — every CloudFormation
    // attribute name that contains a dot takes the same parse.
    const result = await resolver.resolve(
      { 'Fn::Sub': 'host=${Cluster.Endpoint.Address}' },
      deployed()
    );
    expect(result).toBe('host=my-cluster.rds.amazonaws.com');
  });

  it('still rejects the string spellings that name no attribute at all', async () => {
    const context = deployed();
    // No dot: no attribute name.
    await expect(resolver.resolve({ 'Fn::GetAtt': 'Child' }, context)).rejects.toThrow(
      'Invalid Fn::GetAtt format: Child'
    );
    // Leading dot: no logical id.
    await expect(resolver.resolve({ 'Fn::GetAtt': '.Outputs' }, context)).rejects.toThrow(
      'Invalid Fn::GetAtt format: .Outputs'
    );
    // Trailing dot: empty attribute name.
    await expect(resolver.resolve({ 'Fn::GetAtt': 'Child.' }, context)).rejects.toThrow(
      'Invalid Fn::GetAtt format: Child.'
    );
  });

  // ---------------------------------------------------------------------
  // Change 2 — a STRUCTURAL Fn::Sub failure refuses instead of shipping text.
  // ---------------------------------------------------------------------

  it('refuses an Fn::Sub whose ${X.Attr} names a DECLARED resource that fails to resolve', async () => {
    // Message-AGNOSTIC on purpose. The two halves throw different messages
    // here (`Resource Child not found for Fn::GetAtt` with change 1 in place,
    // `Invalid Fn::GetAtt format` without it), and pinning either one would
    // make this case red when change 1 alone is reverted — which is exactly
    // the independence the probe has to measure. The discriminator is
    // throw-vs-return: the pre-fix resolver returned the literal string.
    await expect(
      resolver.resolve({ 'Fn::Sub': 'v=${Child.Outputs.Foo}' }, declaredButNotDeployed())
    ).rejects.toThrow();
  });

  it('refuses a BARE ${X} naming a declared resource that is not in state', async () => {
    // The Ref arm of the same rule: `${Child}` is an implicit `Ref Child`, so
    // it is a reference and never ordinary text.
    await expect(
      resolver.resolve({ 'Fn::Sub': 'v=${Child}' }, declaredButNotDeployed())
    ).rejects.toThrow();
  });

  it('a refused placeholder emits NO keep-the-placeholder warning', async () => {
    // The pre-fix signal was a warn line plus a shipped literal. Both are
    // gone; a warning still being emitted would mean the keep path ran.
    await expect(
      resolver.resolve({ 'Fn::Sub': 'v=${Child.Outputs.Foo}' }, declaredButNotDeployed())
    ).rejects.toThrow();
    const kept = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('keeping placeholder'));
    expect(kept).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Counter-cases: everything change 2 must LEAVE ALONE.
  // ---------------------------------------------------------------------

  it('keeps ORDINARY DOTTED TEXT whose head names nothing', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'echo ${config.value}' },
      declaredButNotDeployed()
    );
    expect(result).toBe('echo ${config.value}');
  });

  it('keeps ORDINARY BARE TEXT whose name is not a declared resource', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'cd ${some_shell_var}' },
      declaredButNotDeployed()
    );
    expect(result).toBe('cd ${some_shell_var}');
  });

  it('keeps an EMPTY ${} verbatim', async () => {
    const result = await resolver.resolve({ 'Fn::Sub': 'a${}b' }, declaredButNotDeployed());
    expect(result).toBe('a${}b');
  });

  it('leaves the ${!Literal} ESCAPE alone even when it names a declared resource', async () => {
    // `${!Child.Outputs.Foo}` is CloudFormation's escape: it renders the
    // literal text and must never reach the reference path, so the refusal
    // must not fire on it.
    const result = await resolver.resolve(
      { 'Fn::Sub': '${!Child.Outputs.Foo}' },
      declaredButNotDeployed()
    );
    expect(result).toBe('${Child.Outputs.Foo}');
  });

  it('resolves PSEUDO PARAMETERS unchanged', async () => {
    const context = declaredButNotDeployed();
    context.stackName = 'ParentStack';
    // `AWS::StackName` reads straight off the context, so it pins an exact
    // value without depending on what the STS mock reports.
    expect(await resolver.resolve({ 'Fn::Sub': 'n=${AWS::StackName}' }, context)).toBe(
      'n=ParentStack'
    );
    // `AWS::Region` is derived from the account lookup; the point here is only
    // that it substitutes rather than being kept or refused.
    const region = await resolver.resolve({ 'Fn::Sub': 'r=${AWS::Region}' }, context);
    expect(region).toMatch(/^r=[a-z]{2}-[a-z]+-\d$/);
  });

  it('resolves a ${Parameter} reference unchanged', async () => {
    const context = declaredButNotDeployed();
    context.parameters = { Stage: 'prod' };
    const result = await resolver.resolve({ 'Fn::Sub': 's=${Stage}' }, context);
    expect(result).toBe('s=prod');
  });

  it('resolves a ${Resource} Ref that IS in state', async () => {
    const result = await resolver.resolve({ 'Fn::Sub': 'c=${Cluster}' }, deployed());
    expect(result).toBe('c=my-cluster');
  });

  it('the 2-arg variable map still wins, short-circuiting the refusal', async () => {
    const result = await resolver.resolve(
      {
        'Fn::Sub': [
          'v=${Child.Outputs.Foo}',
          { 'Child.Outputs.Foo': 'from-the-map' },
        ],
      },
      declaredButNotDeployed()
    );
    expect(result).toBe('v=from-the-map');
  });

  // -------------------------------------------------------------------
  // Round 3 -- the four defects independent review found in the round-2 fix.
  // -------------------------------------------------------------------

  it('the context.resources ARM fires on its own, with an EMPTY template Resources', async () => {
    // Item 5. Until this case the `context.resources` arm was UNFENCED:
    // every `refuses ...` case above uses `declaredButNotDeployed()`, whose
    // `resources` is `{}`, so only the TEMPLATE arm ever ran and neutering the
    // resources arm reddened 0 of 1678 cases in this directory.
    //
    // The discriminator is the pairing: `Resources: {}` makes the template arm
    // structurally unable to fire, so a throw here can only come from the
    // `context.resources` arm. `${Child.}` is the failure shape -- a live
    // resource with a malformed attribute -- which reaches
    // `Invalid Fn::GetAtt format`, a PLAIN Error, so the #1740 refusal-class
    // test cannot account for it either.
    const context: ResolverContext = {
      template: { Resources: {} } as unknown as CloudFormationTemplate,
      resources: deployed().resources,
    };
    await expect(resolver.resolve({ 'Fn::Sub': 'v=${Child.}' }, context)).rejects.toThrow(
      /Invalid Fn::GetAtt format/
    );
  });

  it('the two arms are independent: an unknown head still keeps the placeholder', async () => {
    // The counter-case that stops the arm above from being satisfied by a
    // blanket "always refuse": same empty template, same populated resources,
    // a head that is in NEITHER map.
    const context: ResolverContext = {
      template: { Resources: {} } as unknown as CloudFormationTemplate,
      resources: deployed().resources,
    };
    const result = await resolver.resolve({ 'Fn::Sub': 'v=${Nope.Attr}' }, context);
    expect(result).toBe('v=${Nope.Attr}');
  });

  it('MARKS the cdkd-authored escaping errors non-retryable', async () => {
    // Item 2. These messages interpolate template-controlled logical ids, and
    // `isRetryableTransientError` matches by BARE SUBSTRING over patterns
    // including `Throttling` / `SlowDown` / `DependencyViolation` -- all legal
    // logical-id substrings. Escaping `Fn::Sub`'s catch (which this PR made
    // possible) puts them inside the parent's `withRetry` via
    // `NestedStackProvider.create`, so an unmarked refusal is RETRIED.
    // The remedy is the MARK, never a re-worded message: the re-throw must
    // hand back the original error object untouched.
    const notFound = await resolver
      .resolve({ 'Fn::Sub': 'v=${ThrottlingWidget.Arn}' }, declaredWithout('ThrottlingWidget'))
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(notFound).toBeInstanceOf(Error);
    // The premise: this message really does carry a retry pattern.
    expect((notFound as Error).message).toContain('Throttling');
    expect(isMarkedNonRetryable(notFound as Error)).toBe(true);

    const malformed = await resolver
      .resolve({ 'Fn::Sub': 'v=${SlowDownThing.}' }, declaredWithout('SlowDownThing'))
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect((malformed as Error).message).toContain('SlowDown');
    expect(isMarkedNonRetryable(malformed as Error)).toBe(true);

    const badRef = await resolver
      .resolve({ 'Fn::Sub': 'v=${DependencyViolationThing}' }, declaredWithout('DependencyViolationThing'))
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect((badRef as Error).message).toContain('DependencyViolation');
    expect(isMarkedNonRetryable(badRef as Error)).toBe(true);
  });

  it('REFUSES a nested-stack output the child does not declare', async () => {
    // Item 3. `constructAttribute` has no `AWS::CloudFormation::Stack` case, so
    // this used to fall to `guardedPhysicalIdFallback` -- whose ARN-shape guard
    // is `!physicalId.startsWith('arn:')` and a nested stack's synthetic id
    // DOES start with `arn:`. The #1103 guard therefore passed and the bogus
    // `arn:cdkd-local:...` partition shipped into a free-text property.
    const context = deployed();
    const error = await resolver
      .resolve({ 'Fn::GetAtt': 'Child.Outputs.TypoArn' }, context)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    // The positive marker: the synthetic ARN must NOT be what comes back.
    expect((error as Error).message).toContain('declares no output named');
    expect((error as Error).message).toContain('TypoArn');
    // The message names what the child DOES declare, so the fix is actionable.
    expect((error as Error).message).toContain('Foo');
    expect(isMarkedNonRetryable(error as Error)).toBe(true);
  });

  it('does NOT refuse an ABSENT Outputs.-prefixed attribute on a NON-nested-stack resource', async () => {
    // THE CONJUNCT COUNTER-CASE. Deleting
    // `resource.resourceType === NESTED_STACK_RESOURCE_TYPE &&` from the
    // refusal reddened 0 of 1689 cases in this directory: only the `Outputs.`
    // prefix test was fenced, so nothing stopped the hard refusal from firing
    // on any resource whose attribute merely STARTS with `Outputs.`.
    //
    // THE ATTRIBUTE MUST BE ABSENT for this to discriminate, and the first cut
    // of this case got that wrong: with `Outputs.Foo` PRESENT the flat-key
    // lookup returns at the top of `resolveGetAtt` and the refusal is never
    // reached, so the case passed with the conjunct deleted. Absence is the
    // only path that reaches it.
    //
    // Reachable, not hypothetical: a `Custom::` resource returns arbitrary
    // `Data` keys, so an author is free to reference one named `Outputs.Foo`
    // that the handler did not return. Only a nested stack's outputs are known
    // exhaustively, which is the entire premise of the refusal -- for every
    // other type an absent attribute must keep falling through to
    // `constructAttribute`, which answers with the physical id.
    const context: ResolverContext = {
      template: {
        Resources: { Widget: { Type: 'Custom::Thing', Properties: {} } },
      } as unknown as CloudFormationTemplate,
      resources: {
        Widget: {
          physicalId: 'custom-widget-1',
          resourceType: 'Custom::Thing',
          properties: {},
          attributes: { SomethingElse: 'x' },
          dependencies: [],
        },
      },
    };
    await expect(
      resolver.resolve({ 'Fn::GetAtt': 'Widget.Outputs.Foo' }, context)
    ).resolves.toBe('custom-widget-1');
  });

  it('a nested-stack output that DOES exist still resolves (counter-case)', async () => {
    // Stops the refusal above from being satisfied by a blanket refusal of
    // every `Outputs.` attribute.
    expect(await resolver.resolve({ 'Fn::GetAtt': 'Child.Outputs.Foo' }, deployed())).toBe(
      CHILD_OUTPUT
    );
  });

  it('draws a DAG edge for the Fn::GetAtt STRING spelling', () => {
    // Item 4. Both graph sites required `Array.isArray(getAtt)`, so the string
    // spelling this PR made RESOLVE drew no edge at all -- turning a formerly
    // loud failure into a silent race in which the consumer can be provisioned
    // before the resource it reads.
    const consumer = {
      Type: 'AWS::SSM::Parameter',
      Properties: { Value: { 'Fn::GetAtt': 'Child.Outputs.Foo' } },
    };
    expect([...new TemplateParser().extractDependencies(consumer)]).toEqual(['Child']);

    // And end to end through the graph the deploy actually orders on.
    const graphTemplate = {
      Resources: {
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} },
        Consumer: consumer,
      },
    } as unknown as CloudFormationTemplate;
    const graph = new DagBuilder().buildGraph(graphTemplate);
    expect(graph.predecessors('Consumer') ?? []).toContain('Child');
  });

  it('the dag-builder half of item 4 fires too (custom-resource policy edges)', () => {
    // `DagBuilder.extractLogicalIdFromReference` is a SECOND string-form parser,
    // reached from `addCustomResourcePolicyEdges` rather than from
    // `extractDependencies` -- so the `buildGraph` case above, which routes
    // through `TemplateParser`, does NOT exercise it. Measured: neutering the
    // dag-builder arm alone reddened nothing until this case existed.
    //
    // All three references below use the STRING spelling, which returned
    // `undefined` from that parser before this PR: the role map came out empty,
    // so the implicit `policy -> custom resource` ordering edge was never
    // added and the custom resource could run before its role's policy existed.
    const template = {
      Resources: {
        MyRole: { Type: 'AWS::IAM::Role', Properties: {} },
        MyPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: { Roles: [{ 'Fn::GetAtt': 'MyRole.Arn' }] },
        },
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Role: { 'Fn::GetAtt': 'MyRole.Arn' } },
        },
        CR: {
          Type: 'Custom::Thing',
          Properties: { ServiceToken: { 'Fn::GetAtt': 'Fn.Arn' } },
        },
      },
    } as unknown as CloudFormationTemplate;
    const graph = new DagBuilder().buildGraph(template);
    expect(graph.hasEdge('MyPolicy', 'CR')).toBe(true);
  });

  it('draws NO edge for a string spelling the resolver would refuse', () => {
    // The graph must accept exactly the set `resolveGetAtt` resolves -- an edge
    // to a reference that will throw anyway is a phantom dependency.
    expect([
      ...new TemplateParser().extractDependencies({
        Type: 'AWS::SSM::Parameter',
        Properties: { Value: { 'Fn::GetAtt': 'JustAName' } },
      }),
    ]).toEqual([]);
  });

  it('a BEST-EFFORT caller (diff / scrub) still keeps the placeholder', async () => {
    // `bestEffort` marks the callers whose documented EXPECTED case is a
    // reference to a resource this same deploy will create (issue #1017).
    // Refusing there would change `cdkd diff` output for no gain.
    const context = declaredButNotDeployed();
    context.bestEffort = true;
    const result = await resolver.resolve({ 'Fn::Sub': 'v=${Child.Outputs.Foo}' }, context);
    expect(result).toBe('v=${Child.Outputs.Foo}');
  });
});
