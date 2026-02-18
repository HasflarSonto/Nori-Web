/**
 * Chat Panel UI
 *
 * A collapsible side panel for interacting with the AI controller.
 * Displays message history, tool call status, and data source toggles.
 */

export class ChatPanel {
  constructor() {
    this.container = null;
    this.messagesEl = null;
    this.inputEl = null;
    this.sendBtn = null;
    this.statusEl = null;
    this.collapsed = false;
    this.sending = false;

    // Data source toggles
    this.dataSources = {
      head_camera: true,
      orbit_camera: true,
      state_data: true
    };

    this._build();
  }

  _build() {
    // Main container
    this.container = document.createElement('div');
    this.container.id = 'ai-chat-panel';
    this.container.innerHTML = `
      <style>
        #ai-chat-panel {
          position: fixed;
          top: 0;
          right: 0;
          width: 380px;
          height: 100vh;
          background: rgba(15, 15, 20, 0.95);
          backdrop-filter: blur(10px);
          border-left: 1px solid rgba(255,255,255,0.1);
          display: flex;
          flex-direction: column;
          z-index: 2000;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          color: #e0e0e0;
          transition: transform 0.3s ease;
        }
        #ai-chat-panel.collapsed {
          transform: translateX(340px);
        }
        #ai-chat-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
          background: rgba(25, 25, 35, 0.9);
          flex-shrink: 0;
        }
        #ai-chat-header h3 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: #fff;
        }
        #ai-chat-toggle {
          background: none;
          border: none;
          color: #aaa;
          cursor: pointer;
          font-size: 18px;
          padding: 4px 8px;
          border-radius: 4px;
        }
        #ai-chat-toggle:hover { color: #fff; background: rgba(255,255,255,0.1); }

        #ai-chat-toggles {
          display: flex;
          gap: 6px;
          padding: 8px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          flex-shrink: 0;
          flex-wrap: wrap;
        }
        .ds-toggle {
          padding: 3px 8px;
          border-radius: 12px;
          font-size: 11px;
          cursor: pointer;
          border: 1px solid rgba(255,255,255,0.2);
          background: transparent;
          color: #999;
          transition: all 0.2s;
        }
        .ds-toggle.active {
          background: rgba(59, 130, 246, 0.3);
          border-color: #3b82f6;
          color: #93bbfc;
        }
        .ds-toggle:hover {
          border-color: rgba(255,255,255,0.4);
        }

        #ai-chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        #ai-chat-messages::-webkit-scrollbar { width: 6px; }
        #ai-chat-messages::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.15);
          border-radius: 3px;
        }

        .chat-msg {
          max-width: 95%;
          padding: 8px 12px;
          border-radius: 12px;
          line-height: 1.45;
          word-wrap: break-word;
          white-space: pre-wrap;
        }
        .chat-msg.user {
          align-self: flex-end;
          background: #2563eb;
          color: #fff;
          border-bottom-right-radius: 4px;
        }
        .chat-msg.assistant {
          align-self: flex-start;
          background: rgba(255,255,255,0.08);
          color: #e0e0e0;
          border-bottom-left-radius: 4px;
        }
        .chat-msg.tool-call {
          align-self: flex-start;
          background: rgba(16, 185, 129, 0.15);
          border: 1px solid rgba(16, 185, 129, 0.3);
          color: #6ee7b7;
          font-size: 11px;
          font-family: 'SF Mono', Menlo, monospace;
          padding: 6px 10px;
          border-radius: 8px;
        }
        .chat-msg.status {
          align-self: center;
          color: #888;
          font-size: 11px;
          font-style: italic;
          padding: 4px;
        }
        .chat-msg.error {
          align-self: flex-start;
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #fca5a5;
        }

        #ai-chat-status {
          padding: 6px 16px;
          font-size: 11px;
          color: #666;
          flex-shrink: 0;
          border-top: 1px solid rgba(255,255,255,0.05);
        }
        #ai-chat-status.active { color: #3b82f6; }

        #ai-chat-input-area {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid rgba(255,255,255,0.08);
          flex-shrink: 0;
          background: rgba(25, 25, 35, 0.9);
        }
        #ai-chat-input {
          flex: 1;
          padding: 8px 12px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.15);
          background: rgba(255,255,255,0.05);
          color: #fff;
          font-size: 13px;
          font-family: inherit;
          outline: none;
          resize: none;
        }
        #ai-chat-input:focus {
          border-color: #3b82f6;
        }
        #ai-chat-input::placeholder { color: #555; }
        #ai-chat-send {
          padding: 8px 16px;
          border-radius: 8px;
          border: none;
          background: #2563eb;
          color: #fff;
          font-weight: 600;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.2s;
          white-space: nowrap;
        }
        #ai-chat-send:hover { background: #1d4ed8; }
        #ai-chat-send:disabled {
          background: #333;
          color: #666;
          cursor: not-allowed;
        }
        #ai-chat-clear {
          padding: 8px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.1);
          background: transparent;
          color: #888;
          cursor: pointer;
          font-size: 12px;
        }
        #ai-chat-clear:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
        #ai-chat-stop {
          padding: 8px 16px;
          border-radius: 8px;
          border: none;
          background: #dc2626;
          color: #fff;
          font-weight: 600;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.2s;
          white-space: nowrap;
          display: none;
        }
        #ai-chat-stop:hover { background: #b91c1c; }
      </style>

      <div id="ai-chat-header">
        <h3>AI Robot Control</h3>
        <div style="display:flex; gap:4px;">
          <button id="ai-chat-clear" title="Clear history">Clear</button>
          <button id="ai-chat-toggle" title="Collapse">&raquo;</button>
        </div>
      </div>

      <div id="ai-chat-toggles">
        <button class="ds-toggle active" data-source="head_camera">Head Cam</button>
        <button class="ds-toggle active" data-source="orbit_camera">Orbit Cam</button>
        <button class="ds-toggle active" data-source="state_data">State Data</button>
      </div>

      <div id="ai-chat-messages"></div>

      <div id="ai-chat-status"></div>

      <div id="ai-chat-input-area">
        <textarea id="ai-chat-input" rows="1" placeholder="Tell the robot what to do..."></textarea>
        <button id="ai-chat-send">Send</button>
        <button id="ai-chat-stop">Stop</button>
      </div>
    `;

    document.body.appendChild(this.container);

    // Cache elements
    this.messagesEl = this.container.querySelector('#ai-chat-messages');
    this.inputEl = this.container.querySelector('#ai-chat-input');
    this.sendBtn = this.container.querySelector('#ai-chat-send');
    this.stopBtn = this.container.querySelector('#ai-chat-stop');
    this.statusEl = this.container.querySelector('#ai-chat-status');

    // Event: send message
    this.sendBtn.addEventListener('click', () => this._onSend());

    // Event: stop / interrupt AI
    this.stopBtn.addEventListener('click', () => this._onStop());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._onSend();
      }
    });

    // Event: toggle collapse
    this.container.querySelector('#ai-chat-toggle').addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.container.classList.toggle('collapsed', this.collapsed);
      this.container.querySelector('#ai-chat-toggle').textContent = this.collapsed ? '\u00ab' : '\u00bb';
    });

    // Event: clear history
    this.container.querySelector('#ai-chat-clear').addEventListener('click', () => {
      this._clearHistory();
    });

    // Event: data source toggles
    this.container.querySelectorAll('.ds-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const source = btn.dataset.source;
        this.dataSources[source] = !this.dataSources[source];
        btn.classList.toggle('active', this.dataSources[source]);
      });
    });

    // Auto-resize textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 80) + 'px';
    });

    // Stop keyboard events from reaching the simulation
    this.container.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    this.container.addEventListener('keyup', (e) => {
      e.stopPropagation();
    });
  }

  async _onSend() {
    const text = this.inputEl.value.trim();
    if (!text || this.sending) return;

    this.sending = true;
    this.sendBtn.style.display = 'none';
    this.stopBtn.style.display = 'block';
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    // Add user message
    this._addMessage('user', text);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          dataSources: this.dataSources
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Server error' }));
        this._addMessage('error', err.error || 'Server error');
        return;
      }

      // Read NDJSON stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const update = JSON.parse(line);

            switch (update.type) {
              case 'text':
                assistantText += update.text;
                break;
              case 'tool_call':
                this._addMessage('tool-call', `${update.name}(${JSON.stringify(update.input)})`);
                break;
              case 'status':
                this._setStatus(update.text);
                break;
              case 'error':
                this._addMessage('error', update.text);
                break;
              case 'aborted':
                this._addMessage('status', 'Interrupted by user');
                break;
              case 'done':
                // Final message
                break;
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
      }

      if (assistantText) {
        this._addMessage('assistant', assistantText);
      }

    } catch (err) {
      if (err.name !== 'AbortError') {
        this._addMessage('error', `Network error: ${err.message}`);
      }
    } finally {
      this.sending = false;
      this.sendBtn.style.display = 'block';
      this.stopBtn.style.display = 'none';
      this._setStatus('');
      this.inputEl.focus();
    }
  }

  async _onStop() {
    try {
      await fetch('/api/chat/abort', { method: 'POST' });
    } catch (e) {
      // Server might not be available
    }
    this._setStatus('Stopping...');
  }

  _addMessage(type, text) {
    const el = document.createElement('div');
    el.className = `chat-msg ${type}`;
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  _setStatus(text) {
    if (text) {
      this.statusEl.textContent = text;
      this.statusEl.className = 'active';
      this.statusEl.id = 'ai-chat-status';
    } else {
      this.statusEl.textContent = '';
      this.statusEl.className = '';
      this.statusEl.id = 'ai-chat-status';
    }
  }

  async _clearHistory() {
    this.messagesEl.innerHTML = '';
    try {
      await fetch('/api/chat/clear', { method: 'POST' });
    } catch (e) {
      // Server might not be available
    }
  }
}
