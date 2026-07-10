// AWS Lambda — 定时 agent pass（EventBridge cron 每日触发）
// 逻辑：扫 open & 临近的 deadline → 生成提醒 → 写 agent_events('remind')
// 由后续 TASK 实现，本次不做。

export const handler = async () => {
  throw new Error("not implemented — 见后续 .ai/TASK.md");
};
