# cdkq のテスト方法

## 前提条件

1. AWS アカウント
2. AWS CLI 設定済み (`aws configure`)
3. Node.js 20 以上
4. cdkq のビルド完了 (`npm run build`)

## 1. テスト用 S3 バケットの作成

cdkq は状態管理に S3 バケットを使用します。`bootstrap` コマンドで簡単に作成できます:

### 方法 A: bootstrap コマンドを使用 (推奨)

```bash
# cdkq のパスを設定 (cdkq のルートディレクトリから)
CDKQ_PATH="/Users/goto/github/cdkq"

# バケット名は globally unique である必要があります
export STATE_BUCKET="cdkq-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # お好みのリージョンに変更

# bootstrap コマンドでバケット作成
node ${CDKQ_PATH}/dist/cli.js bootstrap \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

echo "State bucket created: ${STATE_BUCKET}"
```

### 方法 B: AWS CLI を使用 (従来の方法)

```bash
# バケット名は globally unique である必要があります
export STATE_BUCKET="cdkq-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # お好みのリージョンに変更

# S3 バケット作成
aws s3 mb s3://${STATE_BUCKET} --region ${AWS_REGION}

echo "State bucket created: ${STATE_BUCKET}"
```

## 2. テスト用 CDK アプリの準備

cdkq には複数のテスト用例が用意されています:

### オプション A: 既存の例を使用 (推奨)

cdkq リポジトリには複数の例が含まれています:

#### Basic Example (シンプルな S3 バケット)

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/basic
npm install
```

#### Intrinsic Functions Example (組み込み関数のテスト)

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/intrinsic-functions
npm install
```

#### Lambda Example (Lambda + DynamoDB + IAM) ✅ 推奨

実践的なLambda関数とDynamoDBテーブルの統合例:

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/lambda
npm install
```

**テスト済み機能**:

- Lambda アセット公開 (S3へのコードアップロード)
- Fn::GetAtt による ARN 解決
- 環境変数での Ref 解決
- IAM Role/Policy の自動作成

#### Multi-Resource Example (複合的な例)

S3 + Lambda + DynamoDB + SQS + IAM のイベント駆動アーキテクチャ:

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/multi-resource
npm install
```

#### Parameters/Conditions Examples (未実装機能のデモ)

将来の実装のための仕様例:

- `tests/integration/examples/parameters/` - CloudFormation Parameters
- `tests/integration/examples/conditions/` - CloudFormation Conditions

各例の詳細については、それぞれのディレクトリ内の README.md を参照してください。

### オプション B: 新しい CDK アプリを作成

シンプルな CDK アプリを作成してテストすることもできます:

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
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false, // Custom::S3AutoDeleteObjects は未サポート
    });

    // Output でバケット名を確認（CloudFormation 組み込み関数をサポート）
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the test bucket',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'ARN of the test bucket',
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

## 5. CloudFormation 組み込み関数のテスト

cdkq は CloudFormation 組み込み関数 (Ref, Fn::GetAtt, Fn::Join, Fn::Sub) をサポートしています。
これらの関数を使ったリソースをデプロイできることを確認します:

```bash
# 組み込み関数を使用するスタックに変更
cat > lib/cdkq-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class CdkqTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 バケットを作成
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // IAM ロールを作成 (Ref を使って bucket を参照)
    const role = new iam.Role(this, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Test role for cdkq',
    });

    // バケットへの読み取り権限を付与 (Fn::GetAtt を使用)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      })
    );

    // Outputs で組み込み関数をテスト
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Bucket name (Ref)',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'Bucket ARN (Fn::GetAtt)',
    });

    new cdk.CfnOutput(this, 'RoleArn', {
      value: role.roleArn,
      description: 'Role ARN (Fn::GetAtt)',
    });
  }
}
EOF

npm run build

# diff で変更を確認
node ${CDKQ_PATH}/dist/cli.js diff \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

# 更新をデプロイ
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
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

3. **一部の CloudFormation 組み込み関数**: 以下の関数はまだサポートされていません:
   - Fn::Select, Fn::Split, Fn::ImportValue
   - Fn::If, Fn::Equals (Conditions)
   - Fn::FindInMap, Fn::GetAZs, Fn::Base64

4. **疑似パラメータ**: `AWS::Region` と `AWS::AccountId` 以外の疑似パラメータは環境変数またはハードコードされた値を返します。
