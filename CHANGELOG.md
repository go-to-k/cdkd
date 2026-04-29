# [0.5.0](https://github.com/go-to-k/cdkd/compare/v0.4.1...v0.5.0) (2026-04-29)


### Features

* **cli:** add list/ls command (CDK CLI parity) ([#52](https://github.com/go-to-k/cdkd/issues/52)) ([c1222f4](https://github.com/go-to-k/cdkd/commit/c1222f4edfccc569bfc3670ec87a01cb45ef21a0))

## [0.4.1](https://github.com/go-to-k/cdkd/compare/v0.4.0...v0.4.1) (2026-04-29)


### Bug Fixes

* **deploy:** retry CW Logs SubscriptionFilter test-message probe ([#51](https://github.com/go-to-k/cdkd/issues/51)) ([271bafe](https://github.com/go-to-k/cdkd/commit/271bafe85a0651b4192324c197da98bf37fd8600))

# [0.4.0](https://github.com/go-to-k/cdkd/compare/v0.3.6...v0.4.0) (2026-04-29)


### Features

* **cli:** accept CDK display path (Stage/Stack) for stack selection ([#49](https://github.com/go-to-k/cdkd/issues/49)) ([e365fdf](https://github.com/go-to-k/cdkd/commit/e365fdf38cda0a8db0250c9f10e5f3c41c95ab3a))
* **cli:** live multi-line progress display for in-flight resources ([#48](https://github.com/go-to-k/cdkd/issues/48)) ([9843d38](https://github.com/go-to-k/cdkd/commit/9843d38c4bcb2082e4cad917ef4240b5c8a11850))

## [0.3.6](https://github.com/go-to-k/cdkd/compare/v0.3.5...v0.3.6) (2026-04-29)


### Bug Fixes

* **lambda,ec2:** filter ENI by description, not requester-id ([#45](https://github.com/go-to-k/cdkd/issues/45)) ([cf2ab1a](https://github.com/go-to-k/cdkd/commit/cf2ab1a7ce020e371a2b8360069816993109f9d0))

## [0.3.5](https://github.com/go-to-k/cdkd/compare/v0.3.4...v0.3.5) (2026-04-29)


### Bug Fixes

* **lambda:** widen per-ENI delete budget to 30min for AWS eventually-consistent release ([#44](https://github.com/go-to-k/cdkd/issues/44)) ([4db7663](https://github.com/go-to-k/cdkd/commit/4db766344ca542af2fa8690a25d0b1fb30dd9162))

## [0.3.4](https://github.com/go-to-k/cdkd/compare/v0.3.3...v0.3.4) (2026-04-29)


### Bug Fixes

* **lambda,ec2:** delstack-style ENI cleanup + EC2 side-channel retry ([#43](https://github.com/go-to-k/cdkd/issues/43)) ([5241e1f](https://github.com/go-to-k/cdkd/commit/5241e1fbad9c6a0b69bf98fe15c53f40400c2859))

## [0.3.3](https://github.com/go-to-k/cdkd/compare/v0.3.2...v0.3.3) (2026-04-29)


### Bug Fixes

* **lambda:** wait for VPC detach to fully apply before DeleteFunction ([#42](https://github.com/go-to-k/cdkd/issues/42)) ([6de7acb](https://github.com/go-to-k/cdkd/commit/6de7acb1cfce2662b1ccf474c2de5748ad1d7f86))

## [0.3.2](https://github.com/go-to-k/cdkd/compare/v0.3.1...v0.3.2) (2026-04-29)


### Bug Fixes

* **lambda:** match ENI description by token prefix, not full physicalId regex ([#41](https://github.com/go-to-k/cdkd/issues/41)) ([74331ce](https://github.com/go-to-k/cdkd/commit/74331ce49548938d054803becaa753dd83a84526))

## [0.3.1](https://github.com/go-to-k/cdkd/compare/v0.3.0...v0.3.1) (2026-04-28)


### Bug Fixes

* **lambda:** detach VPC + actively delete ENIs before downstream cleanup ([#38](https://github.com/go-to-k/cdkd/issues/38)) ([cc3a9a6](https://github.com/go-to-k/cdkd/commit/cc3a9a6981a5f86503dd3e237b46f6fb3ee86fcc))

# [0.3.0](https://github.com/go-to-k/cdkd/compare/v0.2.0...v0.3.0) (2026-04-28)


### Bug Fixes

* **cloudfront:** wait for Enabled=false to propagate before delete ([#33](https://github.com/go-to-k/cdkd/issues/33)) ([482c071](https://github.com/go-to-k/cdkd/commit/482c071c25c47f285102b9d02e4c32b28d7c98c9))
* **deploy:** force Subnet/SG to wait for Lambda::Function on delete ([#37](https://github.com/go-to-k/cdkd/issues/37)) ([7bfaa5f](https://github.com/go-to-k/cdkd/commit/7bfaa5fe35a0781a2afe985518d0991bfcd959f9))


### Features

* **provider:** handle Lambda VpcConfig + wait for ENI detach on delete ([#35](https://github.com/go-to-k/cdkd/issues/35)) ([51d3de7](https://github.com/go-to-k/cdkd/commit/51d3de76831fce4f299b04da5f65fc097627714c))
* **provider:** handle SecurityGroupEgress on AWS::EC2::SecurityGroup ([#34](https://github.com/go-to-k/cdkd/issues/34)) ([d69b6b9](https://github.com/go-to-k/cdkd/commit/d69b6b91c718bc7606acdabda82882b9e96ef3ab))

# [0.2.0](https://github.com/go-to-k/cdkd/compare/v0.1.0...v0.2.0) (2026-04-27)


### Features

* **deployment:** event-driven DAG dispatch (no level barriers) ([#30](https://github.com/go-to-k/cdkd/issues/30)) ([bffd25d](https://github.com/go-to-k/cdkd/commit/bffd25db80a076956626bb941d6572ec170b60cb))

# [0.1.0](https://github.com/go-to-k/cdkd/compare/v0.0.4...v0.1.0) (2026-04-27)


### Features

* **cli:** add -y/--yes global flag, -a alias, accept assembly dir for --app ([#28](https://github.com/go-to-k/cdkd/issues/28)) ([1f51bb9](https://github.com/go-to-k/cdkd/commit/1f51bb9b8415913bf454885399789125b48f6ff6))

## [0.0.4](https://github.com/go-to-k/cdkd/compare/v0.0.3...v0.0.4) (2026-04-24)


### Bug Fixes

* **analyzer:** add implicit Custom Resource policy edge; split commit gate ([#27](https://github.com/go-to-k/cdkd/issues/27)) ([19b59b5](https://github.com/go-to-k/cdkd/commit/19b59b59dcf281b13c99fb921857ef2a3de5589a))

## [0.0.3](https://github.com/go-to-k/cdkd/compare/v0.0.2...v0.0.3) (2026-04-23)


### Bug Fixes

* **cli:** verify state bucket exists before synth and asset publishing ([#25](https://github.com/go-to-k/cdkd/issues/25)) ([cfe1b63](https://github.com/go-to-k/cdkd/commit/cfe1b630a40d6ad00a57bfe38e8c8b255768e55c))

## [0.0.2](https://github.com/go-to-k/cdkd/compare/v0.0.1...v0.0.2) (2026-04-23)


### Bug Fixes

* **cli:** report real version via build-time package.json injection ([#23](https://github.com/go-to-k/cdkd/issues/23)) ([edca82b](https://github.com/go-to-k/cdkd/commit/edca82b5172bfc2426cbea692a681f71e6ef05c9))
