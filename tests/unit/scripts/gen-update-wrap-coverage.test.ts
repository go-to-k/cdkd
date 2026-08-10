import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  UPDATE_WRAP_ALLOW_LIST,
  allowKey,
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

  // Regression for PR #1271 review blocker 1: only the literal
  // `throw new ProvisioningError` was matched, so the factory idiom used by
  // appsync / rds-dbproxy* / lambda-microvm-image reported five FULLY WRAPPED
  // providers as gaps — and put five non-bugs on a tracking issue.
  describe('factory-idiom wraps', () => {
    it('accepts `throw this.wrapError(...)` when the method returns ProvisioningError', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw this.wrapError(error, 'UPDATE', resourceType, logicalId, physicalId);
          }
        }
        wrapError(error, op, resourceType, logicalId, physicalId): ProvisioningError {
          return new ProvisioningError('x', resourceType, logicalId, physicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    it('accepts a never-returning `throw this.handleError(...)` that throws one', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw this.handleError(error, resourceType, logicalId);
          }
        }
        handleError(error, resourceType, logicalId): never {
          throw new ProvisioningError('x', resourceType, logicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    // Regression for the re-review BLOCKER: `CloudControlProvider` handles its
    // catch with a bare `this.handleError(error, ...)` statement — no `throw`
    // keyword. The clause therefore looked like a SWALLOW, which silently
    // disabled the typed-pass-through check for the widest-coverage provider
    // in the repo.
    it('accepts the STATEMENT-form `this.handleError(...)` on a never-returning factory', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            this.handleError(error, 'UPDATE', resourceType, logicalId, physicalId);
          }
        }
        handleError(error, op, resourceType, logicalId, physicalId): never {
          throw new ProvisioningError('x', resourceType, logicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    it('applies the typed-pass-through check to a STATEMENT-form wrap too', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            this.handleError(error, 'UPDATE', resourceType, logicalId, physicalId);
          }
        }
        handleError(error, op, resourceType, logicalId, physicalId): never {
          throw new ProvisioningError('x', resourceType, logicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
    });

    it('does NOT treat a bare `never` return as a ProvisioningError factory', () => {
      const src = providerSource(`
        async update(logicalId, physicalId) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw this.fail('nope');
          }
        }
        fail(m): never { throw new Error(m); }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('gap');
    });

    it('does NOT count a ProvisioningError buried in an unused nested closure', () => {
      const src = providerSource(`
        async update(logicalId, physicalId) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw this.wrapError(error);
          }
        }
        wrapError(error) {
          const unused = function () { return new ProvisioningError('x', 'T', 'L'); };
          return new Error('nope');
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('gap');
    });

    it('does NOT accept a factory that returns a plain Error', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType) {
          try {
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw this.wrapError(error);
          }
        }
        wrapError(error) {
          return new Error('nope');
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('gap');
    });
  });

  // Regression for PR #1271 review item 5: a catch that logs and continues
  // cannot propagate a raw SDK error, so "wrap the call" is the wrong remedy.
  describe('swallowing catches', () => {
    it('treats a log-and-continue catch as handled, not a gap', () => {
      const src = providerSource(`
        async update(logicalId, physicalId) {
          try {
            await this.client.send(new TagResourceCommand({}));
          } catch (error) {
            this.logger.warn('best-effort tagging failed');
          }
          return { physicalId, wasReplaced: false };
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    // Regression for the re-review MAJOR: `return Promise.reject(err)` raises
    // just like `throw`, but the swallow check only looked for ThrowStatement.
    it('does NOT treat `return Promise.reject(error)` as a swallow', () => {
      const src = providerSource(`
        async update(logicalId, physicalId) {
          try {
            await this.client.send(new UpdateThingCommand({}));
          } catch (error) {
            return Promise.reject(error);
          }
          return { physicalId, wasReplaced: false };
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('gap');
    });

    it('still flags a CONDITIONAL re-throw (the s3-tables shape)', () => {
      const src = providerSource(`
        async update(logicalId, physicalId) {
          try {
            await this.client.send(new GetThingCommand({}));
          } catch (error) {
            if (!(error instanceof NotFoundException)) throw error;
          }
          return { physicalId, wasReplaced: false };
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('gap');
    });
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

    // Regression for PR #1271 review blocker 3: the matcher accepted ANY throw
    // inside an `instanceof` test, so re-labelling the typed error as a
    // ProvisioningError — the exact #1268 defect — passed as a "pass-through".
    it('rejects an instanceof test that throws something OTHER than the caught binding', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            if (error instanceof ResourceUpdateNotSupportedError) {
              throw new ProvisioningError('re-labelled!', resourceType, logicalId);
            }
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
    });

    it('rejects the NEGATED guard, which wraps the typed error instead', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            if (!(error instanceof CdkdError)) throw error;
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
    });

    // Regression for the re-review MAJOR: the repo raises the typed
    // control-flow error as `return Promise.reject(new
    // ResourceUpdateNotSupportedError(...))` at 9 sites (ec2 / ecs /
    // apigateway / lambda-layer). Keying detection on `throw` alone made the
    // invariant silently inert for every one of them.
    // The fixture AWAITS the rejection on purpose. A bare
    // `return Promise.reject(...)` lexically inside a try is NOT caught by that
    // try — the return resolves after the try has exited. The detector
    // over-approximates and would flag the bare form too, which is harmless (it
    // only asks for an extra pass-through), but a fixture must not enshrine
    // semantics JavaScript does not have.
    it('sees a typed control-flow error raised via Promise.reject', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              await Promise.reject(
                new ResourceUpdateNotSupportedError('T', logicalId, 'immutable')
              );
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
    });

    // Regression for #1272: the pass-through can live in a DELEGATED
    // throw-helper rather than lexically in the catch. CloudControlProvider is
    // exactly this shape — `this.handleError(error, ...)` whose body carries
    // `if (error instanceof ProvisioningError) throw error;`. Checking only the
    // clause reported it as swallowing its own typed errors.
    it('accepts a pass-through that lives inside the delegated throw-helper', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            this.handleError(error, resourceType, logicalId);
          }
        }
        handleError(error, resourceType, logicalId): never {
          if (error instanceof ResourceUpdateNotSupportedError) throw error;
          throw new ProvisioningError('x', resourceType, logicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    // The lambda-microvm-image shape: a THROW-form factory whose guard RETURNS
    // the typed error, which the caller then throws. Semantically identical to
    // a re-throw, so it must not be flagged.
    it('accepts a return-form guard inside a THROW-form factory', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw this.wrapError(error, resourceType, logicalId);
          }
        }
        wrapError(error, resourceType, logicalId): ProvisioningError {
          if (error instanceof ResourceUpdateNotSupportedError) return error;
          return new ProvisioningError('x', resourceType, logicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    // ...but a RETURN inside a STATEMENT-form helper swallows rather than
    // re-raises, so the same guard shape must NOT be accepted there.
    it('rejects a return-form guard inside a STATEMENT-form helper', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            this.handleError(error, resourceType, logicalId);
          }
        }
        handleError(error, resourceType, logicalId): never {
          if (error instanceof ResourceUpdateNotSupportedError) return error;
          throw new ProvisioningError('x', resourceType, logicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
    });

    // Regression for PR #1273 review nit 3: ProvisioningError and
    // ResourceUpdateNotSupportedError are SIBLINGS (both extend CdkdError,
    // neither extends the other), so an `instanceof ProvisioningError` guard
    // does NOT re-throw a control-flow error. A flat "any typed guard counts"
    // set accepted exactly that mismatch.
    it('rejects a sibling-class guard that cannot cover the raised control-flow error', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            if (error instanceof ProvisioningError) throw error;
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
    });

    it('accepts the exact-class guard for the raised control-flow error', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            if (error instanceof ResourceUpdateNotSupportedError) throw error;
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('wrapped');
    });

    // Regression for PR #1273 review item 1: the delegation check credited ANY
    // this.x() in the catch whose body held a typed guard. A cleanup helper is
    // the realistic shape now that `instanceof CdkdError` guards are spreading
    // into helpers.
    it('does not credit an unrelated cleanup helper with a pass-through', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            this.cleanup(physicalId);
            throw new ProvisioningError('Failed to update', resourceType, logicalId);
          }
        }
        cleanup(physicalId) {
          try {
            this.other();
          } catch (inner) {
            if (inner instanceof CdkdError) throw inner;
          }
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
    });

    it('does not credit a factory called with a DIFFERENT error value', () => {
      const src = providerSource(`
        async update(logicalId, physicalId, resourceType, props, prev) {
          try {
            if (props.Class !== prev.Class) {
              throw new ResourceUpdateNotSupportedError('T', logicalId, 'immutable');
            }
            await this.client.send(new UpdateThingCommand({}));
            return { physicalId, wasReplaced: false };
          } catch (error) {
            throw this.wrapError(this.lastError, resourceType, logicalId);
          }
        }
        wrapError(error, resourceType, logicalId): ProvisioningError {
          if (error instanceof CdkdError) throw error;
          return new ProvisioningError('x', resourceType, logicalId);
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unguarded-wrap');
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

  // Regression for PR #1271 review blocker 2: an unresolvable callee hides
  // every send behind it, and the class then reported a confident `no-aws` —
  // green, un-allow-listed, and invisible to review.
  describe('unresolved callees', () => {
    it('surfaces an unresolvable this.x() instead of reporting no-aws', () => {
      const src = providerSource(`
        async update(logicalId, physicalId) {
          await this.inheritedHelper(physicalId);
          return { physicalId, wasReplaced: false };
        }
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      expect(c?.bucket).toBe('unresolved-callee');
      expect(c?.unresolvedCallees).toEqual(['inheritedHelper']);
    });

    it('resolves an arrow-function class PROPERTY as a member', () => {
      const src = providerSource(`
        async update(logicalId, physicalId) {
          await this.applyDiff(physicalId);
          return { physicalId, wasReplaced: false };
        }
        applyDiff = async (physicalId) => {
          await this.client.send(new UpdateThingCommand({}));
        };
      `);
      const [c] = classifySource(src, 'fake-provider.ts', new Map());
      // Resolved (not `unresolved-callee`) AND the send behind it is seen.
      expect(c?.bucket).toBe('gap');
      expect(c?.unwrappedSendMethods).toEqual(['applyDiff']);
    });
  });

  describe('allow-list (keyed by Class#method)', () => {
    const gapSrc = providerSource(
      `
      async update(logicalId, physicalId) {
        await this.client.send(new UpdateThingCommand({}));
        return { physicalId, wasReplaced: false };
      }
    `,
      'AllowedProvider'
    );
    const allow = new Map([
      [allowKey('AllowedProvider', 'update'), { rationale: 'KNOWN GAP tracked in #1270' }],
    ]);

    it('keeps an allow-listed gap VISIBLE rather than relabelling it wrapped', () => {
      const [c] = classifySource(gapSrc, 'allowed-provider.ts', allow);
      expect(c?.bucket).toBe('allow-listed');
      // The offending method is still recorded, so the matrix documents it.
      expect(c?.unwrappedSendMethods).toEqual(['update']);
      expect(c?.rationale).toContain('#1270');
    });

    it('excludes allow-listed entries from the CI-blocking gap set', () => {
      expect(findGaps(buildReport(classifySource(gapSrc, 'allowed-provider.ts', allow)))).toEqual(
        []
      );
    });

    // Regression for PR #1271 review item 7: a class-keyed allow-list meant a
    // NEW gap anywhere in an allow-listed class was silently absorbed.
    it('still BLOCKS on a new gap in a different method of an allow-listed class', () => {
      const twoGaps = providerSource(
        `
        async update(logicalId, physicalId) {
          await this.client.send(new UpdateThingCommand({}));
          await this.newHelper(physicalId);
          return { physicalId, wasReplaced: false };
        }
        async newHelper(physicalId) {
          await this.client.send(new BrandNewCommand({}));
        }
      `,
        'AllowedProvider'
      );
      const [c] = classifySource(twoGaps, 'allowed-provider.ts', allow);
      expect(c?.bucket).toBe('gap');
      expect(c?.unwrappedSendMethods).toEqual(['newHelper', 'update']);
      expect(findGaps(buildReport([c!]))).toHaveLength(1);
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
      const [c] = classifySource(cleanSrc, 'allowed-provider.ts', allow);
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
  const classes = [
    ...readdirSync(PROVIDERS_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .flatMap((f) => classifySource(readFileSync(resolve(PROVIDERS_DIR, f), 'utf8'), f)),
    ...classifySource(
      readFileSync(resolve(process.cwd(), 'src/provisioning/cloud-control-provider.ts'), 'utf8'),
      'src/provisioning/cloud-control-provider.ts'
    ),
  ];

  it('parses a realistic number of provider classes with update()', () => {
    // 83 at the time of writing; the floor guards against a parser regression
    // that silently stops seeing the tree.
    expect(classes.length).toBeGreaterThanOrEqual(70);
  });

  it('sees every bucket shape it claims to handle', () => {
    const count = (b: string): number => classes.filter((c) => c.bucket === b).length;
    // wrapped: the overwhelming majority.
    expect(count('wrapped')).toBeGreaterThanOrEqual(70);
    // no-aws: providers whose update() is a genuine no-op.
    expect(count('no-aws')).toBeGreaterThanOrEqual(1);
    // unresolved-callee: expected to be ZERO today. It is asserted (not
    // floored) because a NON-zero value means the walk lost visibility
    // somewhere and the whole matrix's verdicts are less trustworthy.
    expect(count('unresolved-callee')).toBe(0);
    // Belt-and-braces: check the RAW field across every class, not just the
    // bucket. A class that is `gap` / `allow-listed` AND has a lost edge would
    // not show up in the bucket count above.
    expect(classes.filter((c) => c.unresolvedCallees.length > 0)).toEqual([]);
    // allow-listed: ZERO since #1270 fixed every seeded gap and its entries
    // were removed. Asserted (not floored) so a future entry is a deliberate,
    // reviewed decision rather than something that quietly accumulates.
    expect(count('allow-listed')).toBe(0);
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
    // Every `Class#method` entry must still resolve to a real class whose
    // offending-method list still contains that method — otherwise the entry
    // is dead weight hiding nothing, and the gap it documented is either fixed
    // (remove it) or moved (re-key it).
    for (const key of UPDATE_WRAP_ALLOW_LIST.keys()) {
      const [className, method] = key.split('#');
      const found = classes.find((c) => c.className === className);
      expect(found, `allow-listed class ${className} no longer exists`).toBeDefined();
      expect(found?.bucket, `${className} should still be allow-listed`).toBe('allow-listed');
      const offenders = [
        ...(found?.unwrappedSendMethods ?? []),
        ...(found?.unguardedWrapMethods ?? []),
      ];
      expect(offenders, `allow-list entry ${key} is stale — remove it`).toContain(method);
    }
  });

  // Pinned by EXACT NAME, not a floor. A floor of `>= 1` would let a class
  // silently DROP into no-aws (the shape a lost delegation edge produces) while
  // the aggregate `wrapped` floor absorbed the loss — precisely the
  // false-negative PR #1271's review called out.
  it('pins the exact set of no-aws providers', () => {
    const noAws = classes
      .filter((c) => c.bucket === 'no-aws')
      .map((c) => c.className)
      .sort();
    expect(noAws).toEqual([
      'AgentCoreBrowserProvider',
      'AgentCoreCodeInterpreterProvider',
      'GlueSecurityConfigurationProvider',
      'LambdaLayerVersionProvider',
      'NestedStackProvider',
      'WaitConditionHandleProvider',
    ]);
  });

  it('audits CloudControlProvider, the widest-coverage provider in the repo', () => {
    const cc = classes.find((c) => c.className === 'CloudControlProvider');
    expect(cc, 'CloudControlProvider must be scanned').toBeDefined();
    expect(cc?.bucket).toBe('wrapped');
  });

  it('reports no unallow-listed gap in the real tree', () => {
    expect(findGaps(buildReport(classes)).map((c) => c.className)).toEqual([]);
  });
});
