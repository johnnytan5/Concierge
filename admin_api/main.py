"""admin_api — FastAPI backend for Sub-project B. The only process on
this side that holds the Supabase service-role key (orchestrator and
task_engine hold their own copies for their own writes, per Sub-project
A). Every admin CRUD write and every robot-screen button press goes
through here, since Sub-project A's RLS locks anon/authenticated out of
writes entirely. Reads (dashboard, admin item list, robot screen status)
go directly from the browser to Supabase via Realtime + the anon key —
this app has no read/GET endpoints at all.
"""
import os
import secrets
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

load_dotenv()

ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
ROBOT_IDS = ["robot_1", "robot_2"]

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
