import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { buildStackState, reimportedAttributes } from '../../../src/cli/commands/import.js';
import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * Issue #2927: a re-import could not clear a masked attributes bag, and — the
 * inverse shape recorded on the same issue — a re-import whose Cloud Control
 * readback masked keys REPLACED a good deploy-recorded bag with masks.
 */
describe('reimportedAttributes (issue #2927)', () => {
  const M = SECRET_MASK;

  it('keeps a same-id unmasked value over a masked one, per key', () => {
    const { attributes, stillMaskedKeys } = reimportedAttributes(
      { Arn: 'arn:new', Endpoint: { Address: M, Port: M }, Token: M },
      { Arn: 'arn:old', Endpoint: { Address: 'db.example.com', Port: 5432 }, Token: M }
    );
    // The certified sibling takes the FRESH value; only the masked keys fall back.
    expect(attributes).toEqual({
      Arn: 'arn:new',
      Endpoint: { Address: 'db.example.com', Port: 5432 },
      Token: M,
    });
    expect(stillMaskedKeys).toEqual(['Token']);
  });

  it('names every key whose recorded value was kept over a mask', () => {
    expect(
      reimportedAttributes(
        { Arn: 'arn:new', B: M, A: { X: M }, C: M },
        { Arn: 'arn:old', B: 'b', A: { X: 1 }, C: M }
      ).keptRecordedKeys
    ).toEqual(['A', 'B']);
  });

  it('carries a masked prior key a partial row omits, and reports it', () => {
    const { attributes, stillMaskedKeys } = reimportedAttributes(
      { Id: 'x' },
      { Id: 'x', Token: M, Plain: 'dropped' }
    );
    // Masked: carried (dropping it would resolve Fn::GetAtt to the physical id).
    // Unmasked: dropped, the #1098 partial-map contract.
    expect(attributes).toEqual({ Id: 'x', Token: M });
    expect(stillMaskedKeys).toEqual(['Token']);
  });

  it('keeps the mask when prior has no value for that key', () => {
    const { attributes, stillMaskedKeys } = reimportedAttributes(
      { Arn: 'arn:new', Secret: M },
      { Arn: 'arn:old' }
    );
    expect(attributes).toEqual({ Arn: 'arn:new', Secret: M });
    // Masked only by THIS import, not carried from a prior mask.
    expect(stillMaskedKeys).toEqual([]);
  });

  it('an empty readback keeps a masked prior bag and names every masked key', () => {
    const prior = { Arn: 'arn:old', Token: M, Nested: { Deep: [M] } };
    const { attributes, stillMaskedKeys } = reimportedAttributes({}, prior);
    // Kept, NOT cleared: an absent key resolves to the physical id.
    expect(attributes).toEqual(prior);
    expect(stillMaskedKeys).toEqual(['Nested', 'Token']);
  });

  it('an absent readback behaves like an empty one', () => {
    expect(reimportedAttributes(undefined, { Token: M })).toEqual({
      attributes: { Token: M },
      stillMaskedKeys: ['Token'],
      keptRecordedKeys: [],
    });
  });

  it('a fresh unmasked value clears a prior mask and is not reported', () => {
    const { attributes, stillMaskedKeys } = reimportedAttributes(
      { Token: 'certified' },
      { Token: M }
    );
    expect(attributes).toEqual({ Token: 'certified' });
    expect(stillMaskedKeys).toEqual([]);
  });

  it('a non-empty row still drops unmasked keys it omits (#1098 partial-map contract)', () => {
    expect(reimportedAttributes({ Id: 'x' }, { Id: 'x', Other: 'y' }).attributes).toEqual({
      Id: 'x',
    });
  });

  it('with no prior, returns the row as-is and reports nothing', () => {
    const row = { Token: M };
    const result = reimportedAttributes(row, undefined);
    expect(result.attributes).toBe(row);
    expect(result.stillMaskedKeys).toEqual([]);
  });

  it('keeps an own __proto__ key and the row prototype when merging', () => {
    const row = JSON.parse(`{"__proto__": "${M}", "Arn": "a"}`) as Record<string, unknown>;
    const nullProtoRow = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(row)) {
      Object.defineProperty(nullProtoRow, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const prior = JSON.parse('{"__proto__": "real"}') as Record<string, unknown>;
    const { attributes } = reimportedAttributes(nullProtoRow, prior);
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(Object.keys(attributes)).toEqual(['__proto__', 'Arn']);
    expect(Object.getOwnPropertyDescriptor(attributes, '__proto__')?.value).toBe('real');
  });
});

describe('buildStackState on a re-import (issue #2927)', () => {
  const template: CloudFormationTemplate = {
    Resources: { Db: { Type: 'AWS::Some::Thing', Properties: {} } },
  };
  const existing = (physicalId: string, attributes: Record<string, unknown>) =>
    ({
      version: 10,
      stackName: 'Stack',
      region: 'us-east-1',
      resources: {
        Db: {
          physicalId,
          resourceType: 'AWS::Some::Thing',
          properties: {},
          attributes,
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    }) as Parameters<typeof buildStackState>[5];
  const build = (
    attributes: Record<string, unknown>,
    prior: Parameters<typeof buildStackState>[5]
  ) =>
    buildStackState(
      'Stack',
      'us-east-1',
      [
        {
          logicalId: 'Db',
          resourceType: 'AWS::Some::Thing',
          outcome: 'imported',
          physicalId: 'db-1',
          attributes,
        },
      ],
      new TemplateParser(),
      template,
      prior,
      true
    );

  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    info = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  it('a masked readback no longer overwrites a good deploy-recorded bag', () => {
    const state = build(
      { Arn: 'arn:db', Address: SECRET_MASK },
      existing('db-1', { Arn: 'arn:db', Address: 'db.example.com' })
    );
    expect(state.resources['Db']!.attributes).toEqual({
      Arn: 'arn:db',
      Address: 'db.example.com',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain(
      'Db: this import recorded Address only as the redaction mask, so the previously recorded value is kept'
    );
  });

  it('an empty readback over a masked bag keeps it AND warns naming the key', () => {
    const state = build({}, existing('db-1', { Arn: 'arn:db', Address: SECRET_MASK }));
    expect(state.resources['Db']!.attributes).toEqual({ Arn: 'arn:db', Address: SECRET_MASK });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('Db');
    expect(line).toContain('Address');
    expect(line).toContain(
      'Db: this import produced no value to replace the redaction mask recorded under Address,'
    );
    expect(line).toContain('is still refused at deploy');
    expect(line).not.toContain('Arn');
  });

  it('a repointed physical id inherits nothing and does not warn', () => {
    const state = build(
      { Address: SECRET_MASK },
      existing('db-OLD', { Address: 'db.example.com' })
    );
    expect(state.resources['Db']!.attributes).toEqual({ Address: SECRET_MASK });
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders a hostile key display-safe on the warning line', () => {
    build({}, existing('db-1', { 'Evil\u001b[2K\rKey': SECRET_MASK }));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\r');
    expect(line).toContain('Evil');
  });
});
