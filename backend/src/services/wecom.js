const axios = require("axios");
const { logWithTrace, createTraceId } = require('../utils/logger');
require("dotenv").config();

class WeComService {
  constructor() {
    this.corpId = process.env.CORP_ID;
    this.agentId = process.env.AGENT_ID;
    this.corpSecret = process.env.CORP_SECRET;
    this.accessToken = null;
    this.tokenExpires = 0;
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
        url
      });
      const response = await axios.get(url);

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
    const response = await axios.post(url, { schedule_id: scheduleId });
    logWithTrace(traceId, 'wecom-service', 'schedule.get.success', {
      scheduleId,
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg
    });
    return response.data;
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
    const response = await axios.post(url, {
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

  // createSchedule
  // 是什么：企业微信日程创建函数。
  // 做什么：调用 `oa/schedule/add` 在指定日历创建日程并返回接口结果。
  // 为什么：手动创建任务需要与企微日历建立可回查的 `schedule_id` 关联。
  async createSchedule(schedule = {}) {
    const traceId = createTraceId();
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/add?access_token=${token}`;

    logWithTrace(traceId, 'wecom-service', 'schedule.create.start', {
      organizer: schedule && schedule.organizer,
      calId: schedule && schedule.cal_id,
      hasAttendees: Boolean(schedule && Array.isArray(schedule.attendees) && schedule.attendees.length > 0),
      hasSummary: Boolean(schedule && schedule.summary),
    });

    const response = await axios.post(url, {
      schedule,
    });

    logWithTrace(traceId, 'wecom-service', 'schedule.create.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      scheduleId: response.data && response.data.schedule_id,
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

    const response = await axios.post(url, payload);
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
    const response = await axios.get(url);
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
    const response = await axios.get(url);
    logWithTrace(traceId, 'wecom-service', 'oauth.get_userinfo.success', {
      errcode: response.data && response.data.errcode,
      errmsg: response.data && response.data.errmsg,
      userId: response.data && response.data.UserId
    });
    return response.data;
  }
}

module.exports = new WeComService();
