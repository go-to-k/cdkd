import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/**
 * Issue #2347, the CONSUMER side: what a string-where-a-list-was-expected
 * actually produced.
 *
 * `coerceParameterTypedValue` fed `context.parameters`, which `resolveRef`
 * returns verbatim, so a `List<AWS::EC2::Subnet::Id>` parameter reached every
 * downstream reader as the raw comma-joined STRING. Two of the three readers
 * HARD-FAIL on that (`Fn::Select` and `Fn::Join` both demand an array), and the
 * third -- a `Ref` used directly as a property value -- silently handed a
 * provider a scalar where the resource schema declares a list. These tests pin
 * all three against the fixed behaviour.
 */
const TEMPLATE = {
  Parameters: {
    SubnetIds: { Type: 'List<AWS::EC2::Subnet::Id>' },
    SecurityGroupIds: { Type: 'List<AWS::EC2::SecurityGroup::Id>' },
    Azs: { Type: 'CommaDelimitedList' },
    Ports: { Type: 'List<Number>' },
    Name: { Type: 'String' },
  },
  Resources: {},
} as unknown as CloudFormationTemplate;

const USER_PARAMETERS = {
  SubnetIds: 'subnet-a, subnet-b, subnet-c',
  SecurityGroupIds: 'sg-a,sg-b',
  Azs: 'us-east-1a, us-east-1b',
  Ports: '80, 443',
  Name: 'my-app',
};

const refusalOf = (
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): Promise<unknown> =>
  resolver.resolve(value, context).then(
    () => undefined,
    (e: unknown) => e
  );

const buildContext = async (): Promise<ResolverContext> => {
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const parameters = await resolver.resolveParameters(TEMPLATE, USER_PARAMETERS);
  return { resources: {}, template: TEMPLATE, parameters };
};

describe('a List<AWS::...> parameter resolves to a LIST end to end', () => {
  it('resolveParameters coerces every list-typed parameter and leaves the scalars alone', async () => {
    const context = await buildContext();
    expect(context.parameters).toEqual({
      SubnetIds: ['subnet-a', 'subnet-b', 'subnet-c'],
      SecurityGroupIds: ['sg-a', 'sg-b'],
      Azs: ['us-east-1a', 'us-east-1b'],
      Ports: [80, 443],
      Name: 'my-app',
    });
  });

  it('a bare Ref used as a property value hands the provider an ARRAY, not a comma-joined string', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = await buildContext();
    // The silent arm: before the fix this resolved to 'subnet-a, subnet-b,
    // subnet-c', so a provider whose schema declares SubnetIds a list received
    // one scalar string.
    expect(await resolver.resolve({ Ref: 'SubnetIds' }, context)).toEqual([
      'subnet-a',
      'subnet-b',
      'subnet-c',
    ]);
  });

  it('Fn::Select over the parameter picks an element instead of failing "list must be an array"', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = await buildContext();
    expect(await resolver.resolve({ 'Fn::Select': [1, { Ref: 'SubnetIds' }] }, context)).toBe(
      'subnet-b'
    );
    expect(
      await resolver.resolve({ 'Fn::Select': [0, { Ref: 'SecurityGroupIds' }] }, context)
    ).toBe('sg-a');
  });

  it('Fn::Join over the parameter joins the elements instead of refusing a non-list', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = await buildContext();
    expect(await resolver.resolve({ 'Fn::Join': ['|', { Ref: 'SubnetIds' }] }, context)).toBe(
      'subnet-a|subnet-b|subnet-c'
    );
  });

  it('Fn::Split over the parameter is now REFUSED, matching CloudFormation and the CommaDelimitedList arm', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = await buildContext();
    // A template that split the parameter was working AROUND this bug. CFn
    // rejects Fn::Split over a list, so cdkd refuses it too rather than
    // deploying a template `cdkd export` could not hand back.
    // Asserted against the CORRECTED remedy text, not just `/ALREADY a list/`:
    // the pre-#2347 message told the user "A CommaDelimitedList / List<Number>
    // parameter is already a list", which names neither type the user actually
    // has. A loose matcher passes over exactly that wrong wording.
    let message: string | undefined;
    try {
      await resolver.resolve({ 'Fn::Split': [',', { Ref: 'SubnetIds' }] }, context);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBeDefined();
    expect(message).toContain('ALREADY a list');
    expect(message).toContain('Ref SubnetIds');
    expect(message).toContain('A list-typed parameter');
    expect(message).toContain('List<AWS::EC2::Subnet::Id>');
    // The stale enumeration must be gone, not merely joined by better text.
    expect(message).not.toContain('A CommaDelimitedList / List<Number> parameter');
  });

  it('Fn::Equals over the parameter now compares a LIST, so a condition can change answer', async () => {
    // Issue #2347's sharpest downstream consequence, pinned deliberately rather
    // than suppressed. `resolveEquals`
    // (`src/deployment/intrinsic-function-resolver.ts:4798`) compares
    // `JSON.stringify` of both sides. With `Envs: List<String>` defaulting to `prod`, the pre-change
    // Ref resolved to the STRING 'prod' and `Fn::Equals: [{Ref: Envs}, 'prod']`
    // was TRUE; it now resolves to `['prod']`, whose JSON is `["prod"]` against
    // `"prod"`, so the condition is FALSE.
    //
    // FALSE is the CORRECT answer -- a list-typed Ref is not a string, and
    // CloudFormation would reject this template's `List<String>` Type outright
    // -- so it is asserted, not worked around. The cost is real and bounded:
    // `TemplateParser.filterResourcesByCondition` prunes a condition-gated resource that state
    // still holds, so the next deploy DELETES it. `cdkd diff` previews that
    // delete before any apply, which is what bounds it.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = {
      Parameters: { Envs: { Type: 'List<String>', Default: 'prod' } },
      Conditions: {
        IsProd: { 'Fn::Equals': [{ Ref: 'Envs' }, 'prod'] },
        IsProdList: { 'Fn::Equals': [{ Ref: 'Envs' }, ['prod']] },
      },
      Resources: {},
    } as unknown as CloudFormationTemplate;
    const parameters = await resolver.resolveParameters(template, { Envs: 'prod' });
    expect(parameters).toEqual({ Envs: ['prod'] });
    const conditions = await resolver.evaluateConditions({
      resources: {},
      template,
      parameters,
    });
    // The answer that CHANGED, and the one that is now reachable in its place.
    expect(conditions['IsProd']).toBe(false);
    expect(conditions['IsProdList']).toBe(true);
  });

  it('Fn::Sub over a list-typed parameter is REFUSED, as CloudFormation refuses it (issue #3809)', async () => {
    // The FIFTH reader. Pre-#2347 a `List<AWS::EC2::Subnet::Id>` parameter
    // was the user's raw string, so `${SubnetIds}` rendered it verbatim; after
    // #2347 it is an ARRAY, and `String()` rendered `subnet-a,subnet-b`.
    // Neither is CloudFormation's answer: CreateStack rejects the template
    // with "variable SubnetIds in Fn::Sub expression does not resolve to a
    // string" (measured by an A/B for a CommaDelimitedList and a List<Number>
    // parameter). A String parameter carrying the same text still renders.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = {
      Parameters: {
        SubnetIds: { Type: 'List<AWS::EC2::Subnet::Id>' },
        Azs: { Type: 'CommaDelimitedList' },
        Ports: { Type: 'List<Number>' },
        Raw: { Type: 'String' },
      },
      Resources: {},
    } as unknown as CloudFormationTemplate;
    const parameters = await resolver.resolveParameters(template, {
      SubnetIds: 'subnet-a, subnet-b',
      Azs: 'us-east-1a, us-east-1b',
      Ports: '80, 443',
      Raw: 'subnet-a, subnet-b',
    });
    const context = { resources: {}, template, parameters };

    for (const name of ['SubnetIds', 'Azs', 'Ports']) {
      const error = await refusalOf(resolver, { 'Fn::Sub': `v=\${${name}}` }, context);
      expect(error, name).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(isMarkedNonRetryable(error), name).toBe(true);
      expect((error as Error).message, name).toContain(
        `Fn::Sub: the variable \${${name}} resolves to a list (an array of 2 items), not a string.`
      );
      expect((error as Error).message, name).toContain('Fn::Join');
    }
    expect(await resolver.resolve({ 'Fn::Sub': 'v=${Raw}' }, context)).toBe(
      'v=subnet-a, subnet-b'
    );
  });

  it('a variable-map value that is a list is REFUSED even when unused, and the Fn::Join remedy renders', async () => {
    // CloudFormation validates EVERY value of the map ("every value of the
    // context object of every Fn::Sub object must be a string or a function
    // that returns a string"), including one the template never names.
    const context = await buildContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    for (const body of ['ids=${Ids}', 'region-only']) {
      const error = await refusalOf(
        resolver,
        { 'Fn::Sub': [body, { Ids: { Ref: 'SubnetIds' } }] },
        context
      );
      expect(error, body).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(isMarkedNonRetryable(error), body).toBe(true);
      expect((error as Error).message, body).toContain(
        'Fn::Sub: the variable-map value Ids resolves to a list (an array of 3 items)'
      );
    }
    // The remedy the message names.
    expect(
      await resolver.resolve(
        { 'Fn::Sub': ['ids=${Ids}', { Ids: { 'Fn::Join': [',', { Ref: 'SubnetIds' }] } }] },
        context
      )
    ).toBe('ids=subnet-a,subnet-b,subnet-c');
  });

  it('a list-valued Fn::GetAtt placeholder is REFUSED rather than comma-joined', async () => {
    // CloudFormation fails the resource with "variable
    // Vpc.CidrBlockAssociations in Fn::Sub expression does not resolve to a
    // string" (measured).
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context: ResolverContext = {
      template: {
        Resources: { Vpc: { Type: 'AWS::EC2::VPC', Properties: {} } },
      } as unknown as CloudFormationTemplate,
      resources: {
        Vpc: {
          physicalId: 'vpc-1',
          resourceType: 'AWS::EC2::VPC',
          properties: {},
          attributes: { CidrBlockAssociations: ['assoc-a', 'assoc-b'] },
        },
      } as unknown as ResolverContext['resources'],
    };
    const error = await refusalOf(
      resolver,
      { 'Fn::Sub': 'v=${Vpc.CidrBlockAssociations}' },
      context
    );
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).message).toContain(
      'Fn::Sub: the variable ${Vpc.CidrBlockAssociations} resolves to a list (an array of 2 items)'
    );
  });
});
