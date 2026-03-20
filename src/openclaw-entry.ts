/**
 * OpenClaw Plugin Entry — AgnX Connector
 *
 * Wraps AgnX as an OpenClaw Custom Extension.
 * Developers only need to set api_token and gateway_url in openclaw.json.
 * The plugin automatically establishes a persistent WSS connection,
 * receives tasks from the platform, and returns results via the local OpenClaw Agent.
 *
 * ⚠️ 稳定性说明：此文件依赖 OpenClaw 未公开的内部 API（channel.reply.*）。
 * 若 OpenClaw 升级导致 API 变更，此适配层可能需要同步更新。
 * 核心 SDK（AgnxConnector）不受影响。
 */

import { AgnxConnector, type SkillHandler, type WssTaskAssignment } from './index.js';

// ── OpenClaw Plugin API types (subset used by this plugin) ──

interface OpenClawPluginApi {
  runtime: Record<string, unknown> & {
    config: {
      loadConfig: () => Record<string, unknown>;
    };
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
}

// channel.reply sub-API — matches PluginRuntimeChannel['reply'] from OpenClaw source
// See: openclaw/src/plugins/runtime/types-channel.ts + types.adapters.ts
interface ReplyPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  isError?: boolean;
  isReasoning?: boolean;
  [key: string]: unknown;
}

interface DispatchInboundResult {
  queuedFinal: boolean;
  counts: { tool: number; block: number; final: number };
}

interface ChannelReplyApi {
  finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
  dispatchReplyWithBufferedBlockDispatcher: (params: {
    ctx: Record<string, unknown>;
    cfg: Record<string, unknown>;
    dispatcherOptions: {
      deliver: (payload: ReplyPayload, info: { kind: string }) => Promise<void>;
      onError?: (err: unknown, info: { kind: string }) => void;
      onSkip?: (payload: ReplyPayload, info: { kind: string; reason: string }) => void;
    };
    replyOptions?: Record<string, unknown>;
  }) => Promise<DispatchInboundResult>;
}

// ── Helpers ──

function resolveAgnxConfig(cfg: Record<string, unknown>): {
  token: string;
  gatewayUrl: string;
} | null {
  // Priority: plugins.entries config > channels config > env vars
  const plugins = (cfg.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  const entry = (entries['agnx-connector'] ?? {}) as Record<string, unknown>;
  const pluginCfg = (entry.config ?? {}) as Record<string, unknown>;

  // Also check channels.agnx-connector (alternative config location)
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const channelCfg = (channels['agnx-connector'] ?? {}) as Record<string, unknown>;

  const token =
    (pluginCfg.token as string) ??
    (channelCfg.token as string) ??
    process.env.AGNX_API_TOKEN;
  const gatewayUrl =
    (pluginCfg.gatewayUrl as string) ??
    (channelCfg.gatewayUrl as string) ??
    process.env.AGNX_GATEWAY_URL ??
    'wss://worker.agnx.net/ws';

  if (!token) return null;
  return { token, gatewayUrl };
}

// ── Plugin ──

// 模块级单例：OpenClaw 的 register/unregister 生命周期保证同一进程内只有一个插件实例，
// 单例模式可防止 register 被意外多次调用时重复建立 WebSocket 连接。
let connectorInstance: AgnxConnector | null = null;

const plugin = {
  id: 'agnx-connector',
  name: 'AgnX Connector',
  description:
    'Connect to AgnX Platform via WSS. Receive tasks and execute them using local OpenClaw Agent capabilities.',

  register(api: OpenClawPluginApi) {
    if (connectorInstance) {
      api.logger.info('[agnx] Already registered, skipping duplicate register()');
      return;
    }

    const cfg = api.runtime.config.loadConfig();
    const agnxCfg = resolveAgnxConfig(cfg);

    if (!agnxCfg) {
      api.logger.warn(
        '[agnx] No AgnX token configured. Set plugins.entries.agnx-connector.config.token in openclaw.json or AGNX_API_TOKEN env var.',
      );
      return;
    }

    api.logger.info(`[agnx] Connecting to AgnX gateway: ${agnxCfg.gatewayUrl}`);

    // ── 获取 channel.reply API（标准 Channel 消息注入方式） ──
    const rt = api.runtime as Record<string, unknown>;
    const channelObj = rt.channel as Record<string, unknown> | undefined;
    const replyApi = channelObj?.reply as unknown as ChannelReplyApi | undefined;
    const hasChannelReply = typeof replyApi?.finalizeInboundContext === 'function'
      && typeof replyApi?.dispatchReplyWithBufferedBlockDispatcher === 'function';

    api.logger.info(`[agnx] channel.reply API available: ${hasChannelReply}`);

    // Build skill handler: inject task as a standard MessageEvent via channel.reply
    const onSkill: SkillHandler = async (task) => {
      api.logger.info(
        `[agnx] Received AgnX task: "${task.objective}"${task.isTest ? ' (TEST)' : ''}`,
      );

      const messageText = task.prompt ?? buildTaskPrompt(task);

      // ── 路径 1: 标准 Channel 模式 — dispatchReplyWithBufferedBlockDispatcher ──
      if (hasChannelReply) {
        const sessionKey = `agent:main:agnx:task:${task.subTaskId.slice(0, 8)}`;
        const messageId = `agnx-${task.subTaskId}`;

        api.logger.info(`[agnx] Dispatching via channel.reply (session: ${sessionKey})`);

        try {
          // 1. 构建标准入站上下文（与 Telegram/Discord 等 Channel 相同模式）
          const ctx = replyApi!.finalizeInboundContext({
            Body: messageText,
            BodyForAgent: messageText,
            RawBody: messageText,
            CommandBody: messageText,
            From: 'agnx-platform',
            To: 'openclaw-agent',
            SessionKey: sessionKey,
            AccountId: 'default',
            ChatType: 'direct',
            SenderName: 'AgnX Platform',
            SenderId: 'agnx-platform',
            Provider: 'agnx',
            Surface: 'agnx',
            MessageSid: messageId,
            Timestamp: Date.now(),
            WasMentioned: true,
            CommandAuthorized: true,
            OriginatingChannel: 'agnx',
            OriginatingTo: 'openclaw-agent',
          });

          // 2. 用 dispatchReplyWithBufferedBlockDispatcher + deliver 回调捕获回复
          //    与 Telegram 内置通道完全相同的模式 (bot-message-dispatch.ts:540)
          const replyChunks: string[] = [];

          const dispatchResult = await replyApi!.dispatchReplyWithBufferedBlockDispatcher({
            ctx,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: ReplyPayload, info: { kind: string }) => {
                api.logger.info(`[agnx] deliver(kind=${info.kind}): text=${(payload.text ?? '').slice(0, 200)}, isError=${payload.isError}`);
                if (payload.text && payload.text.trim()) {
                  replyChunks.push(payload.text);
                }
              },
              onError: (err, info) => {
                api.logger.error(`[agnx] dispatch ${info.kind} error: ${String(err)}`);
              },
              onSkip: (_payload, info) => {
                api.logger.info(`[agnx] dispatch skip: kind=${info.kind}, reason=${info.reason}`);
              },
            },
          });

          api.logger.info(`[agnx] dispatch done: queuedFinal=${dispatchResult.queuedFinal}, counts=${JSON.stringify(dispatchResult.counts)}, captured=${replyChunks.length} chunks`);

          // 3. 提取 Agent 回复
          const agentResponse = replyChunks.join('\n').trim();

          if (agentResponse) {
            api.logger.info(`[agnx] Agent response captured (${agentResponse.length} chars)`);
            return {
              success: true,
              resultData: {
                agentResponse,
                processedAt: new Date().toISOString(),
              },
            };
          }

          api.logger.warn('[agnx] Agent dispatch completed but no reply text captured');
          return {
            success: true,
            resultData: {
              agentResponse: '[Agent processed task but produced no text output]',
              note: 'dispatch_no_reply',
              processedAt: new Date().toISOString(),
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          api.logger.error(`[agnx] channel.reply dispatch failed: ${msg}`);
          return {
            success: false,
            error: `dispatch_error: ${msg}`,
          };
        }
      }

      // ── 路径 2: Fallback — channel.reply 不可用时返回 echo ──
      // ⚠️ 这意味着本地 OpenClaw Agent 无法执行任务，结果不含真实内容。
      // 平台审计（PoW）默认会拒绝此类 echo 结果，除非在 app_config 中开启
      // audit.allow_echo_fallback=true（仅限测试阶段）。
      // 生产环境中请确认 channel.reply API 已正确暴露。
      api.logger.warn('[agnx] channel.reply API not available — falling back to echo. Task will likely be rejected by platform audit in production.');
      return {
        success: true,
        resultData: {
          echo: true,
          objective: task.objective,
          note: 'channel.reply not available; echo fallback used',
          processedAt: new Date().toISOString(),
        },
      };
    };

    connectorInstance = new AgnxConnector({
      gatewayUrl: agnxCfg.gatewayUrl,
      apiToken: agnxCfg.token,
      logger: api.logger,
      onSkill,
      onConnect: (agentId, agentName) => {
        api.logger.info(`[agnx] Connected to AgnX — Agent "${agentName}" (${agentId.slice(0, 8)})`);
      },
      onDisconnect: (reason) => {
        api.logger.warn(`[agnx] Disconnected from AgnX: ${reason}`);
      },
      onError: (err) => {
        api.logger.error(`[agnx] Socket error: ${err.message}`);
      },
    });

    connectorInstance.start();
  },

  unregister() {
    if (connectorInstance) {
      connectorInstance.stop();
      connectorInstance = null;
    }
  },
};

function buildTaskPrompt(task: WssTaskAssignment): string {
  const parts = [`[AgnX Task ${task.taskId.slice(0, 8)}]`];
  parts.push(`Objective: ${task.objective}`);
  if (task.inputParams) parts.push(`Input: ${JSON.stringify(task.inputParams)}`);
  if (task.outputSchema && Object.keys(task.outputSchema).length > 0) {
    parts.push(`Expected output schema: ${JSON.stringify(task.outputSchema)}`);
  }
  return parts.join('\n');
}

export default plugin;
