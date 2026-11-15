//! 本地账号与会话模型。
//!
//! 仅使用运行时查询（非 `query!` 宏），避免新增 SQL 需要编译期数据库/离线缓存。

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// 本地账号（单机部署下的登录主体）。
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct LocalAccount {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub password_hash: String,
    pub salt: String,
    pub iterations: i64,
    pub created_at: i64,
}

/// 对外暴露的账号信息（不含任何凭据字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicAccount {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
}

impl From<LocalAccount> for PublicAccount {
    fn from(a: LocalAccount) -> Self {
        Self {
            id: a.id,
            email: a.email,
            display_name: a.display_name,
        }
    }
}

impl LocalAccount {
    pub async fn count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM local_accounts")
            .fetch_one(pool)
            .await?;
        Ok(row.0)
    }

    pub async fn find_by_email(pool: &SqlitePool, email: &str) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, LocalAccount>(
            "SELECT id, email, display_name, password_hash, salt, iterations, created_at \
             FROM local_accounts WHERE email = ? COLLATE NOCASE",
        )
        .bind(email)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, LocalAccount>(
            "SELECT id, email, display_name, password_hash, salt, iterations, created_at \
             FROM local_accounts WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        email: &str,
        display_name: &str,
        password_hash: &str,
        salt: &str,
        iterations: i64,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO local_accounts (id, email, display_name, password_hash, salt, iterations, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(email)
        .bind(display_name)
        .bind(password_hash)
        .bind(salt)
        .bind(iterations)
        .bind(now)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }
}

/// 本地会话（登录态）。
#[derive(Debug, Clone, FromRow)]
pub struct LocalSession {
    pub token: String,
    pub account_id: Uuid,
    pub created_at: i64,
    pub expires_at: i64,
}

impl LocalSession {
    pub async fn create(
        pool: &SqlitePool,
        account_id: Uuid,
        token: &str,
        ttl_secs: i64,
    ) -> Result<(), sqlx::Error> {
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO local_sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(token)
        .bind(account_id)
        .bind(now)
        .bind(now + ttl_secs)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 取未过期的会话对应账号。
    pub async fn find_account(
        pool: &SqlitePool,
        token: &str,
    ) -> Result<Option<LocalAccount>, sqlx::Error> {
        let now = chrono::Utc::now().timestamp();
        sqlx::query_as::<_, LocalAccount>(
            "SELECT a.id, a.email, a.display_name, a.password_hash, a.salt, a.iterations, a.created_at \
             FROM local_sessions s JOIN local_accounts a ON a.id = s.account_id \
             WHERE s.token = ? AND s.expires_at > ?",
        )
        .bind(token)
        .bind(now)
        .fetch_optional(pool)
        .await
    }

    pub async fn delete(pool: &SqlitePool, token: &str) -> Result<u64, sqlx::Error> {
        let res = sqlx::query("DELETE FROM local_sessions WHERE token = ?")
            .bind(token)
            .execute(pool)
            .await?;
        Ok(res.rows_affected())
    }

    pub async fn delete_expired(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
        let now = chrono::Utc::now().timestamp();
        let res = sqlx::query("DELETE FROM local_sessions WHERE expires_at <= ?")
            .bind(now)
            .execute(pool)
            .await?;
        Ok(res.rows_affected())
    }
}