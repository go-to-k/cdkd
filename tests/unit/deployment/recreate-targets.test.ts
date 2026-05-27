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

import { describe, it, expect } from 'vite-plus/test';
import {
  validateRecreateTargets,
  renderRecreateTargetsErrors,
} from '../../../src/deployment/recreate-targets.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

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
      { logicalId: 'MyLambda', resourceType: 'AWS::Lambda::Function', physicalId: 'foo', statefulReason: null },
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
              LoggingConfig: { LogFormat: 'JSON' }, // silent-drop property
            },
          },
        },
      };
      const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['MyLambda'],
        allowUnsupportedProperties: new Set(['AWS::Lambda::Function:LoggingConfig']),
        forceStatefulRecreation: false,
      });
      expect(v.ambiguousIntent).toEqual([
        { logicalId: 'MyLambda', resourceType: 'AWS::Lambda::Function', property: 'LoggingConfig' },
      ]);
      const error = renderRecreateTargetsErrors(v);
      expect(error).toContain('Ambiguous intent');
      expect(error).toContain('LoggingConfig');
      expect(error).toMatch(/pick ONE strategy per resource/);
    });

    it('does NOT report overlap when --allow-unsupported-properties names a different property than the template uses', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          MyLambda: {
            Type: 'AWS::Lambda::Function',
            Properties: { FunctionName: 'foo', LoggingConfig: { LogFormat: 'JSON' } },
          },
        },
      };
      const state = st('S', { MyLambda: res('AWS::Lambda::Function') });
      // Allow-set covers SnapStart, not LoggingConfig — the template's
      // actual silent-drop property is LoggingConfig, so no overlap fires.
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
            Properties: { FunctionName: 'foo' /* no LoggingConfig */ },
          },
        },
      };
      const state = st('S', { PlainLambda: res('AWS::Lambda::Function') });
      const v = validateRecreateTargets({
        template,
        state,
        recreateViaCcApi: ['PlainLambda'],
        allowUnsupportedProperties: new Set(['AWS::Lambda::Function:LoggingConfig']),
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
          Properties: { LoggingConfig: { LogFormat: 'JSON' } },
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
      allowUnsupportedProperties: new Set(['AWS::Lambda::Function:LoggingConfig']),
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
