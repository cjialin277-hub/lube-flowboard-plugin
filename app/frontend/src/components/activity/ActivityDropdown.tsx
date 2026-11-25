import { useEffect, useRef } from "react";
import type { ActivityListItem } from "../../api/client";
import { ActivityRow } from "./ActivityRow";
import { useLang } from "../../i18n";

interface ActivityDropdownProps {
  items: ActivityListItem[];
  loading: boolean;
  nextBeforeId: number | null;
  onLoadMore(): void;
  onClose(): void;
  onSelect(id: number): void;
  onCancel?(id: number): Promise<void>;
}

export function ActivityDropdown({
  items,
  loading,
  nextBeforeId,
  onLoadMore,
  onClose,
  onSelect,
  onCancel,
}: ActivityDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { t } = useLang();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Use capture phase so the bell's own click isn't fired again as
    // the dropdown is closing.
    setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [onClose]);

  return (
    <div ref={panelRef} className="activity-dropdown" role="dialog" aria-label="Activity">
      <div className="activity-dropdown__header">
        <span className="activity-dropdown__title">{t("后台任务记录", "Activity")}</span>
        <span className="activity-dropdown__count">
          {t(`共 ${items.length} 条`, `${items.length} ${items.length === 1 ? "item" : "items"}`)}
        </span>
        <button
          type="button"
          className="activity-dropdown__close"
          onClick={onClose}
          aria-label="Close activity"
        >
          ×
        </button>
      </div>

      <div className="activity-dropdown__list">
        {loading && items.length === 0 && (
          <div className="activity-dropdown__placeholder">{t("加载中…", "Loading…")}</div>
        )}
        {!loading && items.length === 0 && (
          <div className="activity-dropdown__placeholder">
            {t("暂无生成记录。点击任意节点生成图片或视频后会在此实时显示进度。", "No activity yet. Run a generation to populate the feed.")}
          </div>
        )}
        {items.map((item) => (
          <ActivityRow
            key={item.id}
            item={item}
            onClick={() => onSelect(item.id)}
            onCancel={onCancel}
          />
        ))}
      </div>

      {nextBeforeId !== null && (
        <button
          type="button"
          className="activity-dropdown__load-more"
          onClick={onLoadMore}
        >
          {t("加载更多 (50条)", "Load 50 more")}
        </button>
      )}
    </div>
  );
}
