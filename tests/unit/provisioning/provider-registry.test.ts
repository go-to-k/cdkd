import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
// STATIC, not `await import(...)` inside the test (issue #1450).
//
// `register-providers.js` pulls in all 80 provider modules and their AWS SDK
// clients. Imported lazily inside a test, that whole graph is resolved against
// the 5s PER-TEST timeout: ~260ms warm and single-file, but under a loaded
// 12-worker full-suite run it could exceed the budget and fail as a timeout —
// which reads like a real assertion failure, passes on re-run once the FS
// cache is warm, and passes in isolation. A static import resolves at
// file-evaluation time instead, outside any test's budget.
//
// Nothing here required the laziness: this file has no `vi.mock`, so there was
// no mock-ordering reason to defer the import.
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { WaitConditionHandleProvider } from '../../../src/provisioning/providers/wait-condition-handle-provider.js';

describe('ProviderRegistry pre-flight (validateResourceTypes)', () => {
  it('passes for SDK + Cloud-Control-supported types', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.validateResourceTypes(new Set(['AWS::S3::Bucket', 'AWS::SNS::Topic']))
    ).not.toThrow();
  });

  it('passes for AWS::CloudFormation::WaitConditionHandle via its no-op SDK provider (issue #1020)', () => {
    const registry = new ProviderRegistry();
    registerAllProviders(registry);
    expect(() =>
      registry.validateResourceTypes(new Set(['AWS::CloudFormation::WaitConditionHandle']))
    ).not.toThrow();
    expect(registry.getProvider('AWS::CloudFormation::WaitConditionHandle')).toBeInstanceOf(
      WaitConditionHandleProvider
    );
  });

  it('rejects a tier3 type with the NON_PROVISIONABLE reason + issue link + escape-hatch hint', () => {
    const registry = new ProviderRegistry();
    let message = '';
    try {
      registry.validateResourceTypes(new Set(['AWS::AppMesh::Mesh', 'AWS::S3::Bucket']));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('AWS::AppMesh::Mesh');
    expect(message).toContain('NON_PROVISIONABLE');
    expect(message).toContain('https://github.com/go-to-k/cdkd/issues/new');
    expect(message).toContain('--allow-unsupported-types AWS::AppMesh::Mesh');
    // Supported sibling is not named in the error.
    expect(message).not.toContain('AWS::S3::Bucket');
  });

  it('joins multiple unsupported types into the single escape-hatch re-run hint', () => {
    const registry = new ProviderRegistry();
    let message = '';
    try {
      // AWS::AppMesh::Route replaced AWS::Budgets::Budget as the second
      // sample here when the Budgets SDK provider shipped (issue #1041).
      registry.validateResourceTypes(
        new Set(['AWS::AppMesh::Mesh', 'AWS::AppMesh::Route', 'AWS::S3::Bucket'])
      );
    } catch (e) {
      message = (e as Error).message;
    }
    // Both unsupported types named individually with their per-type reason + link.
    expect(message).toContain('AWS::AppMesh::Mesh');
    expect(message).toContain('AWS::AppMesh::Route');
    // The re-run hint comma-joins them (load-bearing for copy-paste UX).
    expect(message).toMatch(/--allow-unsupported-types AWS::AppMesh::Mesh,AWS::AppMesh::Route/);
  });
});

describe('ProviderRegistry --allow-unsupported-types escape hatch', () => {
  it('treats an allowed type as available and routes it through Cloud Control', () => {
    const registry = new ProviderRegistry();
    expect(registry.hasProvider('AWS::AppMesh::Mesh')).toBe(false);

    registry.allowUnsupportedTypes(['AWS::AppMesh::Mesh']);

    expect(registry.hasProvider('AWS::AppMesh::Mesh')).toBe(true);
    expect(() => registry.validateResourceTypes(new Set(['AWS::AppMesh::Mesh']))).not.toThrow();
    // getProvider returns a provider (Cloud Control) instead of throwing.
    expect(registry.getProvider('AWS::AppMesh::Mesh')).toBe(
      registry.getCloudControlProvider()
    );
  });

  it('only allows the named types, not all unsupported types', () => {
    const registry = new ProviderRegistry();
    registry.allowUnsupportedTypes(['AWS::AppMesh::Mesh']);
    expect(registry.hasProvider('AWS::AppMesh::Mesh')).toBe(true);
    expect(registry.hasProvider('AWS::AppMesh::Route')).toBe(false);
    expect(() => registry.getProvider('AWS::AppMesh::Route')).toThrow();
  });
});
