# Deadline Reminder Lambda

Deploy `handler.ts` as the daily reminder Lambda handler. Package this directory with its `pg` dependency, set `DATABASE_URL` and `APP_USER_ID`, and optionally set `REMINDER_WINDOW_DAYS` to override the default 30 day scan window.

Recommended trigger: EventBridge Scheduler or EventBridge Rule with a daily cron expression. The handler scans open deadlines due from today through the configured window and inserts one `agent_events('remind')` row per deadline per calendar day.

## Policy KB Refresh Lambda

Deploy `kb-handler.ts` as a separate daily policy knowledge refresh Lambda. Package this directory with `pg`, `@aws-sdk/client-bedrock-runtime`, and `infra/kb-sources.json` available at `../infra/kb-sources.json` relative to the compiled handler, or set `KB_SOURCES_PATH` to the packaged JSON path.

Required environment: `DATABASE_URL` plus AWS credentials/role access for Bedrock Runtime. Optional environment: `AWS_REGION` and `BEDROCK_TITAN_MODEL_ID`.

Recommended trigger: a separate EventBridge Scheduler or EventBridge Rule with a daily cron expression. This Lambda fetches the official KB URLs, replaces changed `SYSTEM_USER_ID` policy documents by `source_key`, embeds chunks with Titan, and inserts `agent_events('kb_refresh')`.
