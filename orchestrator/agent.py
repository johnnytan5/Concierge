"""Process 1 — asyncio orchestrator. Holds the AssemblyAI Voice Agent
WebSocket and the client-side tool handlers. Never touches MuJoCo or
task_engine's tick loop directly (CLAUDE.md constraint 1) — task_engine
runs as its own process, talked to only via cmd_queue + the shared
`state` dict (see task_engine/engine.py).

This *is* the "simulated phone call": no Twilio, no browser — a local
mic/speaker session, framed narratively as the front-desk line for the
demo recording.

BYO-LLM requires a STORED AGENT, not inline session.update — verified
live 2026-09-07: sending `llm` on session.update gets rejected with a
`session.error` ("BYO LLM config is not allowed on session.update; define
it on a stored agent via POST /v1/agents"). So this file creates (or
reuses) a stored agent via `ensure_agent()`, then connects with
`{"agent_id": ...}` only. Set ASSEMBLYAI_AGENT_ID in .env once you have
one, to skip re-creating a duplicate agent every run — `ensure_agent()`
prints the id on first create.

Other things verified live on the same date, all the hard way:
  - The created-agent response field is `id`, not `agent_id`.
  - `session.updated` fires once before `session.ready` — read past it,
    it's not the connect confirmation itself.
  - The stored agent's own POST/GET representation can show a different
    placeholder in `output.voice` (e.g. "ivy") than the top-level
    `voice.voice_id` you set (e.g. "anna") — confirmed the actual session
    voice at connect time correctly follows the top-level `voice_id`, so
    that mismatch in the stored record is cosmetic, not a bug to chase.
  - An early test here got the raw API key echoed back in a 422
    validation-error response body (missing required fields), which
    landed unredacted in a terminal/transcript. `_redact()` below exists
    because of that — never print an agent_definition()/error body
    without it again.
  - Stored agents observed to vanish (404 on GET, `agent_not_found` on
    connect) within roughly one to two minutes of creation on this
    account — confirmed it's not tied to session usage (one disappeared
    with no session ever having touched it) and confirmed it's not
    instant (a fresh one still GETs fine at +10s). Docs don't mention any
    TTL/expiry/per-account limit at all, so the exact cause (a real
    expiry, a free/trial-tier limit, or something else) is unconfirmed —
    treat it as a fact of this account's current behavior, not something
    to "fix" upstream. Consequence: do NOT cache a created agent_id
    across runs and assume it still works — `ensure_agent()` creates
    fresh by default, and `run_agent()` self-heals by recreating once if
    `agent_not_found` arrives right after connecting.

Two more, verified against the live events-reference doc after the fact:
  - `transcript.user`/`transcript.agent` carry their text in a `text`
    field, not `transcript` — this file had it wrong (silently printed
    empty strings, no crash) until checked against the live schema.
  - `tool.result`'s `result` field is a **JSON-encoded string**, not a
    raw object — `{"result": "{\"eta_seconds\": 90}"}`, not
    `{"result": {"eta_seconds": 90}}`. This file had it wrong too; fixed
    by wrapping with `json.dumps()` before sending.
"""
import asyncio
import base64
import json
import multiprocessing as mp
import os
import urllib.error
import urllib.request

import numpy as np
import sounddevice as sd
import websockets
from dotenv import load_dotenv

from orchestrator.tools import SESSION_TOOLS, ToolHandlers
from task_engine.engine import run as run_task_engine

load_dotenv()

WS_URL = "wss://agents.assemblyai.com/v1/ws"
AGENTS_URL = "https://agents.assemblyai.com/v1/agents"
SAMPLE_RATE = 24_000
LLM_MODEL = "claude-sonnet-5"  # verified live against /docs/llm-gateway/available-models, 2026-09-06

SYSTEM_PROMPT = (
    "You are the front-desk voice assistant for a hotel. Guests and staff "
    "ask you to send items to rooms, check on deliveries already under way, "
    "or change/cancel one mid-flight. Use dispatch_delivery, "
    "check_delivery_status, amend_delivery, recall_robot, get_robot_state "
    "and announce_arrival for anything involving the delivery robot — "
    "never claim a delivery is done, in progress, or arrived unless a tool "
    "told you so first."
)

# Room numbers / dish names pulled straight from PLAN.md's scenarios (S1-S3) —
# RQ2 is literally about how much this list helps WER on code-switched audio.
KEYTERMS = ["1204", "0803", "towel", "toothbrush", "char kuey teow"]


def _redact(obj):
    """Strip api_key values before logging/printing a request or error
    body. See the module docstring's incident note — do not remove this."""
    if isinstance(obj, dict):
        return {k: ("***REDACTED***" if k == "api_key" else _redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


def agent_definition(api_key: str) -> dict:
    """Body for POST /v1/agents (stored agent). Required top-level fields
    per the live API: name, system_prompt, voice ({"voice_id": ...}) —
    NOT the same shape as session.update's inline config (there's no
    top-level "voice" there, and `llm` is rejected there entirely)."""
    return {
        "name": "concierge-front-desk",
        "system_prompt": SYSTEM_PROMPT,
        "voice": {"voice_id": "anna"},
        "greeting": "Front desk, how can I help?",
        "input": {
            "format": {"encoding": "audio/pcm"},
            "keyterms": KEYTERMS,
        },
        "tools": SESSION_TOOLS,
        "llm": [{
            "base_url": "https://llm-gateway.assemblyai.com/v1",
            "model": LLM_MODEL,
            "api_key": api_key,
        }],
    }


def ensure_agent(api_key: str, force_new: bool = False) -> str:
    """Create a stored agent. Creates fresh by default — do not assume a
    previously created id still works (see module docstring's TTL note).
    ASSEMBLYAI_AGENT_ID in the environment is honored as a manual
    override for testing against one specific agent, unless force_new."""
    if not force_new:
        existing = os.environ.get("ASSEMBLYAI_AGENT_ID")
        if existing:
            return existing

    req = urllib.request.Request(
        AGENTS_URL,
        data=json.dumps(agent_definition(api_key)).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print("agent creation failed:", e.code, json.dumps(_redact(json.loads(e.read())), indent=2))
        raise

    agent_id = data["id"]
    print(f"created stored agent {agent_id!r}")
    return agent_id


async def _run_session(ws, handlers: ToolHandlers, first_event: dict):
    """The steady-state event loop, entered once we know the connection
    didn't immediately fail (i.e. `first_event` is session.updated or
    session.ready, not an error) — opens mic/speaker only at this point."""
    ready = asyncio.Event()
    loop = asyncio.get_running_loop()
    mic_q: asyncio.Queue = asyncio.Queue()
    # ponytail: one flat pending-results list, not per-turn tracking —
    # fine for our scenarios (one tool call in flight at a time); revisit
    # if a turn ever fires two overlapping tool calls before reply.done.
    pending_results = []

    def on_mic(indata, *_frames_time_status):
        if ready.is_set():
            loop.call_soon_threadsafe(mic_q.put_nowait, bytes(indata))

    async def pump_mic():
        while True:
            chunk = await mic_q.get()
            await ws.send(json.dumps({
                "type": "input.audio",
                "audio": base64.b64encode(chunk).decode(),
            }))

    if first_event.get("type") == "session.ready":
        ready.set()
        print("session ready — talk into the mic")

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                         callback=on_mic), \
         sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16") as speaker:
        mic_task = asyncio.create_task(pump_mic())
        try:
            async for raw in ws:
                ev = json.loads(raw)
                etype = ev.get("type")

                if etype == "session.updated":
                    continue  # fires once before session.ready — not the connect signal

                elif etype == "session.ready":
                    ready.set()
                    print("session ready — talk into the mic")

                elif etype in ("error", "session.error"):
                    print("session error:", ev)

                elif etype == "reply.audio":
                    speaker.write(np.frombuffer(base64.b64decode(ev["data"]), dtype="int16"))

                elif etype == "tool.call":
                    result = handlers.dispatch(ev["name"], ev["arguments"])
                    pending_results.append((ev["call_id"], result))

                elif etype == "reply.done":
                    if ev.get("status") == "interrupted":
                        speaker.abort()
                        speaker.start()
                        pending_results.clear()  # discard stale results, per docs
                    else:
                        for call_id, result in pending_results:
                            await ws.send(json.dumps({
                                "type": "tool.result",
                                "call_id": call_id,
                                "result": json.dumps(result),  # result is a JSON-encoded
                                                                # STRING, not a raw object —
                                                                # verified live 2026-09-07
                            }))
                        pending_results.clear()

                elif etype == "transcript.user":
                    print(f"guest: {ev.get('text', '')}")

                elif etype == "transcript.agent":
                    print(f"agent: {ev.get('text', '')}")
        finally:
            mic_task.cancel()
            await ws.send(json.dumps({"type": "Terminate"}))


async def run_agent(handlers: ToolHandlers, api_key: str):
    """Connects, self-healing once if the stored agent has vanished (see
    ensure_agent's docstring / module docstring's TTL note)."""
    headers = {"Authorization": f"Bearer {api_key}"}
    agent_id = ensure_agent(api_key)

    for attempt in (1, 2):
        async with websockets.connect(WS_URL, additional_headers=headers) as ws:
            await ws.send(json.dumps({"type": "session.update", "session": {"agent_id": agent_id}}))
            first = json.loads(await ws.recv())

            if first.get("type") in ("error", "session.error"):
                if first.get("code") == "agent_not_found" and attempt == 1:
                    print("stored agent vanished before connect — creating a fresh one and retrying once")
                    agent_id = ensure_agent(api_key, force_new=True)
                    continue
                raise RuntimeError(f"session error: {first}")

            await _run_session(ws, handlers, first)
            return


def main():
    api_key = os.environ["ASSEMBLYAI_API_KEY"]

    cmd_queue: mp.Queue = mp.Queue()
    manager = mp.Manager()
    state = manager.dict()

    engine_proc = mp.Process(target=run_task_engine, args=(cmd_queue, state), daemon=True)
    engine_proc.start()

    handlers = ToolHandlers(cmd_queue, state)
    try:
        asyncio.run(run_agent(handlers, api_key))
    except KeyboardInterrupt:
        pass
    finally:
        engine_proc.terminate()


if __name__ == "__main__":
    main()
