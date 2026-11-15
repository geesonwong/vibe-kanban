-- 本地账号与会话：让单机部署拥有「登录」能力，不依赖已关闭的云端。
CREATE TABLE local_accounts (
    id            BLOB PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    iterations    INTEGER NOT NULL DEFAULT 120000,
    created_at    INTEGER NOT NULL
);

CREATE TABLE local_sessions (
    token      TEXT PRIMARY KEY,
    account_id BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES local_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_local_sessions_account ON local_sessions(account_id);
CREATE INDEX idx_local_sessions_expires ON local_sessions(expires_at);