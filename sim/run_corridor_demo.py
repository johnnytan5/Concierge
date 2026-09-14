"""Live, watchable end-to-end demo: one robot, the real corridor scene,
driven entirely by task_engine.engine's actual FSM (_handle/_advance) --
not a separate scripted path, the exact same functions engine.py's own
run() uses in production. Sequence: dispatch -> COLLECTING (door opens,
guest loads bin) -> confirmed -> EN_ROUTE (drives through the real corner
to room 1204) -> ARRIVED (door opens again) -> confirmed -> RETURNING
(drives home) -> PARKING (settles to a canonical heading) -> DONE (stops).

Same macOS/mjpython requirement as sim/run_viewer.py: launch_passive
needs the main thread. Run with `.venv/bin/mjpython sim/run_corridor_demo.py`
(macOS) or `python sim/run_corridor_demo.py` (Linux/Windows). Model/imports
resolve relative to this file, so either invocation location works.
"""
import os
import sys
import time

import mujoco

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "task_engine"))
from concierge_sim import DeliveryBotSimulator  # noqa: E402
import engine  # noqa: E402


def _set_camera(sim, name):
    """Lock the interactive passive viewer onto one of the scene's named
    fixed cameras (top/chase/lid, see scene_corridor.xml/delivery_bot_v2.xml)
    instead of leaving it on the viewer's own default free-look camera --
    launch_passive() doesn't pick one of these automatically."""
    sim._viewer.cam.type = mujoco.mjtCamera.mjCAMERA_FIXED
    sim._viewer.cam.fixedcamid = sim.model.camera(name).id


def demo():
    sim = DeliveryBotSimulator(engine.MODEL_PATH)
    sim.start(headless=False)
    try:
        _set_camera(sim, "top")  # bird's-eye default while driving
        tasks = {}
        speed, tol_m = 0.3, 0.05

        print("[demo] dispatching to room 1204 (far-arm, through the real corner)")
        engine._handle({"cmd": "dispatch", "task_id": "demo", "room": "1204",
                         "items": ["towel", "toothbrush"]}, tasks)
        tasks["demo"]["phase"] = "COLLECTING"
        print(f"[demo] phase=COLLECTING -- door opening, ETA {tasks['demo']['eta_seconds']:.1f}s")

        # "worker loading the bin" -- two-shot sequence. First, an
        # establishing side-on view of the lobby (lobby_side_view) as the
        # robot begins turning toward the desk -- reads as "here's the
        # scene" before the close-up. Then cut to guest_view, the closer
        # head-on shot: the robot turns to face the desk during COLLECTING
        # (engine.py's _rotate_toward/DESK_FACE_YAW_RAD), which puts its
        # door facing this camera -- that's the actual "watch it open"
        # shot. Both are world-fixed (unlike lid/chase) and use
        # mode="targetbodycom" so they always frame the robot regardless of
        # its exact pose. Real settle time measured at ~124 ticks
        # (traced tick-by-tick); 60 (side) + 120 (guest) = 180 has margin.
        _set_camera(sim, "lobby_side_view")
        for _ in range(60):
            tasks["demo"], _ = engine._advance(sim, tasks["demo"], time.time(),
                                                drive_speed=speed, arrival_tolerance_m=tol_m)
            time.sleep(0.05)

        _set_camera(sim, "guest_view")
        for _ in range(120):
            tasks["demo"], _ = engine._advance(sim, tasks["demo"], time.time(),
                                                drive_speed=speed, arrival_tolerance_m=tol_m)
            time.sleep(0.05)

        print("[demo] loading confirmed -> EN_ROUTE")
        _set_camera(sim, "top")
        tasks["demo"], _ = engine._advance(sim, tasks["demo"], time.time(), confirmed=True,
                                            drive_speed=speed, arrival_tolerance_m=tol_m)

        last_phase = tasks["demo"]["phase"]
        for i in range(6000):
            tasks["demo"], frac = engine._advance(sim, tasks["demo"], time.time(),
                                                   drive_speed=speed, arrival_tolerance_m=tol_m)
            if tasks["demo"]["phase"] != last_phase:
                print(f"[demo] tick {i}: phase {last_phase} -> {tasks['demo']['phase']}")
                last_phase = tasks["demo"]["phase"]
                if tasks["demo"]["phase"] == "ARRIVED":
                    # guest_view is fixed near the front desk, useless out
                    # here at the room door -- no per-room fixed camera
                    # exists yet, so this uses "chase" (robot-mounted,
                    # trailing view) rather than "lid" (also robot-mounted,
                    # but at a low, wide-angle pose that reads as pointing
                    # at the sky/ceiling from most headings, confirmed by
                    # rendering it -- not a natural "watch it open" shot).
                    print("[demo] arrived at 1204 -- door open, holding before guest confirms collection")
                    _set_camera(sim, "chase")
                    for _ in range(40):
                        tasks["demo"], _ = engine._advance(sim, tasks["demo"], time.time(),
                                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                        time.sleep(0.05)
                    print("[demo] collection confirmed -> RETURNING")
                    _set_camera(sim, "top")
                    tasks["demo"], _ = engine._advance(sim, tasks["demo"], time.time(), confirmed=True,
                                                        drive_speed=speed, arrival_tolerance_m=tol_m)
                    last_phase = tasks["demo"]["phase"]
            if tasks["demo"]["phase"] == "DONE":
                print(f"[demo] tick {i}: DONE -- robot parked, canonical heading, stopped")
                break
            time.sleep(0.05)

        print("[demo] holding viewer open for 5s so there's something to look at")
        time.sleep(5.0)
    finally:
        sim.stop()


if __name__ == "__main__":
    demo()
