import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  ecsServiceLaunchTypeSetOrChanged,
} from '../../../src/analyzer/replacement-rules.js';

/**
 * `AWS::ECS::Service.LaunchType` (go-to-k/cdkd#5392). `UpdateService` has no
 * `launchType` member and the schema does not mark it createOnly. A real
 * CloudFormation A/B measured: a VARY and an ADD replace the service (the add
 * even when the live value already matched), while a REMOVE updates in place
 * and keeps the live launch type.
 */
describe('ReplacementRulesRegistry — AWS::ECS::Service.LaunchType', () => {
  const registry = new ReplacementRulesRegistry();
  const TYPE = 'AWS::ECS::Service';

  it('replaces on a changed or added LaunchType', () => {
    expect(registry.requiresReplacement(TYPE, 'LaunchType', 'EC2', 'EXTERNAL')).toBe(true);
    expect(registry.requiresReplacement(TYPE, 'LaunchType', undefined, 'EC2')).toBe(true);
  });

  it('updates in place on a removal or an unchanged value', () => {
    expect(registry.requiresReplacement(TYPE, 'LaunchType', 'EXTERNAL', undefined)).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'LaunchType', 'FARGATE', 'FARGATE')).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'LaunchType', undefined, undefined)).toBe(false);
  });

  it('is classified, so the createOnly fallback never overrides it', () => {
    expect(registry.isClassified(TYPE, 'LaunchType')).toBe(true);
  });

  it('reads presence with == null and replaces on an unresolved intrinsic', () => {
    expect(ecsServiceLaunchTypeSetOrChanged('EC2', null)).toBe(false);
    expect(ecsServiceLaunchTypeSetOrChanged('EC2', { Ref: 'Lt' })).toBe(true);
  });

  it('leaves every other property to the registry schema fallback', () => {
    for (const key of ['Cluster', 'ServiceName', 'Role', 'SchedulingStrategy', 'Tags']) {
      expect(registry.isClassified(TYPE, key)).toBe(false);
    }
  });
});
