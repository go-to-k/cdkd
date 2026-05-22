import { describe, it, expect } from 'vite-plus/test';
import { containsMacro, enumerateMacros } from '../../../src/synthesis/macro-detector.js';

describe('containsMacro', () => {
  it('returns true for top-level Transform as a string', () => {
    expect(containsMacro({ Transform: 'AWS::Serverless-2016-10-31', Resources: {} })).toBe(true);
  });

  it('returns true for top-level Transform as an array', () => {
    expect(
      containsMacro({
        Transform: ['AWS::Serverless-2016-10-31', 'AWS::LanguageExtensions'],
        Resources: {},
      })
    ).toBe(true);
  });

  it('returns true for top-level Transform as an object form ({Name, Parameters})', () => {
    expect(
      containsMacro({
        Transform: { Name: 'AWS::Include', Parameters: { Location: 's3://b/k.yaml' } },
        Resources: {},
      })
    ).toBe(true);
  });

  it('returns false for an empty Transform array (CFn no-op)', () => {
    expect(containsMacro({ Transform: [], Resources: {} })).toBe(false);
  });

  it('returns false when no Transform and no Fn::Transform', () => {
    expect(
      containsMacro({
        Resources: { B: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b' } } },
      })
    ).toBe(false);
  });

  it('returns true for Fn::Transform inside a resource Properties block', () => {
    expect(
      containsMacro({
        Resources: {
          MyResource: {
            Type: 'AWS::SomeType',
            Properties: {
              'Fn::Transform': { Name: 'AWS::Include', Parameters: { Location: 's3://b/k' } },
            },
          },
        },
      })
    ).toBe(true);
  });

  it('returns true for Fn::Transform inside a Resources entry (resource-level)', () => {
    expect(
      containsMacro({
        Resources: {
          'Fn::Transform': { Name: 'CustomMacro' },
        },
      })
    ).toBe(true);
  });

  it('returns true for Fn::Transform nested deep inside Outputs', () => {
    expect(
      containsMacro({
        Outputs: {
          MyOutput: {
            Value: { 'Fn::Transform': { Name: 'AWS::Include' } },
          },
        },
        Resources: {},
      })
    ).toBe(true);
  });

  it('returns true for Fn::Transform nested deep inside Mappings', () => {
    expect(
      containsMacro({
        Mappings: { Region: { 'Fn::Transform': { Name: 'AWS::Include' } } },
        Resources: {},
      })
    ).toBe(true);
  });

  it('returns true for Fn::Transform nested deep inside Conditions', () => {
    expect(
      containsMacro({
        Conditions: { IsProd: { 'Fn::Transform': { Name: 'AWS::Include' } } },
        Resources: {},
      })
    ).toBe(true);
  });

  it('returns true for Fn::Transform nested deep inside Rules', () => {
    expect(
      containsMacro({
        Rules: { MyRule: { Assertions: [{ 'Fn::Transform': { Name: 'AWS::Include' } }] } },
        Resources: {},
      })
    ).toBe(true);
  });

  it('returns false for Fn::Transform literally appearing inside Metadata (CFn does not expand there)', () => {
    expect(
      containsMacro({
        Resources: {
          Foo: {
            Type: 'AWS::SomeType',
            Metadata: {
              'Fn::Transform': { Name: 'CustomMacro' },
            },
            Properties: {},
          },
        },
      })
    ).toBe(false);
  });

  it('tolerates malformed inputs without throwing', () => {
    expect(containsMacro(null)).toBe(false);
    expect(containsMacro(undefined)).toBe(false);
    expect(containsMacro('not a template')).toBe(false);
    expect(containsMacro(42)).toBe(false);
    expect(containsMacro([1, 2, 3])).toBe(false);
    expect(containsMacro({})).toBe(false);
  });

  it('returns false for a Fn::Transform key whose value is null', () => {
    // A literal `Fn::Transform: null` is not a real macro reference.
    expect(
      containsMacro({
        Resources: { Foo: { Type: 'AWS::S3::Bucket', Properties: { 'Fn::Transform': null } } },
      })
    ).toBe(false);
  });

  it('returns true for Fn::Transform nested inside an array', () => {
    expect(
      containsMacro({
        Resources: {
          Foo: {
            Type: 'AWS::SomeType',
            Properties: { Items: [{ 'Fn::Transform': { Name: 'AWS::Include' } }] },
          },
        },
      })
    ).toBe(true);
  });
});

describe('enumerateMacros', () => {
  it('returns top-level Transform string as a single-element array', () => {
    expect(enumerateMacros({ Transform: 'AWS::Serverless-2016-10-31', Resources: {} })).toEqual([
      'AWS::Serverless-2016-10-31',
    ]);
  });

  it('returns every entry from a top-level Transform array, in order', () => {
    expect(
      enumerateMacros({
        Transform: ['A', 'B', 'C'],
        Resources: {},
      })
    ).toEqual(['A', 'B', 'C']);
  });

  it('accepts the object-form Transform array entry ({Name, Parameters})', () => {
    expect(
      enumerateMacros({
        Transform: [
          { Name: 'AWS::Include', Parameters: {} },
          'AWS::LanguageExtensions',
        ],
        Resources: {},
      })
    ).toEqual(['AWS::Include', 'AWS::LanguageExtensions']);
  });

  it('deduplicates Transform entries across the top-level and Fn::Transform occurrences', () => {
    expect(
      enumerateMacros({
        Transform: ['AWS::Include'],
        Resources: {
          R: {
            Type: 'AWS::S3::Bucket',
            Properties: { 'Fn::Transform': { Name: 'AWS::Include' } },
          },
        },
      })
    ).toEqual(['AWS::Include']);
  });

  it('returns Fn::Transform macros in encounter order across sections', () => {
    expect(
      enumerateMacros({
        Resources: {
          R1: { Type: 'X', Properties: { 'Fn::Transform': { Name: 'MacroA' } } },
        },
        Outputs: {
          O1: { Value: { 'Fn::Transform': { Name: 'MacroB' } } },
        },
      })
    ).toEqual(['MacroA', 'MacroB']);
  });

  it('returns [] for malformed inputs', () => {
    expect(enumerateMacros(null)).toEqual([]);
    expect(enumerateMacros(undefined)).toEqual([]);
    expect(enumerateMacros('garbage')).toEqual([]);
    expect(enumerateMacros({})).toEqual([]);
  });

  it('ignores Fn::Transform entries without a Name string', () => {
    expect(
      enumerateMacros({
        Resources: {
          R: { Type: 'X', Properties: { 'Fn::Transform': {} } },
          R2: { Type: 'Y', Properties: { 'Fn::Transform': { Name: 42 } } },
        },
      })
    ).toEqual([]);
  });

  it('preserves order across multiple Fn::Transform sites in the same section', () => {
    expect(
      enumerateMacros({
        Resources: {
          R1: { Type: 'X', Properties: { 'Fn::Transform': { Name: 'First' } } },
          R2: { Type: 'X', Properties: { 'Fn::Transform': { Name: 'Second' } } },
          R3: { Type: 'X', Properties: { 'Fn::Transform': { Name: 'First' } } }, // dedup'd
        },
      })
    ).toEqual(['First', 'Second']);
  });

  it('does NOT enumerate macros buried in Metadata blocks', () => {
    expect(
      enumerateMacros({
        Resources: {
          R: {
            Type: 'X',
            Metadata: { 'Fn::Transform': { Name: 'IgnoredMeta' } },
            Properties: { 'Fn::Transform': { Name: 'CountedProp' } },
          },
        },
      })
    ).toEqual(['CountedProp']);
  });
});
