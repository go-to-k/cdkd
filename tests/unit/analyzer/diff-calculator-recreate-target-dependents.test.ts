import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4383: a `--recreate-via-*` target is destroyed and re-created,
 * so the diff promotes its same-stack `Ref` / `Fn::GetAtt` readers exactly as
 * it promotes the readers of a property-driven replacement.
 *
 * DescribeType answers from the committed schema snapshot (no write-only
 * properties) for the API Gateway types only, which the registry does not
 * classify, so the schema createOnly fallback (go-to-k/cdkd#3803) decides
 * them; every other type is classified by the registry alone.
 */
const mockCloudFormationSend = vi.fn((command: { input?: { TypeName?: string } }) => {
  const type = command.input?.TypeName ?? '';
  const paths = type.startsWith('AWS::ApiGateway::')
    ? CREATE_ONLY_PATHS_SNAPSHOT.get(type)
    : undefined;
  if (paths === undefined) {
    return Promise.reject(
      Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
        name: 'AccessDeniedException',
        $metadata: { httpStatusCode: 403 },
      })
    );
  }
  return Promise.resolve({
    Schema: JSON.stringify({
      createOnlyProperties: paths.map((path) => `/properties/${path.join('/')}`),
      writeOnlyProperties: [],
    }),
  });
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/** Diff-time resolution against CURRENT state, as the deploy engine does it. */
const makeResolver =
  (state: StackState) =>
  async (value: unknown): Promise<unknown> => {
    const resolve = async (v: unknown): Promise<unknown> => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return Promise.all(v.map((item) => resolve(item)));
      const obj = v as Record<string, unknown>;
      if ('Ref' in obj && Object.keys(obj).length === 1) {
        const res = state.resources[obj['Ref'] as string];
        if (!res) throw new Error('Ref not found');
        return res.physicalId;
      }
      if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
        const [id, attr] = obj['Fn::GetAtt'] as [string, string];
        const attrValue = state.resources[id]?.attributes?.[attr];
        if (attrValue === undefined) throw new Error('GetAtt not found');
        return attrValue;
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) out[k] = await resolve(val);
      return out;
    };
    return resolve(value);
  };

/**
 * A security group whose `GroupId` AWS assigns, a Lambda reading it by `Ref`
 * (`VpcConfig`, in place), an SSM parameter reading it by `Fn::GetAtt`, a
 * parameter whose create-only `Name` reads it (so it is replaced too) with a
 * reader of its own, and a resource reading nothing.
 */
function fixture(sgTagValue = 'v1'): { state: StackState; template: CloudFormationTemplate } {
  const state: StackState = {
    version: 1,
    stackName: 'TestStack',
    resources: {
      Sg: {
        physicalId: 'sg-old',
        resourceType: 'AWS::EC2::SecurityGroup',
        properties: { GroupDescription: 'sg', Tags: [{ Key: 'k', Value: 'v1' }] },
        attributes: { GroupId: 'sg-old' },
      },
      Fn: {
        physicalId: 'fn',
        resourceType: 'AWS::Lambda::Function',
        properties: {
          FunctionName: 'fn',
          VpcConfig: { SecurityGroupIds: ['sg-old'], SubnetIds: ['subnet-1'] },
        },
        attributes: {},
      },
      GetAttReader: {
        physicalId: 'getatt-reader',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'getatt-reader', Value: 'sg-old' },
        attributes: {},
      },
      NamedBySg: {
        physicalId: 'sg-old',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'sg-old', Value: 'x' },
        attributes: {},
      },
      ReadsNamed: {
        physicalId: 'reads-named',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'reads-named', Value: 'sg-old' },
        attributes: {},
      },
      Unrelated: {
        physicalId: 'unrelated',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'unrelated', Value: 'y' },
        attributes: {},
      },
    },
    outputs: {},
    lastModified: 0,
  };
  const template: CloudFormationTemplate = {
    Resources: {
      Sg: {
        Type: 'AWS::EC2::SecurityGroup',
        // An unchanged GroupDescription; a moved Tags value is an in-place
        // UPDATE, the "target already had a real UPDATE row" shape.
        Properties: {
          GroupDescription: 'sg',
          Tags: [{ Key: 'k', Value: sgTagValue }],
        },
      },
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: 'fn',
          VpcConfig: { SecurityGroupIds: [{ Ref: 'Sg' }], SubnetIds: ['subnet-1'] },
        },
      },
      GetAttReader: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: 'getatt-reader', Value: { 'Fn::GetAtt': ['Sg', 'GroupId'] } },
      },
      NamedBySg: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: { Ref: 'Sg' }, Value: 'x' },
      },
      ReadsNamed: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: 'reads-named', Value: { Ref: 'NamedBySg' } },
      },
      Unrelated: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: 'unrelated', Value: 'y' },
      },
    },
  };
  return { state, template };
}

function pathsOf(change: ResourceChange | undefined): string[] {
  return (change?.propertyChanges ?? []).map((pc) => pc.path);
}

describe('DiffCalculator - readers of a --recreate-via-* target (go-to-k/cdkd#4383)', () => {
  it('leaves every reader NO_CHANGE without a recreate target (the pre-fix shape)', async () => {
    const { state, template } = fixture();
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      makeResolver(state)
    );
    for (const id of ['Sg', 'Fn', 'GetAttReader', 'NamedBySg', 'ReadsNamed', 'Unrelated']) {
      expect(changes.get(id)?.changeType, id).toBe('NO_CHANGE');
    }
  });

  it('promotes the Ref and Fn::GetAtt readers of a NO_CHANGE target, transitively, and leaves the target row as diffed', async () => {
    const { state, template } = fixture();
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      makeResolver(state),
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['Sg'])
    );

    // The target itself: the engine routes it from the flag, and
    // `promoteRecreateTargets` turns its NO_CHANGE row into an UPDATE later.
    expect(changes.get('Sg')?.changeType).toBe('NO_CHANGE');

    const fn = changes.get('Fn');
    expect(fn?.changeType).toBe('UPDATE');
    expect(pathsOf(fn)).toEqual(['VpcConfig']);
    expect(fn?.propertyChanges?.[0]?.replacementPropagated).toBe(true);
    expect(fn?.propertyChanges?.[0]?.requiresReplacement).toBe(false);

    const getAttReader = changes.get('GetAttReader');
    expect(getAttReader?.changeType).toBe('UPDATE');
    expect(pathsOf(getAttReader)).toEqual(['Value']);
    expect(getAttReader?.propertyChanges?.[0]?.replacementPropagated).toBe(true);

    // A create-only referencing property makes the reader a replacement too,
    // so ITS reader is promoted in turn.
    const namedBySg = changes.get('NamedBySg');
    expect(namedBySg?.changeType).toBe('UPDATE');
    expect(namedBySg?.propertyChanges?.find((pc) => pc.path === 'Name')?.requiresReplacement).toBe(
      true
    );
    const readsNamed = changes.get('ReadsNamed');
    expect(readsNamed?.changeType).toBe('UPDATE');
    expect(pathsOf(readsNamed)).toEqual(['Value']);

    expect(changes.get('Unrelated')?.changeType).toBe('NO_CHANGE');
    expect(new DiffCalculator().getSummary(changes)).toMatchObject({ update: 4, noChange: 2 });
  });

  it('promotes the readers of a target whose row is already an in-place UPDATE', async () => {
    const { state, template } = fixture('v2');
    const without = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));
    // The pre-fix shape of this case: the target's own UPDATE is in place, so
    // nothing seeds the replacement pass and its readers stay NO_CHANGE.
    expect(without.get('Sg')?.changeType).toBe('UPDATE');
    expect(without.get('Sg')?.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(false);
    expect(without.get('Fn')?.changeType).toBe('NO_CHANGE');

    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      makeResolver(state),
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['Sg'])
    );
    expect(pathsOf(changes.get('Sg'))).toEqual(['Tags']);
    expect(changes.get('Fn')?.changeType).toBe('UPDATE');
    expect(changes.get('GetAttReader')?.changeType).toBe('UPDATE');
    // Promoted once, by the replacement pass, not again by the in-place pass.
    expect(pathsOf(changes.get('GetAttReader'))).toEqual(['Value']);
    expect(changes.get('GetAttReader')?.propertyChanges?.[0]?.inPlacePropagated).toBeUndefined();
    expect(changes.get('ReadsNamed')?.changeType).toBe('UPDATE');
    expect(changes.get('Unrelated')?.changeType).toBe('NO_CHANGE');
  });

  it('seeds nothing from a target this deploy creates or deletes', async () => {
    const { state, template } = fixture();
    // CREATE: the record does not exist yet, so its readers resolve fresh.
    const created = structuredClone(state);
    delete created.resources['Sg'];
    const createChanges = await new DiffCalculator().calculateDiff(
      created,
      template,
      makeResolver(created),
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['Sg'])
    );
    expect(createChanges.get('Sg')?.changeType).toBe('CREATE');
    // `Fn` resolves the Ref best-effort against a state without `Sg`, which
    // throws in this resolver and keeps the raw intrinsic: whatever that
    // yields, nothing is marked as propagated from a replacement.
    expect(
      createChanges.get('Fn')?.propertyChanges?.some((pc) => pc.replacementPropagated) ?? false
    ).toBe(false);

    // DELETE: a `Condition` now false drops the target, while a reader keeps
    // it on the untaken branch of an `Fn::If`. Its value resolves as
    // recorded, and a resource this deploy deletes is recreated by nobody, so
    // the reader stays NO_CHANGE.
    const ifValue = { 'Fn::If': ['Never', { Ref: 'Sg' }, 'none'] };
    const deleteState = structuredClone(state);
    deleteState.resources['GetAttReader']!.properties = {
      Name: 'getatt-reader',
      Value: { 'Fn::If': ['Never', 'sg-old', 'none'] },
    };
    const deletedTemplate: CloudFormationTemplate = {
      Resources: {
        GetAttReader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'getatt-reader', Value: ifValue },
        },
        Unrelated: template.Resources['Unrelated']!,
      },
    };
    const deleteChanges = await new DiffCalculator().calculateDiff(
      deleteState,
      deletedTemplate,
      makeResolver(deleteState),
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['Sg'])
    );
    expect(deleteChanges.get('Sg')?.changeType).toBe('DELETE');
    expect(deleteChanges.get('GetAttReader')?.changeType).toBe('NO_CHANGE');
    expect(deleteChanges.get('Unrelated')?.changeType).toBe('NO_CHANGE');
  });

  it('ignores a target id the template does not hold', async () => {
    const { state, template } = fixture();
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      makeResolver(state),
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['Missing'])
    );
    for (const id of ['Sg', 'Fn', 'GetAttReader', 'NamedBySg', 'ReadsNamed', 'Unrelated']) {
      expect(changes.get(id)?.changeType, id).toBe('NO_CHANGE');
    }
  });

  it('replaces a reader whose referencing property is schema create-only on an unclassified type, when the target is the only thing that moves', async () => {
    // The issue's shape: a recreated RestApi mints a new `restApiId`, and a
    // Deployment / Stage hold it in create-only `RestApiId`. With nothing
    // else in the stack changing, the target is the only seed of the
    // create-only schema load, so without it neither reader could be
    // classified as a replacement.
    const state: StackState = {
      version: 1,
      stackName: 'TestStack',
      resources: {
        Api: {
          physicalId: 'api-old',
          resourceType: 'AWS::ApiGateway::RestApi',
          properties: { Name: 'api' },
          attributes: { RootResourceId: 'root-old' },
        },
        Deployment: {
          physicalId: 'dep-old',
          resourceType: 'AWS::ApiGateway::Deployment',
          properties: { RestApiId: 'api-old' },
          attributes: {},
        },
        Stage: {
          physicalId: 'prod',
          resourceType: 'AWS::ApiGateway::Stage',
          properties: { RestApiId: 'api-old', DeploymentId: 'dep-old', StageName: 'prod' },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'api' } },
        Deployment: {
          Type: 'AWS::ApiGateway::Deployment',
          Properties: { RestApiId: { Ref: 'Api' } },
        },
        Stage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: 'Api' },
            DeploymentId: { Ref: 'Deployment' },
            StageName: 'prod',
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      makeResolver(state),
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['Api'])
    );

    const deployment = changes.get('Deployment');
    expect(deployment?.changeType).toBe('UPDATE');
    expect(deployment?.propertyChanges).toEqual([
      expect.objectContaining({
        path: 'RestApiId',
        replacementPropagated: true,
        requiresReplacement: true,
      }),
    ]);
    const stage = changes.get('Stage');
    expect(stage?.changeType).toBe('UPDATE');
    expect(stage?.propertyChanges?.find((pc) => pc.path === 'RestApiId')?.requiresReplacement).toBe(
      true
    );
    expect(pathsOf(stage).sort()).toEqual(['DeploymentId', 'RestApiId']);
  });
});
