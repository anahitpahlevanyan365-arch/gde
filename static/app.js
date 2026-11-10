const $ = (id) => document.getElementById(id);

const appEl = $("app");
const mainEl = document.querySelector(".main");
const chatEl = $("chat");
const messagesEl = $("messages");
const historyEl = $("history");
const form = $("composer");
const input = $("input");
const sendBtn = $("sendBtn");
const usageEl = $("usage");
const titleEl = $("topbarTitle");
const searchInput = $("searchInput");
const menuEl = $("convMenu");
const deleteModal = $("deleteModal");
const toastEl = $("toast");
const quotaEl = $("quota");
const FREE_LIMIT = Number(quotaEl.dataset.limit);

const ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

const state = {
  conversations: [],
  currentId: null,
  busy: false,
  messagesLeft: Number(quotaEl.dataset.left),
  menuFor: null,     // conversation id the context menu is open for
  deleteFor: null,   // conversation id pending deletion
};

/* ================= API ================= */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    redirectIfLoggedOut(res);
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// Session expired or logged out in another tab: go to the login page and come back here after
function redirectIfLoggedOut(res) {
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
}

/* ================= Markdown (minimal, safe) ================= */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderMarkdown(src) {
  const parts = src.split(/```/);
  let html = "";

  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Code block (may be unterminated while streaming)
      const nl = part.indexOf("\n");
      const lang = nl === -1 ? part.trim() : part.slice(0, nl).trim();
      const code = nl === -1 ? "" : part.slice(nl + 1).replace(/\n$/, "");
      html += `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || "code")}</span>` +
              `<button class="copy-btn" type="button">Copy code</button></div>` +
              `<pre><code>${escapeHtml(code)}</code></pre></div>`;
      return;
    }

    const lines = escapeHtml(part).split("\n");
    let listType = null;
    let para = [];

    const flushPara = () => {
      if (para.length) { html += `<p>${inline(para.join("<br>"))}</p>`; para = []; }
    };
    const closeList = () => {
      if (listType) { html += `</${listType}>`; listType = null; }
    };

    for (const line of lines) {
      const h = line.match(/^(#{1,3})\s+(.*)/);
      const ul = line.match(/^\s*[-*]\s+(.*)/);
      const ol = line.match(/^\s*\d+\.\s+(.*)/);

      if (h) {
        flushPara(); closeList();
        html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      } else if (ul || ol) {
        flushPara();
        const type = ul ? "ul" : "ol";
        if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
      } else if (line.trim() === "") {
        flushPara(); closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara(); closeList();
  });

  return html;
}

/* ================= Helpers ================= */
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setEmpty(isEmpty) {
  mainEl.classList.toggle("empty", isEmpty);
}

function setBusy(busy) {
  state.busy = busy;
  input.disabled = busy || state.messagesLeft <= 0;
  updateSendBtn();
  if (!input.disabled) input.focus();
}

function updateSendBtn() {
  sendBtn.disabled = state.busy || state.messagesLeft <= 0 || !input.value.trim();
}

/* ================= Free message limit ================= */
function renderQuota() {
  const left = Math.max(state.messagesLeft, 0);
  const out = left === 0;
  quotaEl.textContent = out
    ? `You've used all ${FREE_LIMIT} free messages.`
    : `${left} of ${FREE_LIMIT} free message${FREE_LIMIT === 1 ? "" : "s"} left`;
  quotaEl.classList.toggle("out", out);
  quotaEl.classList.toggle("low", !out && left <= 3);

  form.classList.toggle("locked", out);
  input.disabled = state.busy || out;
  input.placeholder = out ? "No free messages left" : "Ask anything";
  document.querySelectorAll(".suggestion").forEach((b) => (b.disabled = out));
  updateSendBtn();
}

function setMessagesLeft(n) {
  state.messagesLeft = n;
  renderQuota();
}

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
  updateSendBtn();
}

function isMobile() {
  return window.matchMedia("(max-width: 820px)").matches;
}

function closeMobileSidebar() {
  appEl.classList.remove("sidebar-mobile-open");
}

/* ================= Sidebar history ================= */
function groupLabel(isoDate) {
  const date = new Date(isoDate);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday - date) / 86400000) + 1;

  if (date >= startOfToday) return "Today";
  if (days <= 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function renderHistory() {
  const query = searchInput.value.trim().toLowerCase();
  const items = state.conversations.filter((c) => c.title.toLowerCase().includes(query));

  historyEl.innerHTML = "";
  if (!items.length) {
    historyEl.innerHTML = `<p class="history-empty">${query ? "No chats match your search." : "Your chats will appear here."}</p>`;
    return;
  }

  let currentLabel = null;
  let groupEl = null;

  for (const conv of items) {
    const label = groupLabel(conv.updated_at);
    if (label !== currentLabel) {
      currentLabel = label;
      groupEl = document.createElement("div");
      groupEl.className = "history-group";
      groupEl.innerHTML = `<p class="history-label">${escapeHtml(label)}</p>`;
      historyEl.appendChild(groupEl);
    }

    const row = document.createElement("div");
    row.className = "conv" + (conv.id === state.currentId ? " active" : "");
    row.dataset.id = conv.id;
    row.innerHTML =
      `<a class="conv-link" href="/c/${conv.id}" title="${escapeHtml(conv.title)}">${escapeHtml(conv.title)}</a>` +
      `<button class="conv-more" aria-label="Chat options">${ICON_MORE}</button>`;
    groupEl.appendChild(row);
  }
}

async function loadConversations() {
  state.conversations = await api("/api/conversations");
  renderHistory();
}

/* ================= Messages ================= */
function addMessage(role, content = "", { html = false } = {}) {
  setEmpty(false);

  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (role === "user") {
    bubble.textContent = content;
  } else {
    bubble.innerHTML = html ? content : renderMarkdown(content);
  }
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  return bubble;
}

function addAssistantActions(bubble, text) {
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const copy = document.createElement("button");
  copy.className = "msg-action";
  copy.title = "Copy";
  copy.innerHTML = ICON_COPY;
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      copy.innerHTML = ICON_CHECK;
      setTimeout(() => (copy.innerHTML = ICON_COPY), 1500);
    });
  });
  actions.appendChild(copy);
  bubble.parentElement.appendChild(actions);
}

/* ================= Navigation ================= */
function newChat({ push = true } = {}) {
  state.currentId = null;
  messagesEl.innerHTML = "";
  usageEl.textContent = "";
  titleEl.textContent = "Nova Chat";
  document.title = "Nova Chat";
  setEmpty(true);
  if (push && location.pathname !== "/") history.pushState({}, "", "/");
  renderHistory();
  closeMobileSidebar();
  input.focus();
}

async function openConversation(id, { push = true } = {}) {
  try {
    const conv = await api(`/api/conversations/${id}`);
    state.currentId = conv.id;
    messagesEl.innerHTML = "";
    usageEl.textContent = "";
    titleEl.textContent = conv.title;
    document.title = `${conv.title} · Nova Chat`;

    for (const m of conv.messages) {
      const bubble = addMessage(m.role, m.content);
      if (m.role === "assistant") addAssistantActions(bubble, m.content);
    }
    setEmpty(conv.messages.length === 0);
    if (push) history.pushState({}, "", `/c/${conv.id}`);
    renderHistory();
    closeMobileSidebar();
    scrollToBottom();
    input.focus();
  } catch (err) {
    toast(err.message);
    newChat();
  }
}

function routeFromUrl() {
  const match = location.pathname.match(/^\/c\/(\d+)$/);
  if (match) openConversation(Number(match[1]), { push: false });
  else newChat({ push: false });
}

/* ================= Chat ================= */
async function sendMessage(text) {
  text = text.trim();
  if (!text || state.busy) return;
  if (state.messagesLeft <= 0) {
    toast(`You've used all ${FREE_LIMIT} free messages.`);
    return;
  }

  setBusy(true);
  input.value = "";
  autoResize();

  try {
    // Create the conversation lazily on the first message
    if (state.currentId === null) {
      const conv = await api("/api/conversations", { method: "POST" });
      state.currentId = conv.id;
      history.pushState({}, "", `/c/${conv.id}`);
    }
  } catch (err) {
    toast(err.message);
    input.value = text;
    autoResize();
    setBusy(false);
    return;
  }

  const conversationId = state.currentId;
  addMessage("user", text);
  const bubble = addMessage("assistant", '<div class="typing"><span></span><span></span><span></span></div>', { html: true });
  scrollToBottom();

  // Show the new chat in the sidebar right away (title is set from the first message)
  loadConversations().then(() => {
    const conv = state.conversations.find((c) => c.id === conversationId);
    if (conv && state.currentId === conversationId) {
      titleEl.textContent = conv.title;
      document.title = `${conv.title} · Nova Chat`;
    }
  });

  let reply = "";
  try {
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok || !res.body) {
      redirectIfLoggedOut(res);
      if (res.status === 403) setMessagesLeft(0);  // limit reached (e.g. used up in another tab)
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);

        if (event.type === "text") {
          const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
          reply += event.text;
          bubble.innerHTML = renderMarkdown(reply);
          bubble.classList.add("cursor");
          if (nearBottom) scrollToBottom();
        } else if (event.type === "done") {
          if (event.messagesLeft != null) setMessagesLeft(event.messagesLeft);
          const u = event.usage || {};
          if (u.inputTokens != null && state.currentId === conversationId) {
            usageEl.textContent = `${u.inputTokens} in · ${u.outputTokens} out`;
          }
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    }

    bubble.classList.remove("cursor");
    addAssistantActions(bubble, reply);
  } catch (err) {
    bubble.classList.remove("cursor");
    if (!reply) {
      // Server discarded this turn, so let the user retry it
      bubble.parentElement.classList.add("error");
      bubble.textContent = `⚠ ${err.message}`;
      if (state.currentId === conversationId && !input.value) {
        input.value = text;
        autoResize();
      }
    } else {
      toast(err.message);
    }
  } finally {
    setBusy(false);
    loadConversations();
  }
}

/* ================= Rename / delete ================= */
function openMenu(id, anchor) {
  closeMenu();
  state.menuFor = id;
  anchor.closest(".conv").classList.add("menu-open");
  const rect = anchor.getBoundingClientRect();
  menuEl.classList.add("open");
  const top = Math.min(rect.bottom + 4, window.innerHeight - menuEl.offsetHeight - 8);
  menuEl.style.top = `${top}px`;
  menuEl.style.left = `${rect.left}px`;
}

function closeMenu() {
  menuEl.classList.remove("open");
  document.querySelectorAll(".conv.menu-open").forEach((el) => el.classList.remove("menu-open"));
  state.menuFor = null;
}

function startRename(id) {
  const row = historyEl.querySelector(`.conv[data-id="${id}"]`);
  const conv = state.conversations.find((c) => c.id === id);
  if (!row || !conv) return;

  const link = row.querySelector(".conv-link");
  const field = document.createElement("input");
  field.className = "conv-input";
  field.value = conv.title;
  link.replaceWith(field);
  row.querySelector(".conv-more").style.display = "none";
  field.focus();
  field.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const title = field.value.trim();
    if (save && title && title !== conv.title) {
      try {
        const updated = await api(`/api/conversations/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        });
        conv.title = updated.title;
        if (state.currentId === id) {
          titleEl.textContent = updated.title;
          document.title = `${updated.title} · Nova Chat`;
        }
      } catch (err) {
        toast(err.message);
      }
    }
    renderHistory();
  };

  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));
}

function askDelete(id) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  state.deleteFor = id;
  $("deleteName").textContent = conv.title;
  deleteModal.classList.add("open");
  $("confirmDelete").focus();
}

function closeDeleteModal() {
  deleteModal.classList.remove("open");
  state.deleteFor = null;
}

async function confirmDelete() {
  const id = state.deleteFor;
  closeDeleteModal();
  if (id == null) return;
  try {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    state.conversations = state.conversations.filter((c) => c.id !== id);
    if (state.currentId === id) newChat();
    else renderHistory();
    toast("Chat deleted");
  } catch (err) {
    toast(err.message);
  }
}

/* ================= Events ================= */
form.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(input.value);
});

input.addEventListener("input", autoResize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage(input.value);
  }
});

document.querySelectorAll(".suggestion").forEach((btn) =>
  btn.addEventListener("click", () => sendMessage(btn.dataset.prompt))
);

$("newChatBtn").addEventListener("click", () => newChat());
$("topNewChatBtn").addEventListener("click", () => newChat());

$("closeSidebarBtn").addEventListener("click", () => {
  if (isMobile()) return closeMobileSidebar();
  appEl.classList.add("sidebar-collapsed");
  localStorage.setItem("sidebarCollapsed", "1");
});
$("openSidebarBtn").addEventListener("click", () => {
  if (isMobile()) return appEl.classList.add("sidebar-mobile-open");
  appEl.classList.remove("sidebar-collapsed");
  localStorage.removeItem("sidebarCollapsed");
});
$("backdrop").addEventListener("click", closeMobileSidebar);

searchInput.addEventListener("input", renderHistory);

historyEl.addEventListener("click", (e) => {
  const more = e.target.closest(".conv-more");
  if (more) {
    e.preventDefault();
    const id = Number(more.closest(".conv").dataset.id);
    if (state.menuFor === id) closeMenu();
    else openMenu(id, more);
    return;
  }
  const link = e.target.closest(".conv-link");
  if (link && !e.ctrlKey && !e.metaKey && e.button === 0) {
    e.preventDefault();
    const id = Number(link.closest(".conv").dataset.id);
    if (id !== state.currentId) openConversation(id);
    else closeMobileSidebar();
  }
});

menuEl.addEventListener("click", (e) => {
  const item = e.target.closest(".menu-item");
  if (!item) return;
  const id = state.menuFor;
  closeMenu();
  if (item.dataset.action === "rename") startRename(id);
  if (item.dataset.action === "delete") askDelete(id);
});

document.addEventListener("click", (e) => {
  if (!menuEl.contains(e.target) && !e.target.closest(".conv-more")) closeMenu();
});
historyEl.addEventListener("scroll", closeMenu);

$("cancelDelete").addEventListener("click", closeDeleteModal);
$("confirmDelete").addEventListener("click", confirmDelete);
deleteModal.addEventListener("click", (e) => {
  if (e.target === deleteModal) closeDeleteModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); closeDeleteModal(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    newChat();
  }
});

// Copy buttons on code blocks
messagesEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const code = btn.closest(".code-block").querySelector("code").innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy code"), 1500);
  });
});

window.addEventListener("popstate", routeFromUrl);

/* ================= Init ================= */
if (localStorage.getItem("sidebarCollapsed")) appEl.classList.add("sidebar-collapsed");
renderQuota();
loadConversations().catch((err) => toast(err.message));
routeFromUrl();
