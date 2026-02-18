/**
 * AI Controller - Claude API Integration
 *
 * Manages conversation with Claude, handles tool calls,
 * and translates between natural language and robot commands.
 */

import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

const SYSTEM_PROMPT = `You are an AI controller for an XLeRobot, a dual-arm mobile robot operating in a MuJoCo physics simulation. The simulation renders a realistic 3D environment using Gaussian Splatting.

## Your Capabilities
You can see through the robot's head-mounted camera, observe the scene from a third-person orbit camera, and read structured state data about the environment. You control the robot by calling tools to move its base, arms, head, and grippers.

## The Robot
- **Mobile base**: Can drive forward/backward and turn left/right
- **Two arms** (left and right): Each has a 2-link IK chain for positioning the end effector, plus shoulder rotation, wrist roll, and a gripper
- **Head camera**: Pan/tilt head with an RGB camera mounted on it
- **Grippers**: Can open and close to grasp objects

## The Environment
The robot is in a tabletop environment with tables, walls, and potentially manipulable objects. Object positions are in MuJoCo coordinates (X=forward from world origin, Y=left, Z=up).

## Your Approach
1. **Always observe first**: Before acting, use observe_scene or get_scene_objects to understand the current state
2. **Plan step by step**: Break complex tasks into smaller actions
3. **Verify after acting**: After moving, observe again to confirm you reached the goal
4. **Be descriptive**: Tell the user what you see and what you're doing
5. **Use navigate_to for movement**: For going to named objects, prefer navigate_to over manual move_base calls

## Important Notes
- The robot starts at approximately (0, 0) facing the +X direction
- Tables are typically at heights around 0.4-0.8m
- Arm coordinates are relative to the shoulder, not the world
- Forward/backward base movement is along the robot's facing direction
- Head camera gives you the robot's first-person view`;

export class AIController {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.conversationHistory = [];
    this.dataSourceOverrides = {
      head_camera: true,
      orbit_camera: true,
      state_data: true
    };
    this._abortController = null;
  }

  /**
   * Set data source toggles
   */
  setDataSources({ head_camera, orbit_camera, state_data }) {
    if (head_camera !== undefined) this.dataSourceOverrides.head_camera = head_camera;
    if (orbit_camera !== undefined) this.dataSourceOverrides.orbit_camera = orbit_camera;
    if (state_data !== undefined) this.dataSourceOverrides.state_data = state_data;
  }

  /**
   * Process a user message through Claude, executing any tool calls.
   *
   * @param {string} userMessage - Natural language message from the user
   * @param {function} sendCommand - Async fn to send commands to the browser sim
   * @param {function} onStream - Callback for streaming text/status updates to the chat UI
   * @returns {Promise<string>} - Claude's final text response
   */
  async processMessage(userMessage, sendCommand, onStream) {
    this.conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    // Create an AbortController for this request
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    let finalText = '';
    let maxIterations = 20; // Safety limit for tool call loops

    try {
      while (maxIterations-- > 0) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        onStream({ type: 'status', text: 'Thinking...' });

        const response = await this.client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          messages: this.conversationHistory
        });

        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        // Process response content blocks
        const assistantContent = response.content;
        this.conversationHistory.push({
          role: 'assistant',
          content: assistantContent
        });

        // Extract text and tool use blocks
        let textParts = [];
        let toolUseBlocks = [];

        for (const block of assistantContent) {
          if (block.type === 'text') {
            textParts.push(block.text);
            onStream({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            toolUseBlocks.push(block);
            onStream({
              type: 'tool_call',
              name: block.name,
              input: block.input
            });
          }
        }

        finalText += textParts.join('');

        // If no tool calls, we're done
        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          break;
        }

        // Execute tool calls and collect results
        const toolResults = [];
        for (const toolBlock of toolUseBlocks) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

          onStream({
            type: 'status',
            text: `Executing: ${toolBlock.name}...`
          });

          const result = await executeTool(
            toolBlock.name,
            toolBlock.input,
            sendCommand,
            this.dataSourceOverrides
          );

          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

          // Build tool result content
          const resultContent = this._buildToolResultContent(toolBlock.name, result);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: resultContent
          });
        }

        // Add tool results to conversation
        this.conversationHistory.push({
          role: 'user',
          content: toolResults
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Stop the robot motors by sending a stop command
        try {
          await sendCommand('stop_motors', {}, 5000);
        } catch (_) {
          // Best-effort
        }
        throw err;
      }
      throw err;
    } finally {
      this._abortController = null;
    }

    return finalText;
  }

  /**
   * Abort the current in-progress processMessage call.
   */
  abort() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  /**
   * Build the content array for a tool result, handling images properly.
   */
  _buildToolResultContent(toolName, result) {
    if (result.error) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }

    const content = [];

    // Add images if present
    if (result.head_camera_image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: result.head_camera_image
        }
      });
      content.push({
        type: 'text',
        text: '[Head camera view above]'
      });
    }

    if (result.orbit_camera_image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: result.orbit_camera_image
        }
      });
      content.push({
        type: 'text',
        text: '[Orbit camera view above]'
      });
    }

    // Add structured data as text
    const dataResult = { ...result };
    delete dataResult.head_camera_image;
    delete dataResult.orbit_camera_image;

    if (Object.keys(dataResult).length > 0) {
      content.push({
        type: 'text',
        text: JSON.stringify(dataResult, null, 2)
      });
    }

    // Ensure we have at least one content block
    if (content.length === 0) {
      content.push({ type: 'text', text: 'Command executed successfully.' });
    }

    return content;
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.conversationHistory = [];
  }
}
