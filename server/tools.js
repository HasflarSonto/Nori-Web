/**
 * Tool Definitions & Handlers for Claude AI Robot Control
 *
 * Each tool translates a Claude tool call into a WebSocket command
 * sent to the browser simulation, waits for the response, and returns
 * structured results back to Claude.
 */

// Default timeout for blocking commands (ms)
const COMMAND_TIMEOUT = 30000;

/**
 * Tool definitions for the Claude API (tool_use format)
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'observe_scene',
    description:
      'Capture visual and/or state data from the simulation. Use this to look around, understand the environment, and check robot status. Returns images from the robot head camera and/or orbit camera, plus structured state data about all objects and the robot.',
    input_schema: {
      type: 'object',
      properties: {
        sources: {
          type: 'object',
          description: 'Which data sources to include. All enabled by default.',
          properties: {
            head_camera: {
              type: 'boolean',
              description: 'Include the robot head-mounted camera view (first-person perspective)'
            },
            orbit_camera: {
              type: 'boolean',
              description: 'Include the orbit camera view (third-person overview)'
            },
            state_data: {
              type: 'boolean',
              description: 'Include structured state data (object positions, robot joint angles, etc.)'
            }
          }
        }
      }
    }
  },
  {
    name: 'move_base',
    description:
      'Move the robot base in a direction. The robot has a mobile base with forward/backward and turn motors. Blocks until movement completes or times out.',
    input_schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['forward', 'backward', 'turn_left', 'turn_right'],
          description: 'Direction to move the base'
        },
        amount: {
          type: 'number',
          description: 'Amount to move: meters for forward/backward, radians for turning. Typical values: 0.1-1.0m for movement, 0.1-3.14 rad for turning.'
        }
      },
      required: ['direction', 'amount']
    }
  },
  {
    name: 'move_arm',
    description:
      'Move a robot arm end-effector to a target position using inverse kinematics. The robot has left and right arms, each with a 2-link IK chain. Coordinates are relative to the arm shoulder in the arm plane: x is forward distance, y is vertical distance.',
    input_schema: {
      type: 'object',
      properties: {
        arm: {
          type: 'string',
          enum: ['left', 'right'],
          description: 'Which arm to move'
        },
        x: {
          type: 'number',
          description: 'Forward distance from shoulder (meters). Range approx 0.05-0.25'
        },
        y: {
          type: 'number',
          description: 'Vertical distance from shoulder (meters). Range approx 0.05-0.25'
        }
      },
      required: ['arm', 'x', 'y']
    }
  },
  {
    name: 'set_gripper',
    description: 'Open or close a gripper on the robot arm.',
    input_schema: {
      type: 'object',
      properties: {
        arm: {
          type: 'string',
          enum: ['left', 'right'],
          description: 'Which gripper to control'
        },
        state: {
          type: 'string',
          enum: ['open', 'close'],
          description: 'Whether to open or close the gripper'
        }
      },
      required: ['arm', 'state']
    }
  },
  {
    name: 'move_head',
    description:
      'Point the robot head camera by setting pan and tilt angles. Returns the new head camera image after moving. Pan rotates left/right, tilt angles up/down.',
    input_schema: {
      type: 'object',
      properties: {
        pan: {
          type: 'number',
          description: 'Head pan angle in radians. 0=forward, positive=left, negative=right. Range: -3.2 to 3.2'
        },
        tilt: {
          type: 'number',
          description: 'Head tilt angle in radians. 0=level, positive=up, negative=down. Range: -0.76 to 1.45'
        }
      },
      required: ['pan', 'tilt']
    }
  },
  {
    name: 'get_robot_state',
    description:
      'Get the full robot state including all joint positions, joint velocities, actuator controls, and body positions. Useful for precise position checking.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_scene_objects',
    description:
      'Get a list of all named objects in the scene with their 3D positions, types, and sizes. Use this to understand the environment layout and find targets for navigation.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'navigate_to',
    description:
      'High-level navigation: move the robot base to a named object or XY coordinate. The robot will turn to face the target and drive toward it. Use this for tasks like "go to the table" or "move to position (1, 0.5)".',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Name of an object in the scene (e.g. "table1") OR coordinates as "x,y" (e.g. "1.35,0.02")'
        },
        stop_distance: {
          type: 'number',
          description: 'How far from the target to stop (meters). Default 0.3'
        }
      },
      required: ['target']
    }
  },
  {
    name: 'reset_robot',
    description: 'Reset the robot to its initial pose and position. Use when the robot is in a bad state or you need to start over.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
];

/**
 * Execute a tool by sending a command to the browser simulation via WebSocket.
 *
 * @param {string} toolName - The tool name from Claude's tool_use
 * @param {object} toolInput - The tool input parameters
 * @param {function} sendCommand - Async function that sends a command to the browser and returns a response
 * @param {object} dataSourceOverrides - Per-session overrides for data sources {head_camera, orbit_camera, state_data}
 * @returns {Promise<object>} - Tool result to send back to Claude
 */
export async function executeTool(toolName, toolInput, sendCommand, dataSourceOverrides = {}) {
  try {
    switch (toolName) {
      case 'observe_scene': {
        const sources = {
          head_camera: toolInput.sources?.head_camera ?? dataSourceOverrides.head_camera ?? true,
          orbit_camera: toolInput.sources?.orbit_camera ?? dataSourceOverrides.orbit_camera ?? true,
          state_data: toolInput.sources?.state_data ?? dataSourceOverrides.state_data ?? true
        };
        return await sendCommand('observe_scene', { sources }, COMMAND_TIMEOUT);
      }

      case 'move_base':
        return await sendCommand('move_base', {
          direction: toolInput.direction,
          amount: toolInput.amount
        }, COMMAND_TIMEOUT);

      case 'move_arm':
        return await sendCommand('move_arm', {
          arm: toolInput.arm,
          x: toolInput.x,
          y: toolInput.y
        }, COMMAND_TIMEOUT);

      case 'set_gripper':
        return await sendCommand('set_gripper', {
          arm: toolInput.arm,
          state: toolInput.state
        }, COMMAND_TIMEOUT);

      case 'move_head':
        return await sendCommand('move_head', {
          pan: toolInput.pan,
          tilt: toolInput.tilt
        }, COMMAND_TIMEOUT);

      case 'get_robot_state':
        return await sendCommand('get_robot_state', {}, COMMAND_TIMEOUT);

      case 'get_scene_objects':
        return await sendCommand('get_scene_objects', {}, COMMAND_TIMEOUT);

      case 'navigate_to':
        return await sendCommand('navigate_to', {
          target: toolInput.target,
          stop_distance: toolInput.stop_distance ?? 0.3
        }, COMMAND_TIMEOUT * 2); // Navigation may take longer

      case 'reset_robot':
        return await sendCommand('reset_robot', {}, COMMAND_TIMEOUT);

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}
