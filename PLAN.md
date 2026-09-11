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

## 3. Robot model — decision record

**Decision: custom cabinet-bot MJCF** (`sim/delivery_bot_v2.xml` +
`sim/concierge_sim.py`), not Hello Robot Stretch 3.

Stretch 3 via `stretch_mujoco` was the original plan (full A/B/C
comparison is in this file's git history if it's ever needed again), and
its install/behaviour checked out clean — `pip install
git+https://github.com/hello-robot/stretch_mujoco.git` worked first try,
and `sim.start(headless=True)` drove the base correctly at ~0.93x
realtime. This was **not** a broken-install fallback. It was a scope call
made once the real question got asked: a differential-drive delivery
cart doesn't need Stretch's arm, lift, head, or RGB-D cameras, and the
custom model is simpler to reason about end-to-end for a bin-loading-only
interaction.

**What's built:**
- Skeleton: two zaxis-aligned side wheels + one frictionless rear support
  point, driven through a coupled forward/turn tendon — lifted verbatim
  from MuJoCo's own `model/car/car.xml` (the wheel-rolling trick that
  "just worked" with zero tuning). The visible shell rebuilt around it as
  a tall Pudu/Keenon-style cabinet.
- Bin-loading interaction: a two-panel vertical-slide door
  (`open_door()` / `close_door()` / `set_door_fraction()`), not a
  swinging lid — both panels stay within the robot's footprint, so a
  guest standing at the door is never in its path.
- Control: `drive(v, omega)` takes real m/s / rad/s. The underlying
  actuators are force-controlled (`motor`, not `velocity`), so this
  required an empirical ctrl→force calibration (`CTRL_PER_MPS=50.0`,
  `CTRL_PER_RADPS≈12.0` — fit by holding ctrl steady and reading settled
  `linear_vel`/`angular_vel`; see `concierge_sim.py`'s module comment).
  Physical top speed is ~0.16 m/s / ~0.67 rad/s at full `ctrlrange` — over
  the 90s delivery budget that's ~14m of travel, plenty for one corridor.
- Two real bugs found and fixed during verification, worth knowing about
  if the model is ever retuned: the bottom door panel closes against
  gravity and was settling ~31% short of shut (a position actuator's
  steady-state offset under a constant force is `weight/kp`; fixed by
  raising kp 200→3000, kv 20→80 — verified residual <0.001m after the
  fix); and `drive()`'s v/omega were originally raw `ctrl` values, not
  real units, silently ~50x slower than documented.

Booster T1 stays out of scope for the reason it always was — a 23-DoF
humanoid needs a walking policy before it can deliver anything, and
that's a month of work this project doesn't have. "Retarget onto T1/T2"
remains the follow-on for Macau/a paper, not this hackathon.

---

## 4. Scenarios

Five, in build order. Scenarios 1, 2 and 4 are the demo; 3 and 5 are the depth that separates you from the field.

### S1 — Inbound request (the hook)
Guest in 1204 speaks into the front-desk line — a local mic/speaker session against the Voice Agent API, framed narratively as a phone call for the demo; no Twilio/SIP, see Section 5. "Hi, can I get two extra towels sent up?" Agent confirms the room, calls `dispatch_delivery`, states an ETA, and ends the call. The robot starts moving in the viewer before the call has ended.

*Why it matters:* the submission is a demo video, not a live judge dial-in, so a literal phone number doesn't pay off the way it would in live judging — the real differentiator survives untouched: the tool call has genuine state, latency, and failure behind it, live, in the same run as the video. Nobody else's stub-JSON tools do that.

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
  Guest mic/speaker (local — simulated front-desk line, no Twilio/SIP)
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
| Voice | AssemblyAI Voice Agent API | Inline `session.update` config (not a stored agent) — see `orchestrator/agent.py` |
| LLM | BYO-LLM via OpenRouter (`qwen/qwen3.8-flash`) | AssemblyAI's own gateway has zero model access on this account, confirmed live; OpenRouter verified end-to-end incl. tool-calling, cheap model chosen deliberately. See CLAUDE.md constraint 6 |
| Call input | Local mic/speaker (simulated front-desk line) | No Twilio/SIP — raw API key + `Bearer` header, no browser/token needed |
| Physics | MuJoCo 3.x + custom cabinet-bot MJCF | `sim/delivery_bot_v2.xml` + `sim/concierge_sim.py`, Python 3.10 |
| Scenes | Hand-built MJCF corridor | Corridor + 3 doors is enough — pending, Day 8-14 |
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
| 1–3 | Both halves alive *independently*: orchestrator talking to the Voice Agent API (local mic/speaker); cabinet-bot driving in the viewer. Run RQ1. | If code-switching WER is unusable, pivot the language angle now |
| 4–7 | **Vertical slice**: one spoken sentence → `dispatch_delivery` → robot visibly moves | **If this is not working on Day 7, cut manipulation permanently** |
| 8–14 | Hotel scene, waypoint nav, task queue, all six tools, S1 + S2 end to end | |
| 15–20 | `keyterms` + turn-taking tuning against a live key. RQ2, RQ3, RQ4. S3 recorded. | |
| 21–25 | S4 and S5. Failure handling. Rehearse the full run three times. | |
| 26–28 | Demo video, writeup with the WER charts, submission | Submit by Day 28, not Day 30 |

Days 29–30 are buffer. Something will break.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Sim blocks the voice loop | Separate processes from day one, not as a later refactor |
| Custom MJCF actuator/tuning surprises | Verify empirically — measure settled velocity/position, don't assume documented units. Already caught two real bugs (door gravity droop, `drive()` units 50x off) before they hit `nav.py` |
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

Do not cut, under any circumstances: the code-switched scenario, or the mid-flight amendment. Those two are the entire submission. (The literal phone number *was* cut, deliberately — the submission is a demo video, not live judge dial-in, so callability doesn't pay off; the simulated mic session keeps the actual differentiator — real backend state — without the SIP risk. See Section 3/5.)
