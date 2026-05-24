import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  applyImportOverlayForPhase2,
  buildCdkdStateStackTree,
  buildImportPlan,
  filterTemplateForImport,
  flattenCdkdStateTreeLeafFirst,
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
  type CdkdStateStackTree,
} from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

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

  it('does NOT flag nested stacks (handled by dedicated branch in buildImportPlan, issue #464 PR B1)', () => {
    // Pre-PR-B1: AWS::CloudFormation::Stack was in NEVER_IMPORTABLE_TYPES so any
    // nested-stack-bearing export aborted at the "block" branch. PR B1 lifts the
    // entry and routes the row through a dedicated branch in `buildImportPlan`
    // that populates `nestedStackRows[]`. The CFn-side `--include-nested-stacks`
    // submission is tracked under PR B2; the orchestrator hard-errors with a
    // PR B2 pointer in the meantime.
    expect(isNeverImportableType('AWS::CloudFormation::Stack')).toBe(false);
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

  it('overlays ResourceIdentifier only on literal-string mismatch (pre-v0.94.0 prefix-on-user-declared-name legacy)', () => {
    // The pre-v0.94.0 default prefixed user-declared physical names with
    // the stack name: user wrote `roleName: 'user-declared-name'` in CDK
    // code; cdkd deploy created `'MyStack-user-declared-name'` on AWS.
    // ResourceIdentifier (from cdkd state's physicalId) carries the
    // prefixed value; Properties.RoleName (from synth) carries the
    // unprefixed value. CFn IMPORT's identifier-match check rejects the
    // changeset when these differ — overlay fixes the conflict.
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

  it('skips overlay when Properties.<NameField> is absent (auto-generated names — issue #319 fix)', () => {
    // The common case for cdkd-deployed stacks: user did NOT declare a
    // physical name in CDK code, so synth omits `Properties.RoleName`
    // entirely. Pre-#319, cdkd injected the cdkd-prefixed name into
    // Properties → post-export `cdk diff` saw `Properties.RoleName:
    // 'CdkSampleStack-...'` (CFn) vs `Properties.RoleName: <absent>`
    // (CDK synth) → proposed REPLACE on every auto-named resource,
    // defeating the "AWS resources unchanged across migration" promise.
    // Post-#319, the overlay is a no-op when the field is absent:
    // matches upstream `cdk import` behavior (Properties passed through,
    // ResourceIdentifier alone identifies the AWS resource).
    const template = {
      Resources: {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
      },
    };
    const result = filterTemplateForImport(template, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'CdkSampleStack-MyRoleF44D44CF',
        resourceIdentifier: { RoleName: 'CdkSampleStack-MyRoleF44D44CF' },
      },
    ]);
    const role = (result['Resources'] as Record<string, Record<string, unknown>>)['Role']!;
    const properties = role['Properties'] as Record<string, unknown>;
    expect(properties).not.toHaveProperty('RoleName');
    expect(properties['AssumeRolePolicyDocument']).toEqual({
      Version: '2012-10-17',
      Statement: [],
    });
  });

  it('skips overlay when Properties.<field> is an intrinsic (composite-id sub-resource — issue #319 fix)', () => {
    // For composite-id sub-resources (Integration / Route / Lambda::Permission /
    // ApiGateway::Method etc.), the parent's identifier is referenced via
    // intrinsic (`{Ref: 'ParentLogicalId'}` or `{Fn::GetAtt: [...]}`). Pre-#319,
    // cdkd overwrote the intrinsic with a literal value from
    // ResourceIdentifier → post-export `cdk diff` saw literal vs intrinsic
    // shape mismatch → proposed REPLACE on every composite sub-resource.
    // Post-#319, intrinsics are preserved (CFn resolves them during
    // changeset processing against the parent's ResourceIdentifier when
    // both are in the same IMPORT changeset).
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
    // Intrinsic preserved (NOT overwritten with literal 'api-xyz')
    expect(properties['ApiId']).toEqual({ Ref: 'MyApi' });
    // IntegrationId MUST NOT leak into Properties (would cause CFn rejection).
    expect(properties).not.toHaveProperty('IntegrationId');
    // Other Properties preserved.
    expect(properties['IntegrationType']).toBe('AWS_PROXY');
  });

  it('overlays composite identifier only on literal-string mismatch', () => {
    // Composite types where every identifier field happens to be a
    // literal-string mismatch in the synth template (rare in practice;
    // CDK normally emits intrinsics for parent-ref fields). All fields
    // get overwritten via the same literal-mismatch rule.
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

  it('creates a Properties object on resources that had none (still skips overlay since field is absent)', () => {
    // Edge case: resource with no Properties section at all. We still
    // produce an empty Properties object for downstream consistency, but
    // we do NOT inject the overlay fields — same auto-gen-name case as
    // the "absent" test above. Pre-#319 this case injected the cdkd
    // identifier and caused REPLACE on first cdk deploy.
    const template = {
      Resources: { Bare: { Type: 'AWS::S3::Bucket' } },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Bare', resourceType: 'AWS::S3::Bucket', physicalId: 'b', resourceIdentifier: { BucketName: 'b' } },
    ]);
    expect((result['Resources'] as Record<string, Record<string, unknown>>)['Bare']!['Properties']).toEqual({});
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
  // Phase 1 and phase 2 must apply the SAME overlay rule to avoid CFn
  // seeing a "property changed" diff between the IMPORT'd state and the
  // phase-2 UPDATE template (which would silently REPLACE every imported
  // resource whose property is immutable — see PR #316). As of #319 the
  // overlay is conditional (only fires on literal-string mismatch), and
  // since both phases call `overlayResourceIdentifierOnProperties`, the
  // symmetry holds.

  it('skips overlay on auto-gen names (Properties.<field> absent — issue #319 fix)', () => {
    // CDK did not set RoleName; synth has no RoleName on the resource.
    // Phase-2 template MUST NOT inject it either, so the post-export
    // CFn-managed template matches what CDK synth would produce on a
    // future `cdk deploy` (= no Properties.RoleName) and `cdk diff`
    // shows no change.
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
    expect(properties).not.toHaveProperty('RoleName');
    // Existing Properties preserved
    expect(properties['AssumeRolePolicyDocument']).toEqual({
      Version: '2012-10-17',
      Statement: [],
    });
  });

  it('overlays on literal-string mismatch (pre-v0.94.0 prefix-on-user-declared-name legacy)', () => {
    // User declared `roleName: 'foo'` in CDK code; cdkd's pre-v0.94.0
    // default prefixed it to `'MyStack-foo'` on AWS. Phase-2 needs the
    // same overlay phase-1 used to keep CFn from seeing a diff between
    // IMPORT'd state ('MyStack-foo') and phase-2 raw synth ('foo').
    const synth = {
      Resources: {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'foo' },
        },
      },
    };
    const result = applyImportOverlayForPhase2(synth, [
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'MyStack-foo',
        resourceIdentifier: { RoleName: 'MyStack-foo' },
      },
    ]);
    const role = (result['Resources'] as Record<string, Record<string, unknown>>)['Role']!;
    expect((role['Properties'] as Record<string, unknown>)['RoleName']).toBe('MyStack-foo');
  });

  it('does NOT touch resources outside phase1Imports (phase-2 CREATE / recreate stay raw)', () => {
    // Custom Resources go through phase-2 CREATE from raw synth; recreate-
    // before-phase-2 entries (Stage / IAM::Policy) are deleted from AWS
    // and CFn re-CREATEs from raw synth. Neither should have overlay
    // applied — they have no "phase-1 import'd state" to keep consistent.
    const synth = {
      Resources: {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'foo' },
        },
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
        physicalId: 'MyStack-foo',
        resourceIdentifier: { RoleName: 'MyStack-foo' },
      },
      // CR and Stage are NOT in phase1Imports
    ]);
    const resources = result['Resources'] as Record<string, Record<string, unknown>>;
    expect((resources['Role']!['Properties'] as Record<string, unknown>)['RoleName']).toBe(
      'MyStack-foo'
    );
    expect(resources['CR']!['Properties']).toEqual({ ServiceToken: 'arn:...' });
    expect(resources['Stage']!['Properties']).toEqual({
      StageName: '$default',
      ApiId: { Ref: 'Api' },
    });
  });

  it('preserves intrinsic Properties.<field> (composite-id sub-resources — issue #319 fix)', () => {
    // Composite-id sub-resources reference their parent via intrinsic in
    // synth template. Phase-2 overlay MUST NOT overwrite the intrinsic
    // with a literal value — that would create a literal-vs-intrinsic
    // shape mismatch on next `cdk synth` → REPLACE on next `cdk deploy`.
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
    // Intrinsic preserved (NOT overwritten with 'api-xyz')
    expect(properties['ApiId']).toEqual({ Ref: 'Api' });
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

  it('does NOT match AWS::CloudFormation::Stack (nested stacks are not phase-2 creatable)', () => {
    // Nested stacks are handled by a dedicated branch in `buildImportPlan` that
    // routes the row through the state-tree walker (issue #464 PR B1) and
    // ultimately through CFn IMPORT's `--include-nested-stacks` (PR B2). They
    // are NOT phase-2 creatable — phase 2 would create a duplicate AWS::CFn::Stack
    // record rather than adopting the existing nested children.
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
        input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
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
        input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
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
        input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
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
        input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
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
        input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
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
  it('adds DeletionPolicy: Delete on resources lacking the attribute', () => {
    // v0.94.8 switched the injection default from Retain to Delete: matches
    // the CFn type-default behavior for resources without explicit
    // RemovalPolicy, so post-export `cdk diff` sees no Retain→absent diff
    // and the user's mental model stays "= CDK convention". See
    // injectDeletionPolicyForImport's docstring for the Retain-vs-Delete
    // rationale.
    const template: Record<string, unknown> = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        Topic: { Type: 'AWS::SNS::Topic', Properties: {} },
      },
    };
    const injected = injectDeletionPolicyForImport(template);
    expect(injected).toBe(2);
    expect((template['Resources'] as Record<string, Record<string, unknown>>)['Role']!['DeletionPolicy']).toBe('Delete');
    expect((template['Resources'] as Record<string, Record<string, unknown>>)['Topic']!['DeletionPolicy']).toBe('Delete');
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
    expect(resources['Role']!['DeletionPolicy']).toBe('Delete');
    expect(resources['Topic']!['DeletionPolicy']).toBe('Delete');
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

// -----------------------------------------------------------------------------
// Issue #464 PR B1 — `cdkd export` recursive nested-stack walker (state side).
// PR B1 lifts `AWS::CloudFormation::Stack` from `NEVER_IMPORTABLE_TYPES` and
// routes the row through a dedicated branch in `buildImportPlan` that
// surfaces a `nestedStackRows: NestedStackRow[]` list. The orchestrator
// uses `buildCdkdStateStackTree` to recursively load every child state
// file (fails fast on a torn tree) and then hard-errors with a PR B2
// pointer — the actual CFn `--include-nested-stacks` IMPORT changeset
// submission lands in PR B2.
// -----------------------------------------------------------------------------

/** Build a `StackState` shape matching schema v6, with the minimal fields the tests touch. */
function makeState(args: {
  stackName: string;
  region: string;
  resources?: Record<string, { resourceType: string; physicalId?: string }>;
  parentStack?: string;
  parentLogicalId?: string;
}): StackState {
  const resources: StackState['resources'] = {};
  for (const [logicalId, r] of Object.entries(args.resources ?? {})) {
    resources[logicalId] = {
      physicalId: r.physicalId ?? `phy-${logicalId}`,
      resourceType: r.resourceType,
      properties: {},
      attributes: {},
      dependencies: [],
    };
  }
  return {
    version: 6,
    stackName: args.stackName,
    region: args.region,
    resources,
    outputs: {},
    lastModified: 0,
    ...(args.parentStack !== undefined && { parentStack: args.parentStack }),
    ...(args.parentLogicalId !== undefined && { parentLogicalId: args.parentLogicalId }),
    ...(args.parentStack !== undefined && { parentRegion: args.region }),
  };
}

/**
 * Minimal `S3StateBackend` mock that returns a state record keyed by
 * `${stackName}|${region}`. Returns `null` for unknown keys so the walker's
 * missing-child branch can be exercised. `migrationPending` is included
 * (always `undefined` in the mock) to match the real `S3StateBackend.getState`
 * shape — pre-emptive fidelity even though the walker does not consult it.
 */
function makeStateBackendMock(
  states: Record<string, StackState>
): Pick<S3StateBackend, 'getState'> {
  return {
    async getState(stackName: string, region: string) {
      const s = states[`${stackName}|${region}`];
      if (!s) return null;
      return { state: s, etag: '"mock"', migrationPending: undefined };
    },
  } as unknown as Pick<S3StateBackend, 'getState'>;
}

describe('buildCdkdStateStackTree (issue #464 PR B1)', () => {
  it('returns a single-node tree when the root has no nested children', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Bucket: { resourceType: 'AWS::S3::Bucket' } },
    });
    const backend = makeStateBackendMock({ 'Root|us-east-1': root }) as S3StateBackend;
    const tree = await buildCdkdStateStackTree('Root', 'us-east-1', backend);
    expect(tree.stackName).toBe('Root');
    expect(tree.region).toBe('us-east-1');
    expect(tree.nestedChildren.size).toBe(0);
    expect(tree.state).toBe(root);
  });

  it('walks a one-level nested tree (parent -> two children)', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        ChildA: { resourceType: 'AWS::CloudFormation::Stack' },
        ChildB: { resourceType: 'AWS::CloudFormation::Stack' },
      },
    });
    const childA = makeState({
      stackName: 'Root~ChildA',
      region: 'us-east-1',
      resources: { Param: { resourceType: 'AWS::SSM::Parameter' } },
      parentStack: 'Root',
      parentLogicalId: 'ChildA',
    });
    const childB = makeState({
      stackName: 'Root~ChildB',
      region: 'us-east-1',
      resources: { Param: { resourceType: 'AWS::SSM::Parameter' } },
      parentStack: 'Root',
      parentLogicalId: 'ChildB',
    });
    const backend = makeStateBackendMock({
      'Root|us-east-1': root,
      'Root~ChildA|us-east-1': childA,
      'Root~ChildB|us-east-1': childB,
    }) as S3StateBackend;
    const tree = await buildCdkdStateStackTree('Root', 'us-east-1', backend);
    expect([...tree.nestedChildren.keys()].sort()).toEqual(['ChildA', 'ChildB']);
    expect(tree.nestedChildren.get('ChildA')!.stackName).toBe('Root~ChildA');
    expect(tree.nestedChildren.get('ChildB')!.stackName).toBe('Root~ChildB');
  });

  it('recurses into grandchildren (parent -> child -> grandchild)', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const child = makeState({
      stackName: 'Root~Child',
      region: 'us-east-1',
      resources: { Grandchild: { resourceType: 'AWS::CloudFormation::Stack' } },
      parentStack: 'Root',
      parentLogicalId: 'Child',
    });
    const grandchild = makeState({
      stackName: 'Root~Child~Grandchild',
      region: 'us-east-1',
      resources: { Bucket: { resourceType: 'AWS::S3::Bucket' } },
      parentStack: 'Root~Child',
      parentLogicalId: 'Grandchild',
    });
    const backend = makeStateBackendMock({
      'Root|us-east-1': root,
      'Root~Child|us-east-1': child,
      'Root~Child~Grandchild|us-east-1': grandchild,
    }) as S3StateBackend;
    const tree = await buildCdkdStateStackTree('Root', 'us-east-1', backend);
    expect(tree.nestedChildren.size).toBe(1);
    const childNode = tree.nestedChildren.get('Child')!;
    expect(childNode.nestedChildren.size).toBe(1);
    const grandNode = childNode.nestedChildren.get('Grandchild')!;
    expect(grandNode.stackName).toBe('Root~Child~Grandchild');
    expect(grandNode.nestedChildren.size).toBe(0);
  });

  it('throws when the root state is missing', async () => {
    const backend = makeStateBackendMock({}) as S3StateBackend;
    await expect(buildCdkdStateStackTree('Root', 'us-east-1', backend)).rejects.toThrow(
      /No cdkd state found for stack 'Root'/
    );
  });

  it('throws when a child state is missing (torn tree)', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    // Note: NO child state in the mock — simulating a torn tree.
    const backend = makeStateBackendMock({ 'Root|us-east-1': root }) as S3StateBackend;
    await expect(buildCdkdStateStackTree('Root', 'us-east-1', backend)).rejects.toThrow(
      /missing nested-child 'Root~Child'/
    );
  });

  it('throws when a child state records a different region (cross-region nested-stack not allowed)', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    // Child's `state.region` deliberately diverges from the walker's
    // expected region. AWS does not support cross-region nested stacks
    // today (design §6) — fail fast rather than silently consume the
    // mismatched child.
    const child = makeState({
      stackName: 'Root~Child',
      region: 'us-west-2',
      resources: {},
      parentStack: 'Root',
      parentLogicalId: 'Child',
    });
    const backend = makeStateBackendMock({
      'Root|us-east-1': root,
      // Backend lookup happens on the parent's region, so register the
      // child under `(Root~Child, us-east-1)`. The mismatch surfaces only
      // when the walker compares `childResult.state.region` (`us-west-2`)
      // against the walker's `region` argument (`us-east-1`).
      'Root~Child|us-east-1': child,
    }) as S3StateBackend;
    await expect(buildCdkdStateStackTree('Root', 'us-east-1', backend)).rejects.toThrow(
      /region mismatch.*state\.region='us-west-2'.*walked against region='us-east-1'/s
    );
  });

  it('skips the root-state fetch when prefetchedRootState is supplied', async () => {
    // The orchestrator typically loads the root state via
    // `stateBackend.getState` before invoking `buildCdkdStateStackTree`.
    // The fast-path optional argument lets the walker reuse that
    // already-loaded state instead of paying a second S3 round-trip.
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Bucket: { resourceType: 'AWS::S3::Bucket' } },
    });
    let rootFetchCount = 0;
    const backend = {
      async getState(stackName: string, region: string) {
        if (stackName === 'Root' && region === 'us-east-1') {
          rootFetchCount++;
          return { state: root, etag: '"mock"', migrationPending: undefined };
        }
        return null;
      },
    } as unknown as S3StateBackend;
    const tree = await buildCdkdStateStackTree('Root', 'us-east-1', backend, root);
    expect(rootFetchCount).toBe(0);
    expect(tree.state).toBe(root);
  });
});

describe('flattenCdkdStateTreeLeafFirst (issue #464 PR B1)', () => {
  it('returns a single entry for a leaf-only tree', () => {
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root', region: 'us-east-1' }),
      nestedChildren: new Map(),
    };
    expect(flattenCdkdStateTreeLeafFirst(tree)).toEqual([
      { stackName: 'Root', region: 'us-east-1' },
    ]);
  });

  it('orders leaves before parent (DFS post-order)', () => {
    const grand: CdkdStateStackTree = {
      stackName: 'Root~Child~Grand',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root~Child~Grand', region: 'us-east-1' }),
      nestedChildren: new Map(),
    };
    const child: CdkdStateStackTree = {
      stackName: 'Root~Child',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root~Child', region: 'us-east-1' }),
      nestedChildren: new Map([['Grand', grand]]),
    };
    const root: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root', region: 'us-east-1' }),
      nestedChildren: new Map([['Child', child]]),
    };
    expect(flattenCdkdStateTreeLeafFirst(root)).toEqual([
      { stackName: 'Root~Child~Grand', region: 'us-east-1' },
      { stackName: 'Root~Child', region: 'us-east-1' },
      { stackName: 'Root', region: 'us-east-1' },
    ]);
  });

  it('preserves sibling iteration order across multiple children', () => {
    const a: CdkdStateStackTree = {
      stackName: 'Root~A',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root~A', region: 'us-east-1' }),
      nestedChildren: new Map(),
    };
    const b: CdkdStateStackTree = {
      stackName: 'Root~B',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root~B', region: 'us-east-1' }),
      nestedChildren: new Map(),
    };
    const root: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root', region: 'us-east-1' }),
      nestedChildren: new Map([
        ['A', a],
        ['B', b],
      ]),
    };
    expect(flattenCdkdStateTreeLeafFirst(root)).toEqual([
      { stackName: 'Root~A', region: 'us-east-1' },
      { stackName: 'Root~B', region: 'us-east-1' },
      { stackName: 'Root', region: 'us-east-1' },
    ]);
  });
});

describe('buildImportPlan — nested-stack rows (issue #464 PR B1)', () => {
  // `cfnClient` is only consulted by the identifier-resolution path; the
  // nested-stack branch short-circuits before that. A stub that throws on
  // any `send` call is sufficient + documents the contract.
  const cfnClientStub = {
    send: () => {
      throw new Error('cfnClient.send should not be called for nested-stack-only templates');
    },
  } as unknown as AwsClients['cloudFormation'];

  it('routes AWS::CloudFormation::Stack rows into nestedStackRows[] (not blocked)', async () => {
    const state = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        Child: { resourceType: 'AWS::CloudFormation::Stack' },
      },
    });
    const template = {
      Resources: {
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
      },
    };
    const result = await buildImportPlan(state, template, cfnClientStub, 'Root');
    expect(result.nestedStackRows).toEqual([{ logicalId: 'Child', childStackName: 'Root~Child' }]);
    expect(result.blocked).toEqual([]);
    expect(result.phase1Imports).toEqual([]);
  });

  it('derives childStackName via `<parent>~<logicalId>` (the v6 state-key shape)', async () => {
    const state = makeState({
      stackName: 'MyApp',
      region: 'us-east-1',
      resources: {
        Database: { resourceType: 'AWS::CloudFormation::Stack' },
        Frontend: { resourceType: 'AWS::CloudFormation::Stack' },
      },
    });
    const template = {
      Resources: {
        Database: { Type: 'AWS::CloudFormation::Stack', Properties: {} },
        Frontend: { Type: 'AWS::CloudFormation::Stack', Properties: {} },
      },
    };
    const result = await buildImportPlan(state, template, cfnClientStub, 'MyApp');
    expect(result.nestedStackRows.map((r) => r.childStackName).sort()).toEqual([
      'MyApp~Database',
      'MyApp~Frontend',
    ]);
  });

  it('blocks when the template has a nested-stack row but state has no matching entry', async () => {
    const state = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      // No Child entry in state — parent state is torn.
      resources: {},
    });
    const template = {
      Resources: {
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} },
      },
    };
    const result = await buildImportPlan(state, template, cfnClientStub, 'Root');
    expect(result.nestedStackRows).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.logicalId).toBe('Child');
    expect(result.blocked[0]!.reason).toMatch(/no matching nested-stack entry on parent 'Root'/);
  });

  it('blocks when the state row exists but is the wrong resource type (sanity check)', async () => {
    const state = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      // Wrong type — should not be matched as a nested-stack row.
      resources: { Child: { resourceType: 'AWS::S3::Bucket' } },
    });
    const template = {
      Resources: {
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} },
      },
    };
    const result = await buildImportPlan(state, template, cfnClientStub, 'Root');
    expect(result.nestedStackRows).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toMatch(/no matching nested-stack entry/);
  });

  it('classifies a mixed template (one phase-1 row + one nested-stack row) without crosstalk', async () => {
    // Verifies the two branches coexist in a single buildImportPlan run:
    // a regular importable resource lands in `phase1Imports` while a
    // sibling AWS::CloudFormation::Stack row lands in `nestedStackRows`.
    // The cfn-client mock must NOT throw for the bucket's identifier
    // lookup — override the stub so `DescribeType` returns a schema.
    const state = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'my-bucket-123' },
        Child: { resourceType: 'AWS::CloudFormation::Stack' },
      },
    });
    const template = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'my-bucket-123' } },
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
      },
    };
    // Stubbed `send` only fires for the Bucket's DescribeType lookup; the
    // nested-stack row short-circuits BEFORE identifier resolution. Return
    // a schema that resolves AWS::S3::Bucket via the PRIMARY_IDENTIFIER_FALLBACK
    // path (i.e. throw to force fallback to the BucketName entry).
    const cfnClient = {
      send: async () => {
        throw new Error('DescribeType simulated failure — falls back to PRIMARY_IDENTIFIER_FALLBACK');
      },
    } as unknown as AwsClients['cloudFormation'];
    const result = await buildImportPlan(state, template, cfnClient, 'Root');
    expect(result.phase1Imports).toHaveLength(1);
    expect(result.phase1Imports[0]!.logicalId).toBe('Bucket');
    expect(result.phase1Imports[0]!.resourceIdentifier).toEqual({ BucketName: 'my-bucket-123' });
    expect(result.nestedStackRows).toEqual([
      { logicalId: 'Child', childStackName: 'Root~Child' },
    ]);
    expect(result.blocked).toEqual([]);
  });
});
