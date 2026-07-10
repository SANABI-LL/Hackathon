# Architecture

（架构图 + 数据流详述，DevPost 提交用。待补：mermaid 图 / 导出 PNG。）

## 记忆分层（CockroachDB）
| 记忆类型 | 表 | 说明 |
|---|---|---|
| 事务型 | `deadlines` | 结构化 deadline（title/due_date/status/confidence） |
| 语义 | `memory_chunks` | 文档切块 + `VECTOR(1024)` cosine 索引 |
| 情节 | `agent_events` | agent 每次行动留痕（ingest/remind/answer/scan） |
| 对话 | `messages` | 用户 ↔ AI 聊天记录 |

## 数据流
1. **Ingest（同步）**：上传 → S3 → Claude 抽 deadline → Titan embed → 写 4 表 → 返回。
2. **Chat**：向量检索 memory_chunks + 拉 deadlines 上下文 → Claude 生成 → 存 messages。
3. **Scheduled agent（Lambda）**：EventBridge 每日触发 → 扫 open & 临近 deadline → 生成提醒 → agent_events('remind')。
