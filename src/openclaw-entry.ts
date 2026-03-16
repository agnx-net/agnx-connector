/**
 * OpenClaw Plugin Entry — AgnX Connector
 *
 * Wraps AgnX as an OpenClaw Custom Extension.
 * Developers only need to set api_token and gateway_url in openclaw.json.
 * The plugin automatically establishes a persistent WSS connection,
 * receives tasks from the platform, and returns results via the local OpenClaw Agent.
 */

import { AgnxConnector, type SkillHandler, type WssTaskAssignment } from './index.js';

// ── OpenClaw Plugin API types (subset used by this plugin) ──

interface OpenClawPluginApi {
  runtime: {
    config: {
      loadConfig: () => Record<string, unknown>;
    };
    channel?: {
      reply?: {
        handleInboundMessage?: (params: {
          channel: string;
          accountId: string;
          senderId: string;
          chatType: string;
          chatId: string;
          text: string;
          reply: (text: string) => Promise<void>;
        }) => Promise<void>;
      };
    };
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
}

// ── Helpers ──

function resolveAgnxConfig(cfg: Record<string, unknown>): {
  token: string;
  gatewayUrl: string;
} | null {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const agnx = (channels['agnx-connector'] ?? channels.agnx ?? {}) as Record<string, unknown>;

  const token = (agnx.token as string) ?? process.env.AGNX_API_TOKEN;
  const gatewayUrl =
    (agnx.gatewayUrl as string) ??
    process.env.AGNX_GATEWAY_URL ??
    'ws://127.0.0.1:8080/ws';

  if (!token) return null;
  return { token, gatewayUrl };
}

// ── Plugin ──

let connectorInstance: AgnxConnector | null = null;

const plugin = {
  id: 'agnx-connector',
  name: 'AgnX Connector',
  description:
    'Connect to AgnX Platform via WSS. Receive tasks and execute them using local OpenClaw Agent capabilities.',

  register(api: OpenClawPluginApi) {
    const cfg = api.runtime.config.loadConfig();
    const agnxCfg = resolveAgnxConfig(cfg);

    if (!agnxCfg) {
      api.logger.warn(
        '[agnx] No AgnX token configured. Set channels.agnx.token in openclaw.json or AGNX_API_TOKEN env var.',
      );
      return;
    }

    api.logger.info(`[agnx] Connecting to AgnX gateway: ${agnxCfg.gatewayUrl}`);

    // Build skill handler: forward task to OpenClaw agent pipeline
    const onSkill: SkillHandler = async (task) => {
      api.logger.info(
        `[agnx] Received AgnX task: "${task.objective}" (skill: ${task.skillRequired ?? 'any'})`,
      );

      // If OpenClaw's message pipeline is available, use it
      if (api.runtime.channel?.reply?.handleInboundMessage) {
        return new Promise<{
          success: boolean;
          resultData?: Record<string, unknown>;
          error?: string;
        }>((resolve) => {
          void api.runtime.channel!.reply!.handleInboundMessage!({
            channel: 'agnx',
            accountId: 'default',
            senderId: 'agnx-platform',
            chatType: 'direct',
            chatId: `agnx-task-${task.taskId}`,
            text: buildTaskPrompt(task),
            reply: async (responseText: string) => {
              api.logger.info(`[agnx] Agent execution complete, result sent back`);
              resolve({
                success: true,
                resultData: {
                  agentResponse: responseText,
                  skill: task.skillRequired,
                  processedAt: new Date().toISOString(),
                },
              });
            },
          });

          // Timeout: 5 minutes max
          setTimeout(() => {
            resolve({
              success: false,
              error: 'agent_execution_timeout',
            });
          }, 5 * 60 * 1000);
        });
      }

      // Fallback: simple echo (for testing without full agent pipeline)
      api.logger.warn('[agnx] No OpenClaw message pipeline available, using echo fallback');
      return {
        success: true,
        resultData: {
          echo: true,
          objective: task.objective,
          skill: task.skillRequired,
          note: 'Processed by agnx-connector echo fallback',
          processedAt: new Date().toISOString(),
        },
      };
    };

    connectorInstance = new AgnxConnector({
      gatewayUrl: agnxCfg.gatewayUrl,
      apiToken: agnxCfg.token,
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
};

function buildTaskPrompt(task: {
  taskId: string;
  objective: string;
  skillRequired: string | null;
  budget: number | null;
}): string {
  const parts = [`[AgnX Task ${task.taskId.slice(0, 8)}]`];
  if (task.skillRequired) parts.push(`Skill: ${task.skillRequired}`);
  parts.push(`Objective: ${task.objective}`);
  if (task.budget) parts.push(`Budget: ${task.budget}`);
  return parts.join('\n');
}

export default plugin;
