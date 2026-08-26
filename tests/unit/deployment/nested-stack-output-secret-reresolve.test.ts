/**
 * Re-resolution of a nested-stack child's REDACTED output (issue
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055)).
 *
 * `NestedStackProvider` reads the CHILD stack's PERSISTED outputs and surfaces
 * each as the parent's `Outputs.<Name>` attribute. Since PR #1899 a
 * secret-bearing output is persisted as its `{{resolve:secretsmanager:...}}`
 * EXPRESSION, so a parent property spelled
 * `{"Fn::GetAtt": ["Child", "Outputs.DbPassword"]}` reached AWS as that literal
 * token — the third reader of a redacted bag in the #1934 class, one indirection
 * further out than the two `Fn::ImportValue` arms.
 *
 * WHY THIS FILE MOCKS THE SDK RATHER THAN `getAwsClients()`, same reasoning as
 * its sibling `cross-stack-secret-reresolve.test.ts`: half of what this change
 * decides is WHICH REGION resolves the child's expression, and a plain-object
 * `getAwsClients()` fake has no region, so that is not a question it can be
 * asked. The real `AwsClients` is used and only the leaf SDK client class is
 * faked, with the constructor config as the assertion target.
 *
 * Responses are primed per (REGION, COMMAND) rather than with
 * `mockResolvedValueOnce`, so there is no `*Once` queue a test could leave
 * undrained.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

interface FakeClientConfig {
  region?: string;
  profile?: string;
}

interface FakeSend {
  /** The region the sending client was CONSTRUCTED with — the discriminator. */
  ctorRegion: string | undefined;
  region: string | undefined;
  command: string;
}

const { responses, secretsInstances, secretSends, makeFakeClientClass } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();

  const makeFakeClientClass = (
    instances: { ctorConfig: FakeClientConfig }[],
    sends: FakeSend[],
    serviceLabel: string
  ): unknown =>
    class {
      readonly ctorConfig: FakeClientConfig;
      readonly config: { region: () => Promise<string> };
      private resolved?: Promise<string>;

      constructor(ctorConfig: FakeClientConfig = {}) {
        this.ctorConfig = ctorConfig;
        this.config = { region: () => this.resolveRegion() };
        instances.push(this);
      }

      private resolveRegion(): Promise<string> {
        if (!this.resolved) {
          const region = this.ctorConfig.region || process.env['AWS_REGION'];
          this.resolved = region
            ? Promise.resolve(region)
            : Promise.reject(new Error('Region is missing'));
        }
        return this.resolved;
      }

      async send(command: { constructor: { name: string } }): Promise<unknown> {
        let region: string | undefined;
        try {
          region = await this.resolveRegion();
        } catch {
          region = undefined;
        }
        const name = command.constructor.name;
        sends.push({ ctorRegion: this.ctorConfig.region, region, command: name });
        const response = responses.get(`${String(region)}|${name}`);
        if (response === undefined) {
          throw new Error(`no ${serviceLabel} response primed for ${String(region)}|${name}`);
        }
        return response;
      }
      destroy(): void {}
    };

  return {
    responses,
    secretsInstances: [] as { ctorConfig: FakeClientConfig }[],
    secretSends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretsInstances, secretSends, 'secretsmanager'),
  };
});
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass([], [], 'ssm') };
});
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], [], 'sts') };
});

/** Captures what the resolver LOGS — the debug line must never carry the value. */
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logLines.push(`${level} ${args.map(String).join(' ')}`);
    };
  const child = {
    setLevel: record('setLevel'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (): unknown => child,
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResourceState } from '../../../src/types/state.js';

const PARENT_REGION = 'ap-northeast-1';
const CHILD_REGION = 'eu-west-1';
const ACCOUNT = '111111111111';
const PROFILE = 'cdkd-lane-2055';

/** Exactly what PR #1899 persists into a child stack's `state.outputs`. */
const SECRET_EXPRESSION = '{{resolve:secretsmanager:prod/db/cred:SecretString:password}}';
const CHILD_REGION_PASSWORD = 'ireland-password-2055';
const PARENT_REGION_PASSWORD = 'tokyo-password-2055';

const NESTED = 'AWS::CloudFormation::Stack';

function prime(region: string, command: string, response: unknown): void {
  responses.set(`${region}|${command}`, response);
}

/**
 * The parent's `AWS::CloudFormation::Stack` row exactly as
 * `NestedStackProvider.create` records it: a synthesized `cdkd-local` ARN whose
 * region segment is the CHILD's, plus the child's PERSISTED (redacted) outputs
 * projected under `Outputs.<Name>`.
 */
function nestedRow(
  childRegion: string | undefined,
  outputs: Record<string, unknown>
): ResourceState {
  const physicalId =
    childRegion === undefined
      ? 'hand-edited-not-an-arn'
      : `arn:cdkd-local:${childRegion}:${ACCOUNT}:nested-stack/Parent/Child`;
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(outputs)) attributes[`Outputs.${k}`] = v;
  return { physicalId, resourceType: NESTED, properties: {}, attributes };
}

function buildContext(resources: Record<string, ResourceState>): ResolverContext {
  return { template: { Resources: {} }, resources, stackName: 'Parent' };
}

describe('Fn::GetAtt Outputs.<Name> re-resolves a REDACTED child output (issue #2055)', () => {
  let savedRegion: string | undefined;

  beforeEach(() => {
    savedRegion = process.env['AWS_REGION'];
    delete process.env['AWS_REGION'];
    responses.clear();
    secretsInstances.length = 0;
    secretSends.length = 0;
    logLines.length = 0;
    resetAccountInfoCache();
    setAwsClients(new AwsClients({ region: PARENT_REGION, profile: PROFILE }));
    // Two regions holding DIFFERENT values behind the SAME reference — the
    // ordinary Secrets Manager reality (a secret NAME is regional), and what
    // makes "which region answered" observable.
    prime(CHILD_REGION, 'GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: CHILD_REGION_PASSWORD }),
    });
    prime(PARENT_REGION, 'GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: PARENT_REGION_PASSWORD }),
    });
  });

  afterEach(() => {
    resetAwsClients();
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  it('hands the parent the RESOLVED secret, not the stored {{resolve:...}} token', async () => {
    // THE bug: `attributes['Outputs.DbPassword']` was returned verbatim, so the
    // parent shipped the literal expression to AWS as a property value.
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);
    const recordedSecretValues = new Map<string, string>();

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.DbPassword'] },
      {
        ...buildContext({
          Child: nestedRow(PARENT_REGION, { DbPassword: SECRET_EXPRESSION }),
        }),
        recordedSecretValues,
      }
    );

    expect(result).toBe(PARENT_REGION_PASSWORD);
    // ...and the CONSUMER's own state stays redacted: the plaintext is recorded
    // against its expression, which is what the deploy engine's save choke
    // point rewrites it back to. Doing this re-resolution at attribute-BUILD
    // time instead would have handed the consumer a value with no entry here,
    // persisting the plaintext into the consumer's record.
    expect(recordedSecretValues.get(PARENT_REGION_PASSWORD)).toBe(SECRET_EXPRESSION);
  });

  it('resolves it in the CHILD region, not the parent region', async () => {
    // A secret NAME is regional, so the only region whose answer reproduces
    // what the child stack resolved is the child's own — recorded in the
    // synthesized `arn:cdkd-local:<childRegion>:...` physicalId. A fix reaching
    // for the parent's region would return the tokyo value here and still look
    // green on the test above.
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.DbPassword'] },
      buildContext({ Child: nestedRow(CHILD_REGION, { DbPassword: SECRET_EXPRESSION }) })
    );

    expect(result).toBe(CHILD_REGION_PASSWORD);
    // The DISCRIMINATOR: which client was constructed, and with what region.
    expect(secretSends).toHaveLength(1);
    expect(secretSends[0]?.ctorRegion).toBe(CHILD_REGION);
    expect(secretsInstances).toHaveLength(1);
    expect(secretsInstances[0]?.ctorConfig).toMatchObject({
      region: CHILD_REGION,
      profile: PROFILE,
    });
  });

  it('falls back to this resolver region when the physicalId is not a cdkd-local ARN', async () => {
    // A hand-edited state file, or a record written before the synthesized ARN
    // existed. Degrading to the consumer's region is the pre-fix region and is
    // still strictly better than shipping the token.
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.DbPassword'] },
      buildContext({ Child: nestedRow(undefined, { DbPassword: SECRET_EXPRESSION }) })
    );

    expect(result).toBe(PARENT_REGION_PASSWORD);
    expect(secretSends[0]?.ctorRegion).toBe(PARENT_REGION);
  });

  it('never logs the resolved value — only the token it was handed', async () => {
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);
    await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.DbPassword'] },
      buildContext({ Child: nestedRow(CHILD_REGION, { DbPassword: SECRET_EXPRESSION }) })
    );
    expect(logLines.join('\n')).not.toContain(CHILD_REGION_PASSWORD);
  });

  it('leaves the token alone under skipDynamicReferences (the diff / no-op path)', async () => {
    // The parent's DIFF must compare expression-vs-expression: its own state
    // holds the token, so resolving here would report a spurious change AND
    // fetch a secret at plan time.
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.DbPassword'] },
      {
        ...buildContext({ Child: nestedRow(CHILD_REGION, { DbPassword: SECRET_EXPRESSION }) }),
        skipDynamicReferences: true,
      }
    );

    expect(result).toBe(SECRET_EXPRESSION);
    expect(secretSends).toHaveLength(0);
  });

  it('returns an ordinary child output untouched, with no AWS call', async () => {
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.QueueUrl'] },
      buildContext({
        Child: nestedRow(CHILD_REGION, { QueueUrl: 'https://sqs.eu-west-1.amazonaws.com/q' }),
      })
    );

    expect(result).toBe('https://sqs.eu-west-1.amazonaws.com/q');
    expect(secretSends).toHaveLength(0);
  });

  it('is scoped to nested-stack Outputs — another type’s attribute carrying a token is untouched', async () => {
    // Scope control. A non-nested-stack attribute holding a `{{resolve:` string
    // is not this issue's class and must keep its pre-existing behaviour.
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Param', 'Value'] },
      buildContext({
        Param: {
          physicalId: `arn:cdkd-local:${CHILD_REGION}:${ACCOUNT}:nested-stack/Parent/Child`,
          resourceType: 'AWS::SSM::Parameter',
          properties: {},
          attributes: { Value: SECRET_EXPRESSION },
        },
      })
    );

    expect(result).toBe(SECRET_EXPRESSION);
    expect(secretSends).toHaveLength(0);
  });

  it('resolves a token EMBEDDED in a child output string', async () => {
    // `CfnOutput` values are routinely built with `Fn::Sub`, so the persisted
    // output can be a mixed leaf rather than a whole token.
    const resolver = new IntrinsicFunctionResolver(PARENT_REGION);
    const recordedSecretValues = new Map<string, string>();

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Child', 'Outputs.Dsn'] },
      {
        ...buildContext({
          Child: nestedRow(CHILD_REGION, {
            Dsn: `postgres://app:${SECRET_EXPRESSION}@db.internal:5432/app`,
          }),
        }),
        recordedSecretValues,
      }
    );

    expect(result).toBe(`postgres://app:${CHILD_REGION_PASSWORD}@db.internal:5432/app`);
    expect(recordedSecretValues.get(CHILD_REGION_PASSWORD)).toBe(SECRET_EXPRESSION);
    expect(secretSends[0]?.ctorRegion).toBe(CHILD_REGION);
  });
});
