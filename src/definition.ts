/**
 * World 定义：装配层只认这个对象（id、默认值、预检、配置页、工厂、自描述）。
 */
import type { WorldDefinition } from 'cortico/world.ts';
import type { EventDescribe, ToolDescribe } from 'cortico/core/types.ts';
import {
  AGENTWECHAT_DEFAULTS, AGENTWECHAT_ID, agentWechatConfigGroup, normalizeConfig, validateConfig,
  type AgentWechatConfigSection,
} from './config.ts';
import { AGENTWECHAT_EVENT_DESCRIPTIONS, AGENTWECHAT_TOOL_SUMMARIES } from './strings.ts';
import { AgentWechatWorld } from './world.ts';
import { TOOL_SCHEMAS } from './tools.ts';

const tools: ToolDescribe[] = TOOL_SCHEMAS.map((schema) => ({
  name: schema.name,
  description: schema.description,
  parameters: schema.parameters,
  tags: schema.tags,
  summary: AGENTWECHAT_TOOL_SUMMARIES[schema.name as keyof typeof AGENTWECHAT_TOOL_SUMMARIES],
}));

const events: EventDescribe[] = [
  { type: 'agentwechat.message', description: AGENTWECHAT_EVENT_DESCRIPTIONS.message, trigger: 'debounce' },
  { type: 'agentwechat.receipt', description: AGENTWECHAT_EVENT_DESCRIPTIONS.receipt },
  { type: 'agentwechat.status', description: AGENTWECHAT_EVENT_DESCRIPTIONS.status },
];

export const agentWechatDefinition: WorldDefinition<AgentWechatConfigSection> = {
  id: AGENTWECHAT_ID,
  label: 'NAS 微信',
  defaults: () => ({ ...AGENTWECHAT_DEFAULTS }),
  preflight(ctx) {
    const cfg = normalizeConfig(ctx.cfg);
    if (cfg.enabled) validateConfig(cfg);
  },
  configOptions: () => [],
  create: (ctx) => new AgentWechatWorld(ctx),
  describe: { tools, events },
};
