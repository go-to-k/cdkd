import { describe, expect, it } from 'vite-plus/test';
import {
  SECRET_MASK,
  noEchoCoordinatesOf,
  type NoEchoPositionSources,
} from '../../../src/deployment/secret-redaction.js';

/**
 * go-to-k/cdkd#7189: a leaf that EMBEDS a declared `NoEcho` attribute is
 * positioned only where the persisted bag already holds it wholly as the mask
 * (the containment rule masked it), never where that rule spared it.
 */
const SOURCES: NoEchoPositionSources = {
  parameters: new Set(['Token']),
  attributeIsNoEcho: (id, attribute) => id === 'Cr' && attribute === 'Secret',
};
const getAtt = { 'Fn::GetAtt': ['Cr', 'Secret'] };
const join = { 'Fn::Join': ['', ['postgres://u:', getAtt, '@db']] };
const sub = { 'Fn::Sub': 'postgres://u:${Cr.Secret}@db' };
const template = {
  Joined: join,
  Subbed: sub,
  Bare: getAtt,
  Param: { 'Fn::Join': ['-', ['t', { Ref: 'Token' }]] },
  Spared: { 'Fn::Join': ['/', [{ 'Fn::GetAtt': ['Cr', 'Secret'] }, 'x']] },
  List: [join, 'literal'],
  Plain: 'plain',
};
const resolved = {
  Joined: 'postgres://u:s3cr3t-value@db',
  Subbed: 'postgres://u:s3cr3t-value@db',
  Bare: 's3cr3t-value',
  Param: 't-tok',
  Spared: 'us-east-1/x',
  List: ['postgres://u:s3cr3t-value@db', 'literal'],
  Plain: 'plain',
};
const persisted = {
  Joined: SECRET_MASK,
  Subbed: SECRET_MASK,
  Bare: SECRET_MASK,
  Param: SECRET_MASK,
  Spared: 'us-east-1/x',
  List: [SECRET_MASK, 'literal'],
  Plain: 'plain',
};
const keys = (coordinates: readonly (readonly (string | number)[])[]): string[] =>
  coordinates.map((c) => JSON.stringify(c)).sort();

describe('noEchoCoordinatesOf: embedded declared attributes (go-to-k/cdkd#7189)', () => {
  it('without the persisted bag, positions only parameters and bare GetAtts (as before)', () => {
    expect(keys(noEchoCoordinatesOf(template, resolved, SOURCES))).toEqual(
      keys([['Bare'], ['Param']])
    );
  });

  it('with it, adds every embedding leaf the bag holds wholly as the mask, and none it spared', () => {
    expect(
      keys(noEchoCoordinatesOf(template, resolved, SOURCES, undefined, { maskedAt: persisted }))
    ).toEqual(keys([['Bare'], ['Param'], ['Joined'], ['Subbed'], ['List', 0]]));
  });

  it('`only` returns the embedding leaves alone', () => {
    expect(
      keys(
        noEchoCoordinatesOf(template, resolved, SOURCES, undefined, {
          maskedAt: persisted,
          only: true,
        })
      )
    ).toEqual(keys([['Joined'], ['Subbed'], ['List', 0]]));
  });

  it('positions nothing new when no attribute is declared, or the mask is only partial', () => {
    expect(
      noEchoCoordinatesOf(template, resolved, { parameters: new Set() }, undefined, {
        maskedAt: persisted,
        only: true,
      })
    ).toEqual([]);
    expect(
      noEchoCoordinatesOf(template, resolved, SOURCES, undefined, {
        maskedAt: { ...persisted, Joined: `postgres://u:${SECRET_MASK}@db`, Subbed: 'x', List: [] },
        only: true,
      })
    ).toEqual([]);
  });

  it('positions a whole list whose elements do not pair, when the bag holds it wholly as the mask', () => {
    const list = { Hosts: [join, { Ref: 'AWS::NoValue' }] };
    const coordinates = (maskedAt: unknown): unknown =>
      noEchoCoordinatesOf(list, { Hosts: ['postgres://u:s3cr3t-value@db'] }, SOURCES, undefined, {
        maskedAt,
        only: true,
      });
    expect(coordinates({ Hosts: [SECRET_MASK] })).toEqual([['Hosts']]);
    expect(coordinates({ Hosts: ['postgres://u:s3cr3t-value@db'] })).toEqual([]);
  });

  it('follows Fn::If (known and unknown verdict) and Fn::Select to the embedding leaf', () => {
    const conditional: NoEchoPositionSources = { ...SOURCES, conditions: { On: true } };
    const shapes = {
      KnownIf: { 'Fn::If': ['On', join, 'plain'] },
      KnownIfLiteral: { 'Fn::If': ['On', 'plain', join] },
      UnknownIf: { 'Fn::If': ['Unknown', join, 'plain'] },
      Select: { 'Fn::Select': [0, [join, 'plain']] },
      SelectByRef: { 'Fn::Select': [{ Ref: 'Index' }, [join, 'plain']] },
    };
    const bag = Object.fromEntries(Object.keys(shapes).map((key) => [key, 'x']));
    const masked = Object.fromEntries(Object.keys(shapes).map((key) => [key, SECRET_MASK]));
    expect(
      keys(
        noEchoCoordinatesOf(shapes, bag, conditional, undefined, { maskedAt: masked, only: true })
      )
    ).toEqual(keys([['KnownIf'], ['UnknownIf'], ['Select'], ['SelectByRef']]));
  });

  it('does not position an embedding leaf masked for a reason that reads no declared attribute', () => {
    expect(
      noEchoCoordinatesOf({ Other: { 'Fn::Join': ['', ['a', { 'Fn::GetAtt': ['Cr', 'Public'] }]] } }, {
        Other: 'a-public',
      }, SOURCES, undefined, { maskedAt: { Other: SECRET_MASK }, only: true })
    ).toEqual([]);
  });
});
