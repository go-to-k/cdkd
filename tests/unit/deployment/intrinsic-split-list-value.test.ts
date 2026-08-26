import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import {
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

// Mock logger (this resolver logs on every resolution path).
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

/**
 * Issue [#1874](https://github.com/go-to-k/cdkd/issues/1874): `Fn::Split` over
 * a list-valued `Fn::GetAtt`.
 *
 * The BEHAVIOR is unchanged — a non-string value is still refused, because
 * real CloudFormation rejects `Fn::Split` over a list too and accepting it
 * would let cdkd deploy templates `cdkd export` cannot hand back to CFn. What
 * changed is the MESSAGE, so these tests are message tests by design: the
 * pre-fix `value must be a string, got object` named neither the situation nor
 * the remedy.
 */
const mkResource = (attributes: Record<string, unknown>): ResourceState => ({
  physicalId: 'Z123456789',
  resourceType: 'AWS::Route53::HostedZone',
  properties: {},
  attributes,
  dependencies: [],
});

const mkContext = (resources: Record<string, ResourceState> = {}): ResolverContext => ({
  resources,
  template: {} as CloudFormationTemplate,
});

const splitError = async (
  resolver: IntrinsicFunctionResolver,
  args: unknown,
  context: ResolverContext
): Promise<Error> => {
  try {
    await resolver.resolve({ 'Fn::Split': args }, context);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected Fn::Split to throw, but it resolved');
};

describe('Fn::Split over an already-list value (issue #1874)', () => {
  it('refuses a resolved ARRAY with a message naming the situation and the remedy', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const arrayError = await splitError(resolver, [',', ['a', 'b', 'c']], mkContext());
    expect(arrayError.message).toContain('is ALREADY a list');
    expect(arrayError.message).toContain('an array of 3 items');
    expect(arrayError.message).toContain('Remove the Fn::Split');
    // The refusal must state WHY it is not a cdkd divergence, so a reader does
    // not re-open the accept-the-array option the maintainer decided against.
    // Asserted as a two-token kernel, not the whole sentence: a
    // meaning-preserving copy-edit must not red this. The machine-shaped
    // renderings (item count, source clause, `got <type>`, the #1868 token)
    // stay exact — those ARE the contract.
    expect(arrayError.message).toContain('CloudFormation rejects');
  });

  it('singularizes the item count for a one-element array', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const error = await splitError(resolver, [',', ['only']], mkContext());
    expect(error.message).toContain('an array of 1 item)');
    expect(error.message).not.toContain('1 items');
  });

  it('refuses the real-world shape from the issue, naming the source Fn::GetAtt', async () => {
    // {"Fn::Split": [",", {"Fn::GetAtt": ["Zone", "NameServers"]}]} against a
    // state record whose NameServers attribute is a LIST — exactly what
    // PR #1868 made `AWS::Route53::HostedZone.NameServers` resolve to.
    const resolver = new IntrinsicFunctionResolver();
    const context = mkContext({
      Zone: mkResource({
        NameServers: [
          'ns-1.awsdns-00.com',
          'ns-2.awsdns-01.net',
          'ns-3.awsdns-02.org',
          'ns-4.awsdns-03.co.uk',
        ],
      }),
    });

    const error = await splitError(
      resolver,
      [',', { 'Fn::GetAtt': ['Zone', 'NameServers'] }],
      context
    );

    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(error.message).toContain('is ALREADY a list');
    expect(error.message).toContain('an array of 4 items');
    // ResolverContext carries no referencing logical id, but the UNRESOLVED
    // value expression does — so the message can still name the exact site.
    expect(error.message).toContain('(from Fn::GetAtt [Zone, NameServers])');
    // The workaround pointer: this template shape only ever worked because of
    // the pre-#1868 comma-delimited-string bug.
    expect(error.message).toContain('#1868');
  });

  it('names the source for the dotted `Fn::GetAtt` string spelling too', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const context = mkContext({ Zone: mkResource({ NameServers: ['ns-1', 'ns-2'] }) });

    const error = await splitError(resolver, [',', { 'Fn::GetAtt': 'Zone.NameServers' }], context);
    expect(error.message).toContain('(from Fn::GetAtt [Zone, NameServers])');
  });

  it('renders a dotted ATTRIBUTE whole (splits on the FIRST dot only)', async () => {
    // CloudFormation parses `Child.Outputs.Key` as [Child, Outputs.Key] — a
    // nested stack's output. Splitting on every dot would render a
    // three-element Fn::GetAtt that does not exist, which is worse than
    // useless in a message whose only job is to name the site.
    //
    // The three-segment STRING spelling USED to be unable to reach the
    // refusal: `resolveGetAtt` rejected `parts.length !== 2` first, so
    // `resolveValue` threw before `resolveSplit` classified anything, and this
    // test pinned that throw on the note that it would red the day nested-path
    // GetAtt landed. It landed — issue #2270 made the string spelling split on
    // the FIRST dot — so the rendering is now driven through the LIVE path,
    // where it is found already correct.
    const resolver = new IntrinsicFunctionResolver();
    const dotted = mkContext({ Child: mkResource({ 'Outputs.Key': ['a', 'b'] }) });

    const viaString = await splitError(
      resolver,
      [',', { 'Fn::GetAtt': 'Child.Outputs.Key' }],
      dotted
    );
    expect(viaString).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(viaString.message).toContain('(from Fn::GetAtt [Child, Outputs.Key])');
    expect(viaString.message).not.toContain('[Child, Outputs, Key]');

    const rendered = await splitError(
      resolver,
      [',', { 'Fn::GetAtt': ['Child', 'Outputs.Key'] }],
      dotted
    );
    expect(rendered.message).toContain('(from Fn::GetAtt [Child, Outputs.Key])');
    expect(rendered.message).not.toContain('[Child, Outputs, Key]');
  });

  it('refuses a `Ref` to a CommaDelimitedList parameter, naming the PARAMETER', async () => {
    // The second genuinely reachable array source: `coerceParameterValue`
    // returns an array for CommaDelimitedList / List<Number>, so this shape
    // reaches the same refusal as a list-valued Fn::GetAtt.
    const resolver = new IntrinsicFunctionResolver();
    const template = {
      Parameters: { MyListParam: { Type: 'CommaDelimitedList' } },
    } as unknown as CloudFormationTemplate;
    const context: ResolverContext = {
      resources: {},
      template,
      parameters: await resolver.resolveParameters(template, { MyListParam: 'a,b,c' }),
    };
    // The parameter really was coerced to a list by the resolver itself, not
    // hand-shaped by the test.
    expect(context.parameters?.['MyListParam']).toEqual(['a', 'b', 'c']);

    const error = await splitError(resolver, [',', { Ref: 'MyListParam' }], context);

    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(error.message).toContain('(from Ref MyListParam)');
    expect(error.message).toContain('an array of 3 items');
    // The remedy must be the PARAMETER one — asserted precisely enough to
    // distinguish it from the NEUTRAL remedy, which also names
    // CommaDelimitedList but drags Fn::GetAtt in beside it.
    expect(error.message).toContain('A CommaDelimitedList / List<Number> parameter');
    expect(error.message).not.toContain('Fn::GetAtt');
    // ...and it must NOT drag in the Route 53 / #1868 story, which is about a
    // different source entirely and only confuses this reader.
    expect(error.message).not.toContain('#1868');
    expect(error.message).not.toContain('NameServers');
  });

  it('renders a non-string `Fn::GetAtt` argument by NAME, never as [object Object]', async () => {
    // CloudFormation allows the attribute name to be any string-valued
    // expression and `resolveGetAtt` resolves it, so this shape reaches the
    // refusal. An all-strings guard used to drop the whole label back to a
    // bare `Fn::GetAtt`, losing the logical id — the one piece of site
    // information the message carries — and any direct interpolation of the
    // object would render `[object Object]`, which names nothing.
    const resolver = new IntrinsicFunctionResolver();
    const context = mkContext({ Zone: mkResource({ NameServers: ['ns-1', 'ns-2'] }) });

    const error = await splitError(
      resolver,
      [',', { 'Fn::GetAtt': ['Zone', { 'Fn::Sub': 'NameServers' }] }],
      context
    );

    expect(error.message).not.toContain('[object Object]');
    expect(error.message).toContain('(from Fn::GetAtt [Zone, <Fn::Sub>])');
    // The logical id survives, which is the whole point of the label.
    expect(error.message).toContain('Zone');
  });

  it('names no source for shapes that are not a single intrinsic key', async () => {
    // The describer's `undefined` arms, all message-only and all reachable via
    // the non-array refusal: a single-key object whose key is not an
    // intrinsic, and a multi-key object.
    const resolver = new IntrinsicFunctionResolver();

    const plainKey = await splitError(resolver, [',', { NotAnIntrinsic: 'x' }], mkContext());
    expect(plainKey.message).toContain('must be a string, got object');
    expect(plainKey.message).not.toContain('(from ');

    // The multi-key arm needs an input that (a) still REACHES the refusal and
    // (b) is not ALSO caught by the non-intrinsic-key arm above — otherwise
    // mutating `keys.length !== 1` to `< 1` stays green because the probe is
    // inert for that input rather than the guard being covered. `{A: 1, B: 2}`
    // was exactly that. A CFn intrinsic is always a SINGLE-key object, so a
    // second key means this is a plain record that merely looks like one; the
    // dispatcher nonetheless resolves it by its intrinsic key, and a nested
    // Fn::Split yields an array, which lands on the already-a-list refusal.
    const twoKeys = await splitError(
      resolver,
      [',', { 'Fn::Split': [',', 'a,b'], Extra: 'y' }],
      mkContext()
    );
    expect(twoKeys.message).toContain('is ALREADY a list');
    expect(twoKeys.message).not.toContain('(from ');
  });

  it('renders a bare intrinsic key for a source it has no specific shape for', async () => {
    // The describer's non-Fn::GetAtt branch: name the intrinsic, and use the
    // neutral remedy (neither the GetAtt nor the parameter story applies).
    const resolver = new IntrinsicFunctionResolver();
    const context: ResolverContext = {
      resources: {},
      template: {} as CloudFormationTemplate,
      conditions: { UseList: true },
    };

    const error = await splitError(
      resolver,
      [',', { 'Fn::If': ['UseList', ['a', 'b'], 'x'] }],
      context
    );
    expect(error.message).toContain('(from Fn::If)');
    // The NEUTRAL remedy: neither source-specific story applies, so neither
    // the #1868 note nor the Route 53 example may appear.
    expect(error.message).toContain('Several intrinsics already return a list');
    expect(error.message).not.toContain('#1868');
    expect(error.message).not.toContain('NameServers');
  });

  it('gives a literal value the NEUTRAL remedy, with no source clause', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const error = await splitError(resolver, [',', ['a', 'b']], mkContext());
    expect(error.message).toContain('Fn::Split: the value to split is ALREADY a list');
    expect(error.message).not.toContain('(from ');
    // POSITIVE assertion, not only negatives: a literal names nothing about
    // itself, so it takes the neutral remedy. Asserting only the absence of
    // the #1868 note let the remedy silently flip to the Fn::GetAtt text
    // (which is what shipped, and what two reviewers caught).
    expect(error.message).toContain('Several intrinsics already return a list');
    // ...so the Route 53 example and the workaround note must NOT appear.
    expect(error.message).not.toContain('#1868');
    expect(error.message).not.toContain('NameServers');
  });

  it('keeps a distinct refusal for a non-array non-string, never claiming "already a list"', async () => {
    const resolver = new IntrinsicFunctionResolver();

    const numberError = await splitError(resolver, [',', 42], mkContext());
    expect(numberError).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(numberError.message).toContain('must be a string, got number');
    expect(numberError.message).not.toContain('ALREADY a list');

    const objectError = await splitError(resolver, [',', { Some: 'record' }], mkContext());
    expect(objectError.message).toContain('must be a string, got object');
    expect(objectError.message).not.toContain('ALREADY a list');

    // `typeof null === 'object'` would have read as a record; say `null`.
    const nullError = await splitError(resolver, [',', null], mkContext());
    expect(nullError.message).toContain('must be a string, got null');
    expect(nullError.message).not.toContain('ALREADY a list');
  });

  it('still splits an ordinary string, including a list-valued attribute joined first', async () => {
    const resolver = new IntrinsicFunctionResolver();
    expect(await resolver.resolve({ 'Fn::Split': [',', 'a,b,c'] }, mkContext())).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(await resolver.resolve({ 'Fn::Split': ['|', 'single'] }, mkContext())).toEqual([
      'single',
    ]);

    // The supported way to split a list-valued attribute: join it first.
    const context = mkContext({ Zone: mkResource({ NameServers: ['ns-1', 'ns-2'] }) });
    expect(
      await resolver.resolve(
        { 'Fn::Split': [',', { 'Fn::Join': [',', { 'Fn::GetAtt': ['Zone', 'NameServers'] }] }] },
        context
      )
    ).toEqual(['ns-1', 'ns-2']);
  });

  it('throws IntrinsicResolutionRefusalError (a deliberate refusal), not a bare Error', async () => {
    const resolver = new IntrinsicFunctionResolver();
    for (const value of [['a'], 42, null, { Some: 'record' }]) {
      const error = await splitError(resolver, [',', value], mkContext());
      expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect((error as IntrinsicResolutionRefusalError).code).toBe('INTRINSIC_RESOLUTION_REFUSAL');
    }
  });

  it('is marked non-retryable, so the refusal cannot burn the retry schedule', async () => {
    // Issue #1838. The criterion is "can this ever succeed on a retry" — an
    // Fn::Split over an array never can — NOT "does today's wording collide
    // with a pattern", which `retryable-errors.ts` documents as insufficient.
    // Reachability is real: resolution runs outside `withRetry` on the flat
    // path, but `NestedStackProvider.create` runs a child `DeployEngine.deploy()`
    // and re-throws, and the parent wraps `create()` in `withRetry` — so inside
    // a nested stack each retry re-runs a whole child deploy plus rollback.
    const resolver = new IntrinsicFunctionResolver();
    for (const value of [['a', 'b'], 42, null, { Some: 'record' }]) {
      const error = await splitError(resolver, [',', value], mkContext());
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(isRetryableTransientError(error, error.message)).toBe(false);
    }
  });

  it('stays non-retryable when the logical id itself contains a retryable pattern', async () => {
    // The regression the marker exists for: `sourceClause` interpolates
    // template-controlled text, so an ordinary composite CDK logical id can put
    // a retryable pattern INTO the message. `DependencyViolation` is a
    // whitespace-free entry in the table, which is what makes it reachable
    // from an identifier (the only one until issue #2116 added the
    // name-cooldown error codes). Asserted through the classifier (the OUTCOME), not by
    // re-checking the message against the table — the wording is expected to
    // collide here, and the marker is what has to win.
    const resolver = new IntrinsicFunctionResolver();
    const logicalId = 'MyDependencyViolationHandler';
    const context = mkContext({ [logicalId]: mkResource({ NameServers: ['ns-1', 'ns-2'] }) });

    const error = await splitError(
      resolver,
      [',', { 'Fn::GetAtt': [logicalId, 'NameServers'] }],
      context
    );

    // The message really does contain a retryable pattern...
    expect(error.message).toContain('DependencyViolation');
    expect(RETRYABLE_ERROR_MESSAGE_PATTERNS).toContain('DependencyViolation');
    // ...and the classifier must still refuse to retry it.
    expect(isRetryableTransientError(error, error.message)).toBe(false);
  });

  it('PROPAGATES out of an `Fn::Sub` 2-arg variable map (not laundered)', async () => {
    // The JSDoc's error-class reasoning rests on this: `Fn::Sub`'s `${...}`
    // form cannot syntactically contain an Fn::Split, and its 2-arg
    // variable-map form resolves each value through `resolveValue` OUTSIDE any
    // catch — so the #1740 laundering path is unreachable from here and the
    // class choice changes no behavior. Nothing tested that, so a future catch
    // added around the variable-map loop would rot the rationale silently.
    const resolver = new IntrinsicFunctionResolver();
    let thrown: Error | undefined;
    try {
      await resolver.resolve(
        { 'Fn::Sub': ['x-${v}', { v: { 'Fn::Split': [',', ['a', 'b']] } }] },
        mkContext()
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(thrown?.message).toContain('is ALREADY a list');
    expect(isMarkedNonRetryable(thrown)).toBe(true);
  });

  it('IS laundered inside a `Conditions` entry (the corrected comment, pinned)', async () => {
    // `evaluateConditions` catches everything per condition, warns, and
    // downgrades that condition to `false`. Both the in-code comment and the
    // PR body assert this happens TODAY — as the reason the error class is not
    // a guarantee against a class-agnostic catch — so it needs a test of its
    // own. Both classes behave identically here, so this is a documented
    // limitation rather than a regression.
    const resolver = new IntrinsicFunctionResolver();
    const template = {
      Conditions: {
        Refuses: { 'Fn::Equals': [{ 'Fn::Split': [',', ['a', 'b']] }, 'x'] },
        Plain: { 'Fn::Equals': ['x', 'x'] },
      },
    } as unknown as CloudFormationTemplate;

    const conditions = await resolver.evaluateConditions({ resources: {}, template });

    expect(conditions['Refuses']).toBe(false);
    expect(conditions['Plain']).toBe(true);
  });

  it('carries no retryable message pattern on its own, either', async () => {
    // Belt-and-braces beside the marker: with no user text interpolated the
    // static wording must not collide, so a future reword cannot quietly rely
    // on the marker alone (and a `--dry-run`-style consumer that only ever sees
    // the message keeps a clean read).
    const resolver = new IntrinsicFunctionResolver();
    const messages = [
      (await splitError(resolver, [',', ['a', 'b']], mkContext())).message,
      (await splitError(resolver, [',', 42], mkContext())).message,
    ];
    for (const message of messages) {
      const matched = RETRYABLE_ERROR_MESSAGE_PATTERNS.filter((p) => message.includes(p));
      expect(matched).toEqual([]);
    }
  });
});
