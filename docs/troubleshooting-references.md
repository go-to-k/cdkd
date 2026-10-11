---
title: References cdkd cannot resolve
description: "Fix cdkd errors about an unsupported intrinsic function, a secret reference it refuses to resolve, or an Fn::GetAtt with no recorded value."
---

# References cdkd cannot resolve

A template refers to other values with intrinsic functions (`Ref`, `Fn::GetAtt`, `Fn::Sub`) and with `{{resolve:...}}` references to Secrets Manager and SSM. cdkd resolves these itself during a deploy. The entries here are the cases where it cannot, or refuses to.

On this page:

- ["Unresolved intrinsic function" Error](#unresolved-intrinsic-function-error)
- ["Refusing to resolve" a reference whose service cdkd does not resolve](#refusing-to-resolve-a-reference-whose-service-cdkd-does-not-resolve)
- ["Refusing to resolve" a reference whose name was built from a secret](#refusing-to-resolve-a-reference-whose-name-was-built-from-a-secret)
- ["Cannot resolve" a GetAtt on a resource an older cdkd deployed](#cannot-resolve-a-getatt-on-a-resource-an-older-cdkd-deployed)

## "Unresolved intrinsic function" Error

```
ProvisioningError: Failed to create resource MyResource
Caused by: Unsupported CloudFormation intrinsic function "Fn::ToJsonString": cdkd does not support resolving it yet. Deploying this template would produce a broken value. Please request support by opening an issue: https://github.com/go-to-k/cdkd/issues/new?title=Support%20intrinsic%20Fn%3A%3AToJsonString&labels=intrinsic-support
```

The template uses a CloudFormation intrinsic function that cdkd does not
resolve. The error appears when the resource is provisioned. `cdkd diff` does
not show it, because diff leaves anything it cannot resolve as written.

cdkd resolves `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`,
`Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`,
`Fn::ImportValue`, `Fn::GetStackOutput` (cdkd-specific), `Fn::FindInMap`,
`Fn::GetAZs`, `Fn::Base64`, `Fn::Cidr` and `Fn::Transform`.

- **The intrinsic is not in that list** (`Fn::ToJsonString` and `Fn::ForEach`
  are the likely ones): use the link in the message to request it. No flag
  works around it.
- **It is in the list**: the installed cdkd predates its support. Upgrade:

<pm>
npm i -g @go-to-k/cdkd
</pm>

## "Refusing to resolve" a reference whose service cdkd does not resolve

```
Refusing to resolve {{resolve:***}}: its service is not one cdkd resolves (secretsmanager, ssm, ssm-secure), and the reference was assembled from a secret value, so leaving it as written would send that value to AWS and record it in state in the clear.
```

An `Fn::Sub` or `Fn::Join` builds a `{{resolve:...}}` token around a value
that is itself a resolved secret, and the secret lands where the service name
goes:

```yaml
Value:
  Fn::Sub:
    - '{{resolve:${Pw}}}'
    - Pw: '{{resolve:secretsmanager:MySecret:SecretString:password}}'
```

Normally cdkd leaves a `{{resolve:...}}` reference to a service it does not
know exactly as written. Here the text of the reference contains the secret,
so leaving it as written would send the secret to AWS and write it to
`state.json`. cdkd refuses instead.

Reference the secret directly, or spell the service literally and substitute
only the name:
`{{resolve:secretsmanager:${SecretName}:SecretString:password}}`.

### Where the refusal shows up

| Position | Result |
| --- | --- |
| A resource property | The resource fails before its provider is called, and the deploy rolls back |
| A stack Output | The deploy warns `Failed to resolve output <name>: ...`, skips the output and exits 0 |
| A stack Output under `--strict-getatt` | The deploy fails |

### If such a value was already deployed

If a template like this was deployed before, the secret may be stored in AWS
and in the stack's state record. Clean up in this order:

1. Deploy the corrected template, so AWS stops holding the secret.
2. Run [`cdkd scrub`](cli-scrub.md), which replaces the secret inside the
   stored `{{resolve:...}}` text with its reference.
3. Rotate the secret.

The order matters. If you scrub first, the state record holds text that no
service can resolve, while AWS still holds the old value. `cdkd drift` then
skips that property, and a `cdkd rollback` or `cdkd drift --revert` that
touches the resource writes the unresolvable text to it.

When another stack imports the value, scrub the stack that exports it before
you deploy the stack that imports it. The importing stack reads the stored
output exactly as written.

## "Refusing to resolve" a reference whose name was built from a secret

```
Refusing to resolve {{resolve:ssm:/app/***}}: the reference was assembled from a secret value and resolves to a secret, so recording it would write that value into state inside the reference. Build the reference name from non-secret values.
```

An `Fn::Sub` or `Fn::Join` puts a secret value into a `secretsmanager`, `ssm`
or `ssm-secure` reference (its name, a JSON key, a version stage), and the
reference itself resolves to a secret:

```yaml
Value:
  Fn::Sub:
    - '{{resolve:ssm:/app/${Name}}}'
    - Name: '{{resolve:secretsmanager:MySecret:SecretString:name}}'
```

To keep secrets out of `state.json`, cdkd stores the reference in place of
the secret value it resolved to. Here the reference itself contains the other
secret, so storing the reference would write that secret into state.

Build the reference name from values that are not secrets: a literal, or a
plain parameter.

### The message masks the whole reference

A second form of the message reads `Refusing to resolve ***: ...`. It appears
when a secret's whole value is itself `{{resolve:...}}` text. An example is an
`ssm` parameter that holds `{{resolve:ssm:/app/pin}}` and is used through
`Fn::Sub`: cdkd would resolve that text a second time. Write the reference to
the target in the template, and do not store `{{resolve:...}}` text as a
secret's value.

### What is and is not refused

| Reference | Result |
| --- | --- |
| `secretsmanager` or `ssm-secure`, name built from a secret | Refused before any lookup, so the name is never sent to AWS |
| `ssm`, resolves to a `SecureString` | Looked up, then refused |
| `ssm`, resolves to a `String` or `StringList`, or to nothing | Resolved |
| `ssm`, lookup fails | Reports the lookup's own error, with the name masked |
| A name that literally spells a secret of 4+ characters a parent stack passed in as a decrypted parameter | Refused |

Three related behaviours:

- Two references to one secret in the same stack both resolve, even when the
  first one's value also appears in the second one's literal text.
- `cdkd drift` and a rollback read what state already holds, so they are not
  refused.
- `cdkd import` warns `Failed to resolve intrinsics in Properties for imported
  resource '<id>' ...` with this message, and records that resource's
  properties as the template wrote them.

### If such a template was already deployed

The state record can hold the other secret inside the stored reference.
[`cdkd scrub`](cli-scrub.md) does not remove it. Deploy the corrected
template, which rewrites the record, and rotate the secret.

## "Cannot resolve" a GetAtt on a resource an older cdkd deployed

```
Cannot resolve Fn::GetAtt [MyParam, Arn] for AWS::SSM::Parameter: the state
record holds no value for it, and the physical ID fallback "/app/config" is not
an ARN (arn:...). ... cdkd tried to re-read the attributes from AWS to heal the
record, but the provider read failed (AccessDeniedException, HTTP 403); re-run
with --verbose for the AWS error text.
```

cdkd answers an `Fn::GetAtt` from the attributes it recorded in state when
the resource was created or last updated. A state record can lack an
attribute for three reasons:

- An older cdkd release wrote the record before cdkd recorded that attribute.
  Examples are `Arn` on `AWS::SSM::Parameter` and `DBSubnetGroupArn` on
  `AWS::RDS::DBSubnetGroup`.
- AWS had not assigned the value when the record was written. Examples are
  `Endpoint.Address` and `Endpoint.Port` of a `DBInstance` created with
  `--no-wait`.
- An old release stored a wildcard placeholder in place of the ARN of an
  `AWS::AppSync::*` child resource.

Usually you never notice. When `cdkd deploy` meets such a reference, it reads
the resource's attributes from AWS once, uses the value and adds it to the
record. The resource itself is not updated.

The error above appears only when that read could not help, and the message
says why:

| The message says | Meaning | Fix |
| --- | --- | --- |
| `the provider read failed (<ErrorClass>, HTTP <n>)` | The read was denied, throttled or failed | Grant the read permission (or retry) and deploy again |
| `AWS reports no resource behind the recorded physical id` | The resource was deleted outside cdkd | Check with `cdkd drift`, then re-create it or remove it from state |
| `cdkd re-read the resource ... reports none by that name` | The resource type does not supply this attribute | Avoid the `Fn::GetAtt`, or file an issue |
| `re-read the resource through Cloud Control, but withheld the value` | The value came back masked, so cdkd would not use it | Grant the deploy role `cloudformation:DescribeType` and deploy again |

For the last row, if the role already has the permission, the name you asked
for is a writable property and not an attribute. Reference the template's own
value.

Two other ways rewrite the record: change any property of the resource, or
import the resource again with `cdkd import`.

`--verbose` prints the AWS error text. cdkd leaves it out by default because
a denied call quotes the caller's account, role and session.

### How the other commands treat the same record

| Command | Behaviour |
| --- | --- |
| `cdkd deploy --dry-run` | Re-reads, records nothing |
| `cdkd diff` | Re-reads and previews the value, never writes it; its message starts `This preview re-read the attributes from AWS, but ...` |
| `cdkd drift`, `cdkd export` | Never re-read; report an `*Arn` / `*Url` reference as unresolved, and resolve any other attribute to the physical ID with a warning |

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
