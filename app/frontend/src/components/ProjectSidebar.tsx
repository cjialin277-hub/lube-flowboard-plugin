import { useEffect, useRef, useState } from "react";
import { useBoardStore } from "../store/board";
import { AccountPanel } from "./AccountPanel";
import { StatusBar } from "./StatusBar";
import { displayBoardName, useLang } from "../i18n";
import {
  getFlowSyncStatus,
  setPinnedFlowProject,
  syncBoardsUpToFlow,
  type BoardFlowStatus,
  type FlowListingStatus,
  type SyncStatusResponse,
} from "../api/client";
import { useGenerationStore } from "../store/generation";

/**
 * Left sidebar listing every local "project" (Board). Click an item to
 * switch the active board; the canvas re-loads its nodes/edges. Provides
 * inline create / rename / delete (with confirm) — all backed by the
 * /api/boards CRUD that already cascades to children on delete.
 */
export function ProjectSidebar() {
  const boards = useBoardStore((s) => s.boards);
  const activeId = useBoardStore((s) => s.boardId);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const deleteBoardById = useBoardStore((s) => s.deleteBoardById);
  const renameBoard = useBoardStore((s) => s.renameBoard);
  const { lang, t } = useLang();

  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newDialogName, setNewDialogName] = useState("");
  const [newDialogBusy, setNewDialogBusy] = useState(false);
  const newDialogInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Flow project sync — one-way (local → Flow). The map tracks which local
  // boards still have a live Flow project; the sync button used to create a
  // Flow project for any board that was missing one.
  //
  // Since the September 2026 Flow migration neither half is possible: Flow
  // exposes no RPC to list a user's projects or to create one. `flowListing`
  // carries the agent's verdict so the button can explain that instead of
  // firing a request that answers 501.
  const [flowStatus, setFlowStatus] = useState<Map<number, BoardFlowStatus>>(
    () => new Map(),
  );
  const [flowListing, setFlowListing] = useState<FlowListingStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [quickPinOpen, setQuickPinOpen] = useState(false);
  const [quickPinDraft, setQuickPinDraft] = useState("");
  const [quickPinSaving, setQuickPinSaving] = useState(false);

  async function handleQuickPinSave() {
    const raw = quickPinDraft.trim();
    if (!raw || quickPinSaving) return;
    setQuickPinSaving(true);
    setSyncError(null);
    setSyncSummary(null);
    try {
      const res = await setPinnedFlowProject(raw);
      useGenerationStore.setState({ projectId: null });
      await refreshStatus();
      const uMatch = raw.match(/\/u\/\d+/)?.[0];
      setSyncSummary(
        t(
          `✓ 已替换 Flow 项目为 ${(res.flow_project_id ?? "").slice(0, 8)}…${uMatch ? ` (${uMatch}/ 多账号)` : ""}`,
          `✓ Switched Flow project to ${(res.flow_project_id ?? "").slice(0, 8)}…`,
        ),
      );
      setQuickPinOpen(false);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "替换失败");
    } finally {
      setQuickPinSaving(false);
    }
  }

  async function refreshStatus(): Promise<SyncStatusResponse> {
    const res = await getFlowSyncStatus();
    setFlowStatus(new Map(res.board_status.map((b) => [b.board_id, b])));
    setFlowListing(res.flow_listing ?? null);
    return res;
  }

  async function handleSyncClick() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncSummary(null);
    try {
      // Refresh status, then push any orphans up to Flow in one shot.
      const res = await refreshStatus();
      if (res.flow_listing && !res.flow_listing.available) {
        // Listing went away between the render that showed this button and
        // the click. Nothing to push — Flow cannot create a project to push
        // into — so say so rather than calling sync-up for a guaranteed 501.
        setSyncSummary(
          res.flow_listing.pinned_project_id
            ? "Flow no longer creates projects — all boards use the pinned one"
            : "Flow no longer creates projects — set one in Settings → Google Flow project",
        );
        return;
      }
      // `exists_on_flow` is null when the check could not run; only a hard
      // false means the board's project is genuinely gone.
      const orphans = res.board_status.filter(
        (b) => b.exists_on_flow === false,
      ).length;
      if (orphans === 0) {
        setSyncSummary("All boards already on Flow ✓");
      } else {
        const res = await syncBoardsUpToFlow();
        await refreshStatus();
        const ok = res.synced.length;
        const fail = res.failed.length;
        setSyncSummary(
          fail === 0
            ? `Pushed ${ok} board${ok !== 1 ? "s" : ""} to Flow ✓`
            : `Pushed ${ok}, ${fail} failed — see agent log`,
        );
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  }

  // First-mount status read — best-effort, silent on failure (extension
  // might not be connected yet; user can hit the button to retry).
  useEffect(() => {
    refreshStatus().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (renamingId !== null) {
      setTimeout(() => renameInputRef.current?.select(), 30);
    }
  }, [renamingId]);

  // Click-outside closes the kebab menu.
  useEffect(() => {
    if (openMenuId === null) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".project-sidebar__menu") && !t.closest(".project-sidebar__kebab")) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openMenuId]);

  function handleNew() {
    setNewDialogName(t("新剧集画布", "Untitled"));
    setNewDialogOpen(true);
    setTimeout(() => newDialogInputRef.current?.select(), 30);
  }

  function closeNewDialog() {
    if (newDialogBusy) return;
    setNewDialogOpen(false);
    setNewDialogName("");
  }

  async function commitNewDialog() {
    if (newDialogBusy) return;
    const name = newDialogName.trim() || t("未命名画布", "Untitled");
    setNewDialogBusy(true);
    try {
      await createNewBoard(name);
    } finally {
      setNewDialogBusy(false);
      setNewDialogOpen(false);
      setNewDialogName("");
    }
  }

  // Esc closes the new-project dialog.
  useEffect(() => {
    if (!newDialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNewDialog();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDialogOpen, newDialogBusy]);

  function startRename(id: number, currentName: string) {
    setRenamingId(id);
    setRenameDraft(currentName);
    setOpenMenuId(null);
  }

  async function commitRename() {
    if (renamingId === null) return;
    const name = renameDraft.trim();
    if (!name) {
      setRenamingId(null);
      return;
    }
    // Only the active board can be renamed via the existing renameBoard
    // action; for other boards, switch first then rename. Keeps the
    // backend round-trip simple.
    if (renamingId !== activeId) {
      await switchBoard(renamingId);
    }
    await renameBoard(name);
    setRenamingId(null);
  }

  function openDeleteConfirm(id: number, name: string) {
    setOpenMenuId(null);
    setDeleteTarget({ id, name });
  }

  async function commitDelete() {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteBoardById(deleteTarget.id);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  function cancelDelete() {
    if (deleteBusy) return;
    setDeleteTarget(null);
  }

  // Esc closes the delete-confirm dialog.
  useEffect(() => {
    if (!deleteTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDelete();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteTarget, deleteBusy]);

  return (
    <aside className={`project-sidebar${collapsed ? " project-sidebar--collapsed" : ""}`}>
      <div className="project-sidebar__header">
        {!collapsed && (
          <div className="project-sidebar__heading">
            <span className="project-sidebar__title">{t("项目画布", "Projects")}</span>
            <span className="project-sidebar__count">{boards.length}</span>
          </div>
        )}
        <button
          type="button"
          className="project-sidebar__icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? t("展开侧边栏", "Expand sidebar") : t("收起侧边栏", "Collapse sidebar")}
          title={collapsed ? t("展开", "Expand") : t("收起", "Collapse")}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <path d="M6.5 2.5v11" />
          </svg>
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="project-sidebar__row">
            <button
              type="button"
              className="project-sidebar__new"
              onClick={handleNew}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M8 3v10M3 8h10" />
              </svg>
              <span>{t("新建画布", "New project")}</span>
            </button>
            {/* Only rendered while Flow can actually be listed / written to.
                On the current transport it never can, and sync-up answers
                501 every time — a button whose only outcome is a refusal is
                worse than the line below, which names the fix. It comes back
                by itself if flow_sdk ever regains the RPC. */}
            {flowListing?.available && (
              <button
                type="button"
                className="project-sidebar__sync"
                onClick={handleSyncClick}
                disabled={syncing}
                title="Push every local board up to Google Flow — creates a Flow project for any board that's missing one"
                aria-label="Sync local boards up to Google Flow"
              >
                {syncing ? "…" : "↻"}
              </button>
            )}
          </div>
          {flowListing && !flowListing.available && (
            <>
              <button
                type="button"
                className={`project-sidebar__flow-pill${
                  flowListing.pinned_project_id ? " project-sidebar__flow-pill--pinned" : ""
                }`}
                style={{ cursor: "pointer", width: "100%", textAlign: "left" }}
                onClick={() => {
                  setQuickPinDraft(flowListing.pinned_project_id ?? "");
                  setQuickPinOpen((o) => !o);
                }}
                title={t(
                  "点击直接粘贴或替换 Google Flow 项目链接（支持 /u/1/project/... 多账号地址）",
                  "Click to paste or replace Google Flow project URL or UUID",
                )}
              >
                <span className="project-sidebar__flow-pill-dot" aria-hidden="true" />
                <span className="project-sidebar__flow-pill-text">
                  {flowListing.pinned_project_id
                    ? t(
                        `已绑定 Flow (${flowListing.pinned_project_id.slice(0, 8)}…) · 点此替换`,
                        `Flow (${flowListing.pinned_project_id.slice(0, 8)}…) · Replace`,
                      )
                    : t("Flow 未绑定 · 点此粘贴项目链接", "Flow unpinned · Click to bind")}
                </span>
              </button>
              {quickPinOpen && (
                <div className="project-sidebar__quick-pin" style={{ padding: "6px 10px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
                  <input
                    type="text"
                    className="settings-panel__project-input"
                    style={{ fontSize: 11, padding: "5px 8px" }}
                    value={quickPinDraft}
                    onChange={(e) => setQuickPinDraft(e.target.value)}
                    placeholder={t("粘贴 https://flow.google.com/u/1/project/...", "Paste Flow project URL or UUID")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleQuickPinSave();
                      if (e.key === "Escape") setQuickPinOpen(false);
                    }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="settings-panel__project-btn"
                      style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                      disabled={quickPinSaving || !quickPinDraft.trim()}
                      onClick={() => void handleQuickPinSave()}
                    >
                      {quickPinSaving ? t("替换中…", "Saving…") : t("一键替换项目", "Replace Project")}
                    </button>
                    <button
                      type="button"
                      className="composer-dock-mini-btn"
                      style={{ fontSize: 11, padding: "4px 8px" }}
                      onClick={() => setQuickPinOpen(false)}
                    >
                      {t("取消", "Cancel")}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {syncError && (
            <div className="project-sidebar__sync-error" role="status">
              Flow sync: {syncError}
            </div>
          )}
          {syncSummary && !syncError && (
            <div className="project-sidebar__sync-ok" role="status">
              {syncSummary}
            </div>
          )}
          <ul className="project-sidebar__list">
            {boards.map((b) => {
              const isActive = b.id === activeId;
              const isRenaming = b.id === renamingId;
              const status = flowStatus.get(b.id);
              // Orphan = bound flow_project_id is missing from Flow's
              // remote list. We only flag once we've synced at least
              // once (status is present); pre-sync state is "unknown".
              const isOrphan =
                status !== undefined
                && status.flow_project_id !== null
                && status.exists_on_flow === false;
              return (
                <li
                  key={b.id}
                  className={`project-sidebar__item${isActive ? " project-sidebar__item--active" : ""}`}
                >
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="project-sidebar__rename-input"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="project-sidebar__name"
                        onClick={() => switchBoard(b.id)}
                        title={
                          isOrphan
                            ? t(
                                `${b.name} — 绑定的 Flow 项目不存在，请在 ⚙ 设置中更新 UUID。`,
                                `${b.name} — Flow project not found. Update UUID in Settings.`,
                              )
                            : displayBoardName(b.name, lang)
                        }
                      >
                        <svg className="project-sidebar__item-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                          <path d="M6 6h4M6 10h2.5" />
                        </svg>
                        <span className="project-sidebar__name-text">{displayBoardName(b.name, lang)}</span>
                        {isOrphan && (
                          <span
                            className="project-sidebar__orphan-badge"
                            title="Flow project not found — pin a new one in Settings → Google Flow project"
                            aria-label="orphan"
                          >
                            !
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="project-sidebar__kebab"
                        onClick={() =>
                          setOpenMenuId((cur) => (cur === b.id ? null : b.id))
                        }
                        aria-label="Project actions"
                      >
                        ⋯
                      </button>
                      {openMenuId === b.id && (
                        <div className="project-sidebar__menu" role="menu">
                          <button
                            type="button"
                            onClick={() => startRename(b.id, b.name)}
                          >
                            {t("重命名", "Rename")}
                          </button>
                          <button
                            type="button"
                            className="project-sidebar__menu-danger"
                            onClick={() => openDeleteConfirm(b.id, b.name)}
                          >
                            {t("删除", "Delete")}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
            {boards.length === 0 && (
              <li className="project-sidebar__empty">{t("暂无画布项目", "No projects yet")}</li>
            )}
          </ul>
        </>
      )}

      {/* Pinned-bottom service status + account chip — sits below the project
          list because the list above has flex: 1 and pushes everything that
          follows to the bottom of the column. */}
      <StatusBar collapsed={collapsed} />
      <AccountPanel
        collapsed={collapsed}
        onFlowProjectChange={() => {
          refreshStatus().catch(() => {});
        }}
      />

      {deleteTarget && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) cancelDelete();
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-title"
          >
            <h2 id="delete-project-title" className="project-modal__title">
              {t("确认删除画布？", "Delete project?")}
            </h2>
            <p className="project-modal__hint">
              {t(
                `画布「${displayBoardName(deleteTarget.name, lang)}」及其内部所有节点、连线和生成记录将被永久删除，无法恢复。`,
                `"${deleteTarget.name}" and all its nodes, edges, and generation records will be permanently deleted.`,
              )}
            </p>
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__btn"
                onClick={cancelDelete}
                disabled={deleteBusy}
              >
                {t("取消", "Cancel")}
              </button>
              <button
                type="button"
                className="project-modal__btn project-modal__btn--danger"
                onClick={commitDelete}
                disabled={deleteBusy}
                autoFocus
              >
                {deleteBusy ? t("删除中…", "Deleting…") : t("确认删除", "Delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {newDialogOpen && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeNewDialog();
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
          >
            <h2 id="new-project-title" className="project-modal__title">
              {t("新建项目画布", "New project")}
            </h2>
            <p className="project-modal__hint">
              {t("画布名称会显示在左侧列表中，随时可以修改。", "Shown in the left sidebar. You can rename it anytime.")}
            </p>
            <input
              ref={newDialogInputRef}
              className="project-modal__input"
              type="text"
              maxLength={80}
              value={newDialogName}
              onChange={(e) => setNewDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNewDialog();
                if (e.key === "Escape") closeNewDialog();
              }}
              placeholder={t("输入剧集/场次名称…", "Untitled")}
              disabled={newDialogBusy}
              autoFocus
            />
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__btn"
                onClick={closeNewDialog}
                disabled={newDialogBusy}
              >
                {t("取消", "Cancel")}
              </button>
              <button
                type="button"
                className="project-modal__btn project-modal__btn--primary"
                onClick={commitNewDialog}
                disabled={newDialogBusy}
              >
                {newDialogBusy ? t("创建中…", "Creating…") : t("创建画布", "Create")}
              </button>
            </div>
          </div>
        </div>
      )}

    </aside>
  );
}
