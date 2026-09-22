"""admin_api — FastAPI backend for Sub-project B. The only process on
this side that holds the Supabase service-role key (orchestrator and
task_engine hold their own copies for their own writes, per Sub-project
A). Every admin CRUD write and every robot-screen button press goes
through here, since Sub-project A's RLS locks anon/authenticated out of
writes entirely. Reads (dashboard, admin item list, robot screen status)
go directly from the browser to Supabase via Realtime + the anon key.
The only GET here is /admin/call/status, which reports on a local child
process and therefore cannot come from the database.
"""
import os
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

load_dotenv()

ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
ROBOT_IDS = ["robot_1", "robot_2"]

# Repo root — admin_api/main.py lives one level down. The agent is launched
# from here so its own load_dotenv() finds the same .env this process read.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# A room number is interpolated into a launch argument, so it is validated
# rather than trusted. Never passed through a shell (Popen takes a list), but
# a strict allowlist costs nothing and removes the question entirely.
_ROOM_RE = re.compile(r"^[A-Za-z0-9-]{1,10}$")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # hackathon demo scope, see spec's Auth section
    allow_methods=["*"],
    allow_headers=["*"],
)

_client: Client | None = None


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        )
    return _client


def require_admin_password(x_admin_password: str | None = Header(default=None)):
    """Optional header, not a required one: `Header(...)` makes FastAPI reject
    a missing header as a 422 validation error before this function runs, so
    "no credentials" and "malformed request" became indistinguishable to the
    caller. The dashboard keys off 401 to re-prompt for the password, and a
    422 there surfaces as a raw validation message instead.

    compare_digest keeps the check constant-time. This is a shared password,
    not real auth (see the admin-dashboard design spec), but leaking its
    length or prefix through timing is free to avoid.
    """
    if x_admin_password is None or not secrets.compare_digest(x_admin_password, ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="wrong or missing admin password")


class ItemIn(BaseModel):
    name: str
    category: str
    price: float | None = None
    dietary_tags: list[str] = []
    available: bool = True
    stock_count: int | None = None


class ItemPatch(BaseModel):
    name: str | None = None
    category: str | None = None
    price: float | None = None
    dietary_tags: list[str] | None = None
    available: bool | None = None
    stock_count: int | None = None


@app.post("/admin/items", dependencies=[Depends(require_admin_password)])
def create_item(item: ItemIn):
    resp = _get_client().table("inventory_items").insert(item.model_dump()).execute()
    return resp.data[0]


@app.patch("/admin/items/{item_id}", dependencies=[Depends(require_admin_password)])
def update_item(item_id: str, patch: ItemPatch):
    fields = {k: v for k, v in patch.model_dump().items() if v is not None}
    resp = _get_client().table("inventory_items").update(fields).eq("id", item_id).execute()
    if not resp.data:
        raise HTTPException(status_code=404, detail="item not found")
    return resp.data[0]


@app.delete("/admin/items/{item_id}", dependencies=[Depends(require_admin_password)])
def delete_item(item_id: str):
    _get_client().table("inventory_items").delete().eq("id", item_id).execute()
    return {"ack": True}


@app.post("/robot/{robot_id}/complete_loading")
def complete_loading(robot_id: str):
    if robot_id not in ROBOT_IDS:
        raise HTTPException(status_code=404, detail="unknown robot_id")
    _get_client().table("robot_commands").insert(
        {"robot_id": robot_id, "cmd": "complete_loading"}
    ).execute()
    return {"ack": True}


@app.post("/robot/{robot_id}/complete_collection")
def complete_collection(robot_id: str):
    if robot_id not in ROBOT_IDS:
        raise HTTPException(status_code=404, detail="unknown robot_id")
    _get_client().table("robot_commands").insert(
        {"robot_id": robot_id, "cmd": "complete_collection"}
    ).execute()
    return {"ack": True}


class RecallIn(BaseModel):
    reason: str


@app.post("/admin/robots/{robot_id}/recall", dependencies=[Depends(require_admin_password)])
def recall_robot(robot_id: str, body: RecallIn):
    """Admin-initiated recall from the dashboard's Fleet tab.

    Password-gated, unlike the two /robot/* endpoints above — those are the
    robot's own kiosk screen confirming a human action at the machine, this
    is an operator reaching across the floor to pull a robot off its run.

    Returns immediately: the task engine picks the row up on its next
    Supabase poll (~1s) and resolves robot -> current task itself. A recall
    for an idle robot is accepted and lands as a no-op there rather than
    being rejected here, since the engine's view of who is carrying what is
    authoritative and this process's would be a stale guess.
    """
    if robot_id not in ROBOT_IDS:
        raise HTTPException(status_code=404, detail="unknown robot_id")
    _get_client().table("robot_commands").insert(
        {"robot_id": robot_id, "cmd": "recall", "reason": body.reason}
    ).execute()
    return {"ack": True}


@app.post("/admin/escalations/{escalation_id}/resolve",
          dependencies=[Depends(require_admin_password)])
def resolve_escalation(escalation_id: str):
    resp = (_get_client().table("frontdesk_escalations")
            .update({"status": "resolved",
                     "resolved_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", escalation_id)
            .execute())
    if not resp.data:
        raise HTTPException(status_code=404, detail="escalation not found")
    return resp.data[0]


@app.post("/admin/escalations/{escalation_id}/reopen",
          dependencies=[Depends(require_admin_password)])
def reopen_escalation(escalation_id: str):
    """Undo for the above. Resolving is one click on a live floor; without
    a way back, a misclick buries a guest problem permanently."""
    resp = (_get_client().table("frontdesk_escalations")
            .update({"status": "open", "resolved_at": None})
            .eq("id", escalation_id)
            .execute())
    if not resp.data:
        raise HTTPException(status_code=404, detail="escalation not found")
    return resp.data[0]


# ---------------------------------------------------------------------------
# The front-desk line
#
# Starting a call means launching orchestrator/agent.py, which opens the mic
# and holds the AssemblyAI WebSocket. That is a real child process, so this
# section owns its lifecycle: one at a time (there is one microphone), a
# graceful stop that lets the agent close its own session row, and a status
# endpoint so the dashboard can show the right button.
#
# The room is passed through because a hotel PBX already knows which
# extension is ringing — the assistant is told up front rather than asking.
# ---------------------------------------------------------------------------

_call_lock = threading.Lock()
_call: dict | None = None   # {proc, room, started_at, log_path}


def _call_is_running() -> bool:
    """True only if we have a child AND it has not exited on its own (the
    guest hanging up, or the agent erroring out)."""
    return _call is not None and _call["proc"].poll() is None


def _tail_log(path: str, lines: int = 12) -> list[str]:
    try:
        with open(path) as f:
            return [ln.rstrip() for ln in f.readlines()[-lines:]]
    except OSError:
        return []


def _call_status() -> dict:
    if _call is None:
        return {"running": False, "room": None}
    exited = _call["proc"].poll()
    return {
        "running": exited is None,
        "room": _call["room"],
        "pid": _call["proc"].pid,
        "started_at": _call["started_at"],
        "exit_code": exited,
        # The agent prints its session id, the connect handshake and any
        # session.error here. Without it, "the call didn't start" is a
        # dead end from the browser.
        "log": _tail_log(_call["log_path"]),
    }


class CallStartIn(BaseModel):
    room: str | None = None


@app.post("/admin/call/start", dependencies=[Depends(require_admin_password)])
def start_call(body: CallStartIn):
    global _call
    room = (body.room or "").strip() or None
    if room is not None and not _ROOM_RE.match(room):
        raise HTTPException(status_code=400, detail="room must be 1-10 letters/digits/hyphens")

    with _call_lock:
        if _call_is_running():
            raise HTTPException(status_code=409,
                                detail=f"a call is already on the line (room {_call['room']})")

        # -u: unbuffered. Python buffers stdout when it is a file rather than
        # a TTY, so without this the agent's connect confirmation and any
        # session.error sit in a buffer until the process dies -- which is
        # exactly when you no longer need them.
        cmd = [sys.executable, "-u", "-m", "orchestrator.agent"]
        if room:
            cmd += ["--room", room]

        log = tempfile.NamedTemporaryFile(
            prefix="concierge-call-", suffix=".log", delete=False, mode="w")
        try:
            proc = subprocess.Popen(
                cmd,                       # list, never a shell string
                cwd=_REPO_ROOT,
                stdout=log, stderr=subprocess.STDOUT,
                # Own process group, so stopping the call signals the agent
                # AND the task_engine child it spawned, not this server.
                start_new_session=True,
            )
        except OSError as e:
            log.close()
            raise HTTPException(status_code=500, detail=f"could not start the agent: {e}")

        _call = {"proc": proc, "room": room,
                 "started_at": datetime.now(timezone.utc).isoformat(),
                 "log_path": log.name}

    # Give it a moment to fail loudly (missing key, no mic, bad agent config)
    # rather than reporting success on a process that died immediately.
    time.sleep(1.5)
    status = _call_status()
    if not status["running"]:
        raise HTTPException(
            status_code=500,
            detail="the agent exited immediately: " + " / ".join(status["log"][-4:]))
    return status


@app.post("/admin/call/stop", dependencies=[Depends(require_admin_password)])
def stop_call():
    global _call
    with _call_lock:
        if not _call_is_running():
            return {"running": False, "room": None, "note": "no call was on the line"}

        proc = _call["proc"]
        # SIGINT first: agent.py catches KeyboardInterrupt, which terminates
        # the task engine and lets run_agent's finally close the voice_sessions
        # row. Killing outright would leave the session open forever and the
        # dashboard would keep calling it live.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGINT)
        except (ProcessLookupError, PermissionError):
            proc.send_signal(signal.SIGINT)

        killed = False
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
            proc.wait(timeout=5)
            killed = True

        # A SIGKILLed agent never ran its finally, so its voice_sessions row
        # is still open and the dashboard would keep presenting a dead call as
        # live. Close it here. Scoped to sessions that began at or after this
        # call started, so it cannot touch an unrelated (or seeded) open row --
        # and only one agent runs at a time, so that window holds exactly one.
        if killed:
            _close_sessions_since(_call["started_at"])

        return _call_status()


def _close_sessions_since(started_at: str) -> None:
    try:
        (_get_client().table("voice_sessions")
         .update({"ended_at": datetime.now(timezone.utc).isoformat()})
         .is_("ended_at", "null")
         .gte("started_at", started_at)
         .execute())
    except Exception as e:  # noqa: BLE001 - never fail a hang-up over bookkeeping
        print(f"[admin_api] could not close the session row after a forced stop: {e!r}")


@app.get("/admin/call/status", dependencies=[Depends(require_admin_password)])
def call_status():
    return _call_status()
