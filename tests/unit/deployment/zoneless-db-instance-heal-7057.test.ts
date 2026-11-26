/**
 * go-to-k/cdkd#7057: a DBInstance record written before #5640 holds no
 * `AvailabilityZone` where the template declares one. The heal compares the
 * declared zone with the instance's (its drift baseline, else ONE live read)
 * and records it when equal; any other record makes no call (#6438).
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import { healZonelessDbInstanceRecords } from '../../../src/deployment/zoneless-db-instance-heal.js';
import { readDbInstanceAvailabilityZone } from '../../../src/provisioning/providers/rds/live-zone.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const INSTANCE = 'AWS::RDS::DBInstance';
const BASE = { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' };

const record = (properties: Record<string, unknown>, extra: Partial<ResourceState> = {}) =>
  ({
    resourceType: INSTANCE,
    physicalId: 'db-one',
    properties,
    attributes: {},
    dependencies: [],
    ...extra,
  }) as ResourceState;

const templateOf = (properties: Record<string, unknown>, type = INSTANCE): CloudFormationTemplate => ({
  Resources: { Db: { Type: type, Properties: properties } },
});

async function heal(
  resources: Record<string, ResourceState>,
  template: CloudFormationTemplate,
  live: (id: string) => Promise<string | undefined> = async () => 'us-east-1a',
  resolve: (value: unknown) => Promise<unknown> = async (v) => v
) {
  const reader = vi.fn(live);
  const resolver = vi.fn(resolve);
  const lines: string[] = [];
  const healed = await healZonelessDbInstanceRecords({
    resources,
    template,
    resolve: resolver,
    readLiveZone: reader,
    log: (line) => lines.push(line),
  });
  return { healed, reader, resolver, lines };
}

describe('the zone-less record, compared with the instance (go-to-k/cdkd#7057)', () => {
  it('live zone equal to the declared one: recorded, one read, by the recorded identifier', async () => {
    const original = record(BASE);
    const resources = { Db: original };
    const run = await heal(resources, templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }));
    expect(run.healed).toEqual(['Db']);
    expect(run.reader).toHaveBeenCalledTimes(1);
    expect(run.reader).toHaveBeenCalledWith('db-one');
    expect(resources.Db.properties['AvailabilityZone']).toBe('us-east-1a');
    // Replaced, never edited in place: the loaded record is untouched.
    expect(original.properties['AvailabilityZone']).toBeUndefined();
    expect(resources.Db).not.toBe(original);
  });

  it('live zone different: left as it was (the replacement stands)', async () => {
    const resources = { Db: record(BASE) };
    const run = await heal(
      resources,
      templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }),
      async () => 'us-east-1b'
    );
    expect(run.healed).toEqual([]);
    expect(run.reader).toHaveBeenCalledTimes(1);
    expect(resources.Db.properties['AvailabilityZone']).toBeUndefined();
    expect(run.lines.join('\n')).toContain('us-east-1b');
  });

  it('unreadable (the read rejects) or no zone reported: left as it was', async () => {
    for (const live of [
      async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      },
      async () => undefined,
    ]) {
      const resources = { Db: record(BASE) };
      const run = await heal(resources, templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }), live);
      expect(run.healed).toEqual([]);
      expect(resources.Db.properties['AvailabilityZone']).toBeUndefined();
    }
  });

  it('no reader: nothing is read and the record stays', async () => {
    const resources = { Db: record(BASE) };
    const healed = await healZonelessDbInstanceRecords({
      resources,
      template: templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }),
      resolve: async (v) => v,
      log: () => {},
    });
    expect(healed).toEqual([]);
    expect(resources.Db.properties['AvailabilityZone']).toBeUndefined();
  });

  it('the drift baseline holding the declared zone proves it: recorded with no read', async () => {
    const resources = {
      Db: record(BASE, { observedProperties: { AvailabilityZone: 'us-east-1a' } }),
    };
    const run = await heal(resources, templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }));
    expect(run.healed).toEqual(['Db']);
    expect(run.reader).not.toHaveBeenCalled();
    expect(resources.Db.properties['AvailabilityZone']).toBe('us-east-1a');
  });

  it('a baseline holding another zone does not decide: the instance is read', async () => {
    const resources = {
      Db: record(BASE, { observedProperties: { AvailabilityZone: 'us-east-1b' } }),
    };
    const run = await heal(resources, templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }));
    expect(run.reader).toHaveBeenCalledTimes(1);
    expect(run.healed).toEqual(['Db']);
  });

  it('the declared zone is compared as the diff resolves it', async () => {
    const resources = { Db: record(BASE) };
    const declared = { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] };
    const run = await heal(
      resources,
      templateOf({ ...BASE, AvailabilityZone: declared }),
      async () => 'us-east-1a',
      async () => 'us-east-1a'
    );
    expect(run.resolver).toHaveBeenCalledWith(declared);
    expect(run.healed).toEqual(['Db']);
  });

  it('a declared zone that does not resolve to text, or whose resolution throws: no read', async () => {
    for (const resolve of [
      async (v: unknown) => v,
      async () => {
        throw new Error('unresolvable');
      },
    ]) {
      const resources = { Db: record(BASE) };
      const run = await heal(
        resources,
        templateOf({ ...BASE, AvailabilityZone: { Ref: 'Zone' } }),
        undefined,
        resolve
      );
      expect(run.reader).not.toHaveBeenCalled();
      expect(run.healed).toEqual([]);
    }
  });

  it('several such records are read once each', async () => {
    const resources = { A: record(BASE, { physicalId: 'a' }), B: record(BASE, { physicalId: 'b' }) };
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: INSTANCE, Properties: { ...BASE, AvailabilityZone: 'us-east-1a' } },
        B: { Type: INSTANCE, Properties: { ...BASE, AvailabilityZone: 'us-east-1a' } },
      },
    };
    const run = await heal(resources, template, async (id) => (id === 'a' ? 'us-east-1a' : 'us-east-1c'));
    expect(run.reader).toHaveBeenCalledTimes(2);
    expect(run.healed).toEqual(['A']);
  });
});

describe('every other record makes no call and resolves nothing (#6438)', () => {
  const cases: [string, Record<string, ResourceState>, CloudFormationTemplate][] = [
    [
      'the record holds the zone (an ordinary deploy)',
      { Db: record({ ...BASE, AvailabilityZone: 'us-east-1a' }) },
      templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }),
    ],
    [
      'the record holds another zone (a genuine move: the rule decides)',
      { Db: record({ ...BASE, AvailabilityZone: 'us-east-1b' }) },
      templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }),
    ],
    ['the template declares no zone', { Db: record(BASE) }, templateOf(BASE)],
    [
      'the template declares an empty zone',
      { Db: record(BASE) },
      templateOf({ ...BASE, AvailabilityZone: '' }),
    ],
    [
      'another type',
      { Db: { ...record(BASE), resourceType: 'AWS::RDS::DBCluster' } },
      templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }, 'AWS::RDS::DBCluster'),
    ],
    [
      'the template retypes the logical id',
      { Db: record(BASE) },
      templateOf({ AvailabilityZone: 'us-east-1a' }, 'AWS::EC2::Instance'),
    ],
    ['the resource left the template', { Db: record(BASE) }, { Resources: {} }],
    [
      'an unreadable record bag',
      { Db: { ...record(BASE), properties: null as never } },
      templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }),
    ],
  ];
  for (const [name, resources, template] of cases) {
    it(name, async () => {
      const before = structuredClone(resources);
      const run = await heal(resources, template);
      expect(run.reader).not.toHaveBeenCalled();
      expect(run.resolver).not.toHaveBeenCalled();
      expect(run.healed).toEqual([]);
      expect(resources).toEqual(before);
    });
  }

  it('a record with no addressable identifier is not read', async () => {
    const resources = { Db: record(BASE, { physicalId: '  ' }) };
    const run = await heal(resources, templateOf({ ...BASE, AvailabilityZone: 'us-east-1a' }));
    expect(run.reader).not.toHaveBeenCalled();
    expect(run.healed).toEqual([]);
  });
});

describe('readDbInstanceAvailabilityZone', () => {
  const client = (answer: unknown) => {
    const send = vi.fn(async () => answer);
    return { send, client: { send } as never };
  };

  it('one DescribeDBInstances by the identifier; the zone it reports', async () => {
    const c = client({ DBInstances: [{ DBInstanceIdentifier: 'db-one', AvailabilityZone: 'us-east-1a' }] });
    expect(await readDbInstanceAvailabilityZone('db-one', 'us-east-1', c.client)).toBe('us-east-1a');
    expect(c.send).toHaveBeenCalledTimes(1);
    const sent = (c.send.mock.calls[0] as unknown[])[0] as { input: unknown };
    expect(sent.input).toEqual({ DBInstanceIdentifier: 'db-one' });
  });

  it('matches the identifier case-insensitively, as RDS stores it lowercased', async () => {
    const c = client({ DBInstances: [{ DBInstanceIdentifier: 'db-one', AvailabilityZone: 'us-east-1a' }] });
    expect(await readDbInstanceAvailabilityZone('DB-One', 'us-east-1', c.client)).toBe('us-east-1a');
  });

  it('another instance answering, no instance, or no zone: undefined', async () => {
    for (const answer of [
      { DBInstances: [{ DBInstanceIdentifier: 'db-two', AvailabilityZone: 'us-east-1a' }] },
      { DBInstances: [] },
      {},
      { DBInstances: [{ DBInstanceIdentifier: 'db-one' }] },
      { DBInstances: [{ DBInstanceIdentifier: 'db-one', AvailabilityZone: '' }] },
    ]) {
      expect(await readDbInstanceAvailabilityZone('db-one', 'us-east-1', client(answer).client)).toBe(
        undefined
      );
    }
  });

  it('a failed call rejects', async () => {
    const send = vi.fn(async () => {
      throw new Error('DBInstanceNotFound');
    });
    await expect(
      readDbInstanceAvailabilityZone('db-one', 'us-east-1', { send } as never)
    ).rejects.toThrow('DBInstanceNotFound');
  });
});
