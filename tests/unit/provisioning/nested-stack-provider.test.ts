import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NestedStackProvider,
  isAbsoluteCrossPlatform,
} from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { StackState } from '../../../src/types/state.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
} from '../../../src/deployment/retryable-errors.js';

// Mock DeployEngine so create / update don't require a real S3 backend.
// The mock records every constructor call AND the AsyncLocalStorage
// context at deploy() time so the test can verify both the constructor
// inputs (parentStackInfo etc.) and the ALS childCtx the recursive
// provider switched into for grandchild resolution.
const deployCalls: Array<{
  ctor: unknown[];
  deploy: {
    stackName: string;
    templateResourceCount: number;
    template: { Resources?: Record<string, unknown> };
    capturedCtx: NestedStackProviderContext | undefined;
  };
}> = [];
vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation((...ctor: unknown[]) => ({
    deploy: vi.fn(async (stackName: string, template: { Resources?: Record<string, unknown> }) => {
      // Dynamic import inside the mock factory body: top-level imports
      // are hoisted before vi.mock() and would create a TDZ / circular
      // ref. Lazy import resolves at call time after the module graph
      // has settled.
      const ctxMod = await import('../../../src/provisioning/nested-stack-context.js');
      const capturedCtx = ctxMod.getCurrentNestedStackContext();
      deployCalls.push({
        ctor,
        deploy: {
          stackName,
          templateResourceCount: Object.keys(template.Resources ?? {}).length,
          template,
          capturedCtx,
        },
      });
      return {
        stackName,
        created: 1,
        updated: 0,
        deleted: 0,
        unchanged: 0,
        durationMs: 1,
        outputs: {},
      };
    }),
  })),
  DEFAULT_RESOURCE_WARN_AFTER_MS: 5 * 60 * 1000,
  DEFAULT_RESOURCE_TIMEOUT_MS: 30 * 60 * 1000,
}));

// Mock runDestroyForStack so delete doesn't require an actual destroy
// pipeline. Records every invocation AND the ALS context captured at
// call time so the test can verify the child-context swap on the
// recursive destroy path.
const destroyCalls: Array<{
  stackName: string;
  skipConfirmation: boolean;
  destroyCtx: Record<string, unknown>;
  capturedCtx: NestedStackProviderContext | undefined;
}> = [];
/**
 * Issue #1752: per-test override of the child runner's reported counts, so a
 * case can make the child report a SKIPPED resource. `vi.hoisted` because the
 * `vi.mock` factory below is hoisted above ordinary module scope.
 */
const childCounts = vi.hoisted(() => ({ value: {} as Record<string, number | boolean> }));
/**
 * Issue #1777 (G3): per-STACK-NAME override, so a test can make the mocked
 * runner behave differently per level of a nested tree — and, crucially, can
 * RECURSE by calling the provider again from inside it. That is what lets a
 * 3-level (grandchild -> child -> parent) failure chain be exercised: the real
 * runner reaching a nested-stack row calls `provider.delete`, and turns a throw
 * from it into `errorCount`, which is exactly what this override emulates.
 */
const childRunnerOverride = vi.hoisted(() => ({
  fn: undefined as
    | ((stackName: string) => Promise<Record<string, number | boolean> | undefined>)
    | undefined,
}));
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: vi.fn(async (stackName: string, _state: StackState, ctx: Record<string, unknown>) => {
    const ctxMod = await import('../../../src/provisioning/nested-stack-context.js');
    const capturedCtx = ctxMod.getCurrentNestedStackContext();
    destroyCalls.push({
      stackName,
      skipConfirmation: ctx['skipConfirmation'] as boolean,
      destroyCtx: ctx,
      capturedCtx,
    });
    const perStack = childRunnerOverride.fn ? await childRunnerOverride.fn(stackName) : undefined;
    return {
      stackName,
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
      retainedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      interrupted: false,
      ...childCounts.value,
      ...(perStack ?? {}),
    };
  }),
}));

function makeChildState(outputs: Record<string, unknown> = {}): StackState {
  return {
    version: 6,
    stackName: 'Parent~Child',
    region: 'us-east-1',
    resources: { Foo: { physicalId: 'foo-123', resourceType: 'AWS::S3::Bucket', properties: {}, attributes: {}, dependencies: [] } },
    outputs,
    lastModified: Date.now(),
  };
}

function makeContext(overrides: Partial<NestedStackProviderContext> = {}): NestedStackProviderContext {
  const childState = makeChildState({ BucketName: 'my-bucket-123' });
  // Minimal fakes — only the fields NestedStackProvider actually touches.
  const stateBackend = {
    getState: vi.fn(async () => ({ state: childState, etag: 'etag-1' })),
  } as unknown as NestedStackProviderContext['stateBackend'];
  return {
    stateBackend,
    lockManager: {} as NestedStackProviderContext['lockManager'],
    providerRegistry: {} as NestedStackProviderContext['providerRegistry'],
    parentStackName: 'Parent',
    parentRegion: 'us-east-1',
    accountId: '123456789012',
    awsClients: {} as NestedStackProviderContext['awsClients'],
    stateBucket: 'cdkd-state-test',
    dagBuilder: {} as NestedStackProviderContext['dagBuilder'],
    diffCalculator: {} as NestedStackProviderContext['diffCalculator'],
    options: { concurrency: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  deployCalls.length = 0;
  destroyCalls.length = 0;
  childCounts.value = {};
  childRunnerOverride.fn = undefined;
});

describe('NestedStackProvider', () => {
  describe('outside withNestedStackContext()', () => {
    it('create() throws — caller must wrap in withNestedStackContext()', async () => {
      const provider = new NestedStackProvider();
      await expect(provider.create('Child', 'AWS::CloudFormation::Stack', {})).rejects.toThrow(
        /invoked outside withNestedStackContext/
      );
    });

    it('update() throws — caller must wrap in withNestedStackContext()', async () => {
      const provider = new NestedStackProvider();
      await expect(
        provider.update('Child', 'arn:cdkd-local:us-east-1:123:nested-stack/p/c', 'AWS::CloudFormation::Stack', {}, {})
      ).rejects.toThrow(/invoked outside withNestedStackContext/);
    });

    it('delete() throws — caller must wrap in withNestedStackContext()', async () => {
      const provider = new NestedStackProvider();
      await expect(
        provider.delete('Child', 'arn:cdkd-local:us-east-1:123:nested-stack/p/c', 'AWS::CloudFormation::Stack')
      ).rejects.toThrow(/invoked outside withNestedStackContext/);
    });
  });

  describe('getAttribute()', () => {
    it('throws — the resolver fast-paths Outputs.X via state.attributes; reaching this method is a bug', async () => {
      const provider = new NestedStackProvider();
      await expect(
        provider.getAttribute('arn:cdkd-local:us-east-1:123:nested-stack/p/c', 'AWS::CloudFormation::Stack', 'Outputs.Missing')
      ).rejects.toThrow(/not in the recorded Outputs map/);
    });
  });

  describe('create()', () => {
    it('requires deploy-mode context fields — nestedTemplates: undefined', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: undefined });
      await expect(
        withNestedStackContext(ctx, () => provider.create('Child', 'AWS::CloudFormation::Stack', {}))
      ).rejects.toThrow(/deploy-mode context fields .* are missing/);
    });

    // B1 per-arm coverage (issue #556): the requireDeployContext `||` check
    // has three arms; only `nestedTemplates: undefined` is exercised above.
    // Cover the other two so a future split of the unified `||` (e.g. into
    // per-arm error messages naming exactly which field is missing) does
    // not silently regress one arm.
    it('requires deploy-mode context fields — dagBuilder: undefined', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext({ dagBuilder: undefined });
      await expect(
        withNestedStackContext(ctx, () => provider.create('Child', 'AWS::CloudFormation::Stack', {}))
      ).rejects.toThrow(/deploy-mode context fields .* are missing/);
    });

    it('requires deploy-mode context fields — diffCalculator: undefined', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext({ diffCalculator: undefined });
      await expect(
        withNestedStackContext(ctx, () => provider.create('Child', 'AWS::CloudFormation::Stack', {}))
      ).rejects.toThrow(/deploy-mode context fields .* are missing/);
    });

    it('rejects when the child template file is missing from nestedTemplates', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: {} });
      await expect(
        withNestedStackContext(ctx, () => provider.create('Child', 'AWS::CloudFormation::Stack', {}))
      ).rejects.toThrow(/Nested template file not found for AWS::CloudFormation::Stack 'Child'/);
    });

    // B2 readChildTemplate failure paths (issue #556): the private helper
    // wraps both `fs.readFileSync` ENOENT and `JSON.parse` SyntaxError with
    // file-path context. A future refactor that drops the wrapping (e.g.
    // letting raw `ENOENT: no such file or directory, open '...'` bubble)
    // would lose the actionable signal — the user would see the path only
    // by introspecting `error.cause`, which most error-display surfaces
    // don't render. These cases pin the contract.
    it('readChildTemplate: wraps fs.readFileSync ENOENT with template path', async () => {
      const provider = new NestedStackProvider();
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-enoent-'));
      const missingPath = join(dir, 'does-not-exist.nested.template.json');
      const ctx = makeContext({ nestedTemplates: { Child: missingPath } });
      await expect(
        withNestedStackContext(ctx, () => provider.create('Child', 'AWS::CloudFormation::Stack', {}))
      ).rejects.toThrow(
        new RegExp(`Failed to read nested template at ${missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
    });

    it('readChildTemplate: wraps JSON.parse SyntaxError with template path', async () => {
      const provider = new NestedStackProvider();
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-parse-'));
      const invalidPath = join(dir, 'invalid.nested.template.json');
      writeFileSync(invalidPath, '{ this is not valid JSON ::: }');
      const ctx = makeContext({ nestedTemplates: { Child: invalidPath } });
      await expect(
        withNestedStackContext(ctx, () => provider.create('Child', 'AWS::CloudFormation::Stack', {}))
      ).rejects.toThrow(
        new RegExp(`Failed to parse nested template at ${invalidPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
    });

    it('reads child template, dispatches child DeployEngine, returns synthesized ARN + flat Outputs', async () => {
      // Write a minimal child template to disk so the provider reads it.
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-'));
      const childTemplatePath = join(dir, 'child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: { Foo: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b1' } } },
        })
      );

      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: { Child: childTemplatePath } });

      const result = await withNestedStackContext(ctx, () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {
          TemplateURL: 'https://example.com/child.json',
          Parameters: { Env: 'prod' },
        })
      );

      // Synthesized fake ARN with cdkd-local partition (design §3).
      expect(result.physicalId).toBe(
        'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child'
      );
      // Outputs flatten to Outputs.<Key> attribute keys for the resolver fast-path.
      expect(result.attributes).toEqual({ 'Outputs.BucketName': 'my-bucket-123' });

      // Child DeployEngine ran exactly once against the derived state key.
      expect(deployCalls.length).toBe(1);
      expect(deployCalls[0]!.deploy.stackName).toBe('Parent~Child');
      expect(deployCalls[0]!.deploy.templateResourceCount).toBe(1);

      // The DeployEngine was constructed with parentStackInfo (so the child
      // saves parentStack / parentLogicalId / parentRegion on its state).
      // Constructor signature: (stateBackend, lockManager, dagBuilder, diffCalculator, providerRegistry, options, stackRegion, exportIndexStore).
      const opts = deployCalls[0]!.ctor[5] as Record<string, unknown>;
      expect(opts.parameters).toEqual({ Env: 'prod' });
      expect(opts.parentStackInfo).toEqual({
        parentStack: 'Parent',
        parentLogicalId: 'Child',
        parentRegion: 'us-east-1',
      });
      // Child region inherits parent region (AWS forbids cross-region nested stacks).
      expect(deployCalls[0]!.ctor[6]).toBe('us-east-1');

      // ALS context-swap is the load-bearing piece for recursive grandchild
      // resolution: the child engine MUST see itself as the new "parent" so
      // any AWS::CloudFormation::Stack resource inside the child template
      // resolves grandchild templates against the child's directory, not
      // the top-level parent's. The mock captured the ALS context at
      // `deploy()` invocation time — verify the swap.
      const captured = deployCalls[0]!.deploy.capturedCtx;
      expect(captured?.parentStackName).toBe('Parent~Child');
      expect(captured?.parentRegion).toBe('us-east-1');
      // No grandchildren in this fixture: the child template has only
      // an S3 bucket, so the indexed grandchild-templates map is empty.
      expect(captured?.nestedTemplates).toEqual({});
    });

    it('applies the #1002 asset-reference rewrite to the child template when ctx.assetRedirect is set', async () => {
      const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-'));
      const childTemplatePath = join(dir, 'child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: {
            Fn: {
              Type: 'AWS::Lambda::Function',
              Properties: {
                Code: {
                  S3Bucket: {
                    'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
                  },
                  S3Key: 'aaaa1111.zip',
                },
              },
            },
          },
        })
      );

      const assetRedirect = buildAssetRedirectMap(
        {
          version: '38.0.0',
          files: {
            aaaa1111: {
              displayName: 'Code',
              source: { path: 'asset.aaaa1111', packaging: 'zip' },
              destinations: {
                d1: {
                  bucketName: 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
                  objectKey: 'aaaa1111.zip',
                },
              },
            },
          },
          dockerImages: {},
        },
        {
          assetBucket: 'cdkd-assets-123456789012-us-east-1',
          containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
          assetSupportVersion: 1,
          createdAt: '2026-07-15T00:00:00.000Z',
        },
        '123456789012',
        'us-east-1'
      );

      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: { Child: childTemplatePath }, assetRedirect });

      await withNestedStackContext(ctx, () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      );

      expect(deployCalls.length).toBe(1);
      const deployedTemplate = deployCalls[0]!.deploy.template as {
        Resources: { Fn: { Properties: { Code: { S3Bucket: { 'Fn::Sub': string } } } } };
      };
      expect(deployedTemplate.Resources.Fn.Properties.Code.S3Bucket['Fn::Sub']).toBe(
        'cdkd-assets-123456789012-us-east-1'
      );
      // The child ALS context inherits the redirect map so grandchildren
      // rewrite too.
      expect(deployCalls[0]!.deploy.capturedCtx?.assetRedirect).toBe(assetRedirect);
    });

    it('indexes grandchild templates from the child template + rejects absolute aws:asset:path', async () => {
      // 2-level fixture: the child template itself contains an
      // AWS::CloudFormation::Stack pointing at a grandchild template file
      // sibling to the child. Verifies indexGrandchildTemplates walks the
      // child template's Resources for Metadata['aws:asset:path'].
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-grand-'));
      const childTemplatePath = join(dir, 'child.nested.template.json');
      const grandchildAssetName = 'grandchild.nested.template.json';
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: {
            // Three branches of indexGrandchildTemplates exercised in one fixture:
            // (a) recorded: AWS::CloudFormation::Stack + relative asset path.
            Grandchild: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: { TemplateURL: 'https://example.com/g.json' },
              Metadata: { 'aws:asset:path': grandchildAssetName },
            },
            // (b) skipped: non-nested-stack resource type — no Metadata to walk.
            SiblingBucket: { Type: 'AWS::S3::Bucket' },
            // (c) skipped: AWS::CloudFormation::Stack with no Metadata at all.
            StackWithoutMeta: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: { TemplateURL: 'https://example.com/x.json' },
            },
          },
        })
      );

      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: { Child: childTemplatePath } });

      await withNestedStackContext(ctx, () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      );

      // The captured childCtx's nestedTemplates must contain exactly the
      // Grandchild entry (absolute path = childTemplate's dir joined with
      // the relative aws:asset:path).
      const captured = deployCalls[0]!.deploy.capturedCtx;
      expect(captured?.nestedTemplates).toEqual({
        Grandchild: join(dir, grandchildAssetName),
      });
    });

    it('rejects absolute aws:asset:path on grandchild (defensive — CDK only emits relative paths)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-abs-'));
      const childTemplatePath = join(dir, 'child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: {
            Grandchild: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: { TemplateURL: 'https://example.com/g.json' },
              // Absolute path — should be rejected defensively.
              Metadata: { 'aws:asset:path': '/abs/path/to/grandchild.json' },
            },
          },
        })
      );

      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: { Child: childTemplatePath } });

      await expect(
        withNestedStackContext(ctx, () =>
          provider.create('Child', 'AWS::CloudFormation::Stack', {})
        )
      ).rejects.toThrow(/which is absolute/);
    });
  });

  describe('isAbsoluteCrossPlatform()', () => {
    // POSIX-style absolute paths are rejected on every platform.
    // `path.isAbsolute('/abs/foo')` returns `true` on POSIX but `false`
    // on Windows (Windows absolute paths require a drive letter or UNC
    // root), so the `startsWith('/')` fallback is what guarantees the
    // rejection holds when a Linux-synthesized template is consumed on
    // a Windows host.
    it('accepts relative paths', () => {
      expect(isAbsoluteCrossPlatform('foo/bar.json')).toBe(false);
      expect(isAbsoluteCrossPlatform('./foo/bar.json')).toBe(false);
      expect(isAbsoluteCrossPlatform('../foo/bar.json')).toBe(false);
      expect(isAbsoluteCrossPlatform('foo.json')).toBe(false);
    });

    it('rejects POSIX-style absolute paths regardless of host platform', () => {
      expect(isAbsoluteCrossPlatform('/abs/foo')).toBe(true);
      expect(isAbsoluteCrossPlatform('/foo.json')).toBe(true);
      expect(isAbsoluteCrossPlatform('/')).toBe(true);
    });
  });

  describe('update()', () => {
    it('keeps physicalId stable (no replacement) and refreshes Outputs attributes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-'));
      const childTemplatePath = join(dir, 'child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: { Foo: { Type: 'AWS::S3::Bucket' } },
        })
      );

      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: { Child: childTemplatePath } });
      const existingArn = 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child';

      const result = await withNestedStackContext(ctx, () =>
        provider.update('Child', existingArn, 'AWS::CloudFormation::Stack', {}, {})
      );

      expect(result.physicalId).toBe(existingArn);
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({ 'Outputs.BucketName': 'my-bucket-123' });
    });
  });

  describe('delete()', () => {
    it('idempotently succeeds when the child state file does not exist', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext({
        stateBackend: {
          getState: vi.fn(async () => null),
        } as unknown as NestedStackProviderContext['stateBackend'],
      });
      await expect(
        withNestedStackContext(ctx, () =>
          provider.delete('Child', 'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child', 'AWS::CloudFormation::Stack')
        )
      ).resolves.toBeUndefined();
      expect(destroyCalls.length).toBe(0);
    });

    it('routes through runDestroyForStack with skipConfirmation=true when child state exists', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext();
      await withNestedStackContext(ctx, () =>
        provider.delete('Child', 'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child', 'AWS::CloudFormation::Stack')
      );
      expect(destroyCalls.length).toBe(1);
      expect(destroyCalls[0]!.stackName).toBe('Parent~Child');
      expect(destroyCalls[0]!.skipConfirmation).toBe(true);

      // ALS context-swap on the destroy path: any grandchild
      // AWS::CloudFormation::Stack inside the child's state will resolve
      // against the child as its parent — verify the swap fired. Also
      // confirm `nestedTemplates` was nulled out (destroy is state-driven
      // and doesn't need a synth template index).
      const captured = destroyCalls[0]!.capturedCtx;
      expect(captured?.parentStackName).toBe('Parent~Child');
      expect(captured?.parentRegion).toBe('us-east-1');
      expect(captured?.nestedTemplates).toBeUndefined();
    });

    // Issue #1752: the child runner reports a resource it could not address as
    // `skippedCount`. Swallowing it here re-creates the mis-report one level
    // up — the PARENT would print `✓ Child (AWS::CloudFormation::Stack)
    // deleted`, drop the child's row from parent state and exit 0, while the
    // child's own state.json sits there preserved describing a live resource.
    it('propagates a child skip up as { outcome: "skipped" } (issue #1752)', async () => {
      childCounts.value = { deletedCount: 2, skippedCount: 1 };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      const result = await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack'
        )
      );

      expect(result).toEqual({
        outcome: 'skipped',
        reason: expect.stringContaining('Parent~Child'),
      });
      // The reason must carry the COUNT — the parent's status line is the only
      // place a user sees that the child left something behind.
      expect((result as { reason: string }).reason).toContain('1 resource(s)');
      expect(destroyCalls.length).toBe(1);
    });

    it('propagates a child INTERRUPT up as { outcome: "skipped" } (issue #1752 / #1777)', async () => {
      // Same data-loss shape as a skip, reached through a different field: a
      // SIGINT during the child's destroy leaves the child's state.json listing
      // live resources, while the parent — with no signal — would drop the
      // child's row and (with errorCount 0) delete the parent state.json and
      // the exports index outright.
      childCounts.value = { deletedCount: 1, skippedCount: 0, interrupted: true };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      const result = await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack'
        )
      );

      expect(result).toMatchObject({ outcome: 'skipped' });
      expect((result as { reason: string }).reason).toContain('was interrupted');
      expect((result as { reason: string }).reason).toContain('Parent~Child');
      // An interrupt alone must NOT claim resources were skipped.
      expect((result as { reason: string }).reason).not.toContain('resource(s)');
    });

    it('names BOTH causes when the child skipped AND was interrupted', async () => {
      childCounts.value = { deletedCount: 0, skippedCount: 2, interrupted: true };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      const result = await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack'
        )
      );

      const reason = (result as { reason: string }).reason;
      expect(reason).toContain('skipped 2 resource(s)');
      expect(reason).toContain('was interrupted');
    });

    // Issue #1777: the child's `errorCount` is the THIRD field saying "this
    // child stack is NOT gone", and the only one whose honest answer is a
    // THROW. Pre-fix it was swallowed entirely: the parent printed
    // `✓ Child (AWS::CloudFormation::Stack) deleted`, dropped the child's row,
    // and — with the parent's own errorCount still 0 — deleted the parent's
    // state.json AND the exports index, exiting 0.
    it('THROWS when a child resource genuinely FAILED to delete (issue #1777)', async () => {
      childCounts.value = { deletedCount: 1, skippedCount: 0, errorCount: 3 };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      await expect(
        withNestedStackContext(ctx, () =>
          provider.delete(
            'Child',
            'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
            'AWS::CloudFormation::Stack'
          )
        )
      ).rejects.toThrow(/Nested stack Parent~Child failed to destroy/);
    });

    it('the throw names the child stack, the failure COUNT and the child state remedy', async () => {
      childCounts.value = { deletedCount: 1, skippedCount: 0, errorCount: 3 };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      const err = await withNestedStackContext(ctx, () =>
        provider
          .delete(
            'Child',
            'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
            'AWS::CloudFormation::Stack'
          )
          .then(
            () => undefined,
            (e: unknown) => e as Error
          )
      );

      expect(err).toBeInstanceOf(Error);
      const msg = err!.message;
      // The count is the only place a user learns HOW MUCH of the child is
      // still live; the child's state key is the file they must actually open
      // (the parent's own state.json says nothing about which resource failed).
      expect(msg).toContain('3 resource(s) failed to delete');
      expect(msg).toContain("'cdkd state show Parent~Child'");
      // BOTH callers' catch blocks treat an already-deleted-shaped message as
      // an idempotent SUCCESS and drop the state row — the exact outcome this
      // throw exists to prevent. The two sets are not identical, so pin their
      // UNION verbatim rather than a shortened paraphrase:
      //   destroy-runner.ts  — 'does not exist', 'not found', 'No policy found',
      //                        'NoSuchEntity', 'NotFoundException'
      //   deploy-engine.ts   — the same five plus 'was not found' and
      //                        'ResourceNotFoundException'
      // (`'was not found'` / `'ResourceNotFoundException'` are substring-covered
      // by two of the others, but are listed so a future narrowing of either
      // caller's set cannot silently un-fence them here.)
      for (const phrase of [
        'does not exist',
        'not found',
        'No policy found',
        'NoSuchEntity',
        'NotFoundException',
        'was not found',
        'ResourceNotFoundException',
      ]) {
        expect(msg).not.toContain(phrase);
      }
    });

    // errorCount is the strongest of the three signals: something was ATTEMPTED
    // and FAILED. Reporting the run as a mere skip would be a lie in the other
    // direction (a skip means no AWS call was issued at all). All FOUR
    // (skip, interrupt) combinations are pinned: with only the both-set and
    // neither-set rows, SWAPPING the two clause bodies passes the whole file —
    // each row would still see exactly the text it asserts.
    it.each([
      {
        name: 'both a skip and an interrupt',
        counts: { skippedCount: 2, interrupted: true },
        expectSkipClause: true,
        expectInterruptClause: true,
      },
      {
        name: 'a skip only',
        counts: { skippedCount: 2, interrupted: false },
        expectSkipClause: true,
        expectInterruptClause: false,
      },
      {
        name: 'an interrupt only',
        counts: { skippedCount: 0, interrupted: true },
        expectSkipClause: false,
        expectInterruptClause: true,
      },
      {
        name: 'neither',
        counts: { skippedCount: 0, interrupted: false },
        expectSkipClause: false,
        expectInterruptClause: false,
      },
    ])(
      'the errorCount THROW wins over $name, and names exactly what happened',
      async ({ counts, expectSkipClause, expectInterruptClause }) => {
        childCounts.value = { deletedCount: 0, errorCount: 1, ...counts };
        const provider = new NestedStackProvider();
        const ctx = makeContext();

        const err = await withNestedStackContext(ctx, () =>
          provider
            .delete(
              'Child',
              'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
              'AWS::CloudFormation::Stack'
            )
            .then(
              () => undefined,
              (e: unknown) => e as Error
            )
        );

        expect(err).toBeInstanceOf(Error);
        const msg = err!.message;
        expect(msg).toContain('1 resource(s) failed to delete');

        const skipClause = '2 resource(s) were also skipped';
        const interruptClause = 'the child destroy was also interrupted';
        if (expectSkipClause) expect(msg).toContain(skipClause);
        else expect(msg).not.toContain('also skipped');
        if (expectInterruptClause) expect(msg).toContain(interruptClause);
        else expect(msg).not.toContain('also interrupted');

        // The suffix is conditional on there being something to say. An
        // unconditional `(${extra.join('; ')})` renders an empty `()` on the
        // neither-row — every `toContain` above still passes, so this is the
        // only assertion that fences the ternary. (`resource(s)` contributes
        // `(s)`, never `()`.)
        expect(msg).not.toContain('()');
      }
    );

    it('a child that skipped WITHOUT failing still returns { outcome: "skipped" }, not a throw', async () => {
      // The other side of the errorCount boundary: a skip is not a failure, so
      // it must NOT be converted into one. Without this control, "throw on
      // anything non-clean" passes every errorCount test above while breaking
      // the #1752 contract.
      childCounts.value = { deletedCount: 0, skippedCount: 2, errorCount: 0 };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      const result = await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack'
        )
      );

      expect(result).toMatchObject({ outcome: 'skipped' });
    });

    it('propagates a GRANDCHILD failure up the whole chain (3-level nesting)', async () => {
      // G3: the two other layers of coverage each mock the layer below them —
      // this file mocks the runner, the runner file mocks the provider — so
      // neither sees the RECURSION, and the integ fixture is only 2 levels deep.
      // Here the mocked runner for the CHILD calls back into the SAME provider
      // for its own `Grand` nested-stack row (which is what the real runner
      // does) and converts the throw into `errorCount`, exactly as
      // destroy-runner's catch does. So the chain under test is real:
      //   Grand fails -> child's provider.delete THROWS
      //                -> child's runner records errorCount: 1
      //                -> parent's provider.delete THROWS
      const provider = new NestedStackProvider();
      const ctx = makeContext();
      const grandchildErrors: string[] = [];

      childRunnerOverride.fn = async (stackName: string) => {
        if (stackName === 'Parent~Child') {
          try {
            await provider.delete(
              'Grand',
              'arn:cdkd-local:us-east-1:123:nested-stack/Parent~Child/Grand',
              'AWS::CloudFormation::Stack'
            );
            return { errorCount: 0 };
          } catch (e) {
            grandchildErrors.push((e as Error).message);
            return { errorCount: 1 };
          }
        }
        // The leaf: two of the grandchild's own resources failed to delete.
        if (stackName === 'Parent~Child~Grand') return { errorCount: 2 };
        return undefined;
      };

      const err = await withNestedStackContext(ctx, () =>
        provider
          .delete(
            'Child',
            'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
            'AWS::CloudFormation::Stack'
          )
          .then(
            () => undefined,
            (e: unknown) => e as Error
          )
      );

      // Every level was actually walked, and the `<parent>~<child>` key
      // derivation composed at depth 2 (the ALS context swap is what makes the
      // grandchild resolve against the CHILD as its parent).
      expect(destroyCalls.map((c) => c.stackName)).toEqual(['Parent~Child', 'Parent~Child~Grand']);

      // The grandchild's failure surfaced as its OWN throw, naming its own key.
      expect(grandchildErrors).toHaveLength(1);
      expect(grandchildErrors[0]).toContain('Nested stack Parent~Child~Grand failed to destroy');
      expect(grandchildErrors[0]).toContain('2 resource(s) failed to delete');

      // ...and the parent's failure names the CHILD, not the grandchild: each
      // level reports the level directly below it, so the user walks the tree
      // one `cdkd state show` at a time rather than being handed a leaf key
      // with no path to it.
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Nested stack Parent~Child failed to destroy');
      expect(err!.message).toContain('1 resource(s) failed to delete');
      expect(err!.message).not.toContain('Parent~Child~Grand');
    });

    it('a clean GRANDCHILD leaves the whole chain reporting deleted', async () => {
      // Inverted control for the chain above: without it, "recursion always
      // throws" would satisfy every assertion there.
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      childRunnerOverride.fn = async (stackName: string) => {
        if (stackName === 'Parent~Child') {
          await provider.delete(
            'Grand',
            'arn:cdkd-local:us-east-1:123:nested-stack/Parent~Child/Grand',
            'AWS::CloudFormation::Stack'
          );
          return { errorCount: 0 };
        }
        return undefined;
      };

      const result = await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack'
        )
      );

      expect(destroyCalls.map((c) => c.stackName)).toEqual(['Parent~Child', 'Parent~Child~Grand']);
      expect(result).toBeUndefined();
    });

    it('an ABSENT errorCount falls OPEN (no throw) rather than being treated as a failure', async () => {
      // Pinning a decision, not an accident. `DestroyRunnerResult.errorCount` is
      // a REQUIRED number that `runDestroyForStack` initializes to 0, so an
      // absent field can only come from a partial / stubbed result, never from
      // the real runner. Keying the throw on ABSENCE would turn every such
      // partial input into a hard failure — the anti-pattern that makes a
      // refusal fire on incomplete data instead of on the condition it names.
      // So `> 0` is deliberate: undefined behaves exactly like 0.
      //
      // The cost of that choice is real and is why this row exists rather than
      // the behavior being left undocumented: if a future refactor ever makes
      // the field optional, a genuinely failing child would silently report as
      // deleted again. This test is where that regression becomes visible.
      childCounts.value = {
        deletedCount: 1,
        skippedCount: 0,
        errorCount: undefined as unknown as number,
        interrupted: false,
      };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      const result = await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack'
        )
      );

      expect(result).toBeUndefined();
    });

    // Issue #1849: `nestedStackChildFailureMessage` interpolates
    // `<parent>~<childLogicalId>` — fully user-controlled — into a
    // cdkd-authored message, and `retryable-errors.ts` classifies by
    // SUBSTRING. Every assertion below discriminates the MARKER rather than
    // the wording: each pairs the real thrown error against a CONTROL built
    // from the SAME message text, so a future reword of the builder cannot
    // satisfy the test while the fix is gone.
    describe('non-retryable marking (issue #1849)', () => {
      // The child stack name is `${parentStackName}~${logicalId}`, so a
      // logical id carrying the pattern is enough — this is an ordinary
      // composite CDK id, not a contrived one.
      const POISON_ID = 'MyDependencyViolationSub';

      /** Drive `delete()` and return whatever it threw. */
      async function deleteAndCatch(
        logicalId: string,
        ctx = makeContext()
      ): Promise<unknown> {
        const provider = new NestedStackProvider();
        return withNestedStackContext(ctx, () =>
          provider
            .delete(
              logicalId,
              'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
              'AWS::CloudFormation::Stack'
            )
            .then(
              () => {
                throw new Error('expected delete() to throw');
              },
              (e: unknown) => e
            )
        );
      }

      // PREMISE. Without this the whole block could pass vacuously against a
      // message that never carried a retryable pattern at all — the marker
      // would be doing nothing and every assertion below would still be green.
      it('PREMISE: the pattern is in the table AND reaches the message', async () => {
        expect(RETRYABLE_ERROR_MESSAGE_PATTERNS).toContain('DependencyViolation');
        childCounts.value = { deletedCount: 0, errorCount: 1, interrupted: true };
        const err = (await deleteAndCatch(POISON_ID)) as Error;
        expect(err.message).toContain('DependencyViolation');
        expect(err.message).toContain(`Parent~${POISON_ID}`);
      });

      // MARKED ARM — the child destroy was INTERRUPTED. A retry would not heal
      // the failure; it would re-enter a destroy the user just aborted
      // (`draining` in destroy-runner.ts is a per-invocation local, so the
      // second attempt starts with the interrupt forgotten).
      it('an INTERRUPTED child failure is NOT retryable, despite the substring', async () => {
        childCounts.value = { deletedCount: 0, errorCount: 2, interrupted: true };
        const err = (await deleteAndCatch(POISON_ID)) as Error;

        expect(isMarkedNonRetryable(err)).toBe(true);
        expect(isRetryableTransientError(err, err.message)).toBe(false);
      });

      // CONTROL for the arm above. Pins the MARKER, not the wording: an
      // UNMARKED error carrying the byte-identical message is still
      // classified retryable, so scrubbing the logical id out of the message
      // would not satisfy the assertion above.
      it('CONTROL: the SAME message unmarked is still classified retryable', async () => {
        childCounts.value = { deletedCount: 0, errorCount: 2, interrupted: true };
        const err = (await deleteAndCatch(POISON_ID)) as Error;

        const control = new Error(err.message);
        expect(control.message).toBe(err.message);
        expect(isMarkedNonRetryable(control)).toBe(false);
        expect(isRetryableTransientError(control, control.message)).toBe(true);
      });

      // UNMARKED ARM — a plain child failure with no interrupt. A whole-child
      // re-destroy CAN legitimately succeed (a resource still draining on
      // attempt 1 may be gone on attempt 2), so the arm is left UNMARKED and a
      // later blanket-mark of the class breaks LOUDLY here instead of silently
      // converting a recoverable failure into a terminal one.
      //
      // What "unmarked" means is asserted honestly rather than as "the arm
      // stays retryable": with no marker the classification is MESSAGE-driven,
      // so this arm is retryable exactly when the child stack name happens to
      // carry a retryable pattern. Both halves are pinned, because the pair IS
      // the residual — #1849's name-dependence survives on this arm by design
      // (there is no `markRetryable`, and marking it would make the healable
      // case terminal for everyone).
      it('a NON-interrupted child failure is left unmarked, so it stays name-dependent', async () => {
        childCounts.value = { deletedCount: 0, errorCount: 2, interrupted: false };

        const poisoned = (await deleteAndCatch(POISON_ID)) as Error;
        expect(isMarkedNonRetryable(poisoned)).toBe(false);
        expect(isRetryableTransientError(poisoned, poisoned.message)).toBe(true);

        // The SAME arm, same counts, an ordinary logical id: not retryable.
        // The only difference is the name, which is precisely the residual.
        const ordinary = (await deleteAndCatch('PlainSub')) as Error;
        expect(isMarkedNonRetryable(ordinary)).toBe(false);
        expect(isRetryableTransientError(ordinary, ordinary.message)).toBe(false);
      });

      // The two arms must be distinguished by the MARKER alone, not by the
      // failure count or by anything else that happens to differ — otherwise
      // the pair above could pass for the wrong reason.
      it('the two arms differ ONLY by the marker, not by the message', async () => {
        childCounts.value = { deletedCount: 0, errorCount: 2, interrupted: true };
        const marked = (await deleteAndCatch(POISON_ID)) as Error;
        childCounts.value = { deletedCount: 0, errorCount: 2, interrupted: false };
        const unmarked = (await deleteAndCatch(POISON_ID)) as Error;

        // Same failure count, same child, different interrupt clause only.
        expect(marked.message).toContain('2 resource(s) failed to delete');
        expect(unmarked.message).toContain('2 resource(s) failed to delete');
        expect(isMarkedNonRetryable(marked)).toBe(true);
        expect(isMarkedNonRetryable(unmarked)).toBe(false);
      });

      // MARKED ARM — the context-wiring refusal, the one arm of this provider
      // that can never heal: the store is read from AsyncLocalStorage and a
      // retry runs in the SAME async context as the first attempt.
      it('the outside-withNestedStackContext refusal is NOT retryable', async () => {
        const provider = new NestedStackProvider();
        const err = await provider
          .delete(
            'Child',
            'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
            'AWS::CloudFormation::Stack'
          )
          .then(
            () => undefined,
            (e: unknown) => e as Error
          );

        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toMatch(/invoked outside withNestedStackContext/);
        expect(isMarkedNonRetryable(err)).toBe(true);
        // CONTROL: the wording alone carries no retryable substring today, so
        // an unmarked twin is already classified terminal. That is exactly why
        // the marker is the DECLARATION here rather than a fix for a live
        // mis-classification — and why this control is a `false`, not a `true`.
        expect(isRetryableTransientError(new Error(err!.message), err!.message)).toBe(false);
      });

      // NOT TESTED, deliberately: the destroy runner's raw `Too Many Requests`
      // arm. It is a composite gate (destroy-runner.ts) —
      //
      //   !isMarkedNonRetryable(e) && (isRetryableTransientError(e, m) ||
      //                                m.includes('Too Many Requests'))
      //
      // — and its raw half is UNREACHABLE for this message, so there is no
      // honest row to write. `nestedStackChildFailureMessage` interpolates no
      // AWS error text: only the child stack name and the counts. The phrase
      // contains SPACES, and the name is `<parent>~<childLogicalId>` built
      // from CloudFormation logical ids, which are alphanumeric — so the
      // substring cannot occur. That is exactly why `DependencyViolation` is
      // the pattern this whole block is about: it is the only whitespace-free
      // entry in the table, hence the only one a logical id can carry.
      //
      // A row WAS written here first, asserting the marker against an error it
      // constructed ITSELF, and it passed with the provider's marks fully
      // reverted — it never read the provider's mark at all. Recorded rather
      // than silently dropped so the next reader does not re-add it.
    });

    it('returns void (= deleted) when the child skipped nothing', async () => {
      childCounts.value = { deletedCount: 3, skippedCount: 0, interrupted: false };
      const provider = new NestedStackProvider();
      const ctx = makeContext();

      const result = await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack'
        )
      );

      // Byte-identical to the pre-#1752 behavior for every ordinary child.
      expect(result).toBeUndefined();
    });

    // B3 (issue #556): delete() forwards every per-resource budget / per-type
    // override / profile field from the parent's `destroyOptions` PLUS the
    // `removeProtection` flag from the DeleteContext into the recursive
    // runDestroyForStack invocation. Without these, a `cdkd destroy
    // --remove-protection --resource-timeout=AWS::S3::Bucket=10m` flag run
    // against a nested-stack parent would silently fall back to defaults
    // inside the child engine. Each field is independently load-bearing —
    // the existing "no options" happy-path test above proves the
    // pass-through wiring exists but not that every field reaches the
    // child. This combined case pins all six forwarding paths.
    it('forwards removeProtection + destroyOptions.{resourceWarnAfterMs, resourceTimeoutMs, *ByType, profile} to recursive destroy', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext({
        destroyOptions: {
          resourceWarnAfterMs: 7 * 60_000,
          resourceTimeoutMs: 45 * 60_000,
          resourceWarnAfterByType: { 'AWS::S3::Bucket': 10 * 60_000 },
          resourceTimeoutByType: { 'AWS::Lambda::Function': 30 * 60_000 },
          profile: 'my-test-profile',
        },
      });

      await withNestedStackContext(ctx, () =>
        provider.delete(
          'Child',
          'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack',
          undefined,
          { removeProtection: true }
        )
      );

      expect(destroyCalls.length).toBe(1);
      const fwd = destroyCalls[0]!.destroyCtx;
      expect(fwd['removeProtection']).toBe(true);
      expect(fwd['resourceWarnAfterMs']).toBe(7 * 60_000);
      expect(fwd['resourceTimeoutMs']).toBe(45 * 60_000);
      expect(fwd['resourceWarnAfterByType']).toEqual({ 'AWS::S3::Bucket': 10 * 60_000 });
      expect(fwd['resourceTimeoutByType']).toEqual({ 'AWS::Lambda::Function': 30 * 60_000 });
      expect(fwd['profile']).toBe('my-test-profile');
    });

    // Sibling negative case: when neither DeleteContext.removeProtection nor
    // destroyOptions are present, the optional fields MUST be absent from
    // the forwarded ctx — `...(cond && { key: v })` should NOT leak a
    // `key: false` / `key: 0` to runDestroyForStack. The destroy runner
    // treats "key absent" and "key === false" identically today, but the
    // contract is "absent means default" and a future refactor should not
    // be free to change that without surfacing it as a regression.
    it('does NOT forward removeProtection / destroyOptions fields when neither is set', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext();
      await withNestedStackContext(ctx, () =>
        provider.delete('Child', 'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child', 'AWS::CloudFormation::Stack')
      );

      const fwd = destroyCalls[0]!.destroyCtx;
      expect(fwd).not.toHaveProperty('removeProtection');
      expect(fwd).not.toHaveProperty('resourceWarnAfterMs');
      expect(fwd).not.toHaveProperty('resourceTimeoutMs');
      expect(fwd).not.toHaveProperty('resourceWarnAfterByType');
      expect(fwd).not.toHaveProperty('resourceTimeoutByType');
      expect(fwd).not.toHaveProperty('profile');
    });
  });

  describe('extractParameters (edge cases)', () => {
    // The provider's private helper. Exercised here directly to cover
    // shapes the public `create` happy path doesn't reach.
    function extract(provider: NestedStackProvider, properties: Record<string, unknown>) {
      return (provider as unknown as {
        extractParameters: (p: Record<string, unknown>) => Record<string, string>;
      }).extractParameters(properties);
    }

    it('returns {} when Properties has no Parameters key', () => {
      const provider = new NestedStackProvider();
      expect(extract(provider, {})).toEqual({});
    });

    it('returns {} when Parameters is null', () => {
      const provider = new NestedStackProvider();
      expect(extract(provider, { Parameters: null })).toEqual({});
    });

    it('returns {} when Parameters is an array (defensive — CFn shape is Map<string,string>)', () => {
      const provider = new NestedStackProvider();
      expect(extract(provider, { Parameters: ['unexpected'] })).toEqual({});
    });

    it('coerces number / boolean values to strings (matches CFn boundary coercion)', () => {
      const provider = new NestedStackProvider();
      expect(
        extract(provider, {
          Parameters: { Count: 42, Enabled: true, Disabled: false, Zero: 0 },
        })
      ).toEqual({ Count: '42', Enabled: 'true', Disabled: 'false', Zero: '0' });
    });

    it('throws on a non-scalar value (unresolved intrinsic leak)', () => {
      const provider = new NestedStackProvider();
      expect(() =>
        extract(provider, { Parameters: { Bad: { Ref: 'SomeOtherStack' } } })
      ).toThrow(/non-scalar value.*Parameters must be scalars/);
    });

    it('throws on a null value (distinct from missing key — explicit null is suspicious)', () => {
      const provider = new NestedStackProvider();
      expect(() => extract(provider, { Parameters: { Bad: null } })).toThrow(
        /non-scalar value.*type=null/
      );
    });
  });

  describe('runChildDeploy (Minor 4 fix — parameters overwrite vs spread-inherit)', () => {
    it('child with non-empty Parameters: child overrides parent-options shared key, sibling-only keys not leaked', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-paramleak-'));
      const childTemplatePath = join(dir, 'child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: { Foo: { Type: 'AWS::S3::Bucket' } },
        })
      );

      const provider = new NestedStackProvider();
      // Parent has a CLI --parameters Foo=parentValue set on its own
      // DeployEngineOptions. The child template happens to declare a
      // 'Foo' parameter too — if the parent's options leaked into the
      // child, the child would inherit `Foo=parentValue` even though
      // its `Properties.Parameters` block sets `Foo=childValue`.
      const ctx = makeContext({
        nestedTemplates: { Child: childTemplatePath },
        options: { parameters: { Foo: 'parentValue', SharedToo: 'parent-only' } },
      });

      await withNestedStackContext(ctx, () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {
          Parameters: { Foo: 'childValue' },
        })
      );

      // Child engine MUST see `parameters: { Foo: 'childValue' }` — NOT
      // `{ Foo: 'parentValue', SharedToo: 'parent-only', Foo: 'childValue' }`.
      const opts = deployCalls[0]!.ctor[5] as { parameters?: Record<string, string> };
      expect(opts.parameters).toEqual({ Foo: 'childValue' });
      expect(opts.parameters).not.toHaveProperty('SharedToo');
    });

    it('child with NO Parameters block: parent-options parameters do not leak (the true regression class)', async () => {
      // This is the regression the unconditional `parameters: childParameters`
      // overwrite actually closes. Before the fix, the conditional spread
      // `...(Object.keys(childParameters).length > 0 && { parameters: childParameters })`
      // only fired when `childParameters` was non-empty — so when the child
      // template had no `Properties.Parameters` block at all (= the common
      // case for typical `cdk.NestedStack` usage), the parent's
      // `options.parameters` (= the `--parameters Foo=Bar` CLI flag) survived
      // into the child via the outer spread of `parentCtx.options ?? {}`,
      // and any same-named parameter the child template happened to declare
      // got the parent's value. The fix is to ALWAYS overwrite with
      // `parameters: childParameters` (even when empty) so the parent's
      // CLI scope never leaks into a child whose author did not opt into it.
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-stack-test-paramleak-empty-'));
      const childTemplatePath = join(dir, 'child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: { Foo: { Type: 'AWS::S3::Bucket' } },
        })
      );

      const provider = new NestedStackProvider();
      const ctx = makeContext({
        nestedTemplates: { Child: childTemplatePath },
        // Parent CLI scope has parameters set.
        options: { parameters: { Leaked: 'parent-only' } },
      });

      // Child resource has NO `Parameters` key — childParameters resolves to {}.
      await withNestedStackContext(ctx, () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      );

      // Child engine MUST see `parameters: {}` (empty), NOT
      // `parameters: { Leaked: 'parent-only' }`.
      const opts = deployCalls[0]!.ctor[5] as { parameters?: Record<string, string> };
      expect(opts.parameters).toEqual({});
      expect(opts.parameters).not.toHaveProperty('Leaked');
    });
  });

  describe('property coverage hints', () => {
    it('declares disableOuterRetry + disableCcApiFallback to prevent the deploy engine from re-entering or fallback-routing through CC API', () => {
      const provider = new NestedStackProvider();
      expect(provider.disableOuterRetry).toBe(true);
      expect(provider.disableCcApiFallback).toBe(true);
    });

    it('only TemplateURL + Parameters wire through; everything else is unhandled-by-design with a rationale', () => {
      const provider = new NestedStackProvider();
      const handled = provider.handledProperties!.get('AWS::CloudFormation::Stack');
      expect(handled).toEqual(new Set(['TemplateURL', 'Parameters']));

      const unhandled = provider.unhandledByDesign!.get('AWS::CloudFormation::Stack');
      // Every property in unhandled set must have a non-empty rationale string.
      expect(unhandled).toBeDefined();
      for (const [name, rationale] of unhandled!) {
        expect(name).toMatch(/^[A-Z]/);
        expect(rationale.length).toBeGreaterThan(20);
      }
    });
  });
});
