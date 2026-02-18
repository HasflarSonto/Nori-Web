/**
 * WebSocket Client for Browser <-> Server Communication
 *
 * Connects to the Node.js AI server and routes incoming
 * commands to the SimulationAPI.
 */

export class WebSocketClient {
  /**
   * @param {SimulationAPI} simApi - The simulation control API
   */
  constructor(simApi) {
    this.simApi = simApi;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectInterval = 3000;
  }

  /**
   * Connect to the WebSocket server.
   */
  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    console.log('WebSocketClient: Connecting to', url);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('WebSocketClient: Connected');
      this.connected = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'command') {
          // Execute the command via SimulationAPI
          let result;
          try {
            result = await this.simApi.executeCommand(msg.action, msg.params);
          } catch (err) {
            result = { error: err.message || String(err) };
          }

          // Send result back
          this.ws.send(JSON.stringify({
            type: 'command_result',
            id: msg.id,
            result
          }));
        }
      } catch (err) {
        console.error('WebSocketClient: Failed to handle message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocketClient: Disconnected');
      this.connected = false;
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('WebSocketClient: Error:', err);
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected) {
        console.log('WebSocketClient: Attempting reconnect...');
        this.connect();
      }
    }, this.reconnectInterval);
  }

  /**
   * Disconnect from the server.
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
