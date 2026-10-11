---
title: REST v1 integrations in cdkd local start-api
description: "How cdkd local start-api emulates REST API MOCK, HTTP_PROXY, HTTP and non-proxy Lambda integrations, and which parts of API Gateway's VTL mapping templates it supports."
---

# REST v1 integrations in cdkd local start-api

[`cdkd local start-api`](local-start-api.md) serves a Lambda proxy
integration (`AWS_PROXY`) by invoking the Lambda. This page covers the other
four integration types of a REST v1 API. cdkd emulates each of them,
including their mapping templates.

| Type | What the server does |
| --- | --- |
| `MOCK` | Answers from the templates alone. No upstream call. |
| `HTTP_PROXY` | Forwards the request to `Integration.Uri` with the body unchanged. |
| `HTTP` | As `HTTP_PROXY`, with VTL templates applied to the request and the response. |
| `AWS` (Lambda) | Builds the Lambda event from a VTL template and transforms the return value. |

An `AWS` integration that targets a service other than Lambda returns 501. So
does an `HTTP` or `HTTP_PROXY` integration whose `Uri` is not a literal
string.

## `MOCK`

A `MOCK` integration returns a response without calling anything. For
example:

```ts
resource.addMethod('GET', new apigateway.MockIntegration({
  requestTemplates: { 'application/json': '{"statusCode": 200}' },
  integrationResponses: [{
    statusCode: '200',
    responseTemplates: { 'application/json': '{"status": "ok"}' },
  }],
}), { methodResponses: [{ statusCode: '200' }] });
```

cdkd answers a request to that method in two steps:

1. It renders the request template, `RequestTemplates['application/json']`,
   which yields `{"statusCode": N}`.
2. That status selects the `IntegrationResponses` entry, and cdkd renders the
   entry's response template as the body.

When the method has no request template, cdkd uses the
`IntegrationResponses` entry that has no `SelectionPattern`.

Literal `ResponseParameters` headers are applied to the response. A header
whose value is a mapping expression (`integration.response.*`, `context.*`)
is skipped with a warning.

## `HTTP_PROXY` and `HTTP`

Both types send the request to an HTTP endpoint. cdkd sends it to
`Integration.Uri`, fills `{param}` placeholders in the URI from the request
path, and uses the method in `IntegrationHttpMethod`.

The upstream status code selects the response. cdkd matches the status, as a
string, against each `SelectionPattern`.

`HTTP_PROXY` forwards the request body unchanged. `HTTP` also renders two
templates:

- `RequestTemplates[<content-type>]` over the outgoing body,
- `ResponseTemplates[<content-type>]` over the upstream body.

### `RequestParameters`

cdkd supports a `RequestParameters` entry that sets a header, from either a
`'literal'` value or `method.request.header.X`. It does not support an entry
that maps a query string or path parameter. Put `{param}` in the URI for
those.

### Edge case: a URI that points inside your network

At boot, cdkd warns once per URI when an integration URI points at the EC2
instance metadata service, a loopback address, a link-local address or a
private (RFC 1918) range. The request is not blocked.

## `AWS` (Lambda non-proxy)

A non-proxy Lambda integration builds the Lambda event from a mapping
template, where a proxy integration would pass the whole request.

cdkd renders the request template to build the event. When the rendered text
is valid JSON, the event is the parsed JSON. Otherwise the event is the text
as a string.

The response template then runs with `$inputRoot` set to the Lambda's return
value.

When the Lambda returns an error (`{errorMessage, errorType?, stackTrace?}`),
cdkd selects the response by matching each `SelectionPattern` against
`errorMessage`.

## VTL support

Mapping templates are written in VTL, the Velocity Template Language. cdkd
implements the part of API Gateway's VTL listed here:

| Area | Supported |
| --- | --- |
| Variables | `$var`, `${var}`, `$obj.field.subField` |
| Request input | `$input.body`, `$input.json('$.path')`, `$input.path('$.path')`, `$input.params()`, `$input.params('name')`, `$input.params('header').<name>` (also `.querystring`, `.path`) |
| Context | `$context.requestId`, `httpMethod`, `resourcePath`, `stage`, `$context.identity.sourceIp`, `userAgent` |
| Utilities | `$util.escapeJavaScript`, `base64Encode`, `base64Decode`, `urlEncode`, `urlDecode`, `parseJson` |
| Directives | `#set`, `#if` / `#elseif` / `#else` / `#end`, `#foreach` / `#end`, `##` comments |
| Operators | `&&`, `\|\|`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=` |
| JSONPath | `$`, `$.field`, `$.field.sub`, `$.array[index]`, quoted bracket keys |

`$input.params('name')` looks for the name in the path, then the query
string, then the headers.

### Unsupported VTL

A template that uses anything else makes the request fail with HTTP 502, and
the response body names the construct. That includes:

- arithmetic outside literal concatenation,
- `#macro`, `#parse` and `#include`,
- the range operator (`[1..5]`),
- `$velocityCount` and other Velocity built-ins,
- JSONPath filters (`$..items`, `$.items[?(@.x > 5)]`).

## Related

- [`cdkd local start-api`](local-start-api.md): the worked example, the
  options and which routes are served
- [Routing and request handling](local-start-api-routing.md): routes that
  return 501, and the REST v1 CORS preflight
