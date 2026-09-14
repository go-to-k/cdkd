/**
 * The pure merge rule behind the no-change path's partial Outputs persist
 * (issue #2771). The engine-level cases, which pin the WIRING, live in
 * `deploy-engine-outputs-only-change.test.ts` and
 * `deploy-engine-skipped-outputs.test.ts`; these pin each rule and refusal in
 * isolation, both directions.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  bagHoldsSecretExpression,
  isSecretBearingReferenceString,
  keptWholeReasonText,
  mergeNoChangeOutputs,
  type NoChangeOutputsMergeInput,
} from '../../../src/deployment/no-change-outputs-merge.js';
import type { TemplateOutput } from '../../../src/types/resource.js';

const SEC = '{{resolve:secretsmanager:db:SecretString:password}}';

function input(overrides: Partial<NoChangeOutputsMergeInput>): NoChangeOutputsMergeInput {
  return {
    persisted: {},
    resolved: {},
    declaredOutputs: {},
    previousExportNames: new Set(),
    resolvedExportNames: [],
    ...overrides,
  };
}

function merged(result: ReturnType<typeof mergeNoChangeOutputs>) {
  expect(result.kind).toBe('merged');
  if (result.kind !== 'merged') throw new Error('unreachable');
  return result;
}

describe('mergeNoChangeOutputs', () => {
  it('rule 1: a resolved key writes this pass\x27s value over the stored one', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { A: 'old', F: 'f' },
          resolved: { A: 'new', F: undefined },
          declaredOutputs: { A: { Value: 'x' }, F: { Value: 'y' } },
        })
      )
    );
    expect(r.outputs).toEqual({ A: 'new', F: 'f' });
    expect(r.carriedKeys).toEqual(['F']);
  });

  it('rule 2: a failed key with no stored value stays absent', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({ persisted: {}, resolved: { F: undefined, A: 'a' }, declaredOutputs: { F: { Value: 1 } } })
      )
    );
    expect(r.outputs).toEqual({ A: 'a' });
    expect(Object.prototype.hasOwnProperty.call(r.outputs, 'F')).toBe(false);
    expect(r.carriedKeys).toEqual([]);
  });

  it('rule 3: a stored key this pass did not produce (deleted or condition-suppressed) is removed', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { Deleted: 'd', Suppressed: 's', F: 'f' },
          resolved: { F: undefined },
          declaredOutputs: { F: { Value: 1 }, Suppressed: { Value: 2, Condition: 'No' } },
        })
      )
    );
    expect(r.outputs).toEqual({ F: 'f' });
  });

  it('carries a literal alias and its export membership only when the previous record published it', () => {
    const declaredOutputs: Record<string, TemplateOutput> = {
      F: { Value: 1, Export: { Name: 'ex:F' } },
    };
    const published = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f', 'ex:F': 'f' },
          resolved: { F: undefined },
          declaredOutputs,
          previousExportNames: new Set(['ex:F']),
        })
      )
    );
    expect(published.outputs).toEqual({ F: 'f', 'ex:F': 'f' });
    expect(published.exportNames).toEqual(['ex:F']);

    const unpublished = merged(
      mergeNoChangeOutputs(
        input({ persisted: { F: 'f', 'ex:F': 'f' }, resolved: { F: undefined }, declaredOutputs })
      )
    );
    expect(unpublished.outputs).toEqual({ F: 'f' });
    expect(unpublished.exportNames).toEqual([]);
  });

  it('tolerates a template with no Outputs section (declaredOutputs undefined)', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({ persisted: { F: 'f' }, resolved: { F: undefined }, declaredOutputs: undefined })
      )
    );
    expect(r.outputs).toEqual({ F: 'f' });
  });

  // The RESOLVED-name collision. `Other` is both in `resolved` and already in
  // `outputs`, so the `resolved` gate and the already-written guard each block
  // it and neither is pinned by this case alone: the failed-name case below
  // pins the `resolved` gate, the shared-alias case pins the already-written one.
  it('does not overwrite a resolved output with a failed output\x27s same-named alias', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f', Other: 'stale-alias' },
          resolved: { F: undefined, Other: 'other-now' },
          declaredOutputs: { F: { Value: 1, Export: { Name: 'Other' } }, Other: { Value: 2 } },
          previousExportNames: new Set(['Other']),
        })
      )
    );
    expect(r.outputs).toEqual({ F: 'f', Other: 'other-now' });
    expect(r.exportNames).toEqual([]);
  });

  it('does not carry an alias as an EXPORT when it names another FAILED published output', () => {
    // The arm where the collision gate decides: `Other` failed too, so it is
    // in `resolved` (as `undefined`) but not yet in the merged bag when `F`'s
    // alias is considered. Without the gate, `F` would carry `Other` as ITS
    // alias and mark a published output name exported.
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f', Other: 'o' },
          resolved: { F: undefined, Other: undefined },
          declaredOutputs: { F: { Value: 1, Export: { Name: 'Other' } }, Other: { Value: 2 } },
          previousExportNames: new Set(['Other']),
        })
      )
    );
    expect(r.outputs).toEqual({ F: 'f', Other: 'o' });
    expect(r.exportNames).toEqual([]);
  });

  it('does not refuse for an intrinsic Export.Name on a failed output that never had a stored value', () => {
    // It never resolved, so it never published an alias to lose — the issue's
    // own shape with an `Fn::Join` export name.
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { A: 'a' },
          resolved: { F: undefined, A: 'a', Added: 'x' },
          declaredOutputs: {
            F: { Value: 1, Export: { Name: { 'Fn::Join': ['-', ['s', 'F']] } as unknown as string } },
          },
        })
      )
    );
    expect(r.outputs).toEqual({ A: 'a', Added: 'x' });
  });

  it('does not refuse for a null or numeric Export.Name, which publishes nothing', () => {
    for (const name of [null, 7]) {
      const r = merged(
        mergeNoChangeOutputs(
          input({
            persisted: { F: 'f' },
            resolved: { F: undefined, A: 'a' },
            declaredOutputs: { F: { Value: 1, Export: { Name: name as unknown as string } } },
          })
        )
      );
      expect(r.outputs).toEqual({ F: 'f', A: 'a' });
    }
  });

  it('does not export a self-named failed output the previous record never published', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f' },
          resolved: { F: undefined },
          declaredOutputs: { F: { Value: 1, Export: { Name: 'F' } } },
        })
      )
    );
    expect(r.outputs).toEqual({ F: 'f' });
    expect(r.exportNames).toEqual([]);
  });

  it('does not carry an alias the previous export set names but the stored bag does not hold', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f' },
          resolved: { F: undefined },
          declaredOutputs: { F: { Value: 1, Export: { Name: 'ex:F' } } },
          previousExportNames: new Set(['ex:F']),
        })
      )
    );
    expect(Object.keys(r.outputs)).toEqual(['F']);
    expect(r.exportNames).toEqual([]);
  });

  it('keeps a self-named export exported only while the template still declares it', () => {
    const exported = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f' },
          resolved: { F: undefined },
          declaredOutputs: { F: { Value: 1, Export: { Name: 'F' } } },
          previousExportNames: new Set(['F']),
        })
      )
    );
    expect(exported.exportNames).toEqual(['F']);

    const dropped = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f' },
          resolved: { F: undefined },
          declaredOutputs: { F: { Value: 1 } },
          previousExportNames: new Set(['F']),
        })
      )
    );
    expect(dropped.exportNames).toEqual([]);
  });

  it('bagHoldsSecretExpression tolerates a null bag (hand-edited state)', () => {
    expect(bagHoldsSecretExpression(null)).toBe(false);
  });

  it('starts the export set from this pass\x27s aliases, then the carried ones', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f', 'ex:F': 'f' },
          resolved: { F: undefined, A: 'a', 'ex:A': 'a' },
          declaredOutputs: { F: { Value: 1, Export: { Name: 'ex:F' } } },
          previousExportNames: new Set(['ex:F']),
          resolvedExportNames: ['ex:A'],
        })
      )
    );
    expect(r.exportNames).toEqual(['ex:A', 'ex:F']);
  });

  it('REFUSES (keeps the whole bag) when a failed output declares an intrinsic Export.Name', () => {
    const result = mergeNoChangeOutputs(
      input({
        persisted: { F: 'f', 'ex-F': 'f' },
        resolved: { F: undefined, A: 'a' },
        declaredOutputs: { F: { Value: 1, Export: { Name: { 'Fn::Sub': 'ex-F' } as unknown as string } } },
      })
    );
    expect(result).toEqual({ kind: 'kept', reason: 'intrinsic-export-name' });
  });

  it('...but an intrinsic Export.Name on a RESOLVED output with a stored value does not refuse', () => {
    // `A` is stored AND intrinsic-exported, so only the failed-key filter keeps
    // it out of the refusal: examining every resolved key would refuse here.
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { A: 'a-old', F: 'f' },
          resolved: { F: undefined, A: 'a' },
          declaredOutputs: {
            F: { Value: 1 },
            A: { Value: 'a', Export: { Name: { 'Fn::Sub': 'ex-A' } as unknown as string } },
          },
        })
      )
    );
    expect(r.outputs).toEqual({ A: 'a', F: 'f' });
  });

  it('reads only OWN declared outputs, never an inherited one', () => {
    const inherited = Object.create({
      F: { Value: 1, Export: { Name: { 'Fn::Sub': 'ex-F' } } },
    }) as Record<string, TemplateOutput>;
    const r = merged(
      mergeNoChangeOutputs(
        input({ persisted: { F: 'f' }, resolved: { F: undefined }, declaredOutputs: inherited })
      )
    );
    expect(r.outputs).toEqual({ F: 'f' });
  });

  it('carries an alias two failed outputs share exactly once', () => {
    const r = merged(
      mergeNoChangeOutputs(
        input({
          persisted: { F: 'f', G: 'g', ex: 'v' },
          resolved: { F: undefined, G: undefined },
          declaredOutputs: {
            F: { Value: 1, Export: { Name: 'ex' } },
            G: { Value: 2, Export: { Name: 'ex' } },
          },
          previousExportNames: new Set(['ex']),
        })
      )
    );
    expect(r.carriedKeys).toEqual(['F', 'ex', 'G']);
    expect(r.exportNames).toEqual(['ex']);
  });

  describe('the mixed-generation refusal', () => {
    it('REFUSES to carry a value into a bag this pass would give its FIRST secret expression', () => {
      expect(
        mergeNoChangeOutputs(
          input({
            persisted: { Old: 'maybe-plaintext' },
            resolved: { Old: undefined, Sec: SEC },
            declaredOutputs: { Old: { Value: 1 }, Sec: { Value: SEC } },
          })
        )
      ).toEqual({ kind: 'kept', reason: 'mixed-generation' });
    });

    it('merges when the previous bag already held an expression', () => {
      const r = merged(
        mergeNoChangeOutputs(
          input({
            persisted: { Old: 'o', Prev: SEC },
            resolved: { Old: undefined, Prev: SEC, Sec: SEC },
          })
        )
      );
      expect(r.outputs).toEqual({ Old: 'o', Prev: SEC, Sec: SEC });
    });

    it('merges when nothing is carried', () => {
      const r = merged(
        mergeNoChangeOutputs(input({ persisted: { A: 'a' }, resolved: { F: undefined, A: 'a', Sec: SEC } }))
      );
      expect(r.outputs).toEqual({ A: 'a', Sec: SEC });
    });

    it('merges when the merged bag holds no expression at all', () => {
      const r = merged(
        mergeNoChangeOutputs(input({ persisted: { Old: 'o' }, resolved: { Old: undefined, A: 'a' } }))
      );
      expect(r.outputs).toEqual({ Old: 'o', A: 'a' });
    });

    it('a CARRIED expression counts as the previous bag holding one', () => {
      const r = merged(
        mergeNoChangeOutputs(input({ persisted: { Old: SEC }, resolved: { Old: undefined, Sec: SEC } }))
      );
      expect(r.outputs).toEqual({ Old: SEC, Sec: SEC });
    });
  });

  it('handles an output literally named `__proto__` as data (null-prototype bag)', () => {
    const persisted = JSON.parse('{"__proto__": "stored"}') as Record<string, unknown>;
    const resolved = Object.create(null) as Record<string, unknown>;
    resolved['__proto__'] = undefined;
    resolved['A'] = 'a';
    const r = merged(mergeNoChangeOutputs(input({ persisted, resolved })));
    expect(Object.getPrototypeOf(r.outputs)).toBeNull();
    expect(Object.keys(r.outputs).sort()).toEqual(['A', '__proto__']);
    expect(r.outputs['__proto__']).toBe('stored');
  });
});

describe('the shared secret-expression predicate', () => {
  it('matches the two always-secret spellings and nothing else', () => {
    expect(isSecretBearingReferenceString(SEC)).toBe(true);
    expect(isSecretBearingReferenceString('{{resolve:ssm-secure:/p:1}}')).toBe(true);
    expect(isSecretBearingReferenceString('{{resolve:ssm:/public}}')).toBe(false);
    // An array whose ELEMENT is the bare opener: `Array.prototype.includes`
    // would match it, so only the string-type guard returns false here.
    expect(isSecretBearingReferenceString(['{{resolve:secretsmanager:'])).toBe(false);
  });

  it('reads only top-level string leaves of a bag', () => {
    expect(bagHoldsSecretExpression({ A: SEC })).toBe(true);
    expect(bagHoldsSecretExpression({ A: [SEC, 'plaintext'] })).toBe(false);
    expect(bagHoldsSecretExpression({})).toBe(false);
    expect(bagHoldsSecretExpression(undefined)).toBe(false);
  });

  it('names a reason for each refusal', () => {
    expect(keptWholeReasonText('intrinsic-export-name')).toMatch(/intrinsic Export\.Name/);
    expect(keptWholeReasonText('mixed-generation')).toMatch(/redacted secret reference/);
  });
});
