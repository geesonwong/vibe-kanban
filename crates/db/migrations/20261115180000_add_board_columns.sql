-- 可配置看板列（状态）。
--
-- 设计取舍：不重建 tasks 表（task_attachments 有外键指向它，重建风险高），
-- 改为「追加式」：
--   1. 新增 board_columns 表，每项目一组、可增删改名排序
--   2. tasks 增加 column_id 指向列，成为看板真正的事实源
--   3. tasks.status 保留并继续写入（映射自列的 legacy_status），
--      仅为满足历史 CHECK 约束与旧代码路径，不再作为看板依据
CREATE TABLE board_columns (
    id            BLOB PRIMARY KEY,
    project_id    BLOB NOT NULL,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT 'gray',
    position      INTEGER NOT NULL DEFAULT 0,
    legacy_status TEXT NOT NULL DEFAULT 'inprogress',
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_board_columns_project ON board_columns(project_id, position);

ALTER TABLE tasks ADD COLUMN column_id BLOB;

-- 为已存在的项目播种 5 个默认列
INSERT INTO board_columns (id, project_id, name, color, position, legacy_status)
SELECT randomblob(16), p.id, '待办', 'gray', 0, 'todo' FROM projects p;

INSERT INTO board_columns (id, project_id, name, color, position, legacy_status)
SELECT randomblob(16), p.id, '进行中', 'blue', 1, 'inprogress' FROM projects p;

INSERT INTO board_columns (id, project_id, name, color, position, legacy_status)
SELECT randomblob(16), p.id, '待审阅', 'violet', 2, 'inreview' FROM projects p;

INSERT INTO board_columns (id, project_id, name, color, position, legacy_status)
SELECT randomblob(16), p.id, '已完成', 'green', 3, 'done' FROM projects p;

INSERT INTO board_columns (id, project_id, name, color, position, legacy_status)
SELECT randomblob(16), p.id, '已取消', 'rose', 4, 'cancelled' FROM projects p;

-- 既有任务卡按原 status 归位到对应列
UPDATE tasks
SET column_id = (
    SELECT c.id FROM board_columns c
    WHERE c.project_id = tasks.project_id AND c.legacy_status = tasks.status
    ORDER BY c.position LIMIT 1
)
WHERE column_id IS NULL;