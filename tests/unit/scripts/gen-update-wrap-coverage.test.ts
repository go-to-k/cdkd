import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  UPDATE_WRAP_ALLOW_LIST,
  buildReport,
  classifySource,
  findGaps,
} from '../../../scripts/gen-update-wrap-coverage.ts';

const PROVIDERS_DIR = resolve(process.cwd(), 'src/provisioning/providers');

/** Minimal provider-shaped source so the classifier has something to parse. */
function providerSource(body: string, className = 'FakeProvider'): string {
  return `class ${className} {\n${body}\n}`;
}

describe('gen-update-wrap-coverage classifier', () => {
  it('flags an update() whose send escapes unwrapped', () => {
    const src = providerSource(`
      async update(logicalId, physicalId, resourceType, props, prev) {
        await this.client.send(new UpdateThingCommand({}));
        return { physicalId, wasReplaced: false, attributes: {} };
      }
    `);
    const [c] = classifySource(src, 'fake-provider.ts', new Map());
    expect(c?.bucket).toBe('gap');
    expect(c?.unwrappedSendMethods).toEqual(['update']);
  });

  it('accepts an update() that wraps its send in ProvisioningError', () => {
    const src = providerSource(`
      async update(logicalId, physicalId, resourceType, props, prev) {
        try {
          await this.client.send(new UpdateThingCommand({}));
          return { physicalId, wasReplaced: false, attributes: {} };
        } catch (error) {
          throw new ProvisioningError('Failed to update', resourceType, logicalId);
        }
      }
    `);
    const [c] = classifySource(src, 'fake-provider.ts', new Map());
    expect(c?.bucket).toBe('wrapped');
  });

  // The shape PR #1268 settled on, and the one a naive grep gets wrong: the
  // wrap is at the boundary and the sends live in a private helper.
  it('follows the boundary-wrapper -> applyUpdate delegation edge', () => {
    const src = providerSource(`
      async update(logicalId, physicalId, resourceType, props, prev) {
        try {
          return await this.applyUpdate(logicalId, physicalId, props, prev);
        } catch (error) {
          if (error instanceof CdkdError) throw error;
          throw new ProvisioningError('Failed to update', resourceType, logicalId);
        }
      }
      async applyUpdate(logicalId, physicalId, props, prev) {
        await this.client.send(new UpdateThingCommand({}));
        await this.client.send(new TagResourceCommand({}));
        return { physicalId, wasReplaced: false, attributes: {} };
      }
    `);
    const [c] = classifySource(src, 'fake-provider.ts', new Map());
    expect(c?.bucket).toBe('wrapped');
    expect(c?.unwrappedSendMethods).toEqual([]);
  });

  // The inverse delegation shape (s3-tables): update() is bare, but each
  // helper wraps internally. Also must NOT be a gap.
  it('accepts wrapping that lives inside the delegated helper', () => {
    const src = providerSource(`
      async update(logicalId, physicalId, resourceType, props, prev) {
        await this.applyTagsDiff(logicalId, physicalId, resourceType);
        return { physicalId, wasReplaced: false };
      }
      async applyTagsDiff(logicalId, physicalId, resourceType) {
        try {
          await this.client.send(new TagResourceCommand({}));
        } catch (error) {
          throw new ProvisioningError('Failed to tag', resourceType, logicalId);
        }
      }
    `);
    const [c] = classifySource(src, 'fake-provider.ts', new Map());
    expect(c?.bucket).toBe('wrapped');
  });

  // The real s3-tables defect: a lookup helper whose own catch re-throws the
  // RAW error, called from OUTSIDE any wrap.
  it('flags a lookup helper whose catch re-throws raw, called outside a wrap', () => {
    const src = providerSource(`
      async update(logicalId, physicalId, resourceType, props, prev) {
        const arn = await this.lookupArn(physicalId);
        return { physicalId, wasReplaced: false };
      }
      async lookupArn(physicalId) {
        try {
          const resp = await this.client.send(new GetThingCommand({}));
          return resp.arn;
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          throw err;
        }
      }
    `);
    const [c] = classifySource(src, 'fake-provider.ts', new Map());
    expect(c?.bucket).toBe('gap');
    expect(c?.unwrappedSendMethods).toEqual(['lookupArn']);
  });

  it('classifies an update() with no AWS call as no-aws', () => {
    const src = providerSource(`
      async update(logicalId, physicalId) {
        return { physicalId, wasReplaced: false, attributes: {} };
      }
    `);
    const [c] = classifySource(src, 'fake-provider.ts', new Map());
    expect(c?.bucket).toBe('no-aws');
  });

  it('ignores a class with no update() method', () => {
    const src = providerSource(`
      async create(logicalId) { await this.client.send(new CreateCommand({})); }
    `);
    expect(classifySource(src, 'fake-provider.ts', new Map())).toEqual([]);
  });

  describe('typed-error pass-through invariant', () => {
    it('flags a wrap that can swallow a typed control-flow throw', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError(resourceType, logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
      expect(c?.unguardedWrapMethods).toEqual(['update']);
    });

    it('accepts the same wrap once a typed pass-through is present', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError(resourceType, logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            if (error instanceof CdkdError) throw error;
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    // REGRESSION: the first version of this analyzer scanned only the LEXICAL
    // try block for a typed throw. In the boundary-wrapper shape the try body
    // is a single `return await this.applyUpdate(...)` and the typed throw
    // lives in the delegated method — so the lexical-only check reported
    // "cannot capture a typed throw" and stopped enforcing the pass-through on
    // exactly the shape that needs it. Live-testing the critic against the real
    // LogsLogGroupProvider (pass-through removed) is what surfaced it.
    it('flags an unguarded wrap when the typed throw is in a DELEGATED method', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            return await this.applyUpdate(logicalId, physicalId, props, prev);
          } catch (error) {
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
        async applyUpdate(logicalId, physicalId, props, prev) {
          if (props.Class !== prev.Class) {
            throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
          }
          await this.client.send(new UpdateThingCommand({}));
          return { physicalId, wasReplaced: false };
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
      expect(c?.unguardedWrapMethods).toEqual(['update']);
    });

    it('accepts the delegated-typed-throw shape once the pass-through is present', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            return await this.applyUpdate(logicalId, physicalId, props, prev);
          } catch (error) {
            if (error instanceof CdkdError) throw error;
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
        async applyUpdate(logicalId, physicalId, props, prev) {
          if (props.Class !== prev.Class) {
            throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
          }
          await this.client.send(new UpdateThingCommand({}));
          return { physicalId, wasReplaced: false };
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    it('does not flag a wrap that cannot capture a typed throw', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
      expect(c?.unguardedWrapMethods).toEqual([]);
    });
  });

  describe('allow-list', () => {
    const gapSrc = providerSource(
      `
      async update(logicalId, physicalId) {
        await this.client.send(new UpdateThingCommand({}));
        return { physicalId, wasReplaced: false };
      }
    `,
      'AllowedProvider'
    );

    it('keeps an allow-listed gap VISIBLE rather than relabelling it wrapped', () => {
      const [c] = classifySource(
        gapSrc,
        'allowed-provider.ts',
        new Map([['AllowedProvider', { rationale: 'KNOWN GAP tracked in #1270' }]])
      );
      expect(c?.bucket).toBe('allow-listed');
      // The offending method is still recorded, so the matrix documents it.
      expect(c?.unwrappedSendMethods).toEqual(['update']);
      expect(c?.rationale).toContain('#1270');
    });

    it('excludes allow-listed entries from the CI-blocking gap set', () => {
      const classes = classifySource(
        gapSrc,
        'allowed-provider.ts',
        new Map([['AllowedProvider', { rationale: 'KNOWN GAP tracked in #1270' }]])
      );
      expect(findGaps(buildReport(classes))).toEqual([]);
    });

    it('classifies a clean allow-listed class normally, so a stale entry is visible', () => {
      const cleanSrc = providerSource(
        `
        async update(logicalId, physicalId, resourceType) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `,
        'AllowedProvider'
      );
      const [c] = classifySource(
        cleanSrc,
        'allowed-provider.ts',
        new Map([['AllowedProvider', { rationale: 'stale' }]])
      );
      expect(c?.bucket).toBe('wrapped');
    });
  });
});

// Per .claude/rules/testing.md "A checker must prove it sees its input":
// "0 violations" and "parsed nothing at all" are indistinguishable without
// explicit coverage floors. These assert the parser actually reads the real
// provider tree, with a floor per SHAPE it claims to handle — an aggregate
// floor alone would let one dead shape hide underneath it.
describe('real-repo coverage floors', () => {
  const classes = readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .flatMap((f) => classifySource(readFileSync(resolve(PROVIDERS_DIR, f), 'utf8'), f));

  it('parses a realistic number of provider classes with update()', () => {
    // 82 at the time of writing; the floor guards against a parser regression
    // that silently stops seeing the tree.
    expect(classes.length).toBeGreaterThanOrEqual(70);
  });

  it('sees every bucket shape it claims to handle', () => {
    const count = (b: string): number => classes.filter((c) => c.bucket === b).length;
    // wrapped: the overwhelming majority.
    expect(count('wrapped')).toBeGreaterThanOrEqual(50);
    // no-aws: providers whose update() is a genuine no-op.
    expect(count('no-aws')).toBeGreaterThanOrEqual(1);
    // allow-listed: the seeded KNOWN GAPS. If this hits 0, either every gap
    // was fixed (remove the entries + this floor) or the analysis broke.
    expect(count('allow-listed')).toBeGreaterThanOrEqual(1);
  });

  it('classifies the providers fixed by #1263 / #1267 as wrapped', () => {
    // The strongest regression fence available: these five were the actual
    // bugs, and their fixes use the delegation + boundary-wrapper shape that
    // a non-interprocedural checker would misreport.
    for (const name of [
      'LambdaUrlProvider',
      'EventBridgeBusProvider',
      'SNSTopicProvider',
      'LambdaEventSourceMappingProvider',
      'LogsLogGroupProvider',
    ]) {
      const found = classes.find((c) => c.className === name);
      expect(found, `${name} should be classified`).toBeDefined();
      expect(found?.bucket, `${name} should be wrapped`).toBe('wrapped');
    }
  });

  it('keeps the shipped allow-list free of stale entries', () => {
    // Every allow-listed name must still resolve to a real, still-offending
    // class — otherwise the entry is dead weight hiding nothing.
    for (const name of UPDATE_WRAP_ALLOW_LIST.keys()) {
      const found = classes.find((c) => c.className === name);
      expect(found, `allow-listed ${name} no longer exists`).toBeDefined();
      expect(found?.bucket, `allow-list entry for ${name} is stale — remove it`).toBe(
        'allow-listed'
      );
    }
  });

  it('reports no unallow-listed gap in the real tree', () => {
    expect(findGaps(buildReport(classes)).map((c) => c.className)).toEqual([]);
  });
});
