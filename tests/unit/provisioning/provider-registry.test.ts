import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

describe('ProviderRegistry pre-flight (validateResourceTypes)', () => {
  it('passes for SDK + Cloud-Control-supported types', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.validateResourceTypes(new Set(['AWS::S3::Bucket', 'AWS::SNS::Topic']))
    ).not.toThrow();
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
      registry.validateResourceTypes(
        new Set(['AWS::AppMesh::Mesh', 'AWS::Budgets::Budget', 'AWS::S3::Bucket'])
      );
    } catch (e) {
      message = (e as Error).message;
    }
    // Both unsupported types named individually with their per-type reason + link.
    expect(message).toContain('AWS::AppMesh::Mesh');
    expect(message).toContain('AWS::Budgets::Budget');
    // The re-run hint comma-joins them (load-bearing for copy-paste UX).
    expect(message).toMatch(
      /--allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget/
    );
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
