'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Cmd, Engine } from '../lib/sim/engine';

/**
 * The MuJoCo scene drawn with three.js. Physics runs in lib/sim/sim.worker.ts;
 * this component only turns its geom poses into meshes. The model uses boxes,
 * cylinders, spheres and a plane (no mesh files), so each geom maps to one
 * three.js primitive.
 *
 * MuJoCo is Z-up. "follow" looks straight down with +x to the right, like
 * the desktop viewer; the engine cuts to the model's desk and room cameras
 * during the loading scene and the hand-over.
 */

export type SimHandle = {
  send: (cmd: Cmd) => void;
  confirm: () => void; // the kiosk button: Bin loaded / collected
};
export type EngineState = { time: number; robot: Engine['robot']; tasks: Engine['tasks'] };

type Robot = { x: number; y: number; yawDeg: number };
type CamPose = { name: string; pos?: number[]; mat?: number[]; fovy?: number };

const FOLLOW_HEIGHT = 4.5;

export default function SimView({ onReady, onRobot, onState, onCamera, style }: {
  onReady?: (h: SimHandle) => void;
  onRobot?: (r: Robot) => void;
  onState?: (s: EngineState) => void;
  onCamera?: (name: string) => void; // 'follow', 'desk_staff', 'room_1204', ...
  style?: React.CSSProperties;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Latest callbacks for the long-lived worker handler, updated after render.
  const cb = useRef({ onReady, onRobot, onState, onCamera });
  useEffect(() => { cb.current = { onReady, onRobot, onState, onCamera }; });

  useEffect(() => {
    const el = mount.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#15191f');
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(2, -3, 6);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, FOLLOW_HEIGHT);
    camera.lookAt(0, 0, 0);

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const meshes: (THREE.Mesh | null)[] = [];
    const mat4 = new THREE.Matrix4();
    let robot: Robot = { x: 0, y: 0, yawDeg: 0 };
    let cam: CamPose = { name: 'follow' };

    const worker = new Worker(new URL('../lib/sim/sim.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'error') { setError(msg.message); setLoading(false); return; }
      if (msg.type === 'static') {
        for (let i = 0; i < msg.ngeom; i++) {
          const type = msg.geomType[i], s = msg.geomSize.subarray(i * 3, i * 3 + 3);
          const a = msg.rgba[i * 4 + 3];
          if (msg.geomGroup[i] >= 3 || a === 0) { meshes.push(null); continue; }
          let geo: THREE.BufferGeometry | null = null;
          if (type === 0) geo = new THREE.PlaneGeometry(s[0] > 0 ? 2 * s[0] : 20, s[1] > 0 ? 2 * s[1] : 20);
          else if (type === 2) geo = new THREE.SphereGeometry(s[0], 20, 14);
          else if (type === 3) geo = new THREE.CapsuleGeometry(s[0], 2 * s[1], 6, 14).rotateX(Math.PI / 2);
          else if (type === 5) geo = new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 24).rotateX(Math.PI / 2);
          else if (type === 6) geo = new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
          if (!geo) { meshes.push(null); continue; }
          const color = new THREE.Color(msg.rgba[i * 4], msg.rgba[i * 4 + 1], msg.rgba[i * 4 + 2]);
          // past the floor's edge, show more floor rather than a void
          if (type === 0) scene.background = color.clone().multiplyScalar(0.9);
          const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, transparent: a < 1, opacity: a }));
          mesh.matrixAutoUpdate = false;
          scene.add(mesh);
          meshes.push(mesh);
        }
        setLoading(false);
        cb.current.onReady?.({
          send: (cmd) => worker.postMessage({ type: 'cmd', cmd }),
          confirm: () => worker.postMessage({ type: 'confirm' }),
        });
      } else if (msg.type === 'frame') {
        const { xpos, xmat } = msg;
        for (let i = 0; i < meshes.length; i++) {
          const mesh = meshes[i];
          if (!mesh) continue;
          const r = xmat.subarray(i * 9, i * 9 + 9);
          mat4.set(r[0], r[1], r[2], xpos[i * 3],
                   r[3], r[4], r[5], xpos[i * 3 + 1],
                   r[6], r[7], r[8], xpos[i * 3 + 2],
                   0, 0, 0, 1);
          mesh.matrix.copy(mat4);
        }
        robot = msg.robot;
        if (msg.camera.name !== cam.name) cb.current.onCamera?.(msg.camera.name);
        cam = msg.camera;
        cb.current.onRobot?.(robot);
      } else if (msg.type === 'state') {
        cb.current.onState?.({ time: msg.time, robot: msg.robot, tasks: msg.tasks });
      } else if (msg.type === 'cmdError') {
        console.warn('[sim] command rejected:', msg.message);
      }
    };

    let raf = 0;
    const camMat = new THREE.Matrix4(), scale = new THREE.Vector3();
    const draw = () => {
      if (cam.pos && cam.mat) {
        // MuJoCo cameras look down their -z with +y up, same as three.js
        const r = cam.mat;
        camMat.set(r[0], r[1], r[2], cam.pos[0], r[3], r[4], r[5], cam.pos[1], r[6], r[7], r[8], cam.pos[2], 0, 0, 0, 1);
        camMat.decompose(camera.position, camera.quaternion, scale);
        if (camera.fov !== cam.fovy) { camera.fov = cam.fovy ?? 45; camera.updateProjectionMatrix(); }
      } else {
        if (camera.fov !== 45) { camera.fov = 45; camera.updateProjectionMatrix(); }
        camera.up.set(0, 1, 0);
        // same corridor width in view whatever the pane's shape
        camera.position.set(robot.x, robot.y, FOLLOW_HEIGHT * Math.max(1, 1.6 / camera.aspect));
        camera.lookAt(robot.x, robot.y, 0);
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      worker.terminate();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div ref={mount} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 320, ...style }}>
      {(loading || error) && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d8d4d3', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 14 }}>
          {error ? `Simulation failed to start: ${error}` : 'Loading MuJoCo…'}
        </div>
      )}
    </div>
  );
}
