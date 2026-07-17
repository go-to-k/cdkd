import { describe, it, expect } from 'vite-plus/test';
import {
  pascalToCamelCaseKeys,
  camelToPascalCaseKeys,
} from '../../../../src/provisioning/providers/agentcore-case-convert.js';

describe('agentcore-case-convert', () => {
  describe('pascalToCamelCaseKeys', () => {
    it('should convert nested object keys and arrays', () => {
      expect(
        pascalToCamelCaseKeys({
          NetworkConfiguration: { NetworkMode: 'PUBLIC' },
          Items: [{ Value: 1, Label: 'a' }],
          Plain: 'Unchanged-Value',
        })
      ).toEqual({
        networkConfiguration: { networkMode: 'PUBLIC' },
        items: [{ value: 1, label: 'a' }],
        plain: 'Unchanged-Value',
      });
    });

    it('should pass primitives and null/undefined through', () => {
      expect(pascalToCamelCaseKeys(null)).toBeNull();
      expect(pascalToCamelCaseKeys(undefined)).toBeUndefined();
      expect(pascalToCamelCaseKeys('S')).toBe('S');
      expect(pascalToCamelCaseKeys(42)).toBe(42);
    });

    it('should convert a preserved key but copy its value subtree verbatim', () => {
      const preserve = new Set(['AdditionalModelRequestFields']);
      expect(
        pascalToCamelCaseKeys(
          {
            ModelId: 'm',
            AdditionalModelRequestFields: { top_k: 40, Custom_Field: { Nested: true } },
          },
          preserve
        )
      ).toEqual({
        modelId: 'm',
        additionalModelRequestFields: { top_k: 40, Custom_Field: { Nested: true } },
      });
    });
  });

  describe('camelToPascalCaseKeys', () => {
    it('should convert nested object keys and arrays', () => {
      expect(
        camelToPascalCaseKeys({
          ratingScale: { numerical: [{ value: 1, label: 'a', definition: 'd' }] },
        })
      ).toEqual({
        RatingScale: { Numerical: [{ Value: 1, Label: 'a', Definition: 'd' }] },
      });
    });

    it('should convert a preserved key but copy its value subtree verbatim', () => {
      const preserve = new Set(['additionalModelRequestFields']);
      expect(
        camelToPascalCaseKeys(
          {
            modelId: 'm',
            additionalModelRequestFields: { top_k: 40, Custom_Field: { nested: true } },
          },
          preserve
        )
      ).toEqual({
        ModelId: 'm',
        AdditionalModelRequestFields: { top_k: 40, Custom_Field: { nested: true } },
      });
    });
  });
});
