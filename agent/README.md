# Deadline Reminder Lambda

Deploy `handler.ts` as the daily reminder Lambda handler. Package this directory with its `pg` dependency, set `DATABASE_URL` and `APP_USER_ID`, and optionally set `REMINDER_WINDOW_DAYS` to override the default 30 day scan window.

Recommended trigger: EventBridge Scheduler or EventBridge Rule with a daily cron expression. The handler scans open deadlines due from today through the configured window and inserts one `agent_events('remind')` row per deadline per calendar day.

## Policy KB Refresh Lambda

Deploy `kb-handler.ts` as a separate daily policy knowledge refresh Lambda. Package this directory with `pg`, `@aws-sdk/client-bedrock-runtime`, and `infra/kb-sources.json` available at `../infra/kb-sources.json` relative to the compiled handler, or set `KB_SOURCES_PATH` to the packaged JSON path.

Required environment: `DATABASE_URL` plus AWS credentials/role access for Bedrock Runtime. Optional environment: `AWS_REGION` and `BEDROCK_TITAN_MODEL_ID`.

Recommended trigger: a separate EventBridge Scheduler or EventBridge Rule with a daily cron expression. This Lambda fetches the official KB URLs, replaces changed `SYSTEM_USER_ID` policy documents by `source_key`, embeds chunks with Titan, and inserts `agent_events('kb_refresh')`.

---

## Deployment (AWS CLI, region `us-east-2`)

Two separate Lambdas, each on its own daily schedule. Replace `<ACCOUNT_ID>` (e.g. `938050482316`) and `<DATABASE_URL>`; run the schedules staggered so they don't contend for DB connections.

### 1. Reminder Lambda (`handler.ts`) — DB only, no Bedrock

```bash
cd agent && npm install
npx esbuild handler.ts --bundle --platform=node --target=node20 --outfile=dist/handler.js
(cd dist && zip -r ../reminder.zip handler.js)

aws iam create-role --role-name deadline-reminder-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name deadline-reminder-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws lambda create-function --function-name deadline-reminder \
  --runtime nodejs20.x --handler handler.handler \
  --role arn:aws:iam::<ACCOUNT_ID>:role/deadline-reminder-role \
  --zip-file fileb://reminder.zip --timeout 30 --region us-east-2 \
  --environment "Variables={DATABASE_URL=<DATABASE_URL>,APP_USER_ID=00000000-0000-0000-0000-000000000001,REMINDER_WINDOW_DAYS=30}"

aws events put-rule --name deadline-reminder-daily --schedule-expression "cron(0 13 * * ? *)" --region us-east-2
aws lambda add-permission --function-name deadline-reminder --statement-id evb --action lambda:InvokeFunction \
  --principal events.amazonaws.com --region us-east-2 \
  --source-arn arn:aws:events:us-east-2:<ACCOUNT_ID>:rule/deadline-reminder-daily
aws events put-targets --rule deadline-reminder-daily --region us-east-2 \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-east-2:<ACCOUNT_ID>:function:deadline-reminder"
```

### 2. Policy KB Refresh Lambda (`kb-handler.ts`) — needs Bedrock + bundled config

Differs from the reminder Lambda in two ways: (a) the execution role needs `bedrock:InvokeModel` for Titan embeddings, and (b) `infra/kb-sources.json` must be packaged into the zip and pointed to via `KB_SOURCES_PATH`.

```bash
cd agent && npm install
npx esbuild kb-handler.ts --bundle --platform=node --target=node20 --outfile=dist/kb-handler.js
cp ../infra/kb-sources.json dist/kb-sources.json
(cd dist && zip -r ../kb-refresh.zip kb-handler.js kb-sources.json)

aws iam create-role --role-name deadline-kb-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name deadline-kb-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam attach-role-policy --role-name deadline-kb-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

aws lambda create-function --function-name deadline-kb-refresh \
  --runtime nodejs20.x --handler kb-handler.handler \
  --role arn:aws:iam::<ACCOUNT_ID>:role/deadline-kb-role \
  --zip-file fileb://kb-refresh.zip --timeout 300 --memory-size 512 --region us-east-2 \
  --environment "Variables={DATABASE_URL=<DATABASE_URL>,AWS_REGION=us-east-2,BEDROCK_TITAN_MODEL_ID=amazon.titan-embed-text-v2:0,KB_SOURCES_PATH=/var/task/kb-sources.json}"

aws events put-rule --name deadline-kb-daily --schedule-expression "cron(0 8 * * ? *)" --region us-east-2
aws lambda add-permission --function-name deadline-kb-refresh --statement-id evb-kb --action lambda:InvokeFunction \
  --principal events.amazonaws.com --region us-east-2 \
  --source-arn arn:aws:events:us-east-2:<ACCOUNT_ID>:rule/deadline-kb-daily
aws events put-targets --rule deadline-kb-daily --region us-east-2 \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-east-2:<ACCOUNT_ID>:function:deadline-kb-refresh"
```

Verify each with `aws lambda invoke --function-name <name> --region us-east-2 out.json && cat out.json`:
- `deadline-reminder` → `{"scanned":N,"remindersCreated":M}`
- `deadline-kb-refresh` → per-source `updated`/`skipped`/`error` summary (first run updates all sources; unchanged sources are `skipped` on later runs)
