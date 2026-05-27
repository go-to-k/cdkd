import { describe, expect, it, vi } from 'vite-plus/test';
import {
  substituteAgainstState,
  substituteAgainstStateAsync,
  substituteEnvVarsFromState,
  substituteEnvVarsFromStateAsync,
  type CrossStackResolver,
  type SubstitutionContext,
} from '../../../src/local/state-resolver.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * Helper: build a `ResourceState` with sane defaults so tests stay focused
 * on the substitution logic instead of repeating boilerplate.
 */
function res(
  physicalId: string,
  attrs: Record<string, unknown> = {}
): ResourceState {
  return {
    physicalId,
    resourceType: 'AWS::Test::Resource',
    properties: {},
    attributes: attrs,
  };
}

describe('substituteAgainstState', () => {
  it('passes string / number / boolean primitives through unchanged', () => {
    const resources = {};
    expect(substituteAgainstState('literal', resources)).toEqual({
      kind: 'literal',
      value: 'literal',
    });
    expect(substituteAgainstState(42, resources)).toEqual({ kind: 'literal', value: 42 });
    expect(substituteAgainstState(true, resources)).toEqual({ kind: 'literal', value: true });
  });

  it('substitutes Ref against state.resources[id].physicalId', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'),
    };
    expect(substituteAgainstState({ Ref: 'MyTable' }, resources)).toEqual({
      kind: 'literal',
      value: 'real-table-name',
    });
  });

  it('reports unresolved when Ref points at a logical ID not in state', () => {
    const result = substituteAgainstState({ Ref: 'MissingTable' }, {});
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('MissingTable');
      expect(result.reason).toContain('no record in cdkd state');
    }
  });

  it('substitutes Fn::GetAtt array form against state.resources[id].attributes', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name', { Arn: 'arn:aws:dynamodb:us-east-1:123:table/MyTable' }),
    };
    expect(substituteAgainstState({ 'Fn::GetAtt': ['MyTable', 'Arn'] }, resources)).toEqual({
      kind: 'literal',
      value: 'arn:aws:dynamodb:us-east-1:123:table/MyTable',
    });
  });

  it('substitutes Fn::GetAtt string form (LogicalId.Attribute)', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name', { Arn: 'arn:test' }),
    };
    expect(substituteAgainstState({ 'Fn::GetAtt': 'MyTable.Arn' }, resources)).toEqual({
      kind: 'literal',
      value: 'arn:test',
    });
  });

  it('reports unresolved when Fn::GetAtt resource is not in state', () => {
    const result = substituteAgainstState(
      { 'Fn::GetAtt': ['Missing', 'Arn'] },
      {}
    );
    expect(result.kind).toBe('unresolved');
  });

  it('reports unresolved when Fn::GetAtt attribute was not captured at deploy time', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'), // no attributes recorded
    };
    const result = substituteAgainstState({ 'Fn::GetAtt': ['MyTable', 'Arn'] }, resources);
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('not captured');
    }
  });

  it('JSON-stringifies object-valued Fn::GetAtt attributes', () => {
    // Some attributes (e.g. CloudFront `Endpoints`) are objects; Lambda env
    // vars are strings, so we surface them as JSON. The handler can re-parse.
    const resources: Record<string, ResourceState> = {
      MyResource: res('resource-id', { Endpoints: { read: 'r', write: 'w' } }),
    };
    expect(substituteAgainstState({ 'Fn::GetAtt': ['MyResource', 'Endpoints'] }, resources)).toEqual({
      kind: 'literal',
      value: '{"read":"r","write":"w"}',
    });
  });

  it('substitutes Fn::Sub single-string form with ${LogicalId} placeholders', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'),
    };
    expect(substituteAgainstState({ 'Fn::Sub': 'prefix-${MyTable}' }, resources)).toEqual({
      kind: 'literal',
      value: 'prefix-real-table-name',
    });
  });

  it('substitutes Fn::Sub with ${LogicalId.attr} placeholders', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name', { Arn: 'arn:test:table' }),
    };
    expect(
      substituteAgainstState({ 'Fn::Sub': 'arn=${MyTable.Arn};name=${MyTable}' }, resources)
    ).toEqual({
      kind: 'literal',
      value: 'arn=arn:test:table;name=real-table-name',
    });
  });

  it('substitutes Fn::Sub two-arg form against the bindings map (with intrinsic values)', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'),
      MyBucket: res('bucket-1234'),
    };
    const result = substituteAgainstState(
      {
        'Fn::Sub': [
          'table=${T};bucket=${B};literal=${L}',
          { T: { Ref: 'MyTable' }, B: { Ref: 'MyBucket' }, L: 'just-a-string' },
        ],
      },
      resources
    );
    expect(result).toEqual({
      kind: 'literal',
      value: 'table=real-table-name;bucket=bucket-1234;literal=just-a-string',
    });
  });

  it('reports unresolved on Fn::Sub when any placeholder fails', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'),
    };
    const result = substituteAgainstState(
      { 'Fn::Sub': '${MyTable}-${MissingTable}' },
      resources
    );
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('MissingTable');
    }
  });

  it('reports unresolved for unsupported intrinsics (Fn::ImportValue, Fn::If, etc.)', () => {
    const r1 = substituteAgainstState({ 'Fn::ImportValue': 'OtherStackExport' }, {});
    expect(r1.kind).toBe('unresolved');

    const r2 = substituteAgainstState(
      { 'Fn::If': ['Cond', 'a', 'b'] } as Record<string, unknown>,
      {}
    );
    expect(r2.kind).toBe('unresolved');
  });

  it('reports unresolved for objects with multiple keys (not a valid intrinsic shape)', () => {
    const result = substituteAgainstState({ Ref: 'X', 'Fn::GetAtt': ['Y', 'Z'] }, {});
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('one key');
    }
  });

  it('reports unresolved for null', () => {
    const result = substituteAgainstState(null, {});
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('unsupported value type');
    }
  });

  // Fn::Join support (Gap 1 of #286, issue #291).
  it('substitutes Fn::Join with literal-only parts', () => {
    expect(substituteAgainstState({ 'Fn::Join': ['|', ['a', 'b', 'c']] }, {})).toEqual({
      kind: 'literal',
      value: 'a|b|c',
    });
  });

  it('substitutes Fn::Join with nested Ref against state', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: {
        physicalId: 'tbl-deployed',
        resourceType: 'AWS::DynamoDB::Table',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    };
    expect(
      substituteAgainstState(
        { 'Fn::Join': ['-', ['prefix', { Ref: 'MyTable' }, 'suffix']] },
        resources
      )
    ).toEqual({ kind: 'literal', value: 'prefix-tbl-deployed-suffix' });
  });

  it('substitutes Fn::Join with nested Fn::Sub', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: {
        physicalId: 'tbl',
        resourceType: 'AWS::DynamoDB::Table',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    };
    expect(
      substituteAgainstState(
        { 'Fn::Join': ['', [{ 'Fn::Sub': 'x-${MyTable}' }, 'Y']] },
        resources
      )
    ).toEqual({ kind: 'literal', value: 'x-tblY' });
  });

  it('reports unresolved when any Fn::Join element is unresolvable', () => {
    const result = substituteAgainstState(
      { 'Fn::Join': ['-', ['a', { Ref: 'MissingResource' }]] },
      {}
    );
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('Fn::Join element [1]');
      expect(result.reason).toContain('MissingResource');
    }
  });

  it('rejects Fn::Join with non-array argument', () => {
    const r = substituteAgainstState({ 'Fn::Join': 'not-an-array' }, {});
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') expect(r.reason).toContain('Fn::Join expects');
  });

  it('rejects Fn::Join with non-string delimiter', () => {
    const r = substituteAgainstState({ 'Fn::Join': [42, ['a', 'b']] }, {});
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') expect(r.reason).toContain('delimiter must be a string');
  });

  // Pseudo parameter support (issue #291 — used by ecs.Secret.fromSsmParameter).
  it('substitutes Ref pseudo parameters from the context bag', () => {
    const r = substituteAgainstState(
      { Ref: 'AWS::Region' },
      { resources: {}, pseudoParameters: { region: 'eu-west-1' } }
    );
    expect(r).toEqual({ kind: 'literal', value: 'eu-west-1' });
  });

  it('substitutes ${AWS::*} placeholders inside Fn::Sub', () => {
    const r = substituteAgainstState(
      { 'Fn::Sub': '${AWS::Partition}/${AWS::AccountId}' },
      {
        resources: {},
        pseudoParameters: { partition: 'aws', accountId: '123456789012' },
      }
    );
    expect(r).toEqual({ kind: 'literal', value: 'aws/123456789012' });
  });

  it('drops a Ref to an AWS pseudo when pseudoParameters is not supplied', () => {
    const r = substituteAgainstState({ Ref: 'AWS::Region' }, {});
    expect(r.kind).toBe('unresolved');
  });

  it('resolves the canonical ecs.Secret.fromSsmParameter Fn::Join shape', () => {
    // Exact shape CDK 2.x synthesizes for ecs.Secret.fromSsmParameter(param).
    const resources: Record<string, ResourceState> = {
      MyParam: {
        physicalId: '/app/param',
        resourceType: 'AWS::SSM::Parameter',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    };
    const r = substituteAgainstState(
      {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':ssm:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            ':parameter/',
            { Ref: 'MyParam' },
          ],
        ],
      },
      {
        resources,
        pseudoParameters: {
          partition: 'aws',
          region: 'us-east-1',
          accountId: '123456789012',
        },
      }
    );
    expect(r).toEqual({
      kind: 'literal',
      value: 'arn:aws:ssm:us-east-1:123456789012:parameter//app/param',
    });
  });
});

/**
 * Test suite for issue #636 — `Fn::Select` + `Fn::Split` support so the
 * canonical CDK `Fn.select(N, Fn.split(':', secret.secretArn))` shape
 * resolves instead of warn-and-dropping the env var.
 */
describe('substituteAgainstState (Fn::Select / Fn::Split)', () => {
  it('picks the indexed element from a literal-array list under Fn::Select', () => {
    const r = substituteAgainstState({ 'Fn::Select': [1, ['a', 'b', 'c']] }, {});
    expect(r).toEqual({ kind: 'literal', value: 'b' });
  });

  it('resolves Fn::Select over Fn::Split over a literal ARN string', () => {
    // Common CDK pattern: parse the 7th `:`-segment off a secret ARN.
    const arn = 'arn:aws:secretsmanager:us-east-1:123:secret:mysecret-AbCdEf';
    const r = substituteAgainstState(
      { 'Fn::Select': [6, { 'Fn::Split': [':', arn] }] },
      {}
    );
    expect(r).toEqual({ kind: 'literal', value: 'mysecret-AbCdEf' });
  });

  it('resolves Fn::Select over Fn::Split over a Fn::GetAtt with a state-recorded attribute', () => {
    // The canonical `Fn.select(6, Fn.split(':', secret.secretArn))` shape.
    const resources: Record<string, ResourceState> = {
      MySecret: res('secret-physical-id', {
        Arn: 'arn:aws:secretsmanager:us-east-1:123:secret:mysecret-AbCdEf',
      }),
    };
    const r = substituteAgainstState(
      {
        'Fn::Select': [
          6,
          { 'Fn::Split': [':', { 'Fn::GetAtt': ['MySecret', 'Arn'] }] },
        ],
      },
      resources
    );
    expect(r).toEqual({ kind: 'literal', value: 'mysecret-AbCdEf' });
  });

  it('accepts a numeric-string index (the CFn template shape after JSON round-trip)', () => {
    const r = substituteAgainstState(
      { 'Fn::Select': ['0', ['first', 'second']] },
      {}
    );
    expect(r).toEqual({ kind: 'literal', value: 'first' });
  });

  it('resolves Fn::Select with intrinsic-valued literal-array elements', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('tbl-deployed'),
    };
    const r = substituteAgainstState(
      { 'Fn::Select': [1, ['first', { Ref: 'MyTable' }, 'third']] },
      resources
    );
    expect(r).toEqual({ kind: 'literal', value: 'tbl-deployed' });
  });

  it('rejects bare Fn::Split at the top level (arrays are not valid env-var values)', () => {
    const r = substituteAgainstState({ 'Fn::Split': [':', 'a:b:c'] }, {});
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('Fn::Split');
      expect(r.reason).toContain('array');
    }
  });

  it('reports unresolved on out-of-bounds Fn::Select index', () => {
    const r = substituteAgainstState({ 'Fn::Select': [5, ['a', 'b']] }, {});
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('out of bounds');
    }
  });

  it('reports unresolved on negative Fn::Select index', () => {
    const r = substituteAgainstState({ 'Fn::Select': [-1, ['a', 'b']] }, {});
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('non-negative');
    }
  });

  it('reports unresolved on non-numeric Fn::Select index', () => {
    const r = substituteAgainstState(
      { 'Fn::Select': ['not-a-number', ['a', 'b']] },
      {}
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('finite number');
    }
  });

  it('rejects malformed Fn::Select argument shapes', () => {
    const r1 = substituteAgainstState({ 'Fn::Select': 'not-an-array' }, {});
    expect(r1.kind).toBe('unresolved');
    if (r1.kind === 'unresolved') expect(r1.reason).toContain('Fn::Select expects');

    const r2 = substituteAgainstState({ 'Fn::Select': [0] }, {});
    expect(r2.kind).toBe('unresolved');
  });

  it('rejects Fn::Select when the list arg resolves to a scalar (not an array)', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('scalar-value'),
    };
    const r = substituteAgainstState(
      { 'Fn::Select': [0, { Ref: 'MyTable' }] },
      resources
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('must resolve to an array');
    }
  });

  it('propagates Fn::Split inner-string resolution failures through Fn::Select', () => {
    const r = substituteAgainstState(
      {
        'Fn::Select': [0, { 'Fn::Split': [':', { Ref: 'NotInState' }] }],
      },
      {}
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('NotInState');
    }
  });

  it('rejects malformed Fn::Split shape under Fn::Select', () => {
    const r = substituteAgainstState(
      { 'Fn::Select': [0, { 'Fn::Split': 'not-an-array' }] },
      {}
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('Fn::Split expects');
    }
  });

  it('rejects Fn::Split with non-string delimiter under Fn::Select', () => {
    const r = substituteAgainstState(
      { 'Fn::Select': [0, { 'Fn::Split': [42, 'a:b'] }] },
      {}
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('delimiter must be a string');
    }
  });

  it('keeps Fn::Join element-level resolution scalar-only (rejects nested Fn::Split element)', () => {
    // Join elements must be scalars in CFn; a bare Fn::Split inside a
    // Join element should fall under the top-level Fn::Split rejection.
    const r = substituteAgainstState(
      { 'Fn::Join': ['-', ['x', { 'Fn::Split': [':', 'a:b'] }]] },
      {}
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('Fn::Join element [1]');
      expect(r.reason).toContain('Fn::Split');
    }
  });
});

describe('substituteAgainstStateAsync (Fn::Select / Fn::Split)', () => {
  it('resolves Fn::Select through the async dispatcher (delegates to sync path)', async () => {
    const resources: Record<string, ResourceState> = {
      MySecret: res('secret-physical-id', {
        Arn: 'arn:aws:secretsmanager:us-east-1:123:secret:mysecret-AbCdEf',
      }),
    };
    const r = await substituteAgainstStateAsync(
      {
        'Fn::Select': [
          6,
          { 'Fn::Split': [':', { 'Fn::GetAtt': ['MySecret', 'Arn'] }] },
        ],
      },
      resources
    );
    expect(r).toEqual({ kind: 'literal', value: 'mysecret-AbCdEf' });
  });

  it('rejects bare Fn::Split at the async top level', async () => {
    const r = await substituteAgainstStateAsync(
      { 'Fn::Split': [':', 'a:b:c'] },
      {}
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('Fn::Split');
    }
  });
});

describe('substituteEnvVarsFromState', () => {
  it('returns empty audit + empty env when templateEnv is undefined', () => {
    const out = substituteEnvVarsFromState(undefined, {});
    expect(out.env).toEqual({});
    expect(out.audit.resolvedKeys).toEqual([]);
    expect(out.audit.unresolved).toEqual([]);
  });

  it('passes literals through without auditing them', () => {
    const out = substituteEnvVarsFromState({ A: 'a', B: 42 }, {});
    expect(out.env).toEqual({ A: 'a', B: 42 });
    expect(out.audit.resolvedKeys).toEqual([]);
    expect(out.audit.unresolved).toEqual([]);
  });

  it('substitutes Ref- and Fn::GetAtt-valued entries against state', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name', { Arn: 'arn:test' }),
    };
    const out = substituteEnvVarsFromState(
      {
        TABLE_NAME: { Ref: 'MyTable' },
        TABLE_ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] },
        LITERAL: 'unchanged',
      },
      resources
    );
    expect(out.env).toEqual({
      TABLE_NAME: 'real-table-name',
      TABLE_ARN: 'arn:test',
      LITERAL: 'unchanged',
    });
    expect(out.audit.resolvedKeys.sort()).toEqual(['TABLE_ARN', 'TABLE_NAME']);
    expect(out.audit.unresolved).toEqual([]);
  });

  it('drops keys whose substitution failed and reports them in audit.unresolved', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'),
    };
    const out = substituteEnvVarsFromState(
      {
        OK: { Ref: 'MyTable' },
        MISSING: { Ref: 'NotInState' },
        UNSUPPORTED: { 'Fn::ImportValue': 'OtherStackExport' },
      },
      resources
    );
    expect(out.env).toEqual({ OK: 'real-table-name' });
    expect(out.audit.resolvedKeys).toEqual(['OK']);
    expect(out.audit.unresolved.map((u) => u.key).sort()).toEqual(['MISSING', 'UNSUPPORTED']);
    const missing = out.audit.unresolved.find((u) => u.key === 'MISSING');
    expect(missing?.reason).toContain('NotInState');
  });

  it('substitutes Fn::Sub template strings against state', () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'),
    };
    const out = substituteEnvVarsFromState(
      { TABLE_NAME: { 'Fn::Sub': 'prefix-${MyTable}' } },
      resources
    );
    expect(out.env).toEqual({ TABLE_NAME: 'prefix-real-table-name' });
    expect(out.audit.resolvedKeys).toEqual(['TABLE_NAME']);
  });
});

/**
 * Test suite for issue #454 — async cross-stack resolver path. The sync
 * helper still surfaces Fn::ImportValue / Fn::GetStackOutput as
 * `unresolved` (verified by the legacy tests above); the async helper
 * delegates to the supplied `crossStackResolver` when present.
 */
describe('substituteAgainstStateAsync (Fn::ImportValue / Fn::GetStackOutput)', () => {
  function buildResolver(overrides: Partial<CrossStackResolver> = {}): CrossStackResolver {
    return {
      resolveImport: vi.fn(async () => undefined),
      resolveGetStackOutput: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('falls back to the sync path for every legacy intrinsic', async () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name'),
    };
    const r = await substituteAgainstStateAsync({ Ref: 'MyTable' }, resources);
    expect(r).toEqual({ kind: 'literal', value: 'real-table-name' });
  });

  it('resolves Fn::ImportValue via the cross-stack resolver', async () => {
    const resolveImport = vi.fn(async (name: string) => {
      expect(name).toBe('ProducerStack-BucketName');
      return 'my-bucket-12345';
    });
    const ctx: SubstitutionContext = {
      resources: {},
      crossStackResolver: { resolveImport, resolveGetStackOutput: vi.fn() },
    };
    const r = await substituteAgainstStateAsync(
      { 'Fn::ImportValue': 'ProducerStack-BucketName' },
      ctx
    );
    expect(r).toEqual({ kind: 'literal', value: 'my-bucket-12345' });
    expect(resolveImport).toHaveBeenCalledOnce();
  });

  it('reports unresolved when Fn::ImportValue lookup returns undefined', async () => {
    const ctx: SubstitutionContext = {
      resources: {},
      crossStackResolver: buildResolver({
        resolveImport: vi.fn(async () => undefined),
      }),
    };
    const r = await substituteAgainstStateAsync(
      { 'Fn::ImportValue': 'MissingExport' },
      ctx
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain("MissingExport");
      expect(r.reason).toContain('not found');
    }
  });

  it('reports unresolved when Fn::ImportValue lookup throws', async () => {
    const ctx: SubstitutionContext = {
      resources: {},
      crossStackResolver: buildResolver({
        resolveImport: vi.fn(async () => {
          throw new Error('S3 AccessDenied');
        }),
      }),
    };
    const r = await substituteAgainstStateAsync({ 'Fn::ImportValue': 'X' }, ctx);
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('lookup failed');
      expect(r.reason).toContain('S3 AccessDenied');
    }
  });

  it('resolves Fn::ImportValue argument via Fn::Sub against pseudo parameters first', async () => {
    const resolveImport = vi.fn(async (name: string) => {
      // Verify the inner Fn::Sub was resolved BEFORE the resolver was invoked.
      expect(name).toBe('Stack-us-east-1-Bucket');
      return 'bucket-from-inner';
    });
    const ctx: SubstitutionContext = {
      resources: {},
      pseudoParameters: { region: 'us-east-1' },
      crossStackResolver: { resolveImport, resolveGetStackOutput: vi.fn() },
    };
    const r = await substituteAgainstStateAsync(
      {
        'Fn::ImportValue': { 'Fn::Sub': 'Stack-${AWS::Region}-Bucket' },
      },
      ctx
    );
    expect(r).toEqual({ kind: 'literal', value: 'bucket-from-inner' });
  });

  it('reports unresolved when Fn::ImportValue is encountered without a cross-stack resolver', async () => {
    const r = await substituteAgainstStateAsync(
      { 'Fn::ImportValue': 'X' },
      { resources: {} }
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('no cross-stack resolver');
    }
  });

  it('resolves Fn::GetStackOutput via the cross-stack resolver', async () => {
    const resolveGetStackOutput = vi.fn(
      async (stackName: string, region: string, outputName: string) => {
        expect(stackName).toBe('ProducerStack');
        expect(region).toBe('us-east-1');
        expect(outputName).toBe('BucketName');
        return 'producer-bucket';
      }
    );
    const ctx: SubstitutionContext = {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: { resolveImport: vi.fn(), resolveGetStackOutput },
    };
    const r = await substituteAgainstStateAsync(
      {
        'Fn::GetStackOutput': { StackName: 'ProducerStack', OutputName: 'BucketName' },
      },
      ctx
    );
    expect(r).toEqual({ kind: 'literal', value: 'producer-bucket' });
    expect(resolveGetStackOutput).toHaveBeenCalledOnce();
  });

  it('honors Fn::GetStackOutput.Region when set explicitly on the intrinsic', async () => {
    const resolveGetStackOutput = vi.fn(
      async (_stackName: string, region: string) => {
        expect(region).toBe('eu-west-1');
        return 'eu-bucket';
      }
    );
    const ctx: SubstitutionContext = {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: { resolveImport: vi.fn(), resolveGetStackOutput },
    };
    const r = await substituteAgainstStateAsync(
      {
        'Fn::GetStackOutput': {
          StackName: 'ProducerStack',
          OutputName: 'BucketName',
          Region: 'eu-west-1',
        },
      },
      ctx
    );
    expect(r).toEqual({ kind: 'literal', value: 'eu-bucket' });
  });

  it('rejects Fn::GetStackOutput when no Region is supplied and consumerRegion is unset', async () => {
    const ctx: SubstitutionContext = {
      resources: {},
      crossStackResolver: buildResolver(),
    };
    const r = await substituteAgainstStateAsync(
      {
        'Fn::GetStackOutput': { StackName: 'X', OutputName: 'Y' },
      },
      ctx
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('no Region supplied');
    }
  });

  it('rejects Fn::GetStackOutput with RoleArn (cross-account is deferred)', async () => {
    const ctx: SubstitutionContext = {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: buildResolver(),
    };
    const r = await substituteAgainstStateAsync(
      {
        'Fn::GetStackOutput': {
          StackName: 'X',
          OutputName: 'Y',
          RoleArn: 'arn:aws:iam::222:role/r',
        },
      },
      ctx
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('RoleArn');
      expect(r.reason).toContain('#449');
    }
  });

  it('rejects Fn::GetStackOutput when required fields are missing', async () => {
    const ctx: SubstitutionContext = {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: buildResolver(),
    };
    const r1 = await substituteAgainstStateAsync(
      { 'Fn::GetStackOutput': { OutputName: 'Y' } },
      ctx
    );
    expect(r1.kind).toBe('unresolved');
    const r2 = await substituteAgainstStateAsync(
      { 'Fn::GetStackOutput': { StackName: 'X' } },
      ctx
    );
    expect(r2.kind).toBe('unresolved');
  });

  it('falls back to consumerRegion when Fn::GetStackOutput.Region is omitted (via pseudoParameters)', async () => {
    const resolveGetStackOutput = vi.fn(async (_s: string, region: string) => {
      expect(region).toBe('ap-northeast-1');
      return 'val';
    });
    const ctx: SubstitutionContext = {
      resources: {},
      pseudoParameters: { region: 'ap-northeast-1' },
      crossStackResolver: { resolveImport: vi.fn(), resolveGetStackOutput },
    };
    const r = await substituteAgainstStateAsync(
      { 'Fn::GetStackOutput': { StackName: 'X', OutputName: 'Y' } },
      ctx
    );
    expect(r).toEqual({ kind: 'literal', value: 'val' });
  });

  it('reports unresolved when Fn::GetStackOutput is encountered without a cross-stack resolver', async () => {
    const r = await substituteAgainstStateAsync(
      { 'Fn::GetStackOutput': { StackName: 'X', OutputName: 'Y' } },
      { resources: {}, consumerRegion: 'us-east-1' }
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('no cross-stack resolver');
    }
  });

  it('reports unresolved when Fn::GetStackOutput lookup returns undefined', async () => {
    const ctx: SubstitutionContext = {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: buildResolver({
        resolveGetStackOutput: vi.fn(async () => undefined),
      }),
    };
    const r = await substituteAgainstStateAsync(
      { 'Fn::GetStackOutput': { StackName: 'X', OutputName: 'Missing' } },
      ctx
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('output not found');
    }
  });
});

describe('substituteEnvVarsFromStateAsync', () => {
  it('substitutes a Fn::ImportValue env var via the resolver and drops a sibling unresolvable', async () => {
    const resolveImport = vi.fn(async (name: string) =>
      name === 'GoodExport' ? 'good-value' : undefined
    );
    const ctx: SubstitutionContext = {
      resources: {},
      crossStackResolver: { resolveImport, resolveGetStackOutput: vi.fn() },
    };
    const out = await substituteEnvVarsFromStateAsync(
      {
        OK: { 'Fn::ImportValue': 'GoodExport' },
        BAD: { 'Fn::ImportValue': 'MissingExport' },
        LITERAL: 'unchanged',
      },
      ctx
    );
    expect(out.env).toEqual({ OK: 'good-value', LITERAL: 'unchanged' });
    expect(out.audit.resolvedKeys).toEqual(['OK']);
    expect(out.audit.unresolved.map((u) => u.key)).toEqual(['BAD']);
  });

  it('substitutes a Fn::GetStackOutput env var via the resolver', async () => {
    const resolveGetStackOutput = vi.fn(async () => 'producer-output-value');
    const ctx: SubstitutionContext = {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: { resolveImport: vi.fn(), resolveGetStackOutput },
    };
    const out = await substituteEnvVarsFromStateAsync(
      {
        OUTPUT_VALUE: {
          'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'X' },
        },
      },
      ctx
    );
    expect(out.env).toEqual({ OUTPUT_VALUE: 'producer-output-value' });
    expect(out.audit.resolvedKeys).toEqual(['OUTPUT_VALUE']);
  });

  it('preserves the warn-and-drop UX when the resolver is not supplied', async () => {
    const out = await substituteEnvVarsFromStateAsync(
      {
        IMPORT: { 'Fn::ImportValue': 'Export' },
        OUTPUT: { 'Fn::GetStackOutput': { StackName: 'S', OutputName: 'O' } },
      },
      { resources: {}, consumerRegion: 'us-east-1' }
    );
    expect(out.env).toEqual({});
    expect(out.audit.resolvedKeys).toEqual([]);
    expect(out.audit.unresolved.map((u) => u.key).sort()).toEqual(['IMPORT', 'OUTPUT']);
  });

  it('still resolves Ref / Fn::GetAtt / Fn::Sub / Fn::Join entries (sync path coverage)', async () => {
    const resources: Record<string, ResourceState> = {
      MyTable: res('real-table-name', { Arn: 'arn:test' }),
    };
    const out = await substituteEnvVarsFromStateAsync(
      {
        REF: { Ref: 'MyTable' },
        GETATT: { 'Fn::GetAtt': ['MyTable', 'Arn'] },
        SUB: { 'Fn::Sub': 'prefix-${MyTable}' },
        JOIN: { 'Fn::Join': ['/', ['a', { Ref: 'MyTable' }]] },
      },
      { resources }
    );
    expect(out.env).toEqual({
      REF: 'real-table-name',
      GETATT: 'arn:test',
      SUB: 'prefix-real-table-name',
      JOIN: 'a/real-table-name',
    });
    expect(out.audit.unresolved).toEqual([]);
  });
});
