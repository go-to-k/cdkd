import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyImportOverlayForPhase2,
  filterTemplateForImport,
  hasCompositeIdSplitter,
  injectDeletionPolicyForImport,
  invokePreDeleteHandler,
  isImportUnsupportedRecreatableType,
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

  it('uses propertiesOverlay (narrow subset) when set, NOT the full resourceIdentifier', () => {
    // AWS::ApiGatewayV2::Integration's primaryIdentifier is [ApiId, IntegrationId],
    // but IntegrationId is tagged readOnlyProperties in the CFn schema (it's
    // AWS-generated, not user-writable). CFn rejects writing read-only
    // properties at changeset-create time. So the splitter narrows
    // propertiesOverlay to just { ApiId }. resourceIdentifier sent to CFn's
    // ResourcesToImport[].ResourceIdentifier still contains both fields.
    const template = {
      Resources: {
        Integration: {
          Type: 'AWS::ApiGatewayV2::Integration',
          Properties: { ApiId: { Ref: 'MyApi' }, IntegrationType: 'AWS_PROXY' },
        },
      },
    };
    const result = filterTemplateForImport(template, [
      {
        logicalId: 'Integration',
        resourceType: 'AWS::ApiGatewayV2::Integration',
        physicalId: 'integ-abc',
        resourceIdentifier: { ApiId: 'api-xyz', IntegrationId: 'integ-abc' },
        propertiesOverlay: { ApiId: 'api-xyz' },
      },
    ]);
    const integration = (result['Resources'] as Record<string, Record<string, unknown>>)[
      'Integration'
    ]!;
    const properties = integration['Properties'] as Record<string, unknown>;
    expect(properties['ApiId']).toBe('api-xyz');
    // IntegrationId MUST NOT leak into Properties (would cause CFn rejection).
    expect(properties).not.toHaveProperty('IntegrationId');
    // Other Properties preserved.
    expect(properties['IntegrationType']).toBe('AWS_PROXY');
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

describe('applyImportOverlayForPhase2', () => {
  // Closes the silent-REPLACE bug discovered via cdk-sample dogfooding
  // 2026-05-12: cdkd export's phase-2 UPDATE used the raw synth template
  // (no overlay), so CFn saw `Properties.RoleName: 'CdkSampleStack-X'`
  // (from phase-1 overlay) → `Properties.RoleName: (absent)` (raw synth)
  // and replaced every imported resource whose Name is immutable.

  it('overlays Name properties on phase-1 imports (mirrors filterTemplateForImport)', () => {
    // The CDK code did not set RoleName; synth template has no RoleName
    // on the resource. cdkd state has the auto-generated prefixed name
    // as physicalId. Phase-2 template must surface that name in
    // Properties.RoleName so CFn doesn't see "Name removal" vs the
    // phase-1 IMPORT'd state.
    const synth = {
      Resources: {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
      },
    };
    const result = applyImportOverlayForPhase2(synth, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'CdkSampleStack-Role',
        resourceIdentifier: { RoleName: 'CdkSampleStack-Role' },
      },
    ]);
    const role = (result['Resources'] as Record<string, Record<string, unknown>>)['Role']!;
    const properties = role['Properties'] as Record<string, unknown>;
    expect(properties['RoleName']).toBe('CdkSampleStack-Role');
    // Existing Properties preserved
    expect(properties['AssumeRolePolicyDocument']).toEqual({
      Version: '2012-10-17',
      Statement: [],
    });
  });

  it('does NOT touch resources outside phase1Imports (phase-2 CREATE / recreate stay raw)', () => {
    // Custom Resources go through phase-2 CREATE from raw synth; recreate-
    // before-phase-2 entries (Stage / IAM::Policy) are deleted from AWS
    // and CFn re-CREATEs from raw synth. Neither should have overlay
    // applied — they have no "phase-1 import'd state" to keep consistent.
    const synth = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        CR: {
          Type: 'Custom::S3AutoDeleteObjects',
          Properties: { ServiceToken: 'arn:...' },
        },
        Stage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: { StageName: '$default', ApiId: { Ref: 'Api' } },
        },
      },
    };
    const result = applyImportOverlayForPhase2(synth, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'CdkSampleStack-Role',
        resourceIdentifier: { RoleName: 'CdkSampleStack-Role' },
      },
      // CR and Stage are NOT in phase1Imports
    ]);
    const resources = result['Resources'] as Record<string, Record<string, unknown>>;
    expect((resources['Role']!['Properties'] as Record<string, unknown>)['RoleName']).toBe(
      'CdkSampleStack-Role'
    );
    expect(resources['CR']!['Properties']).toEqual({ ServiceToken: 'arn:...' });
    expect(resources['Stage']!['Properties']).toEqual({
      StageName: '$default',
      ApiId: { Ref: 'Api' },
    });
  });

  it('honors propertiesOverlay narrowing (sub-resources do NOT get IntegrationId etc. written)', () => {
    // The phase-1 overlay narrows for sub-resource types whose
    // primaryIdentifier includes a read-only Property (IntegrationId,
    // RouteId, Lambda::Permission's Id). Phase-2 overlay must respect
    // the same narrowing — writing those into Properties would have CFn
    // reject the changeset with "Encountered unsupported property".
    const synth = {
      Resources: {
        Integ: {
          Type: 'AWS::ApiGatewayV2::Integration',
          Properties: { ApiId: { Ref: 'Api' }, IntegrationType: 'AWS_PROXY' },
        },
      },
    };
    const result = applyImportOverlayForPhase2(synth, [
      {
        logicalId: 'Integ',
        resourceType: 'AWS::ApiGatewayV2::Integration',
        physicalId: 'integ-abc',
        resourceIdentifier: { ApiId: 'api-xyz', IntegrationId: 'integ-abc' },
        propertiesOverlay: { ApiId: 'api-xyz' },
      },
    ]);
    const integ = (result['Resources'] as Record<string, Record<string, unknown>>)['Integ']!;
    const properties = integ['Properties'] as Record<string, unknown>;
    expect(properties['ApiId']).toBe('api-xyz');
    // IntegrationId is read-only and must NOT be in Properties
    expect(properties).not.toHaveProperty('IntegrationId');
    expect(properties['IntegrationType']).toBe('AWS_PROXY');
  });

  it('deep-clones the input so the caller can still use the raw synth template', () => {
    // The phase-1 code path also reads from the same synth template
    // (filterTemplateForImport runs separately). Mutating the input
    // here would cross-contaminate.
    const synth = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
      },
    };
    applyImportOverlayForPhase2(synth, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'CdkSampleStack-Role',
        resourceIdentifier: { RoleName: 'CdkSampleStack-Role' },
      },
    ]);
    // Original input untouched
    expect((synth.Resources.Role as { Properties: Record<string, unknown> }).Properties).toEqual(
      {}
    );
  });

  it('preserves Outputs (unlike filterTemplateForImport which strips them)', () => {
    // Phase-2 UPDATE template restores Outputs that phase-1 had to strip
    // (CFn IMPORT rejects Outputs). The overlay function must leave them
    // alone.
    const synth = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
      },
      Outputs: {
        RoleArn: { Value: { 'Fn::GetAtt': ['Role', 'Arn'] } },
      },
    };
    const result = applyImportOverlayForPhase2(synth, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'CdkSampleStack-Role',
        resourceIdentifier: { RoleName: 'CdkSampleStack-Role' },
      },
    ]);
    expect(result['Outputs']).toEqual({
      RoleArn: { Value: { 'Fn::GetAtt': ['Role', 'Arn'] } },
    });
  });

  it('handles template without Resources section gracefully', () => {
    // Defensive: cdkd's executeUpdateChangeSet call site already ensures
    // a Resources section exists, but tolerate the empty case to keep
    // the helper composable.
    const result = applyImportOverlayForPhase2({}, []);
    expect(result).toEqual({});
  });

  it('skips imports whose logicalId is missing from the template (defensive)', () => {
    // Edge case: cdkd state has a resource not in the current synth
    // (e.g. user removed it from CDK code). buildImportPlan would have
    // flagged this earlier, but the overlay helper itself must not crash.
    const synth = {
      Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} } },
    };
    const result = applyImportOverlayForPhase2(synth, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'r',
        resourceIdentifier: { RoleName: 'r' },
      },
      {
        logicalId: 'MissingFromTemplate',
        resourceType: 'AWS::SNS::Topic',
        physicalId: 't',
        resourceIdentifier: { TopicArn: 't' },
      },
    ]);
    const resources = result['Resources'] as Record<string, Record<string, unknown>>;
    expect(resources).toHaveProperty('Role');
    expect(resources).not.toHaveProperty('MissingFromTemplate');
  });
});

describe('hasCompositeIdSplitter', () => {
  it('reports the registered composite types', () => {
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Method')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Resource')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::EC2::VPCGatewayAttachment')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGatewayV2::Integration')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGatewayV2::Route')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::Lambda::Permission')).toBe(true);
    // AWS::ApiGatewayV2::Stage: AWS reports single-key (`Id`), so no splitter
    // is needed AND AWS doesn't support Stage in IMPORT anyway (see export.ts
    // COMPOSITE_ID_SPLITTERS comment block for the follow-up tracking).
    expect(hasCompositeIdSplitter('AWS::ApiGatewayV2::Stage')).toBe(false);
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
      resourceIdentifier: { RestApiId: 'api123', ResourceId: 'res456', HttpMethod: 'GET' },
    });
  });

  it('parses AWS::ApiGateway::Resource (restApiId|resourceId)', () => {
    expect(splitCompositePhysicalId('AWS::ApiGateway::Resource', 'api123|res456')).toEqual({
      resourceIdentifier: { RestApiId: 'api123', ResourceId: 'res456' },
    });
  });

  it('reorders AWS::EC2::VPCGatewayAttachment (cdkd: IGW|VpcId → CFn: {VpcId, InternetGatewayId})', () => {
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'igw-abc|vpc-xyz')
    ).toEqual({
      resourceIdentifier: { VpcId: 'vpc-xyz', InternetGatewayId: 'igw-abc' },
    });
  });

  it('parses AWS::ApiGatewayV2::Integration with ApiId from properties (narrow overlay)', () => {
    // cdkd stores only the secondary id (IntegrationId) in physicalId; ApiId
    // comes from state.properties. Overlay excludes IntegrationId (not a
    // Property of the type — AWS-generated).
    expect(
      splitCompositePhysicalId('AWS::ApiGatewayV2::Integration', 'integ-abc123', {
        ApiId: 'api-xyz',
      })
    ).toEqual({
      resourceIdentifier: { ApiId: 'api-xyz', IntegrationId: 'integ-abc123' },
      propertiesOverlay: { ApiId: 'api-xyz' },
    });
  });

  it('parses AWS::ApiGatewayV2::Route with ApiId from properties (narrow overlay)', () => {
    expect(
      splitCompositePhysicalId('AWS::ApiGatewayV2::Route', 'route-def456', {
        ApiId: 'api-xyz',
      })
    ).toEqual({
      resourceIdentifier: { ApiId: 'api-xyz', RouteId: 'route-def456' },
      propertiesOverlay: { ApiId: 'api-xyz' },
    });
  });

  it('parses AWS::Lambda::Permission with FunctionName from properties (narrow overlay)', () => {
    // CFn schema calls the secondary key `Id` (NOT StatementId). cdkd's
    // physicalId IS the StatementId, which becomes `Id` in CFn's
    // ResourceIdentifier. `Id` is NOT a Property of AWS::Lambda::Permission,
    // so overlay narrows to FunctionName.
    expect(
      splitCompositePhysicalId('AWS::Lambda::Permission', 'MyStatement123', {
        FunctionName: 'my-stack-fn',
      })
    ).toEqual({
      resourceIdentifier: { FunctionName: 'my-stack-fn', Id: 'MyStatement123' },
      propertiesOverlay: { FunctionName: 'my-stack-fn' },
    });
  });

  it('normalizes legacy `<functionArn>|<statementId>` physicalId for AWS::Lambda::Permission', () => {
    // State entries written by the older CC-API path (pre-SDK-provider)
    // store physicalId as `<functionArn>|<statementId>`. The splitter
    // must surface the bare statementId as `Id` so CFn IMPORT's
    // identifier-match compares the correct value against the AWS-current
    // Sid. Mirrors lambda-permission-provider.ts's own normalization.
    expect(
      splitCompositePhysicalId(
        'AWS::Lambda::Permission',
        'arn:aws:lambda:us-east-1:123456789012:function:my-fn|MyStatement123',
        { FunctionName: 'my-stack-fn' }
      )
    ).toEqual({
      resourceIdentifier: { FunctionName: 'my-stack-fn', Id: 'MyStatement123' },
      propertiesOverlay: { FunctionName: 'my-stack-fn' },
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

  it('throws when ApiGwV2 Integration properties lack ApiId (state corruption)', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGatewayV2::Integration', 'integ-abc', {})
    ).toThrow(/missing 'ApiId'/);
  });

  it('throws when ApiGwV2 Route properties lack ApiId (state corruption)', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGatewayV2::Route', 'route-abc', {})
    ).toThrow(/missing 'ApiId'/);
  });

  it('throws when Lambda::Permission properties lack FunctionName (state corruption)', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::Lambda::Permission', 'sid', {})
    ).toThrow(/missing 'FunctionName'/);
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

describe('isImportUnsupportedRecreatableType', () => {
  // Types in IMPORT_UNSUPPORTED_RECREATABLE_TYPES: cdkd skips them from
  // phase-1 IMPORT, deletes the AWS-side resource between phases, and
  // lets CFn re-CREATE in phase 2 (closes cdkd issue #307). Currently
  // only AWS::ApiGatewayV2::Stage qualifies (handlers: [] in the CFn
  // schema). Verified via `aws cloudformation describe-type --type
  // RESOURCE --type-name <T> | jq .handlers`.
  it('matches AWS::ApiGatewayV2::Stage (no IMPORT handler in CFn schema)', () => {
    expect(isImportUnsupportedRecreatableType('AWS::ApiGatewayV2::Stage')).toBe(true);
  });

  it('matches AWS::IAM::Policy (no read/list handler; inline policy has no AWS-side id)', () => {
    // CDK auto-emits this type for L2 grants (ECS Task Execution Role ECR-pull
    // policy, Lambda execution-role inline policies, etc.). Found via real
    // export against cdk-sample on 2026-05-12 — the dry-run plan put it in
    // phase-1 imports, real run would fail at CreateChangeSet.
    expect(isImportUnsupportedRecreatableType('AWS::IAM::Policy')).toBe(true);
  });

  it('does NOT match sibling ApiGwV2 types (they have IMPORT handlers)', () => {
    expect(isImportUnsupportedRecreatableType('AWS::ApiGatewayV2::Api')).toBe(false);
    expect(isImportUnsupportedRecreatableType('AWS::ApiGatewayV2::Integration')).toBe(false);
    expect(isImportUnsupportedRecreatableType('AWS::ApiGatewayV2::Route')).toBe(false);
    expect(isImportUnsupportedRecreatableType('AWS::ApiGatewayV2::Deployment')).toBe(false);
    expect(isImportUnsupportedRecreatableType('AWS::ApiGatewayV2::Authorizer')).toBe(false);
  });

  it('does NOT match AWS::ApiGateway::Stage (v1 Stage has IMPORT handler)', () => {
    expect(isImportUnsupportedRecreatableType('AWS::ApiGateway::Stage')).toBe(false);
  });

  it('does NOT match Custom Resources (those go to phase2Creates, not recreate-before-phase2)', () => {
    expect(isImportUnsupportedRecreatableType('Custom::MyHandler')).toBe(false);
    expect(isImportUnsupportedRecreatableType('AWS::CloudFormation::CustomResource')).toBe(false);
  });

  it('does NOT match standard importable types', () => {
    expect(isImportUnsupportedRecreatableType('AWS::S3::Bucket')).toBe(false);
    expect(isImportUnsupportedRecreatableType('AWS::Lambda::Function')).toBe(false);
  });
});

describe('invokePreDeleteHandler', () => {
  // Each test re-mocks @aws-sdk/client-apigatewayv2 because the handler
  // does a dynamic `import()` inside its body (lazy-init pattern shared
  // with ApiGatewayV2Provider.getClient). vi.doMock + vi.resetModules
  // applied per-test isolates each scenario from the others.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-apigatewayv2');
  });

  it('AWS::ApiGatewayV2::Stage handler calls DeleteStage with ApiId + StageName', async () => {
    const sendCalls: unknown[] = [];
    vi.doMock('@aws-sdk/client-apigatewayv2', () => ({
      ApiGatewayV2Client: class {
        async send(cmd: unknown) {
          sendCalls.push(cmd);
        }
      },
      DeleteStageCommand: class {
        constructor(public input: unknown) {}
      },
      NotFoundException: class extends Error {
        readonly name = 'NotFoundException';
      },
    }));
    // Re-import the module so it picks up the mock.
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await handler('AWS::ApiGatewayV2::Stage', {
      logicalId: 'HttpApiDefaultStage',
      resourceType: 'AWS::ApiGatewayV2::Stage',
      physicalId: '$default',
      properties: { ApiId: 'doptkc8n2i', StageName: '$default' },
    });

    expect(sendCalls).toHaveLength(1);
    const cmd = sendCalls[0] as { input: { ApiId: string; StageName: string } };
    expect(cmd.input.ApiId).toBe('doptkc8n2i');
    expect(cmd.input.StageName).toBe('$default');
  });

  it('throws when ApiId is missing from properties (state corruption)', async () => {
    vi.doMock('@aws-sdk/client-apigatewayv2', () => ({
      ApiGatewayV2Client: class {
        async send() {
          throw new Error('should not reach AWS');
        }
      },
      DeleteStageCommand: class {
        constructor(public input: unknown) {}
      },
      NotFoundException: class extends Error {
        readonly name = 'NotFoundException';
      },
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await expect(
      handler('AWS::ApiGatewayV2::Stage', {
        logicalId: 'HttpApiDefaultStage',
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId: '$default',
        properties: {}, // no ApiId
      })
    ).rejects.toThrow(/missing 'ApiId'/);
  });

  it('throws when ApiId is non-string (state corruption)', async () => {
    vi.doMock('@aws-sdk/client-apigatewayv2', () => ({
      ApiGatewayV2Client: class {
        async send() {
          throw new Error('should not reach AWS');
        }
      },
      DeleteStageCommand: class {
        constructor(public input: unknown) {}
      },
      NotFoundException: class extends Error {
        readonly name = 'NotFoundException';
      },
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await expect(
      handler('AWS::ApiGatewayV2::Stage', {
        logicalId: 'X',
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId: '$default',
        properties: { ApiId: { Ref: 'SomeApi' } }, // unresolved intrinsic
      })
    ).rejects.toThrow(/missing 'ApiId'/);
  });

  it('throws when no handler is registered for the type', async () => {
    await expect(
      invokePreDeleteHandler('AWS::Made::Up::Type', {
        logicalId: 'X',
        resourceType: 'AWS::Made::Up::Type',
        physicalId: 'x',
        properties: {},
      })
    ).rejects.toThrow(/no pre-delete handler registered/);
  });

  it('Stage handler treats NotFoundException as idempotent success (re-run safety)', async () => {
    // If a previous pre-delete attempt partially succeeded and the user
    // re-runs after fixing the underlying failure, the Stage handler MUST
    // tolerate the AWS-side resource being already gone — otherwise the
    // partial-retry path is a permanent foot-gun. AWS returns
    // NotFoundException for both "ApiId not found" and "Stage not found".
    class FakeNotFoundException extends Error {
      readonly $fault = 'client';
      readonly $metadata = {};
      readonly name = 'NotFoundException';
    }
    vi.doMock('@aws-sdk/client-apigatewayv2', () => ({
      ApiGatewayV2Client: class {
        async send() {
          throw new FakeNotFoundException('Stage with name $default does not exist');
        }
      },
      DeleteStageCommand: class {
        constructor(public input: unknown) {}
      },
      NotFoundException: FakeNotFoundException,
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    // Must NOT throw — the goal state (Stage absent) is already achieved.
    await expect(
      handler('AWS::ApiGatewayV2::Stage', {
        logicalId: 'HttpApiDefaultStage',
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId: '$default',
        properties: { ApiId: 'doptkc8n2i' },
      })
    ).resolves.toBeUndefined();
  });

  it('Stage handler propagates non-NotFoundException errors', async () => {
    class FakeAccessDenied extends Error {
      readonly $fault = 'client';
      readonly $metadata = {};
      readonly name = 'AccessDeniedException';
    }
    class FakeNotFoundException extends Error {
      readonly name = 'NotFoundException';
    }
    vi.doMock('@aws-sdk/client-apigatewayv2', () => ({
      ApiGatewayV2Client: class {
        async send() {
          throw new FakeAccessDenied('AccessDenied: not authorized to call DeleteStage');
        }
      },
      DeleteStageCommand: class {
        constructor(public input: unknown) {}
      },
      NotFoundException: FakeNotFoundException,
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await expect(
      handler('AWS::ApiGatewayV2::Stage', {
        logicalId: 'HttpApiDefaultStage',
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId: '$default',
        properties: { ApiId: 'doptkc8n2i' },
      })
    ).rejects.toThrow(/AccessDenied/);
  });

  // ─── AWS::IAM::Policy handler tests ──────────────────────────────
  //
  // Inline policy attachments are per-target (Roles / Users / Groups).
  // The handler walks each target list and issues the appropriate Delete
  // call. NoSuchEntityException is idempotent (matches IAMPolicyProvider.
  // delete in src/provisioning/providers/iam-policy-provider.ts).

  it('AWS::IAM::Policy handler walks Roles and issues DeleteRolePolicy per role', async () => {
    const sendCalls: { cmdName: string; input: Record<string, unknown> }[] = [];
    vi.doMock('@aws-sdk/client-iam', () => ({
      IAMClient: class {
        async send(cmd: { __cmdName: string; input: Record<string, unknown> }) {
          sendCalls.push({ cmdName: cmd.__cmdName, input: cmd.input });
        }
      },
      DeleteRolePolicyCommand: class {
        readonly __cmdName = 'DeleteRolePolicy';
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteUserPolicyCommand: class {
        readonly __cmdName = 'DeleteUserPolicy';
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteGroupPolicyCommand: class {
        readonly __cmdName = 'DeleteGroupPolicy';
        constructor(public input: Record<string, unknown>) {}
      },
      NoSuchEntityException: class extends Error {
        readonly name = 'NoSuchEntityException';
      },
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await handler('AWS::IAM::Policy', {
      logicalId: 'EcrPullPolicy',
      resourceType: 'AWS::IAM::Policy',
      physicalId: 'ecr-pull-policy',
      properties: { Roles: ['RoleA', 'RoleB'] },
    });

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]).toEqual({
      cmdName: 'DeleteRolePolicy',
      input: { RoleName: 'RoleA', PolicyName: 'ecr-pull-policy' },
    });
    expect(sendCalls[1]).toEqual({
      cmdName: 'DeleteRolePolicy',
      input: { RoleName: 'RoleB', PolicyName: 'ecr-pull-policy' },
    });
  });

  it('AWS::IAM::Policy handler walks Users + Groups when set', async () => {
    const sendCalls: { cmdName: string; input: Record<string, unknown> }[] = [];
    vi.doMock('@aws-sdk/client-iam', () => ({
      IAMClient: class {
        async send(cmd: { __cmdName: string; input: Record<string, unknown> }) {
          sendCalls.push({ cmdName: cmd.__cmdName, input: cmd.input });
        }
      },
      DeleteRolePolicyCommand: class {
        readonly __cmdName = 'DeleteRolePolicy';
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteUserPolicyCommand: class {
        readonly __cmdName = 'DeleteUserPolicy';
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteGroupPolicyCommand: class {
        readonly __cmdName = 'DeleteGroupPolicy';
        constructor(public input: Record<string, unknown>) {}
      },
      NoSuchEntityException: class extends Error {
        readonly name = 'NoSuchEntityException';
      },
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await handler('AWS::IAM::Policy', {
      logicalId: 'P',
      resourceType: 'AWS::IAM::Policy',
      physicalId: 'p',
      properties: { Users: ['UserA'], Groups: ['GroupA', 'GroupB'] },
    });

    expect(sendCalls.map((c) => c.cmdName)).toEqual([
      'DeleteUserPolicy',
      'DeleteGroupPolicy',
      'DeleteGroupPolicy',
    ]);
  });

  it('AWS::IAM::Policy handler normalizes legacy `policyName:roleName` physicalId', async () => {
    // Pre-v0.74 state (CC API code path) stored physicalId as
    // `policyName:roleName`. The provider's own delete strips the suffix;
    // the pre-delete handler mirrors that so legacy state still produces
    // the bare policy name as input to DeleteRolePolicy.
    const sendCalls: Record<string, unknown>[] = [];
    vi.doMock('@aws-sdk/client-iam', () => ({
      IAMClient: class {
        async send(cmd: { input: Record<string, unknown> }) {
          sendCalls.push(cmd.input);
        }
      },
      DeleteRolePolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteUserPolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteGroupPolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      NoSuchEntityException: class extends Error {
        readonly name = 'NoSuchEntityException';
      },
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await handler('AWS::IAM::Policy', {
      logicalId: 'P',
      resourceType: 'AWS::IAM::Policy',
      physicalId: 'my-policy:my-role', // legacy CC-API shape
      properties: { Roles: ['my-role'] },
    });

    expect(sendCalls).toEqual([{ RoleName: 'my-role', PolicyName: 'my-policy' }]);
  });

  it('AWS::IAM::Policy handler treats NoSuchEntityException as idempotent success', async () => {
    // After a partial pre-delete retry — some targets succeeded last time,
    // re-running the export hits AWS with "already gone" on those. Must
    // continue, not abort.
    class FakeNoSuchEntity extends Error {
      readonly name = 'NoSuchEntityException';
    }
    let callIndex = 0;
    vi.doMock('@aws-sdk/client-iam', () => ({
      IAMClient: class {
        async send() {
          // Throw on the first send (already-gone Role); second send (live
          // Role) succeeds. The handler must not abort on the first.
          if (callIndex++ === 0) {
            throw new FakeNoSuchEntity('Policy not found on role');
          }
          // success — no return value needed
        }
      },
      DeleteRolePolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteUserPolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteGroupPolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      NoSuchEntityException: FakeNoSuchEntity,
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    // Two Roles: first one returns NoSuchEntity, second one succeeds.
    // The handler must complete without throwing.
    await expect(
      handler('AWS::IAM::Policy', {
        logicalId: 'P',
        resourceType: 'AWS::IAM::Policy',
        physicalId: 'p',
        properties: { Roles: ['AlreadyGoneRole', 'LiveRole'] },
      })
    ).resolves.toBeUndefined();
    expect(callIndex).toBe(2);
  });

  it('AWS::IAM::Policy handler throws when state has no Roles/Users/Groups attachment', async () => {
    // Defensive: state schema invariant says every IAM::Policy has at least
    // one attachment. If state is corrupt and all three arrays are
    // empty/missing, abort with a clear error rather than silently no-op
    // (which would let phase-2 proceed against a still-attached policy).
    vi.doMock('@aws-sdk/client-iam', () => ({
      IAMClient: class {
        async send() {
          throw new Error('should not reach AWS');
        }
      },
      DeleteRolePolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteUserPolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteGroupPolicyCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      NoSuchEntityException: class extends Error {
        readonly name = 'NoSuchEntityException';
      },
    }));
    const { invokePreDeleteHandler: handler } = await import(
      '../../../src/cli/commands/export.js'
    );

    await expect(
      handler('AWS::IAM::Policy', {
        logicalId: 'P',
        resourceType: 'AWS::IAM::Policy',
        physicalId: 'p',
        properties: {}, // no Roles/Users/Groups
      })
    ).rejects.toThrow(/no Roles\/Users\/Groups attachment/);
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
