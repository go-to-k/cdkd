import { describe, it, expect, vi } from 'vite-plus/test';

import {
  COMPOSITE_ID_SEPARATOR,
  compositeIdSeparatorRefusal,
  packCompositeId,
} from '../../../src/provisioning/composite-id.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

describe('composite-id', () => {
  describe('packCompositeId', () => {
    it('joins clean segments with the separator', () => {
      expect(
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: 'orders' },
        ])
      ).toBe('mydb|orders');
    });

    it('stringifies number and boolean segments', () => {
      expect(
        packCompositeId('AWS::EC2::NetworkAclEntry', 'Entry', [
          { name: 'networkAclId', value: 'acl-1' },
          { name: 'ruleNumber', value: 100 },
          { name: 'egress', value: false },
        ])
      ).toBe('acl-1|100|false');
    });

    it('refuses an ARRAY segment whose stringified form carries the separator', () => {
      // Every call site reads its segments through an unvalidated cast
      // (`tableInput['Name'] as string | undefined`), so a hand-written
      // `Name: ['a|b']` is truthy, survives the provider's own required-field
      // gate, and arrives here as an array. `String(['a|b'])` is `'a|b'` — the
      // exact ambiguous id — so a `typeof value === 'string'` predicate would
      // wave it through.
      expect(() =>
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: ['a|b'] },
        ])
      ).toThrow(/tableName 'a\|b'/);
    });

    it('does NOT refuse a plain-object segment (recorded known bound)', () => {
      // An unresolved intrinsic stringifies to `[object Object]`, which carries
      // no separator. That is a malformed-value problem `config-shape.ts` owns:
      // the id is wrong, but not wrong in a way that decodes to a DIFFERENT
      // resource, which is the only thing this guard claims to catch. Pinned so
      // the bound is a decision rather than a discovery.
      expect(
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: { Ref: 'SomeResource' } },
        ])
      ).toBe('mydb|[object Object]');
    });

    it('accepts an EMPTY-STRING segment', () => {
      // Empty is a DIFFERENT defect (an unpairable id) and is the decode
      // sites' own non-empty-segment guards' job; refusing it here would
      // duplicate them and change behavior this issue did not scope.
      expect(
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: '' },
        ])
      ).toBe('mydb|');
    });

    it('refuses a segment carrying MULTIPLE separators', () => {
      expect(() =>
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: 'a|b|c' },
        ])
      ).toThrow(/tableName 'a\|b\|c'/);
    });

    it('refuses a separator at the START of a segment', () => {
      expect(() =>
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: '|orders' },
        ])
      ).toThrow(/tableName '\|orders'/);
    });

    it('refuses a separator at the END of a segment', () => {
      // The end position is the one a `split('|')` most easily hides: it yields
      // a trailing EMPTY segment, so an arity check that only rejects short ids
      // reads the pair as well-formed.
      expect(() =>
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb|' },
          { name: 'tableName', value: 'orders' },
        ])
      ).toThrow(/databaseName 'mydb\|'/);
    });

    it('refuses a segment containing the separator', () => {
      // The bug this whole change exists for: without the guard the id would be
      // `mydb|a|b`, which decodes back to database `mydb`, table `a` — a
      // DIFFERENT table, with every existing non-empty-segment guard passing.
      expect(() =>
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: 'a|b' },
        ])
      ).toThrow(ProvisioningError);
    });

    it('names the offending segment, its value and the id shape in the message', () => {
      let message = '';
      try {
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: 'a|b' },
        ]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('AWS::Glue::Table MyTable');
      expect(message).toContain("tableName 'a|b'");
      expect(message).toContain('<databaseName>|<tableName>');
      expect(message).toContain('https://github.com/go-to-k/cdkd/issues/1672');
      // The clean sibling must NOT be blamed.
      expect(message).not.toContain("databaseName 'mydb'");
    });

    it('carries the resource type and logical id on the thrown error', () => {
      try {
        packCompositeId('AWS::AppSync::Resolver', 'MyResolver', [
          { name: 'apiId', value: 'abc' },
          { name: 'typeName', value: 'Query' },
          { name: 'fieldName', value: 'a|b' },
        ]);
        expect.unreachable('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as ProvisioningError).resourceType).toBe('AWS::AppSync::Resolver');
        expect((error as ProvisioningError).logicalId).toBe('MyResolver');
      }
    });

    it('names EVERY offending segment, not just the first', () => {
      let message = '';
      try {
        packCompositeId('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'my|db' },
          { name: 'tableName', value: 'a|b' },
        ]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("databaseName 'my|db'");
      expect(message).toContain("tableName 'a|b'");
    });

    it('warns and packs the ambiguous id when onRefusal is supplied', () => {
      // The replay downgrade: a create replaying a cdkd STATE record must keep
      // the pre-guard behavior, because no template edit can repair the value.
      const onRefusal = vi.fn();
      const packed = packCompositeId(
        'AWS::Glue::Table',
        'MyTable',
        [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: 'a|b' },
        ],
        { onRefusal }
      );
      expect(packed).toBe('mydb|a|b');
      expect(onRefusal).toHaveBeenCalledTimes(1);
      expect(onRefusal.mock.calls[0]?.[0]).toContain("tableName 'a|b'");
      expect(onRefusal.mock.calls[0]?.[0]).toContain(
        'REFUSED on a template-path create'
      );
    });

    it('does not invoke onRefusal for a clean id', () => {
      const onRefusal = vi.fn();
      expect(
        packCompositeId(
          'AWS::Glue::Table',
          'MyTable',
          [
            { name: 'databaseName', value: 'mydb' },
            { name: 'tableName', value: 'orders' },
          ],
          { onRefusal }
        )
      ).toBe('mydb|orders');
      expect(onRefusal).not.toHaveBeenCalled();
    });
  });

  describe('compositeIdSeparatorRefusal', () => {
    it('catches the ARRAY segment too, sharing the action\'s predicate', () => {
      expect(
        compositeIdSeparatorRefusal('AWS::Glue::Table', 'MyTable', [
          { name: 'databaseName', value: 'mydb' },
          { name: 'tableName', value: ['a|b'] },
        ])
      ).toContain("tableName 'a|b'");
    });

    it('returns undefined for a clean id', () => {
      expect(
        compositeIdSeparatorRefusal('AWS::S3Tables::Namespace', 'Ns', [
          { name: 'tableBucketARN', value: 'arn:aws:s3tables:us-east-1:1:bucket/b' },
          { name: 'namespace', value: 'analytics' },
        ])
      ).toBeUndefined();
    });

    it('returns the same sentence packCompositeId throws, without acting on it', () => {
      const segments = [
        { name: 'databaseName', value: 'mydb' },
        { name: 'tableName', value: 'a|b' },
      ];
      const refusal = compositeIdSeparatorRefusal('AWS::Glue::Table', 'MyTable', segments);
      expect(refusal).toBeDefined();

      let thrown = '';
      try {
        packCompositeId('AWS::Glue::Table', 'MyTable', segments);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      // One message builder for both entry points, so the probe and the action
      // can never describe the refusal differently.
      expect(thrown).toBe(refusal);
    });
  });

  it('exports the separator every provider packs with', () => {
    expect(COMPOSITE_ID_SEPARATOR).toBe('|');
  });
});
