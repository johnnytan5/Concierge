# Project: Voice-Dispatched Hotel Service Robot

AssemblyAI Voice Agent Hackathon (lablab.ai) submission. Full narrative plan
in `PLAN.md`, technical detail in `ARCHITECTURE.md`. Read both once at the
start of a session if context is missing; treat this file as the constraints
that override convenience every time.

## Hard constraints — do not violate these for convenience

1. **Three separate processes. Always.** WebSocket/orchestrator, task
   engine/navigator, MuJoCo physics. Never call `mj_step`, `sim.pull_status`,
   or anything MuJoCo-related from inside the asyncio event loop that holds
   the AssemblyAI WebSocket. If you catch yourself doing this to "simplify
   for now," stop — this is the one thing that will kill the demo.

2. **Every tool handler returns in under ~100ms. No exceptions.** A
   delivery takes up to 90 seconds. `dispatch_delivery`, `amend_delivery`,
   `recall_robot` etc. must mutate a task queue and return immediately —
   never block waiting for the robot to finish moving. Arrival/completion
   surfaces later as a separate agent turn or outbound event, never as the
   return value of the dispatching call.

3. **Robot platform: Hello Robot Stretch 3 via `stretch_mujoco`.** Not
   Booster T1, not a humanoid. If `stretch_mujoco` install/behaviour is
   broken and can't be fixed within half a day, fall back to the custom
   cabinet-bot MJCF (see PLAN.md Option C) — do not silently switch to a
   humanoid or spend more than half a day fighting the install.

4. **Manipulation is a stretch goal behind a Day-7 gate, never the
   critical path.** Default interaction is bin-loading (human loads a
   lidded compartment; robot doesn't grasp anything). Only attempt
   arm/gripper manipulation if the vertical slice (voice → dispatch →
   robot moves) is already working. If asked to build pick-and-place
   before that gate is cleared, push back and point at this file.

5. **Client-side function tools, not HTTP tools.** The sim is in-process
   state (task queue, robot pose), so tools are declared inline in
   `session.tools`, handled via `tool.call`/`tool.result` in the
   orchestrator process. Do not build an HTTP server just to satisfy the
   HTTP-tools pattern — it's the wrong tool for this shape of state.

6. **LLM via AssemblyAI's gateway (`byo-llm` pointing at their Claude
   gateway), not a separately hosted endpoint**, unless a specific reason
   to switch comes up. Less plumbing, same model control.

## Tool schema (contract — keep orchestrator and task engine in sync)

| Tool | Args | Returns | Blocking? |
|---|---|---|---|
| `dispatch_delivery` | `room, items[], priority` | `task_id, eta_seconds` | No |
| `check_delivery_status` | `task_id \| room` | `phase, position, eta` | No |
| `amend_delivery` | `task_id, add[], remove[], new_room` | updated task | No |
| `recall_robot` | `task_id, reason` | `ack` | No |
| `get_robot_state` | — | `pose, payload, battery, current_task` | No |
| `announce_arrival` | `room` | `ack` | No |

## Current phase

Check `PLAN.md` Section 7 (Schedule) for where we are and what the gate
condition for the next milestone is. Don't jump ahead to Days 8–14 work
(hotel scene, full task queue) before the Days 1–3 gate (both halves alive
independently, RQ1 audio test run) is actually cleared.

## Style

Keep it simple before it's clever. This is a hackathon on a deadline, not
a production system — prefer the boring, debuggable path (waypoint graph +
pure pursuit, not SLAM/Nav2; hand-built corridor MJCF, not full RoboCasa)
unless PLAN.md specifically calls for the fancier option.
