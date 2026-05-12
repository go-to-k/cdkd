import { describe, expect, it } from 'vite-plus/test';
import { resolveLambdaArnIntrinsic } from '../../../src/local/intrinsic-lambda-arn.js';

describe('resolveLambdaArnIntrinsic', () => {
  it('resolves bare Ref', () => {
    expect(resolveLambdaArnIntrinsic({ Ref: 'MyHandler' })).toEqual({
      kind: 'resolved',
      logicalId: 'MyHandler',
    });
  });

  it("resolves Fn::GetAtt: [LogicalId, 'Arn']", () => {
    expect(resolveLambdaArnIntrinsic({ 'Fn::GetAtt': ['MyHandler', 'Arn'] })).toEqual({
      kind: 'resolved',
      logicalId: 'MyHandler',
    });
  });

  it("rejects Fn::GetAtt with non-Arn attribute", () => {
    const r = resolveLambdaArnIntrinsic({ 'Fn::GetAtt': ['MyHandler', 'Name'] });
    expect(r.kind).toBe('unsupported');
  });

  it("resolves the canonical REST v1 / HTTP v2 invoke-ARN Fn::Join wrapper", () => {
    // The exact shape `apigateway.LambdaIntegration({proxy: true})` and
    // CDK 2.x `apigatewayv2-authorizers.HttpLambdaAuthorizer` synthesize.
    const shape = {
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          ':apigateway:',
          { Ref: 'AWS::Region' },
          ':lambda:path/2015-03-31/functions/',
          { 'Fn::GetAtt': ['MyHandler', 'Arn'] },
          '/invocations',
        ],
      ],
    };
    expect(resolveLambdaArnIntrinsic(shape)).toEqual({
      kind: 'resolved',
      logicalId: 'MyHandler',
    });
  });

  it('resolves Fn::Sub 1-arg invoke-ARN (AWS-docs canonical shape)', () => {
    // `cdk.Fn.sub('arn:...${LogicalId.Arn}/invocations')` synthesizes this.
    const shape = {
      'Fn::Sub':
        'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyHandler.Arn}/invocations',
    };
    expect(resolveLambdaArnIntrinsic(shape)).toEqual({
      kind: 'resolved',
      logicalId: 'MyHandler',
    });
  });

  it('resolves Fn::Sub 2-arg invoke-ARN (CDK Fn.sub(template, vars))', () => {
    // `cdk.Fn.sub(template, { MyLambdaArn: fn.functionArn })` synthesizes
    // this — the var map value is the Fn::GetAtt: [..., 'Arn'] shape.
    const shape = {
      'Fn::Sub': [
        'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyLambdaArn}/invocations',
        { MyLambdaArn: { 'Fn::GetAtt': ['MyHandler', 'Arn'] } },
      ],
    };
    expect(resolveLambdaArnIntrinsic(shape)).toEqual({
      kind: 'resolved',
      logicalId: 'MyHandler',
    });
  });

  it('rejects Fn::Sub against an arbitrary (non-invoke-ARN) template', () => {
    // The bare `${X.Arn}` shape — used as the negative case in the
    // pre-PR rejection test for route-discovery. Still rejected because
    // the template doesn't contain the invoke-ARN marker.
    const r = resolveLambdaArnIntrinsic({ 'Fn::Sub': '${MyHandler.Arn}' });
    expect(r.kind).toBe('unsupported');
  });

  it("rejects Fn::Sub whose marker-bearing template has no ${X.Arn} placeholder", () => {
    // Marker present, but the only placeholder is `${AWS::Region}` — no
    // Lambda reference at all.
    const r = resolveLambdaArnIntrinsic({
      'Fn::Sub':
        'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/static-name/invocations',
    });
    expect(r.kind).toBe('unsupported');
  });

  it('rejects Fn::Sub 2-arg whose var-map value is not Fn::GetAtt [_, "Arn"]', () => {
    const r = resolveLambdaArnIntrinsic({
      'Fn::Sub': [
        'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyLambdaArn}/invocations',
        { MyLambdaArn: { Ref: 'NotAGetAtt' } },
      ],
    });
    expect(r.kind).toBe('unsupported');
  });

  it("rejects Fn::Join that doesn't contain the invoke-ARN marker", () => {
    const r = resolveLambdaArnIntrinsic({
      'Fn::Join': ['/', ['prefix', { 'Fn::GetAtt': ['Other', 'Arn'] }, 'suffix']],
    });
    expect(r.kind).toBe('unsupported');
  });

  it('rejects Fn::Join with marker but no GetAtt element', () => {
    // Pathological shape — the parts contain the marker as a literal
    // segment but no Fn::GetAtt: [..., 'Arn'] to extract.
    const r = resolveLambdaArnIntrinsic({
      'Fn::Join': [
        '',
        [
          'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/',
          { Ref: 'NotAGetAtt' },
          '/invocations',
        ],
      ],
    });
    expect(r.kind).toBe('unsupported');
  });

  it('rejects bare primitives / arrays / null', () => {
    expect(resolveLambdaArnIntrinsic('string').kind).toBe('unsupported');
    expect(resolveLambdaArnIntrinsic([1, 2]).kind).toBe('unsupported');
    expect(resolveLambdaArnIntrinsic(null).kind).toBe('unsupported');
    expect(resolveLambdaArnIntrinsic(undefined).kind).toBe('unsupported');
  });

  it('rejects unknown intrinsic shape', () => {
    expect(resolveLambdaArnIntrinsic({ 'Fn::ImportValue': 'X' }).kind).toBe('unsupported');
  });

  it("Fn::Sub 1-arg ignores ${LogicalId.OtherAttr} and only resolves ${LogicalId.Arn}", () => {
    // The template references the right Lambda but uses an unrelated
    // attribute name — the resolver should skip and continue scanning
    // (in this case there are no other placeholders, so it fails).
    const r = resolveLambdaArnIntrinsic({
      'Fn::Sub':
        'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyHandler.Name}/invocations',
    });
    expect(r.kind).toBe('unsupported');
  });

  it("Fn::Sub 1-arg picks the FIRST resolvable ${LogicalId.Arn} placeholder", () => {
    // Defensive: a single template containing two Lambda references is
    // not a shape CDK actually emits, but the resolver must be
    // deterministic. The first non-pseudo `${X.Arn}` wins.
    const r = resolveLambdaArnIntrinsic({
      'Fn::Sub':
        'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${First.Arn}/invocations-suffix-${Second.Arn}',
    });
    expect(r).toEqual({ kind: 'resolved', logicalId: 'First' });
  });
});
