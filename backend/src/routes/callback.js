const express = require('express');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const WXBizMsgCrypt = require('../utils/wxcrypto');
const { taskService, TaskOperationError } = require('../services/task');
const {
  createTraceId,
  logWithTrace,
  createHttpLogger
} = require('../utils/logger');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// normalizeTextValue
// 是什么：通用文本标准化函数。
// 做什么：将入参统一转换为去首尾空白的字符串，兼容数组与空值。
// 为什么：回调参数与环境变量可能存在空白/数组形态，直接使用会导致验签失败。
const normalizeTextValue = (value) => {
  if (Array.isArray(value)) {
    return normalizeTextValue(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
};

// normalizeEnvValue
// 是什么：环境变量标准化函数。
// 做什么：移除首尾空白与包裹引号，返回稳定字符串。
// 为什么：运维配置常见引号包裹/空格污染，需统一清洗避免签名偏差。
const normalizeEnvValue = (value) => {
  const normalized = normalizeTextValue(value);
  return normalized.replace(/^['"]|['"]$/g, '');
};

// decodeRawQueryParam
// 是什么：原始 Query 参数解析函数。
// 做什么：从 `req.originalUrl` 精确提取参数，并将 `+` 按字面量保留后解码。
// 为什么：`echostr` 是 Base64 字符串，若 `+` 被解析为空格会直接导致验签失败。
const decodeRawQueryParam = (req, key) => {
  const originalUrl = normalizeTextValue(req.originalUrl || req.url);
  const queryIndex = originalUrl.indexOf('?');

  if (queryIndex < 0) {
    return '';
  }

  const queryString = originalUrl.slice(queryIndex + 1);
  const queryPairs = queryString.split('&');

  for (const pair of queryPairs) {
    if (!pair) {
      continue;
    }

    const separatorIndex = pair.indexOf('=');
    const rawKey = separatorIndex >= 0 ? pair.slice(0, separatorIndex) : pair;
    const rawValue = separatorIndex >= 0 ? pair.slice(separatorIndex + 1) : '';

    let decodedKey = rawKey;
    try {
      decodedKey = decodeURIComponent(rawKey);
    } catch (error) {
      decodedKey = rawKey;
    }

    if (decodedKey !== key) {
      continue;
    }

    try {
      return decodeURIComponent(rawValue.replace(/\+/g, '%2B'));
    } catch (error) {
      return rawValue;
    }
  }

  return '';
};

// buildEchostrCandidates
// 是什么：`echostr` 候选集构建函数。
// 做什么：同时收集原始值、解析值和空格转 `+` 值用于多路径验签。
// 为什么：不同代理/框架对 Query 解码行为不同，候选验证可提升兼容性与成功率。
const buildEchostrCandidates = (rawEchostr, parsedEchostr) => {
  const candidates = new Set();

  const addCandidate = (value) => {
    const normalized = normalizeTextValue(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  addCandidate(rawEchostr);
  addCandidate(parsedEchostr);

  const parsedNormalized = normalizeTextValue(parsedEchostr);
  if (parsedNormalized.includes(' ')) {
    addCandidate(parsedNormalized.replace(/ /g, '+'));
  }

  return Array.from(candidates);
};

// fingerprintText
// 是什么：文本指纹计算函数。
// 做什么：输出文本的短 SHA1 指纹用于日志关联。
// 为什么：回调参数涉及敏感数据，不宜明文打日志但仍需可追踪定位。
const fingerprintText = (value) => {
  const normalized = normalizeTextValue(value);
  if (!normalized) {
    return '';
  }
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
};

// isSignatureMatched
// 是什么：签名比较函数。
// 做什么：对输入做标准化后执行常量时间比较。
// 为什么：避免大小写/空白差异导致误判，并降低直接字符串比较带来的侧信道风险。
const isSignatureMatched = (calculatedSignature, incomingSignature) => {
  const expected = normalizeTextValue(calculatedSignature).toLowerCase();
  const actual = normalizeTextValue(incomingSignature).toLowerCase();

  if (!expected || !actual) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
};

// resolveCallbackConfig
// 是什么：企业微信回调配置解析函数。
// 做什么：读取并标准化回调 Token、EncodingAESKey 与 CorpId，支持多变量名回退。
// 为什么：兼容历史配置差异，避免环境变量命名不一致导致验签失败。
const resolveCallbackConfig = () => {
  const token = normalizeEnvValue(
    process.env.WECOM_CALLBACK_TOKEN || process.env.WECOM_TOKEN || process.env.TOKEN
  );
  const encodingAesKey = normalizeEnvValue(
    process.env.WECOM_ENCODING_AES_KEY || process.env.ENCODING_AES_KEY
  );
  const corpId = normalizeEnvValue(process.env.WECOM_CORP_ID || process.env.CORP_ID);

  return {
    token,
    encodingAesKey,
    corpId
  };
};

const config = resolveCallbackConfig();

const crypt = new WXBizMsgCrypt(config.token, config.encodingAesKey, config.corpId);

// logWecomCallback
// 是什么：企业微信回调统一日志函数。
// 做什么：按 traceId + stage 输出结构化日志，包含时间戳与完整载荷。
// 为什么：统一日志格式便于按阶段（入参/解密/出参）检索与告警接入。
const logWecomCallback = (traceId, stage, payload) => {
  logWithTrace(traceId, 'wecom-callback', stage, payload);
};

const getFromObjectPath = (target, path) => {
  return path.reduce((accumulator, key) => {
    if (!accumulator || accumulator[key] === undefined || accumulator[key] === null) {
      return undefined;
    }
    return accumulator[key];
  }, target);
};

const resolveTaskIdFromMessage = (message) => {
  const candidates = [
    message && message.TaskId,
    message && message.TaskID,
    message && message.task_id,
    getFromObjectPath(message, ['TemplateCardEvent', 'TaskId']),
    getFromObjectPath(message, ['TemplateCardEvent', 'TaskID']),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTextValue(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

const resolveSelectedKeyFromMessage = (message) => {
  const candidates = [
    message && message.SelectedKey,
    message && message.EventKey,
    getFromObjectPath(message, ['ButtonSelection', 'Key']),
    getFromObjectPath(message, ['TemplateCardEvent', 'SelectedItems', 'SelectedItem', 'OptionIds']),
    getFromObjectPath(message, ['TemplateCardEvent', 'SelectedItems', 'SelectedItem', 'OptionId']),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTextValue(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

// attachWecomTraceId
// 是什么：企业微信回调 traceId 绑定中间件。
// 做什么：在已有全局 traceId 基础上，补充 `wecomTraceId` 供回调链路日志使用。
// 为什么：统一 traceId 字段命名，避免回调业务日志缺失追踪标识。
const attachWecomTraceId = (req, res, next) => {
  req.wecomTraceId = req.traceId || createTraceId();
  next();
};

router.use('/callback', createHttpLogger('wecom-callback'));
router.use('/callback', attachWecomTraceId);

// 1. 验证回调 URL (GET)
router.get('/callback', (req, res) => {
  const traceId = req.wecomTraceId || createTraceId();
  const msgSignature = normalizeTextValue(
    decodeRawQueryParam(req, 'msg_signature') ||
      req.query.msg_signature ||
      req.query.msgSignature ||
      req.query.signature
  );
  const timestamp = normalizeTextValue(decodeRawQueryParam(req, 'timestamp') || req.query.timestamp);
  const nonce = normalizeTextValue(decodeRawQueryParam(req, 'nonce') || req.query.nonce);
  const parsedEchostr = normalizeTextValue(req.query.echostr);
  const rawEchostr = normalizeTextValue(decodeRawQueryParam(req, 'echostr'));
  const echostrCandidates = buildEchostrCandidates(rawEchostr, parsedEchostr);

  if (!msgSignature || !timestamp || !nonce || echostrCandidates.length === 0) {
    logWecomCallback(traceId, 'signature.verify.get.reject', {
      reason: 'invalid_query',
      msgSignaturePresent: Boolean(msgSignature),
      timestampPresent: Boolean(timestamp),
      noncePresent: Boolean(nonce),
      echostrCandidateCount: echostrCandidates.length
    });
    return res.status(400).send('Invalid callback query');
  }

  try {
    let matchedSignature = '';
    let matchedEchostr = '';
    let lastCalculatedSignature = '';

    for (const candidate of echostrCandidates) {
      const calculatedSignature = crypt.getSignature(timestamp, nonce, candidate);
      lastCalculatedSignature = calculatedSignature;

      if (isSignatureMatched(calculatedSignature, msgSignature)) {
        matchedSignature = calculatedSignature;
        matchedEchostr = candidate;
        break;
      }
    }

    logWecomCallback(traceId, 'signature.verify.get', {
      msgSignature,
      calculatedSignature: matchedSignature || lastCalculatedSignature,
      timestamp,
      nonce,
      echostrCandidateCount: echostrCandidates.length,
      echostrFingerprint: fingerprintText(matchedEchostr || parsedEchostr || rawEchostr),
      callbackTokenFingerprint: fingerprintText(config.token)
    });

    if (matchedSignature) {
      const decrypted = crypt.decrypt(matchedEchostr);
      logWecomCallback(traceId, 'signature.verify.get.pass', {
        decrypted
      });
      res.send(decrypted);
    } else {
      logWecomCallback(traceId, 'signature.verify.get.reject', {
        reason: 'signature_mismatch',
        echostrCandidateCount: echostrCandidates.length,
        callbackTokenFingerprint: fingerprintText(config.token)
      });
      res.status(401).send('Invalid Signature');
    }
  } catch (err) {
    logWecomCallback(traceId, 'callback.get.error', {
      message: err.message,
      stack: err.stack
    });
    res.status(500).send('Error');
  }
});

// 2. 接收业务指令 (POST)
router.post('/callback', async (req, res) => {
  const traceId = req.wecomTraceId || createTraceId();
  const msgSignature = normalizeTextValue(
    decodeRawQueryParam(req, 'msg_signature') ||
      req.query.msg_signature ||
      req.query.msgSignature ||
      req.query.signature
  );
  const timestamp = normalizeTextValue(decodeRawQueryParam(req, 'timestamp') || req.query.timestamp);
  const nonce = normalizeTextValue(decodeRawQueryParam(req, 'nonce') || req.query.nonce);
  const encryptedXml = req.body.xml; // express-xml-bodyparser puts xml content in req.body.xml

  logWecomCallback(traceId, 'callback.post.payload.raw', {
    msgSignature,
    timestamp,
    nonce,
    encryptedXml
  });

  if (!msgSignature || !timestamp || !nonce) {
    logWecomCallback(traceId, 'signature.verify.post.reject', {
      reason: 'invalid_query',
      msgSignaturePresent: Boolean(msgSignature),
      timestampPresent: Boolean(timestamp),
      noncePresent: Boolean(nonce)
    });
    return res.status(400).send('Invalid callback query');
  }

  if (!encryptedXml || !encryptedXml.encrypt) {
    logWecomCallback(traceId, 'callback.post.reject', {
      reason: 'invalid_xml'
    });
    return res.status(400).send('Invalid XML');
  }

  const encrypt = encryptedXml.encrypt[0];

  try {
    // 1. Verify Signature
    const signature = crypt.getSignature(timestamp, nonce, encrypt);
    logWecomCallback(traceId, 'signature.verify.post', {
      msgSignature,
      calculatedSignature: signature,
      encryptFingerprint: fingerprintText(encrypt),
      callbackTokenFingerprint: fingerprintText(config.token)
    });

    if (!isSignatureMatched(signature, msgSignature)) {
      logWecomCallback(traceId, 'signature.verify.post.reject', {
        reason: 'signature_mismatch',
        callbackTokenFingerprint: fingerprintText(config.token)
      });
      return res.status(401).send('Invalid Signature');
    }

    // 2. Decrypt
    const decryptedXml = crypt.decrypt(encrypt);
    logWecomCallback(traceId, 'callback.post.decrypted_xml', {
      decryptedXml
    });
    
    // 3. Parse Decrypted XML
    const message = await crypt.parseXML(decryptedXml);
    logWecomCallback(traceId, 'callback.post.message.parsed', {
      message
    });

    // 4. Handle Task Card Event
    if (message.MsgType === 'event' && message.Event === 'template_card_event') {
      const taskId = resolveTaskIdFromMessage(message);
      const selectedKey = resolveSelectedKeyFromMessage(message);
      const interactionPayload = {
        UserID: message.FromUserName,
        TaskId: taskId,
        SelectedKey: selectedKey,
      };

      logWecomCallback(traceId, 'callback.post.task_interaction.in', {
        interactionPayload
      });

      const interactionResult = await taskService.handleInteraction(interactionPayload);

      logWecomCallback(traceId, 'callback.post.task_interaction.out', {
        interactionResult
      });
    } else {
      logWecomCallback(traceId, 'callback.post.event.skipped', {
        reason: 'unsupported_message_type_or_event',
        msgType: message.MsgType,
        event: message.Event
      });
    }

    res.send("success");
  } catch (err) {
    if (err instanceof TaskOperationError) {
      logWecomCallback(traceId, 'callback.post.task_interaction.reject', {
        code: err.code,
        message: err.message,
      });
      return res.send('success');
    }

    logWecomCallback(traceId, 'callback.post.error', {
      message: err.message,
      stack: err.stack
    });
    res.status(500).send('Internal Error');
  }
});

module.exports = router;
