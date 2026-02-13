require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const xmlparser = require('express-xml-bodyparser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('./src/models/db');
const syncService = require('./src/services/sync');
const cookieParser = require('cookie-parser');
const apiRouter = require('./src/routes/api');
const { createHttpLogger, logWithTrace, createTraceId } = require('./src/utils/logger');
// callbackRouter
// 是什么：企业微信回调路由模块实例。
// 做什么：挂载企业微信的回调验签与事件接收接口。
// 为什么：未导入会导致 `app.use('/wecom', callbackRouter)` 在运行时报 `ReferenceError`。
const callbackRouter = require('./src/routes/callback');

const app = express();
const PORT = process.env.PORT || 80;

// hasWecomSignatureQuery
// 是什么：企业微信签名 Query 判定函数。
// 做什么：检测请求是否包含 `msg_signature + timestamp + nonce` 组合。
// 为什么：用于识别根路径 `/` 是否应按企微回调请求处理，避免误返回前端 HTML。
const hasWecomSignatureQuery = (query = {}) => {
  const msgSignature = query.msg_signature || query.msgSignature || query.signature;
  return Boolean(msgSignature && query.timestamp && query.nonce);
};

// rewriteToCallbackPath
// 是什么：请求路径重写函数。
// 做什么：将根路径回调请求在进入 callbackRouter 前重写为 `/callback`。
// 为什么：复用既有回调验签与解密逻辑，避免重复实现一套根路径处理代码。
const rewriteToCallbackPath = (req) => {
  const requestUrl = req.url || '';
  const queryIndex = requestUrl.indexOf('?');
  const querySuffix = queryIndex >= 0 ? requestUrl.slice(queryIndex) : '';
  req.url = `/callback${querySuffix}`;
};

// isWeComDomainVerifyFilename
// 是什么：企业微信域名校验文件名匹配函数。
// 做什么：校验请求文件名是否符合 `WW_verify_xxx.txt` 规则。
// 为什么：仅放行官方校验文件请求，避免任意文件路径被探测。
const isWeComDomainVerifyFilename = (value = '') => {
  return /^WW_verify_[A-Za-z0-9]+\.txt$/.test(String(value || ''));
};

// resolveWeComDomainVerifyFilePath
// 是什么：域名校验文件路径解析函数。
// 做什么：在项目根目录、前端 public、前端 dist 中按顺序查找校验文件。
// 为什么：避免 SPA catch-all 抢占请求，确保企微能读取到纯文本校验文件。
const resolveWeComDomainVerifyFilePath = (filename) => {
  const normalizedFilename = path.basename(String(filename || ''));
  if (!isWeComDomainVerifyFilename(normalizedFilename)) {
    return '';
  }

  const candidatePaths = [
    path.resolve(__dirname, `../${normalizedFilename}`),
    path.resolve(__dirname, `../frontend/public/${normalizedFilename}`),
    path.resolve(__dirname, `../frontend/dist/${normalizedFilename}`),
  ];

  return candidatePaths.find((item) => fs.existsSync(item)) || '';
};

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(xmlparser()); // Handle XML callbacks from WeCom
app.use(createHttpLogger('http-global'));

// 兼容根路径作为企业微信回调地址的场景（例如配置为 `https://domain.com/`）
app.get('/', (req, res, next) => {
  const isHandshakeRequest = hasWecomSignatureQuery(req.query) && Boolean(req.query.echostr);
  if (!isHandshakeRequest) {
    return next();
  }

  rewriteToCallbackPath(req);
  return callbackRouter(req, res, next);
});

app.post('/', (req, res, next) => {
  const hasSignature = hasWecomSignatureQuery(req.query);
  const hasEncryptedXml = Boolean(req.body && req.body.xml && req.body.xml.encrypt);
  if (!hasSignature && !hasEncryptedXml) {
    return next();
  }

  rewriteToCallbackPath(req);
  return callbackRouter(req, res, next);
});

// Routes
app.use('/wecom', callbackRouter);
app.use('/api', apiRouter);

app.get('/:verifyFilename', (req, res, next) => {
  const verifyFilename = req.params.verifyFilename;
  const verifyFilePath = resolveWeComDomainVerifyFilePath(verifyFilename);

  if (!verifyFilePath) {
    return next();
  }

  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain; charset=utf-8');
  return res.sendFile(verifyFilePath);
});

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// The "catchall" handler: for any request that doesn't
// match one above, send back React's index.html file.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// Start Server
app.listen(PORT, () => {
  const traceId = createTraceId();
  logWithTrace(traceId, 'app', 'startup.success', {
    port: PORT,
    mode: 'integrated',
    staticDir: path.join(__dirname, '../frontend/dist')
  });

  syncService.start();
});
