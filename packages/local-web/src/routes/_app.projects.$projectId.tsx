import { createFileRoute } from '@tanstack/react-router';
import { BoardPage } from '@/pages/board/BoardPage';
import { projectSearchValidator } from '@vibe/web-core/project-search';

/**
 * 项目看板路由。
 *
 * 原先是 `LocalProjectKanban` → `ProjectKanban` → 渲染 `ProjectSunsetPage`（功能已退役）。
 * 这里替换为本地看板实现：数据来自 `/api/board/*`，不依赖任何云服务。
 */
export const Route = createFileRoute('/_app/projects/$projectId')({
  validateSearch: projectSearchValidator,
  component: BoardPage,
});