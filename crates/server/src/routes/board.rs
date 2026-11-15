//! 本地看板：项目 / 可配置列（状态）/ 任务卡。
//!
//! 列（状态）不再硬编码：每个项目在 `board_columns` 里有一组有序的列，
//! 可增、可删、可改名、可调顺序。任务卡通过 `column_id` 归属列，
//! 同时把映射后的 legacy status 写回 `tasks.status`（兼容历史 CHECK 约束）。

use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, patch, post},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError, routes::local_auth::require_account};
use utils::response::ApiResponse;

/// 新建项目时播种的默认列。
const DEFAULT_COLUMNS: [(&str, &str, &str); 5] = [
    ("待办", "gray", "todo"),
    ("进行中", "blue", "inprogress"),
    ("待审阅", "violet", "inreview"),
    ("已完成", "green", "done"),
    ("已取消", "rose", "cancelled"),
];

/// 允许的配色标识（前端映射到具体颜色）。
const ALLOWED_COLORS: [&str; 7] = ["gray", "blue", "violet", "green", "rose", "amber", "teal"];

fn normalize_color(color: Option<&str>) -> String {
    match color {
        Some(c) if ALLOWED_COLORS.contains(&c) => c.to_string(),
        _ => "gray".to_string(),
    }
}

// ---------- 数据结构 ----------

#[derive(Debug, Clone, Serialize)]
pub struct BoardColumn {
    pub id: Uuid,
    pub name: String,
    pub color: String,
    pub position: i64,
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
    pub column_id: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
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
    pub column_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateIssueRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub column_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateColumnRequest {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateColumnRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub position: Option<i64>,
}

// ---------- 查询辅助 ----------

async fn load_columns(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
) -> Result<Vec<BoardColumn>, sqlx::Error> {
    let rows: Vec<(Uuid, String, String, i64)> = sqlx::query_as(
        "SELECT id, name, color, position FROM board_columns \
         WHERE project_id = ? ORDER BY position ASC, created_at ASC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, name, color, position)| BoardColumn { id, name, color, position })
        .collect())
}

async fn column_legacy_status(
    pool: &sqlx::SqlitePool,
    column_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT legacy_status FROM board_columns WHERE id = ?")
            .bind(column_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|r| r.0))
}

async fn load_projects(pool: &sqlx::SqlitePool) -> Result<Vec<BoardProject>, sqlx::Error> {
    let rows: Vec<(Uuid, String, String, String, i64)> = sqlx::query_as(
        "SELECT p.id, p.name, p.created_at, p.updated_at, \
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) \
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

async fn load_project(pool: &sqlx::SqlitePool, project_id: Uuid) -> Result<BoardProject, ApiError> {
    let row: Option<(Uuid, String, String, String, i64)> = sqlx::query_as(
        "SELECT p.id, p.name, p.created_at, p.updated_at, \
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) \
         FROM projects p WHERE p.id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;

    let (id, name, created_at, updated_at, issue_count) = row
        .ok_or_else(|| ApiError::BadRequest("项目不存在".into()))?;

    Ok(BoardProject { id, name, created_at, updated_at, issue_count })
}

async fn load_issues(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
) -> Result<Vec<BoardIssue>, sqlx::Error> {
    let rows: Vec<(Uuid, Uuid, Option<Uuid>, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, project_id, column_id, title, description, created_at, updated_at \
         FROM tasks WHERE project_id = ? ORDER BY created_at ASC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, project_id, column_id, title, description, created_at, updated_at)| {
            BoardIssue { id, project_id, column_id, title, description, created_at, updated_at }
        })
        .collect())
}

async fn load_issue(pool: &sqlx::SqlitePool, issue_id: Uuid) -> Result<BoardIssue, ApiError> {
    let row: Option<(Uuid, Uuid, Option<Uuid>, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, project_id, column_id, title, description, created_at, updated_at \
         FROM tasks WHERE id = ?",
    )
    .bind(issue_id)
    .fetch_optional(pool)
    .await?;

    let (id, project_id, column_id, title, description, created_at, updated_at) =
        row.ok_or_else(|| ApiError::BadRequest("任务卡不存在".into()))?;

    Ok(BoardIssue { id, project_id, column_id, title, description, created_at, updated_at })
}

async fn seed_default_columns(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    for (position, (name, color, legacy)) in DEFAULT_COLUMNS.iter().enumerate() {
        sqlx::query(
            "INSERT INTO board_columns (id, project_id, name, color, position, legacy_status) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4())
        .bind(project_id)
        .bind(*name)
        .bind(*color)
        .bind(position as i64)
        .bind(*legacy)
        .execute(pool)
        .await?;
    }
    Ok(())
}

// ---------- 项目 ----------

pub async fn list_projects(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<Vec<BoardProject>>>, ApiError> {
    require_account(&deployment, &headers).await?;
    Ok(Json(ApiResponse::success(load_projects(&deployment.db().pool).await?)))
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

    seed_default_columns(pool, id).await?;

    Ok(Json(ApiResponse::success(load_project(pool, id).await?)))
}

pub async fn delete_project(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    for sql in [
        "DELETE FROM tasks WHERE project_id = ?",
        "DELETE FROM board_columns WHERE project_id = ?",
        "DELETE FROM projects WHERE id = ?",
    ] {
        sqlx::query(sql).bind(project_id).execute(pool).await?;
    }

    Ok(Json(ApiResponse::success(())))
}

// ---------- 看板 ----------

pub async fn get_board(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ApiResponse<BoardView>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    let project = load_project(pool, project_id).await?;
    let columns = load_columns(pool, project_id).await?;
    let issues = load_issues(pool, project_id).await?;

    Ok(Json(ApiResponse::success(BoardView { project, columns, issues })))
}

// ---------- 列（状态）----------

pub async fn create_column(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<CreateColumnRequest>,
) -> Result<Json<ApiResponse<BoardColumn>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    let name = payload.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("列名称不能为空".into()));
    }
    load_project(pool, project_id).await?;

    let (max_pos,): (Option<i64>,) = sqlx::query_as(
        "SELECT MAX(position) FROM board_columns WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    let position = max_pos.map(|p| p + 1).unwrap_or(0);

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO board_columns (id, project_id, name, color, position, legacy_status) \
         VALUES (?, ?, ?, ?, ?, 'inprogress')",
    )
    .bind(id)
    .bind(project_id)
    .bind(name)
    .bind(normalize_color(payload.color.as_deref()))
    .bind(position)
    .execute(pool)
    .await?;

    let columns = load_columns(pool, project_id).await?;
    let created = columns
        .into_iter()
        .find(|c| c.id == id)
        .ok_or(sqlx::Error::RowNotFound)?;
    Ok(Json(ApiResponse::success(created)))
}

pub async fn update_column(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(column_id): Path<Uuid>,
    Json(payload): Json<UpdateColumnRequest>,
) -> Result<Json<ApiResponse<BoardColumn>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    let row: Option<(Uuid, Uuid, String, String, i64)> = sqlx::query_as(
        "SELECT id, project_id, name, color, position FROM board_columns WHERE id = ?",
    )
    .bind(column_id)
    .fetch_optional(pool)
    .await?;
    let (_, project_id, name, color, position) =
        row.ok_or_else(|| ApiError::BadRequest("列不存在".into()))?;

    let next_name = match payload.name.as_deref() {
        Some(n) if n.trim().is_empty() => {
            return Err(ApiError::BadRequest("列名称不能为空".into()));
        }
        Some(n) => n.trim().to_string(),
        None => name,
    };
    let next_color = match payload.color.as_deref() {
        Some(c) => normalize_color(Some(c)),
        None => color,
    };
    let next_position = payload.position.unwrap_or(position);

    sqlx::query("UPDATE board_columns SET name = ?, color = ?, position = ? WHERE id = ?")
        .bind(&next_name)
        .bind(&next_color)
        .bind(next_position)
        .bind(column_id)
        .execute(pool)
        .await?;

    Ok(Json(ApiResponse::success(BoardColumn {
        id: column_id,
        name: next_name,
        color: next_color,
        position: next_position,
    })))
}

pub async fn delete_column(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Path(column_id): Path<Uuid>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    require_account(&deployment, &headers).await?;
    let pool = &deployment.db().pool;

    let row: Option<(Uuid,)> = sqlx::query_as("SELECT project_id FROM board_columns WHERE id = ?")
        .bind(column_id)
        .fetch_optional(pool)
        .await?;
    let (project_id,) = row.ok_or_else(|| ApiError::BadRequest("列不存在".into()))?;

    let columns = load_columns(pool, project_id).await?;
    if columns.len() <= 1 {
        return Err(ApiError::BadRequest("至少要保留一列".into()));
    }

    // 把该列的卡片迁到剩余的第一列，避免卡片丢失
    let fallback = columns
        .iter()
        .find(|c| c.id != column_id)
        .map(|c| c.id)
        .ok_or_else(|| ApiError::BadRequest("至少要保留一列".into()))?;

    sqlx::query("UPDATE tasks SET column_id = ? WHERE column_id = ?")
        .bind(fallback)
        .bind(column_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM board_columns WHERE id = ?")
        .bind(column_id)
        .execute(pool)
        .await?;

    Ok(Json(ApiResponse::success(())))
}

// ---------- 任务卡 ----------

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
    load_project(pool, project_id).await?;

    // 指定列则校验归属；未指定则落到第一列
    let column_id = match payload.column_id {
        Some(cid) => {
            let cols = load_columns(pool, project_id).await?;
            if !cols.iter().any(|c| c.id == cid) {
                return Err(ApiError::BadRequest("列不属于该项目".into()));
            }
            cid
        }
        None => load_columns(pool, project_id)
            .await?
            .first()
            .map(|c| c.id)
            .ok_or_else(|| ApiError::BadRequest("项目没有可用列".into()))?,
    };

    let legacy = column_legacy_status(pool, column_id)
        .await?
        .unwrap_or_else(|| "todo".to_string());

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO tasks (id, project_id, column_id, title, description, status, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, datetime('now','subsec'), datetime('now','subsec'))",
    )
    .bind(id)
    .bind(project_id)
    .bind(column_id)
    .bind(title)
    .bind(payload.description.as_deref())
    .bind(legacy)
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

    let current = load_issue(pool, issue_id).await?;

    if let Some(title) = payload.title.as_deref()
        && title.trim().is_empty()
    {
        return Err(ApiError::BadRequest("任务标题不能为空".into()));
    }

    // 换列时同步 legacy status，兼容旧 CHECK 约束
    let (next_column, next_legacy) = match payload.column_id {
        Some(cid) => {
            let cols = load_columns(pool, current.project_id).await?;
            if !cols.iter().any(|c| c.id == cid) {
                return Err(ApiError::BadRequest("列不属于该项目".into()));
            }
            let legacy = column_legacy_status(pool, cid)
                .await?
                .unwrap_or_else(|| "inprogress".to_string());
            (Some(cid), Some(legacy))
        }
        None => (current.column_id, None),
    };

    sqlx::query(
        "UPDATE tasks SET title = ?, description = ?, column_id = ?, \
                         status = COALESCE(?, status), updated_at = datetime('now','subsec') \
         WHERE id = ?",
    )
    .bind(
        payload
            .title
            .map(|t| t.trim().to_string())
            .unwrap_or(current.title),
    )
    .bind(payload.description.or(current.description))
    .bind(next_column)
    .bind(next_legacy)
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
            .route("/projects/{project_id}/columns", post(create_column))
            .route("/columns/{column_id}", patch(update_column).delete(delete_column))
            .route("/issues/{issue_id}", patch(update_issue).delete(delete_issue)),
    )
}