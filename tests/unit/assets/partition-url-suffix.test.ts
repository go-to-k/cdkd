import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockEcrSend, mockEcrDestroy, mockRunDocker } = vi.hoisted(() => ({
  mockEcrSend: vi.fn(),
  mockEcrDestroy: vi.fn(),
  mockRunDocker: vi.fn(),
}));

vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation(() => ({
    send: mockEcrSend,
    destroy: mockEcrDestroy,
  })),
  GetAuthorizationTokenCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'GetAuthorizationToken',
  })),
  DescribeImagesCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'DescribeImages',
  })),
}));

vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return { ...actual, runDockerStreaming: mockRunDocker };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLevel: () => 'info',
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      getLevel: () => 'info',
    }),
  }),
}));

import {
  DockerAssetPublisher,
  resetEcrLoginCache,
} from '../../../src/assets/docker-asset-publisher.js';
import {
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../../src/assets/asset-redirect.js';
import type { DockerImageAsset } from '../../../src/types/assets.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const ACCOUNT = '123456789012';

/**
 * Issue #1745 — every ECR registry URI in the publisher hardcoded
 * `amazonaws.com`, so outside the commercial partition cdkd pushed to (and
 * logged into) a hostname that does not resolve. Commercial output must stay
 * byte-identical.
 */
describe('DockerAssetPublisher derives the ECR registry suffix (issue #1745)', () => {
  let publisher: DockerAssetPublisher;

  const asset = (): DockerImageAsset => ({
    displayName: 'TestDockerAsset',
    source: { directory: 'asset.docker123' },
    destinations: {
      'current-account': { repositoryName: 'my-repo', imageTag: 'abc123' },
    },
  });

  const authToken = Buffer.from('AWS:mock-password').toString('base64');

  beforeEach(() => {
    vi.clearAllMocks();
    resetEcrLoginCache();
    publisher = new DockerAssetPublisher();
    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        const err = new Error('Image not found') as Error & { name: string };
        err.name = 'ImageNotFoundException';
        throw err;
      }
      if (cmd._type === 'GetAuthorizationToken') {
        return { authorizationData: [{ authorizationToken: authToken }] };
      }
      return {};
    });
    // Fail the first push with an auth error so the lazy ECR login fires and
    // the login ENDPOINT (the second hardcoded site) is observable too.
    let pushes = 0;
    mockRunDocker.mockImplementation((args: string[]) => {
      if (args[0] === 'push' && pushes++ === 0) {
        const err = new Error('push failed') as Error & { stderr: string };
        err.stderr = 'no basic auth credentials';
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  });

  const dockerArgs = (verb: string): string[][] =>
    mockRunDocker.mock.calls.map(([a]) => a as string[]).filter((a) => a[0] === verb);

  it('a cn- region pushes and logs in to amazonaws.com.cn', async () => {
    await publisher.publish('h1', asset(), '/tmp/out', ACCOUNT, 'cn-north-1');

    const target = dockerArgs('push')[0]?.[1];
    expect(target).toBe(`${ACCOUNT}.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:abc123`);

    // The lazy-login endpoint falls back to the constructed registry host when
    // AWS reports no `proxyEndpoint`.
    const login = dockerArgs('login')[0];
    expect(login?.[login.length - 1]).toBe(
      `https://${ACCOUNT}.dkr.ecr.cn-north-1.amazonaws.com.cn`
    );
  });

  it('a commercial region is byte-identical to the pre-fix output', async () => {
    await publisher.publish('h1', asset(), '/tmp/out', ACCOUNT, 'us-east-1');

    expect(dockerArgs('push')[0]?.[1]).toBe(
      `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/my-repo:abc123`
    );
  });

  // `publish()` above has NO production caller — `AssetPublisher` drives
  // `build()` + `push()` (src/assets/asset-publisher.ts). PR review caught that
  // testing only `publish()` left the ACTUAL deploy push target unpinned, so a
  // hardcoded suffix there would have shipped green. These two cover `push()`.
  it('push() — the method the deploy path actually calls — uses the derived suffix', async () => {
    await publisher.push(asset(), ACCOUNT, 'cn-north-1', 'local-tag');

    expect(dockerArgs('push')[0]?.[1]).toBe(
      `${ACCOUNT}.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:abc123`
    );
  });

  it('push() in a commercial region is byte-identical', async () => {
    await publisher.push(asset(), ACCOUNT, 'us-east-1', 'local-tag');

    expect(dockerArgs('push')[0]?.[1]).toBe(
      `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/my-repo:abc123`
    );
  });

  it('the login cache is keyed by the SUFFIXED registry — two pushes, one login', async () => {
    await publisher.push(asset(), ACCOUNT, 'cn-north-1', 'local-tag');
    await publisher.push(asset(), ACCOUNT, 'cn-north-1', 'local-tag');

    // The first push fails auth once (see beforeEach) and triggers the lazy
    // login; the second must reuse the cached entry rather than re-login.
    expect(dockerArgs('login')).toHaveLength(1);
  });
});

/**
 * Issue #1745 — `evaluatePseudoParam`'s `AWS::URLSuffix` arm returned a
 * hardcoded `amazonaws.com` while claiming to mirror `IntrinsicFunctionResolver`,
 * which derives it. A folded `Fn::Join` therefore produced an unresolvable host
 * outside the commercial partition.
 */
describe('asset-redirect folds AWS::URLSuffix from the region (issue #1745)', () => {
  const mapFor = (region: string): AssetRedirectMap => ({
    buckets: new Map([[`cdk-hnb659fds-assets-${ACCOUNT}-${region}`, 'cdkd-assets']]),
    repos: new Map(),
    entries: [{ source: `cdk-hnb659fds-assets-${ACCOUNT}-${region}`, target: 'cdkd-assets' }],
    accountId: ACCOUNT,
    region,
    // Production shape: every `buildAssetRedirectMap` caller omits the
    // `partition` argument, so this field is ALWAYS the 'aws' default. Hand-building
    // 'aws-cn' here is what masked the un-derived `AWS::Partition` arm from review.
    partition: 'aws',
  });

  const templateFor = (region: string): CloudFormationTemplate =>
    ({
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            CodeUri: {
              'Fn::Join': [
                '',
                [
                  'https://s3.',
                  { Ref: 'AWS::Region' },
                  '.',
                  { Ref: 'AWS::URLSuffix' },
                  `/cdk-hnb659fds-assets-${ACCOUNT}-${region}/aaaa1111.zip`,
                ],
              ],
            },
          },
        },
      },
    }) as unknown as CloudFormationTemplate;

  const codeUriOf = (t: CloudFormationTemplate): unknown =>
    (
      (t.Resources!['Fn'] as { Properties: Record<string, unknown> }).Properties as {
        CodeUri: unknown;
      }
    ).CodeUri;

  it('a cn- region folds to amazonaws.com.cn', () => {
    const template = templateFor('cn-north-1');
    expect(rewriteTemplateAssetReferences(template, mapFor('cn-north-1'))).toBe(1);
    expect(JSON.stringify(codeUriOf(template))).toContain('amazonaws.com.cn');
    expect(JSON.stringify(codeUriOf(template))).toContain('cdkd-assets');
  });

  it('AWS::Partition folds from the region too — the same switch must not contradict itself', () => {
    // Review finding: fixing only the URLSuffix arm left `AWS::Partition`
    // returning `map.partition`, which is unconditionally 'aws' because every
    // caller omits the argument. A cn fold then emitted `arn:aws:` alongside
    // `amazonaws.com.cn` in ONE template.
    const template = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Arn: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':s3:::cdk-hnb659fds-assets-' + ACCOUNT + '-cn-north-1/x.zip',
                ],
              ],
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    expect(rewriteTemplateAssetReferences(template, mapFor('cn-north-1'))).toBe(1);
    const rendered = JSON.stringify(
      (
        (template.Resources!['Fn'] as { Properties: Record<string, unknown> }).Properties as {
          Arn: unknown;
        }
      ).Arn
    );
    expect(rendered).toContain('arn:aws-cn:');
    expect(rendered).not.toContain('arn:aws:');
  });

  it('a commercial region still folds to amazonaws.com', () => {
    const template = templateFor('us-east-1');
    expect(rewriteTemplateAssetReferences(template, mapFor('us-east-1'))).toBe(1);
    const rendered = JSON.stringify(codeUriOf(template));
    // NOT `toContain('amazonaws.com')` — that is satisfied by `amazonaws.com.cn`
    // too, so it could not tell the commercial fold from the cn one.
    expect(rendered).toContain('s3.us-east-1.amazonaws.com/');
    expect(rendered).not.toContain('amazonaws.com.cn');
  });
});
