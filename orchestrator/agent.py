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
import argparse
import asyncio
import base64
import json
import multiprocessing as mp
import os
import urllib.error
import urllib.request
import sys
import threading
import time
import uuid

import numpy as np
import sounddevice as sd
import websockets
from dotenv import load_dotenv

from orchestrator import inventory
from orchestrator.tools import SESSION_TOOLS, ToolHandlers, needs_nudge, nudge_instruction
from task_engine.engine import run as run_task_engine

load_dotenv()

WS_URL = "wss://agents.assemblyai.com/v1/ws"
AGENTS_URL = "https://agents.assemblyai.com/v1/agents"
SAMPLE_RATE = 24_000
# BYO-LLM via OpenRouter — a genuinely OpenAI-Chat-Completions-shaped
# endpoint (unlike Anthropic's own API), so it's a drop-in fit for
# `llm.base_url`. AssemblyAI's own gateway has zero model access on this
# account (see agent_definition()'s docstring) — OpenRouter does,
# confirmed live 2026-09-11: both a plain completion and OpenAI-style
# tool-calling tested directly against it, standalone, before wiring in.
LLM_BASE_URL = "https://openrouter.ai/api/v1"
# "@preset/concierge" is an OpenRouter preset (openrouter.ai/settings/presets)
# that sets reasoning.enabled=false. AssemblyAI's llm block only passes
# base_url/model/api_key, so the model string is the one place that switch
# can ride along. Without it qwen3.8 thinks silently for 3-8s before every
# tool call (100-275 hidden tokens) and the guest hears dead air; with it,
# first token ~1s and it says "let me check" on its own. Measured
# 2026-09-23. /no_think and chat_template_kwargs do NOT work via OpenRouter.
# GPT-6 Luna, pinned, with the preset supplying its settings (reasoning off).
# Measured 2026-09-24 on the turn that kept failing live (a Chinese Uber Eats
# request mid-call): Luna called deliver_parcel 8/8 first time and 6/6 after
# a nudge; qwen3.8-flash was 6-7/8 and, nudged, claimed "booked" without the
# tool 5/6. Qwen's only host (Alibaba) was also returning 429 from a shared
# upstream pool. Pinned rather than the bare "@preset/concierge" because the
# preset's own model order did not take effect when reordered.
LLM_MODEL = "openai/gpt-6-luna@preset/concierge"  # cheap (~$0.5/M completion tokens vs. Claude's), verified
                                    # live 2026-09-11: correct tool-calling on a multi-item
                                    # dispatch_delivery request, standalone against OpenRouter
USE_BYO_LLM = True  # via OpenRouter (OPENROUTER_API_KEY in .env), not AssemblyAI's own
                     # gateway — that one has zero model access on this account

_BASE_PROMPT = (
    "You are the front-desk voice assistant for a hotel, speaking on the "
    "phone. Guests and staff ask you to send items to rooms, check on "
    "deliveries already under way, change or cancel one mid-flight, or ask "
    "general questions about the hotel.\n\n"
    "LANGUAGE: guests may speak Chinese, Malay or mixed languages. Always "
    "reply in English — the voice can only speak English — but show you "
    "understood by naming what they asked for. In every tool call, use the "
    "exact English item names from the MENU (e.g. 毛巾 -> towel).\n\n"
    "HOW TO SPEAK: keep every reply to one or two short sentences. Never "
    "read out the menu or a list longer than two items. Only talk about "
    "items the guest actually asked for. Before calling any tool, say one "
    "brief phrase first, such as 'One moment, let me check that.' That "
    "phrase and the tool call MUST be in the same reply: never announce an "
    "action ('let me pass that on', 'let me check') and end your turn "
    "without actually calling the tool — the guest would wait in silence "
    "until they speak again.\n\n"
    "ITEM REQUESTS: the MENU below is what the delivery robot can bring "
    "right now. Before you agree to send anything, check every requested "
    "item against it. Never say you will send an item that is not on it, "
    "and never confirm an order before you know each item is available. "
    "If an item is not on the MENU, say plainly that the hotel does not "
    "have it and offer at most two close alternatives from the MENU. Do "
    "NOT escalate an unavailable item to the front desk — there is nothing "
    "for them to do. Call check_menu only if the guest asks about an item "
    "you cannot find below or wants to double-check stock.\n\n"
    "ONE TOOL PER REPLY: never call more than one tool in the same reply. "
    "One tool per reply does NOT mean one item per call: put every item for "
    "a room in a single dispatch_delivery. "
    "If the guest asks for two things, handle one, then the other in your "
    "very next reply -- never drop the second one. (Two results at once make "
    "you answer twice, and the second answer talks over the guest's next "
    "question.) Example: towel plus an Uber Eats order in one breath = "
    "dispatch_delivery first, then deliver_parcel.\n\n"
    "DISPATCHING: once the guest confirms, call dispatch_delivery with only "
    "the available items. Then tell the guest exactly what the result says "
    "was sent, and anything listed as unavailable — never claim more was "
    "sent than dispatched_items. A new order first waits at the front desk "
    "to be loaded, so never say it is on the way before it has left -- say "
    "staff are loading it and it will be up shortly. If a tool result has "
    "tell_guest, follow it. Never claim a delivery is done, in "
    "progress, or arrived unless a tool told you so. Use check_delivery_status, "
    "amend_delivery, recall_robot, get_fleet_state and announce_arrival for "
    "deliveries already under way. For 'where is my order?' / 'what's the "
    "status?', call check_delivery_status with the guest's room -- you "
    "always know it; never ask for or talk about an order or task id. "
    "Dietary tags are for answering the "
    "guest's own dietary questions — bring them up only if the guest "
    "mentions a dietary need, and never state an ingredient the MENU does "
    "not list. When the guest says yes or 'send it', dispatch right away "
    "without further questions.\n\n"
    "FOOD DELIVERY APPS: if the guest has ordered from an outside app "
    "(Uber Eats, Grab, Meituan, Foodpanda...) and wants it brought up, call "
    "deliver_parcel with the room and the app. Riders can't go upstairs, so "
    "the order is left at the front desk and the robot carries it up once "
    "staff load it -- tell the guest that, briefly. You cannot place or "
    "change orders on those apps; never offer to.\n\n"
    "GENERAL QUESTIONS: check-in/out times, late checkout policy, which "
    "floor a facility is on and its hours, wifi, breakfast, parking, "
    "laundry — call hotel_info and answer only from what it returns; never "
    "guess a time, price or floor. For any late check-out question, give "
    "the guest the policy and its cost first, then offer to request it.\n\n"
    "ESCALATION: call escalate_to_frontdesk only when a person has to act: "
    "actually granting a late checkout, a lost key card, billing, something "
    "broken in the room, a complaint, or a question hotel_info has no "
    "answer for. Pass the guest's room number as `room` whenever you know "
    "it.\n\n"
    "Anything you escalate is a REQUEST, not a result: say the front desk "
    "will confirm it — never say it is confirmed, approved or arranged. "
    "Only escalate after the guest has said yes, and escalate each request "
    "once.\n\n"
    "Quote prices, times and limits exactly as hotel_info states them; do "
    "not paraphrase them into something vaguer. Never repeat information "
    "you have already told the guest in this call.\n\n"
    "After finishing a request, ask briefly if there is anything else. "
    "When the guest says goodbye, that's all, or asks to end the call, "
    "call end_call."
)


def menu_for_prompt(items: list[dict]) -> str:
    """The live menu as compact prompt lines, snapshotted at call start.

    Putting it here means an ordinary order needs no check_menu round trip
    before the assistant can answer — each tool round trip is a full extra
    LLM turn of silence for the guest. Stock can still move mid-call;
    dispatch_delivery re-checks it live and reports what it couldn't send.
    Only sellable items are listed, so the model has nothing unavailable
    to promise."""
    lines = []
    for it in sorted(items, key=lambda i: (i.get("category") or "", i["name"])):
        if not (it.get("available") and it.get("in_stock")):
            continue
        price = f" ${float(it['price']):.2f}" if it.get("price") else " (complimentary)"
        tags = f" [{', '.join(it['dietary_tags'])}]" if it.get("dietary_tags") else ""
        lines.append(f"- {it['name']} ({it.get('category')}){price}{tags}")
    return "MENU (available now):\n" + ("\n".join(lines) or "- nothing available")


def system_prompt_for(room: str | None) -> str:
    """The prompt, with the caller's room baked in when we know it.

    A hotel PBX tells reception which room is ringing before anyone speaks,
    so the assistant should already know it — asking "what room are you in?"
    when the switchboard just told you is exactly the tell that gives away a
    scripted demo. When no room is supplied (the bare `python -m
    orchestrator.agent` path) it falls back to asking, which is correct for
    a call with no caller ID.
    """
    base = _BASE_PROMPT + "\n\n" + menu_for_prompt(inventory.all_items()) + "\n\n"
    if not room:
        return base + (
            "You do not know which room this call came from, so ask for it "
            "before dispatching anything."
        )
    return base + (
        f"This call is coming from room {room} — the switchboard already "
        f"identified it, so do NOT ask the guest which room they are in. Use "
        f"{room} as the room for dispatch_delivery, check_delivery_status and "
        f"escalate_to_frontdesk unless the guest explicitly asks for something "
        f"to go to a different room."
    )

# Room numbers / dish names pulled straight from PLAN.md's scenarios (S1-S3) —
# RQ2 is literally about how much this list helps WER on code-switched audio.
KEYTERMS = ["1204", "0803", "towel", "conditioner", "toothbrush", "char kuey teow",
            # delivery apps a US guest will name (deliver_parcel); two words
            # each and easy to mishear, so bias for them
            "Uber Eats", "DoorDash"]


def _redact(obj):
    """Strip api_key values before logging/printing a request or error
    body. See the module docstring's incident note — do not remove this."""
    if isinstance(obj, dict):
        return {k: ("***REDACTED***" if k == "api_key" else _redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


def agent_definition(api_key: str, room: str | None = None) -> dict:
    """Body for POST /v1/agents (stored agent). Required top-level fields
    per the live API: name, system_prompt, voice ({"voice_id": ...}) —
    NOT the same shape as session.update's inline config (there's no
    top-level "voice" there, and `llm` is rejected there entirely).

    `api_key` here is the AssemblyAI key (for the stored-agent request's
    own auth) — NOT what goes in the `llm` block below, which needs
    OPENROUTER_API_KEY instead. Two different keys, two different
    purposes; don't conflate them.

    BYO-LLM history, so the next person doesn't have to rediscover this:
    AssemblyAI's own gateway (`https://llm-gateway.assemblyai.com/v1`)
    has zero model access on this account — confirmed live 2026-09-11 by
    testing every Claude/Gemini model string directly against it, every
    one came back `"Your account does not have access to this LLM
    Gateway model"`. The Voice Agent API didn't surface that as a
    session.error — it silently returned an empty "completed" reply (no
    text, near-silent audio, no tool.call) for every single turn, which
    is exactly what a live session looked like before this was
    diagnosed. Switched to OpenRouter (`https://openrouter.ai/api/v1`)
    instead: a genuinely OpenAI-Chat-Completions-shaped endpoint (unlike
    Anthropic's own API), verified standalone before wiring in — both a
    plain completion and OpenAI-style tool-calling worked correctly
    against `anthropic/claude-fable-5.1` there. What's still unverified
    at the time of writing: whether the Voice Agent API itself correctly
    bridges tool-calling through to a BYO-LLM backend end-to-end (vs.
    just to its own managed model, which was proven to work). If a live
    session ever shows replies with real text but tool.call never fires,
    that's the thing to suspect first — test the LLM endpoint directly
    and in isolation (like this incident did) before assuming it's a bug
    in this codebase.
    """
    definition = {
        "name": "concierge-front-desk",
        "system_prompt": system_prompt_for(room),
        "voice": {"voice_id": "anna"},
        # Reception answers a room extension already knowing who is calling.
        "greeting": (f"Front desk, room {room} — how can I help?" if room
                     else "Front desk, how can I help?"),
        "input": {
            "format": {"encoding": "audio/pcm"},
            # The caller's own room, biased for: they will say it back
            # ("towels to twelve oh four"), and it is the single term most
            # worth getting right on this call.
            "keyterms": (KEYTERMS + [room]) if room and room not in KEYTERMS else KEYTERMS,
            # How long a pause counts as "the guest has finished". Left null
            # (adaptive defaults), a dry run cut "Oh yeah, I also wanted to ask
            # about late check-in" at "Oh yeah," -- the model answered the
            # fragment ("Anything else?") and the real question was lost.
            # Longer silence costs ~0.5s per turn; being cut off costs the call.
            "turn_detection": {
                # 0.6, not 0.5: family voices and chatter in the room kept
                # registering as the guest.
                "vad_threshold": 0.6,
                "min_silence": 900,     # ms of silence when confident the turn ended
                "max_silence": 2400,    # ms: end the turn regardless after this
                "interrupt_response": True,
                # ms of guest speech before the assistant stops talking. At
                # 100 a cough, an "mm-hm" or someone else in the room cut a
                # long reply off mid-sentence (dry run, 13:26:44). 500 still
                # lets a real "wait, actually..." interrupt.
                "interruption_delay": 500,
            },
        },
        "tools": SESSION_TOOLS,
    }
    if USE_BYO_LLM:
        definition["llm"] = [{
            "base_url": LLM_BASE_URL,
            "model": LLM_MODEL,
            "api_key": os.environ["OPENROUTER_API_KEY"],
        }]
    return definition


def ensure_agent(api_key: str, force_new: bool = False, room: str | None = None) -> str:
    """Create a stored agent. Creates fresh by default — do not assume a
    previously created id still works (see module docstring's TTL note).

    ASSEMBLYAI_AGENT_ID is honored as a manual override for testing against
    one specific agent — but NOT when a room is supplied, since the room is
    baked into the stored agent's prompt, greeting and keyterms, and reusing
    an agent built for a different room would answer with the wrong one."""
    if not force_new and not room:
        existing = os.environ.get("ASSEMBLYAI_AGENT_ID")
        if existing:
            return existing

    req = urllib.request.Request(
        AGENTS_URL,
        data=json.dumps(agent_definition(api_key, room)).encode(),
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


async def _run_session(ws, handlers: ToolHandlers, first_event: dict, session_id: str):
    """The steady-state event loop, entered once we know the connection
    didn't immediately fail (i.e. `first_event` is session.updated or
    session.ready, not an error) — opens mic/speaker only at this point.

    `session_id` stamps the transcript turns written below. They used to be
    print()-only, which meant the guest's actual words existed nowhere after
    the process exited — the admin dashboard's Call log replays a call from
    these rows plus the tool_call_events carrying the same id."""
    ready = asyncio.Event()
    loop = asyncio.get_running_loop()
    mic_q: asyncio.Queue = asyncio.Queue()

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

    # Which mic, in the call log: macOS silently makes AirPods the default
    # input when they connect, and a mic sitting in its case looks exactly
    # like "the agent isn't transcribing me".
    print(f"mic: {sd.query_devices(kind='input')['name']} | "
          f"speaker: {sd.query_devices(kind='output')['name']}")
    # Playback is callback-driven off a byte buffer. It used to be a blocking
    # speaker.write() inside this loop, which froze the loop for the length
    # of every reply: the mic pump starved (guest speech reached AssemblyAI
    # seconds late), events queued up, and one long reply outlasted the WS
    # keepalive and killed the call. Barge-in is now just clearing the buffer.
    play_buf = bytearray()
    play_lock = threading.Lock()

    def on_speaker(outdata, frames, _time, _status):
        n = len(outdata)
        with play_lock:
            chunk = bytes(play_buf[:n])
            del play_buf[:n]
        outdata[:len(chunk)] = chunk
        outdata[len(chunk):] = b"\x00" * (n - len(chunk))

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                         callback=on_mic), \
         sd.RawOutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                            callback=on_speaker,
                            # "low" (the default) means a few-ms buffer; on
                            # Bluetooth, any moment the GIL is busy decoding
                            # an event starves it and the voice stutters.
                            latency="high"):
        mic_task = asyncio.create_task(pump_mic())
        audio_chunk_count = 0  # debug: reply.audio was completely invisible before
        audio_byte_total = 0
        audio_peak_max = 0
        # Per-reply bookkeeping for the announced-but-never-called nudge,
        # keyed by reply_id. The final transcript.agent for a reply can land
        # AFTER that reply's reply.done, so attributing text by arrival order
        # glued one reply's "let me check" onto the next reply; the deltas
        # carry reply_id and always precede their reply.done.
        current_reply: str | None = None
        reply_texts: dict[str, list[str]] = {}
        replies_with_tool: set[str] = set()
        guest_speaking = False
        nudges_this_turn = 0     # capped at MAX_NUDGES per guest turn
        last_guest_text = ""
        parcel_booked = False    # deliver_parcel already called this call
        ending = False           # end_call was called; close after the goodbye
        force_close = None
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
                    raw_bytes = base64.b64decode(ev["data"])
                    audio_chunk_count += 1  # debug: was completely invisible before
                    audio_byte_total += len(raw_bytes)
                    samples = np.frombuffer(raw_bytes, dtype="int16")
                    peak = int(np.abs(samples).max()) if len(samples) else 0
                    audio_peak_max = max(audio_peak_max, peak)  # debug: distinguishes real
                                                                  # speech from near-silent padding
                    with play_lock:
                        play_buf.extend(raw_bytes)

                elif etype == "reply.started":
                    current_reply = ev.get("reply_id")

                elif etype == "transcript.agent.delta":
                    reply_texts.setdefault(ev.get("reply_id") or current_reply, []).append(ev.get("delta", ""))

                elif etype == "input.speech.started":
                    guest_speaking = True

                elif etype == "input.speech.stopped":
                    guest_speaking = False

                elif etype == "tool.call":
                    replies_with_tool.add(ev.get("reply_id") or current_reply)
                    if ev.get("name") == "deliver_parcel":
                        parcel_booked = True
                    print(f"tool.call: {ev.get('name')}({ev.get('arguments')})")  # debug
                    try:
                        result = handlers.dispatch(ev["name"], ev["arguments"])
                    except Exception as e:  # don't let a handler bug silently kill the loop
                        print(f"tool handler raised: {e!r}")
                        result = {"error": str(e)}
                    if ev["name"] == "end_call" and not ending:
                        ending = True
                        # Backstop: if no goodbye reply ever comes, still hang up.
                        force_close = asyncio.create_task(_close_after(ws, 12))
                    # Every tool is declared execution_mode "hold" (see
                    # tools.SESSION_TOOLS): the result goes back the moment
                    # the handler returns and auto-fires the spoken follow-up.
                    await ws.send(json.dumps({
                        "type": "tool.result",
                        "call_id": ev["call_id"],
                        "result": json.dumps(result),  # JSON-encoded STRING,
                                                        # verified live 2026-09-07
                    }))

                elif etype == "reply.done":
                    print(f"reply.done: status={ev.get('status')!r} audio_chunks={audio_chunk_count} "
                          f"audio_bytes={audio_byte_total} peak_amplitude={audio_peak_max}/32767")  # debug —
                          # peak_amplitude near 0 means the "audio" is silence/padding, not real speech
                    audio_chunk_count = 0
                    audio_byte_total = 0
                    audio_peak_max = 0
                    rid = ev.get("reply_id") or current_reply
                    said = "".join(reply_texts.pop(rid, []))
                    if ending and (rid not in replies_with_tool or said.strip()):
                        # The goodbye is done: either the reply that carried
                        # end_call already said it (close now -- otherwise the
                        # auto-fired follow-up says a SECOND goodbye), or this
                        # is that follow-up. Let it finish playing, then close.
                        for _ in range(150):
                            with play_lock:
                                if not play_buf:
                                    break
                            await asyncio.sleep(0.1)
                        print("CALL_ENDED by end_call")
                        break
                    if ev.get("status") == "interrupted":
                        with play_lock:
                            play_buf.clear()  # barge-in: stop talking now
                    elif (rid not in replies_with_tool and nudges_this_turn < MAX_NUDGES
                          and not guest_speaking and needs_nudge(said)):
                        # The model promised an action ("let me pass that on")
                        # and ended its turn without the tool call. Left alone
                        # the guest waits until they speak again. Capped per
                        # guest turn so a stubborn model can't loop; two, because
                        # live the first nudged reply was once just another
                        # promise ("I'll have that brought up for you now").
                        nudges_this_turn += 1
                        print(f"nudge {nudges_this_turn}: reply announced an action without a tool call")
                        await ws.send(json.dumps({
                            "type": "reply.create",
                            "instructions": nudge_instruction(last_guest_text, parcel_booked),
                        }))

                elif etype in ("transcript.user", "transcript.agent"):
                    role = "guest" if etype == "transcript.user" else "agent"
                    text = ev.get("text", "")
                    if role == "guest":
                        nudges_this_turn = 0
                        last_guest_text = text
                    print(f"{role}: {text}")
                    # Empty transcripts do arrive (partials, barge-in); a
                    # blank row would just be noise in the Call log, and the
                    # column is NOT NULL anyway.
                    if text:
                        inventory.insert_transcript_turn(session_id, role, text)

                else:
                    # debug: catch-all so nothing (reply.started, input.speech.*,
                    # anything not yet handled above) is silently dropped again
                    print(f"(unhandled) {etype}: {ev}")
        finally:
            mic_task.cancel()
            if force_close:
                force_close.cancel()
            try:
                await ws.send(json.dumps({"type": "session.end"}))
            except websockets.exceptions.ConnectionClosed:
                pass  # already closed (the end_call backstop, or the server)


async def _close_after(ws, seconds: float):
    await asyncio.sleep(seconds)
    print("CALL_ENDED by end_call (no goodbye reply arrived)")
    await ws.close()


# reply.create nudges allowed per guest turn (see _run_session).
MAX_NUDGES = 2

# Terminal task phases — a delivery in any other phase is still on the floor.
_DONE_PHASES = ("DONE", "AT_DESK")


def wait_for_robot(state, limit_s: int = 600):
    """After the guest hangs up, keep the task engine alive until the robot
    finishes. The engine (and the MuJoCo sims inside it) lives in this
    process, so exiting straight away froze the robot mid-corridor the
    moment the guest said goodbye. Capped: a bin nobody ever loads would
    otherwise hold the process forever."""
    announced = False
    for _ in range(limit_s):
        tasks = dict(state.get("tasks") or {})
        active = [t for t in tasks.values() if t.get("phase") not in _DONE_PHASES]
        if not active:
            # ponytail: fixed grace, not a handshake with the engine. It
            # mirrors to Supabase only every 5th tick (~1s) plus the write
            # itself, so exiting the instant the task hits DONE left the
            # dashboard showing "heading back" forever. 3s = two mirror
            # rounds of margin.
            time.sleep(3)
            print("robot idle — exiting")
            return
        if not announced:
            print(f"call over; robot finishing {len(active)} task(s)")
            announced = True
        time.sleep(1)
    print("gave up waiting for the robot after the time limit")


async def start_inventory():
    """Prime the inventory cache once, then keep it refreshing in the
    background. MUST run before the first turn can call a tool: the cache
    starts empty, so without this every item looks "not offered" and
    dispatch_delivery never enqueues anything — the headline feature,
    inert. (No task in the inventory/fleet plan owned this file, so nothing
    ever called inventory's own refresh entry points; only a throwaway test
    script did, by hand, which is why the live e2e check passed anyway.)

    The blocking refresh goes through run_in_executor, never straight onto
    the event loop (CLAUDE.md constraint 2). Returns the refresh task so
    the caller can cancel it — and so it isn't garbage-collected mid-run."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, inventory.refresh_cache_sync)
    print(f"inventory cache primed: {len(inventory.all_items())} items")
    return asyncio.create_task(inventory.start_refresh_loop())


async def run_agent(handlers: ToolHandlers, api_key: str, session_id: str,
                     room: str | None = None):
    """Connects, self-healing once if the stored agent has vanished (see
    ensure_agent's docstring / module docstring's TTL note).

    `room` is the extension this call came in on, if the switchboard knew it."""
    headers = {"Authorization": f"Bearer {api_key}"}
    loop = asyncio.get_running_loop()
    # The session row is inserted in parallel with the WS connect rather than
    # after it (serial startup cost ~8s before the greeting). It must exist
    # before the first transcript write, so it is awaited before _run_session.
    # The prompt embeds the live menu, so the inventory must be primed
    # before the agent is created; the session row still overlaps the connect.
    refresh_task = await start_inventory()
    agent_id = await loop.run_in_executor(None, lambda: ensure_agent(api_key, room=room))
    reg_task = loop.run_in_executor(None, inventory.insert_voice_session,
                                    session_id, agent_id, room)
    registered = False

    try:
        for attempt in (1, 2):
            async with websockets.connect(WS_URL, additional_headers=headers) as ws:
                await ws.send(json.dumps({"type": "session.update", "session": {"agent_id": agent_id}}))
                first = json.loads(await ws.recv())

                if first.get("type") in ("error", "session.error"):
                    if first.get("code") == "agent_not_found" and attempt == 1:
                        print("stored agent vanished before connect — creating a fresh one and retrying once")
                        agent_id = ensure_agent(api_key, force_new=True, room=room)
                        continue
                    raise RuntimeError(f"session error: {first}")

                # The row was inserted in parallel with the connect (FKs from
                # tool_call_events / transcript_turns need it first). If the
                # stored agent had to be recreated, its agent_id column holds
                # the first id tried — cosmetic, and that path is rare.
                await reg_task
                registered = True
                print(f"voice session {session_id} registered "
                      f"(agent {agent_id}, room {room or 'unknown'})")

                await _run_session(ws, handlers, first, session_id)
                return
    finally:
        refresh_task.cancel()
        # The row is inserted before the connect is known to work, so close
        # it whenever the insert landed — not only when the session ran.
        if registered or (reg_task.done() and not reg_task.exception()):
            await loop.run_in_executor(None, inventory.end_voice_session, session_id)


def main(room: str | None = None, viewer: bool = False):
    api_key = os.environ["ASSEMBLYAI_API_KEY"]
    # One id per run = one "call" in the admin dashboard's Call log. Same
    # short-hex shape as task_id, for consistency in the UI.
    session_id = "sess_" + uuid.uuid4().hex[:12]

    cmd_queue: mp.Queue = mp.Queue()
    manager = mp.Manager()
    state = manager.dict()

    viewer_robot = None
    if viewer:
        # MuJoCo's viewer needs the Cocoa main thread on macOS, which only
        # mjpython provides. The engine's main thread is its own, so spawning
        # just that process under mjpython is enough; this one (the asyncio
        # WS loop) stays plain python and never touches MuJoCo (constraint 1).
        mjpython = os.path.join(os.path.dirname(sys.executable), "mjpython")
        if sys.platform == "darwin" and os.path.exists(mjpython):
            mp.set_executable(mjpython)
        viewer_robot = "robot_1"  # ROBOT_IDS[0]: gets the first dispatch
    engine_proc = mp.Process(target=run_task_engine, args=(cmd_queue, state, viewer_robot),
                             daemon=True)
    engine_proc.start()
    if viewer:
        mp.set_executable(sys.executable)

    handlers = ToolHandlers(cmd_queue, state, session_id=session_id)
    try:
        asyncio.run(run_agent(handlers, api_key, session_id, room))
        if handlers.end_requested:
            wait_for_robot(state)
    except KeyboardInterrupt:
        pass
    finally:
        engine_proc.terminate()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Front-desk voice agent. Talk into the mic; Ctrl-C to hang up.")
    ap.add_argument(
        "--room",
        help="Extension the call came in on. A hotel PBX knows this before "
             "the guest speaks, so the assistant is told it up front and will "
             "not ask. Omit for a call with no caller ID.")
    ap.add_argument(
        "--viewer", action="store_true",
        help="Open the MuJoCo viewer on robot_1's live sim (the one this call "
             "drives), for a split-screen demo next to the dashboard.")
    args = ap.parse_args()
    main(args.room, viewer=args.viewer)
