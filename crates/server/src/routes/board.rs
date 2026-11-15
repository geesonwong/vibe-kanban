//! 本地看板：把被搬到云端、随公司关闭而消失的「项目 / 任务卡」能力搬回本地。
//!
//! 复用既有 `projects` / `tasks` 表（schema 从未删除），仅补上缺失的 REST 路由，
//! 因此不新增任何表结构。所有写操作要求已登录。
//!
//! 状态机沿用 `TaskStatus`：todo → inprogress → inreview → done（cancelled 为旁路）。

use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, patch, post},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    routes::local_auth::require_account,
};
use utils::response::ApiResponse;

/// 看板列定义（与 `TaskStatus` 的数据库取值一一对应）。
#[derive(Debug, Clone, Serialize)]
pub struct BoardColumn {
    pub id: &'static str,
    pub name: &'static str,
    pub color: &'static str,
}

const COLUMNS: [BoardColumn; 5] = [
    BoardColumn { id: "todo", name: "待办", color: "gray" },
    BoardColumn { id: "inprogress", name: "进行中", color: "blue" },
    BoardColumn { id: "inreview", name: "待审阅", color: "purple" },
    BoardColumn { id: "done", name: "已完成", color: "green" },
    BoardColumn { id: "cancelled", name: "已取消", color: "red" },
];

fn is_valid_status(status: &str) -> bool {
    COLUMNS.iter().any(|c| c.id == status)
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardProject {
    pub id: Uuid,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub issue_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardIssue {
    pub id: Uuid,
    pub project_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct BoardView {
    pub project: BoardProject,
    pub columns: Vec<BoardColumn>,
    pub issues: Vec<BoardIssue>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateIssueRequest {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateIssueRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

// ---------- 查询辅助 ----------

async fn load_projects(pool: &sqlx::SqlitePool) -> Result<Vec<BoardProject>, sqlx::Error> {
    let rows: Vec<(Uuid, String, String, String, i64)> = sqlx::query_as(
        "SELECT p.id, p.name, p.created_at, p.updated_at, \
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS issue_count \
         FROM projects p ORDER BY p.created_at DESC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, name, created_at, updated_at, issue_count)| BoardProject {
            id,
            name,
            created_at,
            updated_at,
            issue_count,
        })
        .collect())
}

async fn load_project(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
) -> Result<BoardProject, ApiError> {
    let row: Option<(Uuid, String, String, String, i64)> = sqlx::query_as(
        "SELECT p.id, p.name, p.created_at, p.updated_at, \
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) \
         FROM projects p WHERE p.id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;

    let (id, name, created_at, updated_at, issue_count) = row.ok_or_else(|| {
        ApiError::BadRequest("项目不存在".into())
    })?;

    Ok(BoardProject { id, name, created_at, updated_at, issue_count })
}

async fn load_issues(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
) -> Result<Vec<BoardIssue>, sqlx::Error> {
    let rows: Vec<(Uuid, Uuid, String, Option<String>, String, String, String)> = sqlx::query_as(
        "SELECT id, project_id, title, description, status, created_at, updated_at \
         FROM tasks WHERE project_id = ? ORDER BY created_at ASC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, project_id, title, description, status, created_at, updated_at)| BoardIssue {
            id,
            project_id,
            title,
            description,
            status,
            created_at,
            updated_at,
        })
        .collect())
}

async fn load_issue(pool: &sqlx::SqlitePool, issue_id: Uuid) -> Result<BoardIssue, ApiError> {
    let row: Option<(Uuid, Uuid, String, Option<String>, String, String, String)> = sqlx::query_as(
        "SELECT id, project_id, title, description, status, created_at, updated_at \
         FROM tasks WHERE id = ?",
    )
    .bind(issue_id)
    .fetch_optional(pool)
    .await?;

    let (id, project_id, title, description, status, created_at, updated_at) =
        row.ok_or_else(|| ApiError::BadRequest("任务卡不存在".into()))?;

    Ok(BoardIssue { id, project_id, title, description, status, created_at, updated_at })
}

// ---------- 项目 ----------

pub async fn list_projects(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<Vec<BoardProject>>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let projects = load_projects(&deployment.db().pool).await?;
    Ok(Json(ApiResponse::success(projects)))
}

pub async fn create_project(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(payload): Json<CreateProjectRequest>,
) -> Result<Json<ApiResponse<BoardProject>>, ApiError> {
    require_account(&deployment, &headers).await?;

    let name = payload.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("项目名称不能为空".into()));
    }

    let pool = &deployment.db().pool;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, name, created_at, updated_at) \
         VALUES (?, ?, datetime('now','subsec'), datetime('now','subsec'))",
    )
    .bind(id)
    .bind(name)
    .execute(pool)
    .await?;

    Ok(Json(ApiResponse::success(load_project(pool, id).await?)))
}

pub async fn delete_project(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    // tasks 表有 ON DELETE CASCADE，但 SQLite 需开启外键约束；这里显式清理，行为可预期。
    sqlx::query("DELETE FROM tasks WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM project_repos WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;

    Ok(Json(ApiResponse::success(())))
}

// ---------- 看板 / 任务卡 ----------

pub async fn get_board(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ApiResponse<BoardView>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    let project = load_project(pool, project_id).await?;
    let issues = load_issues(pool, project_id).await?;

    Ok(Json(ApiResponse::success(BoardView {
        project,
        columns: COLUMNS.to_vec(),
        issues,
    })))
}

pub async fn create_issue(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<CreateIssueRequest>,
) -> Result<Json<ApiResponse<BoardIssue>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    let title = payload.title.trim();
    if title.is_empty() {
        return Err(ApiError::BadRequest("任务标题不能为空".into()));
    }
    let status = payload.status.as_deref().unwrap_or("todo");
    if !is_valid_status(status) {
        return Err(ApiError::BadRequest(format!("未知状态：{status}")));
    }

    // 项目必须存在
    load_project(pool, project_id).await?;

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, datetime('now','subsec'), datetime('now','subsec'))",
    )
    .bind(id)
    .bind(project_id)
    .bind(title)
    .bind(payload.description.as_deref())
    .bind(status)
    .execute(pool)
    .await?;

    Ok(Json(ApiResponse::success(load_issue(pool, id).await?)))
}

pub async fn update_issue(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(issue_id): Path<Uuid>,
    Json(payload): Json<UpdateIssueRequest>,
) -> Result<Json<ApiResponse<BoardIssue>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    if let Some(status) = payload.status.as_deref()
        && !is_valid_status(status)
    {
        return Err(ApiError::BadRequest(format!("未知状态：{status}")));
    }
    if let Some(title) = payload.title.as_deref()
        && title.trim().is_empty()
    {
        return Err(ApiError::BadRequest("任务标题不能为空".into()));
    }

    // 先确认存在，避免静默无操作
    let current = load_issue(pool, issue_id).await?;

    sqlx::query(
        "UPDATE tasks SET title = ?, description = ?, status = ?, updated_at = datetime('now','subsec') \
         WHERE id = ?",
    )
    .bind(payload.title.map(|t| t.trim().to_string()).unwrap_or(current.title))
    .bind(payload.description.or(current.description))
    .bind(payload.status.unwrap_or(current.status))
    .bind(issue_id)
    .execute(pool)
    .await?;

    Ok(Json(ApiResponse::success(load_issue(pool, issue_id).await?)))
}

pub async fn delete_issue(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(issue_id): Path<Uuid>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    require_account(&deployment, &headers).await?;
    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(issue_id)
        .execute(&deployment.db().pool)
        .await?;
    Ok(Json(ApiResponse::success(())))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().nest(
        "/board",
        Router::new()
            .route("/projects", get(list_projects).post(create_project))
            .route("/projects/{project_id}", get(get_board).delete(delete_project))
            .route("/projects/{project_id}/issues", post(create_issue))
            .route(
                "/issues/{issue_id}",
                patch(update_issue).delete(delete_issue),
            ),
    )
}