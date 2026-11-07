/**
 * The security diff's model: template equality and normalization, IAM
 * statements, managed-policy attachments, IAM Identity Center elements,
 * security-group rules, and the old/new collections they are diffed in.
 * Split out of `../security-changes.ts` (#5835).
 */

import { type PropertyScrutiny, type ResourceScrutiny } from './scrutiny.js';

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One resource of a template: what the security diff reads. */
export interface SecurityTemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SecurityTemplate {
  Resources: Record<string, SecurityTemplateResource>;
}

// ---------------------------------------------------------------------------
// Equality

/** Plain structural equality (`fast-deep-equal` over JSON values). */
function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return a !== a && b !== b; // NaN
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    return a.length === bArr.length && a.every((v, i) => strictEqual(v, bArr[i]));
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (k) =>
      Object.hasOwn(b, k) &&
      strictEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/**
 * CloudFormation's equality: a string equals a boolean or number with the same
 * text, and `DependsOn` compares order-free.
 */
function cfnEqual(lvalue: Json, rvalue: Json): boolean {
  if (lvalue === rvalue) return true;
  if (
    ((typeof lvalue === 'string' && typeof rvalue === 'boolean') ||
      (typeof lvalue === 'boolean' && typeof rvalue === 'string')) &&
    lvalue.toString() === rvalue.toString()
  ) {
    return true;
  }
  if (
    (typeof lvalue === 'string' || typeof rvalue === 'string') &&
    Number(lvalue) === Number(rvalue)
  ) {
    return true;
  }
  if (typeof lvalue !== typeof rvalue) return false;
  if (Array.isArray(lvalue) !== Array.isArray(rvalue)) return false;
  if (Array.isArray(lvalue)) {
    if (lvalue.length !== rvalue.length) return false;
    for (let i = 0; i < lvalue.length; i++) {
      if (!cfnEqual(lvalue[i], rvalue[i])) return false;
    }
    return true;
  }
  if (typeof lvalue === 'object') {
    if (lvalue === null || rvalue === null) return false;
    const keys = Object.keys(lvalue);
    if (keys.length !== Object.keys(rvalue).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(rvalue, key)) return false;
      if (key === 'DependsOn') {
        if (!dependsOnEqual(lvalue[key], rvalue[key])) return false;
        continue;
      }
      if (!cfnEqual(lvalue[key], rvalue[key])) return false;
    }
    return true;
  }
  return false;
}

function dependsOnEqual(lvalue: Json, rvalue: Json): boolean {
  if (Array.isArray(lvalue) !== Array.isArray(rvalue)) {
    const array = Array.isArray(lvalue) ? lvalue : rvalue;
    const nonArray = Array.isArray(lvalue) ? rvalue : lvalue;
    return array.length === 1 && cfnEqual(array[0], nonArray);
  }
  if (Array.isArray(lvalue) && Array.isArray(rvalue)) {
    if (lvalue.length !== rvalue.length) return false;
    // As the AWS CDK CLI's loop: each element is compared with the FIRST of
    // `rvalue`, and only a one-element list can differ.
    for (let i = 0; i < lvalue.length; i++) {
      if (!cfnEqual(lvalue[i], rvalue[0]) && lvalue.length === 1) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Template normalization and intrinsic rendering

/** `Fn::GetAtt: 'A.B'` to `['A', 'B']`, a `DependsOn` to a sorted list. In place. */
export function normalize(template: Json): void {
  if (typeof template !== 'object' || template === null) return;
  for (const key of Object.keys(template)) {
    if (key === 'Fn::GetAtt' && typeof template[key] === 'string') {
      template[key] = template[key].split('.');
      continue;
    } else if (key === 'DependsOn') {
      if (typeof template[key] === 'string') template[key] = [template[key]];
      else if (Array.isArray(template[key])) {
        template[key] = template[key].sort((x: Json, y: Json) =>
          String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
        );
      }
      continue;
    }
    if (Array.isArray(template[key])) {
      for (const element of template[key]) normalize(element);
    } else {
      normalize(template[key]);
    }
  }
}

function getIntrinsic(x: Json): { fn: string; args: Json } | undefined {
  if (x === undefined || x === null || Array.isArray(x) || typeof x !== 'object') return undefined;
  const keys = Object.keys(x);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'))
    ? { fn: keys[0]!, args: x[keys[0]!] }
    : undefined;
}

function isNoValue(x: Json): boolean {
  const intrinsic = getIntrinsic(x);
  return intrinsic !== undefined && intrinsic.fn === 'Ref' && intrinsic.args === 'AWS::NoValue';
}

/**
 * An intrinsic as text a reader understands: `Ref` and `Fn::GetAtt` as
 * `${Id}` / `${Id.Attr}`, an `Fn::Join` over a literal list joined, anything
 * else as its JSON; `AWS::NoValue` entries dropped.
 */
export function renderIntrinsics(x: Json): Json {
  if (Array.isArray(x)) return x.filter((el) => !isNoValue(el)).map(renderIntrinsics);
  if (isNoValue(x)) return undefined;
  const intrinsic = getIntrinsic(x);
  if (intrinsic !== undefined) {
    if (intrinsic.fn === 'Ref') return '${' + intrinsic.args + '}';
    if (intrinsic.fn === 'Fn::GetAtt') {
      return '${' + intrinsic.args[0] + '.' + intrinsic.args[1] + '}';
    }
    if (intrinsic.fn === 'Fn::Join') {
      const [separator, args] = intrinsic.args;
      if (Array.isArray(args)) {
        return args
          .filter((el) => !isNoValue(el))
          .map(renderIntrinsics)
          .join(separator);
      }
      return JSON.stringify({ 'Fn::Join': renderIntrinsics([separator, args]) });
    }
    return JSON.stringify({ [intrinsic.fn]: renderIntrinsics(intrinsic.args) });
  }
  if (typeof x === 'object' && x !== null) {
    const ret: Record<string, Json> = {};
    for (const [key, value] of Object.entries(x)) {
      if (!isNoValue(value)) ret[key] = renderIntrinsics(value);
    }
    return ret;
  }
  return x;
}

// ---------------------------------------------------------------------------
// IAM statements

class Targets {
  readonly values: string[];
  readonly not: boolean;

  constructor(statement: Json, positiveKey: string, negativeKey: string) {
    if (negativeKey in statement) {
      this.values = forceListOfStrings(statement[negativeKey]);
      this.not = true;
    } else {
      this.values = forceListOfStrings(statement[positiveKey]);
      this.not = false;
    }
    this.values.sort();
  }

  get empty(): boolean {
    return this.values.length === 0;
  }

  equal(other: Targets): boolean {
    return this.not === other.not && strictEqual(this.values.sort(), other.values.sort());
  }

  replaceEmpty(replacement: string): void {
    if (this.empty) this.values.push(replacement);
  }

  replaceStar(replacement: string): void {
    for (let i = 0; i < this.values.length; i++) {
      if (this.values[i] === '*') this.values[i] = replacement;
    }
    this.values.sort();
  }

  render(): string {
    return this.not ? this.values.map((s) => `NOT ${s}`).join('\n') : this.values.join('\n');
  }
}

function forceListOfStrings(x: Json): string[] {
  if (typeof x === 'string') return [x];
  if (x === undefined || x === null) return [];
  if (Array.isArray(x)) return x.map((e) => forceListOfStrings(e).join(','));
  if (typeof x === 'object') {
    const ret: string[] = [];
    for (const [key, value] of Object.entries(x)) {
      ret.push(...forceListOfStrings(value).map((s) => `${key}:${s}`));
    }
    return ret;
  }
  return [`${x}`];
}

export class Statement {
  readonly sid: string | undefined;
  readonly effect: 'Allow' | 'Deny' | 'Unknown';
  readonly resources: Targets;
  readonly actions: Targets;
  readonly principals: Targets;
  readonly condition: Json;
  readonly serializedIntrinsic: string | undefined;

  constructor(statement: Json) {
    if (typeof statement === 'string') {
      this.sid = undefined;
      this.effect = 'Unknown';
      this.resources = new Targets({}, '', '');
      this.actions = new Targets({}, '', '');
      this.principals = new Targets({}, '', '');
      this.condition = undefined;
      this.serializedIntrinsic = statement;
    } else {
      // The AWS CDK CLI throws here too (`in` on a non-object), and the gate
      // fails closed on it; this message names no value, as one may be secret.
      if (typeof statement !== 'object' || statement === null) {
        throw new Error('An IAM policy statement is neither an object nor a string');
      }
      this.sid = typeof statement.Sid === 'string' ? statement.Sid : undefined;
      this.effect =
        statement.Effect === 'Allow' || statement.Effect === 'Deny' ? statement.Effect : 'Unknown';
      this.resources = new Targets(statement, 'Resource', 'NotResource');
      this.actions = new Targets(statement, 'Action', 'NotAction');
      this.principals = new Targets(statement, 'Principal', 'NotPrincipal');
      this.condition = statement.Condition;
      this.serializedIntrinsic = undefined;
    }
  }

  equal(other: Statement): boolean {
    return (
      this.sid === other.sid &&
      this.effect === other.effect &&
      this.serializedIntrinsic === other.serializedIntrinsic &&
      this.resources.equal(other.resources) &&
      this.actions.equal(other.actions) &&
      this.principals.equal(other.principals) &&
      strictEqual(this.condition, other.condition)
    );
  }

  /** Allow with a `Not*` target, or Deny without one. */
  get isNegativeStatement(): boolean {
    const notTarget = this.actions.not || this.principals.not || this.resources.not;
    return this.effect === 'Allow' ? notTarget : !notTarget;
  }

  render(): string[] {
    return this.serializedIntrinsic
      ? [this.serializedIntrinsic, '', '', this.principals.render(), '']
      : [
          this.resources.render(),
          this.effect,
          this.actions.render(),
          this.principals.render(),
          renderCondition(this.condition),
        ];
  }
}

export function parseStatements(x: Json): Statement[] {
  if (x === undefined) x = [];
  if (!Array.isArray(x)) x = [x];
  return x.map((s: Json) => new Statement(s));
}

/** The statement Lambda adds to a function's policy for an `AWS::Lambda::Permission`. */
export function parseLambdaPermission(x: Json): Statement {
  const statement: Json = { Effect: 'Allow', Action: x.Action, Resource: x.FunctionName };
  if (x.Principal !== undefined) {
    if (x.Principal === '*') statement.Principal = '*';
    else if (/^\d{12}$/.test(x.Principal)) {
      statement.Principal = { AWS: `arn:aws:iam::${x.Principal}:root` };
    } else statement.Principal = { Service: x.Principal };
  }
  if (x.SourceArn !== undefined) {
    statement.Condition ??= {};
    statement.Condition.ArnLike = { 'AWS:SourceArn': x.SourceArn };
  }
  if (x.SourceAccount !== undefined) {
    statement.Condition ??= {};
    statement.Condition.StringEquals = { 'AWS:SourceAccount': x.SourceAccount };
  }
  if (x.EventSourceToken !== undefined) {
    statement.Condition ??= {};
    statement.Condition.StringEquals = { 'lambda:EventSourceToken': x.EventSourceToken };
  }
  return new Statement(statement);
}

/** The Condition column: the JSON without its outer braces and indent. */
function renderCondition(condition: Json): string {
  if (!condition || Object.keys(condition).length === 0) return '';
  const lines = JSON.stringify(condition, undefined, 2).split('\n');
  return lines
    .slice(1, lines.length - 1)
    .map((s) => s.slice(2))
    .join('\n');
}

export function defaultPrincipal(principal: string, statements: Statement[]): Statement[] {
  statements.forEach((s) => s.principals.replaceEmpty(principal));
  statements.forEach((s) => s.principals.replaceStar(principal));
  return statements;
}

export function defaultResource(resource: string, statements: Statement[]): Statement[] {
  statements.forEach((s) => s.resources.replaceEmpty(resource));
  statements.forEach((s) => s.resources.replaceStar(resource));
  return statements;
}

export class ManagedPolicyAttachment {
  readonly identityArn: string;
  readonly managedPolicyArn: string;

  constructor(identityArn: string, managedPolicyArn: string) {
    this.identityArn = identityArn;
    this.managedPolicyArn = managedPolicyArn;
  }

  equal(other: ManagedPolicyAttachment): boolean {
    return (
      this.identityArn === other.identityArn && this.managedPolicyArn === other.managedPolicyArn
    );
  }
}

/** An IAM Identity Center element, compared field by field. */
export class SsoElement {
  readonly fields: Json;

  constructor(fields: Json) {
    this.fields = fields;
  }

  equal(other: SsoElement): boolean {
    return strictEqual(this.fields, other.fields);
  }
}

// ---------------------------------------------------------------------------
// Security groups

type Peer =
  | { kind: 'cidr-ip'; ip: Json }
  | { kind: 'security-group'; securityGroupId: Json }
  | { kind: 'prefix-list'; prefixListId: Json };

export class SecurityGroupRule {
  readonly ipProtocol: string;
  readonly fromPort: Json;
  readonly toPort: Json;
  readonly groupId: Json;
  readonly peer: Peer | undefined;

  constructor(rule: Json, groupRef?: string) {
    this.ipProtocol = rule.IpProtocol?.toString() || '*unknown*';
    this.fromPort = rule.FromPort;
    this.toPort = rule.ToPort;
    this.groupId = rule.GroupId || groupRef || '*unknown*';
    this.peer =
      findFirst(rule, ['CidrIp', 'CidrIpv6'], (ip) => ({ kind: 'cidr-ip', ip })) ||
      findFirst(rule, ['DestinationSecurityGroupId', 'SourceSecurityGroupId'], (id) => ({
        kind: 'security-group',
        securityGroupId: id,
      })) ||
      findFirst(rule, ['DestinationPrefixListId', 'SourcePrefixListId'], (id) => ({
        kind: 'prefix-list',
        prefixListId: id,
      }));
  }

  equal(other: SecurityGroupRule): boolean {
    return (
      this.groupId === other.groupId &&
      this.ipProtocol === other.ipProtocol &&
      this.fromPort === other.fromPort &&
      this.toPort === other.toPort &&
      peerEqual(this.peer, other.peer)
    );
  }

  describeProtocol(): string {
    if (this.ipProtocol === '-1') return 'Everything';
    const ipProtocol = this.ipProtocol.toUpperCase();
    if (this.fromPort === -1) return `All ${ipProtocol}`;
    if (this.fromPort === this.toPort) return `${ipProtocol} ${this.fromPort}`;
    return `${ipProtocol} ${this.fromPort}-${this.toPort}`;
  }

  describePeer(): string {
    switch (this.peer?.kind) {
      case 'cidr-ip':
        if (this.peer.ip === '0.0.0.0/0') return 'Everyone (IPv4)';
        if (this.peer.ip === '::/0') return 'Everyone (IPv6)';
        return `${this.peer.ip}`;
      case 'prefix-list':
        return `${this.peer.prefixListId}`;
      case 'security-group':
        return `${this.peer.securityGroupId}`;
      default:
        return '?';
    }
  }
}

function peerEqual(a: Peer | undefined, b: Peer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'cidr-ip' && b.kind === 'cidr-ip') return a.ip === b.ip;
  if (a.kind === 'security-group' && b.kind === 'security-group') {
    return a.securityGroupId === b.securityGroupId;
  }
  if (a.kind === 'prefix-list' && b.kind === 'prefix-list')
    return a.prefixListId === b.prefixListId;
  return false;
}

function findFirst(obj: Json, keys: string[], fn: (value: Json) => Peer): Peer | undefined {
  for (const key of keys) {
    try {
      if (key in obj) return fn(obj[key]);
    } catch {
      // A value `in` cannot inspect has no peer.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Old/new collections

interface Equatable<T> {
  equal(other: T): boolean;
}

export class DiffableCollection<T extends Equatable<T>> {
  readonly additions: T[] = [];
  readonly removals: T[] = [];
  private readonly oldElements: T[] = [];
  private readonly newElements: T[] = [];

  addOld(...elements: T[]): void {
    this.oldElements.push(...elements);
  }

  addNew(...elements: T[]): void {
    this.newElements.push(...elements);
  }

  calculateDiff(): void {
    const contains = (x: T, xs: T[]): boolean => xs.some((y) => y.equal(x));
    this.additions.push(...this.newElements.filter((x) => !contains(x, this.oldElements)));
    this.removals.push(...this.oldElements.filter((x) => !contains(x, this.newElements)));
  }

  get hasChanges(): boolean {
    return this.additions.length + this.removals.length > 0;
  }

  get hasAdditions(): boolean {
    return this.additions.length > 0;
  }
}

// ---------------------------------------------------------------------------
// The template diff

export interface ResourceDiff {
  oldValue: SecurityTemplateResource | undefined;
  newValue: SecurityTemplateResource | undefined;
}

export interface PropertyChange {
  logicalId: string;
  resourceType: string;
  scrutiny: PropertyScrutiny;
  oldValue: Json;
  newValue: Json;
}

export interface ResourceScrutinyChange {
  logicalId: string;
  scrutiny: ResourceScrutiny;
  oldProperties: Json;
  newProperties: Json;
}

/**
 * Did a resource change at all: its type, any property, or any other key, each
 * by CloudFormation's equality. A key absent on both sides is no change.
 */
export function resourceDiffers(oldValue: Json, newValue: Json): boolean {
  if (oldValue === undefined || newValue === undefined) return true;
  if (oldValue.Type !== newValue.Type) return true;
  const keyDiffers = (a: Json, b: Json, skip?: string): boolean =>
    [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].some((key) => {
      if (key === skip) return false;
      const x = a?.[key];
      const y = b?.[key];
      return !(x === undefined && y === undefined) && !cfnEqual(x, y);
    });
  return (
    keyDiffers(oldValue.Properties, newValue.Properties) ||
    keyDiffers(oldValue, newValue, 'Properties')
  );
}
