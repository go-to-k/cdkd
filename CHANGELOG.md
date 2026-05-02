# [0.19.0](https://github.com/go-to-k/cdkd/compare/v0.18.1...v0.19.0) (2026-05-02)


### Features

* **provisioning:** add import to 6 more SDK providers (batch 2) ([#80](https://github.com/go-to-k/cdkd/issues/80)) ([139dcc6](https://github.com/go-to-k/cdkd/commit/139dcc644ba81b1389f8f0edac84aab9f019781f))

## [0.18.1](https://github.com/go-to-k/cdkd/compare/v0.18.0...v0.18.1) (2026-05-02)


### Bug Fixes

* **cli:** buffer per-stack log output during parallel deploy ([#77](https://github.com/go-to-k/cdkd/issues/77)) ([0275dd3](https://github.com/go-to-k/cdkd/commit/0275dd3edf091e01b08b76c5ee95ad0f4ac12d8d))
* **cli:** scope live renderer tasks per stack for parallel deploys ([#83](https://github.com/go-to-k/cdkd/issues/83)) ([40b4997](https://github.com/go-to-k/cdkd/commit/40b4997c2885d68fc353038f4ce62774d2323ce2))

# [0.18.0](https://github.com/go-to-k/cdkd/compare/v0.17.1...v0.18.0) (2026-05-02)


### Features

* rename state rm to orphan + add cdkd orphan + 0.x-friendly releaseRules ([#79](https://github.com/go-to-k/cdkd/issues/79)) ([dc701dd](https://github.com/go-to-k/cdkd/commit/dc701dd1aa365b8b0d9a1e98f1c16d9079bd00fb))

## [0.17.1](https://github.com/go-to-k/cdkd/compare/v0.17.0...v0.17.1) (2026-05-01)


### Bug Fixes

* **provisioning:** scope resource-name stack prefix per async context (parallel deploy bug) ([#74](https://github.com/go-to-k/cdkd/issues/74)) ([1b5fb83](https://github.com/go-to-k/cdkd/commit/1b5fb834206e9051d285332265f181cf60709a78))

# [0.17.0](https://github.com/go-to-k/cdkd/compare/v0.16.1...v0.17.0) (2026-05-01)


### Features

* **provisioning:** add import to EC2, RDS, ECS, CloudFront, ApiGateway, Cognito providers ([#73](https://github.com/go-to-k/cdkd/issues/73)) ([255cab1](https://github.com/go-to-k/cdkd/commit/255cab1588395f3463f7dc9352e9823e242cd116))

## [0.16.1](https://github.com/go-to-k/cdkd/compare/v0.16.0...v0.16.1) (2026-05-01)


### Bug Fixes

* **cli:** fall back to legacy bucket when new is empty and legacy has state ([#72](https://github.com/go-to-k/cdkd/issues/72)) ([b48fd5d](https://github.com/go-to-k/cdkd/commit/b48fd5d9d4e7e888ab1ca1e5e6f2d2a5ed6facf4))

# [0.16.0](https://github.com/go-to-k/cdkd/compare/v0.15.0...v0.16.0) (2026-05-01)


### Features

* **provisioning:** add import to CloudControlProvider (explicit-override only) ([#71](https://github.com/go-to-k/cdkd/issues/71)) ([80739cc](https://github.com/go-to-k/cdkd/commit/80739cc31f531fbcb748653750c84e223a15dfd2))

# [0.15.0](https://github.com/go-to-k/cdkd/compare/v0.14.0...v0.15.0) (2026-05-01)


### Features

* **cli:** add cdkd import for adopting AWS-deployed resources ([#67](https://github.com/go-to-k/cdkd/issues/67)) ([f1cad24](https://github.com/go-to-k/cdkd/commit/f1cad2438868b48c56f5e268d1d0ea8ac4b958bf))

# [0.14.0](https://github.com/go-to-k/cdkd/compare/v0.13.0...v0.14.0) (2026-05-01)


### Features

* **cli:** add cdkd state migrate-bucket ([#66](https://github.com/go-to-k/cdkd/issues/66)) ([33dfd9b](https://github.com/go-to-k/cdkd/commit/33dfd9bc4e7dabca4b7d42fd60dfd54a962f4af5))

# [0.13.0](https://github.com/go-to-k/cdkd/compare/v0.12.0...v0.13.0) (2026-05-01)


### Features

* **cli:** hide state bucket from default output, add cdkd state info ([#59](https://github.com/go-to-k/cdkd/issues/59)) ([03b3bd8](https://github.com/go-to-k/cdkd/commit/03b3bd817ffe657c10363b4fc436c9aae153e2f7))

# [0.12.0](https://github.com/go-to-k/cdkd/compare/v0.11.0...v0.12.0) (2026-05-01)


### Features

* **cli:** cdkd state destroy command (CDK-app-free destroy) ([#58](https://github.com/go-to-k/cdkd/issues/58)) ([cacc26c](https://github.com/go-to-k/cdkd/commit/cacc26c81399032de775015a3bd60a02dda003cc))

# [0.11.0](https://github.com/go-to-k/cdkd/compare/v0.10.0...v0.11.0) (2026-05-01)


### Features

* **state:** default bucket name without region (cdkd-state-{accountId}) ([#62](https://github.com/go-to-k/cdkd/issues/62)) ([11a676c](https://github.com/go-to-k/cdkd/commit/11a676cb8b571d462f1de03568b3665295997eae))

# [0.10.0](https://github.com/go-to-k/cdkd/compare/v0.9.0...v0.10.0) (2026-05-01)


### Features

* **state:** dynamic state-bucket region resolution + UnknownError normalization ([#60](https://github.com/go-to-k/cdkd/issues/60)) ([d0056cd](https://github.com/go-to-k/cdkd/commit/d0056cd6fcc85fa78f2ff071ecfc5957fb8bf3cf))

# [0.9.0](https://github.com/go-to-k/cdkd/compare/v0.8.0...v0.9.0) (2026-05-01)


### Features

* **provisioning:** verify region match before idempotent NotFound on delete ([#61](https://github.com/go-to-k/cdkd/issues/61)) ([ab8f1f6](https://github.com/go-to-k/cdkd/commit/ab8f1f613369d5f7f533eb756b326448ace9b263))

# [0.8.0](https://github.com/go-to-k/cdkd/compare/v0.7.0...v0.8.0) (2026-05-01)


### Features

* **state:** region-prefixed state key (collection model extension) ([#57](https://github.com/go-to-k/cdkd/issues/57)) ([83e5ddb](https://github.com/go-to-k/cdkd/commit/83e5ddb66ca4a2923aba1f9ccc106c4411864ae6))

# [0.7.0](https://github.com/go-to-k/cdkd/compare/v0.6.0...v0.7.0) (2026-04-29)


### Features

* **cli:** physical stack name in cdkd list + spec-correct empty containers in toYaml + PR-readiness infra ([#55](https://github.com/go-to-k/cdkd/issues/55)) ([3353c47](https://github.com/go-to-k/cdkd/commit/3353c47d492f3790e93b31e0180f809759a4d813))

# [0.6.0](https://github.com/go-to-k/cdkd/compare/v0.5.1...v0.6.0) (2026-04-29)


### Features

* **cli:** add state command (list/resources/show/rm subcommands) ([#53](https://github.com/go-to-k/cdkd/issues/53)) ([5818f82](https://github.com/go-to-k/cdkd/commit/5818f826a4abbe43bebc1ee9dd1db8178431c79e))

## [0.5.1](https://github.com/go-to-k/cdkd/compare/v0.5.0...v0.5.1) (2026-04-29)


### Performance Improvements

* **deploy:** faster CREATE retry backoff (1s init + 8s cap) ([#54](https://github.com/go-to-k/cdkd/issues/54)) ([2df06a7](https://github.com/go-to-k/cdkd/commit/2df06a770bb2cc30f95093dce522df7243b5da48))

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
