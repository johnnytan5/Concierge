# Demo runsheet

Target: ~90 seconds of demo, plus a short close. Everything below is verified
against the live system on 2026-09-23, not assumed.

The thesis to leave the judge with, in one line:

> **Every other submission's tool calls return canned JSON. Mine move a robot,
> decrement real stock, and can be changed after they've started.**

---

## 0. Pre-flight — do these in order

| ✅ | Step |
|---|---|
| | **Headphones on.** Non-negotiable — see "The echo problem" below. |
| | `.venv/bin/uvicorn admin_api.main:app --port 8000` |
| | `cd dashboard && npm run dev` → http://localhost:3000 |
| | Reset demo state (below) |
| | Fleet tab: both robots **IDLE**, no current task |
| | Screen recorder set to capture **system audio + mic** |

### The echo problem — read this before your first take

Your laptop mic hears your laptop speaker. The agent's own greeting gets
transcribed as the guest speaking, and the agent interrupts itself. Observed
live:

```
agent: Front desk, room 0803 — how can I
input.speech.started
reply.done: status='interrupted'
transcript.user.delta: 'Front desk, room 803 — how can'
```

**Headphones fix it.** Without them every take is corrupted. This is physics,
not a bug in the code — there is no echo cancellation in the path.

### Reset demo state

```bash
.venv/bin/python scripts/seed_demo_calls.py --remove   # clear seeded calls
```

Decide deliberately whether to keep seeded history:

- **Keep it** (just don't run `--remove`) → the Call log looks like a hotel
  mid-shift. Better for the "this is a real system" read.
- **Clear it** → everything on screen was created live during the take.
  Stronger if a judge suspects staging.

Recommendation: **keep it**, and say out loud that earlier calls are from the
seed script. Honest, and the dashboard doesn't look empty.

---

## 1. Facts the demo depends on

**Rooms the robot can reach** — only these four have waypoint paths:

| Room | Wing | ETA |
|---|---|---|
| `0803` | near | ~9s |
| `0804` | near | ~18s |
| `1204` | far, past the corner | ~36s |
| `1205` | far, past the corner | ~46s |

Any other room is rejected *before stock is touched*, with the reachable list
returned. That's the failure-handling beat.

**Items that work:** towel, char kuey teow, teh tarik, nasi lemak, roti canai,
mee goreng, club sandwich, extra blanket, extra pillow, still water, kopi o…
(26 in total)

**Items that deliberately fail** — pick one for the failure beat:

| Item | Fails because |
|---|---|
| `toothbrush` | hidden from the menu |
| `chicken satay` | on the menu, 0 in stock |

> ⚠️ **`toothbrush` is in `KEYTERMS` but is hidden from the menu.** Don't order
> it expecting success.

**The loading gate.** After dispatch the robot sits at the desk in
`COLLECTING` and will **not** move until someone confirms the bin is loaded.
That's the Fleet card's **"Bin loaded — send it"** button. It is a hard FSM
gate — if you forget it during a take, the robot just sits there.

Same at the other end: on `ARRIVED`, **"Guest collected it"** releases it home.

---

## 2. Window layout

One browser window, Live call tab, at a readable zoom. Put the MuJoCo viewer
beside it if you're showing the robot — otherwise the Fleet tab's phase strip
carries the motion story on its own.

Set `initialTab="live"` in `dashboard/app/page.tsx` so the first frame is the
call, not the fleet.

---

## 3. Shot list

### Shot 1 — Answer the call (0:00–0:10)

Live call tab. Type **`0803`** into the room field. Press **Answer call**.

> *"A guest is calling the front desk from room 0803. The switchboard already
> knows the room — same as a real hotel PBX — so the assistant isn't going to
> ask."*

Agent greets: **"Front desk, room 0803 — how can I help?"**

That greeting is the first advantage, and it's free: **the room came from the
call, not the conversation.**

### Shot 2 — The hard utterance (0:10–0:30)

Say, naturally — don't over-enunciate the switches:

> **"Boss, can you hantar satu towel to my room ah, then also I want the char
> kuey teow."**

Malay (*hantar* = send, *satu* = one), Manglish particle (*ah*), and a Hokkien
dish name — in one breath, with no language hint given to the API.

Watch the Live call panel fill: transcript lands, then `check_menu`, then
`dispatch_delivery` with both items and room `0803`.

> *"No language configuration. It code-switches natively — and more
> importantly, that sentence just became a real order."*

### Shot 3 — Load the bin, robot departs (0:30–0:45)

Fleet tab → **"Bin loaded — send it"**.

> *"This is the bin-loading model real hotel robots use — Pudu, Keenon. A
> human loads a lidded compartment; the robot never grasps anything. It
> physically can't leave until someone confirms."*

Robot drives. Phase strip advances, `pose_frac` climbs.

### Shot 4 — The money shot: change your mind mid-flight (0:45–1:10)

**Start this call to `1205` instead** (far wing) so there's travel time to work
with. Once the robot is past the corner, call back and say:

> **"Actually, send it to 0803 instead."**

The robot **turns around and re-routes from wherever it is**. Verified: at
x=1.35 committed to the far wing, amended to 0803, reversed and arrived.

> *"That's the part you cannot fake. Stub JSON can't reverse a robot that's
> already halfway down a corridor. There's real state here — a task queue, a
> physics sim, a robot with a position."*

Hold on this. It's the single strongest 10 seconds in the submission.

### Shot 5 — Failure handling (1:10–1:25)

Pick one:

**(a) Undeliverable room** — ask for something to room `9999`.
> *"It refuses before touching stock, and tells you which rooms it can reach.
> A misheard room number can't send a robot to the wrong floor or silently
> decrement inventory."*

**(b) Out of stock** — order `chicken satay`.
> *"On the menu, zero in stock. It says so instead of promising it."*

(a) is stronger — it's the transcription-robustness story, and it's *your*
backend doing it, not the STT.

### Shot 6 — The audit trail (1:25–1:40)

Call log tab → open the call you just made.

> *"Every call is reconstructable: what was said, what the assistant decided,
> what it dispatched, and how long each tool call took."*

Point at a **latency badge**. That's RQ3 — measured, not claimed.

Flip **Staff view → Dev view** to show the same screen in table names and
endpoints.

> *"Same screen, two audiences. Front-desk staff never see a session id."*

---

## 4. Advantages to name (pick 3, don't list all)

Ranked by how hard they are to fake:

1. **Amendable mid-flight** — real state, real physics. Unfakeable.
2. **Fails safe on bad input** — unknown room rejected before stock changes.
3. **Room from the call, not the conversation** — PBX-accurate.
4. **Full audit trail** — transcript + tool calls + consequences, per call.
5. **Native code-switching** — no language config.
6. **Measured latency** — RQ3 on screen.

Don't do an architecture walkthrough or a tool tour. Video time is the most
expensive real estate you have; the writeup is where the diagram goes.

---

## 5. If it goes wrong on camera

| Symptom | Cause | Do this |
|---|---|---|
| Agent interrupts itself | Echo — speaker into mic | Headphones. Restart the take |
| Robot doesn't move after dispatch | Loading gate not confirmed | Fleet → "Bin loaded — send it" |
| "No route to room…" | Room isn't 0803/0804/1204/1205 | Use a real one |
| Item "not offered" | toothbrush / phone charger are hidden | Use towel, char kuey teow, teh tarik |
| Call won't start | admin_api down, or a call already open | Check :8000; Hang up first |
| Live tab shows "Last call" | Session went stale (>90s idle) | Expected. Answer a new call |
| Writes rejected | admin_api down, or dashboard opened on a non-localhost origin (CORS) | Restart admin_api; open http://localhost:3000 |

**Do a full dry run before the real take.** Your own schedule budgets Days
21–25 for exactly this ("Rehearse the full run three times").

---

## 6. What is NOT in the demo, deliberately

- **RQ1/RQ2 WER study** — cut Day 22. See `PLAN.md` §6 for why: it measures
  the sponsor's STT, not this system, and the Day 1–3 gate rationale expired.
- **Manipulation** — bin-loading is the model, per `CLAUDE.md` constraint 4.
- **A phone number** — cut deliberately; `PLAN.md` §9. This is a mic session
  framed as the front-desk line, and the runsheet says so out loud rather than
  implying telephony that doesn't exist.
