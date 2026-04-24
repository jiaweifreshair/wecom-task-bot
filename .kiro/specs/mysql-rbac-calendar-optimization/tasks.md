# 实施计划：MySQL RBAC 日历优化

## 概述

按照数据库层 → 后端服务 → 前端 UI 的依赖顺序，将设计文档拆分为可增量执行的编码任务。后端使用 Node.js/JavaScript，前端使用 React/TypeScript，属性测试使用 fast-check + node:test。

## 任务

- [x] 1. MySQL DDL 脚本文件与初始化入口改造
  - [x] 1.1 创建 `backend/sql/001-create-database.sql` 建库脚本
    - 包含 `CREATE DATABASE IF NOT EXISTS` 语句，使用 utf8mb4 字符集
    - 添加文件头注释（版本号、创建日期、用途说明）
    - _需求: 1.1, 1.4_

  - [x] 1.2 创建 `backend/sql/002-create-tables.sql` 全量建表脚本
    - 包含 7 张表的完整 `CREATE TABLE IF NOT EXISTS` DDL，与 `db-dialect.js` 的 `buildSchemaStatements('mysql')` 输出完全一致
    - 使用 `utf8mb4` 字符集和 `utf8mb4_unicode_ci` 排序规则
    - 添加文件头注释
    - _需求: 1.2, 1.4_

  - [x] 1.3 创建 `backend/sql/003-migrations.sql` 幂等迁移脚本
    - 使用存储过程或条件判断实现幂等性（列已存在时跳过）
    - 覆盖 tasks 表 8 个迁移列和 platform_user_access 表 1 个迁移列
    - 添加文件头注释
    - _需求: 1.3, 1.4_

  - [x] 1.4 改造 `backend/scripts/init-mysql.js` 读取并执行 SQL 文件
    - 实现 `executeSqlFiles(pool, sqlDir)` 函数，按文件名编号顺序读取 `backend/sql/*.sql` 并逐条执行
    - 成功时输出 `MySQL 初始化完成: {host}:{port}/{database}` 并退出码 0
    - 失败时输出 `MySQL 初始化失败: {error.message}` 并退出码 1
    - _需求: 1.5, 1.6, 1.7, 1.8_

  - [x] 1.5 编写 SQL 脚本执行顺序属性测试
    - **Property 1: SQL 脚本文件按编号顺序执行**
    - 使用 fast-check 生成随机文件名集合，验证排序结果严格按数字前缀升序
    - **验证: 需求 1.5**

  - [x] 1.6 编写数据库初始化幂等性属性测试
    - **Property 2: 数据库初始化幂等性**
    - 验证重复执行初始化后表结构不变、数据不丢失、不抛错
    - **验证: 需求 1.9**

- [x] 2. 检查点 - 数据库层完成
  - 确保所有测试通过，ask the user if questions arise.

- [x] 3. 数据库兼容层验证与属性测试
  - [x] 3.1 验证 `transformSqlForClient` 覆盖全部 SQLite→MySQL 转换规则
    - 审查并确认 `datetime('now')` → `CURRENT_TIMESTAMP`、`datetime(?, 'unixepoch')` → `FROM_UNIXTIME(?)`、`datetime('now', '±N hour')` → `DATE_ADD/DATE_SUB`、`ON CONFLICT` → `ON DUPLICATE KEY UPDATE` 均已正确实现
    - 如有遗漏则补充实现
    - _需求: 2.5, 8.1, 8.2, 8.3, 8.4_

  - [x] 3.2 编写 MySQL 连接配置构建属性测试
    - **Property 3: MySQL 连接配置从环境变量正确构建**
    - 使用 fast-check 生成随机环境变量组合，验证 `buildMysqlConnectionConfig` 输出字段与输入一致，缺失时回退默认值
    - **验证: 需求 2.1, 2.4**

  - [x] 3.3 编写 SQL 方言转换正确性属性测试
    - **Property 4: SQLite 到 MySQL 的 SQL 方言转换正确性**
    - 使用 fast-check 生成包含 SQLite 语法的 SQL 字符串，验证转换后包含 MySQL 等价语法且不含原始 SQLite 语法
    - **验证: 需求 2.5, 8.1, 8.2, 8.3, 8.4, 8.5**

- [x] 4. 后端 RBAC 权限服务与日程提醒
  - [x] 4.1 确认 `platform-access.js` 的 `getEffectivePlatformAccess` 返回字段完整性
    - 验证返回对象始终包含 `platform_role`、`is_admin`、`is_super_admin`、`menu_permissions` 四个字段
    - 确认 `/api/user/me` 路由正确透传这些字段
    - _需求: 3.7_

  - [x] 4.2 编写平台权限返回字段完整性属性测试
    - **Property 7: 平台权限返回字段完整性**
    - 使用 fast-check 生成随机 userId，验证 `getEffectivePlatformAccess` 返回对象字段完整且值域合法
    - **验证: 需求 3.7**

  - [x] 4.3 确认日程提醒定时任务链路完整
    - 验证 `sync.js` 中 cron 任务周期性调用 `listPendingTasks()` → `dispatchTaskReminder()`
    - 确认冷却期 12 小时逻辑通过 `shouldSendReminder` 控制
    - 确认提醒发送后回写 `last_reminder_at` 和 `last_reminder_kind`
    - _需求: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 4.4 编写任务提醒类型分类属性测试
    - **Property 10: 任务提醒类型分类**
    - 使用 fast-check 生成随机任务状态和时间组合，验证 `getReminderKind` 返回值符合规则
    - **验证: 需求 6.1, 6.2, 10.9**

  - [x] 4.5 编写提醒冷却期控制属性测试
    - **Property 11: 提醒冷却期控制**
    - 使用 fast-check 生成随机提醒历史和时间间隔，验证 `shouldSendReminder` 冷却期判定正确
    - **验证: 需求 6.3**

- [x] 5. 检查点 - 后端服务层完成
  - 确保所有测试通过，ask the user if questions arise.

- [x] 6. 前端日历页面 RBAC 权限集成
  - [x] 6.1 在 CalendarManager.tsx 中集成权限判定逻辑
    - 从 `useAuth()` 读取 `user.isAdmin` 和 `user.id`
    - 使用 `canUserViewCalendarEvent` 过滤可见日程
    - 使用 `canUserMutateCalendarEvent` 控制编辑/删除按钮显示
    - EXECUTOR 查看他人日程时隐藏编辑/删除入口（视觉弱化而非弹窗阻断）
    - _需求: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 5.1, 5.2, 5.3_

  - [x] 6.2 编写日程查看权限判定属性测试
    - **Property 5: 日程查看权限判定**
    - 使用 fast-check 生成随机用户和事件组合，验证 `canUserViewCalendarEvent` 返回值符合权限矩阵
    - **验证: 需求 3.1, 3.2, 5.1**

  - [x] 6.3 编写日程编辑权限判定属性测试
    - **Property 6: 日程编辑权限判定**
    - 使用 fast-check 生成随机用户和事件组合，验证 `canUserMutateCalendarEvent` 返回值符合权限矩阵
    - **验证: 需求 3.3, 3.4, 3.5, 3.6, 5.3**

- [x] 7. 前端日历页面视觉层级与反 AI Slop 优化
  - [x] 7.1 实现日程视觉区分样式
    - 自己创建的日程：`border-l-4 border-blue-500` + 较深字重
    - 他人分配的日程：`border-l-4 border-slate-300` + 较浅字重
    - 移除所有装饰性 emoji 图标、紫色渐变背景
    - _需求: 5.4, 7.8, 7.9_

  - [x] 7.2 实现权限受限操作的视觉弱化
    - EXECUTOR 查看他人日程时，编辑/删除按钮通过 `opacity-40 pointer-events-none` 弱化
    - 不使用弹窗阻断
    - _需求: 7.10_

  - [x] 7.3 编写日程时间范围校验属性测试
    - **Property 8: 日程时间范围校验**
    - 使用 fast-check 生成随机时间对，验证 `hasInvalidDateTimeRange` 判定正确
    - **验证: 需求 4.4**

  - [x] 7.4 编写日程时间冲突检测属性测试
    - **Property 9: 日程时间冲突检测**
    - 使用 fast-check 生成随机事件集合和目标时间区间，验证 `findConflictingEvent` 检测正确
    - **验证: 需求 4.5**

- [x] 8. 前端日历页面交互与性能优化
  - [x] 8.1 实现 Skeleton Screen 加载状态
    - API 请求中展示骨架屏占位而非 loading spinner
    - 保持页面布局稳定不跳动
    - _需求: 7.5_

  - [x] 8.2 实现乐观更新与服务端回查机制
    - 创建/编辑/删除日程后立即更新本地状态
    - 异步发起服务端请求，失败时自动回滚并展示 Toast 错误提示
    - 成功后触发任务数据刷新保持仪表盘一致
    - _需求: 7.2, 7.3, 7.4, 10.4_

  - [x] 8.3 实现 Toast 通知组件
    - 底部滑入，2 秒自动消失
    - 替代所有模态弹窗式操作反馈
    - _需求: 7.11_

  - [x] 8.4 实现过渡动画与 `prefers-reduced-motion` 支持
    - 日程操作提供 150-300ms 过渡动画
    - 所有动画包裹在 `@media (prefers-reduced-motion: no-preference)` 中
    - _需求: 7.12, 7.13_

  - [x] 8.5 实现月份数据本地缓存
    - 切换月份时缓存已加载数据，避免重复请求
    - _需求: 7.1_

  - [x] 8.6 实现 API 错误友好提示与重试
    - 请求失败展示用户可理解的中文错误提示
    - 提供重试按钮
    - _需求: 7.6, 7.7_

  - [x] 8.7 编写错误消息用户友好性属性测试
    - **Property 12: 错误消息用户友好性**
    - 使用 fast-check 生成随机错误输入，验证 `resolveErrorMessage` 输出为非空中文字符串且不含技术性文本
    - **验证: 需求 7.6**

- [x] 9. 检查点 - 日历页面核心功能完成
  - 确保所有测试通过，ask the user if questions arise.

- [x] 10. 前端响应式适配与全局 CRUD 优化
  - [x] 10.1 实现日历页面响应式布局
    - 移动端（< 768px）：月视图切换为紧凑列表/周视图，触摸目标 ≥ 44×44px
    - 移动端日程编辑表单以全屏底部 Drawer 展示
    - _需求: 7.14, 7.15_

  - [x] 10.2 实现全局创建操作响应式表单
    - 桌面端（≥ 1024px）：居中 Modal，max-w-640px
    - 平板端（768-1023px）：侧边 Drawer
    - 移动端（< 768px）：全屏底部 Drawer
    - _需求: 9.1, 9.2, 9.3_

  - [x] 10.3 实现全局编辑操作响应式交互
    - 桌面端支持行内编辑（Enter 保存、Esc 取消）
    - 移动端以全屏 Drawer 展示编辑表单
    - 提交后乐观更新，失败自动回滚 + Toast 提示
    - _需求: 9.4, 9.5, 9.6_

  - [x] 10.4 实现全局删除操作响应式确认
    - 桌面端：Popconfirm 气泡紧贴触发按钮
    - 移动端：底部 Action Sheet，按钮 ≥ 44×44px
    - 删除后淡出动画 200ms
    - _需求: 9.7, 9.8, 9.9_

  - [x] 10.5 实现通用交互规范
    - 操作进行中禁用提交按钮 + 加载指示器
    - 未保存变更离开提示
    - 移动端列表切换为卡片视图，支持左滑快捷操作
    - 触摸目标 ≥ 44×44px，相邻元素间距 ≥ 8px
    - _需求: 9.10, 9.11, 9.12, 9.13, 9.14_

- [x] 11. 数据展示准确性保障
  - [x] 11.1 统一前端数据源与格式化
    - 任务状态直接使用后端 `status` 字段，禁止前端推断
    - 日期时间统一使用后端 UTC 时间 + 本地时区格式化，格式 `YYYY-MM-DD HH:mm`
    - 权限以 `getEffectivePlatformAccess` 返回为唯一数据源
    - _需求: 10.1, 10.2, 10.3_

  - [x] 11.2 实现数据同步与过期刷新机制
    - 写操作后乐观更新 + 服务端回查，不一致时以服务端为准静默修正
    - 仪表盘统计从后端实时拉取
    - 页面切换返回时检查数据过期（> 30s），过期则静默刷新
    - _需求: 10.4, 10.5, 10.6_

  - [x] 11.3 实现空值防护与异常数据展示
    - `null`/`undefined`/空字符串展示「未设置」「暂无数据」占位文本
    - 无法解析的日期展示「时间未设置」
    - 分页总数标注准确
    - _需求: 10.10, 10.11, 10.12_

  - [x] 11.4 编写任务状态映射恒等性属性测试
    - **Property 13: 任务状态映射恒等性**
    - 使用 fast-check 从合法状态值中随机选取，验证 `mapTaskStatus` 输出与输入相等
    - **验证: 需求 10.1**

  - [x] 11.5 编写任务统计数量守恒属性测试
    - **Property 14: 任务统计数量守恒**
    - 使用 fast-check 生成随机任务列表，验证 `buildTaskKpi` 输出的各状态数量之和等于 `total_tasks`
    - **验证: 需求 10.7**

  - [x] 11.6 编写空值占位文本防护属性测试
    - **Property 15: 空值占位文本防护**
    - 使用 fast-check 生成 `null`/`undefined`/空字符串输入，验证 `normalizeText` 返回空字符串而非 `'null'`/`'undefined'`
    - **验证: 需求 10.10**

  - [x] 11.7 编写分页总数一致性属性测试
    - **Property 16: 分页总数一致性**
    - 使用 fast-check 生成随机列表长度和分页参数，验证总数标注与实际长度一致
    - **验证: 需求 10.12**

- [x] 12. Docker 集成与部署验证
  - [x] 12.1 更新 `docker-compose.yml` 支持 SQL 文件挂载
    - 将 `backend/sql/` 目录挂载到 MySQL 容器的 `/docker-entrypoint-initdb.d/`
    - 确保 `db-init` 服务使用改造后的 `init-mysql.js`
    - _需求: 1.10_

  - [x] 12.2 更新 `backend/.env.example` 补充 MySQL 配置项说明
    - 添加 `TASK_BOT_DB_CLIENT`、`TASK_BOT_DB_HOST`、`TASK_BOT_DB_PORT` 等配置项注释
    - _需求: 2.1, 2.2, 2.3_

- [x] 13. 最终检查点 - 全部功能完成
  - 确保所有测试通过，ask the user if questions arise.

## 备注

- 标记 `*` 的任务为可选属性测试任务，可跳过以加速 MVP
- 每个任务引用了具体需求编号，确保可追溯性
- 属性测试使用 fast-check 库，运行命令 `npm test`
- 检查点任务用于阶段性验证，确保增量交付质量
