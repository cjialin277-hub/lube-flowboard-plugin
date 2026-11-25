import { useEffect, useState } from "react";
import { getHealth, type HealthResponse } from "../api/client";
import { useLang } from "../i18n";

function formatAge(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function StatusBar({ collapsed = false }: { collapsed?: boolean }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [agentOk, setAgentOk] = useState(false);
  const { t } = useLang();

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await getHealth();
        if (!alive) return;
        setAgentOk(h.ok);
        setHealth(h);
      } catch {
        if (!alive) return;
        setAgentOk(false);
        setHealth(null);
      }
    };
    poll();
    const tmr = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(tmr);
    };
  }, []);

  const extConnected = health?.extension_connected ?? null;
  const stats = health?.ws_stats;
  const tokenAge = formatAge(stats?.token_age_s ?? null);
  const reqCount = stats?.request_count ?? 0;
  const okCount = stats?.success_count ?? 0;
  const failCount = stats?.failed_count ?? 0;

  const agentLabel = agentOk
    ? t("服务正常", "Agent online")
    : t("服务离线", "Agent offline");
  const extLabel =
    extConnected === null
      ? t("检测扩展", "Checking ext")
      : extConnected
      ? t("扩展已连", "Ext connected")
      : t("扩展未连", "Ext offline");

  const fullTooltip = [
    agentOk ? t("本地引擎 :8434 运行正常", "Local engine :8434 healthy") : t("本地引擎离线", "Local engine offline"),
    extConnected === true
      ? t("Chrome 扩展桥接已连接", "Chrome extension bridge connected")
      : extConnected === false
      ? t("Chrome 扩展未连接（如使用干跑模式可忽略）", "Chrome extension disconnected (optional in Dry-Run mode)")
      : t("正在检测 Chrome 扩展…", "Checking Chrome extension…"),
    extConnected && stats?.flow_key_present && tokenAge ? `Token ${tokenAge}` : null,
    extConnected && reqCount > 0 ? `${t("请求", "Requests")} ${reqCount} · ✓${okCount}${failCount > 0 ? ` · ✗${failCount}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  if (collapsed) {
    return (
      <div className="sidebar-statusbar sidebar-statusbar--collapsed" title={fullTooltip}>
        <span
          className={`sidebar-statusbar__dot sidebar-statusbar__dot--${agentOk ? "ok" : "err"}`}
          aria-label={agentLabel}
        />
        <span
          className={`sidebar-statusbar__dot sidebar-statusbar__dot--${
            extConnected ? "ok" : extConnected === null ? "pending" : "idle"
          }`}
          aria-label={extLabel}
        />
      </div>
    );
  }

  return (
    <div className="sidebar-statusbar" title={fullTooltip}>
      <div className="sidebar-statusbar__line">
        <span className="sidebar-statusbar__item">
          <span
            className={`sidebar-statusbar__dot sidebar-statusbar__dot--${agentOk ? "ok" : "err"}`}
            aria-hidden="true"
          />
          <span>{t("本地引擎", "Local engine")}</span>
        </span>
        <span className={`sidebar-statusbar__val${agentOk ? "" : " sidebar-statusbar__val--err"}`}>
          {agentOk ? t("正常", "Online") : t("离线", "Offline")}
        </span>
      </div>
      <div className="sidebar-statusbar__line">
        <span className="sidebar-statusbar__item">
          <span
            className={`sidebar-statusbar__dot sidebar-statusbar__dot--${
              extConnected ? "ok" : extConnected === null ? "pending" : "idle"
            }`}
            aria-hidden="true"
          />
          <span>{t("扩展桥接", "Extension")}</span>
        </span>
        <span className="sidebar-statusbar__val">
          {extConnected === null
            ? t("检测中", "Check")
            : extConnected
            ? t("已连", "Live")
            : t("未连", "Off")}
        </span>
      </div>
      {extConnected && (stats?.flow_key_present && tokenAge || reqCount > 0) && (
        <div className="sidebar-statusbar__sub">
          {stats?.flow_key_present && tokenAge && <span>token {tokenAge}</span>}
          {reqCount > 0 && (
            <span>
              {t("请求", "req")} {reqCount} · ✓{okCount}
              {failCount > 0 && <span className="sidebar-statusbar__fail"> · ✗{failCount}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
