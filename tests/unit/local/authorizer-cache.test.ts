import { describe, expect, it } from 'vite-plus/test';
import { createAuthorizerCache } from '../../../src/local/authorizer-cache.js';

describe('authorizer-cache', () => {
  it('returns undefined on miss', () => {
    const cache = createAuthorizerCache();
    expect(cache.get('A1', 'tok')).toBeUndefined();
  });

  it('roundtrips a cached entry within its TTL', () => {
    let now = 1_000_000;
    const cache = createAuthorizerCache({ now: () => now });
    cache.set('A1', 'tok', 60, { allow: true, principalId: 'u1', context: { foo: 'bar' } });
    expect(cache.get('A1', 'tok')).toEqual({
      allow: true,
      principalId: 'u1',
      context: { foo: 'bar' },
    });
    now += 30_000; // 30 seconds in
    expect(cache.get('A1', 'tok')).toEqual({
      allow: true,
      principalId: 'u1',
      context: { foo: 'bar' },
    });
  });

  it('evicts past-expiry entries on get', () => {
    let now = 1_000_000;
    const cache = createAuthorizerCache({ now: () => now });
    cache.set('A1', 'tok', 5, { allow: true });
    expect(cache.get('A1', 'tok')).toEqual({ allow: true });
    now += 6_000; // 1 second past TTL
    expect(cache.get('A1', 'tok')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('treats ttl=0 as no-op (HTTP v2 JWT default)', () => {
    const cache = createAuthorizerCache();
    cache.set('A1', 'tok', 0, { allow: true });
    expect(cache.get('A1', 'tok')).toBeUndefined();
  });

  it('isolates entries by authorizer id and identity hash', () => {
    const cache = createAuthorizerCache();
    cache.set('A1', 'a', 60, { allow: true, principalId: 'u1' });
    cache.set('A2', 'a', 60, { allow: false });
    cache.set('A1', 'b', 60, { allow: false });
    expect(cache.get('A1', 'a')).toEqual({ allow: true, principalId: 'u1' });
    expect(cache.get('A2', 'a')).toEqual({ allow: false });
    expect(cache.get('A1', 'b')).toEqual({ allow: false });
  });

  it('clear() drops every entry', () => {
    const cache = createAuthorizerCache();
    cache.set('A1', 'a', 60, { allow: true });
    cache.set('A1', 'b', 60, { allow: false });
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('A1', 'a')).toBeUndefined();
  });
});
