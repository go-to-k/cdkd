import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
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

const mockSecretsManagerSend = vi.fn();
const mockSSMSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: vi.fn().mockResolvedValue({ AvailabilityZones: [] }) },
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: mockSSMSend },
  }),
}));

/**
 * Issue [#2739](https://github.com/go-to-k/cdkd/issues/2739): the two-argument
 * `Fn::Sub` form resolved its variable map IN PLACE, so after one resolution
 * the caller's template object held the resolved value — a secret's plaintext
 * — where it had held the `{{resolve:...}}` reference. A template is a
 * description, not a cache: the object is what `DeployEngine.resolveOutputs`
 * retains as the positioning source, and a later resolution of it with a
 * fresh recording map would return the plaintext without recording it (no
 * token left for `resolveDynamicReferences` to see).
 *
 * The real resolver over a faked Secrets Manager client, so the cache-hit arm
 * that re-records into the map it is handed is the one exercised on the
 * second resolution — which is why the client answering ONCE is the expected
 * count.
 */
describe('IntrinsicFunctionResolver - resolveSub leaves the caller\'s variable map untouched (issue #2739)', () => {
  const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
  const PLAINTEXT = 's3cr3t-pw';
  const template: CloudFormationTemplate = { Resources: {} };

  function freshContext(): ResolverContext & { recordedSecretValues: Map<string, string> } {
    return { template, resources: {}, recordedSecretValues: new Map<string, string>() };
  }

  beforeEach(() => {
    // Also clears the process-global secret-expression store.
    resetAccountInfoCache();
    mockSecretsManagerSend.mockReset();
    mockSSMSend.mockReset();
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ username: 'admin', password: PLAINTEXT }),
    });
  });

  it('keeps the template object byte-identical across a resolution, and the second resolution with a fresh map still records the secret', async () => {
    const resolver = new IntrinsicFunctionResolver();
    // The shape `resolveOutputs` hands the resolver: the object INSIDE the
    // template, whose second element is the variable map.
    const subValue = { 'Fn::Sub': ['user=${User};pw=${Pw}', { User: 'admin', Pw: SECRET_EXPR }] };
    const before = JSON.stringify(subValue);

    const first = freshContext();
    const firstResult = await resolver.resolve(subValue, first);

    expect(firstResult).toBe(`user=admin;pw=${PLAINTEXT}`);
    expect(JSON.stringify(subValue)).toBe(before);
    expect(first.recordedSecretValues.get(PLAINTEXT)).toBe(SECRET_EXPR);
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);

    // A second pass over the SAME object, with the per-pass map a new
    // `buildResolverContext` would create. Before the fix the map held the
    // plaintext, the token was gone, and nothing was recorded here.
    const second = freshContext();
    const secondResult = await resolver.resolve(subValue, second);

    expect(secondResult).toBe(`user=admin;pw=${PLAINTEXT}`);
    expect(second.recordedSecretValues.get(PLAINTEXT)).toBe(SECRET_EXPR);
    // Served by the cache-hit arm, not by a second lookup.
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(subValue)).toBe(before);
  });

  it('does not write a resolved intrinsic back into the variable map either', async () => {
    // The non-secret twin of the case above: a variable that is itself an
    // intrinsic (a pseudo parameter) used to be overwritten with its resolved
    // string, so the template read `AccountId: '123456789012'` afterwards.
    const resolver = new IntrinsicFunctionResolver();
    const variables: Record<string, unknown> = { Acct: { Ref: 'AWS::AccountId' }, Lit: 'x' };
    const subValue = { 'Fn::Sub': ['${Acct}-${Lit}', variables] };

    const result = await resolver.resolve(subValue, freshContext());

    expect(result).toBe('123456789012-x');
    expect(variables).toEqual({ Acct: { Ref: 'AWS::AccountId' }, Lit: 'x' });
  });

  it('still substitutes a variable named __proto__, which JSON.parse makes an OWN key of the map', async () => {
    // The fresh object is created with a null prototype: copying into `{}`
    // would route this one assignment through the inherited setter and
    // render the placeholder as `[object Object]`, where the in-place code
    // (and CloudFormation) substitute the value.
    const resolver = new IntrinsicFunctionResolver();
    const subValue = JSON.parse('{"Fn::Sub":["value=${__proto__}",{"__proto__":"expected"}]}') as {
      'Fn::Sub': [string, Record<string, unknown>];
    };

    const result = await resolver.resolve(subValue, freshContext());

    expect(result).toBe('value=expected');
  });

  it('no longer substitutes an Object.prototype member for a placeholder the map does not carry', async () => {
    // The consequence of the null prototype, stated as behaviour: with a
    // plain-object map `'constructor' in variables` was true, so
    // `${constructor}` rendered the Object constructor's source text
    // (`function Object() { [native code] }`). It now falls through to the
    // pseudo-parameter / `Ref` arms like any unknown name. What THOSE answer
    // for a prototype-member name is not this file's subject (`resolveRef`
    // reads `context.resources[name]`, and an empty resources bag answers
    // `undefined` for `constructor` through its own prototype), so the pin is
    // the negative: no function source reaches the rendered string.
    const resolver = new IntrinsicFunctionResolver();
    for (const subValue of [
      { 'Fn::Sub': ['x-${constructor}', { Lit: 'y' }] },
      // The plain-string form tested against a plain `{}` too.
      { 'Fn::Sub': 'x-${constructor}' },
    ]) {
      const result = await resolver.resolve(subValue, freshContext());

      expect(result).not.toContain('native code');
      expect(result).not.toContain('function');
    }
  });

  it('resolves a prototype-member name through the Ref arm when a resource carries it, on both forms', async () => {
    // The positive twin of the case above, which pins that the fall-through
    // RUNS: a resource named `constructor` in state gives the `Ref` arm a
    // known answer, and a mutant that treats every name as bound (rendering
    // `undefined` from the null-prototype lookup) cannot produce it.
    const resolver = new IntrinsicFunctionResolver();
    const context: ResolverContext = {
      template: { Resources: { constructor: { Type: 'AWS::S3::Bucket' } } },
      resources: {
        constructor: { physicalId: 'phys-ctor', resourceType: 'AWS::S3::Bucket', properties: {} },
      },
    };
    for (const subValue of [
      { 'Fn::Sub': ['x-${constructor}', { Lit: 'y' }] },
      { 'Fn::Sub': 'x-${constructor}' },
    ]) {
      expect(await resolver.resolve(subValue, context)).toBe('x-phys-ctor');
    }
  });

  it('substitutes OWN keys of the variable map only: an inherited binding is not a variable, and the Ref arm answers instead', async () => {
    // The writer-side half of the reader's inherited-binding refusal in
    // `secret-redaction.ts`: `Object.entries` copies own enumerable keys, so a
    // binding the map merely inherits is not substituted locally — the
    // placeholder falls through to `Ref`, which a resource of that name
    // answers. A `for...in` copy (which walks the prototype chain) would
    // render the inherited value instead.
    const resolver = new IntrinsicFunctionResolver();
    const inherited = Object.create({ Bound: 'from-the-prototype' }) as Record<string, unknown>;
    const context: ResolverContext = {
      template: { Resources: { Bound: { Type: 'AWS::S3::Bucket' } } },
      resources: {
        Bound: { physicalId: 'phys-bound', resourceType: 'AWS::S3::Bucket', properties: {} },
      },
    };

    expect(await resolver.resolve({ 'Fn::Sub': ['x-${Bound}', inherited] }, context)).toBe(
      'x-phys-bound'
    );
  });

  it('refuses a null or primitive second element unconditionally, non-retryably, and keeps resolving an array one by index', async () => {
    // Newly enforced validation. Before the change `null` and a non-empty
    // string always threw, but a number, a boolean or an empty string failed
    // only once a placeholder reached the `in` test (a placeholder-free
    // template beside one resolved); copying into a fresh object would have
    // made those three resolve silently, and the cross-stack reader in
    // `secret-redaction.ts` relies on the shape never being recorded. Hence
    // the placeholder-FREE template is in the set (a guard applied only when
    // the template carries `${` would pass it), and so are the FALSY
    // primitives (a truthiness-shaped guard would accept them).
    const resolver = new IntrinsicFunctionResolver();
    // The diagnostic names the TYPE and never the value: a rejected string
    // could be anything a template author put there.
    const REJECTED_STRING = 'not-an-object-s3cr3t';
    for (const [templateString, second, kind] of [
      ['x-${A}', REJECTED_STRING, 'string'],
      ['x-${A}', 5, 'number'],
      ['x-${A}', null, 'null'],
      ['literal', 5, 'number'],
      ['x-${A}', 0, 'number'],
      ['x-${A}', false, 'boolean'],
      ['x-${A}', '', 'string'],
      // The one-element form and an explicit `undefined`: the guard is not
      // keyed on presence either (an unguarded `Object.entries(undefined)`
      // would throw an incidental, unmarked error instead).
      ['x-${A}', undefined, 'undefined'],
    ] as const) {
      const attempt = resolver.resolve({ 'Fn::Sub': [templateString, second] } as never, freshContext());
      await expect(attempt).rejects.toThrow(
        `Fn::Sub: the second element must be a variable map, got ${kind}`
      );
      await attempt.catch((err: unknown) => {
        // A template shape a retry cannot change.
        expect(isMarkedNonRetryable(err)).toBe(true);
        // The WHOLE message, beside `toThrow`'s substring test above: a
        // diagnostic that appended the rejected value would still contain
        // the expected sentence, and the `REJECTED_STRING` negative below
        // covers one value, not the shape.
        expect((err as Error).message).toBe(
          `Fn::Sub: the second element must be a variable map, got ${kind}`
        );
        expect((err as Error).message).not.toContain(REJECTED_STRING);
      });
    }
    const oneElement = resolver.resolve({ 'Fn::Sub': ['x-${A}'] } as never, freshContext());
    await expect(oneElement).rejects.toThrow(
      'Fn::Sub: the second element must be a variable map, got undefined'
    );
    await oneElement.catch((err: unknown) => {
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect((err as Error).message).toBe(
        'Fn::Sub: the second element must be a variable map, got undefined'
      );
    });
    // The array shape resolved by index before and still does...
    expect(await resolver.resolve({ 'Fn::Sub': ['x-${0}', ['first']] } as never, freshContext())).toBe(
      'x-first'
    );
    // ...while its non-enumerable `length` is no longer a variable: it falls
    // through to `Ref` resolution, which for an undeclared name warns and
    // keeps the placeholder (it rendered `x-1` through `in` before).
    expect(
      await resolver.resolve({ 'Fn::Sub': ['x-${length}', ['first']] } as never, freshContext())
    ).toBe('x-${length}');
  });
});
