import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd';
import {
  boardApi,
  COLUMN_COLORS,
  type BoardColumn,
  type BoardIssue,
  type BoardView,
} from '@/shared/lib/boardApi';

const DOT: Record<string, string> = {
  gray: 'bg-neutral-400',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  green: 'bg-emerald-500',
  rose: 'bg-rose-500',
  amber: 'bg-amber-500',
  teal: 'bg-teal-500',
};

/**
 * 本地看板页。
 *
 * 列（状态）可配置：新建、改名、换色、左右移动、删除。
 * 卡片通过 column_id 归属列；拖拽或 ‹ › 按钮跨列即改状态。
 */
export function BoardPage() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const navigate = useNavigate();

  const [board, setBoard] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeIssue, setActiveIssue] = useState<BoardIssue | null>(null);
  const [composingIn, setComposingIn] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [menuColumn, setMenuColumn] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');

  const handleError = useCallback(
    (e: unknown) => {
      const err = e as Error & { status?: number };
      if (err.status === 401) {
        navigate({ to: '/login' });
        return;
      }
      setError(err.message);
    },
    [navigate]
  );

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setBoard(await boardApi.getBoard(projectId));
      setError(null);
    } catch (e) {
      handleError(e);
    } finally {
      setLoading(false);
    }
  }, [projectId, handleError]);

  useEffect(() => {
    void load();
  }, [load]);

  /** column_id → 卡片列表 */
  const byColumn = useMemo(() => {
    const groups = new Map<string, BoardIssue[]>();
    board?.columns.forEach((c) => groups.set(c.id, []));
    board?.issues.forEach((issue) => {
      const key =
        issue.column_id && groups.has(issue.column_id)
          ? issue.column_id
          : (board?.columns[0]?.id ?? '');
      const list = groups.get(key) ?? [];
      list.push(issue);
      groups.set(key, list);
    });
    return groups;
  }, [board]);

  const moveIssueTo = async (issue: BoardIssue, columnId: string) => {
    if (issue.column_id === columnId) return;
    try {
      await boardApi.updateIssue(issue.id, { column_id: columnId });
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const onDragEnd = async (result: DropResult) => {
    const { destination, draggableId } = result;
    if (!destination) return;
    const issue = board?.issues.find((i) => i.id === draggableId);
    if (!issue) return;
    await moveIssueTo(issue, destination.droppableId);
  };

  const addCard = async (columnId: string) => {
    if (!projectId || !draftTitle.trim()) return;
    try {
      await boardApi.createIssue(projectId, {
        title: draftTitle.trim(),
        column_id: columnId,
      });
      setDraftTitle('');
      setComposingIn(null);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const saveIssue = async (
    issue: BoardIssue,
    patch: { title?: string; description?: string; column_id?: string }
  ) => {
    try {
      await boardApi.updateIssue(issue.id, patch);
      setActiveIssue(null);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const removeIssue = async (issue: BoardIssue) => {
    if (!window.confirm(`删除任务卡「${issue.title}」？`)) return;
    try {
      await boardApi.deleteIssue(issue.id);
      setActiveIssue(null);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  // --- 列管理 ---
  const addColumn = async () => {
    if (!projectId || !newColumnName.trim()) return;
    try {
      await boardApi.createColumn(projectId, { name: newColumnName.trim() });
      setNewColumnName('');
      setAddingColumn(false);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const renameColumn = async (column: BoardColumn) => {
    const name = window.prompt('列名称', column.name);
    if (!name || !name.trim() || name === column.name) return;
    try {
      await boardApi.updateColumn(column.id, { name: name.trim() });
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const recolorColumn = async (column: BoardColumn) => {
    const color = window.prompt(
      `配色（${COLUMN_COLORS.join(' / ')}）`,
      column.color
    );
    if (!color || !COLUMN_COLORS.includes(color as (typeof COLUMN_COLORS)[number])) {
      return;
    }
    try {
      await boardApi.updateColumn(column.id, { color });
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const moveColumn = async (column: BoardColumn, delta: number) => {
    if (!board) return;
    const index = board.columns.findIndex((c) => c.id === column.id);
    const target = board.columns[index + delta];
    if (!target) return;
    try {
      await boardApi.updateColumn(column.id, { position: target.position });
      await boardApi.updateColumn(target.id, { position: column.position });
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const removeColumn = async (column: BoardColumn) => {
    if (!window.confirm(`删除列「${column.name}」？其卡片会移到第一列。`)) return;
    try {
      await boardApi.deleteColumn(column.id);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  if (loading) {
    return <p className="p-double text-base text-low">加载看板中…</p>;
  }
  if (!board) {
    return <p className="p-double text-base text-error">{error ?? '看板加载失败'}</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-base border-b px-double py-base">
        <div className="flex items-center gap-base">
          <button
            onClick={() => navigate({ to: '/board' })}
            className="rounded border px-base py-half text-sm text-low hover:text-normal"
          >
            ← 项目
          </button>
          <h1 className="text-xl font-semibold text-high">{board.project.name}</h1>
          <span className="text-sm text-low">
            {board.issues.length} 张卡 · {board.columns.length} 个状态
          </span>
        </div>
        {error && <span className="text-sm text-error">{error}</span>}
      </header>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex flex-1 gap-base overflow-x-auto p-base">
          {board.columns.map((column, index) => (
            <Column
              key={column.id}
              column={column}
              index={index}
              total={board.columns.length}
              issues={byColumn.get(column.id) ?? []}
              composing={composingIn === column.id}
              draftTitle={draftTitle}
              menuOpen={menuColumn === column.id}
              onToggleMenu={() =>
                setMenuColumn(menuColumn === column.id ? null : column.id)
              }
              onDraftChange={setDraftTitle}
              onStartCompose={() => {
                setComposingIn(column.id);
                setDraftTitle('');
              }}
              onCancelCompose={() => setComposingIn(null)}
              onSubmitCompose={() => addCard(column.id)}
              onOpenIssue={setActiveIssue}
              onMoveIssue={(issue, delta) => {
                const next = board.columns[index + delta];
                if (next) void moveIssueTo(issue, next.id);
              }}
              onRename={() => renameColumn(column)}
              onRecolor={() => recolorColumn(column)}
              onMoveColumn={(delta) => moveColumn(column, delta)}
              onDelete={() => removeColumn(column)}
            />
          ))}

          {/* 新建列 */}
          <div className="flex w-64 shrink-0 flex-col">
            {addingColumn ? (
              <div className="rounded-lg border bg-secondary p-base">
                <input
                  autoFocus
                  value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addColumn();
                    if (e.key === 'Escape') setAddingColumn(false);
                  }}
                  placeholder="新状态名称，回车创建"
                  className="w-full bg-transparent text-base text-high outline-none placeholder:text-low"
                />
                <div className="mt-base flex justify-end gap-base">
                  <button
                    onClick={() => setAddingColumn(false)}
                    className="text-sm text-low hover:text-normal"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void addColumn()}
                    className="rounded bg-brand px-base py-half text-sm text-white"
                  >
                    创建
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingColumn(true)}
                className="rounded-lg border border-dashed px-base py-base text-sm text-low hover:text-normal"
              >
                + 新建状态列
              </button>
            )}
          </div>
        </div>
      </DragDropContext>

      {activeIssue && (
        <IssuePanel
          issue={activeIssue}
          columns={board.columns}
          onClose={() => setActiveIssue(null)}
          onSave={(patch) => saveIssue(activeIssue, patch)}
          onDelete={() => removeIssue(activeIssue)}
        />
      )}
    </div>
  );
}

function Column({
  column,
  index,
  total,
  issues,
  composing,
  draftTitle,
  menuOpen,
  onToggleMenu,
  onDraftChange,
  onStartCompose,
  onCancelCompose,
  onSubmitCompose,
  onOpenIssue,
  onMoveIssue,
  onRename,
  onRecolor,
  onMoveColumn,
  onDelete,
}: {
  column: BoardColumn;
  index: number;
  total: number;
  issues: BoardIssue[];
  composing: boolean;
  draftTitle: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onDraftChange: (v: string) => void;
  onStartCompose: () => void;
  onCancelCompose: () => void;
  onSubmitCompose: () => void;
  onOpenIssue: (issue: BoardIssue) => void;
  onMoveIssue: (issue: BoardIssue, delta: number) => void;
  onRename: () => void;
  onRecolor: () => void;
  onMoveColumn: (delta: number) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg bg-panel">
      <div className="relative flex items-center gap-base px-base py-base">
        <span className={`h-2 w-2 rounded-full ${DOT[column.color] ?? DOT.gray}`} />
        <span className="text-base font-medium text-normal">{column.name}</span>
        <span className="text-sm text-low">{issues.length}</span>
        <button
          onClick={onStartCompose}
          title="新增任务卡"
          className="ml-auto text-lg leading-none text-low hover:text-normal"
        >
          +
        </button>
        <button
          onClick={onToggleMenu}
          title="列设置"
          className="text-base leading-none text-low hover:text-normal"
        >
          ⋯
        </button>

        {menuOpen && (
          <div className="absolute right-base top-full z-30 w-40 rounded border bg-secondary py-half shadow-lg">
            {[
              { label: '重命名', action: onRename },
              { label: '换个颜色', action: onRecolor },
              {
                label: '左移',
                action: () => onMoveColumn(-1),
                disabled: index === 0,
              },
              {
                label: '右移',
                action: () => onMoveColumn(1),
                disabled: index === total - 1,
              },
              {
                label: '删除此列',
                action: onDelete,
                disabled: total <= 1,
                danger: true,
              },
            ].map((item) => (
              <button
                key={item.label}
                disabled={item.disabled}
                onClick={() => {
                  onToggleMenu();
                  item.action();
                }}
                className={`block w-full px-base py-half text-left text-sm ${
                  item.disabled
                    ? 'cursor-not-allowed text-low opacity-50'
                    : item.danger
                      ? 'text-error hover:bg-panel'
                      : 'text-normal hover:bg-panel'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 space-y-base overflow-y-auto px-base pb-base ${
              snapshot.isDraggingOver ? 'bg-secondary' : ''
            }`}
          >
            {issues.map((issue, idx) => (
              <Draggable key={issue.id} draggableId={issue.id} index={idx}>
                {(dragProvided, dragSnapshot) => (
                  <div
                    ref={dragProvided.innerRef}
                    {...dragProvided.draggableProps}
                    {...dragProvided.dragHandleProps}
                    onClick={() => onOpenIssue(issue)}
                    className={`cursor-pointer rounded border bg-primary p-base text-base text-normal shadow-sm ${
                      dragSnapshot.isDragging ? 'ring-2 ring-brand' : ''
                    }`}
                  >
                    <div className="flex items-start gap-half">
                      <div className="flex-1 font-medium">{issue.title}</div>
                      <div className="flex shrink-0 gap-half">
                        <button
                          title="移到上一列"
                          onClick={(e) => {
                            e.stopPropagation();
                            onMoveIssue(issue, -1);
                          }}
                          className="rounded border px-half text-sm text-low hover:text-normal"
                        >
                          ‹
                        </button>
                        <button
                          title="移到下一列"
                          onClick={(e) => {
                            e.stopPropagation();
                            onMoveIssue(issue, 1);
                          }}
                          className="rounded border px-half text-sm text-low hover:text-normal"
                        >
                          ›
                        </button>
                      </div>
                    </div>
                    {issue.description && (
                      <div className="mt-half line-clamp-2 text-sm text-low">
                        {issue.description}
                      </div>
                    )}
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}

            {composing && (
              <div className="rounded border bg-secondary p-half">
                <textarea
                  autoFocus
                  rows={2}
                  value={draftTitle}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onSubmitCompose();
                    }
                    if (e.key === 'Escape') onCancelCompose();
                  }}
                  placeholder="任务标题，回车保存"
                  className="w-full resize-none bg-transparent text-base text-high outline-none placeholder:text-low"
                />
                <div className="mt-half flex justify-end gap-base">
                  <button
                    onClick={onCancelCompose}
                    className="text-sm text-low hover:text-normal"
                  >
                    取消
                  </button>
                  <button
                    onClick={onSubmitCompose}
                    className="rounded bg-brand px-base py-half text-sm text-white"
                  >
                    添加
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}

function IssuePanel({
  issue,
  columns,
  onClose,
  onSave,
  onDelete,
}: {
  issue: BoardIssue;
  columns: BoardColumn[];
  onClose: () => void;
  onSave: (patch: { title?: string; description?: string; column_id?: string }) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? '');
  const [columnId, setColumnId] = useState(issue.column_id ?? columns[0]?.id ?? '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-base">
      <div className="w-full max-w-lg rounded-lg bg-secondary p-double shadow-lg">
        <h2 className="text-lg font-semibold text-high">编辑任务卡</h2>

        <label className="mt-base block">
          <span className="text-sm font-medium text-low">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-half w-full rounded border bg-primary px-base py-half text-base text-high outline-none focus:ring-1 focus:ring-brand"
          />
        </label>

        <label className="mt-base block">
          <span className="text-sm font-medium text-low">描述</span>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-half w-full resize-y rounded border bg-primary px-base py-half text-base text-high outline-none focus:ring-1 focus:ring-brand"
          />
        </label>

        <label className="mt-base block">
          <span className="text-sm font-medium text-low">状态</span>
          <select
            value={columnId}
            onChange={(e) => setColumnId(e.target.value)}
            className="mt-half w-full rounded border bg-primary px-base py-half text-base text-high outline-none focus:ring-1 focus:ring-brand"
          >
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-double flex items-center justify-between">
          <button onClick={onDelete} className="text-base text-error hover:opacity-80">
            删除
          </button>
          <div className="flex gap-base">
            <button
              onClick={onClose}
              className="rounded border px-base py-half text-base text-normal"
            >
              取消
            </button>
            <button
              onClick={() => onSave({ title, description, column_id: columnId })}
              className="rounded bg-brand px-double py-half text-base font-medium text-white"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}