"""Dev entry point: run concierge_sim's demo sequence headless (no
window) — drive, turn, open/close the door, print status before/after.

Run from anywhere: `python sim/run_headless.py`, or `cd sim && python
run_headless.py`. Model path is resolved relative to this file, not the
current working directory, so both work.
"""
import os

from concierge_sim import DeliveryBotSimulator, demo

MODEL = os.path.join(os.path.dirname(__file__), "delivery_bot_v2.xml")

if __name__ == "__main__":
    sim = DeliveryBotSimulator(MODEL)
    sim.start(headless=True)
    try:
        demo(sim)
    finally:
        sim.stop()
