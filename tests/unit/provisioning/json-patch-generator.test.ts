import { describe, it, expect } from 'vite-plus/test';
import { JsonPatchGenerator } from '../../../src/provisioning/json-patch-generator.js';

describe('JsonPatchGenerator.generatePatch', () => {
  // go-to-k/cdkd#3515: the removal loop tested membership with `key in
  // desiredProperties`, which answers TRUE for an Object.prototype member
  // (`constructor`) through the prototype chain, so a removed property of
  // that name produced no `remove` op and stayed live on AWS.
  it('emits a remove op for a removed property named after an Object.prototype member', () => {
    const gen = new JsonPatchGenerator();
    const patches = gen.generatePatch({ Name: 'a', constructor: 'x' }, { Name: 'a' });
    expect(patches).toEqual([{ op: 'remove', path: '/constructor' }]);
  });
  // go-to-k/cdkd#3515 (generatePatch add arm): `previousProperties[key] ===
  // undefined` read Object.prototype.constructor for a newly added property
  // named `constructor`, so it was classified as a change (`replace`) of a
  // path that does not exist instead of an `add`.
  it('emits an add op for an added property named after an Object.prototype member', () => {
    const gen = new JsonPatchGenerator();
    const patches = gen.generatePatch({ Name: 'a' }, { Name: 'a', constructor: 'x' });
    expect(patches).toEqual([{ op: 'add', path: '/constructor', value: 'x' }]);
  });

  // go-to-k/cdkd#3515 (deepEqual object arm): the key walk read `bObj[key]`
  // without an own-key check. A JSON-parsed own `__proto__: {}` on the previous
  // side met `bObj['__proto__']` === Object.prototype (zero own keys) on the
  // desired side, which compared equal to `{}`, so a real change was dropped.
  it('emits a replace when a nested own __proto__ key is replaced by a different key', () => {
    const gen = new JsonPatchGenerator();
    const previous = { Cfg: JSON.parse('{"__proto__": {}}') as Record<string, unknown> };
    const desired = { Cfg: { B: {} } };
    const patches = gen.generatePatch(previous, desired);
    expect(patches).toEqual([{ op: 'replace', path: '/Cfg', value: { B: {} } }]);
  });

  // Negative controls for the three cases above: an own-key test must not
  // OVER-answer either. A mutant that treats every prototype-member NAME as
  // absent (`!Object.hasOwn(x, k) || k in Object.prototype`) passes every
  // positive case, and only an unchanged key of that name present on BOTH
  // sides tells it apart.
  it('emits nothing for an unchanged property named after an Object.prototype member', () => {
    const gen = new JsonPatchGenerator();
    expect(gen.generatePatch({ constructor: 'x' }, { constructor: 'x' })).toEqual([]);
  });

  it('emits nothing for an unchanged nested own __proto__ key present on both sides', () => {
    const gen = new JsonPatchGenerator();
    const bag = (): Record<string, unknown> => ({
      Cfg: JSON.parse('{"__proto__": {}}') as Record<string, unknown>,
    });
    expect(gen.generatePatch(bag(), bag())).toEqual([]);
  });
});
