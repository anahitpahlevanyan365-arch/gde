import os
import sqlite3
from datetime import datetime, timezone

DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(DATA_DIR, "chat.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT    NOT NULL,
    messages_used  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL DEFAULT 'New chat',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT    NOT NULL,
    created_at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
"""

CONVERSATION_COLUMNS = "id, title, created_at, updated_at"


def _now():
    return datetime.now(timezone.utc).isoformat()


def get_conn():
    # A fresh connection per call keeps things simple and safe with Flask's threaded dev server
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with get_conn() as conn:
        # Older databases were created before users existed: add the owner column
        has_conversations = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'"
        ).fetchone()
        if has_conversations:
            columns = {r["name"] for r in conn.execute("PRAGMA table_info(conversations)")}
            if "user_id" not in columns:
                conn.execute(
                    "ALTER TABLE conversations ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE"
                )
        conn.executescript(SCHEMA)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at)")

        # Users created before the free limit existed: add the counter, starting from what they already sent
        user_columns = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
        if "messages_used" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN messages_used INTEGER NOT NULL DEFAULT 0")
            conn.execute(
                """UPDATE users SET messages_used = (
                       SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                       WHERE c.user_id = users.id AND m.role = 'user')"""
            )


# ---------- Users ----------

def create_user(username, password_hash):
    """Create a user and return it, or None if the username is taken.

    The very first user also takes over chats saved before login existed.
    """
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, password_hash, _now()),
            )
        except sqlite3.IntegrityError:
            return None
        user_id = cur.lastrowid
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1:
            conn.execute("UPDATE conversations SET user_id = ? WHERE user_id IS NULL", (user_id,))
    return get_user(user_id)


def get_user(user_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, username, messages_used, created_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else None


def reserve_message(user_id, limit):
    """Use one free message. Returns False if the user has none left.

    A single conditional UPDATE, so two requests at the same time can't both use the last message.
    """
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE users SET messages_used = messages_used + 1 WHERE id = ? AND messages_used < ?",
            (user_id, limit),
        )
    return cur.rowcount == 1


def refund_message(user_id):
    """Give back a message that got no answer."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET messages_used = messages_used - 1 WHERE id = ? AND messages_used > 0",
            (user_id,),
        )


def get_user_by_username(username):
    """Includes password_hash, for checking a login."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?", (username,)
        ).fetchone()
    return dict(row) if row else None


# ---------- Conversations (always scoped to their owner) ----------

def list_conversations(user_id):
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conversation_id, user_id):
    with get_conn() as conn:
        row = conn.execute(
            f"SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ? AND user_id = ?",
            (conversation_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def create_conversation(user_id, title="New chat"):
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (user_id, title, now, now),
        )
        conversation_id = cur.lastrowid
    return get_conversation(conversation_id, user_id)


def rename_conversation(conversation_id, user_id, title):
    with get_conn() as conn:
        conn.execute(
            "UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?",
            (title, conversation_id, user_id),
        )
    return get_conversation(conversation_id, user_id)


def delete_conversation(conversation_id, user_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", (conversation_id, user_id))


# ---------- Messages ----------

def list_messages(conversation_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id",
            (conversation_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def add_message(conversation_id, role, content):
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (conversation_id, role, content, now),
        )
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
    return cur.lastrowid


def delete_message(message_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
