# Task: 后端收尾 — 多模态 ingest + 每日提醒 Lambda + seed

## Goal
1. ingest 支持多模态：扫描件/图片型 PDF 与 PNG/JPEG 直接喂 Claude 抽取（文本型 PDF 仍走 pdf-parse）。
2. 每日 deadline 提醒 Lambda（agent 自主扫临近 deadline 写提醒事件）。
3. seed 脚本灌 demo 数据。

## Context
- ingest 现状：multipart file / JSON text → pdf-parse → `extractDeadlines(text)` → S3 + `writeMemory`(chunk+embed+deadlines)。
- Bedrock Claude Sonnet 4.5 支持 image / document(PDF) content block（多模态）。
- 已定：**不加 confirm 步**，ingest 仍直接入库。env：BEDROCK_CLAUDE_MODEL_ID / BEDROCK_TITAN_MODEL_ID / DATABASE_URL / S3_BUCKET / APP_USER_ID。

## Requirements

### A. 多模态 ingest
1. `web/lib/bedrock.ts`：新增多模态抽取，如 `extractFromMedia(base64: string, mediaType: string): Promise<{ transcript: string; deadlines: ExtractedDeadline[] }>`：
   - PDF → Anthropic messages 的 document block；PNG/JPEG → image block（对 Bedrock/Sonnet 4.5 的正确格式，anthropic_version bedrock-2023-05-31）。
   - prompt 要求**同时**返回纯文本 transcript（供 RAG chunking）和 deadlines 数组，JSON 形如 `{"transcript":"...","deadlines":[{title,due_date,description,confidence}]}`。英文。复用现有日期/confidence 校验（normalizeDeadline）。
2. `web/app/api/ingest/route.ts`：
   - 允许类型加 `image/png`、`image/jpeg`（沿用 10MB 上限）。
   - PDF：先 pdf-parse；抽出文本足够长(如 ≥ 一个阈值常量)→ 走现有文本路径；否则(扫描件/空)→ 走 `extractFromMedia(pdf)`，用返回 transcript 当 document text。
   - PNG/JPEG：直接 `extractFromMedia`，transcript 当 text。
   - S3 仍存原件；`writeMemory` 用 transcript 做 chunk+embed，deadlines 照写。多模态失败给结构化可读错误。

### B. 每日提醒 Lambda（自包含，不 import web/）
3. `agent/handler.ts`：用 `pg` 直连 + 内联逻辑（Lambda 打包不便依赖 web/lib）：
   - 查 `status='open'` 且 `due_date` 在未来 N 天内(默认 30)、且当天尚未为该 deadline 写过 `'remind'` 的 deadline。
   - 每个写 `agent_events('remind', {deadlineId,title,dueDate,daysLeft})`；同 deadline 同天不重复。
   - handler 返回 `{scanned, remindersCreated}`；错误不 throw 裸奔（catch 后返回错误摘要）。读 env DATABASE_URL、APP_USER_ID。
4. `agent/package.json`（含 pg 依赖）+ 在 `agent/` 或 README 写一段 Lambda 部署说明（EventBridge 每日 cron → 此 handler；需 DATABASE_URL 等环境变量）。

### C. seed 脚本
5. `scripts/seed.ts`（`tsx` 跑，读 `web/.env.local`）：复用 `web/lib` 的 `extractDeadlines`+`writeMemory`（或 POST /api/ingest）灌 3-4 个真实感样本（IRCC 学签到期邮件 / CAQ 通知 / 工签）。**幂等**（靠 text_hash 去重，重复跑不翻倍）。加 `web/package.json` 或根 script 入口跑它。

## Constraints
- 不碰前端 page/layout/components。所有 prompt / 文案英文。参数化 SQL，无 ORM。复用现有 lib，别重复造 embed/chunk/normalizeDeadline。
- 多模态严格按 Bedrock anthropic messages 的 content block 格式；若 Bedrock InvokeModel 不支持 PDF document block，降级为报可读错误并在 HANDOFF 标注。

## Verify（静态，无 live）
- `cd web && npx tsc --noEmit`、`npm run lint`、`npm run test` 全过（新增纯函数可补测）。
- **不要**跑 live DB/Bedrock/S3/HTTP；live 由 Claude(人类侧) 验。

## Acceptance（Claude live 验）
- 传图片/扫描 PDF → 返回抽出的 deadline，库里有 chunks(transcript embedding)。
- 文本 PDF/文本仍走原路径正常。
- 本地 mock 调 `agent/handler` → 为临近 deadline 生成 remind 事件，重复跑不重复写。
- seed 跑完库里有样本，重复跑不翻倍。

## Review Focus
- 多模态 content block 格式（Bedrock/Sonnet 4.5）对不对。
- 文本型 vs 扫描型 PDF 分流阈值是否合理。
- transcript 用于 chunk 是否得当；多模态失败是否降级。
- Lambda 自包含、无重复提醒、事务/幂等。
- seed 幂等。

## 完成后 HANDOFF 追加 "## Round 3" 小结（改了啥、静态验证结果、多模态 content block 决策、待 live 验证点）。不要 commit/push。
