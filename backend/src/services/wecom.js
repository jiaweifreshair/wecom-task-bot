const axios = require("axios");
const dns = require('dns');
const https = require('https');
const { logWithTrace, createTraceId } = require('../utils/logger');
require("dotenv").config();

// normalizeTextValue
// 是什么：文本标准化函数。
// 做什么：将任意输入转换为去首尾空白字符串，空值返回空串。
// 为什么：企业微信请求参数需稳定格式，避免空白或类型差异导致接口拒绝。
const normalizeTextValue = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

// DEFAULT_WECOM_HOST
// 是什么：企业微信 API 默认主机名常量。
// 做什么：定义企微服务请求域名默认值，支持通过环境变量覆盖。
// 为什么：统一主机配置来源，便于后续网络容灾策略复用。
const DEFAULT_WECOM_HOST = 'qyapi.weixin.qq.com';

// DEFAULT_WECOM_DNS_SERVERS
// 是什么：企业微信 DNS 解析备用服务器列表。
// 做什么：在系统 DNS 不稳定时为 resolver 提供可配置默认上游。
// 为什么：部分运行环境会出现系统解析失败，需提供显式 DNS 容灾路径。
const DEFAULT_WECOM_DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

// DEFAULT_WECOM_HTTP_TIMEOUT_MS
// 是什么：企微 HTTP 请求超时默认值。
// 做什么：统一 axios 请求超时时间，避免网络异常时无限等待。
// 为什么：联调与生产都需要可预期失败时间，提升可观测性与稳定性。
const DEFAULT_WECOM_HTTP_TIMEOUT_MS = 15000;

// USER_LIST_RETRY_ERRCODES
// 是什么：组织成员查询可回退错误码集合。
// 做什么：定义在 `user/list` 响应这些错误码时允许切换到下一套 Secret 重试。
// 为什么：通讯录 Secret 与应用 Secret 的权限或可信 IP 可能配置不一致，需要容错回退保障可用性。
const USER_LIST_RETRY_ERRCODES = new Set([60011, 60020, 48009]);

// OA_API_RETRY_ERRCODES
// 是什么：OA 接口可重试错误码集合。
// 做什么：定义在 OA 接口返回这些错误码时允许切换备用 Secret 重试。
// 为什么：当默认 Secret 被配置为通讯录助手时，OA 日程接口会返回 `48009`，需自动兜底。
const OA_API_RETRY_ERRCODES = new Set([48009]);

// parseCommaList
// 是什么：逗号分隔配置解析函数。
// 做什么：将字符串配置解析为去空白、去空值后的数组。
// 为什么：DNS 服务器与备用 IP 配置均依赖逗号串输入，需统一解析逻辑。
const parseCommaList = (rawValue) => {
  const normalized = normalizeTextValue(rawValue);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(',')
    .map((item) => normalizeTextValue(item))
    .filter(Boolean);
};

// normalizeTemplateCardButtons
// 是什么：模板卡片按钮选项标准化函数。
// 做什么：将 `buttons` 统一转换为 `{ id, text }` 结构并过滤无效项。
// 为什么：发送企微模板卡片前需要稳定按钮结构，避免字段缺失导致接口拒绝。
const normalizeTemplateCardButtons = (buttons = []) => {
  const sourceList = Array.isArray(buttons) ? buttons : [];
  return sourceList
    .map((item) => {
      const button = item && typeof item === 'object' ? item : {};
      const id = normalizeTextValue(button.id || button.key);
      const text = normalizeTextValue(button.text || button.name);
      if (!id || !text) {
        return null;
      }

      return {
        id,
        text,
      };
    })
    .filter(Boolean);
};

// normalizeTemplateCardButtonList
// 是什么：模板卡片直出按钮标准化函数。
// 做什么：将 `button_list` 统一转换为 `{ text, key, style }` 结构并校正样式值。
// 为什么：保证透传按钮配置满足企微接口格式，减少运行时兼容分支。
const normalizeTemplateCardButtonList = (buttonList = []) => {
  const sourceList = Array.isArray(buttonList) ? buttonList : [];
  return sourceList
    .map((item) => {
      const button = item && typeof item === 'object' ? item : {};
      const text = normalizeTextValue(button.text || button.name);
      const key = normalizeTextValue(button.key || button.id);
      if (!text || !key) {
        return null;
      }

      const parsedStyle = Number(button.style);
      const style = parsedStyle === 2 ? 2 : 1;

      return {
        text,
        key,
        style,
      };
    })
    .filter(Boolean);
};

// buildTemplateCardActionConfig
// 是什么：模板卡片动作区配置构建函数。
// 做什么：根据按钮数量自动选择 `button_selection` 或 `button_list`，并返回统一结构。
// 为什么：单按钮使用 `button_selection` 在企微侧会触发 `40016 invalid button size`，需按数量分流。
const buildTemplateCardActionConfig = (config = {}) => {
  const normalizedButtons = normalizeTemplateCardButtons(config.buttons);
  const explicitButtonList = normalizeTemplateCardButtonList(config.button_list);

  const buttonSelection =
    normalizedButtons.length >= 2
      ? {
          question_key: 'task_action',
          title: '请确认任务进度',
          option_list: normalizedButtons,
        }
      : null;

  const fallbackSingleButtonList =
    normalizedButtons.length === 1
      ? [
          {
            text: normalizedButtons[0].text,
            key: normalizedButtons[0].id,
            style: 1,
          },
        ]
      : [];

  const buttonList = explicitButtonList.length > 0 ? explicitButtonList : fallbackSingleButtonList;

  return {
    buttonSelection,
    buttonList,
  };
};

// sanitizeCreateSchedulePayload
// 是什么：创建日程请求体清洗函数。
// 做什么：复制 `schedule` 并移除 `organizer` 字段，返回符合接口规范的请求体。
// 为什么：`oa/schedule/add` 传入 `organizer` 在当前租户会触发 `48002`，需在服务层统一兜底。
const sanitizeCreateSchedulePayload = (schedule = {}) => {
  const normalizedSchedule = schedule && typeof schedule === 'object' ? { ...schedule } : {};
  delete normalizedSchedule.organizer;
  return {
    schedule: normalizedSchedule,
  };
};

// buildCreateCalendarPayload
// 是什么：创建日历请求体构建函数。
// 做什么：优先透传 `options.calendar`，缺失时回退到 `summary/color/description` 组合，并按需注入 agentid。
// 为什么：页面管理场景需要支持完整日历字段，而登录自动建历仍需兼容旧参数格式。
const buildCreateCalendarPayload = (options = {}, defaultAgentId = '') => {
  const hasCalendarObject =
    options && typeof options === 'object' && options.calendar && typeof options.calendar === 'object';
  const payload = {
    calendar: hasCalendarObject
      ? { ...options.calendar }
      : {
          summary: normalizeTextValue(options.summary),
          color: normalizeTextValue(options.color),
          description: normalizeTextValue(options.description),
        },
  };

  const rawAgentId =
    options && options.agentid !== undefined && options.agentid !== null ? options.agentid : defaultAgentId;
  const normalizedAgentId = Number(rawAgentId || 0);
  if (Number.isFinite(normalizedAgentId) && normalizedAgentId > 0) {
    payload.agentid = normalizedAgentId;
  }

  return payload;
};

// pickFirstIpv4Address
// 是什么：IPv4 地址提取函数。
// 做什么：从 `dns.lookup/resolve4` 返回结构中提取首个 IPv4 地址字符串。
// 为什么：不同 API 返回结构不一致，统一抽取可减少调用侧分支判断。
const pickFirstIpv4Address = (records = []) => {
  const list = Array.isArray(records) ? records : [];
  for (const item of list) {
    const address = normalizeTextValue(typeof item === 'string' ? item : item && item.address);
    if (address) {
      return address;
    }
  }

  return '';
};

// normalizeLookupOptions
// 是什么：dns.lookup 参数标准化函数。
// 做什么：兼容 number/object/undefined 的 lookup options 输入。
// 为什么：https.Agent 的 lookup 回调签名灵活，需先标准化再处理。
const normalizeLookupOptions = (rawOptions) => {
  if (typeof rawOptions === 'number') {
    return {
      family: rawOptions,
      hints: 0,
      all: false,
      verbatim: false,
    };
  }

  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  return {
    family: Number(options.family) || 0,
    hints: Number(options.hints) || 0,
    all: Boolean(options.all),
    verbatim: Boolean(options.verbatim),
  };
};

// createDnsResolver
// 是什么：自定义 DNS Resolver 构建函数。
// 做什么：按配置注入上游 DNS 服务器并返回 resolver 实例。
// 为什么：系统 DNS 不稳定时，需要可控解析器兜底企业微信域名解析。
const createDnsResolver = (dnsServers = []) => {
  const resolver = new dns.Resolver();
  const normalizedServers = (Array.isArray(dnsServers) ? dnsServers : [])
    .map((item) => normalizeTextValue(item))
    .filter(Boolean);

  if (normalizedServers.length > 0) {
    resolver.setServers(normalizedServers);
  }

  return resolver;
};

class WeComService {
  constructor() {
    this.corpId = process.env.CORP_ID;
    this.agentId = process.env.AGENT_ID;
    this.corpSecret = normalizeTextValue(process.env.CORP_SECRET);
    this.oaSecret =
      normalizeTextValue(process.env.WECOM_OA_SECRET) ||
      normalizeTextValue(process.env.WECOM_AGENT_SECRET) ||
      normalizeTextValue(process.env.WECOM_APP_SECRET);
    this.contactSecret = normalizeTextValue(process.env.WECOM_CONTACT_SECRET) || normalizeTextValue(process.env.CONTACT_SECRET);
    this.wecomHost = normalizeTextValue(process.env.WECOM_API_HOST) || DEFAULT_WECOM_HOST;
    this.fallbackIps = parseCommaList(process.env.WECOM_DNS_FALLBACK_IPS);
    this.dnsServers = (() => {
      const configuredServers = parseCommaList(process.env.WECOM_DNS_SERVERS);
      if (configuredServers.length > 0) {
        return configuredServers;
      }

      return DEFAULT_WECOM_DNS_SERVERS;
    })();
    this.dnsResolver = createDnsResolver(this.dnsServers);
    this.fallbackIpCursor = 0;
    this.httpTimeoutMs = (() => {
      const rawTimeout = Number(process.env.WECOM_HTTP_TIMEOUT_MS || DEFAULT_WECOM_HTTP_TIMEOUT_MS);
      if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
        return DEFAULT_WECOM_HTTP_TIMEOUT_MS;
      }

      return Math.floor(rawTimeout);
    })();
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      lookup: this.lookupWithFallback.bind(this),
    });
    this.accessToken = null;
    this.tokenExpires = 0;
    this.tokenCache = {};
    // contactSecretUserListDenied
    // 是什么：通讯录 Secret 成员查询熔断标记。
    // 做什么：当 `user/list` 明确返回 `48009` 后，当前进程后续成员查询不再尝试该 Secret。
    // 为什么：通讯录助手类凭证会稳定触发 `48009`，继续重试只会制造无效日志与额外延迟。
    this.contactSecretUserListDenied = false;
  }

  // buildUserListTokenCandidates
  // 是什么：组织成员查询 token 候选构建函数。
  // 做什么：根据当前熔断状态生成“通讯录 Secret -> 默认 Secret”候选列表。
  // 为什么：通讯录 Secret 可用时优先命中最小权限；不可用时应立即跳过，避免重复噪音。
  buildUserListTokenCandidates() {
    const candidates = [];
    const hasIndependentContactSecret =
      this.contactSecret &&
      normalizeTextValue(this.contactSecret) !== normalizeTextValue(this.corpSecret);

    if (hasIndependentContactSecret && !this.contactSecretUserListDenied) {
      candidates.push({
        source: 'contact',
        tokenOptions: { corpSecret: this.contactSecret, cacheKey: 'contact' },
      });
    }

    candidates.push({
      source: 'default',
      tokenOptions: { cacheKey: 'default' },
    });

    return candidates;
  }

  // markContactSecretUserListDenied
  // 是什么：通讯录 Secret 成员查询熔断记录函数。
  // 做什么：在 contact Secret 命中 `48009` 时标记当前进程跳过该 Secret，并清理旧 token 缓存。
  // 为什么：错误一旦被证实为能力不匹配，就不应在同一进程里重复尝试。
  markContactSecretUserListDenied(traceId, responseData = {}) {
    const errcode = Number(responseData && responseData.errcode);
    if (errcode !== 48009 || this.contactSecretUserListDenied) {
      return;
    }

    this.contactSecretUserListDenied = true;
    delete this.tokenCache.contact;

    logWithTrace(traceId, 'wecom-service', 'users.list.contact_secret.disabled', {
      errcode,
      errmsg: responseData && responseData.errmsg,
    });
  }

  // buildAxiosConfig
  // 是什么：企微 HTTP 请求配置构建函数。
  // 做什么：统一注入超时与 `httpsAgent`，确保请求共享同一网络容灾策略。
  // 为什么：分散配置易遗漏，统一入口可避免局部请求未应用容灾能力。
  buildAxiosConfig() {
    // disableEnvProxy
    // 是什么：环境代理禁用配置。
    // 做什么：通过 `proxy: false` 阻止 axios 继承 `ALL_PROXY/HTTPS_PROXY`。
    // 为什么：当前运行环境存在 `socks5://` 代理变量，会触发 follow-redirects 的 protocol mismatch。
    return {
      timeout: this.httpTimeoutMs,
      httpsAgent: this.httpsAgent,
      proxy: false,
    };
  }

  // requestGet
  // 是什么：企微 GET 请求包装函数。
  // 做什么：统一走 axios + 容灾网络配置发起 GET 请求。
  // 为什么：减少重复参数拼装，保证所有请求口径一致。
  async requestGet(url) {
    return axios.get(url, this.buildAxiosConfig());
  }

  // requestPost
  // 是什么：企微 POST 请求包装函数。
  // 做什么：统一走 axios + 容灾网络配置发起 POST 请求。
  // 为什么：后续新增接口可直接复用，避免遗漏容灾配置。
  async requestPost(url, payload) {
    return axios.post(url, payload, this.buildAxiosConfig());
  }

  // buildOaTokenCandidates
  // 是什么：OA 接口 token 候选构建函数。
  // 做什么：按“默认 Secret -> 显式 OA Secret -> 通讯录 Secret(兜底)”顺序生成候选列表。
  // 为什么：现场配置可能把 `CORP_SECRET` 误配成通讯录助手，需为日程接口提供可恢复路径。
  buildOaTokenCandidates() {
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (source, tokenOptions = {}) => {
      const corpSecret = normalizeTextValue(tokenOptions.corpSecret) || this.corpSecret;
      const cacheKey = normalizeTextValue(tokenOptions.cacheKey) || 'default';
      const dedupeKey = `${cacheKey}:${corpSecret}`;
      if (!corpSecret || seen.has(dedupeKey)) {
        return;
      }

      seen.add(dedupeKey);
      candidates.push({
        source,
        tokenOptions: {
          corpSecret,
          cacheKey,
        },
      });
    };

    pushCandidate('default', { corpSecret: this.corpSecret, cacheKey: 'default' });
    pushCandidate('oa_explicit', { corpSecret: this.oaSecret, cacheKey: 'oa_explicit' });
    pushCandidate('contact_fallback', { corpSecret: this.contactSecret, cacheKey: 'contact_fallback' });

    return candidates;
  }

  // requestOaPostWithTokenFallback
  // 是什么：OA POST 接口自动重试函数。
  // 做什么：使用候选 Secret 顺序请求 OA 接口，遇到 `48009` 自动切换下一候选重试。
  // 为什么：避免因 Secret 配置混用导致“创建/更新日程”直接失败，提升线上可用性。
  async requestOaPostWithTokenFallback(endpoint, payload, traceId) {
    const tokenCandidates = this.buildOaTokenCandidates();
    let lastResponseData = null;
    let lastError = null;

    for (let index = 0; index < tokenCandidates.length; index += 1) {
      const candidate = tokenCandidates[index];
      const isLastCandidate = index === tokenCandidates.length - 1;

      try {
        const token = await this.getAccessToken(candidate.tokenOptions);
        const url = `https://qyapi.weixin.qq.com/cgi-bin/${endpoint}?access_token=${token}`;
        const response = await this.requestPost(url, payload);
        const responseData = (response && response.data) || {};
        const errcode = Number(responseData.errcode);
        lastResponseData = responseData;

        if (errcode === 0 || isLastCandidate || !OA_API_RETRY_ERRCODES.has(errcode)) {
          return responseData;
        }

        logWithTrace(traceId, 'wecom-service', 'oa.request.retry.next_secret', {
          endpoint,
          currentTokenSource: candidate.source,
          nextTokenSource: tokenCandidates[index + 1] && tokenCandidates[index + 1].source,
          errcode,
          errmsg: responseData.errmsg,
        });
      } catch (error) {
        lastError = error;
        if (isLastCandidate) {
          break;
        }

        logWithTrace(traceId, 'wecom-service', 'oa.request.retry.next_secret', {
          endpoint,
          currentTokenSource: candidate.source,
          nextTokenSource: tokenCandidates[index + 1] && tokenCandidates[index + 1].source,
          reason: 'request_exception',
          message: error.message,
        });
      }
    }

    if (lastResponseData) {
      return lastResponseData;
    }

    throw lastError || new Error(`OA 请求失败：${endpoint}`);
  }

  // pickNextFallbackIp
  // 是什么：备用 IP 轮询选择函数。
  // 做什么：从配置的 `WECOM_DNS_FALLBACK_IPS` 中轮询返回下一可用 IP。
  // 为什么：单一备用 IP 可能失效，轮询可降低单点风险。
  pickNextFallbackIp() {
    if (!Array.isArray(this.fallbackIps) || this.fallbackIps.length === 0) {
      return '';
    }

    const pickedIndex = this.fallbackIpCursor % this.fallbackIps.length;
    const pickedIp = normalizeTextValue(this.fallbackIps[pickedIndex]);
    this.fallbackIpCursor = (this.fallbackIpCursor + 1) % this.fallbackIps.length;
    return pickedIp;
  }

  // resolveViaSystemLookup
  // 是什么：系统 DNS 解析函数。
  // 做什么：调用 `dns.lookup` 获取目标主机 IPv4 地址。
  // 为什么：优先复用系统解析，兼容宿主机既有网络策略。
  async resolveViaSystemLookup(hostname) {
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, { family: 4, all: true }, (error, addresses) => {
        if (error) {
          reject(error);
          return;
        }

        const resolved = pickFirstIpv4Address(addresses);
        if (!resolved) {
          reject(new Error(`dns.lookup 未返回 IPv4 地址: ${hostname}`));
          return;
        }

        resolve(resolved);
      });
    });
  }

  // resolveViaCustomResolver
  // 是什么：自定义 DNS 解析函数。
  // 做什么：通过 `dns.Resolver` + 配置上游 DNS 获取目标主机 IPv4 地址。
  // 为什么：当系统 DNS 异常时提供第二解析通道，提升可用性。
  async resolveViaCustomResolver(hostname) {
    return new Promise((resolve, reject) => {
      this.dnsResolver.resolve4(hostname, (error, addresses) => {
        if (error) {
          reject(error);
          return;
        }

        const resolved = pickFirstIpv4Address(addresses);
        if (!resolved) {
          reject(new Error(`resolver.resolve4 未返回 IPv4 地址: ${hostname}`));
          return;
        }

        resolve(resolved);
      });
    });
  }

  // resolveWecomHostAddress
  // 是什么：企业微信主机地址解析函数。
  // 做什么：按“系统 DNS -> 自定义 DNS -> 配置备用 IP”顺序解析目标地址。
  // 为什么：在 DNS 异常环境下提供多级降级路径，降低 `ENOTFOUND` 概率。
  async resolveWecomHostAddress(hostname) {
    const traceId = createTraceId();
    const normalizedHostname = normalizeTextValue(hostname);

    try {
      return await this.resolveViaSystemLookup(normalizedHostname);
    } catch (systemError) {
      logWithTrace(traceId, 'wecom-service', 'dns.lookup.system_error', {
        hostname: normalizedHostname,
        message: systemError.message,
      });
    }

    try {
      const resolvedByCustomResolver = await this.resolveViaCustomResolver(normalizedHostname);
      logWithTrace(traceId, 'wecom-service', 'dns.lookup.custom_resolver_hit', {
        hostname: normalizedHostname,
        address: resolvedByCustomResolver,
        dnsServers: this.dnsServers,
      });
      return resolvedByCustomResolver;
    } catch (resolverError) {
      logWithTrace(traceId, 'wecom-service', 'dns.lookup.custom_resolver_error', {
        hostname: normalizedHostname,
        message: resolverError.message,
        dnsServers: this.dnsServers,
      });
    }

    const fallbackIp = this.pickNextFallbackIp();
    if (fallbackIp) {
      logWithTrace(traceId, 'wecom-service', 'dns.lookup.fallback_ip_hit', {
        hostname: normalizedHostname,
        fallbackIp,
      });
      return fallbackIp;
    }

    throw new Error(`企业微信域名解析失败: ${normalizedHostname}`);
  }

  // lookupWithFallback
  // 是什么：https.Agent 自定义 lookup 函数。
  // 做什么：仅对企微域名注入多级 DNS 容灾，其他域名回退系统默认解析。
  // 为什么：精确控制容灾范围，避免影响非企微域名请求行为。
  lookupWithFallback(hostname, rawOptions, callback) {
    const options = normalizeLookupOptions(rawOptions);
    const normalizedHostname = normalizeTextValue(hostname);

    if (normalizedHostname !== this.wecomHost) {
      dns.lookup(normalizedHostname, options, callback);
      return;
    }

    this.resolveWecomHostAddress(normalizedHostname)
      .then((address) => {
        if (options.all) {
          callback(null, [{ address, family: 4 }]);
          return;
        }

        callback(null, address, 4);
      })
      .catch((error) => {
        callback(error);
      });
  }

  /**
   * Get or Refresh Access Token
   */
  async getAccessToken(options = {}) {
    const traceId = createTraceId();
    const corpSecret = normalizeTextValue(options.corpSecret) || this.corpSecret;
    const cacheKey = normalizeTextValue(options.cacheKey) || 'default';
    const now = Date.now();
    const cachedToken = this.tokenCache[cacheKey];

    if (cachedToken && cachedToken.accessToken && now < cachedToken.tokenExpires) {
      logWithTrace(traceId, 'wecom-service', 'access_token.cache.hit', {
        cacheKey,
        expiresAt: cachedToken.tokenExpires
      });
      return cachedToken.accessToken;
    }

    try {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${corpSecret}`;
      logWithTrace(traceId, 'wecom-service', 'access_token.fetch.start', {
        endpoint: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
        cacheKey,
        hasCorpId: Boolean(this.corpId),
        hasCorpSecret: Boolean(corpSecret),
      });
      const response = await this.requestGet(url);

      if (response.data.errcode === 0) {
        const tokenExpires = now + (response.data.expires_in - 300) * 1000;
        this.tokenCache[cacheKey] = {
          accessToken: response.data.access_token,
          tokenExpires,
        };
        // 为兼容历史读取字段，默认 token 同步回旧字段。
        if (cacheKey === 'default') {
          this.accessToken = response.data.access_token;
          this.tokenExpires = tokenExpires;
        }
        logWithTrace(traceId, 'wecom-service', 'access_token.fetch.success', {
          cacheKey,
          expiresIn: response.data.expires_in,
          tokenExpiresAt: tokenExpires
        });
        return response.data.access_token;
      } else {
        logWithTrace(traceId, 'wecom-service', 'access_token.fetch.reject', {
          cacheKey,
          errcode: response.data.errcode,
          errmsg: response.data.errmsg
        });
        throw new Error(`WeCom Token Error: ${response.data.errmsg}`);
      }
    } catch (error) {
      logWithTrace(traceId, 'wecom-service', 'access_token.fetch.error', {
        message: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Get Schedule Details
   * @param {string} scheduleId
   */
  async getSchedule(scheduleId) {
    const traceId = createTraceId();
    logWithTrace(traceId, 'wecom-service', 'schedule.get.start', {
      scheduleId
    });
    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/get', {
      schedule_id_list: [scheduleId],
    }, traceId);
    const scheduleList = Array.isArray(responseData && responseData.schedule_list)
      ? responseData.schedule_list
      : [];
    logWithTrace(traceId, 'wecom-service', 'schedule.get.success', {
      scheduleId,
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg
    });
    return {
      ...(responseData || {}),
      schedule_list: scheduleList,
      schedule: scheduleList[0] || null,
    };
  }

  // getSchedules
  // 是什么：企业微信日程详情批量查询函数。
  // 做什么：通过 `schedule_id_list` 批量拉取日程详情并返回标准化 `schedule_list`。
  // 为什么：管理页和 API 网关都需要一次查询多条日程，避免逐条请求导致性能浪费。
  async getSchedules(scheduleIdList = []) {
    const traceId = createTraceId();
    const normalizedScheduleIdList = (Array.isArray(scheduleIdList) ? scheduleIdList : [scheduleIdList])
      .map((item) => normalizeTextValue(item))
      .filter(Boolean);

    if (normalizedScheduleIdList.length === 0) {
      return {
        errcode: 0,
        errmsg: 'ok',
        schedule_list: [],
      };
    }

    logWithTrace(traceId, 'wecom-service', 'schedule.get.batch.start', {
      scheduleCount: normalizedScheduleIdList.length,
    });
    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/get', {
      schedule_id_list: normalizedScheduleIdList,
    }, traceId);
    const scheduleList = Array.isArray(responseData && responseData.schedule_list)
      ? responseData.schedule_list
      : [];

    logWithTrace(traceId, 'wecom-service', 'schedule.get.batch.success', {
      scheduleCount: normalizedScheduleIdList.length,
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
      resultCount: scheduleList.length,
    });

    return {
      ...(responseData || {}),
      schedule_list: scheduleList,
    };
  }

  /**
   * Get Schedule List for a calendar
   */
  async getScheduleList(calId, offset = 0, limit = 500) {
    const traceId = createTraceId();
    logWithTrace(traceId, 'wecom-service', 'schedule.list.start', {
      calId,
      offset,
      limit
    });
    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/get_by_calendar', {
      cal_id: calId,
      offset: offset,
      limit: limit,
    }, traceId);
    logWithTrace(traceId, 'wecom-service', 'schedule.list.success', {
      calId,
      errcode: responseData && responseData.errcode,
      scheduleCount: (responseData && responseData.schedule_list && responseData.schedule_list.length) || 0
    });
    return responseData;
  }

  // getCalendarByIds
  // 是什么：企业微信日历详情批量查询函数。
  // 做什么：通过 `cal_id_list` 拉取指定日历的详情信息。
  // 为什么：登录建历需要验证历史映射是否仍然可用，避免使用失效 cal_id。
  async getCalendarByIds(calIdList = []) {
    const traceId = createTraceId();
    const normalizedCalIdList = (Array.isArray(calIdList) ? calIdList : [])
      .map((item) => normalizeTextValue(item))
      .filter(Boolean);

    logWithTrace(traceId, 'wecom-service', 'calendar.list.start', {
      calIdCount: normalizedCalIdList.length,
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/calendar/get', {
      cal_id_list: normalizedCalIdList,
    }, traceId);

    logWithTrace(traceId, 'wecom-service', 'calendar.list.success', {
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
      calendarCount:
        (responseData && responseData.calendar_list && responseData.calendar_list.length) || 0,
    });
    return responseData;
  }

  // createCalendar
  // 是什么：企业微信日历创建函数。
  // 做什么：调用 `oa/calendar/add` 创建日历并返回 `cal_id`。
  // 为什么：首次登录账号需要自动建立可同步日历，减少人工配置成本。
  async createCalendar(options = {}) {
    const traceId = createTraceId();
    const body = buildCreateCalendarPayload(options, this.agentId);
    const summary = normalizeTextValue(body && body.calendar && body.calendar.summary);
    const color = normalizeTextValue(body && body.calendar && body.calendar.color);
    const description = normalizeTextValue(body && body.calendar && body.calendar.description);

    logWithTrace(traceId, 'wecom-service', 'calendar.create.start', {
      hasSummary: Boolean(summary),
      color,
      hasDescription: Boolean(description),
      hasAgentId: Boolean(body.agentid),
      adminCount: Array.isArray(body && body.calendar && body.calendar.admins)
        ? body.calendar.admins.length
        : 0,
      shareCount: Array.isArray(body && body.calendar && body.calendar.shares)
        ? body.calendar.shares.length
        : 0,
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/calendar/add', body, traceId);
    logWithTrace(traceId, 'wecom-service', 'calendar.create.success', {
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
      calId: responseData && responseData.cal_id,
    });

    return responseData;
  }

  // updateCalendar
  // 是什么：企业微信日历更新函数。
  // 做什么：调用 `oa/calendar/update` 覆盖更新指定日历，支持 `skip_public_range` 可选参数。
  // 为什么：日历维护页面需要完整编辑能力，必须与官方“覆盖更新”语义保持一致。
  async updateCalendar(calendar = {}, options = {}) {
    const traceId = createTraceId();
    const payload = {
      calendar: calendar && typeof calendar === 'object' ? { ...calendar } : {},
    };
    const skipPublicRange = options && options.skip_public_range;
    if (skipPublicRange !== undefined && skipPublicRange !== null) {
      payload.skip_public_range = skipPublicRange;
    }

    logWithTrace(traceId, 'wecom-service', 'calendar.update.start', {
      calId: payload.calendar && payload.calendar.cal_id,
      hasSummary: Boolean(payload.calendar && payload.calendar.summary),
      skipPublicRange: payload.skip_public_range,
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/calendar/update', payload, traceId);
    logWithTrace(traceId, 'wecom-service', 'calendar.update.success', {
      calId: payload.calendar && payload.calendar.cal_id,
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
    });
    return responseData;
  }

  // deleteCalendar
  // 是什么：企业微信日历删除函数。
  // 做什么：调用 `oa/calendar/del` 删除指定 `cal_id` 日历。
  // 为什么：页面管理闭环需要支持无效日历清理与重建流程。
  async deleteCalendar(calId) {
    const traceId = createTraceId();
    const normalizedCalId = normalizeTextValue(calId);
    if (!normalizedCalId) {
      throw new Error('cal_id 不能为空');
    }

    const payload = {
      cal_id: normalizedCalId,
    };

    logWithTrace(traceId, 'wecom-service', 'calendar.delete.start', {
      calId: normalizedCalId,
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/calendar/del', payload, traceId);
    logWithTrace(traceId, 'wecom-service', 'calendar.delete.success', {
      calId: normalizedCalId,
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
    });
    return responseData;
  }

  // createSchedule
  // 是什么：企业微信日程创建函数。
  // 做什么：调用 `oa/schedule/add` 在指定日历创建日程并返回接口结果。
  // 为什么：手动创建任务需要与企微日历建立可回查的 `schedule_id` 关联。
  async createSchedule(schedule = {}) {
    const traceId = createTraceId();
    const payload = sanitizeCreateSchedulePayload(schedule);

    logWithTrace(traceId, 'wecom-service', 'schedule.create.start', {
      organizer: schedule && schedule.organizer,
      calId: schedule && schedule.cal_id,
      hasAttendees: Boolean(schedule && Array.isArray(schedule.attendees) && schedule.attendees.length > 0),
      hasSummary: Boolean(schedule && schedule.summary),
      organizerStripped: Boolean(schedule && schedule.organizer),
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/add', payload, traceId);

    logWithTrace(traceId, 'wecom-service', 'schedule.create.success', {
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
      scheduleId: responseData && responseData.schedule_id,
    });

    return responseData;
  }

  // updateSchedule
  // 是什么：企业微信日程更新函数。
  // 做什么：调用 `oa/schedule/update` 覆盖更新指定日程，并支持重复日程相关可选参数。
  // 为什么：官方接口更新语义为覆盖式，需显式透传 `skip_attendees/op_mode/op_start_time` 以适配真实场景。
  async updateSchedule(schedule = {}, options = {}) {
    const traceId = createTraceId();
    const payload = {
      schedule,
    };
    const skipAttendees = options && options.skip_attendees;
    const opMode = options && options.op_mode;
    const opStartTime = options && options.op_start_time;

    if (skipAttendees !== undefined && skipAttendees !== null) {
      payload.skip_attendees = skipAttendees;
    }
    if (opMode !== undefined && opMode !== null) {
      payload.op_mode = opMode;
    }
    if (opStartTime !== undefined && opStartTime !== null) {
      payload.op_start_time = opStartTime;
    }

    logWithTrace(traceId, 'wecom-service', 'schedule.update.start', {
      scheduleId: schedule && schedule.schedule_id,
      hasSummary: Boolean(schedule && schedule.summary),
      skipAttendees: payload.skip_attendees,
      opMode: payload.op_mode,
      hasOpStartTime: Boolean(payload.op_start_time),
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/update', payload, traceId);
    logWithTrace(traceId, 'wecom-service', 'schedule.update.success', {
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
      scheduleId: responseData && responseData.schedule_id,
    });

    return responseData;
  }

  // cancelSchedule
  // 是什么：企业微信日程取消函数。
  // 做什么：调用 `oa/schedule/del` 取消指定日程，并支持重复日程操作模式参数。
  // 为什么：官方取消接口路径为 `del` 而非 `cancel`，需统一封装避免业务侧误用。
  async cancelSchedule(scheduleId, options = {}) {
    const traceId = createTraceId();
    const normalizedScheduleId = normalizeTextValue(scheduleId);
    if (!normalizedScheduleId) {
      throw new Error('schedule_id 不能为空');
    }

    const payload = {
      schedule_id: normalizedScheduleId,
    };
    const opMode = options && options.op_mode;
    const opStartTime = options && options.op_start_time;

    if (opMode !== undefined && opMode !== null) {
      payload.op_mode = opMode;
    }
    if (opStartTime !== undefined && opStartTime !== null) {
      payload.op_start_time = opStartTime;
    }

    logWithTrace(traceId, 'wecom-service', 'schedule.cancel.start', {
      scheduleId: normalizedScheduleId,
      opMode: payload.op_mode,
      hasOpStartTime: Boolean(payload.op_start_time),
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/del', payload, traceId);
    logWithTrace(traceId, 'wecom-service', 'schedule.cancel.success', {
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
      scheduleId: normalizedScheduleId,
    });

    return responseData;
  }

  // addScheduleAttendees
  // 是什么：日程参与人增量添加函数。
  // 做什么：调用 `oa/schedule/add_attendees` 将成员追加到现有日程。
  // 为什么：文档要求该接口走增量模式，避免覆盖式更新参与人列表。
  async addScheduleAttendees(scheduleId, attendees = []) {
    const traceId = createTraceId();
    const normalizedScheduleId = normalizeTextValue(scheduleId);
    if (!normalizedScheduleId) {
      throw new Error('schedule_id 不能为空');
    }

    const payload = {
      schedule_id: normalizedScheduleId,
      attendees: Array.isArray(attendees) ? attendees : [],
    };

    logWithTrace(traceId, 'wecom-service', 'schedule.attendees.add.start', {
      scheduleId: normalizedScheduleId,
      attendeeCount: payload.attendees.length,
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/add_attendees', payload, traceId);
    logWithTrace(traceId, 'wecom-service', 'schedule.attendees.add.success', {
      scheduleId: normalizedScheduleId,
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
    });

    return responseData;
  }

  // removeScheduleAttendees
  // 是什么：日程参与人增量删除函数。
  // 做什么：调用 `oa/schedule/del_attendees` 从现有日程移除成员。
  // 为什么：配合新增参与人接口形成增量维护闭环，避免全量覆盖带来的并发冲突。
  async removeScheduleAttendees(scheduleId, attendees = []) {
    const traceId = createTraceId();
    const normalizedScheduleId = normalizeTextValue(scheduleId);
    if (!normalizedScheduleId) {
      throw new Error('schedule_id 不能为空');
    }

    const payload = {
      schedule_id: normalizedScheduleId,
      attendees: Array.isArray(attendees) ? attendees : [],
    };

    logWithTrace(traceId, 'wecom-service', 'schedule.attendees.remove.start', {
      scheduleId: normalizedScheduleId,
      attendeeCount: payload.attendees.length,
    });

    const responseData = await this.requestOaPostWithTokenFallback('oa/schedule/del_attendees', payload, traceId);
    logWithTrace(traceId, 'wecom-service', 'schedule.attendees.remove.success', {
      scheduleId: normalizedScheduleId,
      errcode: responseData && responseData.errcode,
      errmsg: responseData && responseData.errmsg,
    });

    return responseData;
  }

  /**
   * Send Template Card (Interactive Message)
   * @param {Object} config Card configuration
   */
  async sendTemplateCard(config) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    const actionConfig = buildTemplateCardActionConfig(config);

    const payload = {
      touser: config.touser,
      msgtype: "template_card",
      agentid: this.agentId,
      template_card: {
        card_type: "button_interaction",
        source: {
          icon_url: config.icon_url || "",
          desc: "任务闭环系统",
          desc_color: 0,
        },
        main_title: {
          title: config.title,
          desc: config.description,
        },
        sub_title_text: config.sub_title || "",
        horizontal_content_list: config.details || [],
        action_menu: {
          desc: "更多操作",
          action_list: [{ text: "查看详情", key: "VIEW_DETAIL" }],
        },
        task_id: config.task_id,
      },
      enable_id_trans: 0,
      enable_duplicate_check: 0,
      duplicate_check_interval: 1800,
    };

    if (actionConfig.buttonSelection) {
      payload.template_card.button_selection = actionConfig.buttonSelection;
    }

    if (Array.isArray(actionConfig.buttonList) && actionConfig.buttonList.length > 0) {
      payload.template_card.button_list = actionConfig.buttonList;
    }

    logWithTrace(traceId, 'wecom-service', 'template_card.send.start', {
      touser: payload.touser,
      taskId: payload.template_card.task_id,
      title: payload.template_card.main_title && payload.template_card.main_title.title,
      buttonSelectionCount:
        (payload.template_card.button_selection &&
          payload.template_card.button_selection.option_list &&
          payload.template_card.button_selection.option_list.length) ||
        0,
      buttonListCount: (payload.template_card.button_list && payload.template_card.button_list.length) || 0,
    });

    const response = await this.requestPost(url, payload);
    logWithTrace(traceId, 'wecom-service', 'template_card.send.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      msgid: response.data && response.data.msgid
    });
    return response.data;
  }
  /**
   * List Users By Department
   * @param {number} departmentId
   * @param {number} fetchChild
   * @param {number} status
   */
  async listUsersByDepartment(departmentId = 1, fetchChild = 1, status = 0) {
    const traceId = createTraceId();
    const normalizedDepartmentId = Number(departmentId) > 0 ? Number(departmentId) : 1;
    const normalizedFetchChild = Number(fetchChild) === 1 ? 1 : 0;
    const normalizedStatus = Number(status) >= 0 ? Number(status) : 0;
    const tokenCandidates = this.buildUserListTokenCandidates();

    let lastResponseData = null;
    let lastError = null;

    for (let index = 0; index < tokenCandidates.length; index += 1) {
      const candidate = tokenCandidates[index];
      const isLastCandidate = index === tokenCandidates.length - 1;

      try {
        const token = await this.getAccessToken(candidate.tokenOptions);
        const url = `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=${normalizedDepartmentId}&fetch_child=${normalizedFetchChild}&status=${normalizedStatus}`;

        logWithTrace(traceId, 'wecom-service', 'users.list.start', {
          departmentId: normalizedDepartmentId,
          fetchChild: normalizedFetchChild,
          status: normalizedStatus,
          tokenSource: candidate.source,
        });

        const response = await this.requestGet(url);
        const responseData = (response && response.data) || {};
        const errcode = Number(responseData.errcode);

        logWithTrace(traceId, 'wecom-service', 'users.list.success', {
          tokenSource: candidate.source,
          errcode: responseData.errcode,
          errmsg: responseData.errmsg,
          userCount: Array.isArray(responseData.userlist) ? responseData.userlist.length : 0,
        });

        if (candidate.source === 'contact') {
          this.markContactSecretUserListDenied(traceId, responseData);
        }

        lastResponseData = responseData;
        if (errcode === 0 || isLastCandidate || !USER_LIST_RETRY_ERRCODES.has(errcode)) {
          return responseData;
        }

        logWithTrace(traceId, 'wecom-service', 'users.list.retry.next_secret', {
          currentTokenSource: candidate.source,
          nextTokenSource: tokenCandidates[index + 1] && tokenCandidates[index + 1].source,
          errcode,
          errmsg: responseData.errmsg,
        });
      } catch (error) {
        lastError = error;
        if (isLastCandidate) {
          break;
        }

        logWithTrace(traceId, 'wecom-service', 'users.list.retry.next_secret', {
          currentTokenSource: candidate.source,
          nextTokenSource: tokenCandidates[index + 1] && tokenCandidates[index + 1].source,
          reason: 'request_exception',
          message: error.message,
        });
      }
    }

    if (lastResponseData) {
      return lastResponseData;
    }

    throw lastError || new Error('组织成员查询失败');
  }

  /**
   * Get User Details
   * @param {string} userId
   */
  async getUser(userId) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${userId}`;
    logWithTrace(traceId, 'wecom-service', 'user.get.start', {
      userId
    });
    const response = await this.requestGet(url);
    logWithTrace(traceId, 'wecom-service', 'user.get.success', {
      userId,
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg
    });
    return response.data;
  }

  /**
   * Get User Info from OAuth Code
   * @param {string} code
   */
  async getUserInfoByCode(code) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=${token}&code=${code}`;
    logWithTrace(traceId, 'wecom-service', 'oauth.get_userinfo.start', {
      code
    });
    const response = await this.requestGet(url);
    logWithTrace(traceId, 'wecom-service', 'oauth.get_userinfo.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      userId: response.data && response.data.UserId
    });
    return response.data;
  }
}

const wecomService = new WeComService();

module.exports = wecomService;
module.exports.WeComService = WeComService;
module.exports.parseCommaList = parseCommaList;
module.exports.pickFirstIpv4Address = pickFirstIpv4Address;
module.exports.createDnsResolver = createDnsResolver;
