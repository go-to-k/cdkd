import { describe, it, expect } from 'vite-plus/test';
import { CC_API_FALLBACK_DENY_LIST } from '../../../src/analyzer/drift-cc-api-deny-list.js';

describe('CC_API_FALLBACK_DENY_LIST', () => {
  it('every entry is a non-empty reason string', () => {
    for (const [type, reason] of Object.entries(CC_API_FALLBACK_DENY_LIST)) {
      expect(reason, `deny-list entry for ${type} must be a non-empty reason string`).toBeTypeOf(
        'string'
      );
      expect(reason.length, `deny-list entry for ${type} reason cannot be empty`).toBeGreaterThan(
        0
      );
    }
  });

  it('every entry uses a CFn-style AWS::Service::Type key', () => {
    // Cheap sanity check: only `AWS::*::*` style keys make sense here.
    // Custom resources (`Custom::*`) and pseudo types (`AWS::CDK::*`)
    // are out of scope — the registry skips them before drift would
    // ever consider a fallback.
    const cfnTypePattern = /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/;
    for (const type of Object.keys(CC_API_FALLBACK_DENY_LIST)) {
      expect(type, `deny-list key must be CFn-style: ${type}`).toMatch(cfnTypePattern);
    }
  });

  it('list is curated, not bulk-imported (size cap is a soft signal)', () => {
    // Deliberately keep the list small. If this ever exceeds the cap,
    // it's a signal someone is using the deny-list as a workaround
    // instead of writing a first-class SDK provider. Bump the cap if
    // the additions are genuinely verified divergent shapes — this
    // assertion is a forcing function, not a hard limit.
    expect(Object.keys(CC_API_FALLBACK_DENY_LIST).length).toBeLessThanOrEqual(20);
  });
});
