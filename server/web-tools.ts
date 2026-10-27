// LIVEUIAGENT web tool registry: keyless, GFW-safe public APIs the generated apps can
// call as real tools. 每个工具一条注册项 —— 新增能力 = 在 webToolRegistry 里加一个对象,
// 权限白名单 / 能力派生 / 预取执行 / grounding 目录与调度全部自动跟上(不再四处硬编码)。
//
// 可达性约束(2026-08 从腾讯云实测):cn.bing.com / open-meteo / frankfurter /
// api.github.com / exchangerate-api 可达;duckduckgo / wikipedia / searx 不可达,
// 禁止把它们加回来(会静默超时拖死整个 action 回合)。

type JsonRecord = Record<string, unknown>;

export type WebToolSpec = {
  id: string;              // capability/permission id, e.g. tool.web.search
  apiName: string;         // grounding-catalog name the agent calls, e.g. web_search
  label: string;
  purpose: string;         // shown to the orchestrator + grounding agent
  keywords: RegExp;        // prompt-time capability derivation
  argsHint: string;        // catalog args line, * marks required
  // 从整张 GUI 表单萃取本工具的调用参数(盲预取路径用);抛错 = 这次预取跳过。
  fromPayload(payload: JsonRecord): JsonRecord;
  invoke(args: JsonRecord): Promise<JsonRecord>;
};

function toolError(message: string, status = 502) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 拒绝私网/本机目标:web.fetch 的 URL 来自模型/用户,放行内网地址等于让服务器
// 替请求方探测自己所在的内网(SSRF)。只挡字面量;域名解析层面这台机上无内网服务面。
function assertPublicHttpUrl(url: string, label: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw toolError(`${label} requires a valid http(s) url`, 400); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw toolError(`${label} requires http(s)`, 400);
  if (parsed.username || parsed.password) throw toolError(`${label} refuses URL credentials`, 400);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::' || host.includes(':') || host.endsWith('.local') || host.endsWith('.localhost') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) {
    throw toolError(`${label} refuses private/loopback hosts`, 400);
  }
}

const MAX_FETCH_BYTES = 2_000_000; // 正文上限:防止一个大文件把内存和 stripHtml 的正则烧穿。

async function fetchText(url: string, label: string, timeoutMs = 12000, redirects = 0): Promise<string> {
  assertPublicHttpUrl(url, label);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7' },
    });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 3) throw toolError(`${label} redirect limit exceeded`);
      const nextUrl = new URL(location, url).href;
      assertPublicHttpUrl(nextUrl, label);
      return await fetchText(nextUrl, label, timeoutMs, redirects + 1);
    }
    let text = '';
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (bytes >= MAX_FETCH_BYTES) { await reader.cancel(); break; }
      }
    } else {
      text = await response.text();
      if (text.length > MAX_FETCH_BYTES) text = text.slice(0, MAX_FETCH_BYTES);
    }
    if (!response.ok) throw toolError(`${label} failed ${response.status}: ${text.slice(0, 200)}`);
    return text;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw toolError(`${label} timed out`, 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string, label: string, timeoutMs = 12000): Promise<any> {
  const text = await fetchText(url, label, timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    throw toolError(`${label} returned non-JSON: ${text.slice(0, 160)}`);
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&(?:nbsp|ensp|emsp|thinsp);/g, ' ')
    .replace(/&hellip;/g, '…').replace(/&middot;/g, '·')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => { try { return String.fromCodePoint(parseInt(code, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, code) => { try { return String.fromCodePoint(Number(code)); } catch { return ' '; } })
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(input: string, max: number): string {
  const text = input.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// 表单里所有非簿记字段拼成查询文本(与旧 queryTextFromPayload 同语义)。
export function payloadQueryText(payload: JsonRecord): string {
  return Object.entries(payload)
    .filter(([key]) => !['sourceComponentId', 'entityId', 'entityName', 'toolResults'].includes(key))
    .map(([, value]) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' ');
}

// 从表单值里挑最像地名的一个(权重:字段名 > 纯中文短词 > 纯英文短词)。
export function payloadLocationText(payload: JsonRecord): string {
  const candidates = Object.entries(payload)
    .filter(([key]) => !['sourceComponentId', 'entityId', 'entityName', 'toolResults'].includes(key))
    .map(([key, value]) => {
      const text = String(value ?? '').trim();
      const score = /city|location|地点|城市|地区|位置/i.test(key) ? 4
        : /^[一-龥]{2,8}$/.test(text) ? 3
        : /^[A-Za-z][A-Za-z\s-]{2,40}$/.test(text) ? 3
        : /[一-龥]{2,8}/.test(text) ? 2
        : /[A-Za-z][A-Za-z\s-]{2,40}/.test(text) ? 2
        : 0;
      return { text, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const location = candidates[0]?.text || '';
  if (!location) throw toolError('weather tool requires a city or location field', 400);
  return location;
}

async function bingSearch(query: string): Promise<JsonRecord> {
  const html = await fetchText(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=10`,
    'web search tool',
  );
  const items = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const results = items.map((item) => {
    const head = /<h2[^>]*>[\s\S]*?<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(item);
    if (!head) return null;
    const para = /<p[^>]*>([\s\S]*?)<\/p>/.exec(item);
    const title = stripHtml(head[2]);
    if (!title) return null;
    return {
      title: clip(title, 120),
      url: clip(head[1], 300),
      snippet: clip(para ? stripHtml(para[1]) : '', 220),
    };
  }).filter(Boolean).slice(0, 8) as JsonRecord[];
  if (!results.length) throw toolError(`web search returned no parseable results for: ${clip(query, 80)}`);
  return { query: clip(query, 200), results };
}

async function fetchPage(url: string): Promise<JsonRecord> {
  if (!/^https?:\/\//i.test(url)) throw toolError(`web fetch requires an http(s) url, got: ${clip(url, 80)}`, 400);
  const html = await fetchText(url, 'web fetch tool', 15000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return {
    url: clip(url, 300),
    title: clip(title ? stripHtml(title[1]) : '', 160),
    excerpt: clip(stripHtml(html), 2400),
  };
}

async function weatherQuery(location: string): Promise<JsonRecord> {
  const geo = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`,
    'weather geocoding tool',
  );
  const first = Array.isArray(geo.results) ? geo.results[0] : undefined;
  if (!first) throw toolError(`weather tool could not resolve location: ${location}`, 404);
  const forecast = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(String(first.latitude))}&longitude=${encodeURIComponent(String(first.longitude))}`
    + '&current=temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3',
    'weather forecast tool',
  );
  return {
    location: [first.name, first.admin1, first.country].filter(Boolean).join(', '),
    current: forecast.current,
    daily: forecast.daily,
  };
}

async function exchangeRate(args: { from: string; to: string; amount?: number }): Promise<JsonRecord> {
  const from = String(args.from || '').trim().toUpperCase();
  const to = String(args.to || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    throw toolError('exchange rate requires 3-letter currency codes, e.g. {"from":"USD","to":"CNY"}', 400);
  }
  const data = await fetchJson(
    `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`,
    'exchange rate tool',
  );
  const rate = Number(data?.rates?.[to]);
  if (!Number.isFinite(rate)) throw toolError(`exchange rate unavailable for ${from}→${to}`);
  const amount = Number.isFinite(Number(args.amount)) ? Number(args.amount) : null;
  return {
    from, to, rate, date: String(data?.date || ''),
    ...(amount !== null ? { amount, converted: Math.round(amount * rate * 100) / 100 } : {}),
  };
}

function requiredText(value: unknown, name: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim()) throw toolError(`${name} must be a nonempty string`, 400);
  if (value.length > max) throw toolError(`${name} exceeds ${max} characters`, 400);
  return value.trim();
}

async function githubSearch(query: string): Promise<JsonRecord> {
  const data = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(requiredText(query, 'query'))}&sort=updated&per_page=8`, 'GitHub repository search');
  if (!Array.isArray(data.items)) throw toolError('GitHub repository search returned no item array');
  return {source:'GitHub public repository API', fetchedAt:new Date().toISOString(), query,
    results:data.items.map((repo:any)=>({name:repo.full_name,url:repo.html_url,description:repo.description ?? '',stars:repo.stargazers_count,language:repo.language,updatedAt:repo.updated_at})).slice(0,8)};
}

async function arxivSearch(query: string): Promise<JsonRecord> {
  const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(requiredText(query, 'query'))}&start=0&max_results=8&sortBy=submittedDate&sortOrder=descending`, 'arXiv search', 15000);
  if (!/<feed[\s>]/.test(xml)) throw toolError('arXiv search returned no Atom feed');
  const field=(entry:string,tag:string)=>stripHtml(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(entry)?.[1] ?? '');
  const entries=xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return {source:'arXiv Atom API',fetchedAt:new Date().toISOString(),query,results:entries.slice(0,8).map(entry=>({title:field(entry,'title'),url:field(entry,'id'),published:field(entry,'published'),updated:field(entry,'updated'),summary:clip(field(entry,'summary'),1600),authors:(entry.match(/<author>[\s\S]*?<\/author>/g) ?? []).map(author=>field(author,'name'))}))};
}

export const webToolRegistry: WebToolSpec[] = [
  {
    id: 'tool.web.search',
    apiName: 'web_search',
    label: 'Web Search Tool',
    purpose: 'Search the live web (Bing) for current information: news, prices, facts, reviews, anything the workflow needs to know right now. Returns titles, urls and snippets.',
    keywords: /搜索|查询|查找|网页|新闻|资料|文献|价格|比价|评测|攻略|资讯|search|web|news|lookup|research|price/i,
    argsHint: 'query*',
    fromPayload: (payload) => {
      const query = clip(payloadQueryText(payload), 240);
      if (!query) throw toolError('web search tool requires query text', 400);
      return { query };
    },
    invoke: async (args) => bingSearch(String(args.query || '').trim()),
  },
  {
    id: 'tool.web.fetch',
    apiName: 'web_fetch',
    label: 'Web Page Fetch Tool',
    purpose: 'Fetch one web page by url and return its readable text excerpt. Use after web_search to read a promising result in depth.',
    // 故意窄:只有明确"读某个链接/网页"的需求才派生。宽词(文章/阅读/read/page)
    // 会命中一切阅读清单类应用,而那些表单里根本没有 URL,预取永远失败。
    keywords: /网页链接|打开链接|抓取|url|http|网址|链接内容|webpage|web page/i,
    argsHint: 'url*',
    fromPayload: (payload) => {
      const url = Object.values(payload).map((value) => String(value ?? '')).find((value) => /^https?:\/\//i.test(value.trim()));
      if (!url) throw toolError('web fetch tool requires a url field', 400);
      return { url: url.trim() };
    },
    invoke: async (args) => fetchPage(String(args.url || '').trim()),
  },
  {
    id: 'tool.github.search', apiName: 'github_search_repositories', label: 'GitHub Search Tool',
    purpose: 'Find actual public GitHub repositories by query. Returns repository names, canonical URLs, descriptions, stars, language and update dates. No private repositories or account writes.',
    keywords: /github|开源项目|开源工具|代码仓库|repository|repositories/i,
    argsHint: 'query* (GitHub repository search syntax)',
    fromPayload: payload => ({query:requiredText(payloadQueryText(payload),'query')}),
    invoke: args => githubSearch(requiredText(args.query,'query')),
  },
  {
    id: 'tool.arxiv.search', apiName: 'arxiv_search', label: 'arXiv Search Tool',
    purpose: 'Search actual arXiv papers using the public Atom API, newest submitted first. Returns title, authors, canonical URL, dates and abstract. Results do not certify publication, quality or novelty.',
    keywords: /arxiv|论文|文献|paper|preprint|research/i,
    argsHint: 'query* (arXiv search syntax, e.g. all:agent)',
    fromPayload: payload => ({query:requiredText(payloadQueryText(payload),'query')}),
    invoke: args => arxivSearch(requiredText(args.query,'query')),
  },
  {
    id: 'tool.weather.query',
    apiName: 'weather_query',
    label: 'Weather Tool',
    purpose: 'Query current weather and a 3-day forecast for a named city or place (Open-Meteo, no key).',
    keywords: /天气|气温|降雨|下雨|空气|预报|weather|forecast|temperature|rain/i,
    argsHint: 'location*',
    fromPayload: (payload) => ({ location: payloadLocationText(payload) }),
    invoke: async (args) => weatherQuery(String(args.location || '').trim()),
  },
  {
    id: 'tool.exchange.rate',
    apiName: 'exchange_rate',
    label: 'Exchange Rate Tool',
    purpose: 'Get the live exchange rate between two currencies (3-letter codes), optionally converting an amount.',
    keywords: /汇率|换汇|外币|currency|exchange rate|forex/i,
    argsHint: 'from*, to*, amount',
    fromPayload: (payload) => {
      // 只认真实 ISO 币种码(frankfurter 支持集),任意 [A-Z]{3} 会把 HOW/BUY/PAY 当币种。
      const KNOWN = new Set(['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'AUD', 'CAD', 'CHF', 'SGD', 'THB', 'INR', 'MYR', 'NZD', 'SEK', 'NOK', 'DKK', 'TRY', 'MXN', 'BRL', 'ZAR', 'PHP', 'IDR', 'ILS', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'ISK']);
      const text = payloadQueryText(payload).toUpperCase();
      const codes = (text.match(/\b[A-Z]{3}\b/g) ?? []).filter((code) => KNOWN.has(code));
      const unique = [...new Set(codes)];
      if (unique.length < 2) throw toolError('exchange rate tool requires two currency codes in the form fields', 400);
      const amount = Number((text.match(/\d+(?:\.\d+)?/) ?? [])[0]);
      return { from: unique[0], to: unique[1], ...(Number.isFinite(amount) ? { amount } : {}) };
    },
    invoke: async (args) => exchangeRate(args as { from: string; to: string; amount?: number }),
  },
];

export function findWebTool(capabilityId: string): WebToolSpec | undefined {
  return webToolRegistry.find((tool) => tool.id === capabilityId);
}

export function findWebToolByApiName(apiName: string): WebToolSpec | undefined {
  return webToolRegistry.find((tool) => tool.apiName === apiName);
}

// grounding 目录里的工具行,与 AppWorld API 行同一格式,agent 可在循环中直接调用。
export function webToolCatalogLines(tools: WebToolSpec[]): string[] {
  return tools.map((tool) => `- ${tool.apiName} [GET]: ${clip(tool.purpose, 140)} args(*=required): ${tool.argsHint}`);
}
