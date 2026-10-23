CREATE TABLE IF NOT EXISTS share_links (
    code TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    route TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
