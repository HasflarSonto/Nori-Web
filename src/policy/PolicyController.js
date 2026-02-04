/**
 * Policy Controller
 *
 * Manages RL policy execution for humanoid robots.
 * Handles policy loading, inference, and PD control.
 */

import { PolicyRunner } from './policyRunner.js';
import { toFloatArray } from './math.js';

const MOTION_INDEX_FORMAT = 'tracking-motion-index-v1';

function stripJsonExtension(path) {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.json$/i, '');
}

function normalizeMotionEntry(entry) {
  if (typeof entry === 'string') {
    return { name: stripJsonExtension(entry), file: entry };
  }
  if (entry && typeof entry === 'object') {
    const file = entry.file ?? entry.path ?? null;
    if (!file) {
      return null;
    }
    const name = entry.name ?? stripJsonExtension(file);
    return { name, file };
  }
  return null;
}

function parseMotionIndex(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (payload.format !== MOTION_INDEX_FORMAT) {
    return null;
  }
  const motions = Array.isArray(payload.motions) ? payload.motions : [];
  return {
    basePath: payload.base_path ?? null,
    motions
  };
}

async function loadMotionIndex(indexPayload, motionsUrl) {
  const index = parseMotionIndex(indexPayload);
  if (!index) {
    return null;
  }

  const basePath = index.basePath
    ? (index.basePath.endsWith('/') ? index.basePath : `${index.basePath}/`)
    : null;
  const baseUrl = basePath
    ? new URL(basePath, motionsUrl)
    : new URL('.', motionsUrl);
  const motions = {};
  const entries = index.motions.map((entry) => normalizeMotionEntry(entry));

  const requests = entries.map(async (entry) => {
    if (!entry || !entry.file || !entry.name) {
      throw new Error('Motion index entries must include a name and file path.');
    }
    const clipUrl = new URL(entry.file, baseUrl).toString();
    const response = await fetch(clipUrl);
    if (!response.ok) {
      throw new Error(`Failed to load motion clip from ${clipUrl}: ${response.status}`);
    }
    const clip = await response.json();
    motions[entry.name] = clip;
  });

  await Promise.all(requests);
  return motions;
}

export class PolicyController {
  constructor() {
    this.enabled = false;
    this.policyRunner = null;
    this.config = null;
    this.currentPolicyPath = null;

    // Joint mappings
    this.policyJointNames = null;
    this.jointNamesMJC = [];
    this.ctrl_adr_policy = [];
    this.qpos_adr_policy = [];
    this.qvel_adr_policy = [];
    this.numActions = 0;

    // PD gains
    this.kpPolicy = null;
    this.kdPolicy = null;
    this.defaultJposPolicy = null;

    // Control type
    this.control_type = 'joint_position';

    // Action target
    this.actionTarget = null;

    // MuJoCo references
    this.model = null;
    this.data = null;
    this.mujoco = null;

    // Decimation
    this.decimation = 1;
    this.timestep = 0.002;
  }

  /**
   * Load and initialize a policy
   * @param {string} policyPath - Path to policy JSON config
   * @param {object} model - MuJoCo model
   * @param {object} data - MuJoCo data
   * @param {object} mujoco - MuJoCo WASM module
   */
  async loadPolicy(policyPath, model, data, mujoco) {
    this.model = model;
    this.data = data;
    this.mujoco = mujoco;
    this.currentPolicyPath = policyPath;

    // Wait if previous inference is running
    while (this.policyRunner?.isInferencing) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    console.log('Loading policy:', policyPath);

    // Load policy config
    const response = await fetch(policyPath);
    if (!response.ok) {
      throw new Error(`Failed to load policy config from ${policyPath}: ${response.status}`);
    }
    const config = await response.json();
    this.config = config;

    // Load tracking config if present
    let trackingConfig = null;
    if (config.tracking) {
      trackingConfig = { ...config.tracking };
      if (trackingConfig.motions_path && !trackingConfig.motions) {
        const motionsUrl = new URL(trackingConfig.motions_path, window.location.href);
        const motionResponse = await fetch(motionsUrl);
        if (!motionResponse.ok) {
          throw new Error(`Failed to load tracking motions from ${motionsUrl}: ${motionResponse.status}`);
        }
        const payload = await motionResponse.json();
        const indexedMotions = await loadMotionIndex(payload, motionsUrl);
        trackingConfig.motions = indexedMotions ?? payload;
      }
    }

    // Get policy joint names
    const policyJointNames = Array.isArray(config.policy_joint_names)
      ? config.policy_joint_names
      : null;
    if (!policyJointNames || policyJointNames.length === 0) {
      throw new Error('Policy configuration must include a non-empty policy_joint_names list');
    }

    // Build joint name list from MuJoCo model
    this._buildJointNames(model);

    // Configure joint mappings
    this._configureJointMappings(policyJointNames);

    // Set default joint positions
    const configDefaultJointPos = Array.isArray(config.default_joint_pos)
      ? config.default_joint_pos
      : null;
    if (configDefaultJointPos) {
      if (configDefaultJointPos.length !== this.numActions) {
        throw new Error(
          `default_joint_pos length ${configDefaultJointPos.length} does not match policy_joint_names length ${this.numActions}`
        );
      }
      this.defaultJposPolicy = new Float32Array(configDefaultJointPos);
    } else {
      this.defaultJposPolicy = new Float32Array(this.numActions);
    }

    // Set PD gains
    this.kpPolicy = toFloatArray(config.stiffness, this.numActions, 0.0);
    this.kdPolicy = toFloatArray(config.damping, this.numActions, 0.0);
    this.control_type = config.control_type ?? 'joint_position';

    // Add policy joint names to tracking config
    if (trackingConfig) {
      trackingConfig.policy_joint_names = policyJointNames.slice();
    }

    // Calculate decimation
    this.timestep = model.opt.timestep;
    this.decimation = Math.max(1, Math.round(0.02 / this.timestep));
    console.log('Policy timestep:', this.timestep, 'decimation:', this.decimation);

    // Create policy runner
    this.policyRunner = new PolicyRunner(
      {
        ...config,
        tracking: trackingConfig,
        policy_joint_names: policyJointNames,
        action_scale: config.action_scale,
        default_joint_pos: this.defaultJposPolicy
      },
      {
        policyJointNames,
        actionScale: config.action_scale,
        defaultJointPos: this.defaultJposPolicy
      }
    );
    await this.policyRunner.init();

    // Reset with current state
    const state = this.readPolicyState();
    this.policyRunner.reset(state);

    this.enabled = true;
    console.log('Policy loaded successfully');
  }

  _buildJointNames(model) {
    const textDecoder = new TextDecoder();
    const namesArray = new Uint8Array(model.names);

    this.jointNamesMJC = [];
    for (let j = 0; j < model.njnt; j++) {
      let start_idx = model.name_jntadr[j];
      let end_idx = start_idx;
      while (end_idx < namesArray.length && namesArray[end_idx] !== 0) {
        end_idx++;
      }
      this.jointNamesMJC.push(textDecoder.decode(namesArray.subarray(start_idx, end_idx)));
    }
  }

  _configureJointMappings(jointNames) {
    const model = this.model;
    const mujoco = this.mujoco;

    this.policyJointNames = jointNames.slice();

    const jointTransmission = mujoco.mjtTrn.mjTRN_JOINT.value;
    const actuator2joint = [];
    for (let i = 0; i < model.nu; i++) {
      if (model.actuator_trntype[i] !== jointTransmission) {
        throw new Error(`Actuator ${i} transmission type is not mjTRN_JOINT`);
      }
      actuator2joint.push(model.actuator_trnid[2 * i]);
    }

    this.ctrl_adr_policy = [];
    this.qpos_adr_policy = [];
    this.qvel_adr_policy = [];

    for (const name of jointNames) {
      const jointIdx = this.jointNamesMJC.indexOf(name);
      if (jointIdx < 0) {
        throw new Error(`Joint "${name}" not found in MuJoCo model`);
      }
      const actuatorIdx = actuator2joint.findIndex((jointId) => jointId === jointIdx);
      if (actuatorIdx < 0) {
        throw new Error(`No actuator mapped to joint "${name}"`);
      }
      this.ctrl_adr_policy.push(actuatorIdx);
      this.qpos_adr_policy.push(model.jnt_qposadr[jointIdx]);
      this.qvel_adr_policy.push(model.jnt_dofadr[jointIdx]);
    }

    this.numActions = jointNames.length;
  }

  /**
   * Read current state for policy
   */
  readPolicyState() {
    const qpos = this.data.qpos;
    const qvel = this.data.qvel;
    const jointPos = new Float32Array(this.numActions);
    const jointVel = new Float32Array(this.numActions);
    for (let i = 0; i < this.numActions; i++) {
      const qposAdr = this.qpos_adr_policy[i];
      const qvelAdr = this.qvel_adr_policy[i];
      jointPos[i] = qpos[qposAdr];
      jointVel[i] = qvel[qvelAdr];
    }
    const rootPos = new Float32Array([qpos[0], qpos[1], qpos[2]]);
    const rootQuat = new Float32Array([qpos[3], qpos[4], qpos[5], qpos[6]]);
    const rootAngVel = new Float32Array([qvel[3], qvel[4], qvel[5]]);
    return {
      jointPos,
      jointVel,
      rootPos,
      rootQuat,
      rootAngVel
    };
  }

  /**
   * Run one policy step and apply PD control
   * Returns the number of physics substeps to run
   */
  async step() {
    if (!this.enabled || !this.policyRunner) {
      return 0;
    }

    const state = this.readPolicyState();

    try {
      this.actionTarget = await this.policyRunner.step(state);
    } catch (e) {
      console.error('Policy inference error:', e);
      return 0;
    }

    return this.decimation;
  }

  /**
   * Apply PD control for one substep
   */
  applyControl() {
    if (!this.enabled || !this.actionTarget) {
      return;
    }

    if (this.control_type === 'joint_position') {
      for (let i = 0; i < this.numActions; i++) {
        const qpos_adr = this.qpos_adr_policy[i];
        const qvel_adr = this.qvel_adr_policy[i];
        const ctrl_adr = this.ctrl_adr_policy[i];

        const targetJpos = this.actionTarget[i];
        const kp = this.kpPolicy[i];
        const kd = this.kdPolicy[i];
        const torque = kp * (targetJpos - this.data.qpos[qpos_adr]) + kd * (0 - this.data.qvel[qvel_adr]);

        let ctrlValue = torque;
        const ctrlRange = this.model?.actuator_ctrlrange;
        if (ctrlRange && ctrlRange.length >= (ctrl_adr + 1) * 2) {
          const min = ctrlRange[ctrl_adr * 2];
          const max = ctrlRange[(ctrl_adr * 2) + 1];
          if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
            ctrlValue = Math.min(Math.max(ctrlValue, min), max);
          }
        }
        this.data.ctrl[ctrl_adr] = ctrlValue;
      }
    }
  }

  /**
   * Reset the policy
   */
  reset() {
    if (this.policyRunner) {
      const state = this.readPolicyState();
      this.policyRunner.reset(state);
    }
    this.actionTarget = null;
  }

  /**
   * Disable the policy
   */
  disable() {
    this.enabled = false;
    this.policyRunner = null;
    this.actionTarget = null;
  }

  /**
   * Get available motions
   */
  getAvailableMotions() {
    if (this.policyRunner) {
      return this.policyRunner.getAvailableMotions();
    }
    return [];
  }

  /**
   * Request a motion
   */
  requestMotion(name) {
    if (this.policyRunner) {
      const state = this.readPolicyState();
      return this.policyRunner.requestMotion(name, state);
    }
    return false;
  }

  /**
   * Get current playback state
   */
  getPlaybackState() {
    if (this.policyRunner) {
      return this.policyRunner.getPlaybackState();
    }
    return null;
  }
}

// Singleton instance
export const policyController = new PolicyController();
