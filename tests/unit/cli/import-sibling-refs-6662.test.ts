import { describe, it, expect } from 'vite-plus/test';
import {
  adoptedRefValue,
  dispatchInRefOrder,
  inRefOrder,
} from '../../../src/cli/commands/import/sibling-refs.js';
import type { ImportRow } from '../../../src/cli/commands/import/types.js';
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

describe('dispatchInRefOrder', () => {
  const zoneType = (logicalId: string) => ({
    logicalId,
    resource: { Type: 'AWS::Route53::HostedZone', Properties: {} } as TemplateResource,
  });
  const rows = (seen: Array<[string, Record<string, string>]>) =>
    async (
      entry: { logicalId: string; resource: TemplateResource },
      refValues: Map<string, string>
    ): Promise<ImportRow> => {
      seen.push([entry.logicalId, Object.fromEntries(refValues)]);
      return entry.resource.Type === 'AWS::Route53::HostedZone'
        ? {
            logicalId: entry.logicalId,
            resourceType: entry.resource.Type,
            outcome: 'imported',
            physicalId: 'ZADOPTED',
          }
        : { logicalId: entry.logicalId, resourceType: entry.resource.Type, outcome: 'skipped-not-found' };
    };

  it('hands a later row the Ref value of a zone adopted before it, and reports template order', async () => {
    const seen: Array<[string, Record<string, string>]> = [];
    const out = await dispatchInRefOrder(
      [res('Record', { HostedZoneId: { Ref: 'Zone' } }), zoneType('Zone')],
      new Map(),
      rows(seen)
    );
    expect(seen).toEqual([
      ['Zone', {}],
      ['Record', { Zone: 'ZADOPTED' }],
    ]);
    expect(out.map((r) => r.logicalId)).toEqual(['Record', 'Zone']);
  });

  it('keeps an override over the adopted value', async () => {
    const seen: Array<[string, Record<string, string>]> = [];
    await dispatchInRefOrder(
      [zoneType('Zone'), res('Record', { HostedZoneId: { Ref: 'Zone' } })],
      new Map([['Zone', 'ZOVERRIDE']]),
      rows(seen)
    );
    expect(seen[1]).toEqual(['Record', { Zone: 'ZOVERRIDE' }]);
  });
});
