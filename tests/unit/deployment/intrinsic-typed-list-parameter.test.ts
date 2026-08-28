import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

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

  it('Fn::Sub over a list-typed parameter loses the padding whitespace the raw string kept', async () => {
    // The FIFTH reader, and the only one whose change is neither a hard failure
    // nor a silent wrong shape -- it is a silently DIFFERENT string.
    //
    // `resolveSub` substitutes `String(await this.resolveRef(name))`. Pre-#2347
    // a `List<AWS::EC2::Subnet::Id>` parameter resolved to the user's raw text,
    // so `'subnet-a, subnet-b'` was substituted verbatim, padding and all. It
    // now resolves to an ARRAY, and `String(['subnet-a','subnet-b'])` joins on
    // a bare comma -- so the same template renders `subnet-a,subnet-b`.
    //
    // Pinned rather than "fixed": the array IS the value the parameter's
    // declared type says it has, and CloudFormation's own comma-delimited
    // parameter semantics space-trim each member, so the padded spelling was
    // never meaningful data. What matters is that the difference is RECORDED,
    // because a template embedding this substitution in a user-visible string
    // (a tag value, a description, a UserData line) renders differently after
    // upgrading, with nothing failing to announce it.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = {
      Parameters: {
        SubnetIds: { Type: 'List<AWS::EC2::Subnet::Id>' },
        Raw: { Type: 'String' },
      },
      Resources: {},
    } as unknown as CloudFormationTemplate;
    const parameters = await resolver.resolveParameters(template, {
      SubnetIds: 'subnet-a, subnet-b',
      Raw: 'subnet-a, subnet-b',
    });

    // The discriminator: the two parameters carry the SAME user input and
    // differ only in declared type, so anything that renders them identically
    // has not read the coercion at all.
    expect(parameters).toEqual({
      SubnetIds: ['subnet-a', 'subnet-b'],
      Raw: 'subnet-a, subnet-b',
    });

    const context = { resources: {}, template, parameters };
    const listSub = await resolver.resolve({ 'Fn::Sub': 'subnets=${SubnetIds}' }, context);
    const stringSub = await resolver.resolve({ 'Fn::Sub': 'subnets=${Raw}' }, context);

    expect(listSub).toBe('subnets=subnet-a,subnet-b');
    expect(stringSub).toBe('subnets=subnet-a, subnet-b');
    expect(listSub).not.toBe(stringSub);
  });
});
