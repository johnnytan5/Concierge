"""
concierge_sim: control wrapper for delivery_bot_v2.xml.

Built on MuJoCo's own model/car/car.xml skeleton (two zaxis-aligned side
wheels + one frictionless rear support point, driven through a coupled
forward/turn tendon) — verified stable under straight driving, turning,
combined arcs, and door operation mid-drive. See ARCHITECTURE.md for the
full verification history.

Door mechanism: two independent slide-jointed panels (top slides up,
bottom slides down) meeting at a flush seam when closed. This replaced an
earlier hinged-door design that swung out into the corridor — the sliding
version stays within the robot's footprint, matching how real hotel
delivery robots (Pudu/Keenon-style) work.

Usage:
    from concierge_sim import DeliveryBotSimulator

    sim = DeliveryBotSimulator("delivery_bot_v2.xml")
    sim.start(headless=False)

    sim.drive(v=0.3, omega=0.0)   # m/s forward, rad/s turn
    sim.open_door()
    sim.close_door()
    sim.stop()

    status = sim.pull_status()
    print(status.base.xy, status.door.fraction_open)

Every method returns immediately — none block waiting for the robot to
arrive anywhere or the door to finish moving. That matches CLAUDE.md
constraint 2: the task engine (Process 2), which owns this simulator,
must never let the orchestrator's tool handlers (Process 1) block on
physical motion.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional

import mujoco
import mujoco.viewer as mj_viewer


# Door travel range, in meters, from the MJCF joint ranges. The two
# panels are NOT symmetric: the top panel retracts up into open space
# above the compartment (0.16m clear), but the bottom panel retracting
# down runs into the drive wheel's housing, so its usable travel is much
# smaller (0.04m) before it would collide. Both were tuned by checking
# actual contact state in MuJoCo, not assumed — see delivery_bot_v2.xml
# comments and ARCHITECTURE.md for the verification history.
#
# Measured 2026-09-07: lid_bottom_slide closes against gravity and was
# settling ~0.0123m short of qpos=0 (a position actuator's steady-state
# offset under a constant force is F/kp; 2.45N weight / kp=200 = 0.0123m,
# matched the observed residual exactly) — 31% "still open" on this small
# a range. Fixed in the MJCF (kp 200->3000, kv 20->80, same damping ratio).
# lid_top_slide closes with gravity assisting and had no such offset.
DOOR_TOP_RANGE_M = 0.16
DOOR_BOTTOM_RANGE_M = 0.04

# The base/turn actuators are `motor` (force-controlled) driving the
# forward/turn tendons — inherited from car.xml on purpose, see the MJCF's
# header comment, and deliberately not touched here. That means `ctrl` is
# a force, not a velocity: measured by holding ctrl steady and reading the
# settled linear_vel/angular_vel (both converge within ~1-2s and then hold
# flat — this is a viscous-damping-dominated system, not free
# acceleration, so "terminal velocity" is reached fast and stays put).
#   forward: ctrl=0.3 -> 0.0060 m/s, ctrl=8.0 -> 0.1597 m/s -> ratio ~50,
#            tight fit at both ends (50.0 / 50.1)
#   turn:    ctrl=2.0 -> 0.155 rad/s, ctrl=8.0 -> ~0.70-0.71 rad/s (still
#            drifting slightly at 3.5s) -> ratio ~11-13, noisier; 12.0 used
# drive() below converts real m/s / rad/s into ctrl using these, and clamps
# to the actuator's physical ceiling (MAX_LINEAR_MPS/MAX_ANGULAR_RADPS —
# this is the model's real top speed, not an arbitrary wrapper limit).
# ponytail: the turn ratio is an approximate fit (~±15%), not a lab
# calibration — good enough because nav.py's pure-pursuit loop re-issues
# drive() every tick off measured heading error (closed-loop), which
# absorbs open-loop scale error rather than needing it exact.
CTRL_PER_MPS = 50.0
CTRL_PER_RADPS = 12.0
MAX_LINEAR_MPS = 8.0 / CTRL_PER_MPS       # ~0.16 m/s, ctrlrange ceiling
MAX_ANGULAR_RADPS = 8.0 / CTRL_PER_RADPS  # ~0.67 rad/s, ctrlrange ceiling


@dataclass
class BaseStatus:
    xy: tuple[float, float]
    yaw_deg: float
    linear_vel: float
    angular_vel: float


@dataclass
class DoorStatus:
    top_position_m: float
    bottom_position_m: float
    fraction_open: float  # 0.0 closed, 1.0 fully open (both panels at max travel)


@dataclass
class BotStatus:
    time: float
    base: BaseStatus
    door: DoorStatus


class DeliveryBotSimulator:
    """Controls one instance of delivery_bot_v2.xml.

    Threading model: mj_step runs in a background thread at a fixed rate
    once start() is called. Public methods write into d.ctrl (returns
    instantly) or read out of d.qpos/d.qvel — never block on motion
    completing. The task engine's navigator (pure-pursuit loop) is
    expected to call drive() repeatedly as it re-aims at each waypoint.
    """

    def __init__(self, model_path: str):
        self.model = mujoco.MjModel.from_xml_path(model_path)
        self.data = mujoco.MjData(self.model)
        mujoco.mj_resetDataKeyframe(self.model, self.data, 0)

        self._fwd = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, "forward")
        self._turn = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, "turn")
        self._door_top_act = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, "lid_top_pos")
        self._door_bot_act = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, "lid_bottom_pos")

        self._door_top_joint = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "lid_top_slide")
        self._door_bot_joint = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "lid_bottom_slide")
        self._door_top_qadr = self.model.jnt_qposadr[self._door_top_joint]
        self._door_bot_qadr = self.model.jnt_qposadr[self._door_bot_joint]

        self._viewer = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, headless: bool = True, realtime: bool = True):
        """Begin stepping the simulation in a background thread.

        headless=False opens the interactive MuJoCo viewer (for demos/dev).
        headless=True steps without any window (unattended / CI).
        realtime=True paces stepping to wall-clock time.
        """
        if self._running:
            return
        self._running = True

        if not headless:
            self._viewer = mj_viewer.launch_passive(self.model, self.data)

        def _loop():
            dt = self.model.opt.timestep
            while self._running:
                t0 = time.perf_counter()
                with self._lock:
                    mujoco.mj_step(self.model, self.data)
                if self._viewer is not None:
                    self._viewer.sync()
                if realtime:
                    elapsed = time.perf_counter() - t0
                    if elapsed < dt:
                        time.sleep(dt - elapsed)

        self._thread = threading.Thread(target=_loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the simulation loop. Call before process exit."""
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if self._viewer is not None:
            self._viewer.close()
            self._viewer = None

    # ------------------------------------------------------------------
    # Base motion
    # ------------------------------------------------------------------

    def drive(self, v: float, omega: float):
        """Set base velocity: v in m/s (forward+), omega in rad/s (CCW+).

        Converted to the model's native force-tendon ctrl via
        CTRL_PER_MPS/CTRL_PER_RADPS (see module-level comment) and clamped
        to MAX_LINEAR_MPS/MAX_ANGULAR_RADPS — the model's actual physical
        top speed at full ctrlrange, not a wrapper-imposed limit. Sets a
        target and returns immediately; the motors keep driving at this
        rate until drive() is called again.
        """
        v = max(-MAX_LINEAR_MPS, min(MAX_LINEAR_MPS, v))
        omega = max(-MAX_ANGULAR_RADPS, min(MAX_ANGULAR_RADPS, omega))
        with self._lock:
            self.data.ctrl[self._fwd] = v * CTRL_PER_MPS
            self.data.ctrl[self._turn] = omega * CTRL_PER_RADPS

    def stop_base(self):
        """Zero the base velocity. Does not affect the door."""
        self.drive(0.0, 0.0)

    # ------------------------------------------------------------------
    # Door — two-panel vertical slide
    # ------------------------------------------------------------------

    def open_door(self):
        """Command both panels to their fully-retracted position. The
        panels have different travel budgets (see DOOR_TOP_RANGE_M /
        DOOR_BOTTOM_RANGE_M) — this opens each as far as it can safely go,
        not to a shared distance."""
        with self._lock:
            self.data.ctrl[self._door_top_act] = DOOR_TOP_RANGE_M
            self.data.ctrl[self._door_bot_act] = DOOR_BOTTOM_RANGE_M

    def close_door(self):
        """Command both panels back to the flush-closed seam position."""
        with self._lock:
            self.data.ctrl[self._door_top_act] = 0.0
            self.data.ctrl[self._door_bot_act] = 0.0

    def set_door_fraction(self, fraction: float):
        """Direct partial control: 0.0 closed, 1.0 fully open. Clamped.
        Each panel is scaled by its own travel budget so both reach their
        respective limits together at fraction=1.0."""
        clamped = max(0.0, min(1.0, fraction))
        with self._lock:
            self.data.ctrl[self._door_top_act] = clamped * DOOR_TOP_RANGE_M
            self.data.ctrl[self._door_bot_act] = clamped * DOOR_BOTTOM_RANGE_M

    # ------------------------------------------------------------------
    # State readout
    # ------------------------------------------------------------------

    def pull_status(self) -> BotStatus:
        """Snapshot for check_delivery_status / get_robot_state tool
        calls. Read-only, safe to call at any rate.
        """
        with self._lock:
            x, y = self.data.qpos[0], self.data.qpos[1]
            quat = self.data.qpos[3:7].copy()
            lin_vel = self.data.qvel[0:2].copy()
            ang_vel = float(self.data.qvel[5])
            top_pos = float(self.data.qpos[self._door_top_qadr])
            bot_pos = float(self.data.qpos[self._door_bot_qadr])
            t = self.data.time

        yaw_deg = _yaw_deg_from_quat(quat)
        top_frac = max(0.0, min(1.0, top_pos / DOOR_TOP_RANGE_M))
        bot_frac = max(0.0, min(1.0, bot_pos / DOOR_BOTTOM_RANGE_M))
        fraction_open = (top_frac + bot_frac) / 2.0

        return BotStatus(
            time=t,
            base=BaseStatus(
                xy=(float(x), float(y)),
                yaw_deg=yaw_deg,
                linear_vel=float((lin_vel[0] ** 2 + lin_vel[1] ** 2) ** 0.5),
                angular_vel=ang_vel,
            ),
            door=DoorStatus(
                top_position_m=top_pos,
                bottom_position_m=bot_pos,
                fraction_open=fraction_open,
            ),
        )


def _yaw_deg_from_quat(quat_wxyz) -> float:
    """Extract yaw (rotation about world z) from a MuJoCo wxyz quaternion,
    in degrees."""
    import math

    w, x, y, z = quat_wxyz
    siny_cosp = 2 * (w * z + x * y)
    cosy_cosp = 1 - 2 * (y * y + z * z)
    return math.degrees(math.atan2(siny_cosp, cosy_cosp))


def demo(sim: DeliveryBotSimulator):
    """Shared smoke sequence: drive a short path, turn, open the door,
    close it. Used by this file's own __main__ and by sim/run_headless.py
    / sim/run_viewer.py — one sequence, three entry points that only
    differ in headless=True/False.
    """
    sim.drive(v=0.12, omega=0.0)  # within MAX_LINEAR_MPS (~0.16 m/s)
    time.sleep(3.0)
    sim.drive(v=0.0, omega=0.4)   # within MAX_ANGULAR_RADPS (~0.67 rad/s)
    time.sleep(2.0)
    sim.stop_base()

    sim.open_door()
    time.sleep(2.0)
    print("Status with door open:", sim.pull_status())

    sim.close_door()
    time.sleep(3.0)  # bottom panel needs ~3s to settle against gravity, see kp/kv note above
    print("Status with door closed:", sim.pull_status())


if __name__ == "__main__":
    sim = DeliveryBotSimulator("delivery_bot_v2.xml")
    sim.start(headless=False)
    try:
        demo(sim)
    finally:
        sim.stop()
