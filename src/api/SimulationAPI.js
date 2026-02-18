/**
 * Simulation API - Browser-side Control Interface
 *
 * Provides high-level robot control methods that the WebSocket
 * command handler calls. Each method manipulates MuJoCo data
 * directly and returns results.
 *
 * Motor direction reference (from XLeRobotController keyboard mapping):
 *   ctrl[0]  forward tendon: W (visual forward) = -1,  S (visual backward) = +1
 *   ctrl[1]  turn tendon:    A (visual left)    = +1,  D (visual right)    = -1
 */

import { getPosition, getQuaternion } from '../mujocoUtils.js';
import { inverseKinematics2Link } from '../utils/math/inverseKinematics.js';
import * as THREE from 'three';

// Motor direction constants (matching XLeRobotController)
const MOTOR_FORWARD = -1;   // W key = visual forward = negative ctrl[0]
const MOTOR_BACKWARD = 1;   // S key = visual backward = positive ctrl[0]
const MOTOR_TURN_LEFT = 1;  // A key = visual left turn = positive ctrl[1]
const MOTOR_TURN_RIGHT = -1; // D key = visual right turn = negative ctrl[1]

export class SimulationAPI {
  /**
   * @param {object} demo - The MuJoCoDemo instance
   * @param {RobotCamera} robotCamera - The head-mounted camera
   */
  constructor(demo, robotCamera) {
    this.demo = demo;
    this.robotCamera = robotCamera;

    // Cache body name -> index mapping
    this._bodyNameMap = null;
    this._actuatorNameMap = null;
  }

  /**
   * Rebuild internal caches after model reload.
   */
  rebuildCaches() {
    this._bodyNameMap = null;
    this._actuatorNameMap = null;
  }

  _ensureBodyNameMap() {
    if (this._bodyNameMap) return;
    this._bodyNameMap = {};

    const model = this.demo.model;
    if (!model) return;

    const textDecoder = new TextDecoder('utf-8');
    const nullChar = textDecoder.decode(new ArrayBuffer(1));

    for (let b = 0; b < model.nbody; b++) {
      const name = textDecoder.decode(
        model.names.subarray(model.name_bodyadr[b])
      ).split(nullChar)[0];
      if (name) {
        this._bodyNameMap[name] = b;
      }
    }
  }

  _ensureActuatorNameMap() {
    if (this._actuatorNameMap) return;
    this._actuatorNameMap = {};

    const model = this.demo.model;
    if (!model) return;

    const textDecoder = new TextDecoder('utf-8');
    const nullChar = textDecoder.decode(new ArrayBuffer(1));

    for (let i = 0; i < model.nu; i++) {
      const name = textDecoder.decode(
        model.names.subarray(model.name_actuatoradr[i])
      ).split(nullChar)[0];
      if (name) {
        this._actuatorNameMap[name] = i;
      }
    }
  }

  /**
   * Get body position in MuJoCo coordinates (no swizzle).
   */
  _getBodyPosMJ(bodyIndex) {
    const data = this.demo.data;
    return {
      x: Math.round(data.xpos[bodyIndex * 3 + 0] * 1000) / 1000,
      y: Math.round(data.xpos[bodyIndex * 3 + 1] * 1000) / 1000,
      z: Math.round(data.xpos[bodyIndex * 3 + 2] * 1000) / 1000
    };
  }

  /**
   * Get the chassis body index. The XLeRobot root body is "chassis".
   */
  _getChassisIndex() {
    this._ensureBodyNameMap();
    return this._bodyNameMap['chassis'] ?? this._bodyNameMap['base_link'] ?? 1;
  }

  /**
   * Get the robot base position in MuJoCo coordinates.
   */
  _getRobotBasePos() {
    return this._getBodyPosMJ(this._getChassisIndex());
  }

  /**
   * Get the robot's current facing angle (yaw) in radians.
   * In MuJoCo Z-up, yaw = rotation around Z.
   */
  _getRobotYaw() {
    const idx = this._getChassisIndex();
    const data = this.demo.data;
    // MuJoCo quaternion: (w, x, y, z)
    const w = data.xquat[idx * 4 + 0];
    const x = data.xquat[idx * 4 + 1];
    const y = data.xquat[idx * 4 + 2];
    const z = data.xquat[idx * 4 + 3];
    // Yaw from quaternion (rotation about Z-axis)
    return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  }

  /**
   * Execute a command from the AI server.
   */
  async executeCommand(action, params) {
    switch (action) {
      case 'observe_scene':
        return this._observeScene(params);
      case 'move_base':
        return this._moveBase(params);
      case 'move_arm':
        return this._moveArm(params);
      case 'set_gripper':
        return this._setGripper(params);
      case 'move_head':
        return this._moveHead(params);
      case 'get_robot_state':
        return this._getRobotState();
      case 'get_scene_objects':
        return this._getSceneObjects();
      case 'navigate_to':
        return this._navigateTo(params);
      case 'reset_robot':
        return this._resetRobot();
      case 'stop_motors':
        return this._stopMotors();
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  // ==========================================
  // Command Implementations
  // ==========================================

  _observeScene(params) {
    const sources = params.sources || {};
    const result = {};

    if (sources.head_camera !== false) {
      const img = this.robotCamera.capture();
      if (img) {
        result.head_camera_image = img;
      }
    }

    if (sources.orbit_camera !== false) {
      result.orbit_camera_image = this._captureOrbitCamera();
    }

    if (sources.state_data !== false) {
      result.robot_position = this._getRobotBasePos();
      result.robot_yaw = Math.round(this._getRobotYaw() * 100) / 100;
      result.objects = this._getSceneObjectsList();
    }

    return result;
  }

  _captureOrbitCamera() {
    const renderer = this.demo.renderer;
    const scene = this.demo.scene;
    const camera = this.demo.camera;

    // The renderer has preserveDrawingBuffer: true
    renderer.render(scene, camera);

    const canvas = renderer.domElement;
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1];
  }

  async _moveBase(params) {
    const { direction, amount } = params;
    const data = this.demo.data;

    const startPos = this._getRobotBasePos();
    const startYaw = this._getRobotYaw();

    return new Promise((resolve) => {
      let elapsed = 0;
      const checkInterval = 50;

      const step = () => {
        if (direction === 'forward' || direction === 'backward') {
          const currentPos = this._getRobotBasePos();
          const dx = currentPos.x - startPos.x;
          const dy = currentPos.y - startPos.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist >= amount || elapsed > 15000) {
            data.ctrl[0] = 0;
            resolve({
              success: dist >= amount * 0.7,
              distance_moved: Math.round(dist * 1000) / 1000,
              position: this._getRobotBasePos()
            });
            return;
          }

          data.ctrl[0] = direction === 'forward' ? MOTOR_FORWARD : MOTOR_BACKWARD;

        } else if (direction === 'turn_left' || direction === 'turn_right') {
          const currentYaw = this._getRobotYaw();
          let angleMoved = currentYaw - startYaw;
          // Normalize to [-pi, pi]
          while (angleMoved > Math.PI) angleMoved -= 2 * Math.PI;
          while (angleMoved < -Math.PI) angleMoved += 2 * Math.PI;

          if (Math.abs(angleMoved) >= amount || elapsed > 10000) {
            data.ctrl[1] = 0;
            resolve({
              success: Math.abs(angleMoved) >= amount * 0.7,
              angle_turned: Math.round(Math.abs(angleMoved) * 100) / 100,
              yaw: Math.round(currentYaw * 100) / 100,
              position: this._getRobotBasePos()
            });
            return;
          }

          data.ctrl[1] = direction === 'turn_left' ? MOTOR_TURN_LEFT : MOTOR_TURN_RIGHT;
        }

        elapsed += checkInterval;
        setTimeout(step, checkInterval);
      };

      step();
    });
  }

  _moveArm(params) {
    const { arm, x, y } = params;
    const data = this.demo.data;

    const [j2, j3] = inverseKinematics2Link(x, y);
    const wristPitch = j2 - j3;

    if (arm === 'left') {
      data.ctrl[3] = j2;   // Pitch_L
      data.ctrl[4] = j3;   // Elbow_L
      data.ctrl[5] = wristPitch; // Wrist_Pitch_L
    } else {
      data.ctrl[9] = j2;   // Pitch_R
      data.ctrl[10] = j3;  // Elbow_R
      data.ctrl[11] = wristPitch; // Wrist_Pitch_R
    }

    return {
      success: true,
      arm,
      target: { x, y },
      joint_angles: { shoulder_pitch: Math.round(j2 * 100) / 100, elbow: Math.round(j3 * 100) / 100 }
    };
  }

  _setGripper(params) {
    const { arm, state } = params;
    const data = this.demo.data;

    const GRIPPER_OPEN = 1.5;
    const GRIPPER_CLOSED = -0.25;
    const value = state === 'open' ? GRIPPER_OPEN : GRIPPER_CLOSED;

    if (arm === 'left') {
      data.ctrl[7] = value;
    } else {
      data.ctrl[13] = value;
    }

    return { success: true, arm, state };
  }

  async _moveHead(params) {
    const { pan, tilt } = params;
    const data = this.demo.data;

    const clampedPan = Math.max(-3.2, Math.min(3.2, pan));
    const clampedTilt = Math.max(-0.76, Math.min(1.45, tilt));

    data.ctrl[14] = clampedPan;
    data.ctrl[15] = clampedTilt;

    // Wait for the head to settle
    await this._wait(500);

    const result = {
      success: true,
      pan: clampedPan,
      tilt: clampedTilt
    };

    const img = this.robotCamera.capture();
    if (img) {
      result.head_camera_image = img;
    }

    return result;
  }

  _getRobotState() {
    const model = this.demo.model;
    const data = this.demo.data;
    this._ensureActuatorNameMap();

    const joints = {};
    const textDecoder = new TextDecoder('utf-8');
    const nullChar = textDecoder.decode(new ArrayBuffer(1));

    for (let j = 0; j < model.njnt; j++) {
      const name = textDecoder.decode(
        model.names.subarray(model.name_jntadr[j])
      ).split(nullChar)[0];

      const qposAddr = model.jnt_qposadr[j];
      joints[name] = Math.round(data.qpos[qposAddr] * 1000) / 1000;
    }

    const actuators = {};
    for (const [name, idx] of Object.entries(this._actuatorNameMap)) {
      actuators[name] = Math.round(data.ctrl[idx] * 1000) / 1000;
    }

    return {
      position: this._getRobotBasePos(),
      yaw: Math.round(this._getRobotYaw() * 100) / 100,
      joints,
      actuators
    };
  }

  _getSceneObjects() {
    return {
      objects: this._getSceneObjectsList()
    };
  }

  _getSceneObjectsList() {
    this._ensureBodyNameMap();
    const objects = [];

    // Known robot body names to exclude (exact matches and prefix patterns)
    const robotBodyNames = new Set([
      'chassis', 'left_wheel', 'right_wheel',
      'top_base_link', 'caster_back_left_1', 'caster_back_right_1'
    ]);

    // Robot body name patterns (substring match)
    const robotPatterns = [
      'Rotation_Link', 'Pitch_Link', 'Elbow_Link', 'Wrist_', 'Jaw_',
      'head_', 'Left_Arm', 'Right_Arm', '_Camera',
      'SO_', 'panda_link', 'hand'
    ];

    for (const [name, idx] of Object.entries(this._bodyNameMap)) {
      if (idx === 0) continue; // world body
      if (name === '') continue;
      if (robotBodyNames.has(name)) continue;
      if (robotPatterns.some(p => name.includes(p))) continue;

      const pos = this._getBodyPosMJ(idx);
      objects.push({
        name,
        position: pos
      });
    }

    return objects;
  }

  async _navigateTo(params) {
    const { target, stop_distance } = params;
    const stopDist = stop_distance || 0.3;

    // Resolve target to coordinates
    let targetX, targetY;

    if (target.includes(',')) {
      const parts = target.split(',').map(s => parseFloat(s.trim()));
      targetX = parts[0];
      targetY = parts[1];
    } else {
      this._ensureBodyNameMap();
      const bodyIdx = this._bodyNameMap[target];
      if (bodyIdx === undefined) {
        return { error: `Object "${target}" not found in scene. Use get_scene_objects to see available objects.` };
      }
      const pos = this._getBodyPosMJ(bodyIdx);
      targetX = pos.x;
      targetY = pos.y;
    }

    const data = this.demo.data;

    // Phase 1: Turn to face target
    await new Promise((resolve) => {
      let elapsed = 0;
      const checkInterval = 50;

      const step = () => {
        const pos = this._getRobotBasePos();
        const yaw = this._getRobotYaw();
        const dx = targetX - pos.x;
        const dy = targetY - pos.y;
        const targetAngle = Math.atan2(dy, dx);

        let angleDiff = targetAngle - yaw;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        if (Math.abs(angleDiff) < 0.15 || elapsed > 10000) {
          data.ctrl[1] = 0;
          resolve();
          return;
        }

        // Proportional turn speed with min threshold
        const turnSpeed = Math.min(1, Math.max(0.3, Math.abs(angleDiff)));
        data.ctrl[1] = angleDiff > 0 ? turnSpeed * MOTOR_TURN_LEFT : turnSpeed * MOTOR_TURN_RIGHT;

        elapsed += checkInterval;
        setTimeout(step, checkInterval);
      };

      step();
    });

    // Phase 2: Drive toward target with steering correction
    const driveResult = await new Promise((resolve) => {
      let elapsed = 0;
      const checkInterval = 50;

      const step = () => {
        const pos = this._getRobotBasePos();
        const dx = targetX - pos.x;
        const dy = targetY - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= stopDist || elapsed > 20000) {
          data.ctrl[0] = 0;
          data.ctrl[1] = 0;
          resolve({
            distance_remaining: Math.round(dist * 1000) / 1000,
            reached: dist <= stopDist * 1.5
          });
          return;
        }

        // Steer correction while driving
        const yaw = this._getRobotYaw();
        const targetAngle = Math.atan2(dy, dx);
        let angleDiff = targetAngle - yaw;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        data.ctrl[0] = MOTOR_FORWARD * 0.8;
        // Proportional steering
        const steer = Math.max(-0.4, Math.min(0.4, angleDiff * 1.5));
        data.ctrl[1] = steer;

        elapsed += checkInterval;
        setTimeout(step, checkInterval);
      };

      step();
    });

    return {
      success: driveResult.reached,
      target: { name: target, x: targetX, y: targetY },
      final_position: this._getRobotBasePos(),
      distance_remaining: driveResult.distance_remaining
    };
  }

  _resetRobot() {
    const { model, data, mujoco } = this.demo;
    mujoco.mj_resetData(model, data);
    mujoco.mj_forward(model, data);
    return { success: true };
  }

  _stopMotors() {
    const data = this.demo.data;
    data.ctrl[0] = 0; // forward/backward
    data.ctrl[1] = 0; // turn
    return { success: true };
  }

  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
