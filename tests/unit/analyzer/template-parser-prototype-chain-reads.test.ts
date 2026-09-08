/**
 * Issue [#2767](https://github.com/go-to-k/cdkd/issues/2767), the
 * `template-parser.ts` half: the same shape as the resolver's bag reads — a
 * key the TEMPLATE supplies, looked up on a plain object, so an
 * `Object.prototype` member answers where no entry exists.
 *
 * The WRITE in `filterResourcesByCondition` is the one that matters most and is
 * the twin of `resolveValue`'s: `Object.entries` yields a `__proto__` logical id
 * (an own key after `JSON.parse`), and a plain assignment routes it through the
 * inherited setter — so the resource vanishes from the effective template, the
 * diff reads "present in state, absent from desired", and the next deploy issues
 * a DELETE for a resource the user still declares.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

describe('template-parser bag reads do not walk the prototype chain (#2767)', () => {
  const parser = new TemplateParser();

  describe('getResource', () => {
    it('answers undefined for an Object.prototype member name', () => {
      const template = JSON.parse(
        '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}'
      ) as CloudFormationTemplate;

      // Reached with a template-controlled id by `DagBuilder`'s Custom-Resource
      // edge, which passes `extractLogicalIdFromReference(serviceToken)`. A bare
      // read answered the `Object` FUNCTION.
      expect(parser.getResource(template, 'constructor')).toBeUndefined();
      expect(parser.getResource(template, '__proto__')).toBeUndefined();
    });

    it('still answers for a resource that genuinely carries such a name', () => {
      const template = JSON.parse(
        '{"Resources":{"constructor":{"Type":"AWS::S3::Bucket"}}}'
      ) as CloudFormationTemplate;

      // The positive twin: `Object.hasOwn` must not refuse an OWN key merely
      // because it collides with a prototype member.
      expect(parser.getResource(template, 'constructor')?.Type).toBe('AWS::S3::Bucket');
    });
  });

  describe('filterResourcesByCondition', () => {
    it('keeps a resource whose logical id is __proto__', () => {
      const template = JSON.parse(
        '{"Resources":{"__proto__":{"Type":"AWS::S3::Bucket"},"Ordinary":{"Type":"AWS::SNS::Topic"}}}'
      ) as CloudFormationTemplate;

      const filtered = parser.filterResourcesByCondition(template, {});

      // The loss is SILENT, so assert the key list and own-ness, not just a
      // read-back: `filtered.Resources['__proto__']` on the broken code answers
      // `Object.prototype`, which is truthy and would mask the drop.
      expect(Object.keys(filtered.Resources).sort()).toEqual(['Ordinary', '__proto__']);
      expect(Object.hasOwn(filtered.Resources, '__proto__')).toBe(true);
      expect(filtered.Resources['__proto__']?.Type).toBe('AWS::S3::Bucket');
    });

    it('does not read an Object.prototype member as a false condition', () => {
      const template = JSON.parse(
        '{"Resources":{"Gated":{"Type":"AWS::S3::Bucket","Condition":"constructor"}}}'
      ) as CloudFormationTemplate;

      // An UNKNOWN condition is not `=== false`, so the resource is KEPT — the
      // documented behaviour for a condition the map does not carry. The bare
      // read is safe only because the resolver hands over a null-prototype bag
      // today; this method is exported and takes whatever a caller has.
      const filtered = parser.filterResourcesByCondition(template, {});

      expect(Object.keys(filtered.Resources)).toEqual(['Gated']);
    });

    it('still excludes a resource whose condition really is false', () => {
      const template = JSON.parse(
        '{"Resources":{"Gated":{"Type":"AWS::S3::Bucket","Condition":"IsProd"},"Always":{"Type":"AWS::SNS::Topic"}}}'
      ) as CloudFormationTemplate;

      const filtered = parser.filterResourcesByCondition(template, { IsProd: false });

      expect(Object.keys(filtered.Resources)).toEqual(['Always']);
    });
  });

  describe('the property path walks', () => {
    it('does not report an Object.prototype member as a present property', () => {
      const resource = JSON.parse(
        '{"Type":"AWS::S3::Bucket","Properties":{"Tags":{"Key":"v"}}}'
      ) as never;

      // Both walks take template-controlled path segments.
      expect(parser.hasProperty(resource, 'Tags.constructor')).toBe(false);
      expect(parser.getProperty(resource, 'Tags.constructor')).toBeUndefined();
    });

    it('still walks a genuine property path', () => {
      const resource = JSON.parse(
        '{"Type":"AWS::S3::Bucket","Properties":{"Tags":{"Key":"v"}}}'
      ) as never;

      expect(parser.hasProperty(resource, 'Tags.Key')).toBe(true);
      expect(parser.getProperty(resource, 'Tags.Key')).toBe('v');
    });
  });
});
