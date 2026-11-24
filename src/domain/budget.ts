/**
 * 输出预算估算：按本段字幕规模给出 max_tokens。
 *
 * 关键教训（0.5.0 修复）：0.4.0 版本按「输入字符数」估算，在旧结构下够用，
 * 但 0.5.0 换成了「章节 + 段落/条目」结构，每个块都要带 sourceCueIds 数组，
 * 输出体积大幅上升。240 条字幕按旧公式只给 1952 tokens，而实际需要约 4000+，
 * 于是**每一段都必然截断**——不是偶发慢，是确定性失败。
 *
 * 新公式按「字幕条数」估算输出块数，再折算 token：
 * - 约 6 条字幕产出一个段落或条目（经验值，偏保守）；
 * - 每个块含 text 与 sourceCueIds，约 150 字符、即约 100 tokens；
 * - 预留 512 tokens 给 JSON 骨架与标题。
 * 上限保持 8192，避免个别服务对超大 max_tokens 直接报错。
 *
 * 历史上它长在 `jobs/summary-service.ts`（旧的分段总结编排）里，
 * 编排已下线，但公式仍被自动学习与整段总结复用，故独立到领域层。
 */
export function summaryOutputBudget(cueCount: number, configured: number): number {
  const blocks = Math.ceil(cueCount / 6);
  const byBlocks = blocks * 100 + 512;
  // 用户配置的 maxTokens 作为下限参考，但不能低于旧版的 2048：
  // 新结构的输出天然比旧结构长，沿用旧下限会导致同样的截断问题。
  const floor = Math.max(2048, Math.min(configured, 4096));
  return Math.max(floor, Math.min(byBlocks, 8192));
}
