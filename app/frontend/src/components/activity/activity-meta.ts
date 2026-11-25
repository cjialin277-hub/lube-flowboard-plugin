import { getLang } from "../../i18n";

export const ACTIVITY_TYPE_META: Record<
  string,
  { labelEn: string; labelZh: string; group: "llm" | "gen" | "upload" }
> = {
  auto_prompt:       { labelEn: "Auto-Prompt",         labelZh: "自动分镜提示词", group: "llm" },
  auto_prompt_batch: { labelEn: "Auto-Prompt (batch)", labelZh: "批量多景别提示词", group: "llm" },
  vision:            { labelEn: "Vision",              labelZh: "画面视觉解析",   group: "llm" },
  planner:           { labelEn: "Planner",             labelZh: "剧本节点规划",   group: "llm" },
  gen_image:             { labelEn: "Generate image",          labelZh: "生成图片",           group: "gen" },
  gen_video:             { labelEn: "Generate video",          labelZh: "生成视频",           group: "gen" },
  gen_video_omni:        { labelEn: "Generate video (Omni)",   labelZh: "多参考视频 (Omni)",  group: "gen" },
  gen_video_first_last:  { labelEn: "First → Last transition", labelZh: "首尾帧过渡视频",     group: "gen" },
  edit_image:            { labelEn: "Edit image",              labelZh: "局部修图",           group: "gen" },
  upload:            { labelEn: "Upload (file)",       labelZh: "上传本地图片",   group: "upload" },
  upload_url:        { labelEn: "Upload (link)",       labelZh: "链接导入图片",   group: "upload" },
};

export function metaFor(type: string) {
  const m = ACTIVITY_TYPE_META[type];
  if (!m) return { label: type, group: "llm" as const };
  return {
    label: getLang() === "zh" ? m.labelZh : m.labelEn,
    group: m.group,
  };
}

export const STATUS_META: Record<
  string,
  { icon: string; labelEn: string; labelZh: string; tone: "muted" | "running" | "ok" | "fail" }
> = {
  queued:   { icon: "⋯", labelEn: "queued",   labelZh: "排队中", tone: "muted" },
  running:  { icon: "⟳", labelEn: "running",  labelZh: "运行中", tone: "running" },
  done:     { icon: "✓", labelEn: "done",     labelZh: "已完成", tone: "ok" },
  failed:   { icon: "✗", labelEn: "failed",   labelZh: "失败",   tone: "fail" },
  canceled: { icon: "⊘", labelEn: "canceled", labelZh: "已取消", tone: "muted" },
  timeout:  { icon: "⏱", labelEn: "timeout",  labelZh: "超时",   tone: "fail" },
};

export function statusMeta(status: string) {
  const s = STATUS_META[status];
  if (!s) return { icon: "•", label: status, tone: "muted" as const };
  return {
    icon: s.icon,
    label: getLang() === "zh" ? s.labelZh : s.labelEn,
    tone: s.tone,
  };
}

export function relativeTime(iso: string): string {
  const zh = getLang() === "zh";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return zh ? "刚刚" : "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 5) return zh ? "刚刚" : "just now";
  if (sec < 60) return zh ? `${sec}秒前` : `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return zh ? `${min}分钟前` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return zh ? `${hr}小时前` : `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return zh ? `${day}天前` : `${day}d ago`;
  return new Date(iso).toLocaleDateString(zh ? "zh-CN" : "en-US");
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${min}m ${s}s`;
}
