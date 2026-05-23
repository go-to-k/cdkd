import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { StackState } from '../../../src/types/state.js';

// Mock DeployEngine so create / update don't require a real S3 backend.
// The mock records every constructor call so the test can verify it
// received the right child stackName / region / parameters / parentStackInfo.
const deployCalls: Array<{
  ctor: unknown[];
  deploy: { stackName: string; templateResourceCount: number };
}> = [];
vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation((...ctor: unknown[]) => ({
    deploy: vi.fn(async (stackName: string, template: { Resources?: Record<string, unknown> }) => {
      deployCalls.push({
        ctor,
        deploy: { stackName, templateResourceCount: Object.keys(template.Resources ?? {}).length },
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
// pipeline. Records every invocation so the test can assert the child
// stack name + skipConfirmation flag.
const destroyCalls: Array<{ stackName: string; skipConfirmation: boolean }> = [];
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: vi.fn(async (stackName: string, _state: StackState, ctx: { skipConfirmation: boolean }) => {
    destroyCalls.push({ stackName, skipConfirmation: ctx.skipConfirmation });
    return {
      stackName,
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
      retainedCount: 0,
      errorCount: 0,
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
    it('requires deploy-mode context fields (nestedTemplates / dagBuilder / diffCalculator)', async () => {
      const provider = new NestedStackProvider();
      const ctx = makeContext({ nestedTemplates: undefined });
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
      expect(destroyCalls[0]).toEqual({ stackName: 'Parent~Child', skipConfirmation: true });
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
