//! 本地登录：单机部署下的账号体系，完全不依赖已关闭的云端。
//!
//! 设计要点：
//! - 首个注册的账号即管理员（`/setup` 仅在无账号时可用）
//! - 口令用「加盐 + 多次 SHA-256」派生，迭代次数随账号存储，便于日后升级
//! - 会话令牌为 32 字节随机十六进制串，明文存库、通过 HttpOnly Cookie 下发
//! - 仅 `/status` `/setup` `/login` `/logout` `/me` 五个端点，无第三方依赖

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use db::models::local_auth::{LocalAccount, LocalSession, PublicAccount};
use deployment::Deployment;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

const COOKIE_NAME: &str = "vk_local_session";
const SESSION_TTL_SECS: i64 = 60 * 60 * 24 * 30;
const HASH_ITERATIONS: i64 = 120_000;
/// 口令最短长度：本地单机场景下不做过度限制，但拒绝空口令。
const MIN_PASSWORD_LEN: usize = 6;

// ---------- 口令与令牌 ----------

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn derive_hash(password: &str, salt: &str, iterations: i64) -> String {
    let mut hash = Sha256::digest(format!("{salt}:{password}").as_bytes()).to_vec();
    for _ in 0..iterations.max(1) {
        let mut buf = Vec::with_capacity(hash.len() + salt.len());
        buf.extend_from_slice(&hash);
        buf.extend_from_slice(salt.as_bytes());
        hash = Sha256::digest(&buf).to_vec();
    }
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

/// 定长比较，避免按字节提前返回。
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn read_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&format!("{COOKIE_NAME}=")) {
            return Some(v.to_string());
        }
    }
    None
}

fn session_cookie(token: &str) -> String {
    format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECS}")
}

fn clear_cookie() -> String {
    format!("{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

/// 供其它路由复用的登录校验。
pub async fn require_account(
    deployment: &DeploymentImpl,
    headers: &HeaderMap,
) -> Result<LocalAccount, ApiError> {
    let token = read_token(headers).ok_or(ApiError::Unauthorized)?;
    LocalSession::find_account(&deployment.db().pool, &token)
        .await?
        .ok_or(ApiError::Unauthorized)
}

/// 可选登录校验：未登录返回 `None`，不报错。
pub async fn optional_account(
    deployment: &DeploymentImpl,
    headers: &HeaderMap,
) -> Result<Option<LocalAccount>, ApiError> {
    let Some(token) = read_token(headers) else {
        return Ok(None);
    };
    Ok(LocalSession::find_account(&deployment.db().pool, &token).await?)
}

// ---------- 请求 / 响应体 ----------

#[derive(Debug, Deserialize)]
pub struct SetupRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    /// 还没有任何账号 → 前端应显示「创建管理员账号」
    pub needs_setup: bool,
    pub user: Option<PublicAccount>,
}

// ---------- 处理函数 ----------

pub async fn status(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<AuthStatus>>, ApiError> {
    let count = LocalAccount::count(&deployment.db().pool).await?;
    let user = optional_account(&deployment, &headers)
        .await?
        .map(PublicAccount::from);
    Ok(Json(ApiResponse::success(AuthStatus {
        needs_setup: count == 0,
        user,
    })))
}

pub async fn setup(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<SetupRequest>,
) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;

    if LocalAccount::count(pool).await? > 0 {
        return Err(ApiError::Conflict("账号已存在，请直接登录".into()));
    }
    validate_credentials(&payload.email, &payload.password)?;

    let salt = random_hex(16);
    let hash = derive_hash(&payload.password, &salt, HASH_ITERATIONS);
    let display_name = if payload.display_name.trim().is_empty() {
        payload
            .email
            .split('@')
            .next()
            .unwrap_or("local")
            .to_string()
    } else {
        payload.display_name.trim().to_string()
    };

    let account =
        LocalAccount::create(pool, payload.email.trim(), &display_name, &hash, &salt, HASH_ITERATIONS)
            .await?;

    let token = random_hex(32);
    LocalSession::create(pool, account.id, &token, SESSION_TTL_SECS).await?;

    let public = PublicAccount::from(account);
    Ok((
        [(header::SET_COOKIE, session_cookie(&token))],
        Json(ApiResponse::<PublicAccount>::success(public)),
    )
        .into_response())
}

pub async fn login(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;

    let account = LocalAccount::find_by_email(pool, payload.email.trim())
        .await?
        .ok_or_else(|| ApiError::BadRequest("邮箱或密码不正确".into()))?;

    let candidate = derive_hash(&payload.password, &account.salt, account.iterations);
    if !constant_time_eq(&candidate, &account.password_hash) {
        return Err(ApiError::BadRequest("邮箱或密码不正确".into()));
    }

    let token = random_hex(32);
    LocalSession::create(pool, account.id, &token, SESSION_TTL_SECS).await?;
    let _ = LocalSession::delete_expired(pool).await;

    let public = PublicAccount::from(account);
    Ok((
        [(header::SET_COOKIE, session_cookie(&token))],
        Json(ApiResponse::<PublicAccount>::success(public)),
    )
        .into_response())
}

pub async fn logout(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(token) = read_token(&headers) {
        let _ = LocalSession::delete(&deployment.db().pool, &token).await;
    }
    Ok(([(header::SET_COOKIE, clear_cookie())], Json(ApiResponse::<()>::success(()))).into_response())
}

pub async fn me(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<PublicAccount>>, ApiError> {
    let account = require_account(&deployment, &headers).await?;
    Ok(Json(ApiResponse::success(PublicAccount::from(account))))
}

fn validate_credentials(email: &str, password: &str) -> Result<(), ApiError> {
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err(ApiError::BadRequest("请填写有效邮箱".into()));
    }
    if password.len() < MIN_PASSWORD_LEN {
        return Err(ApiError::BadRequest(format!(
            "口令至少 {MIN_PASSWORD_LEN} 位"
        )));
    }
    Ok(())
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().nest(
        "/local-auth",
        Router::new()
            .route("/status", get(status))
            .route("/setup", post(setup))
            .route("/login", post(login))
            .route("/logout", post(logout))
            .route("/me", get(me)),
    )
}