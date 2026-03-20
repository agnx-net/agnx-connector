import WebSocket from 'ws';

// ── WSS Protocol Types ──

export type WssTaskAssignment = {
  type: 'task.assign';
  taskId: string;
  subTaskId: string;
  objective: string;
  prompt?: string;
  isTest?: boolean;
  claimedQuantity: number;
  unitPrice: number;
  inputParams: Record<string, unknown> | null;
  outputSchema: Record<string, unknown>;
  timeoutAt: string;
};

export type WssTaskResult = {
  type: 'task.result';
  taskId: string;
  subTaskId: string;
  isTest?: boolean;
  success: boolean;
  resultData: Record<string, unknown> | null;
  validCount?: number;
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

/** Agent 收到任务后立刻回送给平台，表示消息已安全接收、即将执行 */
export type WssTaskAck = {
  type: 'task.ack';
  subTaskId: string;
};

/** 所有平台 ↔ Agent 双向协议消息的联合类型 */
export type WssMessage = WssTaskAssignment | WssTaskResult | WssAuthOk | WssAuthFail | WssTaskAck;

// ── Types ──

/**
 * 任务执行回调。接收平台下发的任务，返回执行结果。
 *
 * @param task - 平台下发的任务对象，包含目标描述、输入参数、期望输出结构等
 * @returns success: 是否成功；resultData: 结果数据；validCount: 有效条目数（批量任务用）；error: 失败原因
 */
export type SkillHandler = (
  task: WssTaskAssignment,
) => Promise<{ success: boolean; resultData?: Record<string, unknown>; validCount?: number; error?: string }>;

export interface ConnectorLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type ConnectorOptions = {
  /** AgnX 平台 WebSocket 网关地址，如 wss://worker.agnx.net/ws */
  gatewayUrl: string;
  /**
   * Agent API Token。
   * ⚠️ 安全提示：Token 当前通过 URL 查询参数传输（?token=xxx），会出现在服务端访问日志中。
   * 请勿在公共网络环境下使用敏感 Token，并定期轮换。
   */
  apiToken: string;
  /** 任务执行回调，开发者在此实现业务逻辑 */
  onSkill: SkillHandler;
  /** 鉴权成功并建立连接时触发 */
  onConnect?: (agentId: string, agentName: string) => void;
  /** 连接断开时触发（包含断开原因） */
  onDisconnect?: (reason: string) => void;
  /** WebSocket 发生错误时触发 */
  onError?: (err: Error) => void;
  /** 自定义日志实现，默认使用 console */
  logger?: ConnectorLogger;
  /** 客户端主动 ping 间隔（毫秒）。设为 0 禁用。默认: 30000 */
  pingIntervalMs?: number;
};

// ── Constants ──

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const BACKOFF_FACTOR = 2;
const DEFAULT_PING_INTERVAL_MS = 30_000;

// ── Connector ──

export class AgnxConnector {
  private ws: WebSocket | null = null;
  private options: ConnectorOptions;
  private retryCount = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private _agentId: string | null = null;
  private log: ConnectorLogger;

  /** 当前已认证的 Agent ID。未连接或认证前为 null。 */
  get agentId(): string | null { return this._agentId; }

  constructor(options: ConnectorOptions) {
    this.options = options;
    this.log = options.logger ?? console;
  }

  start() {
    this.stopped = false;
    this.retryCount = 0;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'connector_stopped');
      this.ws = null;
    }
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private connect() {
    if (this.stopped) return;

    const url = `${this.options.gatewayUrl}?token=${this.options.apiToken}`;
    this.log.info(`[agnx-connector] Connecting to ${this.options.gatewayUrl}...`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.log.info('[agnx-connector] WebSocket connected, awaiting auth...');
      this.startPing(ws);
    });

    ws.on('message', (raw) => {
      let msg: WssMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.log.error('[agnx-connector] Invalid JSON received');
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

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || `code=${code}`;
      this.log.info(`[agnx-connector] Disconnected: ${reasonStr}`);
      this.ws = null;
      this._agentId = null;
      this.clearTimers();
      this.options.onDisconnect?.(reasonStr);

      if (this.stopped || code === 4001) return;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log.error('[agnx-connector] Socket error:', err.message);
      this.options.onError?.(err);
    });
  }

  private startPing(ws: WebSocket) {
    const interval = this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    if (interval <= 0) return;
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, interval);
  }

  private handleAuthOk(msg: WssAuthOk) {
    this.retryCount = 0;
    this._agentId = msg.agentId;
    this.log.info(`[agnx-connector] ✓ Authenticated as "${msg.agentName}" (${msg.agentId.slice(0, 8)})`);
    this.options.onConnect?.(msg.agentId, msg.agentName);
  }

  private handleAuthFail(msg: WssAuthFail) {
    this.log.error(`[agnx-connector] ✗ Auth failed: ${msg.reason}`);
    this.stopped = true;
  }

  /** 向平台发送任务结果（统一出口，避免重复 send 逻辑） */
  private sendResult(result: WssTaskResult): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.log.error(`[task:${result.taskId.slice(0, 8)}] Cannot send result: socket not open`);
      return;
    }
    try {
      this.ws.send(JSON.stringify(result));
    } catch (err) {
      // JSON.stringify 失败（如循环引用）时降级发送错误结果
      this.log.error(`[task:${result.taskId.slice(0, 8)}] Failed to serialize result:`, err);
      this.ws.send(JSON.stringify({
        type: 'task.result',
        taskId: result.taskId,
        subTaskId: result.subTaskId,
        isTest: result.isTest,
        success: false,
        resultData: null,
        error: 'result_serialization_error',
      } satisfies WssTaskResult));
    }
  }

  private async handleTaskAssignment(task: WssTaskAssignment) {
    const tag = `[task:${task.taskId.slice(0, 8)}]`;
    this.log.info(`${tag} Received: "${task.objective}"${task.isTest ? ' (TEST)' : ''}`);

    // 立刻回送 ACK，告知服务端消息已安全接收（在执行任务之前）
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'task.ack', subTaskId: task.subTaskId } satisfies WssTaskAck));
    }

    const base = {
      type: 'task.result' as const,
      taskId: task.taskId,
      subTaskId: task.subTaskId,
      isTest: task.isTest,
    };

    try {
      const result = await this.options.onSkill(task);
      this.sendResult({ ...base, success: result.success, resultData: result.resultData ?? null, validCount: result.validCount, error: result.error });
      this.log.info(`${tag} Result sent: ${result.success ? '✓ success' : '✗ failed'}`);
    } catch (err) {
      this.log.error(`${tag} Skill execution error:`, err);
      this.sendResult({ ...base, success: false, resultData: null, error: err instanceof Error ? err.message : 'unknown_skill_error' });
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;

    const delay = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, this.retryCount), MAX_DELAY_MS);
    this.retryCount++;
    this.log.info(`[agnx-connector] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.retryCount})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export default AgnxConnector;
