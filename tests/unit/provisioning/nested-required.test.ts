/**
 * Pre-flight nested `required` check (issue #1802).
 *
 * The behaviors every case below varies:
 *
 * - A PRESENT nested block missing a required member is refused; an ABSENT
 *   block never is.
 * - Anything behind an unresolved intrinsic is UNKNOWN and passes, and a member
 *   is present when its KEY is, whatever the value.
 * - Only types CloudFormation was measured to enforce are checked at all.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  CFN_ENFORCED_TYPES,
  buildNestedRequiredMessage,
  findNestedRequiredViolations,
} from '../../../src/provisioning/nested-required.js';
import { NESTED_REQUIRED } from '../../../src/provisioning/nested-required.generated.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

const ECS = 'AWS::ECS::Service';
const ROLE = 'AWS::IAM::Role';

function violations(
  resourceType: string,
  properties: Record<string, unknown> | undefined
): Array<[string, readonly string[]]> {
  return findNestedRequiredViolations(resourceType, properties).map((v) => [v.path, v.missing]);
}

describe('findNestedRequiredViolations against the shipped table', () => {
  it('refuses a kept DeploymentCircuitBreaker without Rollback (the measured #1802 case)', () => {
    expect(
      violations(ECS, {
        Cluster: 'c',
        DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: false } },
      })
    ).toEqual([['DeploymentConfiguration.DeploymentCircuitBreaker', ['Rollback']]]);
  });

  it('names every missing member of an empty block', () => {
    expect(violations(ECS, { DeploymentConfiguration: { Alarms: {} } })).toEqual([
      ['DeploymentConfiguration.Alarms', ['AlarmNames', 'Enable', 'Rollback']],
    ]);
  });

  it('accepts a complete block, including falsy member values', () => {
    expect(
      violations(ECS, {
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: false, Rollback: false },
          Alarms: { AlarmNames: [], Enable: 0, Rollback: null },
        },
      })
    ).toEqual([]);
  });

  it('never refuses an ABSENT block', () => {
    expect(violations(ECS, { DeploymentConfiguration: {} })).toEqual([]);
    expect(violations(ECS, {})).toEqual([]);
    expect(violations(ECS, undefined)).toEqual([]);
  });

  it('checks each array element and indexes the path', () => {
    const policy = { PolicyName: 'p', PolicyDocument: { Version: '2012-10-17', Statement: [] } };
    expect(
      violations(ROLE, {
        AssumeRolePolicyDocument: {},
        Policies: [policy, { PolicyName: 'q' }, { PolicyDocument: {} }],
      })
    ).toEqual([
      ['Policies[1]', ['PolicyDocument']],
      ['Policies[2]', ['PolicyName']],
    ]);
  });

  it('treats a member whose value is an intrinsic as present', () => {
    expect(
      violations(ECS, {
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: {
            Enable: true,
            Rollback: { 'Fn::If': ['C', true, { Ref: 'AWS::NoValue' }] },
          },
        },
      })
    ).toEqual([]);
  });

  it('skips a block, an array, an element or the whole bag behind an unresolved intrinsic', () => {
    expect(
      violations(ECS, {
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { 'Fn::If': ['C', { Enable: true }, { Ref: 'AWS::NoValue' }] },
        },
      })
    ).toEqual([]);
    expect(violations(ECS, { DeploymentConfiguration: { Ref: 'Param' } })).toEqual([]);
    // Any `Fn::*`, not only `Fn::If`: a GetAtt / ImportValue / FindInMap block
    // resolves to a shape pre-flight cannot see.
    for (const fn of ['Fn::GetAtt', 'Fn::ImportValue', 'Fn::FindInMap']) {
      expect(
        violations(ECS, { DeploymentConfiguration: { DeploymentCircuitBreaker: { [fn]: ['x'] } } })
      ).toEqual([]);
    }
    expect(violations(ROLE, { Policies: { 'Fn::If': ['C', [{}], []] } })).toEqual([]);
    expect(violations(ROLE, { Policies: [{ 'Fn::If': ['C', {}, {}] }] })).toEqual([]);
    expect(
      violations(ECS, { 'Fn::If': ['C', { DeploymentConfiguration: { Alarms: {} } }, {}] })
    ).toEqual([]);
  });

  it('skips a value that is not an object at all (a scalar or string where a block goes)', () => {
    expect(violations(ECS, { DeploymentConfiguration: 'oops' })).toEqual([]);
    expect(violations(ECS, { DeploymentConfiguration: { DeploymentCircuitBreaker: 1 } })).toEqual(
      []
    );
  });

  it('reads own keys only: an inherited member name is not "present"', () => {
    // `constructor` answers `in` through the prototype chain; a check using
    // `in` would call a block present whose required member is named that.
    const table = new Map([['Block', ['constructor']]]);
    expect(
      findNestedRequiredViolations('T', { Block: {} }, table).map((v) => v.missing)
    ).toEqual([['constructor']]);
  });

  it('reads own keys only on the path too: an inherited segment name does not walk', () => {
    // `__proto__` answers `in` on every plain object and indexes to
    // `Object.prototype` — a concrete object an `in` walk would then refuse.
    const table = new Map([['__proto__', ['Y']]]);
    expect(findNestedRequiredViolations('T', {}, table)).toEqual([]);
    const own = JSON.parse('{"__proto__": {}}') as Record<string, unknown>;
    expect(findNestedRequiredViolations('T', own, table).map((v) => v.path)).toEqual(['__proto__']);
  });

  it('does not check a type CloudFormation was measured NOT to enforce', () => {
    // Non-vacuous: the table DOES list the tag requirement for this type, and
    // CloudFormation measured accepting a tag with neither member.
    expect(NESTED_REQUIRED.get('AWS::Logs::LogGroup')?.get('Tags')).toEqual(['Key', 'Value']);
    expect(CFN_ENFORCED_TYPES.has('AWS::Logs::LogGroup')).toBe(false);
    expect(violations('AWS::Logs::LogGroup', { Tags: [{}] })).toEqual([]);
  });

  it('does not check a type with no table entry', () => {
    expect(violations('Custom::Thing', { Anything: {} })).toEqual([]);
  });

  it('has a table entry for every enforced type (a rename or removal would silently disable it)', () => {
    const missing = [...CFN_ENFORCED_TYPES].filter((t) => !NESTED_REQUIRED.has(t));
    expect(missing).toEqual([]);
    expect(CFN_ENFORCED_TYPES.size).toBeGreaterThanOrEqual(78);
  });
});

describe('findNestedRequiredViolations path walking (explicit table)', () => {
  it('walks through arrays at any depth, arrays transparent in the path key', () => {
    const table = new Map([['Outer.Inner', ['Name']]]);
    const found = findNestedRequiredViolations(
      'T',
      {
        Outer: [{ Inner: [{ Name: 'a' }, {}] }, { Inner: {} }, {}, [[{ Inner: { X: 1 } }]]],
      },
      table
    ).map((v) => v.path);
    expect(found).toEqual([
      'Outer[0].Inner[1]',
      'Outer[1].Inner',
      'Outer[3][0][0].Inner',
    ]);
  });
});

describe('buildNestedRequiredMessage', () => {
  it('names the resource, type, path and missing members', () => {
    expect(
      buildNestedRequiredMessage('Svc', {
        resourceType: ECS,
        path: 'DeploymentConfiguration.Alarms',
        missing: ['Enable', 'Rollback'],
      })
    ).toBe(
      '  - Svc (AWS::ECS::Service): DeploymentConfiguration.Alarms is missing required members Enable, Rollback'
    );
    expect(
      buildNestedRequiredMessage('Svc', { resourceType: ECS, path: 'P', missing: ['Rollback'] })
    ).toContain('is missing required member Rollback');
  });
});

describe('ProviderRegistry wiring', () => {
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

  const partial = (logicalId: string) => ({
    logicalId,
    resourceType: ECS,
    properties: { DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true } } },
  });

  it('validateResourceProperties refuses, aggregating every offending resource into ONE error', () => {
    let message = '';
    try {
      makeRegistry().validateResourceProperties([partial('SvcA'), partial('SvcB')]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      'SvcA (AWS::ECS::Service): DeploymentConfiguration.DeploymentCircuitBreaker is missing required member Rollback'
    );
    expect(message).toContain('SvcB (AWS::ECS::Service)');
    expect(message).toContain('without a member it requires');
  });

  it('accepts a complete block and an absent one', () => {
    expect(() =>
      makeRegistry().validateResourceProperties([
        {
          logicalId: 'Ok',
          resourceType: ECS,
          properties: {
            DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
          },
        },
        { logicalId: 'Absent', resourceType: ECS, properties: { Cluster: 'c' } },
      ])
    ).not.toThrow();
  });
});
