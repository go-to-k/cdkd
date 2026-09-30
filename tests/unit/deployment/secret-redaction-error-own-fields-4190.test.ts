import { inspect } from 'node:util';
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  ERROR_CAUSE_MASK_MAX_DEPTH,
  maskSecretsInError,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import {
  isMarkedNonRetryable,
  isThrottlingError,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';

// go-to-k/cdkd#4190: `maskSecretsInError` masked each link's `message` and
// `stack` and copied every other own field verbatim, so an AWS SDK exception's
// own copy of its error body (awsQuery's `Error: { Type, Code, Message }`, a
// JSON / XML exception's modeled `Message`) kept the plaintext for any reader
// that walks the object (`util.inspect`, `JSON.stringify`).

const SECRET = 'secret-named-role-0001';
const EXPRESSION = '{{resolve:secretsmanager:sdp:SecretString:role::}}';

function bag(): RecordedSecretValues {
  return new Map([[SECRET, EXPRESSION]]);
}

/** The own-key shape measured on `@aws-sdk/client-iam` for a 403 awsQuery body. */
class IamLikeException extends Error {
  $fault = 'client';
  $metadata = { httpStatusCode: 403, requestId: 'req-1', attempts: 1 };
  Type = 'Sender';
  Code = 'AccessDenied';
  Error: { Type: string; Code: string; Message: string };
  constructor(message: string) {
    super(message);
    this.name = 'AccessDenied';
    this.Error = { Type: 'Sender', Code: 'AccessDenied', Message: message };
  }
}

describe('maskSecretsInError - own fields (go-to-k/cdkd#4190)', () => {
  it('masks an awsQuery `Error.Message` and keeps name, Code, $metadata and the marker', () => {
    const original = markNonRetryable(
      new IamLikeException(`User is not authorized on role/${SECRET}`)
    );
    const masked = maskSecretsInError(original, bag());

    expect(masked).not.toBe(original);
    expect(masked).toBeInstanceOf(IamLikeException);
    expect(masked.message).toBe(`User is not authorized on role/${SECRET_MASK}`);
    expect(masked.Error).toEqual({
      Type: 'Sender',
      Code: 'AccessDenied',
      Message: `User is not authorized on role/${SECRET_MASK}`,
    });
    // Identifier fields survive, the unchanged `$metadata` by identity.
    expect(masked.name).toBe('AccessDenied');
    expect(masked.Code).toBe('AccessDenied');
    expect(masked.Type).toBe('Sender');
    expect(masked.$fault).toBe('client');
    expect(masked.$metadata).toBe(original.$metadata);
    expect(isMarkedNonRetryable(masked)).toBe(true);
    // The original is never written.
    expect(original.Error.Message).toContain(SECRET);
  });

  it('makes a clone when the name is ONLY in an own field (message and stack clean)', () => {
    const original = Object.assign(new Error('AccessDenied'), {
      Error: { Code: 'AccessDenied', Message: `role/${SECRET}` },
    });
    const masked = maskSecretsInError(original, bag());

    expect(masked).not.toBe(original);
    expect(masked.message).toBe('AccessDenied');
    expect(masked.Error).toEqual({ Code: 'AccessDenied', Message: `role/${SECRET_MASK}` });
    expect(original.Error.Message).toBe(`role/${SECRET}`);
  });

  it('masks a direct own string field (a JSON / XML exception`s modeled `Message`)', () => {
    const original = Object.assign(new Error('denied'), { Message: `denied on ${SECRET}` });
    const masked = maskSecretsInError(original, bag());
    expect(masked.Message).toBe(`denied on ${SECRET_MASK}`);
    expect(original.Message).toContain(SECRET);
  });

  it('masks a field of a DEEPER link of the cause chain', () => {
    const inner = new IamLikeException(`role/${SECRET}`);
    Object.defineProperty(inner, 'message', { value: 'denied', configurable: true });
    const outer = new Error('wrapped', { cause: inner });
    const masked = maskSecretsInError(outer, bag());
    const cause = masked.cause as IamLikeException;
    expect(cause).not.toBe(inner);
    expect(cause.Error.Message).toBe(`role/${SECRET_MASK}`);
    expect(inner.Error.Message).toBe(`role/${SECRET}`);
  });

  it('masks a string cause and a plain-object cause', () => {
    const withString = new Error('x', { cause: `for ${SECRET}` });
    expect(maskSecretsInError(withString, bag()).cause).toBe(`for ${SECRET_MASK}`);
    const withObject = new Error('x', { cause: { detail: [`for ${SECRET}`] } });
    expect(maskSecretsInError(withObject, bag()).cause).toEqual({
      detail: [`for ${SECRET_MASK}`],
    });
    expect((withObject.cause as { detail: string[] }).detail[0]).toContain(SECRET);
  });

  it('masks strings in arrays and symbol-keyed fields, keeping holes and length', () => {
    const sym = Symbol('detail');
    const sparse: unknown[] = [];
    sparse[3] = SECRET;
    const original = Object.assign(new Error('x'), {
      list: ['plain', `a ${SECRET}`, { nested: SECRET }],
      sparse,
      [sym]: `b ${SECRET}`,
    });
    const masked = maskSecretsInError(original, bag());
    expect(masked.list).toEqual(['plain', `a ${SECRET_MASK}`, { nested: SECRET_MASK }]);
    expect(masked.sparse).toHaveLength(4);
    expect(0 in masked.sparse).toBe(false);
    expect(masked.sparse[3]).toBe(SECRET_MASK);
    expect((masked as unknown as Record<symbol, string>)[sym]).toBe(`b ${SECRET_MASK}`);
  });

  it('keeps each property`s attributes and the prototype of a null-prototype object', () => {
    const detail = Object.create(null) as Record<string, string>;
    Object.defineProperty(detail, 'Message', { value: SECRET, enumerable: false });
    const original = new Error('x');
    Object.defineProperty(original, 'Error', { value: detail, enumerable: true });
    const masked = maskSecretsInError(original, bag()) as Error & { Error: typeof detail };
    expect(Object.getPrototypeOf(masked.Error)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(masked.Error, 'Message')).toEqual({
      value: SECRET_MASK,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(Object.getOwnPropertyDescriptor(masked, 'Error')?.writable).toBe(false);
  });

  it('copies a FROZEN object instead of writing it, and keeps the copy non-extensible', () => {
    const detail = Object.freeze({ Message: SECRET });
    const original = Object.assign(new Error('x'), { Error: detail });
    const masked = maskSecretsInError(original, bag());
    expect(masked.Error).not.toBe(detail);
    expect(masked.Error.Message).toBe(SECRET_MASK);
    expect(Object.isFrozen(masked.Error)).toBe(true);
    expect(detail.Message).toBe(SECRET);
  });

  it('terminates on a CYCLE and keeps a shared node shared in the copy', () => {
    const shared = { Message: SECRET };
    const node: Record<string, unknown> = { a: shared, b: shared };
    // Three self-references: without the visited set the frontier grows 3^depth.
    node.self = node;
    node.again = node;
    node.more = node;
    const original = Object.assign(new Error('x'), { Error: node });
    const masked = maskSecretsInError(original, bag());
    const copy = masked.Error;
    expect(copy).not.toBe(node);
    expect(copy.self).toBe(copy);
    expect(copy.a).toBe(copy.b);
    expect((copy.a as { Message: string }).Message).toBe(SECRET_MASK);
    expect(shared.Message).toBe(SECRET);
  });

  it('never invokes an accessor, and a throwing getter does not throw', () => {
    const getter = vi.fn(() => {
      throw new Error(`getter ${SECRET}`);
    });
    const detail = { Message: SECRET };
    Object.defineProperty(detail, 'loud', { get: getter, enumerable: true });
    const original = Object.assign(new Error('x'), { Error: detail });
    Object.defineProperty(original, 'link', { get: getter, enumerable: true });
    const masked = maskSecretsInError(original, bag());
    expect(getter).not.toHaveBeenCalled();
    expect(masked.Error.Message).toBe(SECRET_MASK);
    expect(Object.getOwnPropertyDescriptor(masked.Error, 'loud')?.get).toBe(getter);
  });

  it('does not enter a class instance, and a throwing Proxy keeps its value without throwing', () => {
    class Holder {
      constructor(public text: string) {}
    }
    const holder = new Holder(SECRET);
    const map = new Map([['k', SECRET]]);
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      }
    );
    const original = Object.assign(new Error(`m ${SECRET}`), { holder, map, hostile });
    const masked = maskSecretsInError(original, bag());
    expect(masked.message).toBe(`m ${SECRET_MASK}`);
    expect(masked.holder).toBe(holder);
    expect(masked.map).toBe(map);
    expect(masked.hostile).toBe(hostile);
  });

  it(`masks at the shallowest depth a node is reached, and stops past ${ERROR_CAUSE_MASK_MAX_DEPTH} levels`, () => {
    const leaf = { Message: SECRET };
    let deep: Record<string, unknown> = { leaf };
    for (let i = 0; i < ERROR_CAUSE_MASK_MAX_DEPTH + 5; i++) deep = { next: deep };
    // `deep` first, so a depth-first walk would reach `leaf` past the cap first.
    const original = Object.assign(new Error('x'), { Error: { deep, leaf } });
    const masked = maskSecretsInError(original, bag());
    expect(masked.Error.leaf.Message).toBe(SECRET_MASK);
    // The bound: past it the value is kept as it is (the original node).
    let cursor = masked.Error.deep as Record<string, unknown>;
    for (let i = 0; i < ERROR_CAUSE_MASK_MAX_DEPTH + 5; i++) {
      cursor = cursor.next as Record<string, unknown>;
    }
    expect((cursor.leaf as { Message: string }).Message).toBe(SECRET);
  });

  it(`masks the last entered level (${ERROR_CAUSE_MASK_MAX_DEPTH - 1}) and keeps the one past it`, () => {
    // The field value is level 0, so levels 0..MAX-1 are entered.
    const past = { Message: SECRET };
    const last: Record<string, unknown> = { Message: SECRET, past };
    let root: Record<string, unknown> = last;
    for (let i = 0; i < ERROR_CAUSE_MASK_MAX_DEPTH - 1; i++) root = { next: root };
    const masked = maskSecretsInError(Object.assign(new Error('x'), { Error: root }), bag());
    let cursor = masked.Error;
    for (let i = 0; i < ERROR_CAUSE_MASK_MAX_DEPTH - 1; i++) {
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(cursor.Message).toBe(SECRET_MASK);
    expect(cursor.past).toBe(past);
  });

  it('a throwing `stack` accessor neither throws nor stops the masking', () => {
    const original = new Error(`m ${SECRET}`);
    Object.defineProperty(original, 'stack', {
      get() {
        throw new Error('stack getter');
      },
      configurable: true,
    });
    const masked = maskSecretsInError(original, bag());
    expect(masked.message).toBe(`m ${SECRET_MASK}`);
    expect(Object.getOwnPropertyDescriptor(masked, 'stack')).toBeUndefined();
  });

  it('does not enter an Array SUBCLASS instance', () => {
    class Items extends Array<string> {}
    const items = new Items();
    items.push(SECRET);
    const masked = maskSecretsInError(Object.assign(new Error(`m ${SECRET}`), { items }), bag());
    expect(masked.items).toBe(items);
  });

  it('keeps a frozen array`s length non-writable in the copy', () => {
    const list = Object.freeze([SECRET, 'a']);
    const masked = maskSecretsInError(Object.assign(new Error('x'), { list }), bag());
    expect(masked.list).toEqual([SECRET_MASK, 'a']);
    expect(Object.getOwnPropertyDescriptor(masked.list, 'length')?.writable).toBe(false);
    expect(Object.isFrozen(masked.list)).toBe(true);
  });

  it('copies the classifier identifier fields verbatim even when a recorded value occurs in them', () => {
    const original = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      code: 'ThrottlingException',
      Code: 'Throttling',
      __type: 'ThrottlingException',
      ccErrorCode: 'Throttling',
      ccOperation: 'Throttling',
      Message: 'Throttling on a request',
    });
    const masked = maskSecretsInError(original, new Map([['Throttling', EXPRESSION]]));
    expect(isThrottlingError(original)).toBe(true);
    expect(isThrottlingError(masked)).toBe(true);
    for (const key of ['name', 'code', 'Code', '__type', 'ccErrorCode', 'ccOperation'] as const) {
      expect(masked[key]).toBe(original[key]);
    }
    // Any OTHER field is masked: the exemption is by key.
    expect(masked.Message).toBe('*** on a request');
  });

  it('applies extraMask to own fields too', () => {
    const original = Object.assign(new Error('clean'), { Error: { Message: 'stack prod-q7' } });
    const masked = maskSecretsInError(original, new Map(), (t) => t.split('prod-q7').join('***'));
    expect(masked.Error.Message).toBe('stack ***');
  });

  it('masks a stack that alone holds the secret (message reassigned after construction)', () => {
    const original = new Error(`first ${SECRET}`);
    // V8 formats the stack on first read, so read it before the reassignment.
    expect(original.stack).toContain(SECRET);
    original.message = 'clean';
    expect(original.stack).toContain(SECRET);
    const masked = maskSecretsInError(original, bag());
    expect(masked).not.toBe(original);
    expect(masked.stack).not.toContain(SECRET);
  });

  it('prints no plaintext through util.inspect or JSON.stringify', () => {
    const outer = new Error('wrapped', { cause: new IamLikeException(`role/${SECRET}`) });
    const masked = maskSecretsInError(outer, bag());
    expect(inspect(masked, { depth: 10 })).not.toContain(SECRET);
    expect(JSON.stringify(masked.cause)).not.toContain(SECRET);
    // Non-vacuity: the original prints it through both.
    expect(inspect(outer, { depth: 10 })).toContain(SECRET);
    expect(JSON.stringify(outer.cause)).toContain(SECRET);
  });

  it('returns the ORIGINAL by identity when no field, message or stack changes', () => {
    const original = Object.assign(new IamLikeException('denied'), { list: ['a', { b: 'c' }] });
    expect(maskSecretsInError(original, bag())).toBe(original);
  });

  it('a masked clone still classifies (name / $metadata untouched)', () => {
    const throttle = Object.assign(new Error(`Rate exceeded for ${SECRET}`), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
      Error: { Code: 'Throttling', Message: `Rate exceeded for ${SECRET}` },
    });
    const masked = maskSecretsInError(throttle, bag());
    expect(masked).not.toBe(throttle);
    expect(isThrottlingError(masked)).toBe(true);
  });
});
