import { describe, it, expect, vi } from 'vitest';
import {
  filterTemplateForImport,
  hasCompositeIdSplitter,
  injectDeletionPolicyForImport,
  isNeverImportableType,
  isPhase2CreatableType,
  parseParameterOverrides,
  refuseTransientContextIfUnsafe,
  reportDriftBaselineGaps,
  resolveTemplateParameters,
  scanCrossStackReferences,
  splitCompositePhysicalId,
} from '../../../src/cli/commands/export.js';

describe('refuseTransientContextIfUnsafe', () => {
  it('passes through when no context overrides are supplied', () => {
    expect(() =>
      refuseTransientContextIfUnsafe({ acceptTransientContext: false })
    ).not.toThrow();
    expect(() =>
      refuseTransientContextIfUnsafe({ context: [], acceptTransientContext: false })
    ).not.toThrow();
  });

  it('refuses when CLI -c overrides are supplied without the escape hatch', () => {
    expect(() =>
      refuseTransientContextIfUnsafe({
        context: ['env=prod'],
        acceptTransientContext: false,
      })
    ).toThrow(/Refusing to export/);
  });

  it('includes every override in the refusal message', () => {
    let thrown: Error | undefined;
    try {
      refuseTransientContextIfUnsafe({
        context: ['env=prod', 'region=us-east-1'],
        acceptTransientContext: false,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('-c env=prod');
    expect(thrown!.message).toContain('-c region=us-east-1');
  });

  it('proceeds with --accept-transient-context (does not throw)', () => {
    expect(() =>
      refuseTransientContextIfUnsafe({
        context: ['env=prod'],
        acceptTransientContext: true,
      })
    ).not.toThrow();
  });
});

describe('isNeverImportableType', () => {
  it('flags AWS::CDK::Metadata', () => {
    expect(isNeverImportableType('AWS::CDK::Metadata')).toBe(true);
  });

  it('flags nested stacks', () => {
    expect(isNeverImportableType('AWS::CloudFormation::Stack')).toBe(true);
  });

  it('flags every Custom::* type', () => {
    expect(isNeverImportableType('Custom::MyHandler')).toBe(true);
    expect(isNeverImportableType('Custom::SomethingElse')).toBe(true);
  });

  it('flags AWS::CloudFormation::CustomResource (untyped cdk.CustomResource)', () => {
    // CDK emits this type when `new cdk.CustomResource(...)` is constructed
    // without a `resourceType` property. AWS rejects it from IMPORT changesets
    // for the same reason it rejects Custom::*.
    expect(isNeverImportableType('AWS::CloudFormation::CustomResource')).toBe(true);
  });

  it('does NOT flag common importable types', () => {
    expect(isNeverImportableType('AWS::S3::Bucket')).toBe(false);
    expect(isNeverImportableType('AWS::IAM::Role')).toBe(false);
    expect(isNeverImportableType('AWS::Lambda::Function')).toBe(false);
    expect(isNeverImportableType('AWS::DynamoDB::Table')).toBe(false);
  });
});

describe('filterTemplateForImport', () => {
  it('keeps only resources in the plan', () => {
    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        KeepMe: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b' } },
        DropMe: { Type: 'AWS::CDK::Metadata', Properties: {} },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'KeepMe', resourceType: 'AWS::S3::Bucket', physicalId: 'b', resourceIdentifier: { BucketName: 'b' } },
    ]);
    expect(result['Resources']).toEqual({
      KeepMe: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b' } },
    });
  });

  it('overlays ResourceIdentifier values onto Properties (CFn IMPORT identifier match)', () => {
    // cdkd deploy prefixes user-declared names with the stack name, so
    // the synth template's Properties.RoleName is the unprefixed
    // value while ResourceIdentifier (built from cdkd state's
    // physicalId) carries the prefixed value. CFn IMPORT rejects the
    // changeset when these disagree, so filterTemplateForImport
    // overlays the prefixed identifier onto Properties.
    const template = {
      Resources: {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: {
            RoleName: 'user-declared-name',
            Description: 'unchanged',
          },
        },
      },
    };
    const result = filterTemplateForImport(template, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'MyStack-user-declared-name',
        resourceIdentifier: { RoleName: 'MyStack-user-declared-name' },
      },
    ]);
    const role = (result['Resources'] as Record<string, Record<string, unknown>>)['Role']!;
    const properties = role['Properties'] as Record<string, unknown>;
    expect(properties['RoleName']).toBe('MyStack-user-declared-name');
    expect(properties['Description']).toBe('unchanged');
  });

  it('overlays composite identifiers (every field)', () => {
    const template = {
      Resources: {
        Method: {
          Type: 'AWS::ApiGateway::Method',
          Properties: { RestApiId: 'old', ResourceId: 'old', HttpMethod: 'old' },
        },
      },
    };
    const result = filterTemplateForImport(template, [
      {
        logicalId: 'Method',
        resourceType: 'AWS::ApiGateway::Method',
        physicalId: 'api123|res456|GET',
        resourceIdentifier: { RestApiId: 'api123', ResourceId: 'res456', HttpMethod: 'GET' },
      },
    ]);
    const method = (result['Resources'] as Record<string, Record<string, unknown>>)['Method']!;
    expect(method['Properties']).toEqual({
      RestApiId: 'api123',
      ResourceId: 'res456',
      HttpMethod: 'GET',
    });
  });

  it('creates a Properties object on resources that had none', () => {
    const template = {
      Resources: { Bare: { Type: 'AWS::S3::Bucket' } },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Bare', resourceType: 'AWS::S3::Bucket', physicalId: 'b', resourceIdentifier: { BucketName: 'b' } },
    ]);
    expect((result['Resources'] as Record<string, Record<string, unknown>>)['Bare']!['Properties']).toEqual({
      BucketName: 'b',
    });
  });

  it('preserves top-level keys other than Resources/Outputs', () => {
    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'test',
      Parameters: { P: { Type: 'String' } },
      Resources: {
        A: { Type: 'AWS::S3::Bucket' },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'A', resourceType: 'AWS::S3::Bucket', physicalId: 'b', resourceIdentifier: { BucketName: 'b' } },
    ]);
    expect(result['AWSTemplateFormatVersion']).toBe('2010-09-09');
    expect(result['Description']).toBe('test');
    expect(result['Parameters']).toEqual({ P: { Type: 'String' } });
  });

  it('strips Outputs entirely (CFn IMPORT changeset rejects any Outputs)', () => {
    // CloudFormation IMPORT rejects the changeset with "As part of the
    // import operation, you cannot modify or add [Outputs]", regardless
    // of whether the Outputs reference imported or excluded resources.
    // Phase 2 UPDATE re-submits the full synth template and restores
    // Outputs along with the non-importable resources.
    const template = {
      Resources: {
        Keep: { Type: 'AWS::S3::Bucket' },
        Drop: { Type: 'Custom::Foo' },
      },
      Outputs: {
        // Even an Output that only references the imported resource
        // must be stripped — AWS rejects ANY Outputs on IMPORT.
        KeepOut: { Value: { Ref: 'Keep' } },
        DropOut: { Value: { Ref: 'Drop' } },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', resourceIdentifier: { BucketName: 'b' } },
    ]);
    expect('Outputs' in result).toBe(false);
  });

  it('strips Outputs even when none reference any resource', () => {
    const template = {
      Resources: { Keep: { Type: 'AWS::S3::Bucket' } },
      Outputs: { StaticOut: { Value: 'plain-string' } },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', resourceIdentifier: { BucketName: 'b' } },
    ]);
    expect('Outputs' in result).toBe(false);
  });

  it('leaves the result without an Outputs key when template has none', () => {
    const template = {
      Resources: { Keep: { Type: 'AWS::S3::Bucket' } },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', resourceIdentifier: { BucketName: 'b' } },
    ]);
    expect('Outputs' in result).toBe(false);
  });
});

describe('hasCompositeIdSplitter', () => {
  it('reports the registered composite types', () => {
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Method')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Resource')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::EC2::VPCGatewayAttachment')).toBe(true);
  });

  it('returns false for single-key types', () => {
    expect(hasCompositeIdSplitter('AWS::S3::Bucket')).toBe(false);
    expect(hasCompositeIdSplitter('AWS::Lambda::Function')).toBe(false);
  });

  it('returns false for unknown / unregistered types', () => {
    expect(hasCompositeIdSplitter('AWS::Made::Up::Type')).toBe(false);
  });
});

describe('splitCompositePhysicalId', () => {
  it('parses AWS::ApiGateway::Method (restApiId|resourceId|httpMethod)', () => {
    expect(splitCompositePhysicalId('AWS::ApiGateway::Method', 'api123|res456|GET')).toEqual({
      RestApiId: 'api123',
      ResourceId: 'res456',
      HttpMethod: 'GET',
    });
  });

  it('parses AWS::ApiGateway::Resource (restApiId|resourceId)', () => {
    expect(splitCompositePhysicalId('AWS::ApiGateway::Resource', 'api123|res456')).toEqual({
      RestApiId: 'api123',
      ResourceId: 'res456',
    });
  });

  it('reorders AWS::EC2::VPCGatewayAttachment (cdkd: IGW|VpcId → CFn: {VpcId, InternetGatewayId})', () => {
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'igw-abc|vpc-xyz')
    ).toEqual({
      VpcId: 'vpc-xyz',
      InternetGatewayId: 'igw-abc',
    });
  });

  it('throws on wrong part count for ApiGateway::Method', () => {
    expect(() => splitCompositePhysicalId('AWS::ApiGateway::Method', 'only-two|parts')).toThrow(
      /expected 3 parts/
    );
  });

  it('throws on wrong part count for ApiGateway::Resource', () => {
    expect(() => splitCompositePhysicalId('AWS::ApiGateway::Resource', 'one-part')).toThrow(
      /expected 2 parts/
    );
  });

  it('throws on wrong part count for VPCGatewayAttachment', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'three|parts|here')
    ).toThrow(/expected 2 parts/);
  });

  it('throws on unregistered type', () => {
    expect(() => splitCompositePhysicalId('AWS::Made::Up::Type', 'whatever')).toThrow(
      /no composite-id splitter registered/
    );
  });
});

describe('isPhase2CreatableType', () => {
  it('matches every Custom::* type (CFn CREATEs in phase 2)', () => {
    expect(isPhase2CreatableType('Custom::MyHandler')).toBe(true);
    expect(isPhase2CreatableType('Custom::SomethingElse')).toBe(true);
    expect(isPhase2CreatableType('Custom::AWSCDKOpenIdConnectProvider')).toBe(true);
  });

  it('matches AWS::CloudFormation::CustomResource (untyped cdk.CustomResource)', () => {
    // `new cdk.CustomResource(...)` without `resourceType` synthesizes to
    // this CFn resource type. Functionally identical to Custom::* — Lambda-
    // backed, no AWS resource state — so it also goes through phase 2.
    expect(isPhase2CreatableType('AWS::CloudFormation::CustomResource')).toBe(true);
  });

  it('does NOT match AWS::CloudFormation::Stack (nested stacks stay blocked)', () => {
    // Nested stack import would create a duplicate, so it is intentionally
    // NOT in the phase-2 set. PR3 verifies this stays blocked.
    expect(isPhase2CreatableType('AWS::CloudFormation::Stack')).toBe(false);
  });

  it('does NOT match importable resource types', () => {
    expect(isPhase2CreatableType('AWS::S3::Bucket')).toBe(false);
    expect(isPhase2CreatableType('AWS::Lambda::Function')).toBe(false);
    expect(isPhase2CreatableType('AWS::IAM::Role')).toBe(false);
  });

  it('does NOT match AWS::CDK::Metadata (silent-drop, not phase 2)', () => {
    expect(isPhase2CreatableType('AWS::CDK::Metadata')).toBe(false);
  });
});

describe('injectDeletionPolicyForImport', () => {
  it('adds DeletionPolicy: Retain on resources lacking the attribute', () => {
    const template: Record<string, unknown> = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        Topic: { Type: 'AWS::SNS::Topic', Properties: {} },
      },
    };
    const injected = injectDeletionPolicyForImport(template);
    expect(injected).toBe(2);
    expect((template['Resources'] as Record<string, Record<string, unknown>>)['Role']!['DeletionPolicy']).toBe('Retain');
    expect((template['Resources'] as Record<string, Record<string, unknown>>)['Topic']!['DeletionPolicy']).toBe('Retain');
  });

  it('preserves resources that already declare DeletionPolicy (any value)', () => {
    const template: Record<string, unknown> = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {}, DeletionPolicy: 'Delete' },
        Snapshot: { Type: 'AWS::RDS::DBInstance', Properties: {}, DeletionPolicy: 'Snapshot' },
        Existing: { Type: 'AWS::IAM::Role', Properties: {}, DeletionPolicy: 'Retain' },
      },
    };
    const injected = injectDeletionPolicyForImport(template);
    expect(injected).toBe(0);
    const resources = template['Resources'] as Record<string, Record<string, unknown>>;
    expect(resources['Bucket']!['DeletionPolicy']).toBe('Delete');
    expect(resources['Snapshot']!['DeletionPolicy']).toBe('Snapshot');
    expect(resources['Existing']!['DeletionPolicy']).toBe('Retain');
  });

  it('does NOT inject UpdateReplacePolicy (only DeletionPolicy required by IMPORT)', () => {
    const template: Record<string, unknown> = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
      },
    };
    injectDeletionPolicyForImport(template);
    expect(
      (template['Resources'] as Record<string, Record<string, unknown>>)['Role']!['UpdateReplacePolicy']
    ).toBeUndefined();
  });

  it('handles a mix of missing + present DeletionPolicy entries', () => {
    const template: Record<string, unknown> = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {}, DeletionPolicy: 'Delete' },
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        Topic: { Type: 'AWS::SNS::Topic', Properties: {} },
      },
    };
    const injected = injectDeletionPolicyForImport(template);
    expect(injected).toBe(2);
    const resources = template['Resources'] as Record<string, Record<string, unknown>>;
    expect(resources['Bucket']!['DeletionPolicy']).toBe('Delete');
    expect(resources['Role']!['DeletionPolicy']).toBe('Retain');
    expect(resources['Topic']!['DeletionPolicy']).toBe('Retain');
  });

  it('returns 0 for a template with no Resources section', () => {
    const template: Record<string, unknown> = { AWSTemplateFormatVersion: '2010-09-09' };
    expect(injectDeletionPolicyForImport(template)).toBe(0);
  });

  it('returns 0 for an empty Resources object', () => {
    const template: Record<string, unknown> = { Resources: {} };
    expect(injectDeletionPolicyForImport(template)).toBe(0);
  });
});

describe('parseParameterOverrides', () => {
  it('returns empty map for undefined / empty input', () => {
    expect(parseParameterOverrides(undefined)).toEqual({});
    expect(parseParameterOverrides([])).toEqual({});
  });

  it('parses Key=Value tokens', () => {
    expect(parseParameterOverrides(['Env=prod', 'Region=us-east-1'])).toEqual({
      Env: 'prod',
      Region: 'us-east-1',
    });
  });

  it('preserves Value content including embedded "="', () => {
    expect(parseParameterOverrides(['Equation=x=y+z'])).toEqual({ Equation: 'x=y+z' });
  });

  it('rejects tokens without "="', () => {
    expect(() => parseParameterOverrides(['Bare'])).toThrow(/expected 'Key=Value'/);
  });

  it('rejects tokens with empty key', () => {
    expect(() => parseParameterOverrides(['=value'])).toThrow(/expected 'Key=Value'/);
  });
});

describe('resolveTemplateParameters', () => {
  it('returns empty array when template has no Parameters section', () => {
    const result = resolveTemplateParameters({ Resources: {} }, {});
    expect(result).toEqual({ parameters: [], missing: [] });
  });

  it('uses defaults when no overrides supplied', () => {
    const tpl = {
      Parameters: {
        Env: { Type: 'String', Default: 'dev' },
        BootstrapVersion: { Type: 'String', Default: '12' },
      },
    };
    const result = resolveTemplateParameters(tpl, {});
    expect(result.missing).toEqual([]);
    expect(result.parameters).toEqual([
      { ParameterKey: 'Env', ParameterValue: 'dev' },
      { ParameterKey: 'BootstrapVersion', ParameterValue: '12' },
    ]);
  });

  it('user override beats template Default', () => {
    const tpl = { Parameters: { Env: { Type: 'String', Default: 'dev' } } };
    const result = resolveTemplateParameters(tpl, { Env: 'prod' });
    expect(result.parameters).toEqual([{ ParameterKey: 'Env', ParameterValue: 'prod' }]);
  });

  it('coerces non-string defaults to string', () => {
    const tpl = { Parameters: { Count: { Type: 'Number', Default: 5 } } };
    const result = resolveTemplateParameters(tpl, {});
    expect(result.parameters).toEqual([{ ParameterKey: 'Count', ParameterValue: '5' }]);
  });

  it('reports parameters without defaults as missing when no override', () => {
    const tpl = {
      Parameters: {
        Required: { Type: 'String' },
        Optional: { Type: 'String', Default: 'x' },
      },
    };
    const result = resolveTemplateParameters(tpl, {});
    expect(result.missing).toEqual(['Required']);
    expect(result.parameters).toEqual([{ ParameterKey: 'Optional', ParameterValue: 'x' }]);
  });

  it('user override satisfies a parameter without Default', () => {
    const tpl = { Parameters: { Required: { Type: 'String' } } };
    const result = resolveTemplateParameters(tpl, { Required: 'set' });
    expect(result.missing).toEqual([]);
    expect(result.parameters).toEqual([{ ParameterKey: 'Required', ParameterValue: 'set' }]);
  });

  it('throws when an override targets a parameter not in the template', () => {
    const tpl = { Parameters: { Env: { Type: 'String', Default: 'dev' } } };
    expect(() => resolveTemplateParameters(tpl, { Typo: 'oops' })).toThrow(
      /does not match any parameter/
    );
  });

  it('throws when overrides supplied but template has no Parameters section', () => {
    expect(() => resolveTemplateParameters({ Resources: {} }, { Env: 'prod' })).toThrow(
      /template has no Parameters section/
    );
  });
});

describe('scanCrossStackReferences', () => {
  it('returns empty when no other stacks reference the target', () => {
    const stacks = [
      { stackName: 'Exporting', template: { Resources: {} } },
      { stackName: 'Other', template: { Resources: { R: { Type: 'AWS::S3::Bucket' } } } },
    ];
    expect(scanCrossStackReferences(stacks, 'Exporting')).toEqual([]);
  });

  it('finds object-form Fn::GetStackOutput in another stack', () => {
    const stacks = [
      { stackName: 'Exporting', template: { Resources: {} } },
      {
        stackName: 'Consumer',
        template: {
          Resources: {
            Lambda: {
              Type: 'AWS::Lambda::Function',
              Properties: {
                Environment: {
                  Variables: {
                    PROD_URL: {
                      'Fn::GetStackOutput': { StackName: 'Exporting', OutputName: 'ApiUrl' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ];
    const result = scanCrossStackReferences(stacks, 'Exporting');
    expect(result).toHaveLength(1);
    expect(result[0]!.consumerStackName).toBe('Consumer');
    expect(result[0]!.outputName).toBe('ApiUrl');
  });

  it('finds legacy array-form Fn::GetStackOutput', () => {
    const stacks = [
      { stackName: 'Exporting', template: {} },
      {
        stackName: 'Consumer',
        template: { Outputs: { X: { Value: { 'Fn::GetStackOutput': ['Exporting', 'Out'] } } } },
      },
    ];
    const result = scanCrossStackReferences(stacks, 'Exporting');
    expect(result).toHaveLength(1);
    expect(result[0]!.outputName).toBe('Out');
  });

  it('does NOT flag references to OTHER stacks', () => {
    const stacks = [
      { stackName: 'Exporting', template: {} },
      {
        stackName: 'Consumer',
        template: {
          Resources: {
            R: {
              Properties: {
                X: { 'Fn::GetStackOutput': { StackName: 'NotMe', OutputName: 'Y' } },
              },
            },
          },
        },
      },
    ];
    expect(scanCrossStackReferences(stacks, 'Exporting')).toEqual([]);
  });

  it('ignores the exporting stack itself', () => {
    const stacks = [
      {
        stackName: 'Exporting',
        template: {
          Resources: {
            R: {
              Properties: {
                X: { 'Fn::GetStackOutput': { StackName: 'Exporting', OutputName: 'Y' } },
              },
            },
          },
        },
      },
    ];
    expect(scanCrossStackReferences(stacks, 'Exporting')).toEqual([]);
  });

  it('captures all references when multiple consumers exist', () => {
    const stacks = [
      { stackName: 'Exporting', template: {} },
      {
        stackName: 'C1',
        template: {
          Resources: {
            R: {
              Properties: { X: { 'Fn::GetStackOutput': { StackName: 'Exporting', OutputName: 'A' } } },
            },
          },
        },
      },
      {
        stackName: 'C2',
        template: {
          Outputs: { O: { Value: { 'Fn::GetStackOutput': { StackName: 'Exporting', OutputName: 'B' } } } },
        },
      },
    ];
    const result = scanCrossStackReferences(stacks, 'Exporting');
    expect(result).toHaveLength(2);
    const summary = result.map((r) => `${r.consumerStackName}.${r.outputName}`).sort();
    expect(summary).toEqual(['C1.A', 'C2.B']);
  });
});

describe('reportDriftBaselineGaps', () => {
  function makeLogger() {
    return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
  }

  it('warns nothing when every resource has observedProperties', () => {
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 3,
        stackName: 'S',
        region: 'us-east-1',
        resources: {
          R1: { physicalId: 'p1', resourceType: 'AWS::S3::Bucket', properties: {}, observedProperties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns nothing for an empty state', () => {
    const logger = makeLogger();
    reportDriftBaselineGaps(
      { version: 3, stackName: 'S', region: 'r', resources: {}, outputs: {}, lastModified: 0 },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns about schema version 1/2 (pre-observedProperties)', () => {
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 2,
        stackName: 'S',
        region: 'r',
        resources: { R1: { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/schema is v2/);
  });

  it('warns about per-resource missing observedProperties at v3', () => {
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 3,
        stackName: 'S',
        region: 'r',
        resources: {
          R1: { physicalId: 'p1', resourceType: 'AWS::S3::Bucket', properties: {}, observedProperties: {} },
          R2: { physicalId: 'p2', resourceType: 'Custom::X', properties: {} }, // no observedProperties
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    // 1 summary warn + 1 per-resource warn
    expect(logger.warn).toHaveBeenCalled();
    const calls = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(calls).toMatch(/1 of 2 resource\(s\)/);
    expect(calls).toMatch(/R2/);
  });
});
