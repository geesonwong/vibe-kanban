import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { localAuthApi, type LocalAuthStatus } from '@/shared/lib/boardApi';

/**
 * 本地登录页。
 *
 * 云服务已随 BloopAI 关闭而下线，官方登录入口点了只会报
 * `Remote client not configured`。这里提供本机账号：
 * - 首次使用 → 创建管理员账号（`/local-auth/setup`）
 * - 之后 → 邮箱 + 口令登录（`/local-auth/login`）
 * 登录态由 HttpOnly Cookie 承载，无需在前端存 token。
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<LocalAuthStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    localAuthApi
      .status()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s.user) navigate({ to: '/board' });
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [navigate]);

  const needsSetup = status?.needs_setup ?? false;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) {
        await localAuthApi.setup({ email, password, display_name: displayName });
      } else {
        await localAuthApi.login({ email, password });
      }
      window.dispatchEvent(new Event('vk-local-auth-changed'));
      navigate({ to: '/board' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-100 p-double">
      <div className="w-full max-w-md rounded-lg border border bg-secondary p-double shadow-sm">
        <h1 className="text-xl font-semibold text-high">
          {needsSetup ? '创建本地管理员账号' : '登录本地看板'}
        </h1>
        <p className="mt-half text-base text-low">
          {needsSetup
            ? '首次使用需要创建一个本机账号；账号只保存在这台机器上。'
            : '账号保存在本机数据库中，不联网、不上传。'}
        </p>

        <form className="mt-double space-y-4" onSubmit={onSubmit}>
          <label className="block">
            <span className="text-base font-medium text-normal">
              邮箱
            </span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@local"
              className="mt-half w-full rounded-md border border bg-secondary px-3 py-2 text-base text-neutral-900 outline-none focus:border-neutral-500"
            />
          </label>

          {needsSetup && (
            <label className="block">
              <span className="text-base font-medium text-normal">
                显示名（可选）
              </span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Geeson"
                className="mt-half w-full rounded-md border border bg-secondary px-3 py-2 text-base text-neutral-900 outline-none focus:border-neutral-500"
              />
            </label>
          )}

          <label className="block">
            <span className="text-base font-medium text-normal">
              口令
            </span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位"
              className="mt-half w-full rounded-md border border bg-secondary px-3 py-2 text-base text-neutral-900 outline-none focus:border-neutral-500"
            />
          </label>

          {error && (
            <p className="rounded-md bg-secondary px-base py-half text-base text-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-brand px-4 py-2 text-base font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50"
          >
            {busy ? '处理中…' : needsSetup ? '创建并进入' : '登录'}
          </button>
        </form>

        <p className="mt-base text-sm text-low">
          提示：这是本地账号，与 GitHub / Google 无关；官方云端登录已随 BloopAI 关闭失效。
        </p>
      </div>
    </div>
  );
}