# 企业微信任务闭环系统 - 项目方案文档

## 1. 项目概述

### 1.1 项目目标
构建一个基于企业微信的任务闭环管理系统，实现：
- 任务从日程同步到系统
- 执行人通过企微卡片标记完成
- 领导通过企微卡片验收/驳回
- Web 端可视化看板展示任务状态与 KPI

### 1.2 核心业务流程
```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  任务创建   │ -> │  执行中     │ -> │  待验收     │ -> │  已完成     │
│  (PENDING)  │    │  (PENDING)  │    │(WAITING_    │    │ (COMPLETED) │
│             │    │             │    │  VERIFY)    │    │             │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                                            │
                                            v (驳回)
                                      ┌─────────────┐
                                      │  重新执行   │
                                      │  (PENDING)  │
                                      └─────────────┘
```

---

## 2. 系统架构

### 2.1 技术栈
| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 前端 | React 19 + Vite 6 + TypeScript | 现代化 SPA 架构 |
| 后端 | Node.js + Express | 轻量级 API 服务 |
| 数据库 | SQLite | 单机部署，轻量存储 |
| 消息通道 | 企业微信回调 + 模板卡片 | 双向交互 |
| 认证 | 企微 OAuth + JWT | 单点登录 |

### 2.2 目录结构
```
wecom-task-bot/
├── backend/                    # 后端服务
│   ├── app.js                  # 入口文件
│   ├── database/               # SQLite 数据库文件
│   │   └── tasks.db
│   ├── src/
│   │   ├── models/
│   │   │   └── db.js           # 数据库连接与 Schema
│   │   ├── routes/
│   │   │   ├── api.js          # REST API 路由
│   │   │   └── callback.js     # 企微回调路由
│   │   ├── services/
│   │   │   ├── wecom.js        # 企微 API 封装
│   │   │   ├── task.js         # 任务业务逻辑
│   │   │   └── sync.js         # 日程同步服务
│   │   └── utils/
│   │       ├── wxcrypto.js     # 企微加解密工具
│   │       └── logger.js       # 日志工具
│   ├── .env                    # 环境变量配置
│   └── package.json
├── frontend/                   # 前端应用
│   ├── App.tsx                 # 主应用组件
│   ├── api.ts                  # API 客户端
│   ├── types.ts                # TypeScript 类型定义
│   ├── contexts/
│   │   ├── AuthContext.tsx     # 认证上下文
│   │   └── LanguageContext.tsx # 国际化上下文
│   ├── pages/
│   │   ├── Dashboard.tsx       # 仪表盘页面
│   │   └── Tasks.tsx           # 任务列表页面
│   ├── components/             # 通用组件
│   └── package.json
├── start.sh                    # 一键启动脚本
└── PROJECT_PLAN.md             # 本文档
```

### 2.3 部署架构
```
                    ┌──────────────────────────────────────┐
                    │           企业微信服务器              │
                    └──────────────────────────────────────┘
                              │                    ▲
                              │ 回调推送           │ API 调用
                              ▼                    │
┌─────────────────────────────────────────────────────────────────────┐
│                         Nginx / 云服务器                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Node.js 服务 (Port 8080)                    │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │  │
│  │  │ /wecom/*    │  │ /api/*      │  │ /* (静态资源)       │   │  │
│  │  │ 回调处理    │  │ REST API    │  │ React SPA           │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘   │  │
│  │                          │                                     │  │
│  │                          ▼                                     │  │
│  │                   ┌─────────────┐                              │  │
│  │                   │   SQLite    │                              │  │
│  │                   │  tasks.db   │                              │  │
│  │                   └─────────────┘                              │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 环境配置

### 3.1 环境变量 (backend/.env)
```bash
# 服务配置
PORT=8080
APP_URL=https://your-domain.com

# 企业微信配置
CORP_ID=ww1234567890abcdef           # 企业 ID
AGENT_ID=1000002                      # 应用 AgentId
CORP_SECRET=your-corp-secret          # 应用 Secret

# 回调配置 (在企微后台设置)
WECOM_CALLBACK_TOKEN=your-callback-token
WECOM_ENCODING_AES_KEY=your-43-char-encoding-aes-key

# 认证配置
JWT_SECRET=your-jwt-secret-key

# 可选：全局验收人 (多人用逗号分隔)
GLOBAL_VERIFIERS=admin1,admin2

# 同步配置：默认日历（无映射时回退）
DEFAULT_CAL_ID=wc_default_calendar_id

# 同步配置：员工日历映射（优先）
# 格式1：zhangsan:wc_cal_a,lisi:wc_cal_b
# 格式2：{"zhangsan":"wc_cal_a","lisi":"wc_cal_b"}
USER_CALENDAR_MAP=

# 登录模式：AUTO（默认）| QR（强制扫码）| OAUTH（强制企微内授权）
AUTH_LOGIN_MODE=AUTO

# 可选：登录回调基准域名（用于修复 redirect_uri 域名不一致）
AUTH_CALLBACK_BASE_URL=https://your-domain.com
```

### 3.2 企业微信后台配置

#### 3.2.1 创建自建应用
1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 应用管理 → 自建 → 创建应用
3. 记录 `AgentId` 和 `Secret`

#### 3.2.2 配置可信域名
1. 应用详情 → 网页授权及 JS-SDK → 设置可信域名
2. 填入你的域名（如 `your-domain.com`）

#### 3.2.3 配置接收消息
1. 应用详情 → 接收消息 → 设置 API 接收
2. URL: `https://your-domain.com/wecom/callback` 或 `https://your-domain.com/`
3. Token: 自定义（填入 `WECOM_CALLBACK_TOKEN`）
4. EncodingAESKey: 随机生成（填入 `WECOM_ENCODING_AES_KEY`）
5. 点击保存，企微会发送验证请求

---

## 4. API 接口文档

### 4.1 认证接口

#### GET /api/auth/login
跳转到企微 OAuth 授权页面

#### GET /api/auth/callback
OAuth 回调处理，成功后重定向到前端并携带 JWT Token

#### GET /api/user/me
获取当前登录用户信息
- Headers: `Authorization: Bearer <token>`
- Response:
```json
{
  "userid": "zhangsan",
  "name": "张三",
  "avatar": "https://..."
}
```

### 4.2 任务接口

#### GET /api/tasks
获取任务列表
- Headers: `Authorization: Bearer <token>`
- Response:
```json
{
  "tasks": [
    {
      "id": 1,
      "wecom_schedule_id": "schedule_xxx",
      "title": "完成项目报告",
      "description": "...",
      "creator_userid": "leader1",
      "executor_userid": "zhangsan",
      "start_time": "2024-01-15T09:00:00",
      "end_time": "2024-01-15T18:00:00",
      "status": "PENDING",
      "completion_time": null,
      "verify_time": null,
      "reject_reason": null,
      "created_at": "2024-01-15T08:00:00"
    }
  ]
}
```

### 4.3 企微回调接口

#### GET /wecom/callback
URL 验证接口（企微配置时调用）
- Query: `msg_signature`, `timestamp`, `nonce`, `echostr`
- Response: 解密后的 echostr 明文

#### POST /wecom/callback
事件接收接口（卡片按钮点击等）
- Query: `msg_signature`, `timestamp`, `nonce`
- Body: XML 格式的加密消息
- Response: `success`

---

## 5. 数据库设计

### 5.1 tasks 表
```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wecom_schedule_id TEXT UNIQUE,      -- 企微日程 ID
  title TEXT,                          -- 任务标题
  description TEXT,                    -- 任务描述
  creator_userid TEXT,                 -- 创建人 (领导)
  executor_userid TEXT,                -- 执行人
  start_time DATETIME,                 -- 开始时间
  end_time DATETIME,                   -- 截止时间
  status TEXT DEFAULT 'PENDING',       -- 状态: PENDING/WAITING_VERIFY/COMPLETED
  completion_time DATETIME,            -- 执行人提交时间
  verify_time DATETIME,                -- 领导验收时间
  reject_reason TEXT,                  -- 驳回原因
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 5.2 状态流转
| 状态 | 说明 | 触发条件 |
|------|------|----------|
| PENDING | 待执行/执行中 | 初始状态 / 被驳回 |
| WAITING_VERIFY | 待验收 | 执行人点击"已完成" |
| COMPLETED | 已完成 | 领导点击"通过" |

---

## 6. 部署指南

### 6.1 本地开发
```bash
# 1. 克隆项目
git clone <repo-url>
cd wecom-task-bot

# 2. 配置环境变量
cp backend/.env.example backend/.env
# 编辑 backend/.env 填入企微配置

# 3. 一键启动
bash start.sh
# 服务运行在 http://localhost:8080
```

### 6.2 生产部署

#### 方式一：直接部署
```bash
# 1. 安装 Node.js 18+
# 2. 上传代码到服务器
# 3. 配置 backend/.env
# 4. 启动服务
bash start.sh

# 5. 配置 Nginx 反向代理 (可选)
```

#### 方式二：Docker 部署 (待实现)
```bash
docker-compose up -d
```

### 6.3 Nginx 配置示例
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 7. 企微回调验证测试

### 7.1 本地测试 (使用 ngrok)
```bash
# 1. 安装 ngrok
brew install ngrok  # macOS

# 2. 启动本地服务
bash start.sh

# 3. 暴露本地端口
ngrok http 8080

# 4. 使用 ngrok 提供的 HTTPS URL 配置企微回调
# 例如: https://abc123.ngrok.io/wecom/callback
```

### 7.2 验证回调配置
```bash
# 模拟企微验证请求 (需要正确的签名参数)
curl "http://localhost:8080/wecom/callback?msg_signature=xxx&timestamp=xxx&nonce=xxx&echostr=xxx"

# 查看日志确认验签结果
tail -f log/app.log
```

---

## 8. 功能开发路线图

### Phase 1: 基础框架 ✅ 已完成
- [x] 项目结构搭建
- [x] 后端 Express 服务
- [x] 前端 React 应用
- [x] SQLite 数据库
- [x] 企微回调验签
- [x] 企微 OAuth 登录
- [x] JWT 认证

### Phase 2: 核心业务 🔄 进行中
- [x] 任务数据模型
- [x] 任务列表 API
- [x] 任务卡片交互处理
- [ ] 日程同步服务
- [ ] 任务创建接口
- [ ] 任务状态更新 API

### Phase 3: 前端完善
- [x] 仪表盘页面
- [x] 任务列表页面
- [ ] 任务详情弹窗
- [ ] 状态操作按钮
- [ ] KPI 统计图表
- [ ] 团队统计页面

### Phase 4: 高级功能
- [ ] 任务提醒通知
- [ ] 超时自动提醒
- [ ] 数据导出
- [ ] 操作日志
- [ ] 权限管理

### Phase 5: 运维优化
- [ ] Docker 容器化
- [ ] 日志聚合
- [ ] 监控告警
- [ ] 数据备份

---

## 9. 常见问题排查

### 9.1 回调验签失败 (401)
**可能原因：**
1. `WECOM_CALLBACK_TOKEN` 与企微后台配置不一致
2. `WECOM_ENCODING_AES_KEY` 配置错误（必须是 43 位）
3. URL 编码问题导致 `echostr` 中的 `+` 被解析为空格

**排查步骤：**
```bash
# 1. 检查环境变量
cat backend/.env | grep WECOM

# 2. 查看回调日志
grep "signature.verify" log/app.log

# 3. 对比签名
# 日志中会输出 msgSignature (企微传入) 和 calculatedSignature (本地计算)
```

### 9.2 OAuth 登录失败
**可能原因：**
1. 可信域名未配置
2. `APP_URL` 与实际访问域名不一致
3. `CORP_SECRET` 配置错误

**排查步骤：**
```bash
# 查看 OAuth 日志
grep "auth.callback" log/app.log
```

### 9.3 任务卡片无响应
**可能原因：**
1. 回调 URL 未正确配置
2. 卡片 `task_id` 与数据库不匹配
3. 按钮 `key` 与代码中的处理逻辑不匹配

---

## 10. 联系与支持

- 项目仓库: [GitHub URL]
- 问题反馈: [Issues URL]
- 企微文档: https://developer.work.weixin.qq.com/document/

---

*文档版本: v1.0.0*
*最后更新: 2024-01-15*

---

## 11. 闭环补齐执行记录（2026-02-12）

### 11.1 本次已补齐能力
- ✅ 日历任务同步闭环：`sync` 服务在应用启动后自动运行（含定时同步 + 启动即同步），并支持手动触发同步。
- ✅ 执行人卡片提交：执行人通过企微卡片 `ACTION_COMPLETE` 或 Web 端接口提交后，任务进入 `WAITING_VERIFY`。
- ✅ 领导卡片验收/驳回：领导可通过企微卡片 `ACTION_PASS` / `ACTION_REJECT` 完成验收流转。
- ✅ 日期提醒闭环：系统对 `PENDING` 任务执行“24小时到期提醒 + 逾期提醒”，并含冷却窗口避免重复轰炸。
- ✅ Web 看板 KPI：后端统一输出 KPI（总量、完成率、待验收、逾期、即将到期、按时率），前端实时展示。

### 11.2 新增/增强接口
- `GET /api/tasks`：返回任务列表 + KPI，并附带权限与提醒标记（`can_complete/can_verify/is_due_soon/is_overdue`）。
- `GET /api/tasks/kpi`：独立获取 KPI 汇总。
- `POST /api/tasks/:id/complete`：执行人提交完成（进入待验收）。
- `POST /api/tasks/:id/verify`：领导验收（`PASS`）或驳回（`REJECT` + 可选驳回理由）。
- `POST /api/tasks/sync`：手动触发日程同步与提醒派发。

### 11.3 数据模型补齐
`tasks` 表新增字段（自动迁移）：
- `redo_count`：驳回重做计数
- `last_reminder_at`：最近提醒时间
- `last_reminder_kind`：最近提醒类型
- `completed_by_userid`：提交完成人
- `verified_by_userid`：验收人
- `updated_at`：最近更新时间

### 11.4 当前已知后续优化点
- ⏳ 组织角色模型仍可增强（目前以“创建人 + 全局验收人”作为验收权限口径）。
- ⏳ KPI 历史趋势图可进一步下沉到后端聚合接口，减少前端计算。
- ⏳ 可补充 E2E（企微回调仿真 + Web 操作）以覆盖全链路回归。


### 11.5 产品页面完工清单（2026-02-12）
- ✅ 任务页：新增任务弹窗（标题/描述/执行人/起止时间）、任务详情弹窗、状态操作按钮全量可用。
- ✅ 团队统计页：成员维度任务量、完成率、待验收、逾期等指标看板与表格。
- ✅ 系统设置页：提醒开关、自动同步标记、语言偏好保存、手动同步入口。
- ✅ 前端交互联通：所有关键操作均接入真实后端接口（创建/提交完成/验收驳回/同步）。
- ✅ 文案与多语言：新增页面相关中英文文案键，移除“仅占位”展示路径。

### 11.6 员工日历映射方案（2026-02-12）
- ✅ 同步支持“每员工一个 cal_id”：`sync` 服务会先解析 `USER_CALENDAR_MAP`，按员工日历逐个拉取日程，再回退 `DEFAULT_CAL_ID`。
- ✅ 任务写入企微日程：Web 创建任务时优先按执行人映射的 `cal_id` 调用 `oa/schedule/add`，并将 `schedule_id` 回写任务。
- ✅ 数据模型补齐：`tasks` 新增 `owner_userid`、`owner_cal_id` 字段，用于追踪任务归属员工与来源日历。
- ✅ 用户视图隔离：任务查询与 KPI 接口按 `owner_userid / executor_userid / creator_userid` 限制，默认仅返回当前登录用户相关任务。

### 11.7 登录入口升级（2026-02-12）
- ✅ `GET /api/auth/login` 默认支持二维码登录：浏览器访问时自动跳转企微扫码页。
- ✅ AUTO 模式智能切换：企业微信内置浏览器走 OAuth，外部浏览器走扫码登录。
- ✅ 支持手动覆盖：`/api/auth/login?mode=qr|oauth|auto` 可按单次请求切换登录模式。
- ✅ 新增环境变量：`AUTH_LOGIN_MODE=AUTO|QR|OAUTH`，用于统一控制默认登录策略。

### 11.8 登录域名与首页视觉优化（2026-02-12）
- ✅ 登录回调域名修复：`redirect_uri` 优先按请求域名与 `AUTH_CALLBACK_BASE_URL` 生成，避免“授权回调域名不一致”。
- ✅ 登录页改为直出二维码：未登录态直接展示可扫码二维码面板，并支持“刷新二维码”。
- ✅ 首页背景优化：主应用页面增加渐变与柔光背景层，不再是纯色空白背景。
