import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AuthContext,
  type AuthContextValue,
} from '@/shared/hooks/auth/useAuth';
import { localAuthApi } from '@/shared/lib/boardApi';

interface LocalAuthProviderProps {
  children: ReactNode;
}

/**
 * 本地登录态来源。
 *
 * 原实现读的是 `userSystem.login_status`，那份状态来自已经关闭的云端，
 * 因此永远是「未登录」——所有需要登录的入口（项目/看板）都打不开。
 *
 * 这里改为查询本机 `/api/local-auth/status`：
 * - 登录 / 注册 / 注销后，页面派发 `vk-local-auth-changed` 事件即可刷新全局状态
 * - 不使用 react-query，避免依赖 Provider 层级（本组件位于 QueryClient 之外）
 */
export function LocalAuthProvider({ children }: LocalAuthProviderProps) {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await localAuthApi.status();
      setIsSignedIn(Boolean(status.user));
      setUserId(status.user?.id ?? null);
    } catch {
      setIsSignedIn(false);
      setUserId(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const onChange = () => {
      void refresh();
    };
    window.addEventListener('vk-local-auth-changed', onChange);
    window.addEventListener('focus', onChange);
    return () => {
      window.removeEventListener('vk-local-auth-changed', onChange);
      window.removeEventListener('focus', onChange);
    };
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isSignedIn,
      isLoaded: loaded,
      userId,
    }),
    [isSignedIn, loaded, userId]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}