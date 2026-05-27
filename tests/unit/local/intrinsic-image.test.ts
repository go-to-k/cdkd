import { describe, expect, it } from 'vite-plus/test';
import {
  derivePseudoParametersFromRegion,
  substituteImagePlaceholders,
  tryResolveImageFnJoin,
  type ImageResolutionContext,
} from '../../../src/local/intrinsic-image.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * Unit tests for the shared image-URI intrinsic resolver extracted in
 * issue #286 Gap 2. The helper is consumed by both ECS
 * (`ecs-task-resolver.ts`) and Lambda container (`lambda-resolver.ts`)
 * resolvers — the test surface covers the canonical CDK 2.x shapes both
 * call sites care about.
 */

const repoResources: Record<string, TemplateResource> = {
  Repo1: { Type: 'AWS::ECR::Repository', Properties: {} },
};

/**
 * The canonical `Fn::Join` shape CDK 2.x emits for
 * `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })` and
 * `ContainerImage.fromEcrRepository(repo, tag)`. Captured by `cdk synth`
 * + `jq` from a real CDK app (see issue #286 Gap 2 verification step).
 */
function canonicalFromEcrJoin(repoLogicalId: string, tagOrDigest: string): unknown {
  return {
    'Fn::Join': [
      '',
      [
        {
          'Fn::Select': [
            4,
            { 'Fn::Split': [':', { 'Fn::GetAtt': [repoLogicalId, 'Arn'] }] },
          ],
        },
        '.dkr.ecr.',
        {
          'Fn::Select': [
            3,
            { 'Fn::Split': [':', { 'Fn::GetAtt': [repoLogicalId, 'Arn'] }] },
          ],
        },
        '.',
        { Ref: 'AWS::URLSuffix' },
        '/',
        { Ref: repoLogicalId },
        tagOrDigest.startsWith('sha256:') ? `@${tagOrDigest}` : `:${tagOrDigest}`,
      ],
    ],
  };
}

describe('tryResolveImageFnJoin', () => {
  it('returns not-applicable for a non-Fn::Join value', () => {
    expect(tryResolveImageFnJoin('public.ecr.aws/nginx:1', repoResources, undefined)).toEqual({
      kind: 'not-applicable',
    });
    expect(tryResolveImageFnJoin({ 'Fn::Sub': 'foo:bar' }, repoResources, undefined)).toEqual({
      kind: 'not-applicable',
    });
    expect(tryResolveImageFnJoin(null, repoResources, undefined)).toEqual({
      kind: 'not-applicable',
    });
    expect(tryResolveImageFnJoin(undefined, repoResources, undefined)).toEqual({
      kind: 'not-applicable',
    });
  });

  it('returns needs-state when the canonical from-ECR shape has no state context', () => {
    const result = tryResolveImageFnJoin(
      canonicalFromEcrJoin('Repo1', 'latest'),
      repoResources,
      undefined
    );
    expect(result).toEqual({ kind: 'needs-state', repoLogicalId: 'Repo1' });
  });

  it('returns needs-state when state-resources is missing the matching entry', () => {
    const ctx: ImageResolutionContext = {
      pseudoParameters: { urlSuffix: 'amazonaws.com' },
      // stateResources omitted entirely → needs-state
    };
    const result = tryResolveImageFnJoin(
      canonicalFromEcrJoin('Repo1', 'latest'),
      repoResources,
      ctx
    );
    expect(result).toEqual({ kind: 'needs-state', repoLogicalId: 'Repo1' });
  });

  it('resolves canonical from-ECR Fn::Join when full state + pseudo-parameters are supplied', () => {
    const stateResources: Record<string, ResourceState> = {
      Repo1: {
        physicalId: 'my-repo-name',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: {
          Arn: 'arn:aws:ecr:us-east-1:111111111111:repository/my-repo-name',
        },
        dependencies: [],
      },
    };
    const ctx: ImageResolutionContext = {
      pseudoParameters: { urlSuffix: 'amazonaws.com' },
      stateResources,
    };
    const result = tryResolveImageFnJoin(
      canonicalFromEcrJoin('Repo1', 'latest'),
      repoResources,
      ctx
    );
    expect(result).toEqual({
      kind: 'resolved',
      uri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/my-repo-name:latest',
    });
  });

  it('resolves a digest-form from-ECR Fn::Join (with @sha256: tail)', () => {
    const stateResources: Record<string, ResourceState> = {
      Repo1: {
        physicalId: 'r',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: { Arn: 'arn:aws:ecr:us-west-2:222222222222:repository/r' },
        dependencies: [],
      },
    };
    const result = tryResolveImageFnJoin(
      canonicalFromEcrJoin('Repo1', 'sha256:abc123'),
      repoResources,
      { pseudoParameters: { urlSuffix: 'amazonaws.com' }, stateResources }
    );
    expect(result).toEqual({
      kind: 'resolved',
      uri: '222222222222.dkr.ecr.us-west-2.amazonaws.com/r@sha256:abc123',
    });
  });

  it('returns not-applicable for an unrelated Fn::Join with no ECR refs and unresolvable parts', () => {
    // Imported-repo style — literal acct + region, `Ref: AWS::URLSuffix`,
    // literal path. No same-stack ECR Repository ref. Without pseudo-
    // parameter context the URLSuffix Ref returns undefined, so we fall
    // through to not-applicable (the caller surfaces its own error).
    const importedShape = {
      'Fn::Join': [
        '',
        ['123456789012.dkr.ecr.us-east-1.', { Ref: 'AWS::URLSuffix' }, '/external:v1'],
      ],
    };
    expect(tryResolveImageFnJoin(importedShape, {}, undefined)).toEqual({
      kind: 'not-applicable',
    });
  });

  it('resolves a public-URI Fn::Join with no intrinsic refs (literal concat only)', () => {
    const literalShape = {
      'Fn::Join': ['', ['public.ecr.aws/', 'nginx/nginx', ':alpine']],
    };
    expect(tryResolveImageFnJoin(literalShape, {}, undefined)).toEqual({
      kind: 'resolved',
      uri: 'public.ecr.aws/nginx/nginx:alpine',
    });
  });

  it('rejects a malformed Fn::Join (wrong shape)', () => {
    const bad = { 'Fn::Join': 'not-an-array' };
    expect(tryResolveImageFnJoin(bad, {}, undefined)).toEqual({
      kind: 'unsupported-join',
      reason: expect.stringContaining('Fn::Join must be'),
    });
  });

  it('rejects an Fn::Join with a non-string delimiter', () => {
    const bad = { 'Fn::Join': [42, ['a', 'b']] };
    expect(tryResolveImageFnJoin(bad, {}, undefined)).toEqual({
      kind: 'unsupported-join',
      reason: expect.stringContaining('delimiter must be a string'),
    });
  });

  it('returns unsupported-join for an ECR-tree shape with an unresolvable element', () => {
    // The Repo1 ref is present (so repoLogicalId is set), and stateResources
    // is also present (so the needs-state path is skipped). But one of the
    // inner elements is an unsupported intrinsic that the resolver does
    // not handle, so it cannot be reduced to a string.
    const stateResources: Record<string, ResourceState> = {
      Repo1: {
        physicalId: 'r',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: { Arn: 'arn:aws:ecr:us-east-1:111111111111:repository/r' },
        dependencies: [],
      },
    };
    const ctx: ImageResolutionContext = {
      pseudoParameters: { urlSuffix: 'amazonaws.com' },
      stateResources,
    };
    const bad = {
      'Fn::Join': [
        '',
        [
          { Ref: 'Repo1' },
          ':',
          // Fn::If is intentionally out of scope for this resolver.
          { 'Fn::If': ['SomeCondition', 'a', 'b'] },
        ],
      ],
    };
    const result = tryResolveImageFnJoin(bad, repoResources, ctx);
    expect(result.kind).toBe('unsupported-join');
  });
});

describe('substituteImagePlaceholders', () => {
  it('passes through strings with no placeholders unchanged', () => {
    expect(substituteImagePlaceholders('public.ecr.aws/x:1', {}, undefined)).toBe(
      'public.ecr.aws/x:1'
    );
  });

  it('substitutes AWS pseudo parameters', () => {
    const ctx: ImageResolutionContext = {
      pseudoParameters: {
        accountId: '111111111111',
        region: 'us-east-1',
        partition: 'aws',
        urlSuffix: 'amazonaws.com',
      },
    };
    expect(
      substituteImagePlaceholders(
        '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/repo:tag',
        {},
        ctx
      )
    ).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:tag');
  });

  it('substitutes same-stack ECR Repository Ref and GetAtt placeholders', () => {
    const resources: Record<string, TemplateResource> = {
      Repo1: { Type: 'AWS::ECR::Repository', Properties: {} },
    };
    const stateResources: Record<string, ResourceState> = {
      Repo1: {
        physicalId: 'my-repo-name',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: { Arn: 'arn:aws:ecr:us-east-1:111111111111:repository/my-repo-name' },
        dependencies: [],
      },
    };
    expect(
      substituteImagePlaceholders('prefix-${Repo1}-${Repo1.Arn}', resources, {
        stateResources,
      })
    ).toBe(
      'prefix-my-repo-name-arn:aws:ecr:us-east-1:111111111111:repository/my-repo-name'
    );
  });

  it('leaves unrecognized placeholders untouched', () => {
    expect(substituteImagePlaceholders('${Unknown}/x', {}, undefined)).toBe('${Unknown}/x');
  });
});

describe('derivePseudoParametersFromRegion (issue #637)', () => {
  it('returns aws partition for standard commercial regions', () => {
    expect(derivePseudoParametersFromRegion('us-east-1')).toEqual({
      region: 'us-east-1',
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
    expect(derivePseudoParametersFromRegion('eu-west-2')).toEqual({
      region: 'eu-west-2',
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
    expect(derivePseudoParametersFromRegion('ap-northeast-1')).toEqual({
      region: 'ap-northeast-1',
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
  });

  it('returns aws-cn partition + .com.cn urlSuffix for China regions', () => {
    expect(derivePseudoParametersFromRegion('cn-north-1')).toEqual({
      region: 'cn-north-1',
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
    });
    expect(derivePseudoParametersFromRegion('cn-northwest-1')).toEqual({
      region: 'cn-northwest-1',
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
    });
  });

  it('returns aws-us-gov partition for GovCloud regions (urlSuffix stays .com)', () => {
    expect(derivePseudoParametersFromRegion('us-gov-west-1')).toEqual({
      region: 'us-gov-west-1',
      partition: 'aws-us-gov',
      urlSuffix: 'amazonaws.com',
    });
    expect(derivePseudoParametersFromRegion('us-gov-east-1')).toEqual({
      region: 'us-gov-east-1',
      partition: 'aws-us-gov',
      urlSuffix: 'amazonaws.com',
    });
  });

  it('returns aws-iso / aws-iso-b partitions for ISO regions', () => {
    // us-isob-* must be checked BEFORE us-iso-* (prefix overlap).
    expect(derivePseudoParametersFromRegion('us-iso-east-1')).toEqual({
      region: 'us-iso-east-1',
      partition: 'aws-iso',
      urlSuffix: 'c2s.ic.gov',
    });
    expect(derivePseudoParametersFromRegion('us-isob-east-1')).toEqual({
      region: 'us-isob-east-1',
      partition: 'aws-iso-b',
      urlSuffix: 'sc2s.sgov.gov',
    });
  });

  it('passes accountId through when supplied', () => {
    expect(derivePseudoParametersFromRegion('us-east-1', '123456789012')).toEqual({
      accountId: '123456789012',
      region: 'us-east-1',
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
  });

  it('omits accountId field when not supplied', () => {
    const result = derivePseudoParametersFromRegion('us-east-1');
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('accountId');
  });

  it('returns undefined for empty / falsy region', () => {
    expect(derivePseudoParametersFromRegion(undefined)).toBeUndefined();
    expect(derivePseudoParametersFromRegion('')).toBeUndefined();
  });
});
