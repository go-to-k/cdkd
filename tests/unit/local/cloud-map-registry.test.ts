import { describe, expect, it } from 'vite-plus/test';
import { CloudMapRegistry } from '../../../src/local/cloud-map-registry.js';

describe('CloudMapRegistry', () => {
  describe('register / lookup', () => {
    it('publishes a single endpoint and looks it up by fqdn', () => {
      const r = new CloudMapRegistry();
      const handle = r.register('cdkd-local.local', 'orders', {
        ip: '172.20.0.5',
        port: 80,
        ownerKey: 'Orders:r0:sc:0',
      });
      expect(handle.fqdn).toBe('orders.cdkd-local.local');
      expect(handle.ownerKey).toBe('Orders:r0:sc:0');
      const endpoints = r.lookup('cdkd-local.local', 'orders');
      expect(endpoints?.length).toBe(1);
      expect(endpoints?.[0]).toEqual({
        ip: '172.20.0.5',
        port: 80,
        ownerKey: 'Orders:r0:sc:0',
      });
    });

    it('returns undefined when fqdn was never registered', () => {
      const r = new CloudMapRegistry();
      expect(r.lookup('cdkd-local.local', 'missing')).toBeUndefined();
    });

    it('supports multiple replicas under the same fqdn', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'svc', { ip: '1.2.3.4', port: 80, ownerKey: 'Svc:r0' });
      r.register('ns.local', 'svc', { ip: '1.2.3.5', port: 80, ownerKey: 'Svc:r1' });
      const endpoints = r.lookup('ns.local', 'svc');
      expect(endpoints?.length).toBe(2);
      expect(endpoints?.map((e) => e.ip)).toEqual(['1.2.3.4', '1.2.3.5']);
    });

    it('re-register by same ownerKey replaces the prior entry', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'svc', { ip: '1.2.3.4', port: 80, ownerKey: 'Svc:r0' });
      r.register('ns.local', 'svc', { ip: '5.6.7.8', port: 81, ownerKey: 'Svc:r0' });
      const endpoints = r.lookup('ns.local', 'svc');
      expect(endpoints?.length).toBe(1);
      expect(endpoints?.[0]?.ip).toBe('5.6.7.8');
      expect(endpoints?.[0]?.port).toBe(81);
    });

    it('rejects empty namespace and empty discoveryName', () => {
      const r = new CloudMapRegistry();
      expect(() => r.register('', 'svc', { ip: '1.1.1.1', port: 1, ownerKey: 'k' })).toThrow(
        /namespace must be a non-empty string/
      );
      expect(() => r.register('ns.local', '', { ip: '1.1.1.1', port: 1, ownerKey: 'k' })).toThrow(
        /discoveryName must be a non-empty string/
      );
    });
  });

  describe('unregister', () => {
    it('removes one endpoint by handle', () => {
      const r = new CloudMapRegistry();
      const handleA = r.register('ns.local', 'svc', {
        ip: '1.1.1.1',
        port: 80,
        ownerKey: 'Svc:r0',
      });
      r.register('ns.local', 'svc', { ip: '2.2.2.2', port: 80, ownerKey: 'Svc:r1' });
      expect(r.unregister(handleA)).toBe(true);
      const left = r.lookup('ns.local', 'svc');
      expect(left?.length).toBe(1);
      expect(left?.[0]?.ip).toBe('2.2.2.2');
    });

    it('returns false on unknown handle (idempotent)', () => {
      const r = new CloudMapRegistry();
      expect(r.unregister({ fqdn: 'x.y.z', ownerKey: 'gone' })).toBe(false);
    });

    it('deletes the fqdn entry when the last endpoint is removed', () => {
      const r = new CloudMapRegistry();
      const h = r.register('ns.local', 'svc', { ip: '1.1.1.1', port: 1, ownerKey: 'k' });
      r.unregister(h);
      expect(r.lookup('ns.local', 'svc')).toBeUndefined();
      expect(r.isEmpty()).toBe(true);
    });

    it('unregisterByOwner drops every entry with the matching prefix', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'svc', { ip: '1.1.1.1', port: 80, ownerKey: 'Svc:r0:sc:0' });
      r.register('ns.local', 'svc', { ip: '2.2.2.2', port: 80, ownerKey: 'Svc:r1:sc:0' });
      r.register('ns.local', 'other', { ip: '3.3.3.3', port: 80, ownerKey: 'Other:r0:sc:0' });
      const removed = r.unregisterByOwner('Svc:');
      expect(removed).toBe(2);
      expect(r.lookup('ns.local', 'svc')).toBeUndefined();
      expect(r.lookup('ns.local', 'other')?.length).toBe(1);
    });
  });

  describe('registerAlias / lookupAlias', () => {
    it('maps a bare alias to the target fqdn', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'orders', { ip: '1.1.1.1', port: 80, ownerKey: 'O:r0' });
      r.registerAlias('orders', 'orders.ns.local');
      const endpoints = r.lookupAlias('orders');
      expect(endpoints?.length).toBe(1);
      expect(endpoints?.[0]?.ip).toBe('1.1.1.1');
    });

    it('returns undefined when alias has no registered target', () => {
      const r = new CloudMapRegistry();
      r.registerAlias('orders', 'orders.ns.local');
      expect(r.lookupAlias('orders')).toBeUndefined();
    });

    it('rejects empty alias and empty targetFqdn', () => {
      const r = new CloudMapRegistry();
      expect(() => r.registerAlias('', 'a.b')).toThrow(/alias must be a non-empty string/);
      expect(() => r.registerAlias('a', '')).toThrow(/targetFqdn must be a non-empty string/);
    });
  });

  describe('buildAddHostFlags', () => {
    it('emits one --add-host pair per fqdn', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'svc', { ip: '1.1.1.1', port: 80, ownerKey: 'Svc:r0' });
      r.register('ns.local', 'other', { ip: '2.2.2.2', port: 80, ownerKey: 'Other:r0' });
      const flags = r.buildAddHostFlags();
      // Each entry produces two argv tokens (--add-host + name:ip).
      expect(flags.length).toBe(4);
      expect(flags).toEqual(
        expect.arrayContaining([
          '--add-host',
          'svc.ns.local:1.1.1.1',
          '--add-host',
          'other.ns.local:2.2.2.2',
        ])
      );
    });

    it('emits both the fqdn and every alias mapped to it', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'orders', { ip: '1.1.1.1', port: 80, ownerKey: 'O:r0' });
      r.registerAlias('orders', 'orders.ns.local');
      r.registerAlias('orders-svc', 'orders.ns.local');
      const flags = r.buildAddHostFlags();
      const map = parseAddHostFlags(flags);
      expect(map['orders.ns.local']).toBe('1.1.1.1');
      expect(map['orders']).toBe('1.1.1.1');
      expect(map['orders-svc']).toBe('1.1.1.1');
    });

    it('skips aliases pointing at fqdns with no live endpoint', () => {
      const r = new CloudMapRegistry();
      r.registerAlias('orders', 'orders.ns.local');
      const flags = r.buildAddHostFlags();
      expect(flags).toEqual([]);
    });

    it('excludeOwnerKeyPrefix drops every endpoint owned by that prefix', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'a', { ip: '1.1.1.1', port: 80, ownerKey: 'A:r0' });
      r.register('ns.local', 'b', { ip: '2.2.2.2', port: 80, ownerKey: 'B:r0' });
      const flags = r.buildAddHostFlags('A:');
      const map = parseAddHostFlags(flags);
      expect(map['a.ns.local']).toBeUndefined();
      expect(map['b.ns.local']).toBe('2.2.2.2');
    });

    it('first endpoint wins when multiple replicas registered under the same fqdn', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'svc', { ip: '1.1.1.1', port: 80, ownerKey: 'S:r0' });
      r.register('ns.local', 'svc', { ip: '2.2.2.2', port: 80, ownerKey: 'S:r1' });
      const flags = r.buildAddHostFlags();
      const map = parseAddHostFlags(flags);
      expect(map['svc.ns.local']).toBe('1.1.1.1');
    });
  });

  describe('list / isEmpty', () => {
    it('isEmpty reports the registry state', () => {
      const r = new CloudMapRegistry();
      expect(r.isEmpty()).toBe(true);
      r.register('ns.local', 'svc', { ip: '1.1.1.1', port: 1, ownerKey: 'k' });
      expect(r.isEmpty()).toBe(false);
    });

    it('list surfaces fqdn rows and alias rows', () => {
      const r = new CloudMapRegistry();
      r.register('ns.local', 'orders', { ip: '1.1.1.1', port: 80, ownerKey: 'O:r0' });
      r.registerAlias('orders', 'orders.ns.local');
      const rows = r.list();
      expect(rows.length).toBe(2);
      const fqdnRow = rows.find((r) => !r.isAlias);
      const aliasRow = rows.find((r) => r.isAlias);
      expect(fqdnRow?.discoveryName).toBe('orders');
      expect(fqdnRow?.namespace).toBe('ns.local');
      expect(aliasRow?.discoveryName).toBe('orders');
      expect(aliasRow?.namespace).toBe('');
      expect(aliasRow?.endpoints[0]?.ip).toBe('1.1.1.1');
    });
  });
});

function parseAddHostFlags(flags: ReadonlyArray<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] !== '--add-host') continue;
    const [name, ip] = (flags[i + 1] ?? '').split(':');
    if (name && ip) out[name] = ip;
  }
  return out;
}
