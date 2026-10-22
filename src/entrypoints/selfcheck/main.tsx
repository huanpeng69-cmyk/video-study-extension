/**
 * 自检页：在扩展自己的环境里跑真实代码，把「字幕 → 自动学习」每一步的真实结果显示出来。
 *
 * 为什么需要它：之前只能靠读代码推断，反复改却不中；这个页面直接调用
 * 真实的 IndexedDB、真实的 runtime 消息，把断点位置变成可见事实。
 * 只读为主，不写任何视频资料，也不发模型请求。
 */
import { getDb, listTranscripts, getCues, latestSummary } from '../../storage/db';
import { autoSummaryState } from '../../lib/bridge';
import { loadApiKey, loadSettings } from '../../storage/settings';
import { AUTO_NODE_INTERVAL_MS } from '../../jobs/auto-nodes';

type Level = 'ok' | 'bad' | 'warn';

const log = document.getElementById('log')!;
const lines: string[] = [];

function row(level: Level, title: string, detail?: unknown): void {
  const div = document.createElement('div');
  div.className = `row ${level}`;
  const head = document.createElement('div');
  head.textContent = `${level === 'ok' ? '✓' : level === 'bad' ? '✗' : '!'} ${title}`;
  div.appendChild(head);
  if (detail !== undefined) {
    const pre = document.createElement('pre');
    pre.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    div.appendChild(pre);
  }
  log.appendChild(div);
  lines.push(`[${level}] ${title}${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

async function run(): Promise<void> {
  log.innerHTML = '';
  lines.length = 0;

  // 1) 数据库里到底有没有视频、字幕
  const db = getDb();
  await db.open();
  const videos = await db.videos.toArray();
  const transcripts = await db.transcripts.toArray();
  const sessions = await db.autoSummarySessions.toArray();
  const nodes = await db.summaryNodes.toArray();
  const summaries = await db.summaries.toArray();

  row(videos.length > 0 ? 'ok' : 'bad', `视频记录：${videos.length} 条`,
    videos.slice(0, 5).map((v) => ({ id: v.id, title: v.title, platform: v.platform, durationMs: v.durationMs })));
  row(transcripts.length > 0 ? 'ok' : 'bad', `字幕版本：${transcripts.length} 条`,
    transcripts.slice(0, 5).map((t) => ({ id: t.id, videoId: t.videoId, kind: t.sourceKind, cues: t.cueCount, label: t.trackLabel })));
  if (transcripts.length === 0) {
    row('bad', '没有任何字幕版本 → 自动学习不可能工作',
      '字幕只存在于内存（cues）而没有落库时，就是这个状态。请在视频页点「从音频转写」或「读取页内字幕」后重新自检。');
  }

  // 2) 每个视频的自动学习会话与节点
  for (const video of videos.slice(0, 5)) {
    const list = await listTranscripts(video.id);
    const session = sessions.find((s) => s.videoId === video.id) ?? null;
    const videoNodes = nodes.filter((n) => n.videoId === video.id);
    row(list.length > 0 ? 'ok' : 'warn', `视频 ${video.id} 的字幕版本：${list.length}`,
      list.slice(0, 3).map((t) => t.id));
    row(session ? 'ok' : 'bad', `视频 ${video.id} 的自动学习会话：${session ? '存在' : '不存在'}`,
      session ? {
        transcriptId: session.transcriptId, enabled: session.enabled, lastNode: session.lastNode,
        durationMs: session.durationMs, playbackPaused: session.playbackPaused,
        lastPositionMs: session.lastPositionMs, error: session.error?.code ?? null,
      } : '没有会话 → 自动学习不会触发。会话由「字幕就绪」或「播放位置上报」创建。');
    row(videoNodes.length > 0 ? 'ok' : 'warn', `视频 ${video.id} 的节点：${videoNodes.length} 个`,
      videoNodes.map((n) => ({ index: n.index, status: n.status, ms: `${n.startMs}-${n.endMs}` })));
    const summary = await latestSummary(video.id);
    row(summary ? 'ok' : 'warn', `视频 ${video.id} 的总结：${summary ? '已生成' : '尚无'}`,
      summary ? { coverage: summary.coverage, sections: summary.payload.sections.length + 1 } : undefined);
  }
  row(summaries.length > 0 ? 'ok' : 'warn', `总结记录总数：${summaries.length}`);

  // 3) 后台快照（真实 runtime 调用）
  const firstVideo = videos[0];
  if (firstVideo) {
    const snap = await autoSummaryState(firstVideo.id);
    row(snap.ok ? 'ok' : 'bad', '后台 AUTO_SUMMARY_STATE', snap.ok ? snap.data : snap.error);
  }

  // 4) AI 配置（不显示 Key 内容）
  const settings = await loadSettings();
  const key = await loadApiKey(settings);
  row(settings.consentAcknowledged ? 'ok' : 'bad',
    `发送范围确认：${settings.consentAcknowledged ? '已确认' : '未确认（自动学习会被拦）'}`);
  row(key ? 'ok' : 'bad', `API Key：${key ? '已保存' : '缺失（自动学习会被拦）'}`);
  row(settings.provider.baseUrl && settings.provider.modelId ? 'ok' : 'bad',
    '服务地址与模型', { baseUrl: settings.provider.baseUrl, modelId: settings.provider.modelId });
  const origin = (() => { try { return new URL(settings.provider.baseUrl).origin; } catch { return null; } })();
  if (origin) {
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
    row(granted ? 'ok' : 'bad', `域名授权 ${origin}：${granted ? '已授权' : '未授权'}`);
  }
  row('warn', `节点间隔：${AUTO_NODE_INTERVAL_MS / 1000} 秒（播放跨过 30s 才触发节点 0）`);

  // 5) 结论提示
  row('warn', '怎么看结论',
    '若「字幕版本」为 0 → 字幕没落库（自动学习必然不出字）；\n' +
    '若字幕有、但「自动学习会话」不存在 → 会话没建立；\n' +
    '若会话存在且 enabled=true、播放已过 30 秒仍无节点 → 触发或播放上报有问题；\n' +
    '若节点 status=failed → 看 error.code（配置/Key/授权）。');
}

async function main(): Promise<void> {
  document.getElementById('run')!.addEventListener('click', () => { void run(); });
  document.getElementById('copy')!.addEventListener('click', () => {
    void navigator.clipboard.writeText(lines.join('\n'));
  });
  document.getElementById('clear')!.addEventListener('click', () => { log.innerHTML = ''; lines.length = 0; });
  await run();
}

void main();
