import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl, type ReferenceItem } from "../api/client";
import { useBoardStore } from "../store/board";
import { filterReferences, useReferencesStore } from "../store/references";
import { useLang } from "../i18n";

/**
 * Right-side collapsible reference library.
 *
 * The panel renders a vertical list of saved references — each card is
 * a 64x64 thumbnail + label + shortId tag with hover-revealed actions
 * (pin toggle, rename in-place, delete with confirm). Cards are both
 * clickable (Phase 3 will wire spawn-at-canvas-center) and draggable
 * with a custom `application/x-flowboard-reference` MIME so canvas
 * drop handlers can detect the payload without colliding with the
 * existing file-upload drop path.
 *
 * A fixed-position vertical ★ tab on the right edge toggles the open
 * state, which is persisted to localStorage by the store.
 */
export function ReferencesPanel() {
  const items = useReferencesStore((s) => s.items);
  const loading = useReferencesStore((s) => s.loading);
  const error = useReferencesStore((s) => s.error);
  const panelOpen = useReferencesStore((s) => s.panelOpen);
  const query = useReferencesStore((s) => s.query);
  const setQuery = useReferencesStore((s) => s.setQuery);
  const togglePanel = useReferencesStore((s) => s.togglePanel);
  const remove = useReferencesStore((s) => s.remove);
  const rename = useReferencesStore((s) => s.rename);
  const togglePin = useReferencesStore((s) => s.togglePin);
  const { t } = useLang();

  const filtered = useMemo(() => filterReferences(items, query), [items, query]);

  return (
    <>
      <button
        type="button"
        className={`references-panel__toggle-tab${panelOpen ? " references-panel__toggle-tab--open" : ""}`}
        onClick={togglePanel}
        aria-label={panelOpen ? t("收起素材库", "Collapse references") : t("打开素材库", "Open references")}
        title={panelOpen ? t("收起跨画布素材库", "Collapse library") : t("打开跨画布素材库", "Open library")}
      >
        {panelOpen ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3l5 5-5 5" />
          </svg>
        ) : (
          <>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 2.5h8a1 1 0 011 1v10.5l-5-2.8-5 2.8V3.5a1 1 0 011-1z" />
            </svg>
            <span className="references-panel__toggle-label">{t("素材库", "Refs")}</span>
            {items.length > 0 && (
              <span className="references-panel__toggle-count">{items.length}</span>
            )}
          </>
        )}
      </button>
      <aside
        className={`references-panel${
          panelOpen ? " references-panel--open" : " references-panel--collapsed"
        }`}
        aria-hidden={!panelOpen}
      >
        <div className="references-panel__header">
          <span className="references-panel__title">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 2.5h8a1 1 0 011 1v10.5l-5-2.8-5 2.8V3.5a1 1 0 011-1z" />
            </svg>
            <span>{t("跨画布素材库", "Library")}</span>
          </span>
          <button
            type="button"
            className="references-panel__close"
            onClick={togglePanel}
            aria-label={t("收起素材库", "Collapse references panel")}
            title={t("收起", "Collapse")}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 3l5 5-5 5" />
            </svg>
          </button>
        </div>

        <div className="references-panel__search">
          <input
            type="text"
            placeholder={t("搜索角色 / 道具 / 场景…", "Search references…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("搜索素材", "Search references")}
          />
        </div>

        {error && <div className="references-panel__error">{error}</div>}

        {loading && items.length === 0 && (
          <div className="references-panel__empty">{t("加载中…", "Loading…")}</div>
        )}

        {!loading && items.length === 0 && (
          <div className="references-panel__empty">
            {t("在任意角色或图片卡片上点「★ 收藏」，即可沉淀到这里跨画布拖拽复用。", "Save a variant from any image node to start your library.")}
          </div>
        )}

        {!loading && items.length > 0 && filtered.length === 0 && (
          <div className="references-panel__empty">
            {t(`未找到匹配「${query}」的素材`, `No references match "${query}".`)}
          </div>
        )}

        <ul className="references-panel__list">
          {filtered.map((ref) => (
            <ReferenceCard
              key={ref.id}
              item={ref}
              onRename={(label) => rename(ref.id, label)}
              onTogglePin={() => togglePin(ref.id)}
              onDelete={() => remove(ref.id)}
            />
          ))}
        </ul>
      </aside>
    </>
  );
}

interface ReferenceCardProps {
  // Named `item` rather than `ref` to avoid React's reserved-prop
  // collision (refs are forwarded via a different prop in React 19+).
  item: ReferenceItem;
  onRename(label: string): Promise<void> | void;
  onTogglePin(): Promise<void> | void;
  onDelete(): Promise<void> | void;
}

function ReferenceCard({
  item,
  onRename,
  onTogglePin,
  onDelete,
}: ReferenceCardProps) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.label);
  // Inline 2-step delete confirm: first click arms the button (label →
  // "Confirm?", colour shifts to red), second click within 3s commits
  // the DELETE. Anywhere else (timeout, blur, panel scroll) → revert.
  // Replaces the native window.confirm() which was modal + ugly.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-revert the confirm-armed state after 3s of no second click.
    return () => {
      if (confirmTimerRef.current !== null) {
        clearTimeout(confirmTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (renaming) {
      setDraft(item.label);
      setTimeout(() => inputRef.current?.select(), 20);
    }
  }, [renaming, item.label]);

  function handleDragStart(e: React.DragEvent<HTMLLIElement>) {
    const payload = {
      mediaId: item.mediaId,
      aiBrief: item.aiBrief,
      aspectRatio: item.aspectRatio,
      kind: item.kind,
      label: item.label,
    };
    e.dataTransfer.setData(
      "application/x-flowboard-reference",
      JSON.stringify(payload),
    );
    e.dataTransfer.effectAllowed = "copy";
  }

  async function handleClick() {
    // Click-to-spawn: drop a new visual_asset node onto the canvas at a
    // fixed fallback position. A future polish pass can pipe in the real
    // canvas center via ReactFlow's screenToFlowPosition once it's
    // exposed outside <ReactFlow> (this component lives outside that
    // subtree, so we don't have access to the hook here).
    const pos = { x: 200, y: 200 };
    await useBoardStore.getState().addReferenceNode(
      {
        mediaId: item.mediaId,
        aiBrief: item.aiBrief,
        aspectRatio: item.aspectRatio,
        kind: item.kind,
        label: item.label,
      },
      pos,
    );
  }

  async function commitRename() {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === item.label) return;
    try {
      await onRename(next);
    } catch {
      // Swallow — surface via store.error already.
    }
  }

  function armDeleteConfirm() {
    setConfirmDelete(true);
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
    }
    confirmTimerRef.current = setTimeout(() => {
      setConfirmDelete(false);
      confirmTimerRef.current = null;
    }, 3000);
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    // First click: arm the confirm (visual red + label change). Second
    // click within 3s commits. Timeout → revert.
    if (!confirmDelete) {
      armDeleteConfirm();
      return;
    }
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setDeleting(true);
    try {
      await onDelete();
      // The card unmounts on success — no need to flip state back.
    } catch {
      // Swallow — surfaced via store.error. Revert UI so the user can
      // retry or move on.
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // Short id derived from sourceNodeShortId if present; otherwise show
  // the numeric ref id. Provenance-first because users tend to scan the
  // panel by "which node was this from?".
  const shortIdTag = item.sourceNodeShortId
    ? `#${item.sourceNodeShortId}`
    : `#${item.id}`;

  const tooltip = item.aiBrief
    ? `${item.label}\n\n${item.aiBrief}`
    : item.label;

  return (
    <li
      className="reference-card"
      draggable
      onDragStart={handleDragStart}
      onClick={() => {
        void handleClick();
      }}
      title={tooltip}
    >
      <div className="reference-card__thumb">
        {thumbBroken ? (
          <div className="reference-card__thumb-missing" aria-hidden="true">
            📷
          </div>
        ) : (
          <img
            src={mediaUrl(item.mediaId)}
            alt=""
            onError={() => setThumbBroken(true)}
            draggable={false}
          />
        )}
      </div>

      <div className="reference-card__body">
        {renaming ? (
          <input
            ref={inputRef}
            className="reference-card__rename-input"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setRenaming(false);
                setDraft(item.label);
              }
            }}
          />
        ) : (
          <span className="reference-card__label">{item.label}</span>
        )}
        <span className="reference-card__id">{shortIdTag}</span>
      </div>

      <div className="reference-card__actions">
        <button
          type="button"
          className={`reference-card__action-btn${
            item.pinned ? " reference-card__action-btn--active" : ""
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          aria-label={item.pinned ? "Unpin reference" : "Pin reference"}
          title={item.pinned ? "Unpin" : "Pin to top"}
        >
          {item.pinned ? "★" : "☆"}
        </button>
        <button
          type="button"
          className="reference-card__action-btn"
          onClick={(e) => {
            e.stopPropagation();
            setRenaming(true);
          }}
          aria-label="Rename reference"
          title="Rename"
        >
          ✎
        </button>
        <button
          type="button"
          className={
            "reference-card__action-btn reference-card__action-btn--danger"
            + (confirmDelete ? " reference-card__action-btn--armed" : "")
          }
          onClick={handleDelete}
          disabled={deleting}
          aria-label={
            confirmDelete
              ? "Confirm delete reference"
              : "Delete reference"
          }
          title={
            confirmDelete
              ? "Click again to confirm — auto-cancels in 3s"
              : "Delete (underlying image stays in storage)"
          }
        >
          {deleting ? "…" : confirmDelete ? "Confirm?" : "🗑"}
        </button>
      </div>
    </li>
  );
}
