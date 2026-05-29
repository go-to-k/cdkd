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
import type { S3Client } from '@aws-sdk/client-s3';

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
              RecursiveLoop: 'Allow', // silent-drop property
            },
          },
        },
      };
      const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyLambda'],
        allowUnsupportedProperties: new Set(['AWS::Lambda::Function:RecursiveLoop']),
        forceStatefulRecreation: false,
      });
      expect(v.ambiguousIntent).toEqual([
        { logicalId: 'MyLambda', resourceType: 'AWS::Lambda::Function', property: 'RecursiveLoop' },
      ]);
      const error = renderRecreateTargetsErrors(v);
      expect(error).toContain('Ambiguous intent');
      expect(error).toContain('RecursiveLoop');
      expect(error).toMatch(/pick ONE strategy per resource/);
    });

    it('does NOT report overlap when --allow-unsupported-properties names a different property than the template uses', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyLambda: {
            Type: 'AWS::Lambda::Function',
            Properties: { FunctionName: 'foo', RecursiveLoop: 'Allow' },
          },
        },
      };
      const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
      // Allow-set covers SnapStart, not RecursiveLoop — the template's
      // actual silent-drop property is RecursiveLoop, so no overlap fires.
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
            Properties: { FunctionName: 'foo' /* no RecursiveLoop */ },
          },
        },
      };
      const state = st('S', { PlainLambda: res('AWS::Lambda::Function') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['PlainLambda'],
        allowUnsupportedProperties: new Set(['AWS::Lambda::Function:RecursiveLoop']),
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

    it('LogGroup is conditional: blocked only when RetentionInDays > 0', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          KeptLogs: { Type: 'AWS::Logs::LogGroup', Properties: {} },
          EphemeralLogs: { Type: 'AWS::Logs::LogGroup', Properties: {} },
        },
      };
      const state = st('S', {
        KeptLogs: res('AWS::Logs::LogGroup', {
          properties: { RetentionInDays: 30 },
        }),
        EphemeralLogs: res('AWS::Logs::LogGroup', { properties: {} }),
      });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['KeptLogs', 'EphemeralLogs'],
        allowUnsupportedProperties: new Set(),
        forceStatefulRecreation: false,
      });
      // Only KeptLogs blocked (RetentionInDays > 0); EphemeralLogs passes.
      expect(v.blockedStatefulTargets).toHaveLength(1);
      expect(v.blockedStatefulTargets[0]!.logicalId).toBe('KeptLogs');
      expect(v.blockedStatefulTargets[0]!.statefulReason).toBe('has-retention');
      const ephemeral = v.targets.find((t) => t.logicalId === 'EphemeralLogs');
      expect(ephemeral?.statefulReason).toBe(null);
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
          Properties: { RecursiveLoop: 'Allow' },
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
      allowUnsupportedProperties: new Set(['AWS::Lambda::Function:RecursiveLoop']),
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
          Properties: { RecursiveLoop: 'Allow' },
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
      // RecursiveLoop NOT in --allow-unsupported-properties → next deploy
      // would auto-route the recreated SDK resource back to CC.
      allowUnsupportedProperties: new Set(),
      forceStatefulRecreation: false,
      hasSdkProvider: () => true,
    });
    expect(v.ambiguousIntentSdk.map((a) => a.logicalId)).toEqual(['MyLambda']);
    const error = renderRecreateTargetsErrors(v);
    expect(error).toContain('IMMEDIATELY be re-routed back to Cloud Control');
    expect(error).toContain('RecursiveLoop');
  });

  it('inverse ambiguous-intent: PASSES when the silent-drop property IS in --allow-unsupported-properties', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { RecursiveLoop: 'Allow' },
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
      allowUnsupportedProperties: new Set(['AWS::Lambda::Function:RecursiveLoop']),
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

  function mockS3({
    versions,
    deleteMarkers,
    throws,
  }: {
    versions?: number;
    deleteMarkers?: number;
    throws?: Error;
  }): { client: S3Client; sentCommands: unknown[] } {
    const sentCommands: unknown[] = [];
    const send = vi.fn(async (cmd: unknown) => {
      sentCommands.push(cmd);
      if (throws) throw throws;
      return {
        Versions: Array.from({ length: versions ?? 0 }, (_, i) => ({
          Key: `k${i}`,
          VersionId: `v${i}`,
        })),
        DeleteMarkers: Array.from({ length: deleteMarkers ?? 0 }, (_, i) => ({
          Key: `d${i}`,
          VersionId: `dv${i}`,
        })),
      };
    });
    return { client: { send } as unknown as S3Client, sentCommands };
  }

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
    const out = await probeStatefulRecreateTargetsAsync([s3Target()], client, silentLogger());
    expect(out).toHaveLength(1);
    expect(out[0]!.statefulReason).toBe('has-objects');
  });

  it('promotes statefulReason to has-objects when the bucket has only delete-markers (versioned bucket where current keys are soft-deleted)', async () => {
    const { client } = mockS3({ versions: 0, deleteMarkers: 1 });
    const out = await probeStatefulRecreateTargetsAsync([s3Target()], client, silentLogger());
    expect(out[0]!.statefulReason).toBe('has-objects');
  });

  it('leaves statefulReason at null when ListObjectVersions returns no versions and no delete-markers', async () => {
    const { client } = mockS3({ versions: 0, deleteMarkers: 0 });
    const out = await probeStatefulRecreateTargetsAsync([s3Target()], client, silentLogger());
    expect(out[0]!.statefulReason).toBe(null);
  });

  it('soft-fails on probe error — logs a warn and leaves the sync result in place', async () => {
    const { client } = mockS3({ throws: new Error('AccessDenied') });
    const logger = silentLogger();
    const out = await probeStatefulRecreateTargetsAsync([s3Target()], client, logger);
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
        },
      ],
      client,
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe(null);
    expect(sentCommands).toHaveLength(0);
  });

  it('passes through S3 targets whose sync reason is already non-null without probing', async () => {
    const { client, sentCommands } = mockS3({ versions: 99 });
    const out = await probeStatefulRecreateTargetsAsync(
      [s3Target({ statefulReason: 'always' })],
      client,
      silentLogger()
    );
    expect(out[0]!.statefulReason).toBe('always');
    expect(sentCommands).toHaveLength(0);
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
      s3Client: s3,
      forceStatefulRecreation: false,
    });
    expect(out.blockedStatefulTargets).toHaveLength(1);
    expect(out.blockedStatefulTargets[0]!.statefulReason).toBe('has-objects');
    // Rendering proves the new error block surfaces the bucket name.
    const error = renderRecreateTargetsErrors(out);
    expect(error).toContain('MyBucket');
    expect(error).toContain('S3 bucket is non-empty');
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
      s3Client: s3,
      forceStatefulRecreation: true,
    });
    expect(out).toBe(validation);
    expect(send).not.toHaveBeenCalled();
  });
});
