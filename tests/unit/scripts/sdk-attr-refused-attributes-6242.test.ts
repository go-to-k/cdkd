import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  collectRefusedAttributes,
  parseResolverAttributeSet,
} from '../../../scripts/gen-sdk-attr-coverage.ts';

/** go-to-k/cdkd#6242: the matrix's refused-attribute list and its allow-list read. */
describe('sdk-attr-coverage refused attributes (#6242)', () => {
  it('reads PHYSICAL_ID_ATTRIBUTES out of the real resolver source', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../src/deployment/intrinsic-resolver/getatt-refusals.ts'),
      'utf8'
    );
    const set = parseResolverAttributeSet(source);
    expect(set.has('AWS::EFS::MountTarget.Id')).toBe(true);
    expect(set.size).toBeGreaterThanOrEqual(4);
  });

  it('reads CFN_REJECTED_GETATT_ATTRIBUTES out of the real resolver source', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../src/deployment/intrinsic-resolver/getatt-refusals.ts'),
      'utf8'
    );
    const set = parseResolverAttributeSet(source, 'CFN_REJECTED_GETATT_ATTRIBUTES');
    expect(set.has('AWS::CloudFormation::Stack.StackId')).toBe(true);
    expect(set.has('AWS::EFS::MountTarget.Id')).toBe(false);
  });

  it('fails loudly when the set is missing rather than emptying the allow-list', () => {
    expect(() => parseResolverAttributeSet('export const OTHER = 1;')).toThrow(/PHYSICAL_ID_ATTRIBUTES/);
  });

  it('lists a read-only attribute that is neither recorded, named by the resolver, nor allow-listed', () => {
    const refused = collectRefusedAttributes(
      [
        { resourceType: 'AWS::X::A', readOnlyProperties: ['Arn', 'Recorded', 'Named', 'Allowed', 'Gap', 'Obj/Member', 'Obj.Member'] },
        { resourceType: 'AWS::X::NotSdk', readOnlyProperties: ['Gap'] },
      ],
      new Set(['AWS::X::A']),
      new Map([['AWS::X::A', new Set(['Arn', 'Recorded'])]]),
      "case 'Named':",
      new Set(['AWS::X::A.Allowed'])
    );
    expect(refused).toStrictEqual([{ resourceType: 'AWS::X::A', attributes: ['Gap'] }]);
  });
});
