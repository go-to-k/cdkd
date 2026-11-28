import { describe, it, expect } from 'vite-plus/test';
import { buildDeletionDependencies } from '../../../src/deployment/deploy-engine/dependencies.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#7208: a deploy removing a custom resource and a policy on its
 * handler's role deletes the custom resource first, even when the handler
 * and its role stay in the template (so only the stack's other records carry
 * the chain between the two).
 */
describe('buildDeletionDependencies: custom resource before its handler policy (#7208)', () => {
  it('orders the removed custom resource before the removed policy through kept records', () => {
    const state = {
      resources: {
        Role: { physicalId: 'role', resourceType: 'AWS::IAM::Role', properties: {} },
        Handler: {
          physicalId: 'fn',
          resourceType: 'AWS::Lambda::Function',
          properties: {},
          dependencies: ['Role'],
        },
        Grants: {
          physicalId: 'p',
          resourceType: 'AWS::IAM::Policy',
          properties: {},
          dependencies: ['Role'],
        },
        Cr: {
          physicalId: 'cr',
          resourceType: 'Custom::Thing',
          properties: {},
          dependencies: ['Handler'],
        },
      },
    } as unknown as StackState;
    const deps = buildDeletionDependencies(new Set(['Cr', 'Grants']), state, { debug: () => {} });
    // Grants is deleted after Cr.
    expect([...deps.get('Grants')!]).toEqual(['Cr']);
    expect([...deps.get('Cr')!]).toEqual([]);
  });
});
