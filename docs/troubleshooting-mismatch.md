---
title: A deploy succeeds but AWS does not match the template
description: "Find why a property you set never reached AWS, or why removing one changed nothing, after a cdkd deploy that reported success."
---

# A deploy succeeds but AWS does not match the template

The deploy reported success, but the live resource is not what the template declares. Each entry here explains one way that happens and how to get the property applied.

On this page:

- [A property you set in the template never reaches AWS](#a-property-you-set-in-the-template-never-reaches-aws)
- [`cdkd diff` shows `[returning to SDK provider]`](#cdkd-diff-shows-returning-to-sdk-provider)
- [deleting a Cognito `Policies` sub-key changes nothing on the pool](#deleting-a-cognito-policies-sub-key-changes-nothing-on-the-pool)

## A property you set in the template never reaches AWS

The deploy succeeds and `cdkd diff` reports the change, but the field is
absent from the live resource.

cdkd provisions most resources through its own SDK providers, and a provider
sends only the properties it knows. To avoid dropping the others, cdkd looks
at the template first. If a resource carries a top-level property its
provider does not send, cdkd provisions that resource through the Cloud
Control API, which forwards every property. The deploy says so:

```
MyAlarm (AWS::CloudWatch::Alarm): routing via Cloud Control API (cdkd's SDK Provider does not yet wire EvaluationWindow — CC API will forward the full property map. Override via --prefer-sdk-route AWS::CloudWatch::Alarm:EvaluationWindow.)
```

A missing field therefore means the resource stayed on the SDK provider.
Check which of the two handled it:

```bash
cdkd state show MyStack    # ProvisionedBy: sdk | cc-api
```

`cc-api` means Cloud Control forwarded every property, so cdkd did not drop
the field. `sdk` means one of three things.

### You passed `--prefer-sdk-route`

`--prefer-sdk-route <Type>:<Prop>` keeps the resource on the SDK provider and
accepts that the property is dropped. Stop passing the flag. The next deploy
sends the resource through Cloud Control and applies the property.

### cdkd's bundled schema does not know the property

This applies when the resource already carries the property with the same
value. cdkd warns about it on the deploy. Change the value so that the next
deploy sends the resource through Cloud Control, or pass
`--recreate-via-cc-api <LogicalId>`.

### The property is nested

cdkd checks top-level properties only. A missing nested key is a different
problem, and this entry does not explain it.

### Edge cases

- A read-only property never sends a resource to Cloud Control, and neither
  does a property on a type Cloud Control cannot manage.
- You do not need `--recreate-via-cc-api` because a deployed resource gained
  a property its provider does not send. The next deploy sends the resource
  through Cloud Control and normally applies the property in place.

### `CREATE_ONLY_DROP_NEEDS_REPLACEMENT`

When you stop passing `--prefer-sdk-route`, cdkd refuses the deploy with this
code if the property is create-only. A create-only property can be set only
when the resource is created, so applying it to a live resource needs a
replacement. The refusal names the remedies:

| Remedy | Effect |
| --- | --- |
| `--recreate-via-cc-api <LogicalId>` or `--replace` | Replaces the resource with the property applied; inside a nested stack only `--replace` reaches it |
| `--force-stateful-recreation` | Also required when the type is stateful |
| `--prefer-sdk-route` with the list the refusal prints | Keeps dropping the property; the list can name more than your original flag did |

[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md) says what each
remedy costs, and [Provisioning Layers](provisioning-layers.md) how to choose a
flag.

## `cdkd diff` shows `[returning to SDK provider]`

```
  [~] MyTopic (AWS::SNS::Topic) [returning to SDK provider]
```

The resource was deployed through the Cloud Control API, and cdkd's SDK
provider now covers every property it uses. The next deploy that changes the
resource moves it back to the SDK provider, which is faster. The move is an
update in place. The resource keeps its physical id, so references to it
still work. The deploy names the move:

```
MyTopic (AWS::SNS::Topic): returning to the SDK provider — cdkd now covers every property this resource uses. The physical id is preserved; pass --pin-cc-api MyTopic to decline this for a deploy.
```

Usually there is nothing to do. To keep the resource on Cloud Control for one
deploy, for example while investigating something else:

```bash
cdkd deploy MyStack --pin-cc-api MyTopic
```

The flag applies to that deploy only.

One exception: a resource of a type Cloud Control cannot manage correctly
moves back whatever you pass. cdkd logs a different line for it and ignores
`--pin-cc-api`. See [Provisioning Layers](provisioning-layers.md).

## deleting a Cognito `Policies` sub-key changes nothing on the pool

You remove `Policies.SignInPolicy` from an `AWS::Cognito::UserPool`, typically
to revoke a passwordless first-auth factor such as `EMAIL_OTP`. The deploy
succeeds, but the pool still allows it, and `cdkd drift` and `cdkd diff` report
nothing. The same happens for `Policies.PasswordPolicy` and for deleting the
whole `Policies` block.

The only signal is a warning on the deploy that carries the removal. It
begins:

```text
UserPool us-east-1_xxxxxxxxx: the desired configuration no longer declares
Policies.SignInPolicy, and no UpdateUserPool input can express that removal
```

The Cognito `UpdateUserPool` API reads a missing `Policies` sub-key as "keep
the live value", and no input to it expresses a removal. CloudFormation
behaves the same on the same edit.

`cdkd drift` is silent because of what it compares against. After a deploy,
cdkd records the pool's live configuration, and drift compares later reads
with that record. The live pool still holds the sub-key, so the two agree.

Declare the sub-key with the configuration you want instead of deleting it:

```yaml
Policies:
  SignInPolicy:
    AllowedFirstAuthFactors:
      - PASSWORD          # revokes EMAIL_OTP by stating the intended set
```

The AWS defaults are `AllowedFirstAuthFactors: [PASSWORD]` for `SignInPolicy`.
For `PasswordPolicy` they are `MinimumLength: 8`, every character-class
requirement enabled, and `TemporaryPasswordValidityDays: 7`.

### A related refusal when the same edit turns MFA on

Suppose the same edit sets `MfaConfiguration: ON` while the list the pool
kept still allows `EMAIL_OTP` or `SMS_OTP`. cdkd then refuses the deploy
before it sends any change, with a message that names the pool's live
`AllowedFirstAuthFactors`. `WEB_AUTHN` is refused the same way unless
`WebAuthnFactorConfiguration` is `MULTI_FACTOR_WITH_USER_VERIFICATION`. The
fix is the same explicit declaration.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
