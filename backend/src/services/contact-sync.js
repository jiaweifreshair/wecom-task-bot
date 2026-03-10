const db = require('../models/db');
const { normalizeText } = require('./task-lifecycle');
const { createTraceId, logWithTrace } = require('../utils/logger');

// CONTACT_CHANGE_ENTITY_MAP
// 是什么：通讯录变更类型到实体类型的映射表。
// 做什么：将企业微信 `ChangeType` 映射为本地可识别的 `user/department/tag`。
// 为什么：回调统一走 `change_contact`，必须先按实体类型路由到不同落库逻辑。
const CONTACT_CHANGE_ENTITY_MAP = {
  create_user: 'user',
  update_user: 'user',
  delete_user: 'user',
  create_party: 'department',
  update_party: 'department',
  delete_party: 'department',
  create_tag: 'tag',
  update_tag: 'tag',
  delete_tag: 'tag',
};

// USER_UPSERT_CHANGE_TYPES
// 是什么：成员新增/更新事件集合。
// 做什么：声明哪些 `ChangeType` 需要执行成员信息写入。
// 为什么：成员事件包含新增和更新两类，统一使用幂等 upsert 最稳妥。
const USER_UPSERT_CHANGE_TYPES = new Set(['create_user', 'update_user']);

// DEPARTMENT_UPSERT_CHANGE_TYPES
// 是什么：部门新增/更新事件集合。
// 做什么：声明哪些 `ChangeType` 需要执行部门信息写入。
// 为什么：部门回调字段结构一致，可复用同一套写入逻辑。
const DEPARTMENT_UPSERT_CHANGE_TYPES = new Set(['create_party', 'update_party']);

// TAG_UPSERT_CHANGE_TYPES
// 是什么：标签新增/更新事件集合。
// 做什么：声明哪些 `ChangeType` 需要执行标签信息写入。
// 为什么：标签事件只有写入与删除两类，分组后分支更清晰。
const TAG_UPSERT_CHANGE_TYPES = new Set(['create_tag', 'update_tag']);

// hasOwnField
// 是什么：对象字段存在性判断函数。
// 做什么：精确判断消息对象是否显式携带某个字段，而不是仅看值是否为空。
// 为什么：通讯录更新事件可能只回传变更字段，缺失字段必须保留旧值，不能误写为空串。
const hasOwnField = (target, key) => {
  return Boolean(target) && Object.prototype.hasOwnProperty.call(target, key);
};

// runSql
// 是什么：SQLite 写操作 Promise 包装函数。
// 做什么：将 `db.run` 封装成 Promise，返回受影响行数和插入 ID。
// 为什么：通讯录同步包含多步串行写入，Promise 化后更易组织幂等事务式流程。
const runSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID || 0,
      });
    });
  });
};

// getSql
// 是什么：SQLite 单行查询 Promise 包装函数。
// 做什么：将 `db.get` 封装为 Promise，未命中时返回 `null`。
// 为什么：更新事件需要读取已有快照后做字段级合并。
const getSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
};

// parseIntegerOrNull
// 是什么：整数解析函数。
// 做什么：将任意输入解析为整数，非法或空值返回 `null`。
// 为什么：企业微信 XML 数值字段是字符串，入库前需要稳定转型。
const parseIntegerOrNull = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.trunc(parsed);
};

// parseCommaSeparatedTextList
// 是什么：逗号分隔文本列表解析函数。
// 做什么：将回调中的逗号字符串转换为去空白后的文本数组。
// 为什么：成员直属上级、标签成员列表等字段都是逗号串，需要统一收口。
const parseCommaSeparatedTextList = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
};

// parseCommaSeparatedIntegerList
// 是什么：逗号分隔整数列表解析函数。
// 做什么：将逗号字符串转换为整数数组，并过滤非法项。
// 为什么：部门 ID、标签部门列表等字段需要按整数语义持久化。
const parseCommaSeparatedIntegerList = (value) => {
  return parseCommaSeparatedTextList(value)
    .map((item) => parseIntegerOrNull(item))
    .filter((item) => item !== null);
};

// parseStoredJsonArray
// 是什么：数据库 JSON 数组恢复函数。
// 做什么：将表中 JSON 文本恢复为数组，异常时回退到空数组。
// 为什么：成员部门、直属上级和标签列表均以 JSON 文本存储，读取时需容错。
const parseStoredJsonArray = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

// toJsonText
// 是什么：数组 JSON 序列化函数。
// 做什么：将数组稳定序列化为 JSON 文本，缺省输出空数组。
// 为什么：SQLite 没有原生数组类型，通讯录多值字段需要统一落成文本。
const toJsonText = (value) => {
  return JSON.stringify(Array.isArray(value) ? value : []);
};

// pickTextField
// 是什么：文本字段合并函数。
// 做什么：优先使用消息中的显式字段，否则回退到数据库旧值。
// 为什么：更新事件可能只传局部字段，不能因为字段缺席就覆盖已有快照。
const pickTextField = (message, key, fallbackValue = '') => {
  if (hasOwnField(message, key)) {
    return normalizeText(message[key]);
  }

  return normalizeText(fallbackValue);
};

// pickIntegerField
// 是什么：整数字段合并函数。
// 做什么：优先解析消息中的显式整数值，否则回退到旧值。
// 为什么：部门主部门、状态、排序值等字段需要保留数值语义并兼容部分更新。
const pickIntegerField = (message, key, fallbackValue = null) => {
  if (hasOwnField(message, key)) {
    return parseIntegerOrNull(message[key]);
  }

  return parseIntegerOrNull(fallbackValue);
};

// pickJsonListField
// 是什么：JSON 列表字段合并函数。
// 做什么：在新消息显式携带字段时重新解析，否则沿用旧值中的 JSON 数组。
// 为什么：成员部门与标签列表属于多值字段，更新时必须支持保留未变更的旧集合。
const pickJsonListField = (message, key, fallbackValue, parser) => {
  if (hasOwnField(message, key)) {
    return parser(message[key]);
  }

  return parseStoredJsonArray(fallbackValue);
};

// resolveChangeType
// 是什么：通讯录变更类型标准化函数。
// 做什么：将企业微信 `ChangeType` 转为去空白的小写字符串。
// 为什么：事件类型比较应忽略输入大小写与空白差异。
const resolveChangeType = (message = {}) => {
  return normalizeText(message.ChangeType).toLowerCase();
};

// resolveUserEntityIds
// 是什么：成员事件主键解析函数。
// 做什么：同时解析旧 `UserID` 与新 `NewUserID`，返回最终写入主键。
// 为什么：成员更新可能伴随 userid 改名，必须同时支持“旧键删除 + 新键写入”。
const resolveUserEntityIds = (message = {}) => {
  const originalUserId = normalizeText(message.UserID);
  const nextUserId = normalizeText(message.NewUserID) || originalUserId;

  return {
    originalUserId,
    nextUserId,
  };
};

// resolveDepartmentId
// 是什么：部门主键解析函数。
// 做什么：从事件中提取并转为整数部门 ID。
// 为什么：部门回调的 `Id` 是本地落库主键，后续删除与更新都依赖它。
const resolveDepartmentId = (message = {}) => {
  return parseIntegerOrNull(message.Id);
};

// resolveTagId
// 是什么：标签主键解析函数。
// 做什么：从事件中提取并转为整数标签 ID。
// 为什么：标签更新与删除均通过 `TagId` 标识实体。
const resolveTagId = (message = {}) => {
  return parseIntegerOrNull(message.TagId);
};

// safeStringifyPayload
// 是什么：事件载荷安全序列化函数。
// 做什么：尽量将原始事件对象转为 JSON 文本，失败时返回错误摘要。
// 为什么：事件日志需要保留原始载荷，但对象若不可序列化也不能影响主流程。
const safeStringifyPayload = (payload) => {
  try {
    return JSON.stringify(payload || {});
  } catch (error) {
    return JSON.stringify({
      stringify_error: error.message,
    });
  }
};

// appendContactEventLog
// 是什么：通讯录事件日志写入函数。
// 做什么：将每次成功消费的变更事件写入审计表，保留类型、实体和原始载荷。
// 为什么：通讯录同步是增量事件流，保留审计日志便于排查丢事件与重放问题。
const appendContactEventLog = async ({ changeType, entityType, entityId, message }) => {
  await runSql(
    `INSERT INTO wecom_contact_event_log (
      change_type,
      entity_type,
      entity_id,
      payload_json
    ) VALUES (?, ?, ?, ?)`,
    [changeType, entityType, normalizeText(entityId), safeStringifyPayload(message)]
  );
};

// getStoredUserRow
// 是什么：成员快照读取函数。
// 做什么：按旧 userid 或新 userid 查询已存在的成员记录。
// 为什么：更新事件需要基于当前快照做字段级合并，尤其是 userid 改名场景。
const getStoredUserRow = async (originalUserId, nextUserId) => {
  if (originalUserId) {
    const originalRow = await getSql(
      `SELECT * FROM wecom_contact_users WHERE user_id = ? LIMIT 1`,
      [originalUserId]
    );
    if (originalRow) {
      return originalRow;
    }
  }

  if (nextUserId && nextUserId !== originalUserId) {
    return getSql(
      `SELECT * FROM wecom_contact_users WHERE user_id = ? LIMIT 1`,
      [nextUserId]
    );
  }

  return null;
};

// upsertContactUser
// 是什么：成员新增/更新落库函数。
// 做什么：基于回调消息和历史快照幂等写入成员信息，并处理 userid 改名。
// 为什么：通讯录更新事件可能乱序或部分字段更新，必须采用“读旧值 + 合并 + upsert”。
const upsertContactUser = async (message = {}) => {
  const { originalUserId, nextUserId } = resolveUserEntityIds(message);
  if (!nextUserId) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_user_id',
      entity_type: 'user',
      entity_id: '',
    };
  }

  const storedRow = await getStoredUserRow(originalUserId, nextUserId);
  const departmentIds = pickJsonListField(
    message,
    'Department',
    storedRow && storedRow.department_ids_json,
    parseCommaSeparatedIntegerList
  );
  const leaderFlags = pickJsonListField(
    message,
    'IsLeaderInDept',
    storedRow && storedRow.is_leader_in_dept_json,
    parseCommaSeparatedIntegerList
  );
  const directLeaderUserIds = hasOwnField(message, 'DirectLeader')
    ? parseCommaSeparatedTextList(message.DirectLeader)
    : parseStoredJsonArray(storedRow && storedRow.direct_leader_user_ids_json);

  if (originalUserId && originalUserId !== nextUserId) {
    await runSql(`DELETE FROM wecom_contact_users WHERE user_id = ?`, [originalUserId]);
  }

  await runSql(
    `INSERT INTO wecom_contact_users (
      user_id,
      name,
      department_ids_json,
      main_department,
      is_leader_in_dept_json,
      direct_leader_user_ids_json,
      position,
      mobile,
      gender,
      email,
      biz_mail,
      status,
      avatar,
      telephone,
      address,
      alias,
      qr_code,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      name = excluded.name,
      department_ids_json = excluded.department_ids_json,
      main_department = excluded.main_department,
      is_leader_in_dept_json = excluded.is_leader_in_dept_json,
      direct_leader_user_ids_json = excluded.direct_leader_user_ids_json,
      position = excluded.position,
      mobile = excluded.mobile,
      gender = excluded.gender,
      email = excluded.email,
      biz_mail = excluded.biz_mail,
      status = excluded.status,
      avatar = excluded.avatar,
      telephone = excluded.telephone,
      address = excluded.address,
      alias = excluded.alias,
      qr_code = excluded.qr_code,
      updated_at = datetime('now')`,
    [
      nextUserId,
      pickTextField(message, 'Name', storedRow && storedRow.name),
      toJsonText(departmentIds),
      pickIntegerField(message, 'MainDepartment', storedRow && storedRow.main_department),
      toJsonText(leaderFlags),
      toJsonText(directLeaderUserIds),
      pickTextField(message, 'Position', storedRow && storedRow.position),
      pickTextField(message, 'Mobile', storedRow && storedRow.mobile),
      pickIntegerField(message, 'Gender', storedRow && storedRow.gender),
      pickTextField(message, 'Email', storedRow && storedRow.email),
      pickTextField(message, 'BizMail', storedRow && storedRow.biz_mail),
      pickIntegerField(message, 'Status', storedRow && storedRow.status),
      pickTextField(message, 'Avatar', storedRow && storedRow.avatar),
      pickTextField(message, 'Telephone', storedRow && storedRow.telephone),
      pickTextField(message, 'Address', storedRow && storedRow.address),
      pickTextField(message, 'Alias', storedRow && storedRow.alias),
      pickTextField(message, 'QrCode', storedRow && storedRow.qr_code),
    ]
  );

  return {
    success: true,
    entity_type: 'user',
    entity_id: nextUserId,
  };
};

// deleteContactUser
// 是什么：成员删除落库函数。
// 做什么：按 userid 删除本地成员快照。
// 为什么：成员离职或被删除后，旧账号若继续留在本地会污染后续权限与映射逻辑。
const deleteContactUser = async (message = {}) => {
  const { originalUserId, nextUserId } = resolveUserEntityIds(message);
  const targetUserId = nextUserId || originalUserId;
  if (!targetUserId) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_user_id',
      entity_type: 'user',
      entity_id: '',
    };
  }

  await runSql(`DELETE FROM wecom_contact_users WHERE user_id = ?`, [targetUserId]);

  return {
    success: true,
    entity_type: 'user',
    entity_id: targetUserId,
  };
};

// getStoredDepartmentRow
// 是什么：部门快照读取函数。
// 做什么：按部门 ID 读取已存在的本地部门记录。
// 为什么：部门更新事件可能只携带局部字段，需要与旧快照合并。
const getStoredDepartmentRow = async (departmentId) => {
  if (departmentId === null) {
    return null;
  }

  return getSql(
    `SELECT * FROM wecom_contact_departments WHERE department_id = ? LIMIT 1`,
    [departmentId]
  );
};

// upsertContactDepartment
// 是什么：部门新增/更新落库函数。
// 做什么：将部门主数据幂等写入本地表。
// 为什么：组织架构变更是通讯录同步的基础维度，需要单独维护快照。
const upsertContactDepartment = async (message = {}) => {
  const departmentId = resolveDepartmentId(message);
  if (departmentId === null) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_department_id',
      entity_type: 'department',
      entity_id: '',
    };
  }

  const storedRow = await getStoredDepartmentRow(departmentId);

  await runSql(
    `INSERT INTO wecom_contact_departments (
      department_id,
      name,
      parent_department_id,
      order_value,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(department_id) DO UPDATE SET
      name = excluded.name,
      parent_department_id = excluded.parent_department_id,
      order_value = excluded.order_value,
      updated_at = datetime('now')`,
    [
      departmentId,
      pickTextField(message, 'Name', storedRow && storedRow.name),
      pickIntegerField(message, 'ParentId', storedRow && storedRow.parent_department_id),
      pickIntegerField(message, 'Order', storedRow && storedRow.order_value),
    ]
  );

  return {
    success: true,
    entity_type: 'department',
    entity_id: String(departmentId),
  };
};

// deleteContactDepartment
// 是什么：部门删除落库函数。
// 做什么：按部门 ID 删除本地部门快照。
// 为什么：已删除部门若残留在本地，会导致人员组织关系展示与权限判断过期。
const deleteContactDepartment = async (message = {}) => {
  const departmentId = resolveDepartmentId(message);
  if (departmentId === null) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_department_id',
      entity_type: 'department',
      entity_id: '',
    };
  }

  await runSql(`DELETE FROM wecom_contact_departments WHERE department_id = ?`, [departmentId]);

  return {
    success: true,
    entity_type: 'department',
    entity_id: String(departmentId),
  };
};

// getStoredTagRow
// 是什么：标签快照读取函数。
// 做什么：按标签 ID 查询当前本地标签记录。
// 为什么：标签事件可能是增量更新，需要读取旧值后合并成员与部门列表。
const getStoredTagRow = async (tagId) => {
  if (tagId === null) {
    return null;
  }

  return getSql(`SELECT * FROM wecom_contact_tags WHERE tag_id = ? LIMIT 1`, [tagId]);
};

// pickTagUserList
// 是什么：标签成员列表解析函数。
// 做什么：兼容不同事件里对标签成员列表的字段命名差异。
// 为什么：镜像文档与不同回调样例存在 `AddUserItems/UserItems` 命名差异，需统一兼容。
const pickTagUserList = (message, primaryKey, secondaryKey, storedValue) => {
  if (hasOwnField(message, primaryKey)) {
    return parseCommaSeparatedTextList(message[primaryKey]);
  }

  if (hasOwnField(message, secondaryKey)) {
    return parseCommaSeparatedTextList(message[secondaryKey]);
  }

  return parseStoredJsonArray(storedValue);
};

// pickTagDepartmentList
// 是什么：标签部门列表解析函数。
// 做什么：兼容不同事件里对标签部门列表的字段命名差异并转为整数数组。
// 为什么：标签事件样例字段在不同资料源中存在 `AddPartyItems/PartyItems` 差异，需要容错。
const pickTagDepartmentList = (message, primaryKey, secondaryKey, storedValue) => {
  if (hasOwnField(message, primaryKey)) {
    return parseCommaSeparatedIntegerList(message[primaryKey]);
  }

  if (hasOwnField(message, secondaryKey)) {
    return parseCommaSeparatedIntegerList(message[secondaryKey]);
  }

  return parseStoredJsonArray(storedValue);
};

// upsertContactTag
// 是什么：标签新增/更新落库函数。
// 做什么：将标签及其成员/部门增删列表幂等写入本地表。
// 为什么：标签事件会影响通讯录分组关系，需要保留最近一次有效快照以便后续查询。
const upsertContactTag = async (message = {}) => {
  const tagId = resolveTagId(message);
  if (tagId === null) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_tag_id',
      entity_type: 'tag',
      entity_id: '',
    };
  }

  const storedRow = await getStoredTagRow(tagId);

  await runSql(
    `INSERT INTO wecom_contact_tags (
      tag_id,
      name,
      add_user_items_json,
      del_user_items_json,
      add_party_items_json,
      del_party_items_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tag_id) DO UPDATE SET
      name = excluded.name,
      add_user_items_json = excluded.add_user_items_json,
      del_user_items_json = excluded.del_user_items_json,
      add_party_items_json = excluded.add_party_items_json,
      del_party_items_json = excluded.del_party_items_json,
      updated_at = datetime('now')`,
    [
      tagId,
      pickTextField(message, 'Name', storedRow && storedRow.name),
      toJsonText(pickTagUserList(message, 'AddUserItems', 'UserItems', storedRow && storedRow.add_user_items_json)),
      toJsonText(pickTagUserList(message, 'DelUserItems', 'RemoveUserItems', storedRow && storedRow.del_user_items_json)),
      toJsonText(
        pickTagDepartmentList(
          message,
          'AddPartyItems',
          'PartyItems',
          storedRow && storedRow.add_party_items_json
        )
      ),
      toJsonText(
        pickTagDepartmentList(
          message,
          'DelPartyItems',
          'RemovePartyItems',
          storedRow && storedRow.del_party_items_json
        )
      ),
    ]
  );

  return {
    success: true,
    entity_type: 'tag',
    entity_id: String(tagId),
  };
};

// deleteContactTag
// 是什么：标签删除落库函数。
// 做什么：按标签 ID 删除本地标签快照。
// 为什么：标签若已被删除仍残留在本地，会造成分组关系和统计结果失真。
const deleteContactTag = async (message = {}) => {
  const tagId = resolveTagId(message);
  if (tagId === null) {
    return {
      success: false,
      skipped: true,
      reason: 'missing_tag_id',
      entity_type: 'tag',
      entity_id: '',
    };
  }

  await runSql(`DELETE FROM wecom_contact_tags WHERE tag_id = ?`, [tagId]);

  return {
    success: true,
    entity_type: 'tag',
    entity_id: String(tagId),
  };
};

// applyContactChange
// 是什么：通讯录变更执行函数。
// 做什么：根据 `ChangeType` 选择成员、部门或标签的具体落库逻辑。
// 为什么：`change_contact` 只是总入口，具体实体处理必须分流到稳定子函数。
const applyContactChange = async (changeType, message) => {
  if (USER_UPSERT_CHANGE_TYPES.has(changeType)) {
    return upsertContactUser(message);
  }

  if (changeType === 'delete_user') {
    return deleteContactUser(message);
  }

  if (DEPARTMENT_UPSERT_CHANGE_TYPES.has(changeType)) {
    return upsertContactDepartment(message);
  }

  if (changeType === 'delete_party') {
    return deleteContactDepartment(message);
  }

  if (TAG_UPSERT_CHANGE_TYPES.has(changeType)) {
    return upsertContactTag(message);
  }

  if (changeType === 'delete_tag') {
    return deleteContactTag(message);
  }

  return {
    success: false,
    skipped: true,
    reason: 'unsupported_change_type',
    entity_type: '',
    entity_id: '',
  };
};

// handleChangeContactEvent
// 是什么：企业微信通讯录变更事件处理函数。
// 做什么：验证事件类型、执行本地幂等落库，并追加审计日志。
// 为什么：通讯录同步要求服务端能够稳定消费 `change_contact` 增量事件并形成本地快照。
const handleChangeContactEvent = async (message = {}, options = {}) => {
  const traceId = normalizeText(options.traceId) || createTraceId();
  const changeType = resolveChangeType(message);
  const entityType = CONTACT_CHANGE_ENTITY_MAP[changeType] || '';

  logWithTrace(traceId, 'contact-sync', 'change_contact.in', {
    changeType,
    entityType,
  });

  if (!entityType) {
    const unsupportedResult = {
      success: false,
      skipped: true,
      reason: 'unsupported_change_type',
      change_type: changeType,
      entity_type: '',
      entity_id: '',
    };

    logWithTrace(traceId, 'contact-sync', 'change_contact.skip', unsupportedResult);
    return unsupportedResult;
  }

  const applyResult = await applyContactChange(changeType, message);
  const finalResult = {
    ...applyResult,
    change_type: changeType,
    entity_type: applyResult.entity_type || entityType,
  };

  if (!finalResult.success) {
    logWithTrace(traceId, 'contact-sync', 'change_contact.skip', finalResult);
    return finalResult;
  }

  await appendContactEventLog({
    changeType,
    entityType: finalResult.entity_type,
    entityId: finalResult.entity_id,
    message,
  });

  logWithTrace(traceId, 'contact-sync', 'change_contact.success', finalResult);
  return finalResult;
};

module.exports = {
  handleChangeContactEvent,
};
