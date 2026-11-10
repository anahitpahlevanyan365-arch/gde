import json
import os
import re
import secrets
from datetime import timedelta
from functools import wraps
from urllib.parse import urlsplit

from flask import (
    Flask, Response, abort, g, jsonify, redirect, render_template, request, session,
    stream_with_context, url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

import db
from bedrock_client import MODEL_ID, stream_chat, trim_history


def load_secret_key():
    """SECRET_KEY env var, or a random key saved next to the database so logins survive restarts."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    os.makedirs(db.DATA_DIR, exist_ok=True)
    path = os.path.join(db.DATA_DIR, "secret_key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app = Flask(__name__)
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE") == "1",  # set to 1 behind HTTPS
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
db.init_db()

TITLE_MAX_LEN = 60
FREE_MESSAGE_LIMIT = int(os.environ.get("FREE_MESSAGE_LIMIT", "10"))
# ~3,300 tokens. Well under CONTEXT_MAX_TOKENS, so a new message always fits in the window.
MESSAGE_MAX_CHARS = int(os.environ.get("MESSAGE_MAX_CHARS", "10000"))
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PASSWORD_MIN_LEN = 8
# Used when the username doesn't exist, so a failed login takes the same time either way
DUMMY_HASH = generate_password_hash(secrets.token_hex(16))


def make_title(text):
    title = " ".join(text.split())
    return title if len(title) <= TITLE_MAX_LEN else title[: TITLE_MAX_LEN - 1].rstrip() + "…"


# ---------- Auth helpers ----------

@app.before_request
def load_current_user():
    user_id = session.get("user_id")
    g.user = db.get_user(user_id) if user_id else None
    if user_id and g.user is None:
        session.clear()  # user was deleted


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.user is None:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Please log in."}), 401
            return redirect(url_for("login", next=request.full_path.rstrip("?")))
        return view(*args, **kwargs)
    return wrapped


def safe_next(target):
    """Only allow redirects back into this site (no open redirects)."""
    if not target:
        return url_for("index")
    parts = urlsplit(target)
    if parts.scheme or parts.netloc or not target.startswith("/") or target.startswith("//"):
        return url_for("index")
    return target


def log_in(user):
    session.clear()  # new session on login
    session["user_id"] = user["id"]
    session.permanent = True


def messages_left(user_id):
    user = db.get_user(user_id)
    return max(FREE_MESSAGE_LIMIT - user["messages_used"], 0) if user else 0


def require_conversation(conversation_id):
    conversation = db.get_conversation(conversation_id, g.user["id"])
    if conversation is None:
        abort(404, description="Conversation not found.")
    return conversation


@app.errorhandler(404)
@app.errorhandler(403)
@app.errorhandler(400)
def json_error(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": error.description}), error.code
    return error


# ---------- Auth pages ----------

@app.route("/login", methods=["GET", "POST"])
def login():
    next_url = safe_next(request.values.get("next"))
    if g.user:
        return redirect(next_url)

    error = None
    username = ""
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = db.get_user_by_username(username)
        if check_password_hash(user["password_hash"] if user else DUMMY_HASH, password) and user:
            log_in(user)
            return redirect(next_url)
        error = "Incorrect username or password."

    return render_template("auth.html", mode="login", error=error, username=username, next=next_url), \
        (401 if error else 200)


@app.route("/register", methods=["GET", "POST"])
def register():
    next_url = safe_next(request.values.get("next"))
    if g.user:
        return redirect(next_url)

    error = None
    username = ""
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")

        if not USERNAME_RE.match(username):
            error = "Username must be 3–32 characters: letters, numbers, dot, dash or underscore."
        elif len(password) < PASSWORD_MIN_LEN:
            error = f"Password must be at least {PASSWORD_MIN_LEN} characters."
        elif password != confirm:
            error = "Passwords don't match."
        else:
            user = db.create_user(username, generate_password_hash(password))
            if user is None:
                error = "That username is already taken."
            else:
                log_in(user)
                return redirect(next_url)

    return render_template("auth.html", mode="register", error=error, username=username, next=next_url), \
        (400 if error else 200)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------- Pages ----------

@app.route("/healthz")
def healthz():
    return {"status": "ok"}


@app.route("/")
@app.route("/c/<int:conversation_id>")
@login_required
def index(conversation_id=None):
    return render_template(
        "index.html",
        model_id=MODEL_ID,
        username=g.user["username"],
        free_limit=FREE_MESSAGE_LIMIT,
        message_max_chars=MESSAGE_MAX_CHARS,
        messages_left=messages_left(g.user["id"]),
    )


# ---------- Conversations API ----------

@app.get("/api/conversations")
@login_required
def list_conversations():
    return jsonify(db.list_conversations(g.user["id"]))


@app.post("/api/conversations")
@login_required
def create_conversation():
    return jsonify(db.create_conversation(g.user["id"])), 201


@app.get("/api/conversations/<int:conversation_id>")
@login_required
def get_conversation(conversation_id):
    conversation = require_conversation(conversation_id)
    conversation["messages"] = db.list_messages(conversation_id)
    return jsonify(conversation)


@app.patch("/api/conversations/<int:conversation_id>")
@login_required
def rename_conversation(conversation_id):
    require_conversation(conversation_id)
    title = ((request.get_json(silent=True) or {}).get("title") or "").strip()
    if not title:
        abort(400, description="Title cannot be empty.")
    return jsonify(db.rename_conversation(conversation_id, g.user["id"], make_title(title)))


@app.delete("/api/conversations/<int:conversation_id>")
@login_required
def delete_conversation(conversation_id):
    require_conversation(conversation_id)
    db.delete_conversation(conversation_id, g.user["id"])
    return "", 204


# ---------- Chat (streaming) ----------

@app.post("/api/conversations/<int:conversation_id>/messages")
@login_required
def send_message(conversation_id):
    conversation = require_conversation(conversation_id)
    user_id = g.user["id"]
    content = ((request.get_json(silent=True) or {}).get("content") or "").strip()
    if not content:
        abort(400, description="Message cannot be empty.")
    if len(content) > MESSAGE_MAX_CHARS:
        abort(400, description=f"Message is too long (max {MESSAGE_MAX_CHARS:,} characters).")
    if not db.reserve_message(user_id, FREE_MESSAGE_LIMIT):
        abort(403, description=f"You've used all {FREE_MESSAGE_LIMIT} free messages.")

    is_first_message = not db.list_messages(conversation_id)
    user_message_id = db.add_message(conversation_id, "user", content)
    if is_first_message and conversation["title"] == "New chat":
        db.rename_conversation(conversation_id, user_id, make_title(content))

    # The full chat stays in the database; the model only sees the newest messages that fit the window
    history = trim_history(
        [{"role": m["role"], "content": m["content"]} for m in db.list_messages(conversation_id)]
    )

    def generate():
        reply = ""
        try:
            for event in stream_chat(history):
                if event["type"] == "text":
                    reply += event["text"]
                elif event["type"] == "done":
                    event = {**event, "messagesLeft": messages_left(user_id)}
                yield json.dumps(event) + "\n"
        finally:
            # Runs on success, error, or client disconnect.
            if reply:
                db.add_message(conversation_id, "assistant", reply)
            else:
                # No answer: drop the user turn so history keeps alternating user/assistant,
                # and don't charge a free message for it
                db.delete_message(user_message_id)
                db.refund_message(user_id)

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
