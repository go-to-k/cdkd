import { describe, expect, it } from 'vitest';
import {
  substituteAgainstState,
  substituteEnvVarsFromState,
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

  it('reports unresolved for unsupported intrinsics (Fn::Join, Fn::ImportValue, etc.)', () => {
    const r1 = substituteAgainstState({ 'Fn::Join': ['', ['a', 'b']] }, {});
    expect(r1.kind).toBe('unresolved');
    if (r1.kind === 'unresolved') {
      expect(r1.reason).toContain("Fn::Join");
    }

    const r2 = substituteAgainstState({ 'Fn::ImportValue': 'OtherStackExport' }, {});
    expect(r2.kind).toBe('unresolved');

    const r3 = substituteAgainstState({ 'Fn::Select': [0, ['a', 'b']] }, {});
    expect(r3.kind).toBe('unresolved');
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
        UNSUPPORTED: { 'Fn::Join': ['', ['a', 'b']] },
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
