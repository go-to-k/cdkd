import { describe, it, expect } from 'vite-plus/test';
import { withListenerRuleConditionOps } from '../../../src/provisioning/elbv2-listener-rule-patch.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const RULE = 'AWS::ElasticLoadBalancingV2::ListenerRule';
const TEMPLATE_CONDITIONS = [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/a*'] } }];
// What the Cloud Control read model (DescribeRules) carries for the same rule.
const READ_BACK_CONDITIONS = [
  { Field: 'path-pattern', Values: ['/a*'], PathPatternConfig: { Values: ['/a*'] } },
];
const ACTIONS: JsonPatchOp = {
  op: 'replace',
  path: '/Actions',
  value: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200' } }],
};

describe('withListenerRuleConditionOps (go-to-k/cdkd#6663)', () => {
  it('adds the desired conditions to a patch that does not touch them', () => {
    expect(
      withListenerRuleConditionOps(RULE, [ACTIONS], { Conditions: TEMPLATE_CONDITIONS })
    ).toEqual([ACTIONS, { op: 'add', path: '/Conditions', value: TEMPLATE_CONDITIONS }]);
  });

  it('drops the echoed Values from a read-back desired bag (drift --revert)', () => {
    expect(
      withListenerRuleConditionOps(RULE, [{ op: 'replace', path: '/Priority', value: 10 }], {
        Conditions: READ_BACK_CONDITIONS,
      })
    ).toEqual([
      { op: 'replace', path: '/Priority', value: 10 },
      { op: 'add', path: '/Conditions', value: TEMPLATE_CONDITIONS },
    ]);
  });

  it('drops the echoed Values from an existing Conditions op and keeps its op', () => {
    expect(
      withListenerRuleConditionOps(
        RULE,
        [{ op: 'replace', path: '/Conditions', value: READ_BACK_CONDITIONS }],
        { Conditions: READ_BACK_CONDITIONS }
      )
    ).toEqual([{ op: 'replace', path: '/Conditions', value: TEMPLATE_CONDITIONS }]);
  });

  it('keeps a host-header echo out and leaves a config-only condition alone', () => {
    const conditions = [
      { Field: 'host-header', Values: ['a.example.com'], HostHeaderConfig: { Values: ['a.example.com'] } },
      { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Hunt', Values: ['yes'] } },
    ];
    expect(withListenerRuleConditionOps(RULE, [ACTIONS], { Conditions: conditions })).toEqual([
      ACTIONS,
      {
        op: 'add',
        path: '/Conditions',
        value: [
          { Field: 'host-header', HostHeaderConfig: { Values: ['a.example.com'] } },
          conditions[1],
        ],
      },
    ]);
  });

  it('keeps a legacy Values-only condition and a Values differing from its config', () => {
    const conditions = [
      { Field: 'path-pattern', Values: ['/legacy*'] },
      { Field: 'path-pattern', Values: ['/x*'], PathPatternConfig: { Values: ['/y*'] } },
    ];
    expect(withListenerRuleConditionOps(RULE, [ACTIONS], { Conditions: conditions })).toEqual([
      ACTIONS,
      { op: 'add', path: '/Conditions', value: conditions },
    ]);
  });

  it('leaves a remove op on /Conditions as written', () => {
    const patch: JsonPatchOp[] = [{ op: 'remove', path: '/Conditions' }];
    expect(withListenerRuleConditionOps(RULE, patch, {})).toBe(patch);
  });

  it('returns the same array for another type, an empty patch, or no Conditions list', () => {
    const patch: JsonPatchOp[] = [ACTIONS];
    expect(
      withListenerRuleConditionOps('AWS::ElasticLoadBalancingV2::Listener', patch, {
        Conditions: TEMPLATE_CONDITIONS,
      })
    ).toBe(patch);
    const empty: JsonPatchOp[] = [];
    expect(withListenerRuleConditionOps(RULE, empty, { Conditions: TEMPLATE_CONDITIONS })).toBe(
      empty
    );
    expect(withListenerRuleConditionOps(RULE, patch, {})).toBe(patch);
  });
});
