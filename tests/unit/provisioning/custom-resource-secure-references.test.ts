/**
 * go-to-k/cdkd#3976: CloudFormation does not support SECURE dynamic references
 * (`secretsmanager` / `ssm-secure`) in custom resources, so the template path
 * refuses them pre-flight. The rule module, then the registry wiring the deploy
 * engine's pre-flight calls.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  findSecureReferencePaths,
  isCustomResourceType,
} from '../../../src/provisioning/custom-resource-secure-references.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

const SM = '{{resolve:secretsmanager:my-secret:SecretString:password}}';
const SSM_SECURE = '{{resolve:ssm-secure:/app/password}}';
const SSM_PLAIN = '{{resolve:ssm:/app/endpoint}}';

describe('isCustomResourceType', () => {
  it.each([
    ['AWS::CloudFormation::CustomResource', true],
    ['Custom::Anything', true],
    ['AWS::Lambda::Function', false],
    ['AWS::SSM::Parameter', false],
  ])('%s -> %s', (type, expected) => {
    expect(isCustomResourceType(type)).toBe(expected);
  });
});

describe('findSecureReferencePaths', () => {
  it('names the path of each secure reference, secretsmanager and ssm-secure alike', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', {
        ServiceToken: 'arn:aws:lambda:us-east-1:111122223333:function:h',
        Password: SM,
        Nested: { Items: ['plain', SSM_SECURE] },
      })
    ).toEqual(['Password', 'Nested.Items[1]']);
  });

  it('refuses the SAME-STACK CDK shape: a token split around its Ref across Fn::Join parts', () => {
    // What `secret.secretValueFromJson('password')` synthesizes for a Secret in
    // the same stack; no single string holds a complete token.
    expect(
      findSecureReferencePaths('Custom::Thing', {
        Password: {
          'Fn::Join': [
            '',
            ['{{resolve:secretsmanager:', { Ref: 'Sec2765B176' }, ':SecretString:password::}}'],
          ],
        },
      })
    ).toEqual(['Password']);
  });

  it('refuses the split ssm-secure shape (SecretValue.ssmSecure with a token name)', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', {
        Pin: { 'Fn::Join': ['', ['{{resolve:ssm-secure:', { Ref: 'ParamName' }, '}}']] },
      })
    ).toEqual(['Pin']);
  });

  it('refuses an Fn::Sub spelling with a ${...} inside the token, and a substituted service', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', {
        A: { 'Fn::Sub': '{{resolve:secretsmanager:${Secret}:SecretString:password::}}' },
        B: { 'Fn::Sub': ['{{resolve:ssm-secure:${Name}}}', { Name: '/app/pw' }] },
        C: { 'Fn::Sub': '{{resolve:${Svc}:/app/pw}}' },
      })
    ).toEqual(['A', 'B', 'C']);
  });

  it('accepts a plain ssm opener split across Fn::Join parts', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', {
        Endpoint: { 'Fn::Join': ['', ['{{resolve:ssm:', { Ref: 'ParamName' }, '}}']] },
      })
    ).toEqual([]);
  });

  it('reports a property once however many secure parts it holds', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', {
        Conn: { 'Fn::Join': [':', [SM, 'x', SSM_SECURE]] },
      })
    ).toEqual(['Conn']);
  });

  it('checks every token of a leaf, not only the first', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', { Mixed: `${SSM_PLAIN}${SM}` })
    ).toEqual(['Mixed']);
  });

  it('names a whole-intrinsic Properties block when no property name applies', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', {
        'Fn::If': ['Cond', { Password: SM }, { Password: 'x' }],
      })
    ).toEqual(['(Properties)']);
  });

  it('reports an object shared by two properties under both paths', () => {
    const shared = { Secret: SM };
    expect(findSecureReferencePaths('Custom::Thing', { A: shared, B: shared })).toEqual([
      'A.Secret',
      'B.Secret',
    ]);
  });

  it('finds a token inside an intrinsic (a literal-named secret in an Fn::Join part)', () => {
    expect(
      findSecureReferencePaths('AWS::CloudFormation::CustomResource', {
        ConnectionString: { 'Fn::Join': ['', ['user:', SM, '@host']] },
      })
    ).toEqual(['ConnectionString']);
  });

  it('finds an embedded token and the ServiceToken itself', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', {
        ServiceToken: SM,
        Header: `Bearer ${SSM_SECURE}`,
      })
    ).toEqual(['ServiceToken', 'Header']);
  });

  it('accepts a PLAIN ssm reference, which CloudFormation supports in custom resources', () => {
    expect(findSecureReferencePaths('Custom::Thing', { Endpoint: SSM_PLAIN })).toEqual([]);
  });

  it('ignores a secure reference on a type that is not a custom resource', () => {
    expect(findSecureReferencePaths('AWS::RDS::DBInstance', { MasterUserPassword: SM })).toEqual(
      []
    );
  });

  it('ignores an unterminated opener OUTSIDE an intrinsic, and survives undefined properties and cycles', () => {
    expect(
      findSecureReferencePaths('Custom::Thing', { Value: '{{resolve:secretsmanager:x' })
    ).toEqual([]);
    expect(findSecureReferencePaths('Custom::Thing', undefined)).toEqual([]);
    const cyclic: Record<string, unknown> = { A: SM };
    cyclic['Self'] = cyclic;
    expect(findSecureReferencePaths('Custom::Thing', cyclic)).toEqual(['A']);
  });
});

function makeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  (registry as unknown as { logger: Record<string, unknown> }).logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  return registry;
}

describe('ProviderRegistry.validateResourceProperties refuses a secure reference in a custom resource', () => {
  it('throws one aggregated error naming every offending resource and path, never the reference', () => {
    let message = '';
    try {
      makeRegistry().validateResourceProperties([
        {
          logicalId: 'DbInit',
          resourceType: 'Custom::DbInit',
          properties: { Password: SM, Other: SSM_SECURE },
        },
        {
          logicalId: 'Seeder',
          resourceType: 'AWS::CloudFormation::CustomResource',
          properties: { ServiceToken: SSM_SECURE },
        },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DbInit: Password, Other');
    expect(message).toContain('Seeder: ServiceToken');
    expect(message).toContain(
      'CloudFormation does not support secure dynamic references in custom resources'
    );
    expect(message).not.toContain('my-secret');
    expect(message).not.toContain('/app/password');
  });

  it('accepts a custom resource with a plain ssm reference, and any other type', () => {
    expect(() =>
      makeRegistry().validateResourceProperties([
        { logicalId: 'Cr', resourceType: 'Custom::Thing', properties: { Endpoint: SSM_PLAIN } },
        {
          logicalId: 'Db',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Type: 'String', Value: SM },
        },
      ])
    ).not.toThrow();
  });
});
