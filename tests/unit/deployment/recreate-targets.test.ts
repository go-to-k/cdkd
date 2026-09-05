/**
 * Unit tests for the #615 `--recreate-via-cc-api` pre-flight validator.
 *
 * Covers:
 *   - Unknown logical ids (template typo)
 *   - Logical ids absent from state (fresh-deploy case — recreate is N/A)
 *   - Ambiguous intent (--recreate-via-cc-api + --allow-unsupported-properties
 *     overlap on the same Type:Prop)
 *   - Stateful guard refusal without --force-stateful-recreation
 *   - Stateful guard bypass with --force-stateful-recreation
 *   - Duplicate logical id deduplication
 *   - Error-message rendering
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  validateRecreateTargets,
  renderRecreateTargetsErrors,
  probeStatefulRecreateTargetsAsync,
  probeAndRevalidateStateful,
  type RecreateTarget,
} from '../../../src/deployment/recreate-targets.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { NoSuchBucket, NotFound, type S3Client } from '@aws-sdk/client-s3';
import {
  ResourceNotFoundException,
  type CloudWatchLogsClient,
} from '@aws-sdk/client-cloudwatch-logs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function res(
  resourceType: string,
  partial: Partial<ResourceState> = {}
): ResourceState {
  return {
    physicalId: 'pid',
    resourceType,
    properties: {},
    attributes: {},
    dependencies: [],
    ...partial,
  };
}

function st(stackName: string, resources: Record<string, ResourceState>): StackState {
  return {
    version: 7,
    stackName,
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  };
}

describe('validateRecreateTargets (#615)', () => {
  it('returns a clean validation when every named id is in template + state + non-stateful', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'foo' },
        },
      },
    };
    const state = st('S', { MyLambda: res('AWS::Lambda::Function', { physicalId: 'foo' }) });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
    });
    expect(v.targets).toEqual([
      {
        logicalId: 'MyLambda',
        resourceType: 'AWS::Lambda::Function',
        physicalId: 'foo',
        statefulReason: null,
        direction: 'to-cc-api',
      },
    ]);
    expect(v.unknownLogicalIds).toEqual([]);
    expect(v.missingFromState).toEqual([]);
    expect(v.ambiguousIntent).toEqual([]);
    expect(v.blockedStatefulTargets).toEqual([]);
    expect(v.blockedMultiRegionTargets).toEqual([]);
    expect(renderRecreateTargetsErrors(v)).toBeNull();
  });

  it('reports unknown logical ids (typo in --recreate-via-cc-api)', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} },
      },
    };
    const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['Typo'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
    });
    expect(v.unknownLogicalIds).toEqual(['Typo']);
    expect(v.targets).toEqual([]);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('Typo');
    expect(error).toMatch(/not present in the synth template/);
  });

  it('reports missing-from-state ids (fresh-deploy case — recreate is N/A)', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        NewLambda: { Type: 'AWS::Lambda::Function', Properties: {} },
      },
    };
    const state = st('S', {}); // empty
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['NewLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
    });
    expect(v.missingFromState).toEqual(['NewLambda']);
    expect(v.targets).toEqual([]);
    expect(renderRecreateTargetsErrors(v)).toMatch(/fresh CREATEs on the next deploy/);
  });

  it('deduplicates duplicate logical ids in the input', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['MyLambda', 'MyLambda', 'MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
    });
    expect(v.targets).toHaveLength(1);
    expect(v.targets[0]!.logicalId).toBe('MyLambda');
  });

  describe('ambiguous-intent overlap with --allow-unsupported-properties', () => {
    it('reports overlap when the same Type:Prop is in both flags AND template uses the property', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyLambda: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              FunctionName: 'foo',
              FunctionScalingConfig: { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 2 }, // silent-drop property
            },
          },
        },
      };
      const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyLambda'],
        allowUnsupportedProperties: new Set(['AWS::Lambda::Function:FunctionScalingConfig']),
        forceStatefulRecreation: false,
      });
      expect(v.ambiguousIntent).toEqual([
        { logicalId: 'MyLambda', resourceType: 'AWS::Lambda::Function', property: 'FunctionScalingConfig' },
      ]);
      const error = renderRecreateTargetsErrors(v);
      expect(error).toContain('Ambiguous intent');
      expect(error).toContain('FunctionScalingConfig');
      expect(error).toMatch(/pick ONE strategy per resource/);
    });

    it('does NOT report overlap when --allow-unsupported-properties names a different property than the template uses', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyLambda: {
            Type: 'AWS::Lambda::Function',
            Properties: { FunctionName: 'foo', FunctionScalingConfig: { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 2 } },
          },
        },
      };
      const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
      // Allow-set covers SnapStart, not FunctionScalingConfig — the template's
      // actual silent-drop property is FunctionScalingConfig, so no overlap fires.
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyLambda'],
        allowUnsupportedProperties: new Set(['AWS::Lambda::Function:SnapStart']),
        forceStatefulRecreation: false,
      });
      expect(v.ambiguousIntent).toEqual([]);
    });

    it('does NOT report overlap when the template has no silent-drop property at all (override is a no-op)', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          PlainLambda: {
            Type: 'AWS::Lambda::Function',
            Properties: { FunctionName: 'foo' /* no FunctionScalingConfig */ },
          },
        },
      };
      const state = st('S', { PlainLambda: res('AWS::Lambda::Function') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['PlainLambda'],
        allowUnsupportedProperties: new Set(['AWS::Lambda::Function:FunctionScalingConfig']),
        forceStatefulRecreation: false,
      });
      expect(v.ambiguousIntent).toEqual([]);
    });
  });

  describe('stateful guard', () => {
    it('blocks stateful targets without --force-stateful-recreation', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyDB: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: 'foo' } },
        },
      };
      const state = st('S', {
        MyDB: res('AWS::RDS::DBInstance', { physicalId: 'foo' }),
      });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyDB'],
        allowUnsupportedProperties: new Set(),
        forceStatefulRecreation: false,
      });
      expect(v.blockedStatefulTargets).toHaveLength(1);
      expect(v.blockedStatefulTargets[0]!.logicalId).toBe('MyDB');
      expect(v.blockedStatefulTargets[0]!.statefulReason).toBe('always');
      const error = renderRecreateTargetsErrors(v);
      expect(error).toMatch(/--force-stateful-recreation/);
      expect(error).toMatch(/MyDB \(AWS::RDS::DBInstance\)/);
    });

    it('passes stateful targets through when --force-stateful-recreation is set', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyDB: { Type: 'AWS::RDS::DBInstance', Properties: {} },
        },
      };
      const state = st('S', { MyDB: res('AWS::RDS::DBInstance') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyDB'],
        allowUnsupportedProperties: new Set(),
        forceStatefulRecreation: true,
      });
      expect(v.blockedStatefulTargets).toEqual([]);
      expect(v.targets).toHaveLength(1);
      expect(v.targets[0]!.statefulReason).toBe('always');
      expect(renderRecreateTargetsErrors(v)).toBeNull();
    });

    it('LogGroup is conditional at SYNC time: retention blocks, no retention DEFERS to the probe', () => {
      // The `null` on `UnprobedLogs` is a DEFERRAL, not a pass: this validator
      // is the sync first-cut, and `probeAndRevalidateStateful` decides that
      // target's fate a few lines later in `deploy.ts` (issue #2558 — an unset
      // retention is CloudWatch Logs' never-expire, never "nothing to lose").
      // The name says `Unprobed`, not `Ephemeral`, for exactly that reason.
      const template: CloudFormationTemplate = {
        Resources: {
          KeptLogs: { Type: 'AWS::Logs::LogGroup', Properties: {} },
          UnprobedLogs: { Type: 'AWS::Logs::LogGroup', Properties: {} },
        },
      };
      const state = st('S', {
        KeptLogs: res('AWS::Logs::LogGroup', {
          properties: { RetentionInDays: 30 },
        }),
        UnprobedLogs: res('AWS::Logs::LogGroup', { properties: {} }),
      });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['KeptLogs', 'UnprobedLogs'],
        allowUnsupportedProperties: new Set(),
        forceStatefulRecreation: false,
      });
      // Only KeptLogs is decided from the bag; UnprobedLogs awaits the probe.
      expect(v.blockedStatefulTargets).toHaveLength(1);
      expect(v.blockedStatefulTargets[0]!.logicalId).toBe('KeptLogs');
      expect(v.blockedStatefulTargets[0]!.statefulReason).toBe('has-retention');
      const unprobed = v.targets.find((t) => t.logicalId === 'UnprobedLogs');
      expect(unprobed?.statefulReason).toBe(null);
    });

    it('S3 bucket is deferred to the async probe (sync target.statefulReason is null)', () => {
      // The sync map cannot judge S3 emptiness — it defers to the
      // deploy engine's live ListObjectsV2 probe. The sync result is
      // null here, NOT in blockedStatefulTargets.
      const template: CloudFormationTemplate = {
        Resources: { MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      };
      const state = st('S', {
        MyBucket: res('AWS::S3::Bucket', { physicalId: 'bucket-pid' }),
      });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyBucket'],
        allowUnsupportedProperties: new Set(),
        forceStatefulRecreation: false,
      });
      expect(v.targets).toHaveLength(1);
      expect(v.targets[0]!.statefulReason).toBe(null);
      // Sync validation lets this pass — async probe is responsible.
      expect(v.blockedStatefulTargets).toEqual([]);
    });
  });

  describe('multi-region refusal (design §8 — out of scope for v1)', () => {
    it('refuses AWS::DynamoDB::GlobalTable outright (no --force bypass)', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyGlobalTable: { Type: 'AWS::DynamoDB::GlobalTable', Properties: {} },
        },
      };
      const state = st('S', { MyGlobalTable: res('AWS::DynamoDB::GlobalTable') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyGlobalTable'],
        allowUnsupportedProperties: new Set(),
        // Even with --force-stateful-recreation, multi-region is structurally refused.
        forceStatefulRecreation: true,
      });
      expect(v.blockedMultiRegionTargets).toHaveLength(1);
      expect(v.blockedMultiRegionTargets[0]!.logicalId).toBe('MyGlobalTable');
      const error = renderRecreateTargetsErrors(v);
      expect(error).toMatch(/refuses to operate on 1 multi-region resource/);
      expect(error).toMatch(/No --force-stateful-recreation bypass/);
    });

    it('still lists multi-region targets in targets[] so callers see them (the refusal is separate from inclusion)', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyGlobalTable: { Type: 'AWS::DynamoDB::GlobalTable', Properties: {} },
        },
      };
      const state = st('S', { MyGlobalTable: res('AWS::DynamoDB::GlobalTable') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyGlobalTable'],
        allowUnsupportedProperties: new Set(),
        forceStatefulRecreation: true,
      });
      // The target is added to targets[] AND blockedMultiRegionTargets[].
      // renderRecreateTargetsErrors returning non-null is what causes the
      // deploy command to abort BEFORE the engine sees the targets set.
      expect(v.targets.map((t) => t.logicalId)).toEqual(['MyGlobalTable']);
      expect(v.blockedMultiRegionTargets.map((t) => t.logicalId)).toEqual(['MyGlobalTable']);
    });
  });

  it('aggregates multiple distinct failure categories into one rendered error block', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyDB: { Type: 'AWS::RDS::DBInstance', Properties: {} },
        MyLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionScalingConfig: { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 2 } },
        },
        // Declared but never deployed → missingFromState
        FreshResource: { Type: 'AWS::Lambda::Function', Properties: {} },
        MyGlobalTable: { Type: 'AWS::DynamoDB::GlobalTable', Properties: {} },
      },
    };
    const state = st('S', {
      MyDB: res('AWS::RDS::DBInstance'),
      MyLambda: res('AWS::Lambda::Function'),
      MyGlobalTable: res('AWS::DynamoDB::GlobalTable'),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['MyDB', 'MyLambda', 'NotInTemplate', 'FreshResource', 'MyGlobalTable'],
      allowUnsupportedProperties: new Set(['AWS::Lambda::Function:FunctionScalingConfig']),
      forceStatefulRecreation: false,
    });
    expect(v.unknownLogicalIds).toEqual(['NotInTemplate']);
    expect(v.missingFromState).toEqual(['FreshResource']);
    expect(v.blockedStatefulTargets.map((t) => t.logicalId).sort()).toEqual([
      'MyDB',
      'MyGlobalTable',
    ]);
    expect(v.blockedMultiRegionTargets.map((t) => t.logicalId)).toEqual(['MyGlobalTable']);
    expect(v.ambiguousIntent.map((a) => a.logicalId)).toEqual(['MyLambda']);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('not present in the synth template');
    expect(error).toContain('fresh CREATEs on the next deploy');
    expect(error).toContain('Ambiguous intent');
    expect(error).toContain('--force-stateful-recreation');
    expect(error).toContain('multi-region resource');
  });
});

describe('validateRecreateTargets — #651 reverse direction (--recreate-via-sdk-provider)', () => {
  it('rejects --recreate-via-sdk-provider on a resource currently provisionedBy: sdk (no-op)', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'sdk' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.blockedAlreadySdk.map((t) => t.logicalId)).toEqual(['MyLambda']);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('reverse migration is a no-op');
    expect(error).toContain('already SDK-managed');
  });

  it('rejects --recreate-via-sdk-provider on a resource with no provisionedBy field (legacy state, treated as SDK)', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function'), // no provisionedBy → legacy SDK
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.blockedAlreadySdk.map((t) => t.logicalId)).toEqual(['MyLambda']);
  });

  it('accepts --recreate-via-sdk-provider on a resource currently provisionedBy: cc-api', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'cc-api' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.blockedAlreadySdk).toEqual([]);
    expect(v.targets.map((t) => t.logicalId)).toEqual(['MyLambda']);
    expect(v.targets[0]!.direction).toBe('to-sdk');
    expect(renderRecreateTargetsErrors(v)).toBeNull();
  });

  it('rejects --recreate-via-sdk-provider on a type with no SDK provider (Tier 2 CC-only)', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyTier2: { Type: 'AWS::Tier2::Type', Properties: {} } },
    };
    const state = st('S', { MyTier2: res('AWS::Tier2::Type', { provisionedBy: 'cc-api' }) });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyTier2'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: (rt) => rt !== 'AWS::Tier2::Type',
    });
    expect(v.blockedNoSdkProvider.map((t) => t.logicalId)).toEqual(['MyTier2']);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('no SDK provider for');
    expect(error).toContain('AWS::Tier2::Type');
  });

  it('inverse ambiguous-intent: refuses --recreate-via-sdk-provider when template uses a silent-drop property NOT in --allow-unsupported-properties', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionScalingConfig: { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 2 } },
        },
      },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'cc-api' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyLambda'],
      // FunctionScalingConfig NOT in --allow-unsupported-properties → next deploy
      // would auto-route the recreated SDK resource back to CC.
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.ambiguousIntentSdk.map((a) => a.logicalId)).toEqual(['MyLambda']);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('IMMEDIATELY be re-routed back to Cloud Control');
    expect(error).toContain('FunctionScalingConfig');
  });

  it('inverse ambiguous-intent: PASSES when the silent-drop property IS in --allow-unsupported-properties', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionScalingConfig: { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 2 } },
        },
      },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'cc-api' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyLambda'],
      allowUnsupportedProperties: new Set(['AWS::Lambda::Function:FunctionScalingConfig']),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.ambiguousIntentSdk).toEqual([]);
    expect(renderRecreateTargetsErrors(v)).toBeNull();
  });

  it('rejects a logical id named in BOTH --recreate-via-cc-api AND --recreate-via-sdk-provider', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', { MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'cc-api' }) });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['MyLambda'],
      recreateViaSdkProvider: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.conflictingDirections).toEqual(['MyLambda']);
    // The conflicting id is NOT added to targets — caller must pick a side.
    expect(v.targets).toEqual([]);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('Conflicting recreate direction');
    expect(error).toContain('pick ONE direction per resource');
  });

  it('multi-region refusal fires for the reverse direction too', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyGlobalTable: { Type: 'AWS::DynamoDB::GlobalTable', Properties: {} } },
    };
    const state = st('S', {
      MyGlobalTable: res('AWS::DynamoDB::GlobalTable', { provisionedBy: 'cc-api' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyGlobalTable'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: true,
      hasSdkProvider: () => true,
    });
    expect(v.blockedMultiRegionTargets.map((t) => t.logicalId)).toEqual(['MyGlobalTable']);
  });

  it('mixes both directions in a single call (cc-api + sdk-provider non-overlapping)', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        FwdLambda: { Type: 'AWS::Lambda::Function', Properties: {} },
        BackLambda: { Type: 'AWS::Lambda::Function', Properties: {} },
      },
    };
    const state = st('S', {
      FwdLambda: res('AWS::Lambda::Function', { provisionedBy: 'sdk' }),
      BackLambda: res('AWS::Lambda::Function', { provisionedBy: 'cc-api' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['FwdLambda'],
      recreateViaSdkProvider: ['BackLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.targets.map((t) => ({ id: t.logicalId, dir: t.direction }))).toEqual([
      { id: 'FwdLambda', dir: 'to-cc-api' },
      { id: 'BackLambda', dir: 'to-sdk' },
    ]);
    expect(renderRecreateTargetsErrors(v)).toBeNull();
  });
});

describe('validateRecreateTargets — #665 symmetric forward refusal (--recreate-via-cc-api on already-cc-api)', () => {
  it('rejects --recreate-via-cc-api on a resource currently provisionedBy: cc-api (no-op)', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'cc-api' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
    });
    expect(v.blockedAlreadyCcApi.map((t) => t.logicalId)).toEqual(['MyLambda']);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('ALREADY sticky on Cloud Control API');
    expect(error).toContain('migration is a no-op');
    expect(error).toContain('remove --recreate-via-cc-api');
  });

  it('accepts --recreate-via-cc-api on a resource currently provisionedBy: sdk (legitimate forward migration)', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'sdk' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
    });
    expect(v.blockedAlreadyCcApi).toEqual([]);
    expect(v.targets.map((t) => t.logicalId)).toEqual(['MyLambda']);
    expect(v.targets[0]!.direction).toBe('to-cc-api');
    expect(renderRecreateTargetsErrors(v)).toBeNull();
  });

  it('accepts --recreate-via-cc-api on a resource with no provisionedBy field (legacy pre-v7 state, treated as SDK)', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function'), // no provisionedBy
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
    });
    expect(v.blockedAlreadyCcApi).toEqual([]);
    expect(renderRecreateTargetsErrors(v)).toBeNull();
  });

  it('blockedAlreadyCcApi does NOT fire for the reverse direction (--recreate-via-sdk-provider on cc-api is the intended path)', () => {
    const template: CloudFormationTemplate = {
      Resources: { MyLambda: { Type: 'AWS::Lambda::Function', Properties: {} } },
    };
    const state = st('S', {
      MyLambda: res('AWS::Lambda::Function', { provisionedBy: 'cc-api' }),
    });
    const v = validateRecreateTargets({
      template,
      state,
      recreateViaCcApi: [],
      recreateViaSdkProvider: ['MyLambda'],
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.blockedAlreadyCcApi).toEqual([]);
    // The reverse direction PASSES this case — this is exactly the user's goal.
    expect(v.targets[0]!.direction).toBe('to-sdk');
    expect(renderRecreateTargetsErrors(v)).toBeNull();
  });
});

/**
 * A validation carrying only the stateful slice, for the rendering assertions.
 * Every other category is empty, so the rendered block is unambiguously the
 * stateful refusal.
 */
function emptyValidation(
  blocked: Array<RecreateTarget & { statefulReason: Exclude<RecreateTarget['statefulReason'], null> }>
): Parameters<typeof renderRecreateTargetsErrors>[0] {
  return {
    targets: [...blocked],
    unknownLogicalIds: [],
    missingFromState: [],
    ambiguousIntent: [],
    ambiguousIntentSdk: [],
    blockedStatefulTargets: blocked,
    blockedMultiRegionTargets: [],
    blockedAlreadySdk: [],
    blockedAlreadyCcApi: [],
    blockedNoSdkProvider: [],
    conflictingDirections: [],
  };
}

/**
 * A CloudWatch Logs client for validations that contain no log-group target.
 * Throwing rather than no-op'ing: a probe reaching it would mean the arm fired
 * for a type it does not own.
 */
function noLogGroupTargets(): CloudWatchLogsClient {
  return {
    send: vi.fn(() => {
      throw new Error('no log-group target in this validation');
    }),
  } as unknown as CloudWatchLogsClient;
}

describe('probeStatefulRecreateTargetsAsync (#648)', () => {
  function s3Target(overrides: Partial<RecreateTarget> = {}): RecreateTarget {
    return {
      logicalId: 'MyBucket',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'bucket-pid',
      statefulReason: null,
      direction: 'to-cc-api',
      ...overrides,
    };
  }

  /**
   * A CloudWatch Logs client that FAILS the test if it is ever used.
   *
   * Every case in this describe is about the S3 arm, so a log-group probe
   * firing here would mean the type dispatch stopped discriminating — and
   * since the log-group arm fails CLOSED, a stray call would silently promote
   * a target rather than error. Throwing a distinctive message makes the
   * mis-dispatch visible instead.
   */
  function forbiddenLogsClient(): CloudWatchLogsClient {
    return {
      send: vi.fn(() => {
        throw new Error('the S3 arm must not touch the CloudWatch Logs client');
      }),
    } as unknown as CloudWatchLogsClient;
  }

  function mockS3({
    versions,
    deleteMarkers,
    throws,
    throwsOnce,
    truncation,
    omitArrays,
  }: {
    versions?: number;
    deleteMarkers?: number;
    throws?: Error;
    /** Thrown on the FIRST call only, so a retry can succeed. */
    throwsOnce?: Error;
    /** Which continuation shape the page carries, if any. */
    truncation?: 'isTruncated' | 'nextKeyMarker' | 'nextVersionIdMarker';
    /**
     * Omit `Versions` / `DeleteMarkers` entirely rather than sending empty
     * arrays. This is what real S3 does for an empty collection (measured
     * 2026-09-05: a bucket with versions and no delete markers answered with
     * `DeleteMarkers` absent), so it is the shape an EMPTY bucket produces --
     * the case that must keep reading as empty.
     */
    omitArrays?: boolean;
  }): { client: S3Client; sentCommands: unknown[] } {
    const sentCommands: unknown[] = [];
    let calls = 0;
    const send = vi.fn(async (cmd: unknown) => {
      sentCommands.push(cmd);
      calls += 1;
      if (throwsOnce && calls === 1) throw throwsOnce;
      if (throws) throw throws;
      return {
        ...(omitArrays
          ? {}
          : {
              Versions: Array.from({ length: versions ?? 0 }, (_, i) => ({
                Key: `k${i}`,
                VersionId: `v${i}`,
              })),
              DeleteMarkers: Array.from({ length: deleteMarkers ?? 0 }, (_, i) => ({
                Key: `d${i}`,
                VersionId: `dv${i}`,
              })),
            }),
        ...(truncation === 'isTruncated' && { IsTruncated: true }),
        ...(truncation === 'nextKeyMarker' && { NextKeyMarker: 'k-next' }),
        ...(truncation === 'nextVersionIdMarker' && { NextVersionIdMarker: 'v-next' }),
      };
    });
    return { client: { send } as unknown as S3Client, sentCommands };
  }

  /** A throttle shaped the way the SDK surfaces one. */
  function throttleError(): Error {
    const e = new Error('Rate exceeded');
    e.name = 'ThrottlingException';
    return e;
  }

  /** Injected so the retry's backoff costs no wall-clock. */
  const noSleep = async (): Promise<void> => {};

  function silentLogger() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it('promotes statefulReason to has-objects when the bucket has at least one current version', async () => {
    const { client } = mockS3({ versions: 1 });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.statefulReason).toBe('has-objects');
  });

  it('promotes statefulReason to has-objects when the bucket has only delete-markers (versioned bucket where current keys are soft-deleted)', async () => {
    const { client } = mockS3({ versions: 0, deleteMarkers: 1 });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe('has-objects');
  });

  it('leaves statefulReason at null when ListObjectVersions returns no versions and no delete-markers', async () => {
    const { client } = mockS3({ versions: 0, deleteMarkers: 0 });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe(null);
  });

  it('soft-fails on probe error — logs a warn and leaves the sync result in place', async () => {
    const { client } = mockS3({ throws: new Error('AccessDenied') });
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      logger
    );
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnArg = logger.warn.mock.calls[0]![0] as string;
    expect(warnArg).toContain('live S3 probe failed');
    expect(warnArg).toContain('MyBucket');
    expect(warnArg).toContain('AccessDenied');
  });

  it('passes through non-S3 targets without probing', async () => {
    const { client, sentCommands } = mockS3({ versions: 5 });
    const out = await probeStatefulRecreateTargetsAsync(
      [
        {
          logicalId: 'MyLambda',
          resourceType: 'AWS::Lambda::Function',
          physicalId: 'fn-pid',
          statefulReason: null,
          direction: 'to-cc-api',
        },
      ],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe(null);
    expect(sentCommands).toHaveLength(0);
  });

  it('passes through S3 targets whose sync reason is already non-null without probing', async () => {
    const { client, sentCommands } = mockS3({ versions: 99 });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target({ statefulReason: 'always' })],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe('always');
    expect(sentCommands).toHaveLength(0);
  });

  // Issue #2578. Both polarities of the continuation half, plus the control
  // that stops the fix from overshooting into an unconditional refusal.
  for (const truncation of ['isTruncated', 'nextKeyMarker', 'nextVersionIdMarker'] as const) {
    it(`promotes to has-objects when an entry-less page carries ${truncation} — the listing is unfinished, so this page's emptiness is not the bucket's`, async () => {
      const logger = silentLogger();
      const { client } = mockS3({ versions: 0, deleteMarkers: 0, truncation });
      const out = await probeStatefulRecreateTargetsAsync(
        [s3Target()],
        { s3: client, cloudWatchLogs: forbiddenLogsClient() },
        logger
      );
      expect(out[0]!.statefulReason).toBe('has-objects');
      // Warned, not silently refused: the refusal alone would not say the API
      // answered without answering.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0]![0])).toContain('without settling it');
    });
  }

  it('promotes WITHOUT the unsettled warning when a truncated page also carries an entry — the ordinary MaxKeys=1 answer for a non-empty bucket', async () => {
    const logger = silentLogger();
    // This is the COMMON real response, not an edge case: MaxKeys=1 against a
    // non-empty bucket returns one entry AND IsTruncated: true. Only the
    // branch ORDER keeps the "without settling it" warning off every
    // non-empty bucket, so the order needs its own test.
    const { client } = mockS3({ versions: 1, truncation: 'isTruncated' });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      logger
    );
    expect(out[0]!.statefulReason).toBe('has-objects');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves statefulReason at null when the page OMITS both arrays and is not truncated — S3 omits an empty collection, so absence is how an empty bucket answers', async () => {
    const logger = silentLogger();
    const { client } = mockS3({ omitArrays: true });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      logger
    );
    // The control for #2578: requiring a PRESENT empty pair here — the shape
    // the log-group arm requires — would refuse EVERY empty bucket and turn
    // this conditional arm into an unconditional one.
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still promotes an omitted-array page that IS truncated', async () => {
    const { client } = mockS3({ omitArrays: true, truncation: 'isTruncated' });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe('has-objects');
  });

  // Issue #2566.
  it('retries a THROTTLED S3 probe and uses the retry’s answer', async () => {
    const { client, sentCommands } = mockS3({
      versions: 1,
      throwsOnce: throttleError(),
    });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient(), sleep: noSleep },
      silentLogger()
    );
    expect(sentCommands).toHaveLength(2);
    // Without the retry this fell into the fail-OPEN catch and stayed null,
    // silently widening the hole the guard exists to close.
    expect(out[0]!.statefulReason).toBe('has-objects');
  });

  it('gives up after a bounded number of attempts on a PERSISTENT throttle, and degrades to the S3 arm’s open failure', async () => {
    const { client, sentCommands } = mockS3({ throws: throttleError() });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient(), sleep: noSleep },
      silentLogger()
    );
    // 3 retries = 4 attempts. Pinned so the budget cannot grow silently on a
    // path where a user is waiting, and so the published "three retries"
    // figure has something watching it.
    expect(sentCommands).toHaveLength(4);
    // Exhaustion lands in the SAME arm the pre-retry code reached on the
    // first throttle — the retry buys attempts, it does not change the
    // failure posture.
    expect(out[0]!.statefulReason).toBe(null);
  });

  it('does NOT retry a non-throttle S3 failure — the probe keeps its open failure arm', async () => {
    const logger = silentLogger();
    const { client, sentCommands } = mockS3({ throws: new Error('AccessDenied') });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: client, cloudWatchLogs: forbiddenLogsClient(), sleep: noSleep },
      logger
    );
    // One attempt, not four: the classifier is throttle-only, deliberately
    // narrower than the shared transient table.
    expect(sentCommands).toHaveLength(1);
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Issue #2595: the verdict stays null (fail OPEN, unchanged) but the
    // target now CARRIES that nothing was established, which is what lets the
    // confirm prompt distinguish it from a bucket measured empty.
    expect(out[0]!.probeUnresolved).toBe(true);
  });

  for (const [label, err] of [
    ['NoSuchBucket', Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' })],
    ['NotFound', Object.assign(new Error('Not Found'), { name: 'NotFound' })],
  ] as const) {
    it(`treats a typed ${label} as an ANSWER, not an unknown — a gone bucket provably holds nothing`, async () => {
      // Shaped by prototype, not by name: the production check is
      // `instanceof`, so a name-only fake would pass the test while the real
      // error took the other branch (or vice versa).
      const typed = Object.create(
        label === 'NoSuchBucket' ? NoSuchBucket.prototype : NotFound.prototype
      ) as Error;
      Object.assign(typed, err);
      const logger = silentLogger();
      const { client } = mockS3({ throws: typed });
      const out = await probeStatefulRecreateTargetsAsync(
        [s3Target()],
        { s3: client, cloudWatchLogs: forbiddenLogsClient(), sleep: noSleep },
        logger
      );
      expect(out[0]!.statefulReason).toBe(null);
      // The discriminating half: an ordinary probe failure sets the flag and
      // warns. A not-found must do NEITHER, or the plan tells the user cdkd
      // does not know about a bucket AWS just said is gone.
      expect(out[0]!.probeUnresolved).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  }

  it('does NOT mark probeUnresolved when the probe ANSWERED — the flag distinguishes unknown from measured', async () => {
    // Both measured outcomes, in one case, because the flag's whole job is to
    // separate them from the failure above: a flag set unconditionally, or
    // never set, is invisible to a test that only ever probes one of them.
    const empty = mockS3({ versions: 0, deleteMarkers: 0 });
    const nonEmpty = mockS3({ versions: 1 });
    const emptyOut = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: empty.client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    const nonEmptyOut = await probeStatefulRecreateTargetsAsync(
      [s3Target()],
      { s3: nonEmpty.client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(emptyOut[0]!.statefulReason).toBe(null);
    expect(emptyOut[0]!.probeUnresolved).toBeUndefined();
    expect(nonEmptyOut[0]!.statefulReason).toBe('has-objects');
    expect(nonEmptyOut[0]!.probeUnresolved).toBeUndefined();
  });

  it('does NOT mark probeUnresolved on a target whose sync reason was already non-null — it never reaches the probe', async () => {
    const { client } = mockS3({ throws: new Error('AccessDenied') });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target({ statefulReason: 'always' })],
      { s3: client, cloudWatchLogs: forbiddenLogsClient() },
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe('always');
    expect(out[0]!.probeUnresolved).toBeUndefined();
  });
});

describe('probeStatefulRecreateTargetsAsync — AWS::Logs::LogGroup arm (#2558)', () => {
  function logGroupTarget(overrides: Partial<RecreateTarget> = {}): RecreateTarget {
    return {
      logicalId: 'MyLogGroup',
      resourceType: 'AWS::Logs::LogGroup',
      physicalId: '/aws/lambda/my-fn',
      // The sync predicate DEFERS for a log group whose recorded bag carries no
      // positive retention — that deferral is what this probe resolves.
      statefulReason: null,
      direction: 'to-cc-api',
      ...overrides,
    };
  }

  function mockLogs({
    streams,
    throws,
    throwsOnce,
  }: {
    streams?: number;
    throws?: Error;
    /** Thrown on the FIRST call only, so a retry can succeed. */
    throwsOnce?: Error;
  }): {
    client: CloudWatchLogsClient;
    sentCommands: Array<{ logGroupName?: string; limit?: number }>;
  } {
    const sentCommands: Array<{ logGroupName?: string; limit?: number }> = [];
    let calls = 0;
    const send = vi.fn(async (cmd: { input?: { logGroupName?: string; limit?: number } }) => {
      sentCommands.push(cmd.input ?? {});
      calls += 1;
      if (throwsOnce && calls === 1) throw throwsOnce;
      if (throws) throw throws;
      return {
        logStreams: Array.from({ length: streams ?? 0 }, (_, i) => ({
          logStreamName: `stream-${i}`,
          // The field the probe must NOT read: AWS reports `storedBytes` as
          // zero for every log STREAM since June 2019, so a byte-count probe
          // would call this non-empty group empty.
          storedBytes: 0,
        })),
      };
    });
    return { client: { send } as unknown as CloudWatchLogsClient, sentCommands };
  }

  /** An S3 client the log-group arm must never touch. */
  function forbiddenS3Client(): S3Client {
    return {
      send: vi.fn(() => {
        throw new Error('the LogGroup arm must not touch the S3 client');
      }),
    } as unknown as S3Client;
  }

  function silentLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  const probe = async (
    target: RecreateTarget,
    logs: { client: CloudWatchLogsClient },
    logger = silentLogger()
  ): Promise<RecreateTarget[]> =>
    probeStatefulRecreateTargetsAsync(
      [target],
      { s3: forbiddenS3Client(), cloudWatchLogs: logs.client },
      logger
    );

  it('promotes to has-log-events when the log group has at least one log stream', async () => {
    const logs = mockLogs({ streams: 1 });
    const logger = silentLogger();
    const out = await probe(logGroupTarget(), logs, logger);
    expect(out[0]!.statefulReason).toBe('has-log-events');
    // Probed by NAME with a single-page limit — the recorded physical id IS the
    // log group name, and a full listing on a busy group would be pointless.
    expect(logs.sentCommands).toEqual([{ logGroupName: '/aws/lambda/my-fn', limit: 1 }]);
    // SILENT: a stream is an ANSWER, so this arm must not emit the non-answer
    // warning. Without this pin, collapsing the found-a-stream arm into the
    // non-answer `else` would tell a user whose group demonstrably has a
    // stream that the API "answered without settling it" — the same verdict
    // reached by a wrong and misleading route, with nothing red.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves the deferral at null when the log group has no log streams', async () => {
    // The polarity that keeps the condition CONDITIONAL: a genuinely disposable
    // log group is still recreatable with no consent flag. Every event belongs
    // to a stream, so zero streams proves the group holds none.
    const logs = mockLogs({ streams: 0 });
    const out = await probe(logGroupTarget(), logs);
    expect(out[0]!.statefulReason).toBe(null);
  });

  it('fails CLOSED on probe error — warns AND promotes, unlike the S3 arm', async () => {
    // The divergence from `ListObjectVersions`'s soft-fail is the point of
    // issue #2558: an unprovable emptiness must not read as empty for a type
    // whose default configuration is "never expire".
    const logs = mockLogs({ throws: new Error('AccessDeniedException') });
    const logger = silentLogger();
    const out = await probe(logGroupTarget(), logs, logger);
    expect(out[0]!.statefulReason).toBe('has-log-events');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnArg = logger.warn.mock.calls[0]![0] as string;
    expect(warnArg).toContain('MyLogGroup');
    expect(warnArg).toContain('/aws/lambda/my-fn');
    expect(warnArg).toContain('AccessDeniedException');
    expect(warnArg).toContain('--force-stateful-recreation');
  });

  it('treats a MISSING log group as provably empty — the one error that is an answer', async () => {
    // `ResourceNotFoundException` is not a failure to learn whether the group
    // holds events; it IS the answer, so the fail-CLOSED rule does not apply
    // and no warning is emitted. Constructed through the SDK's own class, since
    // production narrows with `instanceof` — a plain `Error` carrying the same
    // message must NOT take this arm, which the next assertion pins.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const logs = mockLogs({ throws: notFound });
    const logger = silentLogger();
    const out = await probe(logGroupTarget(), logs, logger);
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('refuses the not-found inference when the client is in the WRONG region', async () => {
    // `region-check.ts`'s whole purpose: a `ResourceNotFoundException` from a
    // client pointed elsewhere says nothing about the recorded resource. The
    // probe cannot throw (that is the delete path's answer), so it falls back
    // to the fail-CLOSED arm and says why.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: () => Promise.resolve('eu-west-1') },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: 'us-east-1' },
      logger
    );
    expect(out[0]!.statefulReason).toBe('has-log-events');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Both regions named: the warning is only actionable if the user can see
    // WHICH two disagree.
    const warned = logger.warn.mock.calls[0]![0] as string;
    expect(warned).toContain('eu-west-1');
    expect(warned).toContain('us-east-1');
  });

  it('prints the recorded region FOLDED, not as stored', async () => {
    // The message compares two values, so it has to show the two values that
    // were compared: printing the raw record next to the folded client region
    // renders `(  US-EAST-1 )` and reads as a difference the check did not
    // actually make.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: () => Promise.resolve('eu-west-1') },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: '  US-EAST-1 ' },
      logger
    );
    const warned = logger.warn.mock.calls[0]![0] as string;
    expect(warned).toContain('(us-east-1)');
    expect(warned).not.toContain('US-EAST-1');
  });

  it('skips the region check entirely for a whitespace-only recorded region', async () => {
    // A blank record carries no information, so it must read as ABSENT (the
    // documented back-compat no-op) rather than as a region to compare
    // against — which is what `CloudControlProvider` does with its own.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    // A spy, not just a rejecting stub: the rejection would only prove there
    // was no observable CONSEQUENCE of consulting the client, while the claim
    // in this case's name is that it is not consulted at all.
    const regionFn = vi.fn(() => Promise.reject(new Error('config.region() must not be consulted')));
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: regionFn },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: '   ' },
      logger
    );
    expect(out[0]!.statefulReason).toBe(null);
    expect(regionFn).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not THROW when the client region cannot be resolved — it fails closed', async () => {
    // The probe's contract is that it never throws, and the only thing making
    // that true for a rejecting `config.region()` is that the `await` sits
    // INSIDE the try. Hoisting it out — the natural "resolve the region once"
    // refactor — leaves every other case green, so this is the one that pins
    // it. Measured: without the pin, that refactor passed the whole file.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: () => Promise.reject(new Error('Region is missing')) },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: 'us-east-1' },
      logger
    );
    expect(out[0]!.statefulReason).toBe('has-log-events');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The remedy has to match the CAUSE: nothing established a mismatch here,
    // so the message must not tell the user to fix one.
    const warned = logger.warn.mock.calls[0]![0] as string;
    expect(warned).toMatch(/region could not be resolved/);
    expect(warned).not.toMatch(/does not match/);
  });

  it('reports an EMPTY client region as unresolved, not as a mismatch', async () => {
    // `assertRegionMatch`'s unknown-region branch keys on falsiness, so `''`
    // takes the same path a rejection does — and `??` would have printed
    // `the client region ()`.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: () => Promise.resolve('') },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: 'us-east-1' },
      logger
    );
    expect(out[0]!.statefulReason).toBe('has-log-events');
    expect(logger.warn.mock.calls[0]![0] as string).toMatch(/region could not be resolved/);
  });

  it('accepts a recorded region carrying stray whitespace', async () => {
    // `canonicalizeRegion` only lower-cases; the trim is the other half of the
    // fold `CloudControlProvider` applies, and without it a padded state record
    // refuses a log group AWS says is gone.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: () => Promise.resolve('us-east-1') },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: '  us-east-1 ' },
      logger
    );
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a region that differs only in CASE from the recorded one', async () => {
    // A CDK manifest may spell the region `US-EAST-1` while the SDK resolves
    // `us-east-1`, and `assertRegionMatch` compares with `!==`. Without the
    // canonicalization an absent log group would be refused, and the refusal's
    // remedy is the flag that clears the data guard for the whole run.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: () => Promise.resolve('us-east-1') },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: 'US-EAST-1' },
      logger
    );
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('honours the not-found inference when the client region MATCHES the state region', async () => {
    // The other polarity of the same guard — without it, a mutation that made
    // the check always refuse would pass the case above.
    const notFound = new ResourceNotFoundException({
      message: 'The specified log group does not exist.',
      $metadata: {},
    });
    const client = {
      send: vi.fn(() => {
        throw notFound;
      }),
      config: { region: () => Promise.resolve('us-east-1') },
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      { s3: forbiddenS3Client(), cloudWatchLogs: client, expectedRegion: 'us-east-1' },
      logger
    );
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does NOT take the not-found arm for a look-alike message on a plain Error', async () => {
    // The discriminator is the TYPE, not the wording: a permission error
    // phrased "... does not exist" must still fail closed. Without this, a
    // future switch to a substring match would pass the case above.
    const logs = mockLogs({ throws: new Error('The specified log group does not exist.') });
    const logger = silentLogger();
    const out = await probe(logGroupTarget(), logs, logger);
    expect(out[0]!.statefulReason).toBe('has-log-events');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('refuses to read an ABSENT logStreams field as empty', async () => {
    // The SDK types `logStreams` optional
    // (`DescribeLogStreamsResponse.logStreams?: LogStream[]`), so an omitted
    // field is a legal response — and it says NOTHING about the group's
    // contents. An earlier revision read it as zero streams via `?.length ?? 0`
    // and passed the target through, which is the same "an unprovable
    // emptiness reads as empty" mistake #2558 exists to retire, one shape over.
    const client = {
      send: vi.fn(async () => ({})),
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probe(logGroupTarget(), { client }, logger);
    expect(out[0]!.statefulReason).toBe('has-log-events');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = String(logger.warn.mock.calls[0]![0]);
    expect(warned).toContain('no logStreams field in the response');
    // ACTIONABLE, to the same bar as the sibling probe-error warning below:
    // which resource, which log group, and the flag that clears the guard. A
    // warning naming only the shape leaves the user with no next step.
    expect(warned).toContain('MyLogGroup');
    expect(warned).toContain('/aws/lambda/my-fn');
    expect(warned).toContain('--force-stateful-recreation');
  });

  it('refuses to read an EMPTY PAGE carrying a continuation token as empty', async () => {
    // A `nextToken` means the listing is not finished, so this page's
    // emptiness is not the GROUP's emptiness. `limit: 1` makes this unlikely
    // in practice, but "unlikely" is not the standard a data guard gets to
    // use, and the API contract permits it.
    const client = {
      send: vi.fn(async () => ({ logStreams: [], nextToken: 'more-pages' })),
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probe(logGroupTarget(), { client }, logger);
    expect(out[0]!.statefulReason).toBe('has-log-events');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = String(logger.warn.mock.calls[0]![0]);
    expect(warned).toContain('an empty page carrying a continuation token');
    expect(warned).toContain('MyLogGroup');
    expect(warned).toContain('/aws/lambda/my-fn');
    expect(warned).toContain('--force-stateful-recreation');
  });

  it('clears the guard ONLY for a present, empty list with no continuation token', async () => {
    // The one proof shape, pinned next to the two non-answers above so the
    // pair cannot both be satisfied by a blanket "always promote". Without
    // this the fix would be indistinguishable from an unconditional refuse.
    const client = {
      send: vi.fn(async () => ({ logStreams: [], nextToken: undefined })),
    } as unknown as CloudWatchLogsClient;
    const logger = silentLogger();
    const out = await probe(logGroupTarget(), { client }, logger);
    expect(out[0]!.statefulReason).toBe(null);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('passes a has-retention log group through without probing', async () => {
    // The recorded bag already settled it, and the probe may not WEAKEN a
    // positive verdict — an empty-but-retaining group must stay refused, which
    // is the pre-#2558 behaviour this fix does not relax.
    const logs = mockLogs({ streams: 0 });
    const out = await probe(logGroupTarget({ statefulReason: 'has-retention' }), logs);
    expect(out[0]!.statefulReason).toBe('has-retention');
    expect(logs.sentCommands).toEqual([]);
  });

  it('renders the refusal for a promoted log group', async () => {
    const logs = mockLogs({ streams: 1 });
    const out = await probe(logGroupTarget(), logs);
    const validation = emptyValidation([
      out[0]! as RecreateTarget & { statefulReason: 'has-log-events' },
    ]);
    const error = renderRecreateTargetsErrors(validation);
    expect(error).toContain('MyLogGroup');
    expect(error).toContain('log group is not provably empty');
    // Pins the HEDGE, not a contrast with the bucket: since issue #2615 both
    // conditional reasons are hedged, so `log group is non-empty` is a wording
    // no arm emits. This reason also renders where nothing was probed at all.
    expect(error).not.toContain('log group is non-empty');
  });

  it('renders NO refusal for an empty log group — the allow-arm, end to end', async () => {
    // The offline twin of the integ fixture's phase 4
    // (`tests/integration/loggroup-never-expire-guard/verify.sh`), which
    // asserts exactly this pair against real AWS: no refusal text, and the
    // target still present so the recreate plan can name it. It is the
    // assertion that separates "the guard became conditional" from "the guard
    // refuses every log group", and a refuse-everything regression would
    // satisfy every other test in this describe block.
    const logs = mockLogs({ streams: 0 });
    // `emptyValidation` derives `targets` from the BLOCKED list, so the
    // un-blocked target is threaded in explicitly.
    const validated = await probeAndRevalidateStateful({
      validation: { ...emptyValidation([]), targets: [logGroupTarget()] },
      clients: { s3: forbiddenS3Client(), cloudWatchLogs: logs.client },
      forceStatefulRecreation: false,
    });
    expect(validated.blockedStatefulTargets).toEqual([]);
    expect(validated.targets.map((t) => t.logicalId)).toEqual(['MyLogGroup']);
    expect(renderRecreateTargetsErrors(validated)).toBeNull();
  });

  // Issue #2566. This arm fails CLOSED, so an unretried throttle does not
  // widen a hole — it REFUSES a deploy the user asked for, on a condition a
  // second call clears.
  it('retries a THROTTLED log-group probe and uses the retry’s answer', async () => {
    const throttle = new Error('Rate exceeded');
    throttle.name = 'ThrottlingException';
    const logs = mockLogs({ streams: 0, throwsOnce: throttle });
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      {
        s3: forbiddenS3Client(),
        cloudWatchLogs: logs.client,
        sleep: async (): Promise<void> => {},
      },
      silentLogger()
    );
    expect(logs.sentCommands).toHaveLength(2);
    // The retry's answer is a PROVABLY EMPTY group, so the guard clears.
    // Pre-fix the throttle reached the catch and refused with
    // `has-log-events`.
    expect(out[0]!.statefulReason).toBe(null);
  });

  it('gives up after a bounded number of attempts on a PERSISTENT throttle, and degrades to the log group’s CLOSED failure', async () => {
    const throttle = new Error('Rate exceeded');
    throttle.name = 'ThrottlingException';
    const logs = mockLogs({ throws: throttle });
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      {
        s3: forbiddenS3Client(),
        cloudWatchLogs: logs.client,
        sleep: async (): Promise<void> => {},
      },
      silentLogger()
    );
    expect(logs.sentCommands).toHaveLength(4);
    // The opposite posture to the S3 twin above, and deliberately so.
    expect(out[0]!.statefulReason).toBe('has-log-events');
  });

  it('does NOT retry a non-throttle log-group failure', async () => {
    const logs = mockLogs({ throws: new Error('AccessDeniedException') });
    const out = await probeStatefulRecreateTargetsAsync(
      [logGroupTarget()],
      {
        s3: forbiddenS3Client(),
        cloudWatchLogs: logs.client,
        sleep: async (): Promise<void> => {},
      },
      silentLogger()
    );
    expect(logs.sentCommands).toHaveLength(1);
    // Still the fail-CLOSED arm, unchanged.
    expect(out[0]!.statefulReason).toBe('has-log-events');
  });
});

describe('probeAndRevalidateStateful (#648)', () => {
  function s3Target(overrides: Partial<RecreateTarget> = {}): RecreateTarget {
    return {
      logicalId: 'MyBucket',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'bucket-pid',
      statefulReason: null,
      direction: 'to-cc-api',
      ...overrides,
    };
  }

  it('promotes the blockedStatefulTargets list when the probe finds objects', async () => {
    const send = vi.fn(async () => ({
      Versions: [{ Key: 'k', VersionId: 'v' }],
      DeleteMarkers: [],
    }));
    const s3 = { send } as unknown as S3Client;
    const validation = {
      targets: [s3Target()],
      unknownLogicalIds: [],
      missingFromState: [],
      ambiguousIntent: [],
      ambiguousIntentSdk: [],
      blockedStatefulTargets: [],
      blockedMultiRegionTargets: [],
      blockedAlreadySdk: [],
      blockedAlreadyCcApi: [],
      blockedNoSdkProvider: [],
      conflictingDirections: [],
    };
    const out = await probeAndRevalidateStateful({
      validation,
      clients: { s3, cloudWatchLogs: noLogGroupTargets() },
      forceStatefulRecreation: false,
    });
    expect(out.blockedStatefulTargets).toHaveLength(1);
    expect(out.blockedStatefulTargets[0]!.statefulReason).toBe('has-objects');
    // Rendering proves the new error block surfaces the bucket name.
    const error = renderRecreateTargetsErrors(out);
    expect(error).toContain('MyBucket');
    expect(error).toContain('S3 bucket is not provably empty');
  });

  it('composes the log-group promotion into blockedStatefulTargets and the rendered error', async () => {
    // The S3 case above covers the composition for the older type only; this
    // is the same walk for `AWS::Logs::LogGroup` end to end — probe promotes,
    // the blocked list picks it up, and the refusal names the resource and the
    // reason a user acts on.
    const s3 = {
      send: vi.fn(() => {
        throw new Error('no S3 target in this validation');
      }),
    } as unknown as S3Client;
    const cloudWatchLogs = {
      send: vi.fn(async () => ({ logStreams: [{ logStreamName: 'seeded' }] })),
    } as unknown as CloudWatchLogsClient;
    const target: RecreateTarget = {
      logicalId: 'MyLogGroup',
      resourceType: 'AWS::Logs::LogGroup',
      physicalId: '/aws/lambda/my-fn',
      statefulReason: null,
      direction: 'to-cc-api',
    };
    // An empty validation must issue no call at all — the surviving
    // `--force-stateful-recreation` case skips for a different reason, so
    // nothing else covers this one.
    const empty = await probeAndRevalidateStateful({
      validation: emptyValidation([]),
      clients: { s3, cloudWatchLogs },
      forceStatefulRecreation: false,
    });
    expect(empty.blockedStatefulTargets).toEqual([]);
    expect(vi.mocked(cloudWatchLogs.send)).not.toHaveBeenCalled();

    const withTarget = { ...emptyValidation([]), targets: [target] };
    const promotedOut = await probeAndRevalidateStateful({
      validation: withTarget,
      clients: { s3, cloudWatchLogs },
      forceStatefulRecreation: false,
    });
    expect(promotedOut.blockedStatefulTargets).toHaveLength(1);
    expect(promotedOut.blockedStatefulTargets[0]!.statefulReason).toBe('has-log-events');
    const error = renderRecreateTargetsErrors(promotedOut);
    expect(error).toContain('MyLogGroup');
    expect(error).toContain('log group is not provably empty');
  });

  it('returns validation untouched when --force-stateful-recreation is true (no AWS round-trip)', async () => {
    const send = vi.fn();
    const s3 = { send } as unknown as S3Client;
    const validation = {
      targets: [s3Target()],
      unknownLogicalIds: [],
      missingFromState: [],
      ambiguousIntent: [],
      ambiguousIntentSdk: [],
      blockedStatefulTargets: [],
      blockedMultiRegionTargets: [],
      blockedAlreadySdk: [],
      blockedAlreadyCcApi: [],
      blockedNoSdkProvider: [],
      conflictingDirections: [],
    };
    const out = await probeAndRevalidateStateful({
      validation,
      clients: { s3, cloudWatchLogs: noLogGroupTargets() },
      forceStatefulRecreation: true,
    });
    expect(out).toBe(validation);
    expect(send).not.toHaveBeenCalled();
  });
});

// Wiring pin — same shape as the resource-timeout registry pin in
// tests/unit/provisioning/resource-timeout-registry.test.ts.
//
// Both probes are only as correct as the CLIENTS they are handed, and nothing
// in this file's mocks can see that: every case above constructs its own
// doubles, so passing a wrong-REGION client (the state-bucket client instead of
// the deploy-region one) or wiring the wrong SERVICE leaves all of them green
// and is caught only by a real-AWS run. The S3 half was unpinned before issue
// #2558 too; the log-group client doubles the surface, so it is pinned here.
describe('deploy.ts hands the probes the DEPLOY-region clients (source-level pin)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const src = readFileSync(join(repoRoot, 'src', 'cli', 'commands', 'deploy.ts'), 'utf8');
  // Live lines only: a commented-out spelling must fail this pin, not satisfy
  // it — the failure mode a whole-file `toContain` walks straight into.
  const liveLines = src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');

  it('calls probeAndRevalidateStateful with both stack-region clients', () => {
    const callIdx = liveLines.indexOf('probeAndRevalidateStateful({');
    expect(callIdx, 'live probeAndRevalidateStateful call not found').toBeGreaterThan(-1);
    // Bound the window to the call itself, so a matching spelling elsewhere in
    // this 1000-line command cannot satisfy the pin.
    const call = liveLines.slice(callIdx, callIdx + 400);
    expect(call).toContain('s3: stackAwsClients.s3');
    expect(call).toContain('cloudWatchLogs: stackAwsClients.cloudWatchLogs');
    // And the state region, without which the probe's not-found-means-gone
    // inference runs unguarded (`region-check.ts`).
    expect(call).toContain('expectedRegion: stateForRecreateCheck?.state.region');
  });

  it('stackAwsClients is built for the STACK region, not the state-bucket region', () => {
    // The discriminator: `stackAwsClients` must be constructed with
    // `stackRegion`. A probe issued against `baseRegion` would report an
    // us-east-1 log group empty while the stack deploys to another region.
    const ctorIdx = liveLines.indexOf('const stackAwsClients = new AwsClients({');
    expect(ctorIdx, 'stackAwsClients construction not found').toBeGreaterThan(-1);
    expect(liveLines.slice(ctorIdx, ctorIdx + 200)).toContain('region: stackRegion');
  });
});
