# 企业微信日历/日程闭环方案

## 1. 目标
- 提供一个前端“日历与日程管理”页面，覆盖企业微信日历与日程的核心操作闭环。
- 后端提供统一网关接口，隔离企业微信 API 细节，便于前端直连调用。
- 提供脚本化验收与自动化测试，支持本地复现“可创建、可查询、可更新、可删除”全流程。

## 2. 闭环范围
- 日历能力：
  - 创建日历 `calendar/add`
  - 获取日历详情 `calendar/get`
  - 更新日历 `calendar/update`
  - 删除日历 `calendar/del`
  - 用户与日历映射管理（`user_calendar_map`）
- 日程能力：
  - 创建日程 `schedule/add`
  - 获取日程详情 `schedule/get`
  - 获取日历下日程列表 `schedule/get_by_calendar`
  - 更新日程 `schedule/update`
  - 取消日程 `schedule/del`
  - 增加参与人 `schedule/add_attendees`
  - 删除参与人 `schedule/del_attendees`

## 3. 前后端职责
- 前端：
  - 提供日历与日程操作表单。
  - 支持输入 JSON 扩展字段，便于对齐企业微信复杂参数（重复规则、public_range、op_mode 等）。
  - 展示最近一次接口响应，便于联调定位。
- 后端：
  - 提供 `/api/calendar/*` 与 `/api/schedule/*` 路由。
  - 统一校验入参、归一化 ID 列表、返回企业微信原始结果。
  - 维护 `user_calendar_map` 映射，支持“登录自动建历 + 手动绑定”。

## 4. 关键约束
- `schedule/add` 请求体不传 `organizer`，避免 `48002 api forbidden`。
- `schedule/get_by_calendar` 仅可拉取“应用创建的日历”中的日程。
- 企业微信客户端手工创建日程默认不属于应用创建日历，不能通过 `get_by_calendar` 拉到。

## 5. 验收流程
1. 创建测试日历。
2. 获取并确认该日历详情。
3. 在该日历创建测试日程。
4. 按日历拉取日程列表并命中测试日程。
5. 获取测试日程详情。
6. 更新日程标题/描述。
7. 增删参与人。
8. 取消日程。
9. 删除测试日历。
10. 输出结构化报告（PASS/FAIL）。

## 6. 测试策略
- 单元测试：
  - `wecom.js` 服务层调用参数与 URL 断言。
  - 真实验收脚本参数解析与结果判定断言。
- 集成验证：
  - `node scripts/verify-real-integration.js` 执行真实 API 流程。
- 前端验证：
  - `npm run build` 确认页面与类型编译通过。

