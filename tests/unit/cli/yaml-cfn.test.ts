/**
 * Unit tests for the CFn-aware YAML codec. Each tag is exercised both on
 * the parse and the stringify side, plus round-trip stability (parse →
 * stringify → parse → deep-equal the second parse to the first).
 */

import { describe, expect, it } from 'vitest';
import {
  detectTemplateFormat,
  detectTemplateFormatByPath,
  parseCfnTemplate,
  parseCfnTemplateWithFormat,
  stringifyCfnTemplate,
} from '../../../src/cli/yaml-cfn.js';

describe('detectTemplateFormat', () => {
  it('detects JSON when first non-whitespace byte is "{"', () => {
    expect(detectTemplateFormat('{"a":1}')).toBe('json');
    expect(detectTemplateFormat('  \n  {"a":1}')).toBe('json');
  });

  it('detects JSON when first non-whitespace byte is "["', () => {
    expect(detectTemplateFormat('[1,2,3]')).toBe('json');
  });

  it('detects YAML for typical CFn YAML templates', () => {
    expect(detectTemplateFormat('Resources:\n  Bucket: ...')).toBe('yaml');
    expect(detectTemplateFormat('# comment\nResources:\n  X: ...')).toBe('yaml');
    expect(detectTemplateFormat('---\nResources:\n  X: ...')).toBe('yaml');
  });

  it('treats empty input as JSON so the JSON error path fires', () => {
    expect(detectTemplateFormat('')).toBe('json');
    expect(detectTemplateFormat('   \n  ')).toBe('json');
  });
});

describe('detectTemplateFormatByPath', () => {
  it('detects JSON / YAML extensions case-insensitively', () => {
    expect(detectTemplateFormatByPath('template.json')).toBe('json');
    expect(detectTemplateFormatByPath('TEMPLATE.JSON')).toBe('json');
    expect(detectTemplateFormatByPath('template.yaml')).toBe('yaml');
    expect(detectTemplateFormatByPath('template.yml')).toBe('yaml');
    expect(detectTemplateFormatByPath('TEMPLATE.YAML')).toBe('yaml');
  });

  it('returns null for unrecognized extensions', () => {
    expect(detectTemplateFormatByPath('template.txt')).toBe(null);
    expect(detectTemplateFormatByPath('template')).toBe(null);
  });
});

describe('parseCfnTemplate — JSON path', () => {
  it('parses a minimal JSON template', () => {
    const parsed = parseCfnTemplate('{"Resources":{"X":{"Type":"AWS::S3::Bucket"}}}');
    expect(parsed).toEqual({ Resources: { X: { Type: 'AWS::S3::Bucket' } } });
  });

  it('throws a clear error on invalid JSON', () => {
    expect(() => parseCfnTemplate('{not-json')).toThrow(/not valid JSON/);
  });

  it('throws when root is not an object', () => {
    expect(() => parseCfnTemplate('[1, 2, 3]')).toThrow(/Template root is not an object/);
  });
});

describe('parseCfnTemplate — YAML CFn tags (per-tag)', () => {
  it('!Ref scalar → {Ref: ...}', () => {
    const parsed = parseCfnTemplate('X: !Ref MyBucket\n');
    expect(parsed).toEqual({ X: { Ref: 'MyBucket' } });
  });

  it('!Condition scalar → {Condition: ...}', () => {
    const parsed = parseCfnTemplate('X: !Condition IsProd\n');
    expect(parsed).toEqual({ X: { Condition: 'IsProd' } });
  });

  it('!GetAtt scalar (dot-delimited) → {Fn::GetAtt: [Logical, Attr]}', () => {
    const parsed = parseCfnTemplate('X: !GetAtt MyFn.Arn\n');
    expect(parsed).toEqual({ X: { 'Fn::GetAtt': ['MyFn', 'Arn'] } });
  });

  it('!GetAtt scalar with nested attribute path (Endpoint.Port)', () => {
    const parsed = parseCfnTemplate('X: !GetAtt RDSCluster.Endpoint.Port\n');
    // Only the first dot splits the logical id from the attribute path.
    expect(parsed).toEqual({ X: { 'Fn::GetAtt': ['RDSCluster', 'Endpoint.Port'] } });
  });

  it('!GetAtt sequence → {Fn::GetAtt: [Logical, Attr]}', () => {
    const parsed = parseCfnTemplate('X: !GetAtt [MyFn, Arn]\n');
    expect(parsed).toEqual({ X: { 'Fn::GetAtt': ['MyFn', 'Arn'] } });
  });

  it('!Sub scalar → {Fn::Sub: "..."}', () => {
    const parsed = parseCfnTemplate('X: !Sub "${AWS::Region}-${Foo}"\n');
    expect(parsed).toEqual({ X: { 'Fn::Sub': '${AWS::Region}-${Foo}' } });
  });

  it('!Join sequence → {Fn::Join: [delim, [parts...]]}', () => {
    const parsed = parseCfnTemplate("X: !Join [':', ['a', 'b']]\n");
    expect(parsed).toEqual({ X: { 'Fn::Join': [':', ['a', 'b']] } });
  });

  it('!Select sequence → {Fn::Select: [idx, list]}', () => {
    const parsed = parseCfnTemplate("X: !Select [0, ['a', 'b']]\n");
    expect(parsed).toEqual({ X: { 'Fn::Select': [0, ['a', 'b']] } });
  });

  it('!Split sequence → {Fn::Split: [delim, str]}', () => {
    const parsed = parseCfnTemplate("X: !Split [':', 'a:b:c']\n");
    expect(parsed).toEqual({ X: { 'Fn::Split': [':', 'a:b:c'] } });
  });

  it('!If sequence → {Fn::If: [cond, then, else]}', () => {
    const parsed = parseCfnTemplate('X: !If [IsProd, prod-value, dev-value]\n');
    expect(parsed).toEqual({ X: { 'Fn::If': ['IsProd', 'prod-value', 'dev-value'] } });
  });

  it('!Equals sequence → {Fn::Equals: [a, b]}', () => {
    const parsed = parseCfnTemplate('X: !Equals [a, b]\n');
    expect(parsed).toEqual({ X: { 'Fn::Equals': ['a', 'b'] } });
  });

  it('!And / !Or / !Not — boolean composition', () => {
    const parsed = parseCfnTemplate(
      'A: !And [!Condition C1, !Condition C2]\n' +
        'O: !Or [!Condition C1, !Condition C2]\n' +
        'N: !Not [!Condition C1]\n'
    );
    expect(parsed).toEqual({
      A: { 'Fn::And': [{ Condition: 'C1' }, { Condition: 'C2' }] },
      O: { 'Fn::Or': [{ Condition: 'C1' }, { Condition: 'C2' }] },
      N: { 'Fn::Not': [{ Condition: 'C1' }] },
    });
  });

  it('!FindInMap sequence → {Fn::FindInMap: [...]}', () => {
    const parsed = parseCfnTemplate('X: !FindInMap [Map, TopKey, SecondKey]\n');
    expect(parsed).toEqual({ X: { 'Fn::FindInMap': ['Map', 'TopKey', 'SecondKey'] } });
  });

  it('!Base64 scalar → {Fn::Base64: "..."}', () => {
    const parsed = parseCfnTemplate('X: !Base64 "hello"\n');
    expect(parsed).toEqual({ X: { 'Fn::Base64': 'hello' } });
  });

  it('!Cidr sequence → {Fn::Cidr: [...]}', () => {
    const parsed = parseCfnTemplate("X: !Cidr ['10.0.0.0/16', 6, 8]\n");
    expect(parsed).toEqual({ X: { 'Fn::Cidr': ['10.0.0.0/16', 6, 8] } });
  });

  it('!GetAZs scalar → {Fn::GetAZs: ""}', () => {
    const parsed = parseCfnTemplate('X: !GetAZs ""\n');
    expect(parsed).toEqual({ X: { 'Fn::GetAZs': '' } });
  });

  it('!ImportValue scalar → {Fn::ImportValue: "..."}', () => {
    const parsed = parseCfnTemplate('X: !ImportValue OtherStack-Output\n');
    expect(parsed).toEqual({ X: { 'Fn::ImportValue': 'OtherStack-Output' } });
  });

  it('!Transform map → {Fn::Transform: {Name, Parameters}}', () => {
    const parsed = parseCfnTemplate(
      'X: !Transform\n  Name: SomeMacro\n  Parameters:\n    k: v\n'
    );
    expect(parsed).toEqual({
      X: { 'Fn::Transform': { Name: 'SomeMacro', Parameters: { k: 'v' } } },
    });
  });

  it('nested intrinsics — !Join containing !Ref', () => {
    const parsed = parseCfnTemplate("X: !Join [':', ['arn', !Ref AWS::Region]]\n");
    expect(parsed).toEqual({
      X: { 'Fn::Join': [':', ['arn', { Ref: 'AWS::Region' }]] },
    });
  });
});

describe('stringifyCfnTemplate — JSON path', () => {
  it('emits two-space-indented JSON', () => {
    const out = stringifyCfnTemplate({ Resources: { X: { Type: 'AWS::S3::Bucket' } } }, 'json');
    expect(out).toBe(
      '{\n  "Resources": {\n    "X": {\n      "Type": "AWS::S3::Bucket"\n    }\n  }\n}'
    );
  });
});

describe('stringifyCfnTemplate — YAML CFn tags (per-tag)', () => {
  it('Ref → !Ref scalar', () => {
    const out = stringifyCfnTemplate({ X: { Ref: 'MyBucket' } }, 'yaml');
    expect(out).toContain('X: !Ref MyBucket');
  });

  it('Condition → !Condition scalar', () => {
    const out = stringifyCfnTemplate({ X: { Condition: 'IsProd' } }, 'yaml');
    expect(out).toContain('X: !Condition IsProd');
  });

  it('Fn::GetAtt with 2 string elements → scalar dot-delimited', () => {
    const out = stringifyCfnTemplate({ X: { 'Fn::GetAtt': ['MyFn', 'Arn'] } }, 'yaml');
    expect(out).toContain('X: !GetAtt MyFn.Arn');
  });

  it('Fn::GetAtt with nested attribute path → scalar (single split)', () => {
    const out = stringifyCfnTemplate(
      { X: { 'Fn::GetAtt': ['RDSCluster', 'Endpoint.Port'] } },
      'yaml'
    );
    expect(out).toContain('X: !GetAtt RDSCluster.Endpoint.Port');
  });

  it('Fn::Join → !Join sequence', () => {
    const out = stringifyCfnTemplate({ X: { 'Fn::Join': [':', ['a', 'b']] } }, 'yaml');
    expect(out).toContain('X: !Join');
    expect(out).toContain('- ":"');
  });

  it('Fn::Transform → !Transform map', () => {
    const out = stringifyCfnTemplate(
      { X: { 'Fn::Transform': { Name: 'M', Parameters: { k: 'v' } } } },
      'yaml'
    );
    expect(out).toContain('X: !Transform');
    expect(out).toContain('Name: M');
  });

  it('non-intrinsic 1-key object passes through as a plain YAML map', () => {
    // {Key: 'value'} is NOT an intrinsic — `Key` is not in our shorthand
    // map. Must round-trip as a plain map, not surface as `!Key value`.
    const out = stringifyCfnTemplate({ Resources: { X: { Key: 'value' } } }, 'yaml');
    expect(out).toContain('Key: value');
    expect(out).not.toContain('!Key');
  });
});

describe('round-trip stability', () => {
  const FIXTURE = `AWSTemplateFormatVersion: '2010-09-09'
Description: Test stack
Conditions:
  IsProd: !Equals [!Ref Env, prod]
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "\${AWS::StackName}-mybucket"
      Tags:
        - Key: ref-tag
          Value: !Ref AWS::Region
  MyFn:
    Type: AWS::Lambda::Function
    Properties:
      Role: !GetAtt MyRole.Arn
      Environment:
        Variables:
          PORT: !GetAtt RDSCluster.Endpoint.Port
          SEQ: !GetAtt [MyOther, NestedAttr]
          JOIN: !Join [":", ["arn", "aws", !Ref AWS::Region]]
          IFNN: !If [IsProd, !Ref Foo, !Ref AWS::NoValue]
          CIDR: !Cidr ["10.0.0.0/16", 6, 8]
          IMP: !ImportValue OtherStack-Output
          B64: !Base64 "hello"
          AZS: !GetAZs ""
          SEL: !Select [0, !Split [":", "a:b:c"]]
          FIM: !FindInMap [Map, TopKey, SecondKey]
          BOOL: !And [!Condition IsProd, !Not [!Equals [!Ref Env, ""]]]
          TRANS: !Transform
            Name: SomeMacro
            Parameters:
              k: v
Outputs:
  X:
    Value: !Ref MyBucket
`;

  it('round-trips YAML → parse → stringify → parse', () => {
    const first = parseCfnTemplate(FIXTURE);
    const yaml = stringifyCfnTemplate(first, 'yaml');
    const second = parseCfnTemplate(yaml);
    expect(second).toEqual(first);
  });

  it('round-trips YAML → JSON → YAML preserving intrinsics', () => {
    const first = parseCfnTemplate(FIXTURE);
    const asJson = stringifyCfnTemplate(first, 'json');
    const fromJson = parseCfnTemplate(asJson);
    expect(fromJson).toEqual(first);
    // Now back to YAML.
    const yaml = stringifyCfnTemplate(fromJson, 'yaml');
    const reparsed = parseCfnTemplate(yaml);
    expect(reparsed).toEqual(first);
  });

  it('CDK-style synth JSON template (no intrinsics) round-trips JSON identity', () => {
    const tpl = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'literal-name' },
        },
      },
      Outputs: { OutA: { Value: 'literal-value' } },
    };
    const stringified = stringifyCfnTemplate(tpl, 'json');
    expect(JSON.parse(stringified)).toEqual(tpl);
  });
});

describe('parseCfnTemplateWithFormat', () => {
  it('returns both the parsed template and the detected format (JSON)', () => {
    const { template, format } = parseCfnTemplateWithFormat('{"Resources":{}}');
    expect(template).toEqual({ Resources: {} });
    expect(format).toBe('json');
  });

  it('returns both the parsed template and the detected format (YAML)', () => {
    const { template, format } = parseCfnTemplateWithFormat('Resources:\n  X:\n    Type: AWS::S3::Bucket\n');
    expect(template).toEqual({ Resources: { X: { Type: 'AWS::S3::Bucket' } } });
    expect(format).toBe('yaml');
  });
});

describe('regression — generic YAML libs corrupt CFn shorthand', () => {
  it('without the custom codec, intrinsics would be silently stripped', () => {
    // Mirror what would happen with a generic YAML parser. We
    // demonstrate that our codec produces the long-form shape.
    const parsed = parseCfnTemplate('X: !Ref MyBucket\n');
    // The KEY load-bearing test: the value MUST be an object with a
    // `Ref` key, not the bare string 'MyBucket' that a non-CFn-aware
    // codec would produce.
    expect(parsed['X']).toEqual({ Ref: 'MyBucket' });
    expect(parsed['X']).not.toBe('MyBucket');
  });

  it('parses + re-emits a realistic CFn YAML snippet without corruption', () => {
    const yaml = `Resources:
  MyRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: !Sub "\${AWS::StackName}-policy"
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action: s3:GetObject
                Resource: !Sub "\${MyBucket.Arn}/*"
`;
    const parsed = parseCfnTemplate(yaml);
    const out = stringifyCfnTemplate(parsed, 'yaml');
    // Round-trip stability — the second parse equals the first.
    expect(parseCfnTemplate(out)).toEqual(parsed);
    // The Sub intrinsic on a deeply nested property is preserved.
    expect(out).toContain('!Sub');
    // No intrinsic-form leakage into the long-form `Fn::Sub:` key.
    expect(out).not.toContain('Fn::Sub:');
  });
});
