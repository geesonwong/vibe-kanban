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
  type BoardColumn,
  type BoardIssue,
  type BoardView,
} from '@/shared/lib/boardApi';

const COLUMN_ACCENT: Record<string, string> = {
  todo: 'bg-neutral-400',
  inprogress: 'bg-blue-500',
  inreview: 'bg-violet-500',
  done: 'bg-emerald-500',
  cancelled: 'bg-rose-500',
};

/**
 * 本地看板页：把「项目 → 任务卡」从云端搬回本地后的主界面。
 *
 * 交互：拖拽卡片跨列 = 改状态（PATCH /api/board/issues/:id）；
 * 列底部「+」= 新增卡片；点卡片 = 打开编辑面板。
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

  const byColumn = useMemo(() => {
    const groups = new Map<string, BoardIssue[]>();
    board?.columns.forEach((c) => groups.set(c.id, []));
    board?.issues.forEach((issue) => {
      const list = groups.get(issue.status) ?? [];
      list.push(issue);
      groups.set(issue.status, list);
    });
    return groups;
  }, [board]);

  const onDragEnd = async (result: DropResult) => {
    const { destination, draggableId } = result;
    if (!destination || !board) return;
    const issue = board.issues.find((i) => i.id === draggableId);
    if (!issue || issue.status === destination.droppableId) return;

    const nextStatus = destination.droppableId;
    // 乐观更新
    setBoard({
      ...board,
      issues: board.issues.map((i) =>
        i.id === draggableId ? { ...i, status: nextStatus } : i
      ),
    });

    try {
      await boardApi.updateIssue(draggableId, { status: nextStatus });
    } catch (e) {
      handleError(e);
      await load();
    }
  };

  const moveBy = async (issue: BoardIssue, delta: number) => {
    if (!board) return;
    const index = board.columns.findIndex((c) => c.id === issue.status);
    const next = board.columns[index + delta];
    if (!next) return;
    try {
      await boardApi.updateIssue(issue.id, { status: next.id });
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const addCard = async (columnId: string) => {
    if (!projectId || !draftTitle.trim()) return;
    try {
      await boardApi.createIssue(projectId, {
        title: draftTitle.trim(),
        status: columnId,
      });
      setDraftTitle('');
      setComposingIn(null);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const saveIssue = async (issue: BoardIssue, patch: Partial<BoardIssue>) => {
    try {
      await boardApi.updateIssue(issue.id, {
        title: patch.title,
        description: patch.description ?? undefined,
        status: patch.status,
      });
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

  if (loading) {
    return <p className="p-double text-base text-neutral-500">加载看板中…</p>;
  }
  if (!board) {
    return (
      <p className="p-double text-base text-error">
        {error ?? '看板加载失败'}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-base border-b border px-double py-base">
        <div className="flex items-center gap-base">
          <button
            onClick={() => navigate({ to: '/board' })}
            className="rounded-md border border px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
          >
            ← 项目
          </button>
          <h1 className="text-lg font-semibold text-high">
            {board.project.name}
          </h1>
          <span className="text-sm text-low">
            {board.issues.length} 张卡
          </span>
        </div>
        {error && <span className="text-sm text-error">{error}</span>}
      </header>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex flex-1 gap-base overflow-x-auto p-base">
          {board.columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              issues={byColumn.get(column.id) ?? []}
              composing={composingIn === column.id}
              draftTitle={draftTitle}
              onDraftChange={setDraftTitle}
              onStartCompose={() => {
                setComposingIn(column.id);
                setDraftTitle('');
              }}
              onCancelCompose={() => setComposingIn(null)}
              onSubmitCompose={() => addCard(column.id)}
              onOpenIssue={setActiveIssue}
              onMove={(issue, delta) => moveBy(issue, delta)}
            />
          ))}
        </div>
      </DragDropContext>

      {activeIssue && (
        <IssuePanel
          issue={activeIssue}
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
  issues,
  composing,
  draftTitle,
  onDraftChange,
  onStartCompose,
  onCancelCompose,
  onSubmitCompose,
  onOpenIssue,
  onMove,
}: {
  column: BoardColumn;
  issues: BoardIssue[];
  composing: boolean;
  draftTitle: string;
  onDraftChange: (v: string) => void;
  onStartCompose: () => void;
  onCancelCompose: () => void;
  onSubmitCompose: () => void;
  onOpenIssue: (issue: BoardIssue) => void;
  onMove: (issue: BoardIssue, delta: number) => void;
}) {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg bg-panel">
      <div className="flex items-center gap-half px-3 py-3">
        <span
          className={`h-2 w-2 rounded-full ${COLUMN_ACCENT[column.id] ?? 'bg-neutral-400'}`}
        />
        <span className="text-base font-medium text-normal">
          {column.name}
        </span>
        <span className="text-sm text-low">{issues.length}</span>
        <button
          onClick={onStartCompose}
          className="ml-auto text-lg leading-none text-low hover:text-neutral-700"
          title="新增任务卡"
        >
          +
        </button>
      </div>

      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 space-y-2 overflow-y-auto px-2 pb-2 ${
              snapshot.isDraggingOver ? 'bg-secondary' : ''
            }`}
          >
            {issues.map((issue, index) => (
              <Draggable key={issue.id} draggableId={issue.id} index={index}>
                {(dragProvided, dragSnapshot) => (
                  <div
                    ref={dragProvided.innerRef}
                    {...dragProvided.draggableProps}
                    {...dragProvided.dragHandleProps}
                    onClick={() => onOpenIssue(issue)}
                    className={`cursor-pointer rounded-lg border border bg-secondary p-base text-base text-neutral-800 shadow-sm transition ${
                      dragSnapshot.isDragging ? 'ring-2 ring-neutral-400' : ''
                    }`}
                  >
                    <div className="flex items-start gap-half">
                      <div className="flex-1 font-medium">{issue.title}</div>
                      <div className="flex shrink-0 gap-half">
                        <button
                          title="移到上一列"
                          onClick={(e) => {
                            e.stopPropagation();
                            onMove(issue, -1);
                          }}
                          className="rounded border px-half text-sm text-low hover:text-normal"
                        >
                          ‹
                        </button>
                        <button
                          title="移到下一列"
                          onClick={(e) => {
                            e.stopPropagation();
                            onMove(issue, 1);
                          }}
                          className="rounded border px-half text-sm text-low hover:text-normal"
                        >
                          ›
                        </button>
                      </div>
                    </div>
                    {issue.description && (
                      <div className="mt-half line-clamp-half text-sm text-low">
                        {issue.description}
                      </div>
                    )}
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}

            {composing && (
              <div className="rounded-lg border border bg-secondary p-half">
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
                  className="w-full resize-none bg-transparent text-base text-neutral-900 outline-none"
                />
                <div className="mt-half flex justify-end gap-half">
                  <button
                    onClick={onCancelCompose}
                    className="text-sm text-neutral-500 hover:text-neutral-700"
                  >
                    取消
                  </button>
                  <button
                    onClick={onSubmitCompose}
                    className="rounded bg-brand px-2 py-1 text-sm text-white"
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
  onClose,
  onSave,
  onDelete,
}: {
  issue: BoardIssue;
  onClose: () => void;
  onSave: (patch: Partial<BoardIssue>) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? '');
  const [status, setStatus] = useState(issue.status);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-base">
      <div className="w-full max-w-lg rounded-lg bg-secondary p-double shadow-lg">
        <h2 className="text-base font-semibold text-high">
          编辑任务卡
        </h2>

        <label className="mt-base block">
          <span className="text-sm font-medium text-low">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-half w-full rounded-md border border px-3 py-2 text-base outline-none focus:border-neutral-500"
          />
        </label>

        <label className="mt-base block">
          <span className="text-sm font-medium text-low">描述</span>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-half w-full resize-y rounded-md border border px-3 py-2 text-base outline-none focus:border-neutral-500"
          />
        </label>

        <label className="mt-base block">
          <span className="text-sm font-medium text-low">状态</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-half w-full rounded-md border border px-3 py-2 text-base outline-none focus:border-neutral-500"
          >
            <option value="todo">待办</option>
            <option value="inprogress">进行中</option>
            <option value="inreview">待审阅</option>
            <option value="done">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>

        <div className="mt-double flex items-center justify-between">
          <button
            onClick={onDelete}
            className="text-base text-error hover:text-error"
          >
            删除
          </button>
          <div className="flex gap-half">
            <button
              onClick={onClose}
              className="rounded-md border border px-3 py-1.5 text-base text-neutral-700"
            >
              取消
            </button>
            <button
              onClick={() => onSave({ title, description, status })}
              className="rounded-md bg-brand px-4 py-1.5 text-base font-medium text-white"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}