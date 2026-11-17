import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import {
  aliasPolicySecretGuard,
  resolveAliasUpdatePolicy,
} from '../../../src/deployment/deploy-engine/update-policy.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

// go-to-k/cdkd#6437 PR 3 review: the alias policy's secret guard against the
// REAL resolver. The resolved policy is journaled, so a secret reaching it by
// any route (a `Ref` to a `NoEcho` parameter, an `Fn::Join` spelling a dynamic
// reference, a short value the alias's own properties already recorded) is
// refused before anything is sent.

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...child, child: () => child }) };
});
const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: ssmSend },
  }),
}));

const TYPE = 'AWS::Lambda::Alias';

function template(): CloudFormationTemplate {
  return {
    Parameters: {
      Hidden: { Type: 'String', NoEcho: true },
      Short: { Type: 'String', NoEcho: true },
      Plain: { Type: 'String' },
    },
    Resources: {},
  };
}

function context(bag: RecordedSecretValues): ResolverContext {
  return {
    template: template(),
    resources: {},
    parameters: { Hidden: 'hidden-group-name', Short: 'ab', Plain: 'public-group' },
    recordedSecretValues: bag,
  } as ResolverContext;
}

function aliasWith(policy: Record<string, unknown>): TemplateResource {
  return {
    Type: TYPE,
    Properties: {},
    UpdatePolicy: {
      CodeDeployLambdaAliasUpdate: { ApplicationName: 'my-app', ...policy },
    },
  } as TemplateResource;
}

async function run(policy: Record<string, unknown>, bag: RecordedSecretValues = new Map()) {
  const resolver = new IntrinsicFunctionResolver();
  const ctx = context(bag);
  return resolveAliasUpdatePolicy(
    true,
    'Alias',
    TYPE,
    aliasWith(policy),
    true,
    (value) => resolver.resolve(value, ctx),
    () => aliasPolicySecretGuard(bag)
  );
}

describe('aliasPolicySecretGuard with the real resolver (go-to-k/cdkd#6437)', () => {
  beforeEach(() => {
    ssmSend.mockReset();
  });

  it('resolves a plain parameter', async () => {
    expect(await run({ DeploymentGroupName: { Ref: 'Plain' } })).toEqual({
      CodeDeployLambdaAliasUpdate: { ApplicationName: 'my-app', DeploymentGroupName: 'public-group' },
    });
  });

  it('refuses a Ref to a NoEcho parameter', async () => {
    const error = await run({ DeploymentGroupName: { Ref: 'Hidden' } }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect((error as { code?: unknown }).code).toBe('UPDATE_POLICY_SECRET_REFUSED');
  });

  it('refuses a short NoEcho value the alias properties already recorded', async () => {
    const bag: RecordedSecretValues = new Map();
    // The alias's own properties resolve first, into the same bag.
    await new IntrinsicFunctionResolver().resolve({ Description: { Ref: 'Short' } }, context(bag));
    const error = await run({ DeploymentGroupName: { Ref: 'Short' } }, bag).catch(
      (e: unknown) => e
    );
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
  });

  it('refuses an Fn::Join that spells a dynamic reference', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'joined-secret-value', Type: 'SecureString' } });
    const error = await run({
      DeploymentGroupName: { 'Fn::Join': ['', ['{{resol', 've:ssm-secure:/dg/name}}']] },
    }).catch((e: unknown) => e);
    // The joined reference really was resolved (and so recorded) first.
    expect(ssmSend).toHaveBeenCalled();
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
  });
});
