/**
 * 本地看板与本地登录的 API 客户端。
 *
 * 与云端 `api.ts` 完全隔离：只调用本机 `/api/local-auth/*` 与 `/api/board/*`，
 * 不触发任何已关闭的远程服务。
 */

export interface LocalUser {
  id: string;
  email: string;
  display_name: string;
}

export interface LocalAuthStatus {
  needs_setup: boolean;
  user: LocalUser | null;
}

export interface BoardColumn {
  id: string;
  name: string;
  color: string;
}

export interface BoardProject {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  issue_count: number;
}

export interface BoardIssue {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface BoardView {
  project: BoardProject;
  columns: BoardColumn[];
  issues: BoardIssue[];
}

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 非 JSON 响应（例如 502），下面统一抛错
  }

  const envelope = body as
    | { success?: boolean; data?: T; message?: string | null }
    | null;

  if (!res.ok || envelope?.success === false) {
    const message =
      envelope?.message ||
      (res.status === 401 ? '需要先登录' : `请求失败（HTTP ${res.status}）`);
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }

  return envelope?.data as T;
}

// ---------- 本地登录 ----------

export const localAuthApi = {
  status: () => request<LocalAuthStatus>('/local-auth/status'),

  setup: (payload: { email: string; password: string; display_name: string }) =>
    request<LocalUser>('/local-auth/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  login: (payload: { email: string; password: string }) =>
    request<LocalUser>('/local-auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  logout: () =>
    request<void>('/local-auth/logout', {
      method: 'POST',
    }),
};

// ---------- 看板 ----------

export const boardApi = {
  listProjects: () => request<BoardProject[]>('/board/projects'),

  createProject: (name: string) =>
    request<BoardProject>('/board/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteProject: (projectId: string) =>
    request<void>(`/board/projects/${projectId}`, { method: 'DELETE' }),

  getBoard: (projectId: string) =>
    request<BoardView>(`/board/projects/${projectId}`),

  createIssue: (
    projectId: string,
    payload: { title: string; description?: string; status?: string }
  ) =>
    request<BoardIssue>(`/board/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateIssue: (
    issueId: string,
    payload: { title?: string; description?: string; status?: string }
  ) =>
    request<BoardIssue>(`/board/issues/${issueId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteIssue: (issueId: string) =>
    request<void>(`/board/issues/${issueId}`, { method: 'DELETE' }),
};