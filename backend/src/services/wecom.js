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
    this.corpSecret = process.env.CORP_SECRET;
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
  }

  // buildAxiosConfig
  // 是什么：企微 HTTP 请求配置构建函数。
  // 做什么：统一注入超时与 `httpsAgent`，确保请求共享同一网络容灾策略。
  // 为什么：分散配置易遗漏，统一入口可避免局部请求未应用容灾能力。
  buildAxiosConfig() {
    return {
      timeout: this.httpTimeoutMs,
      httpsAgent: this.httpsAgent,
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
  async getAccessToken() {
    const traceId = createTraceId();
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpires) {
      logWithTrace(traceId, 'wecom-service', 'access_token.cache.hit', {
        expiresAt: this.tokenExpires
      });
      return this.accessToken;
    }

    try {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.corpSecret}`;
      logWithTrace(traceId, 'wecom-service', 'access_token.fetch.start', {
        endpoint: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
        hasCorpId: Boolean(this.corpId),
        hasCorpSecret: Boolean(this.corpSecret),
      });
      const response = await this.requestGet(url);

      if (response.data.errcode === 0) {
        this.accessToken = response.data.access_token;
        // Buffer 5 minutes
        this.tokenExpires = now + (response.data.expires_in - 300) * 1000;
        logWithTrace(traceId, 'wecom-service', 'access_token.fetch.success', {
          expiresIn: response.data.expires_in,
          tokenExpiresAt: this.tokenExpires
        });
        return this.accessToken;
      } else {
        logWithTrace(traceId, 'wecom-service', 'access_token.fetch.reject', {
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
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/get?access_token=${token}`;
    logWithTrace(traceId, 'wecom-service', 'schedule.get.start', {
      scheduleId
    });
    const response = await this.requestPost(url, {
      schedule_id_list: [scheduleId],
    });
    const scheduleList = Array.isArray(response.data && response.data.schedule_list)
      ? response.data.schedule_list
      : [];
    logWithTrace(traceId, 'wecom-service', 'schedule.get.success', {
      scheduleId,
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg
    });
    return {
      ...(response.data || {}),
      schedule_list: scheduleList,
      schedule: scheduleList[0] || null,
    };
  }

  /**
   * Get Schedule List for a calendar
   */
  async getScheduleList(calId, offset = 0, limit = 500) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/get_by_calendar?access_token=${token}`;
    logWithTrace(traceId, 'wecom-service', 'schedule.list.start', {
      calId,
      offset,
      limit
    });
    const response = await this.requestPost(url, {
      cal_id: calId,
      offset: offset,
      limit: limit,
    });
    logWithTrace(traceId, 'wecom-service', 'schedule.list.success', {
      calId,
      errcode: response.data && response.data.errcode,
      scheduleCount: (response.data && response.data.schedule_list && response.data.schedule_list.length) || 0
    });
    return response.data;
  }

  // getCalendarByIds
  // 是什么：企业微信日历详情批量查询函数。
  // 做什么：通过 `cal_id_list` 拉取指定日历的详情信息。
  // 为什么：登录建历需要验证历史映射是否仍然可用，避免使用失效 cal_id。
  async getCalendarByIds(calIdList = []) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/calendar/get?access_token=${token}`;
    const normalizedCalIdList = (Array.isArray(calIdList) ? calIdList : [])
      .map((item) => normalizeTextValue(item))
      .filter(Boolean);

    logWithTrace(traceId, 'wecom-service', 'calendar.list.start', {
      calIdCount: normalizedCalIdList.length,
    });

    const response = await this.requestPost(url, {
      cal_id_list: normalizedCalIdList,
    });

    logWithTrace(traceId, 'wecom-service', 'calendar.list.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      calendarCount:
        (response.data && response.data.calendar_list && response.data.calendar_list.length) || 0,
    });
    return response.data;
  }

  // createCalendar
  // 是什么：企业微信日历创建函数。
  // 做什么：调用 `oa/calendar/add` 创建日历并返回 `cal_id`。
  // 为什么：首次登录账号需要自动建立可同步日历，减少人工配置成本。
  async createCalendar(options = {}) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/calendar/add?access_token=${token}`;
    const summary = normalizeTextValue(options.summary);
    const color = normalizeTextValue(options.color);
    const description = normalizeTextValue(options.description);
    const agentId = Number(options.agentid || this.agentId || 0);
    const body = {
      calendar: {
        summary,
        color,
        description,
      },
    };

    if (Number.isFinite(agentId) && agentId > 0) {
      body.agentid = agentId;
    }

    logWithTrace(traceId, 'wecom-service', 'calendar.create.start', {
      hasSummary: Boolean(summary),
      color,
      hasDescription: Boolean(description),
      hasAgentId: Boolean(body.agentid),
    });

    const response = await this.requestPost(url, body);
    logWithTrace(traceId, 'wecom-service', 'calendar.create.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      calId: response.data && response.data.cal_id,
    });

    return response.data;
  }

  // createSchedule
  // 是什么：企业微信日程创建函数。
  // 做什么：调用 `oa/schedule/add` 在指定日历创建日程并返回接口结果。
  // 为什么：手动创建任务需要与企微日历建立可回查的 `schedule_id` 关联。
  async createSchedule(schedule = {}) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/add?access_token=${token}`;
    const payload = sanitizeCreateSchedulePayload(schedule);

    logWithTrace(traceId, 'wecom-service', 'schedule.create.start', {
      organizer: schedule && schedule.organizer,
      calId: schedule && schedule.cal_id,
      hasAttendees: Boolean(schedule && Array.isArray(schedule.attendees) && schedule.attendees.length > 0),
      hasSummary: Boolean(schedule && schedule.summary),
      organizerStripped: Boolean(schedule && schedule.organizer),
    });

    const response = await this.requestPost(url, payload);

    logWithTrace(traceId, 'wecom-service', 'schedule.create.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      scheduleId: response.data && response.data.schedule_id,
    });

    return response.data;
  }

  // updateSchedule
  // 是什么：企业微信日程更新函数。
  // 做什么：调用 `oa/schedule/update` 覆盖更新指定日程，并支持重复日程相关可选参数。
  // 为什么：官方接口更新语义为覆盖式，需显式透传 `skip_attendees/op_mode/op_start_time` 以适配真实场景。
  async updateSchedule(schedule = {}, options = {}) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/update?access_token=${token}`;
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

    const response = await this.requestPost(url, payload);
    logWithTrace(traceId, 'wecom-service', 'schedule.update.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      scheduleId: response.data && response.data.schedule_id,
    });

    return response.data;
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

    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/del?access_token=${token}`;
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

    const response = await this.requestPost(url, payload);
    logWithTrace(traceId, 'wecom-service', 'schedule.cancel.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      scheduleId: normalizedScheduleId,
    });

    return response.data;
  }

  /**
   * Send Template Card (Interactive Message)
   * @param {Object} config Card configuration
   */
  async sendTemplateCard(config) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

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
        button_selection: {
          question_key: "task_action",
          title: "请确认任务进度",
          option_list: config.buttons || [],
        },
        button_list: config.button_list || [],
      },
      enable_id_trans: 0,
      enable_duplicate_check: 0,
      duplicate_check_interval: 1800,
    };

    logWithTrace(traceId, 'wecom-service', 'template_card.send.start', {
      touser: payload.touser,
      taskId: payload.template_card.task_id,
      title: payload.template_card.main_title && payload.template_card.main_title.title,
      buttonSelectionCount: (payload.template_card.button_selection && payload.template_card.button_selection.option_list && payload.template_card.button_selection.option_list.length) || 0
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
