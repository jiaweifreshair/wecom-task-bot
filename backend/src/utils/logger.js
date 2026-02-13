const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// LOG_ROOT_DIR
// 是什么：项目级日志目录绝对路径常量。
// 做什么：统一指向仓库根目录下的 `log` 目录，作为文件日志落盘位置。
// 为什么：避免日志散落在不同子目录，便于运维统一收集与排查。
const LOG_ROOT_DIR = path.resolve(__dirname, '../../../log');

// LOG_FILE_PATH
// 是什么：结构化日志文件路径常量。
// 做什么：定义后端日志的默认输出文件 `wecom-task-bot.log`。
// 为什么：提供稳定日志文件名，降低排障时查找成本。
const LOG_FILE_PATH = path.join(LOG_ROOT_DIR, 'wecom-task-bot.log');

// ensureLogDirectory
// 是什么：日志目录创建函数。
// 做什么：确保根目录 `log` 存在，不存在时递归创建。
// 为什么：文件日志依赖目录存在，缺失时会导致写入失败。
const ensureLogDirectory = () => {
  fs.mkdirSync(LOG_ROOT_DIR, { recursive: true });
};

// createLogFileStream
// 是什么：文件日志流创建函数。
// 做什么：初始化追加写入流并在失败时输出告警。
// 为什么：集中管理文件句柄可降低频繁打开文件带来的开销。
const createLogFileStream = () => {
  try {
    ensureLogDirectory();
    const stream = fs.createWriteStream(LOG_FILE_PATH, {
      flags: 'a',
      encoding: 'utf8'
    });
    stream.on('error', (error) => {
      console.error(`[logger][file.error] ${error.message}`);
    });
    return stream;
  } catch (error) {
    console.error(`[logger][init.error] ${error.message}`);
    return null;
  }
};

let logFileStream = createLogFileStream();

// appendLogToFile
// 是什么：文件日志追加函数。
// 做什么：将格式化后的日志文本按行写入根目录日志文件。
// 为什么：保留控制台输出的同时持久化日志，便于复盘与审计。
const appendLogToFile = (message) => {
  if (!logFileStream) {
    return;
  }

  try {
    logFileStream.write(`${message}\n`);
  } catch (error) {
    console.error(`[logger][write.error] ${error.message}`);
    logFileStream = null;
  }
};

// createTraceId
// 是什么：链路追踪 ID 生成函数。
// 做什么：为每一条日志链路生成唯一 traceId，用于串联请求、服务调用和响应。
// 为什么：多模块并发日志场景下，缺少唯一标识会导致排障时难以关联上下文。
const createTraceId = () => {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

// stringifyLogPayload
// 是什么：日志载荷安全序列化函数。
// 做什么：将日志对象转换为 JSON 文本，序列化失败时返回错误信息。
// 为什么：复杂对象（例如循环引用）可能导致日志输出异常，需要兜底保证日志不丢。
const stringifyLogPayload = (payload) => {
  try {
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    return JSON.stringify({
      logSerializeError: true,
      message: error.message
    });
  }
};

// normalizeResponseBody
// 是什么：HTTP 响应体标准化函数。
// 做什么：将 Buffer 类型转换成可读字符串，其他类型原样返回。
// 为什么：统一日志展示格式，避免二进制响应体在日志中不可读。
const normalizeResponseBody = (body) => {
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }
  return body;
};

// logWithTrace
// 是什么：统一结构化日志输出函数。
// 做什么：按 scope + traceId + stage 输出带时间戳的日志文本。
// 为什么：统一日志格式有利于 grep 检索、日志聚合和问题定位。
const logWithTrace = (traceId, scope, stage, payload) => {
  const timestamp = new Date().toISOString();
  const logLine = `[${scope}][${traceId}][${stage}][${timestamp}] ${stringifyLogPayload(payload)}`;
  console.log(logLine);
  appendLogToFile(logLine);
};

// createHttpLogger
// 是什么：全局 HTTP 请求响应日志中间件工厂。
// 做什么：为每个请求生成/复用 traceId，记录完整入参与出参（状态码、响应体、耗时）。
// 为什么：满足接口“出入参全量可观测”需求，便于线上排查接口问题。
const createHttpLogger = (scope = 'http') => {
  return (req, res, next) => {
    const traceId = req.traceId || req.wecomTraceId || createTraceId();
    const startAt = Date.now();
    req.traceId = traceId;
    res.setHeader('x-trace-id', traceId);

    logWithTrace(traceId, scope, 'request.in', {
      method: req.method,
      originalUrl: req.originalUrl,
      headers: req.headers,
      query: req.query,
      params: req.params,
      body: req.body,
      ip: req.ip
    });

    let responseBody;
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    res.send = (body) => {
      responseBody = normalizeResponseBody(body);
      return originalSend(body);
    };

    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      logWithTrace(traceId, scope, 'response.out', {
        method: req.method,
        originalUrl: req.originalUrl,
        statusCode: res.statusCode,
        responseHeaders: res.getHeaders(),
        responseBody,
        durationMs: Date.now() - startAt
      });
    });

    next();
  };
};

module.exports = {
  createTraceId,
  stringifyLogPayload,
  normalizeResponseBody,
  logWithTrace,
  createHttpLogger
};
