/**
 * 提供商配置的前端接口（docs/04 §2.2）：provider_overview / save / set_key / discover…
 *
 * 后端只认 pi 自己的文件（auth.json / models.json），前端**不做任何合并判断**：
 * "这个值是从哪儿来的"（目录默认 / models.json / 环境变量 / auth.json）由 Rust 算，
 * 界面只负责显示。这样同一份事实不会在两边各推一遍（两边各推一遍 = 迟早不一致）。
 */
import { cmd } from '@/lib/ipc';

/** 一行模型（界面拥有的字段；其余字段由后端按 id 合并保留）。 */
export interface ModelRow {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input?: string[] | null;
}

/** 值从哪来：models.json 覆盖目录，目录只是默认值。 */
export type ValueSource = 'models_json' | 'catalog' | 'none';
/** 密钥来源，顺序即 pi 的解析优先级（auth > models_json > env）。 */
export type KeySource = 'auth' | 'models_json' | 'env' | 'none' | 'typed';

export interface ProviderRow {
  provider: string;
  name: string;
  /** 是否是 pi 内置目录里的提供商（false = 用户自定义路由）。 */
  declared: boolean;
  baseUrl: string;
  baseUrlSource: ValueSource;
  api: string;
  apiSource: ValueSource;
  /** pi 为该提供商声明的协议（空 = 自定义，界面给全部选项）。 */
  apis: string[];
  envVar: string;
  keySource: KeySource;
  keyMasked: string | null;
  keyKind: string;
  /** models.json 里有内联密钥（明文）。它与 auth.json 同时存在时**不生效**。 */
  hasInlineKey: boolean;
  models: ModelRow[];
  /** pi 本地模型目录缓存（models-store.json）里有多少条。 */
  cachedModels: number;
  isDefault: boolean;
}

export interface CatalogRow {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  envVar: string;
  apis: string[];
}

export interface Overview {
  providers: ProviderRow[];
  catalog: CatalogRow[];
  apiOptions: string[];
  defaults: { provider: string; model: string };
  paths: { agent: string; auth: string; models: string; settings: string };
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean;
  input?: string[] | null;
}

export interface Discovery {
  /** catalog = 来自 pi 本地模型目录（没联网）；network = 真问了端点。 */
  source: 'catalog' | 'network';
  /** 真打的地址（catalog 时为空）。用户点"检测"要能看出测了什么。 */
  url: string;
  /** 这次用的是哪把密钥。 */
  keySource: KeySource;
  models: DiscoveredModel[];
}

/**
 * 拉一次总览（配置页只调这一个读接口）。
 *
 * **形状在这里收口**（docs/15 规则 28：IPC 返回值必须校验形状）：真机之外还有
 * 测试里的通配 mock、将来后端字段改名等情况，直接 `raw.providers.length` 会让
 * 整个设置页白屏。缺字段一律退化成空数组/空对象，界面自己会显示"没有提供商"。
 */
export async function loadOverview(): Promise<Overview> {
  const raw = await cmd<Partial<Overview> | null>('provider_overview');
  return {
    providers: Array.isArray(raw?.providers) ? raw.providers : [],
    catalog: Array.isArray(raw?.catalog) ? raw.catalog : [],
    apiOptions: Array.isArray(raw?.apiOptions) ? raw.apiOptions : [],
    defaults: raw?.defaults ?? { provider: '', model: '' },
    paths: raw?.paths ?? { agent: '', auth: '', models: '', settings: '' },
  };
}

/** 新建/更新一个提供商。patch 里空串 = 删键（回落 pi 目录默认值）。 */
export const saveProvider = (provider: string, patch: Record<string, unknown>) =>
  cmd<Record<string, unknown>>('provider_save', { provider, patch });

/**
 * 写 API 密钥。`store` 默认 auth（pi 的凭据库，优先级最高）；
 * `models` 写 models.json 的 apiKey（明文，中转站那类工具的习惯写法）。
 */
export const setProviderKey = (provider: string, apiKey: string, store: 'auth' | 'models' = 'auth') =>
  cmd<null>('provider_set_key', { provider, apiKey, store });

/** 删密钥：auth / models / both。 */
export const removeProviderKey = (provider: string, store: 'auth' | 'models' | 'both' = 'both') =>
  cmd<null>('provider_remove_key', { provider, store });

/** 删提供商（配置 + 凭据一起删，界面必须先确认）。 */
export const removeProvider = (provider: string) => cmd<null>('provider_remove', { provider });

/**
 * 「获取可用模型 / 检测」。`apiKey` 留空 = 用已存的密钥（auth.json → models.json → 环境变量），
 * 这样"检测"不必让用户把密钥再输一遍。
 */
export async function discoverModels(
  provider: string,
  baseUrl: string,
  api: string,
  apiKey?: string,
): Promise<Discovery> {
  const raw = await cmd<Partial<Discovery> | null>('provider_discover', {
    provider,
    baseUrl,
    api,
    // 必须显式送 null：Rust 侧 Option<String> 收到 undefined 会缺参数
    apiKey: apiKey && apiKey.trim() ? apiKey.trim() : null,
  });
  return {
    source: raw?.source === 'catalog' ? 'catalog' : 'network',
    url: typeof raw?.url === 'string' ? raw.url : '',
    keySource: (raw?.keySource ?? 'none') as KeySource,
    models: Array.isArray(raw?.models) ? raw.models : [],
  };
}

/** 密钥来源的中文说明（列表行与编辑器共用一份，避免两处文案打架）。 */
export function keySourceLabel(row: Pick<ProviderRow, 'keySource' | 'envVar' | 'keyKind'>): string {
  switch (row.keySource) {
    case 'auth':
      return 'auth.json';
    case 'models_json':
      return 'models.json（明文）';
    case 'env':
      return `环境变量 ${row.envVar}`;
    default:
      return '未配置';
  }
}

/** pi 的协议 id → 人话（取 DSH 的 protocol 文案，只翻 pi 认识的这几门）。 */
export const API_LABELS: Record<string, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'azure-openai-responses': 'Azure OpenAI Responses',
  'openai-codex-responses': 'OpenAI Codex Responses',
  'google-generative-ai': 'Google Generative AI',
  'google-vertex': 'Google Vertex AI',
  'bedrock-converse-stream': 'Amazon Bedrock',
  'mistral-conversations': 'Mistral',
  'pi-messages': 'pi messages',
};

export const apiLabel = (api: string) => API_LABELS[api] ?? api;
