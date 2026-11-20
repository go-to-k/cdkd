import { describe, it, expect } from 'vite-plus/test';
import {
  adoptedRefValue,
  inRefOrder,
} from '../../../src/cli/commands/import/sibling-refs.js';
import type { TemplateResource } from '../../../src/types/resource.js';

// go-to-k/cdkd#6662: `cdkd import` dispatches a `Ref` target before the
// resources naming it, so the target's adopted id can be substituted.

const res = (logicalId: string, properties: Record<string, unknown> = {}) => ({
  logicalId,
  resource: { Type: 'AWS::Route53::RecordSet', Properties: properties } as TemplateResource,
});

describe('inRefOrder', () => {
  it('places a Ref target, at any depth, before the resource naming it', () => {
    const order = inRefOrder([
      res('Record', { HostedZoneId: { Ref: 'Zone' } }),
      res('Group', { RecordSets: [{ AliasTarget: { HostedZoneId: { Ref: 'Zone' } } }] }),
      res('Zone'),
    ]).map((r) => r.logicalId);
    expect(order).toEqual(['Zone', 'Record', 'Group']);
  });

  it('keeps template order otherwise, and ignores a Ref to a parameter or itself', () => {
    const order = inRefOrder([
      res('B', { X: { Ref: 'Param' } }),
      res('A', { X: { Ref: 'A' } }),
    ]).map((r) => r.logicalId);
    expect(order).toEqual(['B', 'A']);
  });

  it('terminates on a cycle', () => {
    const order = inRefOrder([res('A', { X: { Ref: 'B' } }), res('B', { X: { Ref: 'A' } })]);
    expect(order.map((r) => r.logicalId).sort()).toEqual(['A', 'B']);
  });
});

describe('adoptedRefValue', () => {
  it("is CloudFormation's Ref value for an imported row", () => {
    expect(
      adoptedRefValue({
        logicalId: 'Zone',
        resourceType: 'AWS::Route53::HostedZone',
        outcome: 'imported',
        physicalId: 'Z123',
      })
    ).toBe('Z123');
    // A compound id yields the segment CloudFormation's Ref returns.
    expect(
      adoptedRefValue({
        logicalId: 'Rec',
        resourceType: 'AWS::Route53::RecordSet',
        outcome: 'imported',
        physicalId: 'Z123|www.example.com.|A',
      })
    ).toBe('www.example.com.');
  });

  it('is undefined for a row that was not imported', () => {
    expect(
      adoptedRefValue({
        logicalId: 'Zone',
        resourceType: 'AWS::Route53::HostedZone',
        outcome: 'skipped-not-found',
      })
    ).toBeUndefined();
  });
});
