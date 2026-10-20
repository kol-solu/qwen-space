/* Qwen Space frontend */
const $ = (s) => document.querySelector(s);
const els = {
  sidebar: $("#sidebar"), overlay: $("#sb-overlay"), convList: $("#conv-list"),
  selProvider: $("#sel-provider"), selModel: $("#sel-model"),
  chatArea: $("#chat-area"), messages: $("#messages"), welcome: $("#welcome"),
  input: $("#input"), btnSend: $("#btn-send"), btnStop: $("#btn-stop"),
  modal: $("#modal-backdrop"), provList: $("#provider-list"),
};

let providers = [], conversations = [], currentId = null, editingProvId = null;
let streaming = false, abortCtrl = null;

/* ---------- storage helpers ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("qs_" + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem("qs_" + k, JSON.stringify(v)); }
};

async function api(path, opts = {}) {
  const r = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" }, ...opts,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

/* ---------- markdown rendering ---------- */
function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    const raw = marked.parse(text, { breaks: true });
    return DOMPurify.sanitize(raw);
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function enhanceCode(container) {
  container.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement.classList.contains("codeblock")) return;
    const lang = (code.className.match(/language-(\S+)/) || [])[1] || "text";
    const block = document.createElement("div");
    block.className = "codeblock";
    block.innerHTML = `<div class="cb-head"><span>${escapeHtml(lang)}</span><button class="cb-copy">📋 Copy</button></div>`;
    pre.replaceWith(block);
    block.appendChild(pre);
    block.querySelector(".cb-copy").onclick = () => {
      navigator.clipboard.writeText(code.textContent);
      block.querySelector(".cb-copy").textContent = "✓ Copied";
      setTimeout(() => (block.querySelector(".cb-copy").textContent = "📋 Copy"), 1500);
    };
    if (window.hljs) { try { hljs.highlightElement(code); } catch {} }
  });
  container.querySelectorAll("code:not(pre code)").forEach(c => c.classList.add("inline"));
}

/* ---------- providers / models ---------- */
async function loadProviders() {
  providers = await api("/providers");
  els.selProvider.innerHTML = "";
  for (const p of providers) {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.name;
    els.selProvider.appendChild(o);
  }
  const saved = store.get("provider", null);
  if (saved && providers.some(p => p.id === saved)) els.selProvider.value = saved;
  await loadModels(false);
}

async function loadModels(refresh) {
  const pid = els.selProvider.value;
  const prov = providers.find(p => p.id === pid);
  if (!prov) return;
  els.selModel.innerHTML = "";
  let models = [];
  if (refresh) {
    els.selModel.disabled = true;
    try { models = await api(`/providers/${pid}/models`); }
    catch (e) { models = []; toast(`Could not list models: ${e.message}`); }
    els.selModel.disabled = false;
  } else {
    models = store.get(`models_${pid}`, []);
  }
  if (!models.length && prov.model) models = [prov.model];
  if (!models.length) models = ["default"];
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    els.selModel.appendChild(o);
  }
  const savedModel = store.get("model_" + pid, null);
  if (savedModel && models.includes(savedModel)) els.selModel.value = savedModel;
  else if (prov.model && models.includes(prov.model)) els.selModel.value = prov.model;
  store.set(`models_${pid}`, models);
  store.set("model_" + pid, els.selModel.value);
}

/* ---------- conversations ---------- */
async function loadConversations() {
  conversations = await api("/conversations");
  drawConvList();
}
function drawConvList() {
  els.convList.innerHTML = "";
  for (const c of conversations) {
    const div = document.createElement("div");
    div.className = "conv-item" + (c.id === currentId ? " active" : "");
    div.innerHTML = `<span class="conv-title">${escapeHtml(c.title)}</span>
      <span class="conv-actions">
        <button class="mini-btn rn" title="Rename">✏️</button>
        <button class="mini-btn del" title="Delete">🗑️</button>
      </span>`;
    div.onclick = (e) => {
      if (e.target.closest(".rn") || e.target.closest(".del")) return;
      openConversation(c.id);
      closeSidebarMobile();
    };
    div.querySelector(".rn").onclick = () => startRename(div, c);
    div.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete "${c.title}"?`)) return;
      await api(`/conversations/${c.id}`, { method: "DELETE" });
      if (currentId === c.id) newChat();
      await loadConversations();
    };
    els.convList.appendChild(div);
  }
}
function startRename(div, c) {
  const titleEl = div.querySelector(".conv-title");
  const inp = document.createElement("input");
  inp.className = "rename-input"; inp.value = c.title;
  titleEl.replaceWith(inp); inp.focus(); inp.select();
  const finish = async (save) => {
    if (save && inp.value.trim()) {
      await api(`/conversations/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: inp.value.trim() }) });
      await loadConversations();
    } else drawConvList();
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") finish(false); };
  inp.onclick = (e) => e.stopPropagation();
}

async function openConversation(cid) {
  const conv = await api(`/conversations/${cid}`);
  currentId = conv.id;
  store.set("lastConv", cid);
  if (conv.providerId && providers.some(p => p.id === conv.providerId)) {
    els.selProvider.value = conv.providerId;
    store.set("provider", conv.providerId);
    await loadModels(false);
  }
  if (conv.model && [...els.selModel.options].some(o => o.value === conv.model)) {
    els.selModel.value = conv.model;
  }
  els.messages.innerHTML = "";
  els.welcome.classList.toggle("hidden", (conv.messages || []).length > 0);
  for (const m of conv.messages) appendBubble(m.role, m.content);
  drawConvList();
  scrollBottom(true);
}

function newChat() {
  if (streaming) return;
  currentId = null;
  store.set("lastConv", null);
  els.messages.innerHTML = "";
  els.welcome.classList.remove("hidden");
  drawConvList();
  els.input.focus();
}

/* ---------- message bubbles ---------- */
function appendBubble(role, content) {
  const wrap = document.createElement("div");
  wrap.className = role === "user" ? "msg-user" : "msg-assistant";
  if (role === "user") {
    wrap.innerHTML = `<div class="avatar">🙂</div><div class="bubble"></div>`;
    wrap.querySelector(".bubble").textContent = content;
  } else {
    wrap.innerHTML = `<div class="avatar">Q</div><div style="flex:1;min-width:0">
      <div class="bubble"></div>
      <div class="actions-row"><button class="mini-btn copy-msg">📋 Copy</button></div></div>`;
    const b = wrap.querySelector(".bubble");
    b.innerHTML = renderMarkdown(content);
    enhanceCode(b);
    wrap.querySelector(".copy-msg").onclick = (e) => {
      navigator.clipboard.writeText(content);
      e.target.textContent = "✓ Copied";
      setTimeout(() => (e.target.textContent = "📋 Copy"), 1500);
    };
  }
  els.messages.appendChild(wrap);
  return wrap;
}

function appendError(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg-assistant msg-error";
  wrap.innerHTML = `<div class="avatar">!</div><div class="bubble"></div>`;
  wrap.querySelector(".bubble").textContent = text;
  els.messages.appendChild(wrap);
  return wrap;
}

function scrollBottom(force) {
  const ca = els.chatArea;
  const nearBottom = ca.scrollHeight - ca.scrollTop - ca.clientHeight < 160;
  if (force || nearBottom) ca.scrollTop = ca.scrollHeight;
}

function toast(msg) {
  const t = document.createElement("div");
  t.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:10px 18px;border-radius:10px;z-index:99;font-size:13.5px;box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:80vw";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/* ---------- chat send + SSE ---------- */
async function sendMessage(text) {
  if (streaming || !text.trim()) return;
  const pid = els.selProvider.value;
  if (!pid) { toast("Add a provider in Settings first"); return; }
  const model = els.selModel.value || "default";

  try {
    // create conversation lazily
    if (!currentId) {
      const conv = await api("/conversations", { method: "POST" });
      currentId = conv.id;
      store.set("lastConv", currentId);
      await loadConversations();
    }
    const full = await api(`/conversations/${currentId}`);
    const history = full.messages || [];

    els.welcome.classList.add("hidden");
    appendBubble("user", text);
    history.push({ role: "user", content: text });

    const wrap = appendBubble("assistant", "");
    const bubble = wrap.querySelector(".bubble");
    bubble.innerHTML = '<span class="cursor-blink"></span>';

    streaming = true;
    els.btnSend.classList.add("hidden");
    els.btnStop.classList.remove("hidden");
    abortCtrl = new AbortController();
    scrollBottom(true);

    let acc = "", errMsg = null;
    const resp = await fetch("/api/chat", {
      method: "POST", signal: abortCtrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: pid, model,
        messages: history,
        temperature: parseFloat($("#inp-temp").value),
        system: $("#inp-system").value,
      }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data);
          if (obj.error) errMsg = obj.error;
          else if (obj.c) {
            acc += obj.c;
            bubble.innerHTML = renderMarkdown(acc) + '<span class="cursor-blink"></span>';
            scrollBottom(false);
          }
        } catch {}
      }
    }

    if (acc) {
      bubble.innerHTML = renderMarkdown(acc);
      enhanceCode(bubble);
      history.push({ role: "assistant", content: acc });
      if (errMsg) appendError("Stream ended early: " + errMsg);
    } else {
      wrap.remove();
      appendError(errMsg || "The model returned an empty response.");
    }

    // auto-title from first user message
    let title = full.title || "New chat";
    if (title === "New chat") {
      const firstUser = history.find(m => m.role === "user");
      if (firstUser) title = firstUser.content.slice(0, 42) + (firstUser.content.length > 42 ? "…" : "");
    }
    await api(`/conversations/${currentId}`, {
      method: "PUT",
      body: JSON.stringify({ title, providerId: pid, model, messages: history }),
    }).catch(() => {});
  } catch (e) {
    if (e.name === "AbortError") { /* user stopped: keep partial text already rendered */ }
    else toast("Request failed: " + e.message);
  } finally {
    streaming = false;
    abortCtrl = null;
    els.btnStop.classList.add("hidden");
    els.btnSend.classList.remove("hidden");
    await loadConversations().catch(() => {});
    els.input.focus();
  }
}

/* ---------- settings modal ---------- */
function drawProviderCards() {
  els.provList.innerHTML = "";
  if (!providers.length) els.provList.innerHTML = '<div class="prov-url">No providers yet — add one below.</div>';
  for (const p of providers) {
    const div = document.createElement("div");
    div.className = "prov-card" + (p.id === editingProvId ? " selected" : "");
    div.innerHTML = `<div class="prov-info"><div class="prov-name">${escapeHtml(p.name)}</div>
      <div class="prov-url">${escapeHtml(p.baseUrl)} · ${escapeHtml(p.model || "no default model")}${p.hasKey ? " · 🔑" : ""}</div></div>
      <button class="mini-btn edit">✏️</button><button class="mini-btn del">🗑️</button>`;
    div.querySelector(".edit").onclick = () => {
      editingProvId = p.id;
      $("#pf-name").value = p.name; $("#pf-url").value = p.baseUrl;
      $("#pf-key").value = "";
      $("#pf-key").placeholder = p.hasKey ? "(key saved — leave blank to keep)" : "API key (optional)";
      $("#pf-model").value = p.model || "";
      $("#pf-save").textContent = "Update";
      drawProviderCards();
    };
    div.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete provider "${p.name}"?`)) return;
      await api(`/providers/${p.id}`, { method: "DELETE" });
      if (editingProvId === p.id) resetProvForm();
      await loadProviders(); drawProviderCards();
    };
    els.provList.appendChild(div);
  }
}
function resetProvForm() {
  editingProvId = null;
  $("#pf-name").value = ""; $("#pf-url").value = ""; $("#pf-key").value = ""; $("#pf-model").value = "";
  $("#pf-key").placeholder = "API key (optional for local servers)";
  $("#pf-save").textContent = "Add / Update";
}

async function saveProvider() {
  const name = $("#pf-name").value.trim();
  const baseUrl = $("#pf-url").value.trim();
  if (!name || !baseUrl) { setStatus("Name and Base URL are required"); return; }
  if (!/^https?:\/\//.test(baseUrl)) { setStatus("Base URL must start with http:// or https://"); return; }
  const apiKey = $("#pf-key").value.trim(); // blank => keep existing (server handles)
  const body = { name, baseUrl, apiKey, model: $("#pf-model").value.trim() };
  try {
    if (editingProvId) {
      await api(`/providers/${editingProvId}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      await api("/providers", { method: "POST", body: JSON.stringify(body) });
    }
    setStatus("✓ Saved");
    resetProvForm();
    await loadProviders();
    drawProviderCards();
  } catch (e) { setStatus("✗ " + e.message); }
}
function setStatus(s) { $("#pf-status").textContent = s; setTimeout(() => ($("#pf-status").textContent = ""), 4000); }

/* ---------- theme ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
}

/* ---------- init & wiring ---------- */
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + "px";
}
function submitInput() {
  const t = els.input.value;
  if (!t.trim()) return;
  els.input.value = ""; autosize();
  sendMessage(t);
}
function closeSidebarMobile() { els.sidebar.classList.remove("open"); els.overlay.classList.remove("show"); }

function init() {
  applyTheme(store.get("theme", "dark"));
  $("#inp-temp").value = store.get("temp", 0.7);
  $("#temp-val").textContent = $("#inp-temp").value;
  $("#inp-system").value = store.get("system", "You are a helpful assistant.");

  $("#btn-new-chat").onclick = newChat;
  $("#btn-theme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("#btn-settings").onclick = () => { drawProviderCards(); els.modal.classList.remove("hidden"); };
  $("#btn-modal-close").onclick = () => els.modal.classList.add("hidden");
  els.modal.onclick = (e) => { if (e.target === els.modal) els.modal.classList.add("hidden"); };
  $("#pf-save").onclick = saveProvider;
  $("#btn-refresh-models").onclick = () => loadModels(true);
  els.selProvider.onchange = () => { store.set("provider", els.selProvider.value); loadModels(false); };
  els.selModel.onchange = () => store.set("model_" + els.selProvider.value, els.selModel.value);
  $("#inp-temp").oninput = (e) => { $("#temp-val").textContent = e.target.value; store.set("temp", e.target.value); };
  $("#inp-system").onchange = (e) => store.set("system", e.target.value);

  els.btnSend.onclick = submitInput;
  els.btnStop.onclick = () => abortCtrl && abortCtrl.abort();
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitInput(); }
  });
  els.input.addEventListener("input", autosize);

  document.querySelectorAll(".sg").forEach(b =>
    b.onclick = () => sendMessage(b.textContent.replace(/^\S+\s/, "")));

  $("#btn-open-sb").onclick = () => { els.sidebar.classList.add("open"); els.overlay.classList.add("show"); };
  $("#btn-close-sb").onclick = closeSidebarMobile;
  els.overlay.onclick = closeSidebarMobile;

  loadProviders().then(async () => {
    await loadConversations();
    const last = store.get("lastConv", null);
    if (last && conversations.some(c => c.id === last)) openConversation(last);
  }).catch(e => toast("Failed to load: " + e.message));
}

init();
