import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { boardApi, localAuthApi, type BoardProject, type LocalUser } from '@/shared/lib/boardApi';

/**
 * 项目列表：本地看板的入口。
 * 未登录会被引导到 /login。
 */
export function ProjectsPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<LocalUser | null>(null);
  const [projects, setProjects] = useState<BoardProject[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const status = await localAuthApi.status();
      if (!status.user) {
        navigate({ to: '/login' });
        return;
      }
      setUser(status.user);
      setProjects(await boardApi.listProjects());
      setError(null);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 401) {
        navigate({ to: '/login' });
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await boardApi.createProject(name.trim());
      setName('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeProject = async (id: string, projectName: string) => {
    if (!window.confirm(`删除项目「${projectName}」及其全部任务卡？`)) return;
    try {
      await boardApi.deleteProject(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const signOut = async () => {
    await localAuthApi.logout().catch(() => undefined);
    window.dispatchEvent(new Event('vk-local-auth-changed'));
    navigate({ to: '/login' });
  };

  return (
    <div className="mx-auto w-full max-w-5xl p-double">
      <header className="flex items-center justify-between gap-base">
        <div>
          <h1 className="text-xl font-semibold text-high">
            项目
          </h1>
          <p className="mt-half text-base text-low">
            {user ? `已登录：${user.display_name || user.email}` : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-half">
          <button
            onClick={() => navigate({ to: '/workspaces' })}
            className="rounded-md border border px-3 py-1.5 text-base text-neutral-700 hover:bg-neutral-100"
          >
            工作区
          </button>
          <button
            onClick={signOut}
            className="rounded-md border border px-3 py-1.5 text-base text-neutral-700 hover:bg-neutral-100"
          >
            退出
          </button>
        </div>
      </header>

      <form onSubmit={createProject} className="mt-double flex gap-half">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新建项目名称，例如「Agent 任务板」"
          className="flex-1 rounded-md border border bg-secondary px-3 py-2 text-base text-neutral-900 outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          className="rounded-md bg-brand px-4 py-2 text-base font-medium text-white hover:bg-neutral-700"
        >
          创建项目
        </button>
      </form>

      {error && (
        <p className="mt-base rounded-md bg-secondary px-base py-half text-base text-error">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-8 text-base text-neutral-500">加载中…</p>
      ) : projects.length === 0 ? (
        <div className="mt-half0 rounded-lg border border-dashed border p-10 text-center">
          <p className="text-base text-low">
            还没有项目。先创建第一个项目，再往里添加任务卡。
          </p>
        </div>
      ) : (
        <ul className="mt-double grid gap-base sm:grid-cols-2">
          {projects.map((project) => (
            <li
              key={project.id}
              className="group rounded-lg border border bg-secondary p-base transition hover:border-neutral-400"
            >
              <button
                onClick={() =>
                  navigate({
                    to: '/projects/$projectId',
                    params: { projectId: project.id },
                  })
                }
                className="block w-full text-left"
              >
                <span className="text-base font-medium text-high">
                  {project.name}
                </span>
                <span className="mt-half block text-sm text-low">
                  {project.issue_count} 张任务卡
                </span>
              </button>
              <div className="mt-base flex justify-end">
                <button
                  onClick={() => removeProject(project.id, project.name)}
                  className="text-sm text-low opacity-0 transition group-hover:opacity-100 hover:text-error"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}