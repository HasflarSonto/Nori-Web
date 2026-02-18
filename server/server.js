/**
 * MuJoCo-GS-Web AI Server
 *
 * Express + WebSocket server that:
 * 1. Serves the simulation static files
 * 2. Relays commands between Claude AI and the browser simulation
 * 3. Provides a chat API endpoint for the in-page chat UI
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import { AIController } from './ai-controller.js';

// Load .env from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
config({ path: join(projectRoot, '.env') });

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set. Create a .env file in the project root with:');
  console.error('  ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

// --- Express App ---
const app = express();
app.use(express.json({ limit: '50mb' }));

// Serve static files from project root
app.use(express.static(projectRoot));

const httpServer = createServer(app);

// --- WebSocket Server ---
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// Track connected simulation clients
let simulationSocket = null;
let pendingCommands = new Map(); // id -> { resolve, reject, timer }
let commandIdCounter = 0;

wss.on('connection', (ws) => {
  console.log('Simulation client connected');
  simulationSocket = ws;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'command_result' && msg.id !== undefined) {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(msg.id);
          pending.resolve(msg.result);
        }
      }
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Simulation client disconnected');
    if (simulationSocket === ws) {
      simulationSocket = null;
    }
    // Reject all pending commands
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Simulation disconnected'));
    }
    pendingCommands.clear();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

/**
 * Send a command to the browser simulation and wait for the response.
 */
function sendCommandToSim(action, params, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!simulationSocket || simulationSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error('Simulation not connected. Please open the simulation in a browser.'));
    }

    const id = commandIdCounter++;
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command "${action}" timed out after ${timeout}ms`));
    }, timeout);

    pendingCommands.set(id, { resolve, reject, timer });

    simulationSocket.send(JSON.stringify({
      type: 'command',
      id,
      action,
      params
    }));
  });
}

// --- AI Controller ---
const aiController = new AIController(API_KEY);

// --- Chat API ---
app.post('/api/chat', async (req, res) => {
  const { message, dataSources } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!simulationSocket || simulationSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Simulation not connected. Please open the simulation page first.' });
  }

  // Apply data source toggles if provided
  if (dataSources) {
    aiController.setDataSources(dataSources);
  }

  // Stream updates via SSE-like JSON lines
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const onStream = (update) => {
    try {
      res.write(JSON.stringify(update) + '\n');
    } catch (e) {
      // Client disconnected
    }
  };

  try {
    const finalText = await aiController.processMessage(
      message,
      sendCommandToSim,
      onStream
    );

    // Send final completion marker
    res.write(JSON.stringify({ type: 'done', text: finalText }) + '\n');
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') {
      res.write(JSON.stringify({ type: 'aborted', text: 'Interrupted by user' }) + '\n');
      res.end();
    } else {
      console.error('Chat error:', err);
      res.write(JSON.stringify({ type: 'error', text: err.message }) + '\n');
      res.end();
    }
  }
});

// Abort current AI request
app.post('/api/chat/abort', (req, res) => {
  aiController.abort();
  res.json({ success: true });
});

// Clear conversation history
app.post('/api/chat/clear', (req, res) => {
  aiController.clearHistory();
  res.json({ success: true });
});

// Health check
app.get('/api/status', (req, res) => {
  res.json({
    simulation_connected: simulationSocket !== null && simulationSocket.readyState === WebSocket.OPEN,
    pending_commands: pendingCommands.size
  });
});

// --- Start ---
httpServer.listen(PORT, () => {
  console.log(`\n  MuJoCo-GS-Web AI Server`);
  console.log(`  -----------------------`);
  console.log(`  Open in browser: http://localhost:${PORT}`);
  console.log(`  WebSocket:       ws://localhost:${PORT}/ws`);
  console.log(`  Chat API:        POST http://localhost:${PORT}/api/chat`);
  console.log(`  Status:          GET  http://localhost:${PORT}/api/status\n`);
});
