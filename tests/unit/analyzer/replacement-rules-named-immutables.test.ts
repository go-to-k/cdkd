import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * Regression coverage for the missing-replacement-rule bug class (bug-hunt
 * 2026-06-29 Round 5). These four types have an immutable NAME in CloudFormation
 * ("Update requires: Replacement") but had no registry rule, so the registry
 * defaulted them to updateable and a rename was attempted as an in-place update:
 *   - StepFunctions StateMachine: in-place UpdateStateMachine has no Name -> dropped
 *   - Events Rule / CloudWatch Alarm: PutRule/PutMetricAlarm with the new name
 *     CREATES a second resource and ORPHANS the old one
 *   - SSM Parameter: rename never created the new-named param
 * All silently diverged cdkd state from AWS. The fix adds replacement rules so a
 * rename drives DELETE + CREATE.
 */
const CASES: Array<{ type: string; nameProp: string; updatable: string[] }> = [
  {
    type: 'AWS::StepFunctions::StateMachine',
    nameProp: 'StateMachineName',
    updatable: ['DefinitionString', 'RoleArn', 'LoggingConfiguration', 'TracingConfiguration', 'Tags'],
  },
  {
    type: 'AWS::Events::Rule',
    nameProp: 'Name',
    updatable: ['ScheduleExpression', 'EventPattern', 'State', 'Description', 'Targets', 'RoleArn'],
  },
  {
    type: 'AWS::SSM::Parameter',
    nameProp: 'Name',
    updatable: ['Value', 'Description', 'Tier', 'AllowedPattern', 'Tags'],
  },
  {
    type: 'AWS::CloudWatch::Alarm',
    nameProp: 'AlarmName',
    updatable: ['Threshold', 'EvaluationPeriods', 'ComparisonOperator', 'Metrics', 'AlarmActions', 'Tags'],
  },
];

describe('ReplacementRulesRegistry — immutable-name types (SFN / Events Rule / SSM Param / CW Alarm)', () => {
  const registry = new ReplacementRulesRegistry();

  for (const c of CASES) {
    it(`requires replacement when ${c.type} ${c.nameProp} changes`, () => {
      expect(registry.requiresReplacement(c.type, c.nameProp, 'a', 'b')).toBe(true);
    });

    it.each(c.updatable)(`does NOT require replacement when ${c.type} %s changes`, (prop) => {
      expect(registry.requiresReplacement(c.type, prop, 'old', 'new')).toBe(false);
    });
  }

  it('SFN StateMachineType change requires replacement (STANDARD <-> EXPRESS)', () => {
    expect(
      registry.requiresReplacement('AWS::StepFunctions::StateMachine', 'StateMachineType', 'STANDARD', 'EXPRESS')
    ).toBe(true);
  });

  it('Events Rule EventBusName change requires replacement', () => {
    expect(registry.requiresReplacement('AWS::Events::Rule', 'EventBusName', 'a', 'b')).toBe(true);
  });
});
