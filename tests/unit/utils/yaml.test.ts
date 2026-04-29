import { describe, it, expect } from 'vitest';
import { toYaml } from '../../../src/utils/yaml.js';

/**
 * yaml.ts is shared by `cdkd synth` (CloudFormation template render) and
 * `cdkd list --long` (stack metadata render). These tests pin the quoting
 * rules so neither command regresses if the helper is later tweaked.
 */
describe('toYaml', () => {
  it('renders primitives with CDK CLI-style quoting', () => {
    expect(toYaml(null)).toBe('null\n');
    expect(toYaml(undefined)).toBe('null\n');
    expect(toYaml(true)).toBe('true\n');
    expect(toYaml(false)).toBe('false\n');
    expect(toYaml(42)).toBe('"42"\n');
  });

  it('does not quote plain strings (including AWS:: type names)', () => {
    expect(toYaml('hello')).toBe('hello\n');
    expect(toYaml('AWS::S3::Bucket')).toBe('AWS::S3::Bucket\n');
  });

  it('double-quotes scalar-collision strings', () => {
    expect(toYaml('')).toBe('""\n');
    expect(toYaml('true')).toBe('"true"\n');
    expect(toYaml('false')).toBe('"false"\n');
    expect(toYaml('null')).toBe('"null"\n');
    expect(toYaml('with#hash')).toBe('"with#hash"\n');
  });

  it('single-quotes JSON-like strings (matches CDK CLI behavior)', () => {
    expect(toYaml('{"a": 1}')).toBe(`'{"a": 1}'\n`);
    expect(toYaml('[1,2]')).toBe(`'[1,2]'\n`);
  });

  it('renders empty containers inline', () => {
    expect(toYaml([])).toBe('[]\n');
    expect(toYaml({})).toBe('{}\n');
  });

  it('renders nested objects with correct indentation', () => {
    const result = toYaml({ Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } });
    expect(result).toBe('\nResources:\n  Bucket:\n    Type: AWS::S3::Bucket\n');
  });

  it('renders arrays of records', () => {
    const result = toYaml([
      { id: 'StackA', name: 'StackA' },
      { id: 'StackB', name: 'StackB' },
    ]);
    expect(result).toBe('\n- id: StackA\n  name: StackA\n- id: StackB\n  name: StackB\n');
  });
});
