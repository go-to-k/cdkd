/**
 * The prototype install `glue-provider.ts` uses for the methods split into this
 * directory. A method object's members are `this:`-typed functions; each one is
 * defined on the class's prototype with the descriptor a class method gets
 * (non-enumerable, writable, configurable), so it is an ordinary prototype
 * method at runtime: `this.name()` inside another method and
 * `vi.spyOn(provider, name)` both go through the instance.
 */

/** A method object's type, as the class's interface merge extends it. */
export type Mixin<T> = T;

/** Defines every member of `methods` on `target.prototype`. */
export function installMethods(target: { prototype: object }, ...methods: object[]): void {
  for (const members of methods) {
    for (const [name, value] of Object.entries(members)) {
      Object.defineProperty(target.prototype, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
}
