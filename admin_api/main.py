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


def require_admin_password(x_admin_password: str = Header(...)):
    if x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="wrong password")


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
