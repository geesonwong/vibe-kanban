import { createFileRoute } from '@tanstack/react-router';
import { ProjectsPage } from '@/pages/board/ProjectsPage';

export const Route = createFileRoute('/_app/board')({
  component: ProjectsPage,
});