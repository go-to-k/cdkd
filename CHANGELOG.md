# 1.0.0 (2026-04-23)


### Bug Fixes

* add branch creation step to /create-pr skill ([d9cadb9](https://github.com/go-to-k/cdkd/commit/d9cadb90320a08a18084d076a90bb4ea0921df26))
* **benchmark:** clean up on any exit path, not just INT/TERM ([b873f34](https://github.com/go-to-k/cdkd/commit/b873f34762cf592f708e143fbf20d75cd971594f))
* **diff:** resolve intrinsics against state to detect changes inside Fn::Join ([#8](https://github.com/go-to-k/cdkd/issues/8)) ([1ce59e1](https://github.com/go-to-k/cdkd/commit/1ce59e12d24a1a8e722475fcfd3080aa4c5c24bd))
* exclude AWS::CDK::Metadata and NO_CHANGE resources from level counter ([01ea687](https://github.com/go-to-k/cdkd/commit/01ea687809d8d7b6464e412525ea920564719ac6))
* **release:** use channel instead of prerelease for experimental dist-tag ([#19](https://github.com/go-to-k/cdkd/issues/19)) ([1b7d4ff](https://github.com/go-to-k/cdkd/commit/1b7d4ffbc8c1a1b4667b7ee4692aac23dd255e55))
* remove unnecessary attribute-mapper and schema-cache ([#3](https://github.com/go-to-k/cdkd/issues/3)) ([e0556a3](https://github.com/go-to-k/cdkd/commit/e0556a3510e4d07668097f63a025ba12226b8425))


### Features

* add --no-wait option to /use-cdkd skill ([#6](https://github.com/go-to-k/cdkd/issues/6)) ([e98b9c0](https://github.com/go-to-k/cdkd/commit/e98b9c07ad457f72acbed0552dc627b8a0b4d935))
* add /create-pr skill for automated PR creation with quality checks ([54139bf](https://github.com/go-to-k/cdkd/commit/54139bf7241ca9868d285ba28c94a63aa63df26d))
* add /use-cdkd skill to build and show commands for other projects ([1a95c8e](https://github.com/go-to-k/cdkd/commit/1a95c8e0d88fb1f24728adf5dd329278e62bf9b8))
* add /verify skill for on-demand local quality checks ([885243f](https://github.com/go-to-k/cdkd/commit/885243f017e7bfea224b3b454e7be4c7dfff0c71))
* add SDK/CC API benchmark scenarios and publish results ([2ce59ea](https://github.com/go-to-k/cdkd/commit/2ce59ea62557f8585c0f6d30129a1ee70b9ecb6a))
* implement cdkd - CDK Direct without CloudFormation ([#1](https://github.com/go-to-k/cdkd/issues/1)) ([9865e9c](https://github.com/go-to-k/cdkd/commit/9865e9c31d9d56e5b93db4c553a1fa54dc1d9d7d))
* parallelize asset publishing and stack deployment ([#5](https://github.com/go-to-k/cdkd/issues/5)) ([9cc12ed](https://github.com/go-to-k/cdkd/commit/9cc12edab25b6a78a6e277959797ef13d5fc29ff))
* replace CDK toolkit-lib/cdk-assets-lib with self-implemented synthesis and asset publishing ([#4](https://github.com/go-to-k/cdkd/issues/4)) ([59b9a3e](https://github.com/go-to-k/cdkd/commit/59b9a3e41984ccb4221fed16d169902f67746dd3))
* support CDK Stages by traversing nested cloud assemblies ([#7](https://github.com/go-to-k/cdkd/issues/7)) ([757cc57](https://github.com/go-to-k/cdkd/commit/757cc5786e31bae94dc63508592b654ac8c042b6))
