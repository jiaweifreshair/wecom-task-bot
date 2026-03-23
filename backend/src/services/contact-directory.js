const db = require('../models/db');
const wecom = require('./wecom');
const { normalizeText } = require('./task-lifecycle');
const { getEffectivePlatformAccess } = require('./platform-access');

const allSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows || []);
    });
  });
};

const runSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID,
      });
    });
  });
};

// parseStoredDepartmentIds
// 是什么：通讯录成员部门列表解析函数。
// 做什么：兼容 JSON 文本、数组与逗号分隔字符串，输出去重后的正整数部门 ID 列表。
// 为什么：系统管理筛选要同时兼容历史快照与新快照格式，避免部门过滤口径漂移。
const parseStoredDepartmentIds = (value) => {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0)
      )
    );
  }

  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalizedValue);
    if (Array.isArray(parsed)) {
      return parseStoredDepartmentIds(parsed);
    }
  } catch (error) {
    // ignore invalid json text
  }

  return parseStoredDepartmentIds(
    normalizedValue
      .split(',')
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
  );
};

// buildDepartmentScope
// 是什么：系统管理部门过滤范围解析函数。
// 做什么：根据目标部门与“包含子部门”开关计算匹配范围。
// 为什么：系统设置页的部门筛选必须与企微部门树语义对齐，而不是只按单个部门精确匹配。
const buildDepartmentScope = async (departmentId, fetchChild) => {
  const targetDepartmentId = Number(departmentId || 0);
  if (!Number.isInteger(targetDepartmentId) || targetDepartmentId <= 0) {
    return new Set();
  }

  if (!fetchChild) {
    return new Set([targetDepartmentId]);
  }

  const rows = await allSql(
    `SELECT department_id, parent_department_id
       FROM wecom_contact_departments`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return targetDepartmentId === 1 ? new Set() : new Set([targetDepartmentId]);
  }

  const childMap = new Map();
  rows.forEach((row) => {
    const departmentRowId = Number(row && row.department_id);
    const parentDepartmentId = Number(row && row.parent_department_id);
    if (!Number.isInteger(departmentRowId) || departmentRowId <= 0) {
      return;
    }

    if (!Number.isInteger(parentDepartmentId) || parentDepartmentId <= 0) {
      return;
    }

    const children = childMap.get(parentDepartmentId) || [];
    children.push(departmentRowId);
    childMap.set(parentDepartmentId, children);
  });

  const scope = new Set([targetDepartmentId]);
  if (targetDepartmentId === 1) {
    rows.forEach((row) => {
      const departmentRowId = Number(row && row.department_id);
      if (Number.isInteger(departmentRowId) && departmentRowId > 0) {
        scope.add(departmentRowId);
      }
    });
  }

  const queue = [targetDepartmentId];
  while (queue.length > 0) {
    const currentDepartmentId = queue.shift();
    const children = childMap.get(currentDepartmentId) || [];
    children.forEach((childDepartmentId) => {
      if (scope.has(childDepartmentId)) {
        return;
      }

      scope.add(childDepartmentId);
      queue.push(childDepartmentId);
    });
  }

  return scope;
};

// toJsonText
// 是什么：数组 JSON 文本序列化函数。
// 做什么：将数组值安全序列化为数据库可存储的 JSON 字符串。
// 为什么：通讯录部门字段在本地快照表中使用 JSON 文本保存，写入时必须统一格式。
const toJsonText = (value) => {
  try {
    return JSON.stringify(Array.isArray(value) ? value : []);
  } catch (error) {
    return '[]';
  }
};

// normalizeDepartmentIds
// 是什么：部门 ID 列表清洗函数。
// 做什么：兼容数组与单值输入，输出去重后的正整数部门列表。
// 为什么：企微成员部门字段可能在不同调用路径下呈现不同形态，需要稳定入库。
const normalizeDepartmentIds = (value) => {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [value])
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  );
};

// upsertContactUsersFromWecomList
// 是什么：企微成员列表落库函数。
// 做什么：把 `/user/list` 返回的成员快照批量写入 `wecom_contact_users`。
// 为什么：系统管理页需要一个可持续复用的本地通讯录快照，而不是每次直接依赖企微接口。
const upsertContactUsersFromWecomList = async (userRows = []) => {
  let syncedCount = 0;

  for (const row of Array.isArray(userRows) ? userRows : []) {
    const userId = normalizeText(row && (row.userid || row.user_id));
    if (!userId) {
      continue;
    }

    const departmentIds = normalizeDepartmentIds(row && row.department);

    await runSql(
      `INSERT INTO wecom_contact_users (
        user_id,
        name,
        department_ids_json,
        main_department,
        position,
        mobile,
        email,
        alias,
        status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        name = excluded.name,
        department_ids_json = excluded.department_ids_json,
        main_department = excluded.main_department,
        position = excluded.position,
        mobile = excluded.mobile,
        email = excluded.email,
        alias = excluded.alias,
        status = excluded.status,
        updated_at = datetime('now')`,
      [
        userId,
        normalizeText(row && row.name),
        toJsonText(departmentIds),
        departmentIds[0] || null,
        normalizeText(row && row.position),
        normalizeText(row && row.mobile),
        normalizeText(row && row.email),
        normalizeText(row && row.alias),
        Number.isFinite(Number(row && row.status)) ? Number(row && row.status) : 1,
      ]
    );

    syncedCount += 1;
  }

  return syncedCount;
};

// pullAllContactsToLocalSnapshot
// 是什么：全量通讯录拉取函数。
// 做什么：从企微根部门递归拉取全量成员并写入本地快照。
// 为什么：系统管理页需要一键刷新通讯录，以便后续角色分配基于最新组织成员。
const pullAllContactsToLocalSnapshot = async () => {
  const result = await wecom.listUsersByDepartment(1, 1, 0);
  const errcode = Number(result && result.errcode);

  if (errcode !== 0) {
    return {
      success: false,
      errcode,
      errmsg: normalizeText(result && result.errmsg) || '拉取通讯录失败',
      synced_count: 0,
    };
  }

  const syncedCount = await upsertContactUsersFromWecomList(result && result.userlist);
  return {
    success: true,
    errcode: 0,
    errmsg: 'ok',
    synced_count: syncedCount,
  };
};

// listSystemUsers
// 是什么：系统管理用户列表查询函数。
// 做什么：从本地通讯录、日历映射和权限表汇总成员数据，并支持分页与关键字过滤。
// 为什么：系统管理页需要一次请求拿到“成员信息 + 当前平台权限 + 日历绑定”。
const listSystemUsers = async (options = {}) => {
  const keyword = normalizeText(options.keyword);
  const roleFilter = normalizeText(options.platformRole).toUpperCase();
  const departmentScope = await buildDepartmentScope(options.departmentId, Number(options.fetchChild || 1) !== 0);
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 20)));

  // querySystemUserSnapshotRows
  // 是什么：系统管理成员快照查询函数。
  // 做什么：从本地通讯录快照、部门表与日历映射表读取系统设置页所需基础行。
  // 为什么：首次加载可能需要在自动补拉通讯录前后复用同一查询逻辑，避免 SQL 漂移。
  const querySystemUserSnapshotRows = async () => {
    return allSql(
      `SELECT
         users.user_id,
         users.name,
         users.position,
         users.mobile,
         users.email,
         users.alias,
         users.status,
         users.main_department,
         users.department_ids_json,
         departments.name AS main_department_name,
         users.updated_at AS contact_updated_at,
         mappings.cal_id,
         mappings.calendar_summary,
         mappings.source AS calendar_source
       FROM wecom_contact_users AS users
       LEFT JOIN wecom_contact_departments AS departments
         ON departments.department_id = users.main_department
       LEFT JOIN user_calendar_map AS mappings
         ON mappings.user_id = users.user_id
       ORDER BY users.name COLLATE NOCASE ASC, users.user_id ASC`
    );
  };

  let rows = await querySystemUserSnapshotRows();

  // autoHydrateSystemUsersSnapshot
  // 是什么：系统管理通讯录自动补拉分支。
  // 做什么：当本地成员快照为空时，自动回源企微拉取一次并立即重查本地快照。
  // 为什么：系统设置页是权限管理入口，不能要求管理员首次进入前必须手工点一次“拉取通讯录”。
  if (rows.length === 0) {
    const syncResult = await pullAllContactsToLocalSnapshot();
    if (syncResult && syncResult.success) {
      rows = await querySystemUserSnapshotRows();
    }
  }

  const enrichedRows = [];
  for (const row of rows) {
    const access = await getEffectivePlatformAccess(row && row.user_id);
    enrichedRows.push({
      user_id: normalizeText(row && row.user_id),
      name: normalizeText(row && row.name),
      position: normalizeText(row && row.position),
      mobile: normalizeText(row && row.mobile),
      email: normalizeText(row && row.email),
      alias: normalizeText(row && row.alias),
      status: Number(row && row.status) || 0,
      main_department: Number(row && row.main_department) || 0,
      main_department_name: normalizeText(row && row.main_department_name),
      department_ids_json: normalizeText(row && row.department_ids_json) || '[]',
      cal_id: normalizeText(row && row.cal_id),
      calendar_summary: normalizeText(row && row.calendar_summary),
      calendar_source: normalizeText(row && row.calendar_source),
      platform_role: access.platform_role,
      is_super_admin: access.is_super_admin,
      is_admin: access.is_admin,
      menu_permissions: access.menu_permissions,
      access_source: access.source,
      contact_updated_at: row && row.contact_updated_at,
    });
  }

  const filteredRows = enrichedRows.filter((row) => {
    if (departmentScope.size > 0) {
      const departmentIds = new Set(parseStoredDepartmentIds(row && row.department_ids_json));
      if (Number(row && row.main_department) > 0) {
        departmentIds.add(Number(row.main_department));
      }

      if (departmentIds.size === 0) {
        return false;
      }

      const matched = Array.from(departmentIds).some((item) => departmentScope.has(item));
      if (!matched) {
        return false;
      }
    }

    if (roleFilter && row.platform_role !== roleFilter) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    const searchText = [
      row.user_id,
      row.name,
      row.position,
      row.mobile,
      row.email,
      row.alias,
      row.calendar_summary,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return searchText.includes(keyword.toLowerCase());
  });

  const total = filteredRows.length;
  const offset = (page - 1) * pageSize;
  const pagedRows = filteredRows.slice(offset, offset + pageSize);

  return {
    users: pagedRows,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: total > 0 ? Math.ceil(total / pageSize) : 1,
    },
  };
};

// listSystemDepartments
// 是什么：系统管理部门树查询函数。
// 做什么：读取本地部门快照并按树形顺序输出带层级的扁平列表。
// 为什么：前端系统设置页需要在不额外拼树的前提下快速渲染部门筛选器。
const listSystemDepartments = async () => {
  const departmentRows = await allSql(
    `SELECT department_id, name, parent_department_id, order_value
       FROM wecom_contact_departments
      ORDER BY order_value ASC, department_id ASC`
  );
  const memberRows = await allSql(
    `SELECT main_department, COUNT(*) AS member_count
       FROM wecom_contact_users
      GROUP BY main_department`
  );

  const memberCountMap = new Map(
    memberRows.map((item) => [Number(item && item.main_department) || 0, Number(item && item.member_count) || 0])
  );
  const normalizedRows = departmentRows
    .map((row) => ({
      department_id: Number(row && row.department_id) || 0,
      name: normalizeText(row && row.name),
      parent_department_id: Number(row && row.parent_department_id) || 0,
      order_value: Number(row && row.order_value) || 0,
    }))
    .filter((row) => row.department_id > 0);
  const departmentIdSet = new Set(normalizedRows.map((row) => row.department_id));
  const childMap = new Map();

  normalizedRows.forEach((row) => {
    const parentId = row.parent_department_id;
    const children = childMap.get(parentId) || [];
    children.push(row);
    childMap.set(parentId, children);
  });

  childMap.forEach((children) => {
    children.sort((left, right) => {
      if (left.order_value !== right.order_value) {
        return left.order_value - right.order_value;
      }

      return left.department_id - right.department_id;
    });
  });

  const flattenedRows = [];
  const visitedDepartmentIds = new Set();
  const traverse = (row, level) => {
    if (!row || visitedDepartmentIds.has(row.department_id)) {
      return;
    }

    visitedDepartmentIds.add(row.department_id);
    flattenedRows.push({
      department_id: row.department_id,
      name: row.name,
      parent_department_id: row.parent_department_id,
      order_value: row.order_value,
      level,
      member_count: memberCountMap.get(row.department_id) || 0,
    });

    const children = childMap.get(row.department_id) || [];
    children.forEach((child) => traverse(child, level + 1));
  };

  normalizedRows
    .filter((row) => row.parent_department_id <= 0 || !departmentIdSet.has(row.parent_department_id))
    .forEach((row) => traverse(row, 0));
  normalizedRows.forEach((row) => traverse(row, 0));

  return flattenedRows;
};

module.exports = {
  pullAllContactsToLocalSnapshot,
  listSystemUsers,
  listSystemDepartments,
};
