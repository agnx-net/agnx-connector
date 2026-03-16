import WebSocket from 'ws';

// ── WSS Protocol Types ──

export type WssTaskAssignment = {
  type: 'task.assign';
  taskId: string;
  objective: string;
  skillRequired: string | null;
  budget: number | null;
  inputPayload: Record<string, unknown> | null;
};

export type WssTaskResult = {
  type: 'task.result';
  taskId: string;
  success: boolean;
  resultData: Record<string, unknown> | null;
  error?: string;
};

export type WssAuthOk = {
  type: 'auth.ok';
  agentId: string;
  agentName: string;
};

export type WssAuthFail = {
  type: 'auth.fail';
  reason: string;
};

export type WssMessage = WssTaskAssignment | WssTaskResult | WssAuthOk | WssAuthFail;

// ── Types ──

export type SkillHandler = (
  task: WssTaskAssignment,
) => Promise<{ success: boolean; resultData?: Record<string, unknown>; error?: string }>;

export type ConnectorOptions = {
  gatewayUrl: string;
  apiToken: string;
  onSkill: SkillHandler;
  onConnect?: (agentId: string, agentName: string) => void;
  onDisconnect?: (reason: string) => void;
  onError?: (err: Error) => void;
};

// ── Constants ──

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const BACKOFF_FACTOR = 2;

// ── Connector ──

export class AgnxConnector {
  private ws: WebSocket | null = null;
  private options: ConnectorOptions;
  private retryCount = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private agentId: string | null = null;

  constructor(options: ConnectorOptions) {
    this.options = options;
  }

  start() {
    this.stopped = false;
    this.retryCount = 0;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'connector_stopped');
      this.ws = null;
    }
  }

  private connect() {
    if (this.stopped) return;

    const url = `${this.options.gatewayUrl}?token=${this.options.apiToken}`;
    console.log(`[agnx-connector] Connecting to ${this.options.gatewayUrl}...`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[agnx-connector] WebSocket connected, awaiting auth...');
    });

    ws.on('message', (raw) => {
      let msg: WssMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error('[agnx-connector] Invalid JSON received');
        return;
      }

      switch (msg.type) {
        case 'auth.ok':
          this.handleAuthOk(msg);
          break;
        case 'auth.fail':
          this.handleAuthFail(msg);
          break;
        case 'task.assign':
          void this.handleTaskAssignment(msg);
          break;
        default:
          break;
      }
    });

    ws.on('pong', () => {
      // Server sends ping, we auto-reply pong (ws lib handles this)
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || `code=${code}`;
      console.log(`[agnx-connector] Disconnected: ${reasonStr}`);
      this.ws = null;
      this.options.onDisconnect?.(reasonStr);

      // Don't retry if auth failed or intentionally stopped
      if (this.stopped || code === 4001) return;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[agnx-connector] Socket error:', err.message);
      this.options.onError?.(err);
    });
  }

  private handleAuthOk(msg: WssAuthOk) {
    this.retryCount = 0; // Reset backoff on successful auth
    this.agentId = msg.agentId;
    console.log(`[agnx-connector] ✓ Authenticated as "${msg.agentName}" (${msg.agentId.slice(0, 8)})`);
    this.options.onConnect?.(msg.agentId, msg.agentName);
  }

  private handleAuthFail(msg: WssAuthFail) {
    console.error(`[agnx-connector] ✗ Auth failed: ${msg.reason}`);
    this.stopped = true; // Don't retry on auth failure
  }

  private async handleTaskAssignment(task: WssTaskAssignment) {
    const tag = `[task:${task.taskId.slice(0, 8)}]`;
    console.log(`${tag} Received task: "${task.objective}"`);

    try {
      const result = await this.options.onSkill(task);

      const response: WssTaskResult = {
        type: 'task.result',
        taskId: task.taskId,
        success: result.success,
        resultData: result.resultData ?? null,
        error: result.error,
      };

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(response));
        console.log(`${tag} Result sent: ${result.success ? '✓ success' : '✗ failed'}`);
      } else {
        console.error(`${tag} Cannot send result: socket not open`);
      }
    } catch (err) {
      console.error(`${tag} Skill execution error:`, err);

      const response: WssTaskResult = {
        type: 'task.result',
        taskId: task.taskId,
        success: false,
        resultData: null,
        error: err instanceof Error ? err.message : 'unknown_skill_error',
      };

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(response));
      }
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;

    const delay = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, this.retryCount), MAX_DELAY_MS);
    this.retryCount++;
    console.log(`[agnx-connector] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.retryCount})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export default AgnxConnector;
