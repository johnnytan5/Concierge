# Voice-Dispatched Hotel Service Robot — Research & Build Plan

**Event:** AssemblyAI Voice Agent Hackathon (lablab.ai), Sep 1–30 2026. 5 winners, $10k pool.
**Time remaining at time of writing:** 27 days, part-time alongside internship and FYP.
**Path:** Voice Agent API (not the raw Realtime STT path).

---

## 1. The one-sentence pitch

A hotel front desk you can phone. It takes the request in whatever mix of English, Malay and Mandarin the guest speaks, and dispatches a physically simulated service robot that actually executes the delivery — with live state you can interrupt, amend, and query mid-task.

The differentiator is not the robot. It is that the tool calls have a real backend with state, latency, and failure modes, while every competing submission's tools return canned JSON.

---

## 2. Reality check before you build

The robots you saw in Chinese hotels — Keenon T-series, Pudu BellaBot / HolaBot, YunJi Run — do **not** pick things up. The interaction is:

1. Staff opens a lidded compartment and places the item inside.
2. Staff enters the room number on the robot's touchscreen.
3. Robot navigates, calls the elevator over a building API, then phones the room or plays a chime.
4. Guest opens the lid, takes the item, taps "done."

No manipulation anywhere in that loop. Manipulation is the single largest time sink in robot simulation and it is the part this hackathon does not score.

**Recommendation:** design the demo around bin-loading, which is both realistic and cheap. Keep manipulation as an optional stretch goal you attempt only if the vertical slice is working by Day 7. If you do attempt it, "receptionist places tray, robot closes lid" is achievable; "robot grasps a bowl of noodles from a human hand" is not, in 27 days, part-time.

---

## 3. Robot model selection

### Option A — Hello Robot Stretch 3 (recommended)

In MuJoCo Menagerie as `hello_robot_stretch`, and more importantly there is a first-party wrapper, `hello-robot/stretch_mujoco`, that hands you the whole control layer.

Why it wins for this project:

- Mobile manipulator: differential-drive base **plus** a prismatic lift, a 4-segment telescoping arm, wrist DoFs and a gripper. It degrades gracefully — you can ignore the arm entirely and still have a delivery robot, or use it if time allows.
- The Python API maps almost one-to-one onto voice agent tool calls:

```python
from stretch_mujoco import StretchMujocoSimulator
sim = StretchMujocoSimulator()
sim.start(headless=False)
sim.set_base_velocity(0.3, -0.1)     # v_linear, v_angular
sim.move_to('lift', 1.0)
sim.move_by('base_translate', 0.1)
sim.wait_until_at_setpoint('lift')
sim.pull_status()                     # all joint pos/vel
sim.pull_sensor_data()                # gyro, accel, 2D lidar rangefinder
sim.pull_camera_data()                # calibrated RGB + depth
```

- Ships with RGB-D cameras, a 2D spinning lidar, headless mode for speed, and a viewer for the demo video.
- Spawns into RoboCasa environments — hundreds of pre-built interior scenes with real furniture assets. Far better looking than anything you will build from primitives in a week.
- Models live in `stretch_mujoco/models/`: `stretch.xml` (robot), `scene.xml` (robot + dock + table + objects + floor), `docking_station.xml`, plus `assets/` with meshes and textures.

### Option B — Booster T1 (do not use for this hackathon)

`booster_t1` is in Menagerie: 23 DoF, Apache-2.0, derived from the public `t1_serial.urdf`, with a freejoint on the trunk, IMU site and sensors, position actuators with kp/kv semantics, and frictionloss/armature added for stability.

The story value is obvious given your RCAP work and the lab's six T2s. But a 23-DoF humanoid needs a walking policy before it can deliver anything, and that is a month of work on its own. Attempting it here will sink both this and your Macau preparation.

Correct move: ship Stretch for the hackathon, and keep "retarget the delivery behaviour onto T1/T2" as the follow-on that feeds Macau and a possible paper. They share a MuJoCo backbone, so the task layer transfers.

### Option C — custom cabinet bot (fallback)

If Stretch's install or physics gives you trouble, an authentic Keenon-style robot is roughly 80 lines of MJCF: a box body with a `freejoint`, two hinge-driven wheels with velocity actuators, two spherical casters, a hinged lid, and a `site` for the payload bin. No meshes needed. This is the lowest-risk path and it looks *more* like the real thing, not less.

### Extracting joint parameters

Do not copy numbers from documentation. Dump them from the compiled model — this is also the table you will want in your writeup:

```python
import mujoco, pandas as pd
m = mujoco.MjModel.from_xml_path("stretch_mujoco/models/scene.xml")

rows = []
for i in range(m.njnt):
    name = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_JOINT, i)
    rows.append({
        "joint": name,
        "type": ["free", "ball", "slide", "hinge"][m.jnt_type[i]],
        "limited": bool(m.jnt_limited[i]),
        "range_lo": m.jnt_range[i][0],
        "range_hi": m.jnt_range[i][1],
        "axis": m.jnt_axis[i].tolist(),
        "damping": m.dof_damping[m.jnt_dofadr[i]],
        "armature": m.dof_armature[m.jnt_dofadr[i]],
        "frictionloss": m.dof_frictionloss[m.jnt_dofadr[i]],
    })
print(pd.DataFrame(rows).to_markdown(index=False))
```

Add a second pass over `m.nu` actuators for `actuator_ctrlrange`, `actuator_gainprm` (kp) and `actuator_biasprm` (kv) — those are what you actually tune when motion looks wrong.

---

## 4. Scenarios

Five, in build order. Scenarios 1, 2 and 4 are the demo; 3 and 5 are the depth that separates you from the field.

### S1 — Inbound phone request (the hook)
Guest in 1204 dials the hotel number, which is a Twilio SIP trunk bound to your agent. "Hi, can I get two extra towels sent up?" Agent confirms the room from the caller record, calls `dispatch_delivery`, states an ETA, and ends the call. The robot starts moving in the viewer before the call has ended.

*Why it matters:* judges can literally call your number. Almost nobody else will make theirs callable.

### S2 — Front-desk multi-order handoff
A human receptionist speaks to the robot at the desk: "Okay, this one goes to twelve-oh-four, and the noodles are for oh-eight-oh-three." Two items, two destinations, spoken in one breath, with room numbers as digits. Exercises `keyterms` biasing hard, and produces a queue rather than a single task.

### S3 — Code-switched request under noise
"Boss, can you hantar satu towel to my room ah, then also I want the *char kuey teow*, room one two zero four." Manglish with mid-utterance switches into Malay and Hokkien, over lobby background noise.

*This is your moat.* Nobody in the field has convenient access to this audio. Record it yourself and with friends.

### S4 — Mid-flight amendment (the money shot)
Robot is halfway down the corridor. Guest calls back: "Actually make it two towels, and can you add a toothbrush?" Agent calls `amend_delivery` on the live task. The robot in the viewer reverses, returns to the desk, and re-departs.

*Why it matters:* this is impossible to fake with stub tools. It proves there is real state behind the voice.

### S5 — Arrival, barge-in, and failure
Robot reaches the door and triggers an outbound announcement: "Your delivery is outside room 1204." Guest interrupts mid-sentence to ask something else — the Voice Agent API emits `reply.done` with status `interrupted`, and you handle it. Nobody answers the second time: after a timeout the robot returns to the desk, and the next time staff asks, the agent reports the failed delivery from real task history.

---

## 5. Architecture

Three processes. The separation is not optional — a blocking `mj_step` inside your WebSocket event loop will destroy voice latency, which is the one thing you cannot afford to break.

```
  Guest phone ──SIP──> Twilio trunk
                          │
                          ▼
              AssemblyAI Voice Agent API
              (Universal-3 Pro STT, turn detection,
               VAD, LLM routing, native PCM16 audio out)
                          │
              tool.call ↕ tool.result   (wss://agents.assemblyai.com/v1/ws)
                          │
   ┌──────────────────────▼──────────────────────┐
   │  PROCESS 1 — Orchestrator (asyncio)         │
   │  · holds the WebSocket                      │
   │  · client-side function tool handlers       │
   │  · returns in <100ms, always                │
   └──────────────────────┬──────────────────────┘
                          │  multiprocessing.Queue (commands)
                          │  shared dict / Queue (state)
   ┌──────────────────────▼──────────────────────┐
   │  PROCESS 2 — Task engine + navigator        │
   │  · task queue, FSM per task                 │
   │  · waypoint graph over the floor plan       │
   │  · pure-pursuit → set_base_velocity()       │
   └──────────────────────┬──────────────────────┘
                          │
   ┌──────────────────────▼──────────────────────┐
   │  PROCESS 3 — MuJoCo (stretch_mujoco)        │
   │  · viewer for demo, headless for dev        │
   └─────────────────────────────────────────────┘
```

### Stack

| Layer | Choice | Note |
|---|---|---|
| Voice | AssemblyAI Voice Agent API | Stored agent via `POST /v1/agents`, bind by `agent_id` |
| LLM | Claude via the AssemblyAI gateway (`byo-llm`) | Path 1 does *not* cost you LLM control |
| Telephony | Twilio SIP trunk | No media server, no webhook; env vars only |
| Physics | MuJoCo 3.x + `stretch_mujoco` | Python 3.10 |
| Scenes | RoboCasa assets, or hand-built MJCF corridor | Corridor + 3 doors is enough |
| Nav | Waypoint graph + pure pursuit | **Not** Nav2, **not** SLAM |
| Recording | Session artifacts API + MuJoCo offscreen render | Free demo material |

### Tool schema

Six client-side function tools, declared inline in `session.tools`. Client-side rather than HTTP tools because the sim is in-process state, which is exactly the case the docs say client-side tools are for.

| Tool | Returns | Blocking? |
|---|---|---|
| `dispatch_delivery(room, items[], priority)` | `task_id`, `eta_seconds` | No — returns instantly |
| `check_delivery_status(task_id \| room)` | phase, position, eta | No |
| `amend_delivery(task_id, add[], remove[], new_room)` | updated task | No |
| `recall_robot(task_id, reason)` | ack | No |
| `get_robot_state()` | pose, payload, battery, current task | No |
| `announce_arrival(room)` | ack | No |

**The non-blocking rule is the single most important engineering constraint in this project.** A delivery takes 90 seconds. If you hold the tool call open for 90 seconds, the conversation dies. Every handler mutates the task queue and returns within milliseconds; arrival surfaces later as a separate turn or an outbound call.

Return `tool.result` when `reply.done` is the latest event you have received, per the client-side tools docs.

---

## 6. Research questions

You asked for a research plan, so treat these as small experiments with recorded results. They double as writeup content and as groundwork for the master's-level work you are considering.

**RQ1 — Does Universal-3 Pro handle intra-utterance code-switching?**
Build a 30-utterance test set: 10 clean English, 10 Manglish with Malay/Mandarin switches, 10 with lobby noise. Transcribe, hand-label ground truth, compute WER per bucket. Answer this in the first three days — if it fails badly, you need to know while you can still change direction.

**RQ2 — How much does `keyterms` biasing recover?**
Rerun RQ1's test set with room numbers, guest names, and local dish names supplied as keyterms. Report WER delta per bucket. A before/after bar chart is the most credible thing you can put in a hackathon submission, and it is on-message for the sponsor.

**RQ3 — What is the perceived-latency ceiling for tool round trips?**
Instrument the time from end-of-speech to first agent audio, with and without a tool call in the path. Find where it starts feeling broken. This directly justifies the non-blocking design.

**RQ4 — Do turn-taking thresholds need retuning for accented speech?**
The `turn-taking` sample agent exposes silence thresholds and interruption sensitivity. Speakers who pause mid-sentence while code-switching may get cut off at default settings. Measure false-endpoint rate at two or three threshold values.

---

## 7. Schedule

| Days | Milestone | Hard gate |
|---|---|---|
| 1–3 | Both halves alive *independently*: starter agent talking in browser; Stretch driving in the viewer. Run RQ1. | If code-switching WER is unusable, pivot the language angle now |
| 4–7 | **Vertical slice**: one spoken sentence → `dispatch_delivery` → robot visibly moves | **If this is not working on Day 7, cut manipulation permanently** |
| 8–14 | Hotel scene, waypoint nav, task queue, all six tools, S1 + S2 end to end | |
| 15–20 | Twilio number live. `keyterms` + turn-taking tuning. RQ2, RQ3, RQ4. S3 recorded. | |
| 21–25 | S4 and S5. Failure handling. Rehearse the full run three times. | |
| 26–28 | Demo video, writeup with the WER charts, submission | Submit by Day 28, not Day 30 |

Days 29–30 are buffer. Something will break.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Sim blocks the voice loop | Separate processes from day one, not as a later refactor |
| `stretch_mujoco` install friction | Timebox to half a day, then fall back to Option C cabinet bot |
| Manipulation eats the month | Day 7 gate. Bin-loading is the default, not the fallback |
| Code-switching underperforms | RQ1 on day 1–3; if weak, pivot the story to noise robustness and keyterms |
| Macau RCAP prep + FYP collision | Hard-cap this at evenings and weekends. Do not touch T1 locomotion |
| Field is large and the starter is four commands | Your margin is entirely keyterms tuning, turn-taking config, and tools with real consequences |

---

## 9. What to cut first, in order

1. Manipulation (arm/gripper). Bin-loading instead.
2. RoboCasa scenes. Hand-built corridor from primitives.
3. RGB-D perception. The robot knows the floor plan; it does not need to see it.
4. Elevator / multi-floor. Single corridor.
5. S5 failure handling.

Do not cut, under any circumstances: the phone number, the code-switched scenario, or the mid-flight amendment. Those three are the entire submission.
