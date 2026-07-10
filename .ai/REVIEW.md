# Review (Claude → Codex) — 后端地基

**总体结论：无阻塞（no blocker）。** 代码质量高，schema 修正全部到位，错误兜底/连接池单例/并发限流(5)/单事务原子写都做对了。可以进入「配 infra + 活测试」阶段。以下按优先级列改进项与需活测确认的风险。

## ① Bug
- 无 runtime 崩溃级 bug。纯函数与 Bedrock/DB 调用均有类型与空值防护。

## ② 行为回归
- 不适用（全新代码）。

## ③ 安全 / 数据风险
1. **[应修] 文档/分块去重缺失 → 重复 ingest 会撑爆记忆并污染检索。**
   `memory.ts:92` 算了 `text_hash` 并入库，但 schema 没有 `UNIQUE`，也没人用它去重。同一文件再传一次 → 新增一整份 `memory_documents` + 一整份 `memory_chunks`(带 embedding)。deadline 有 UNIQUE 挡住了，但 chunk 没有，向量库里会出现重复片段，语义检索结果被稀释。
   建议：schema 加 `UNIQUE (user_id, text_hash)`，`insertDocument` 用 `ON CONFLICT (user_id, text_hash) DO NOTHING`；命中已存在文档就跳过 embedding/chunk 写入，直接复用旧 document_id（也省一整轮 Titan 调用）。
2. **[应修] 上传文件无大小上限（Review Focus 点名项）。**
   `route.ts` 直接 `file.arrayBuffer()` 全读进内存 + PDF 解析，没卡上限。超大 PDF 会爆内存/超时（60s）。建议进 `readRequest` 前先查 `Content-Length` 或 buffer 长度，超过阈值（如 10MB）直接 413。
3. **[已知可接受] S3 先传、DB 后写的孤儿对象。**
   `route.ts:151` 先传 S3，之后抽取/写库失败会留下没有 DB 行的 S3 对象。HANDOFF 已声明。demo 可接受；若想干净，DB 事务失败后补一个 S3 删除（compensating delete）。

## ④ 漏掉的测试
4. **[建议] 纯函数现在就能加单测，不依赖 infra。**
   `chunkText`（切块/overlap/超长段切分）、`normalizeDeadline`（脏输入/非 ISO 日期/confidence 裁剪）、`parseJsonArray`（带 markdown 围栏/多余文字）都是纯函数。加一组 vitest 用例，能在没连 DB/Bedrock 时就守住核心逻辑，也是「生产就绪度」的加分点。

## ⑤ 可维护性 / 健壮性
5. **[建议] Titan 无重试/退避。** `mapWithConcurrency` 只限并发不退避；Titan 按 RPM 限流，一旦 429 整个 ingest 直接失败。加个指数退避重试更稳。
6. **[留意] `extractDeadlines` max_tokens=1200。** 文档 deadline 很多时 JSON 可能被截断导致解析失败。demo 影响小，长文档场景需调大或分段。

## ⚠️ 需活测确认（非代码问题，配好 infra 后逐条验）
- **Bedrock 模型可用性**：`InvokeModelCommand` + `us.anthropic.claude-3-5-sonnet-20241022-v2:0`（跨区域推理档 ID，配 InvokeModel 正确）。确认 Model Access 已批、region 一致。
- **向量字面量往返**：`toVectorLiteral` 产出 `[..]` 字符串 + `$5::VECTOR(1024)` 强转。CRDB v25.x 对该 cast 的接受度要真库验一次（`bedrock.ts:167`/`memory.ts:156`）。
- **DB SSL**：`sslmode=verify-full` 走 pg 连 CRDB Cloud，确认无需显式传 CA 就能连上；连不上时给 `ssl` 显式配置。
- **pdf-parse v2 API**：`new PDFParse({data}).getText()` 已过 tsc，真 PDF 跑一次确认抽出非空文本。

## 建议下一步顺序
1. Codex 先修 ①③ 的 #1（去重）+ #2（大小上限）+ ④ 的 #4（纯函数单测）——这些不需要 infra，现在就能做。
2. 你并行去开 CockroachDB 集群 + 申请/确认 Bedrock 权限 + 建 S3 桶，填 `.env.local`。
3. infra 齐了跑「需活测确认」四条 + HANDOFF 里的 pending 清单。
