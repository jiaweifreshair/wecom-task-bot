# 需求文档

## 简介

本功能为企业微信任务管理系统提供三项核心增强：（1）MySQL 数据库 SQL DDL 脚本化初始化部署，提供标准 `.sql` 文件支持一键建库建表与数据迁移；（2）基于公司角色的权限控制（RBAC），实现日程的分级编辑与查看权限，并支持日程到期提醒；（3）全局功能体验优化，确保所有 CRUD 操作在电脑端和移动端均有最佳交互体验，融合华书设计哲学的反 AI slop 原则。

## 术语表

- **系统（System）**：企业微信任务管理系统整体，包含前端 React 应用与后端 Node.js/Express 服务
- **初始化脚本（Init_Script）**：位于 `backend/scripts/init-mysql.js` 的 MySQL 数据库初始化入口程序，负责按顺序执行 `backend/sql/` 目录下的 DDL 脚本
- **DDL 脚本目录（SQL_Scripts）**：位于 `backend/sql/` 的标准 SQL 脚本文件集合，包含建库、建表、迁移等 DDL 语句，可通过 MySQL 客户端直接执行
- **数据库方言层（DB_Dialect）**：位于 `backend/src/models/db-dialect.js` 的跨数据库 SQL 兼容抽象模块
- **数据库适配层（DB_Adapter）**：位于 `backend/src/models/db.js` 的数据库连接、建表与迁移统一入口
- **平台权限服务（Platform_Access_Service）**：位于 `backend/src/services/platform-access.js` 的用户角色与菜单权限管理模块
- **日历管理页（Calendar_Manager）**：位于 `frontend/pages/CalendarManager.tsx` 的日历日程管理前端页面
- **任务服务（Task_Service）**：位于 `backend/src/services/task.js` 的任务创建、同步与提醒核心服务
- **用户日历服务（User_Calendar_Service）**：位于 `backend/src/services/user-calendar.js` 的用户日历自动创建与映射服务
- **超级管理员（SUPER_ADMIN）**：拥有全部系统权限的最高角色
- **管理员（ADMIN）**：拥有任务管理、日程查看与验收权限的管理角色
- **执行对象（EXECUTOR）**：仅可操作自身任务与日程的普通成员角色
- **日程提醒服务（Schedule_Reminder_Service）**：负责日程到期前和逾期后向相关用户推送提醒通知的后端模块

## 需求

### 需求 1：MySQL SQL 脚本初始化部署（DDL 方式）

**用户故事：** 作为运维人员，我希望通过标准 SQL DDL 脚本完成 MySQL 数据库的建库、建表和字段迁移，以便在新环境中快速部署系统，且 DBA 可直接审阅和手动执行 SQL 文件。

#### 验收标准

##### DDL 脚本文件

1. THE 系统 SHALL 在 `backend/sql/` 目录下提供独立的 `.sql` DDL 脚本文件，包含：`001-create-database.sql`（建库）、`002-create-tables.sql`（全部建表）、`003-migrations.sql`（字段迁移 ALTER TABLE）
2. THE `002-create-tables.sql` SHALL 包含所有业务表的完整 `CREATE TABLE IF NOT EXISTS` DDL 语句，使用 `utf8mb4` 字符集和 `utf8mb4_unicode_ci` 排序规则，并为每个表定义主键、索引和外键约束
3. THE `003-migrations.sql` SHALL 包含 `tasks` 表和 `platform_user_access` 表的 `ALTER TABLE` 语句，使用存储过程或条件判断实现幂等性（列已存在时跳过）
4. EACH `.sql` 文件 SHALL 包含文件头注释，标注版本号、创建日期、用途说明

##### 脚本执行入口

5. WHEN 运维人员执行 `npm run db:init:mysql` 命令, THE Init_Script SHALL 按编号顺序读取 `backend/sql/` 目录下的 `.sql` 文件并逐条执行
6. THE Init_Script SHALL 支持 `mysql -u root -p < backend/sql/002-create-tables.sql` 方式直接通过 MySQL 客户端手动执行，不依赖 Node.js 运行时
7. WHEN 初始化全部成功, THE Init_Script SHALL 向标准输出打印 `MySQL 初始化完成: {host}:{port}/{database}` 并以退出码 0 退出
8. IF 连接失败或任一 SQL 执行出错, THEN THE Init_Script SHALL 向标准错误输出打印 `MySQL 初始化失败: {error.message}` 并以退出码 1 退出

##### 幂等性与 Docker 集成

9. WHEN 初始化脚本在已存在完整表结构的数据库上重复执行, THE Init_Script SHALL 保持幂等性（`CREATE TABLE IF NOT EXISTS` + 条件 ALTER），不破坏已有数据且不抛出错误
10. WHEN Docker Compose 启动 `db-init` 服务, THE 系统 SHALL 等待 MySQL 健康检查通过后再执行初始化脚本，并支持将 `.sql` 文件挂载到 MySQL 官方镜像的 `/docker-entrypoint-initdb.d/` 目录自动执行

### 需求 2：MySQL 连接配置管理

**用户故事：** 作为运维人员，我希望通过环境变量灵活配置 MySQL 连接参数，以便在不同环境中无需修改代码即可切换数据库。

#### 验收标准

1. THE DB_Dialect SHALL 从环境变量 `TASK_BOT_DB_HOST`、`TASK_BOT_DB_PORT`、`TASK_BOT_DB_USER`、`TASK_BOT_DB_PASSWORD`、`TASK_BOT_DB_NAME` 读取 MySQL 连接参数
2. WHEN 环境变量 `TASK_BOT_DB_CLIENT` 设置为 `mysql`, THE DB_Adapter SHALL 使用 MySQL 连接池而非 SQLite 文件数据库
3. WHEN 环境变量 `TASK_BOT_DB_CLIENT` 未设置且 `TASK_BOT_DB_PATH` 存在, THE DB_Dialect SHALL 回退到 SQLite 模式
4. THE DB_Dialect SHALL 为 MySQL 连接池提供默认值：host 为 `127.0.0.1`、port 为 `3306`、user 为 `root`、database 为 `wecom_task_bot`、connectionLimit 为 `10`、charset 为 `utf8mb4`
5. WHEN 业务层 SQL 包含 SQLite 特有语法（如 `datetime('now')`、`ON CONFLICT ... DO UPDATE`）, THE DB_Dialect SHALL 自动转换为 MySQL 兼容语法（如 `CURRENT_TIMESTAMP`、`ON DUPLICATE KEY UPDATE`）

### 需求 3：基于角色的日程编辑权限控制

**用户故事：** 作为系统管理员，我希望不同角色的用户对日程拥有不同的操作权限，以便保护日程数据安全并确保职责分离。

#### 验收标准

1. WHILE 用户角色为 SUPER_ADMIN 或 ADMIN, THE Calendar_Manager SHALL 允许该用户查看所有用户的日程事件
2. WHILE 用户角色为 EXECUTOR, THE Calendar_Manager SHALL 仅展示该用户作为创建者或参与人的日程事件
3. WHEN 用户在日历页面选中一个日程事件, THE Calendar_Manager SHALL 根据 `canUserMutateCalendarEvent` 判定结果决定是否显示编辑和删除按钮
4. WHILE 用户角色为 SUPER_ADMIN 或 ADMIN, THE Calendar_Manager SHALL 允许该用户编辑和删除任意日程事件
5. WHILE 用户角色为 EXECUTOR, THE Calendar_Manager SHALL 仅允许该用户编辑和删除自己创建的日程事件
6. WHEN EXECUTOR 用户尝试修改非本人创建的日程, THE Calendar_Manager SHALL 隐藏编辑和删除操作入口，仅展示日程详情
7. THE Platform_Access_Service SHALL 在用户登录时返回 `platform_role`、`is_admin`、`is_super_admin`、`menu_permissions` 字段，供前端进行权限判定

### 需求 4：日程自主编辑能力

**用户故事：** 作为任意角色的用户，我希望能够编辑自己创建的日程（标题、时间、描述、参与人），以便灵活调整工作安排。

#### 验收标准

1. WHEN 用户在日历页面点击自己创建的日程事件, THE Calendar_Manager SHALL 展示包含标题、描述、地点、开始时间、结束时间的编辑表单
2. WHEN 用户修改日程时间后提交, THE Calendar_Manager SHALL 调用 `updateSchedule` API 更新企业微信日程并同步刷新本地任务数据
3. WHEN 用户修改日程参与人, THE Calendar_Manager SHALL 通过 `addScheduleAttendees` 和 `removeScheduleAttendees` API 增量更新参与人列表
4. IF 用户提交的结束时间早于或等于开始时间, THEN THE Calendar_Manager SHALL 在表单层面阻止提交并显示时间范围无效提示
5. IF 编辑后的日程时间与同一日历中其他日程存在时间冲突, THEN THE Calendar_Manager SHALL 显示冲突警告并要求用户确认

### 需求 5：日程查看权限

**用户故事：** 作为团队成员，我希望能够查看与自己相关的日程详情（包括他人分配给我的日程），以便了解工作安排。

#### 验收标准

1. WHEN EXECUTOR 用户打开日历页面, THE Calendar_Manager SHALL 加载并展示该用户作为参与人（attendee）或创建者（organizer）的全部日程
2. WHEN 用户点击他人创建但分配给自己的日程, THE Calendar_Manager SHALL 展示日程详情（标题、时间、描述、创建者、参与人列表）
3. WHILE 用户查看非本人创建的日程, THE Calendar_Manager SHALL 隐藏编辑和删除按钮，仅提供只读查看
4. THE Calendar_Manager SHALL 在月视图中以不同视觉样式区分"自己创建的日程"与"他人分配的日程"

### 需求 6：日程到期提醒

**用户故事：** 作为任务执行人，我希望在日程即将到期和已逾期时收到企业微信消息提醒，以便及时处理工作任务。

#### 验收标准

1. WHEN 待执行任务的截止时间距当前时间不超过 24 小时, THE Schedule_Reminder_Service SHALL 向任务执行人发送"即将到期"提醒卡片
2. WHEN 待执行任务的截止时间已过, THE Schedule_Reminder_Service SHALL 向任务执行人发送"已逾期"提醒卡片
3. WHEN 同一任务已发送过相同类型的提醒, THE Schedule_Reminder_Service SHALL 在 12 小时冷却期内不重复发送同类型提醒
4. WHEN 提醒发送成功, THE Schedule_Reminder_Service SHALL 更新任务记录的 `last_reminder_at` 和 `last_reminder_kind` 字段
5. IF 提醒发送失败（网络异常或企微接口错误）, THEN THE Schedule_Reminder_Service SHALL 记录错误日志但不中断后续任务的提醒处理
6. THE Schedule_Reminder_Service SHALL 通过定时任务（cron）周期性扫描全部待执行任务并触发提醒判定

### 需求 7：前端日历页面体验优化（融合华书设计哲学）

> 设计原则参考：#[[file:.kiro/steering/huashu-design.md]]

**用户故事：** 作为系统用户，我希望日历页面加载快速、交互流畅、视觉层级清晰、状态反馈即时且不反人性，以便高效管理日程。

#### 验收标准

##### 性能与数据一致性

1. WHEN 用户切换月份, THE Calendar_Manager SHALL 在本地缓存已加载月份的日程数据，避免重复请求
2. WHEN 用户创建或编辑日程后, THE Calendar_Manager SHALL 采用乐观更新（Optimistic Update）策略，立即在月视图中更新对应日期的事件展示，无需等待服务端响应
3. WHEN 用户在日历页面执行日程操作（创建、编辑、删除）, THE Calendar_Manager SHALL 同步触发任务数据刷新以保持仪表盘和任务列表数据一致
4. IF 乐观更新后服务端返回失败, THEN THE Calendar_Manager SHALL 自动回滚本地状态并展示用户可理解的错误提示

##### 加载与错误状态

5. WHEN 日程 API 请求正在进行中, THE Calendar_Manager SHALL 展示 Skeleton Screen 占位（而非 loading spinner），保持页面布局稳定不跳动
6. IF 日程 API 请求失败, THEN THE Calendar_Manager SHALL 展示用户可理解的错误提示（如「日程加载失败，请稍后重试」）而非技术错误信息，并提供重试按钮
7. WHEN 网络恢复后用户点击重试, THE Calendar_Manager SHALL 重新加载当前月份数据并恢复正常展示

##### 视觉层级与反 AI Slop

8. THE Calendar_Manager SHALL 通过视觉层级（颜色深浅、左侧色条、字重差异）区分「自己创建的日程」与「他人分配的日程」，而非依赖文字标签或 emoji 图标
9. THE Calendar_Manager SHALL 避免以下反人性设计模式：装饰性 emoji 图标、无意义的紫色渐变背景、每个日程卡片都配无关的 status dot、圆角卡片 + 左彩色 border accent 的千篇一律布局
10. THE Calendar_Manager SHALL 为权限受限的操作（如 EXECUTOR 查看他人日程）通过视觉弱化（降低按钮对比度、隐藏操作入口）而非弹窗阻断来体现，保持用户流畅感

##### 交互反馈与微动效

11. WHEN 用户执行日程操作（创建、编辑、删除）成功, THE Calendar_Manager SHALL 展示轻量级 Toast 通知（从底部滑入，2 秒后自动消失），而非模态弹窗
12. WHEN 用户在日历中拖拽或点击日程, THE Calendar_Manager SHALL 提供 150-300ms 的过渡动画反馈，避免突兀的状态切换
13. THE Calendar_Manager SHALL 尊重 `prefers-reduced-motion` 媒体查询，为偏好减少动画的用户提供无动画回退

##### 响应式与移动端

14. THE Calendar_Manager SHALL 在移动端视口（< 768px）下将月视图切换为紧凑的列表视图或周视图，确保触摸目标不小于 44×44px
15. THE Calendar_Manager SHALL 在移动端下将日程编辑表单以全屏抽屉（Drawer）形式展示，而非小尺寸弹窗

### 需求 8：数据库 SQL 兼容层完整性

**用户故事：** 作为开发人员，我希望现有的 SQLite 风格 SQL 在切换到 MySQL 后仍能正确执行，以便平滑迁移而无需重写业务层代码。

#### 验收标准

1. WHEN 业务层 SQL 包含 `datetime('now')`, THE DB_Dialect SHALL 将其转换为 MySQL 的 `CURRENT_TIMESTAMP`
2. WHEN 业务层 SQL 包含 `datetime(?, 'unixepoch')`, THE DB_Dialect SHALL 将其转换为 MySQL 的 `FROM_UNIXTIME(?)`
3. WHEN 业务层 SQL 包含 `datetime('now', '+N hour')` 或 `datetime('now', '-N hour')`, THE DB_Dialect SHALL 将其转换为 MySQL 的 `DATE_ADD(CURRENT_TIMESTAMP, INTERVAL N HOUR)` 或 `DATE_SUB(CURRENT_TIMESTAMP, INTERVAL N HOUR)`
4. WHEN 业务层 SQL 包含 `ON CONFLICT(column) DO UPDATE SET col = excluded.col`, THE DB_Dialect SHALL 将其转换为 MySQL 的 `ON DUPLICATE KEY UPDATE col = VALUES(col)`
5. FOR ALL 有效的 SQLite 风格 SQL 输入, 经过 `transformSqlForClient` 转换后再经过 MySQL 执行 SHALL 产生与 SQLite 执行语义等价的结果（往返一致性）

### 需求 9：全局 CRUD 操作响应式适配与最佳体验

> 设计原则参考：#[[file:.kiro/steering/huashu-design.md]]

**用户故事：** 作为系统用户，我希望在电脑和手机上执行创建、修改、删除操作时都能获得流畅自然的体验，操作入口清晰可达、表单布局合理、反馈即时且不打断工作流。

#### 验收标准

##### 创建操作（Create）

1. WHEN 用户在桌面端（≥ 1024px）点击创建按钮, THE 系统 SHALL 以居中模态对话框（Modal）展示创建表单，宽度不超过 640px，背景遮罩可点击关闭
2. WHEN 用户在移动端（< 768px）点击创建按钮, THE 系统 SHALL 以全屏底部抽屉（Bottom Sheet Drawer）展示创建表单，从底部滑入，支持下拉手势关闭
3. WHEN 用户在平板端（768px - 1023px）点击创建按钮, THE 系统 SHALL 以侧边抽屉（Side Drawer）或适中宽度模态展示创建表单

##### 修改操作（Update）

4. WHEN 用户在桌面端双击或点击编辑按钮修改记录, THE 系统 SHALL 支持行内编辑（Inline Edit）模式，点击字段直接进入编辑态，按 Enter 保存、Esc 取消
5. WHEN 用户在移动端点击编辑按钮, THE 系统 SHALL 以全屏抽屉展示编辑表单，表单字段纵向排列，输入框高度不小于 44px
6. WHEN 用户提交修改后, THE 系统 SHALL 采用乐观更新策略，立即在界面上反映变更，同时后台异步提交；若提交失败则自动回滚并展示 Toast 错误提示

##### 删除操作（Delete）

7. WHEN 用户在桌面端点击删除按钮, THE 系统 SHALL 展示轻量级确认气泡（Popconfirm）而非全屏模态弹窗，气泡紧贴触发按钮位置
8. WHEN 用户在移动端点击删除按钮, THE 系统 SHALL 展示底部操作面板（Action Sheet）确认删除，按钮区域不小于 44×44px
9. WHEN 删除确认后, THE 系统 SHALL 以淡出动画（200ms）移除被删除项，而非突然消失

##### 通用交互规范

10. FOR ALL CRUD 操作, THE 系统 SHALL 在操作进行中禁用提交按钮并展示加载指示器，防止重复提交
11. FOR ALL CRUD 操作成功后, THE 系统 SHALL 展示 Toast 通知（底部滑入，2 秒自动消失），内容为操作结果（如「日程已创建」「任务已删除」），而非模态弹窗
12. FOR ALL 表单, THE 系统 SHALL 在用户离开未保存的编辑状态时展示「未保存变更」提示，防止意外丢失数据
13. FOR ALL 列表页面, THE 系统 SHALL 在移动端将表格视图切换为卡片列表视图，每张卡片展示关键信息摘要，支持左滑显示快捷操作（编辑/删除）
14. THE 系统 SHALL 确保所有可交互元素在移动端的触摸目标不小于 44×44px，相邻可点击元素间距不小于 8px

### 需求 10：产品数据展示准确性保障

**用户故事：** 作为系统用户，我希望页面上展示的所有业务数据（任务状态、日程时间、统计数字、角色权限等）都与后端实际数据严格一致，避免因前后端数据不同步、格式转换错误或缓存过期导致看到错误信息，从而做出错误判断。

#### 验收标准

##### 数据源一致性

1. WHEN 前端展示任务状态（PENDING / WAITING_VERIFY / COMPLETED）, THE 系统 SHALL 直接使用后端 `Task_Service` 返回的 `status` 字段值，禁止前端自行推断或硬编码状态映射
2. WHEN 前端展示日程时间（开始时间、结束时间、截止时间）, THE 系统 SHALL 使用后端返回的 UTC 时间并在前端按用户本地时区统一格式化，禁止在多处分别实现时间转换逻辑
3. WHEN 前端展示用户角色与权限信息, THE 系统 SHALL 以 `Platform_Access_Service.getEffectivePlatformAccess` 返回的 `platform_role`、`is_admin`、`is_super_admin`、`menu_permissions` 为唯一权威数据源

##### 数据同步与刷新

4. WHEN 用户执行写操作（创建、编辑、删除任务或日程）后, THE 系统 SHALL 在乐观更新的同时发起后端数据回查，确保本地状态与服务端最终一致；若回查结果与乐观更新不一致，SHALL 以服务端数据为准静默修正
5. WHEN 用户在仪表盘（Dashboard）查看统计数据, THE 系统 SHALL 在页面加载时从后端实时拉取统计结果，禁止使用前端本地计算或过期缓存数据作为统计展示
6. WHEN 用户切换页面后返回列表页, THE 系统 SHALL 检查数据是否过期（超过 30 秒），过期则自动静默刷新，确保用户看到的是最新数据

##### 数值与格式准确性

7. WHEN 前端展示任务数量统计（待执行、待验收、已完成等）, THE 系统 SHALL 确保各状态数量之和等于总任务数，禁止出现统计数字不一致的情况
8. WHEN 前端展示日期时间, THE 系统 SHALL 统一使用同一个格式化函数，格式为 `YYYY-MM-DD HH:mm`，禁止不同页面使用不同的日期格式
9. WHEN 前端展示提醒状态（即将到期、已逾期）, THE 系统 SHALL 基于后端 `last_reminder_kind` 字段和当前时间实时计算，禁止使用缓存的提醒状态

##### 异常数据防护

10. WHEN 后端返回的数据字段为 `null`、`undefined` 或空字符串, THE 系统 SHALL 展示明确的占位文本（如「未设置」「暂无数据」），禁止展示 `null`、`undefined`、`NaN` 或空白区域
11. WHEN 前端接收到的任务 `end_time` 无法解析为合法日期, THE 系统 SHALL 展示「时间未设置」而非 `Invalid Date` 或 `1970-01-01`
12. WHEN 前端展示的列表数据与后端总数不匹配（如分页场景）, THE 系统 SHALL 在列表底部展示准确的总条数标注，且翻页后总数保持一致
