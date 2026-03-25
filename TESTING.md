# cdkq のテスト方法

## 前提条件

1. AWS アカウント
2. AWS CLI 設定済み (`aws configure`)
3. Node.js 18 以上
4. cdkq のビルド完了 (`npm run build`)

## 1. テスト用 S3 バケットの作成

cdkq は状態管理に S3 バケットを使用します。まず、専用のバケットを作成します:

```bash
# バケット名は globally unique である必要があります
export STATE_BUCKET="cdkq-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # お好みのリージョンに変更

# S3 バケット作成
aws s3 mb s3://${STATE_BUCKET} --region ${AWS_REGION}

echo "State bucket created: ${STATE_BUCKET}"
```

## 2. テスト用 CDK アプリの作成

シンプルな CDK アプリを作成してテストします:

```bash
# テスト用ディレクトリ作成
directory="/tmp/cdkq-test"
mkdir -p ${directory}
cd ${directory}

# CDK プロジェクトの初期化
npx aws-cdk@latest init app --language typescript

# シンプルなスタックに変更
cat > lib/cdkq-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class CdkqTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // シンプルな S3 バケットを作成
    new s3.Bucket(this, 'TestBucket', {
      bucketName: `cdkq-test-bucket-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
EOF

# ビルド
npm run build
```

## 3. cdkq を使ってデプロイ

```bash
# cdkq のパスを設定 (cdkq のルートディレクトリから)
CDKQ_PATH="/Users/goto/github/cdkq"

# まず diff で変更を確認
node ${CDKQ_PATH}/dist/cli.js diff \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose

# デプロイを実行 (初回は全リソースが作成される)
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose
```

## 4. デプロイ結果の確認

```bash
# AWS コンソールまたは CLI でバケットが作成されているか確認
aws s3 ls | grep cdkq-test-bucket

# 状態ファイルの確認
aws s3 ls s3://${STATE_BUCKET}/stacks/ --recursive
```

## 5. 更新のテスト

スタックを変更してアップデートをテストします:

```bash
# バケットにタグを追加
cat > lib/cdkq-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class CdkqTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'TestBucket', {
      bucketName: `cdkq-test-bucket-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // タグを追加
      tags: {
        Environment: 'test',
        ManagedBy: 'cdkq',
      },
    });
  }
}
EOF

npm run build

# diff で変更を確認
node ${CDKQ_PATH}/dist/cli.js diff \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# 更新をデプロイ
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}
```

## 6. Dry Run のテスト

実際の変更なしで実行計画のみを表示:

```bash
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --dry-run \
  --verbose
```

## 7. スタックの削除

```bash
# destroy コマンドでリソースを削除
node ${CDKQ_PATH}/dist/cli.js destroy \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --stack CdkqTestStack \
  --region ${AWS_REGION} \
  --verbose

# 確認プロンプトをスキップする場合
node ${CDKQ_PATH}/dist/cli.js destroy \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --stack CdkqTestStack \
  --region ${AWS_REGION} \
  --force
```

## 8. クリーンアップ

テスト後は状態バケットも削除:

```bash
# バケット内のオブジェクトを削除
aws s3 rm s3://${STATE_BUCKET} --recursive

# バケット自体を削除
aws s3 rb s3://${STATE_BUCKET}
```

## トラブルシューティング

### アセット公開エラー

CDK アプリでアセット (Lambda 関数のコードなど) を使用している場合、アセット公開が失敗することがあります:

```bash
# アセット公開をスキップ
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "..." \
  --state-bucket ${STATE_BUCKET} \
  --skip-assets
```

### Cloud Control API がサポートしていないリソース

一部のリソースタイプ (例: `AWS::IAM::Role`) は Cloud Control API がサポートしていません。cdkq は自動的に SDK プロバイダーにフォールバックしますが、現在実装されているのは:

- `AWS::IAM::Role`

その他のサポートされていないリソースタイプを使用する場合、エラーメッセージが表示されます。

### ログの詳細表示

`--verbose` フラグを追加すると詳細なログが表示されます:

```bash
node ${CDKQ_PATH}/dist/cli.js deploy ... --verbose
```

## 既知の問題

1. **Cloud Control API の Update 処理**: 現在の実装では常にルート(`/`)を全置換しているため、一部のリソースで更新が失敗する可能性があります。

2. **カスタムリソース**: CDK のカスタムリソース (`Custom::*`) はサポートされていません。

3. **Parameters**: CloudFormation Parameters は現在サポートされていません。

4. **Outputs の Ref**: Outputs で Parameters への `Ref` は解決できません。
