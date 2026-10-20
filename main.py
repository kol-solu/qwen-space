"""Qwen Space - self-hostable chatbot web app (OpenAI-compatible)."""
import json
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Qwen Space")


# ---------- helpers ----------
def _read_json(name: str, default):
    p = DATA_DIR / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(name: str, data):
    tmp = DATA_DIR / (name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(DATA_DIR / name)


def _load_providers():
    providers = _read_json("providers.json", [])
    if not providers:  # first-run defaults
        providers = [
            {
                "id": "ollama",
                "name": "Ollama (local)",
                "baseUrl": "http://localhost:11434/v1",
                "apiKey": "ollama",
                "model": "qwen2.5:7b",
            },
            {
                "id": "openai",
                "name": "OpenAI",
                "baseUrl": "https://api.openai.com/v1",
                "apiKey": "",
                "model": "gpt-4o-mini",
            },
        ]
        _write_json("providers.json", providers)
    return providers


def _get_provider(pid: str):
    for p in _load_providers():
        if p["id"] == pid:
            return p
    raise HTTPException(404, "provider not found")


# ---------- models ----------
class ProviderIn(BaseModel):
    name: str
    baseUrl: str
    apiKey: str = ""
    model: str = ""


class ChatMessage(BaseModel):
    role: str
    content: str





class RenameIn(BaseModel):
    title: str


# ---------- providers API ----------
@app.get("/api/providers")
def list_providers():
    out = []
    for p in _load_providers():
        q = dict(p)
        key = q.get("apiKey") or ""
        q["hasKey"] = bool(key)
        q.pop("apiKey", None)
        out.append(q)
    return out


@app.post("/api/providers")
def add_provider(body: ProviderIn):
    providers = _load_providers()
    p = {"id": uuid.uuid4().hex[:8], **body.model_dump()}
    providers.append(p)
    _write_json("providers.json", providers)
    return {"id": p["id"]}


@app.put("/api/providers/{pid}")
def update_provider(pid: str, body: ProviderIn):
    providers = _load_providers()
    for i, p in enumerate(providers):
        if p["id"] == pid:
            upd = body.model_dump()
            # sentinel: keep the previously stored API key when field left blank
            if upd.get("apiKey") in ("__KEEP__", "") and p.get("apiKey"):
                upd["apiKey"] = p["apiKey"]
            providers[i] = {"id": pid, **upd}
            _write_json("providers.json", providers)
            return {"ok": True}
    raise HTTPException(404, "provider not found")


@app.delete("/api/providers/{pid}")
def delete_provider(pid: str):
    providers = _load_providers()
    new = [p for p in providers if p["id"] != pid]
    if len(new) == len(providers):
        raise HTTPException(404, "provider not found")
    _write_json("providers.json", new)
    return {"ok": True}


@app.get("/api/providers/{pid}/models")
async def fetch_models(pid: str):
    """List models from the upstream endpoint (/models)."""
    p = _get_provider(pid)
    url = p["baseUrl"].rstrip("/") + "/models"
    headers = {}
    if p.get("apiKey"):
        headers["Authorization"] = f"Bearer {p['apiKey']}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            data = r.json().get("data", [])
            return [m.get("id") for m in data if m.get("id")]
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"upstream returned {e.response.status_code}")
    except Exception as e:
        raise HTTPException(502, f"could not reach endpoint: {e}")


# ---------- chat (SSE streaming proxy) ----------
@app.post("/api/chat")
async def chat(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(422, "invalid JSON body")
    msgs = [ChatMessage(**m) for m in body.get("messages", [])]
    if not msgs:
        raise HTTPException(422, "no messages provided")
    p = _get_provider(body.get("providerId", ""))
    url = p["baseUrl"].rstrip("/") + "/chat/completions"
    payload = {
        "model": body.get("model") or p.get("model") or "default",
        "stream": True,
        "temperature": float(body.get("temperature", 0.7)),
        "messages": [{"role": "system", "content": body.get("system", "You are a helpful assistant.")}]
        + [m.model_dump() for m in msgs],
    }
    headers = {"Content-Type": "application/json"}
    if p.get("apiKey"):
        headers["Authorization"] = f"Bearer {p['apiKey']}"

    async def stream():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=20)) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    if resp.status_code != 200:
                        text = (await resp.aread()).decode(errors="replace")[:500]
                        yield f"data: {json.dumps({'error': f'Upstream {resp.status_code}: {text}'})}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            yield "data: [DONE]\n\n"
                            break
                        try:
                            chunk = json.loads(data)
                            delta = chunk["choices"][0].get("delta", {})
                            content = delta.get("content")
                            if content:
                                yield f"data: {json.dumps({'c': content})}\n\n"
                        except (KeyError, IndexError, ValueError):
                            continue
        except httpx.ConnectError:
            yield f"data: {json.dumps({'error': 'Could not connect to endpoint. Is your local LLM server running?'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- conversations API ----------
@app.get("/api/conversations")
def list_conversations():
    convs = _read_json("conversations.json", [])
    return [
        {"id": c["id"], "title": c.get("title", "New chat"),
         "providerId": c.get("providerId"), "updatedAt": c.get("updatedAt", 0)}
        for c in sorted(convs, key=lambda c: c.get("updatedAt", 0), reverse=True)
    ]


@app.get("/api/conversations/{cid}")
def get_conversation(cid: str):
    for c in _read_json("conversations.json", []):
        if c["id"] == cid:
            return c
    raise HTTPException(404, "conversation not found")


@app.post("/api/conversations")
def create_conversation():
    convs = _read_json("conversations.json", [])
    conv = {"id": uuid.uuid4().hex[:12], "title": "New chat",
            "messages": [], "createdAt": time.time(), "updatedAt": time.time()}
    convs.append(conv)
    _write_json("conversations.json", convs)
    return conv


@app.put("/api/conversations/{cid}")
def save_conversation(cid: str, conv: dict):
    convs = _read_json("conversations.json", [])
    for i, c in enumerate(convs):
        if c["id"] == cid:
            conv["id"] = cid
            conv["updatedAt"] = time.time()
            convs[i] = conv
            _write_json("conversations.json", convs)
            return {"ok": True}
    raise HTTPException(404, "conversation not found")


@app.patch("/api/conversations/{cid}")
def rename_conversation(cid: str, body: RenameIn):
    convs = _read_json("conversations.json", [])
    for c in convs:
        if c["id"] == cid:
            c["title"] = body.title[:80] or "New chat"
            _write_json("conversations.json", convs)
            return {"ok": True}
    raise HTTPException(404, "conversation not found")


@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: str):
    convs = _read_json("conversations.json", [])
    new = [c for c in convs if c["id"] != cid]
    if len(new) == len(convs):
        raise HTTPException(404, "conversation not found")
    _write_json("conversations.json", new)
    return {"ok": True}


# ---------- static frontend ----------
STATIC_DIR = Path(__file__).parent / "static"


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=7860)
