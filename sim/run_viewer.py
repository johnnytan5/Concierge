"""Demo entry point: run concierge_sim's demo sequence with the
interactive MuJoCo viewer open — for recording/demoing, not CI.

On macOS, `mujoco.viewer.launch_passive` requires the GUI to run on the
main thread, which means this MUST be run with `mjpython`, not plain
`python` (plain `python` raises `RuntimeError: launch_passive requires
that the Python script be run under mjpython on macOS`). `mjpython` ships
inside the `mujoco` pip package, at `<venv>/bin/mjpython`.

Run from anywhere: `.venv/bin/mjpython sim/run_viewer.py` (macOS) or
`python sim/run_viewer.py` (Linux/Windows). Model path is resolved
relative to this file, not the current working directory, so either
invocation style (repo root or `cd sim &&`) works.
"""
import os
import time

from concierge_sim import DeliveryBotSimulator, demo

MODEL = os.path.join(os.path.dirname(__file__), "delivery_bot_v2.xml")

if __name__ == "__main__":
    sim = DeliveryBotSimulator(MODEL)
    sim.start(headless=False)
    try:
        demo(sim)
        time.sleep(3.0)  # hold the viewer open a moment so there's something to look at
    finally:
        sim.stop()
