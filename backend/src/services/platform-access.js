const db = require('../models/db');

// normalizeText
// 是什么：平台权限服务内部文本清洗函数。
// 做什么：把任意输入转换为去首尾空白的字符串。
// 为什么：该服务位于权限核心链路，需避免与任务统计模块形成循环依赖。
const normalizeText = (value) => {
  if (Array.isArray(value)) {
    return normalizeText(value[0]);
  }

  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

// parseIdListFromEnv
// 是什么：环境变量账号列表解析函数。
// 做什么：把逗号分隔字符串解析成去重后的账号数组。
// 为什么：超级管理员和兼容的历史管理员配置都依赖稳定的账号列表解析。
const parseIdListFromEnv = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  return Array.from(
    new Set(
      normalized
        .split(',')
        .map((item) => normalizeText(item))
        .filter(Boolean)
    )
  );
};

// PLATFORM_ROLE
// 是什么：平台权限角色枚举。
// 做什么：定义超级管理员、管理员与执行对象三类平台登录身份。
// 为什么：后端接口鉴权、菜单收敛和团队统计都需要复用同一套角色口径。
const PLATFORM_ROLE = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  EXECUTOR: 'EXECUTOR',
};

// PLATFORM_MENU
// 是什么：平台菜单权限枚举。
// 做什么：声明前端主导航中可见的菜单键集合。
// 为什么：前后端需共享稳定菜单标识，避免页面侧硬编码漂移。
const PLATFORM_MENU = {
  DASHBOARD: 'DASHBOARD',
  TASKS: 'TASKS',
  CALENDAR: 'CALENDAR',
  TEAM_STATS: 'TEAM_STATS',
  SETTINGS: 'SETTINGS',
};

// PLATFORM_MENU_VALUES
// 是什么：平台菜单权限枚举值列表。
// 做什么：统一沉淀可配置菜单权限的白名单。
// 为什么：菜单权限可能来自数据库和接口入参，必须通过白名单校验防止脏数据入库。
const PLATFORM_MENU_VALUES = Object.values(PLATFORM_MENU);

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

// normalizePlatformRole
// 是什么：平台角色标准化函数。
// 做什么：将任意输入归一化到受支持的平台角色，非法值返回空串。
// 为什么：角色可来自数据库、环境变量和接口入参，必须先统一清洗再做权限判断。
const normalizePlatformRole = (value) => {
  const normalizedValue = normalizeText(value).toUpperCase();

  if (normalizedValue === PLATFORM_ROLE.SUPER_ADMIN) {
    return PLATFORM_ROLE.SUPER_ADMIN;
  }

  if (normalizedValue === PLATFORM_ROLE.ADMIN) {
    return PLATFORM_ROLE.ADMIN;
  }

  if (normalizedValue === PLATFORM_ROLE.EXECUTOR) {
    return PLATFORM_ROLE.EXECUTOR;
  }

  return '';
};

// parseBootstrapSuperAdminIds
// 是什么：超级管理员初始账号解析函数。
// 做什么：从环境变量读取超级管理员列表，缺省回退到 `admin`。
// 为什么：平台权限表可能尚未初始化，系统仍需保证首个超级管理员可登录并完成配置。
const parseBootstrapSuperAdminIds = () => {
  const configuredValue = normalizeText(process.env.SUPER_ADMIN_USERIDS || process.env.SUPER_ADMIN_USERID || 'admin');
  if (!configuredValue) {
    return ['admin'];
  }

  return Array.from(
    new Set(
      configuredValue
        .split(',')
        .map((item) => normalizeText(item))
        .filter(Boolean)
    )
  );
};

// buildMenuPermissionsByRole
// 是什么：按平台角色推导菜单权限函数。
// 做什么：输出当前身份可见的主菜单键列表。
// 为什么：前端菜单展示必须服从服务端权限模型，而不是各页面自行猜测。
const buildMenuPermissionsByRole = (platformRole) => {
  const normalizedRole = normalizePlatformRole(platformRole);

  if (normalizedRole === PLATFORM_ROLE.SUPER_ADMIN || normalizedRole === PLATFORM_ROLE.ADMIN) {
    return [
      PLATFORM_MENU.DASHBOARD,
      PLATFORM_MENU.TASKS,
      PLATFORM_MENU.CALENDAR,
      PLATFORM_MENU.TEAM_STATS,
      PLATFORM_MENU.SETTINGS,
    ];
  }

  return [PLATFORM_MENU.TASKS, PLATFORM_MENU.CALENDAR];
};

// normalizeMenuPermissionList
// 是什么：菜单权限列表标准化函数。
// 做什么：兼容数组、JSON 文本和逗号分隔文本，输出去重且合法的菜单键列表。
// 为什么：菜单权限会在数据库、接口请求和兼容链路之间流转，必须先统一格式再做权限判断。
const normalizeMenuPermissionList = (value) => {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => normalizeText(item).toUpperCase())
          .filter((item) => PLATFORM_MENU_VALUES.includes(item))
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
      return normalizeMenuPermissionList(parsed);
    }
  } catch (error) {
    // ignore invalid json text
  }

  return normalizeMenuPermissionList(
    normalizedValue
      .split(',')
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );
};

// resolveMenuPermissions
// 是什么：用户有效菜单权限解析函数。
// 做什么：根据平台角色与显式配置决定最终可见菜单集合。
// 为什么：超级管理员固定全量菜单，管理员允许定制，执行对象必须锁定为“任务列表 + 日历日程”。
const resolveMenuPermissions = (platformRole, storedMenuPermissions) => {
  const normalizedRole = normalizePlatformRole(platformRole);

  if (normalizedRole === PLATFORM_ROLE.SUPER_ADMIN) {
    return buildMenuPermissionsByRole(PLATFORM_ROLE.SUPER_ADMIN);
  }

  if (normalizedRole === PLATFORM_ROLE.ADMIN) {
    const normalizedMenuPermissions = normalizeMenuPermissionList(storedMenuPermissions);
    return normalizedMenuPermissions.length > 0
      ? normalizedMenuPermissions
      : buildMenuPermissionsByRole(PLATFORM_ROLE.ADMIN);
  }

  return buildMenuPermissionsByRole(PLATFORM_ROLE.EXECUTOR);
};

// isAdminRole
// 是什么：管理权限角色判定函数。
// 做什么：判断给定平台角色是否具备管理员能力。
// 为什么：接口鉴权经常只关心“是否管理员”，不应到处写重复枚举判断。
const isAdminRole = (platformRole) => {
  const normalizedRole = normalizePlatformRole(platformRole);
  return normalizedRole === PLATFORM_ROLE.SUPER_ADMIN || normalizedRole === PLATFORM_ROLE.ADMIN;
};

// listStoredPlatformAccessRows
// 是什么：平台权限表全量读取函数。
// 做什么：返回数据库中显式配置过的用户权限行。
// 为什么：系统管理页和团队统计都需要读取全量显式角色分配结果。
const listStoredPlatformAccessRows = async () => {
  return allSql(
    `SELECT user_id, platform_role, menu_permissions_json, updated_by_userid, created_at, updated_at
       FROM platform_user_access
       ORDER BY datetime(updated_at) DESC, user_id ASC`
  );
};

// getStoredPlatformAccessRow
// 是什么：单用户平台权限读取函数。
// 做什么：按 user_id 查找数据库中显式分配的平台角色。
// 为什么：请求鉴权需要先看是否有手动配置，再决定是否回退默认角色。
const getStoredPlatformAccessRow = async (userId) => {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) {
    return null;
  }

  return getSql(
    `SELECT user_id, platform_role, menu_permissions_json, updated_by_userid, created_at, updated_at
       FROM platform_user_access
      WHERE user_id = ?
      LIMIT 1`,
    [normalizedUserId]
  );
};

// getEffectivePlatformAccess
// 是什么：用户有效平台权限解析函数。
// 做什么：综合超级管理员引导配置、数据库配置和历史验收人环境变量，生成最终权限结果。
// 为什么：权限模型从旧配置迁移到新表期间，需要兼容旧环境并保证角色实时生效。
const getEffectivePlatformAccess = async (userId) => {
  const normalizedUserId = normalizeText(userId);
  const bootstrapSuperAdminIds = new Set(parseBootstrapSuperAdminIds());
  const globalVerifierIds = new Set(parseIdListFromEnv(process.env.GLOBAL_VERIFIERS || ''));
  const storedRow = await getStoredPlatformAccessRow(normalizedUserId);
  const storedRole = normalizePlatformRole(storedRow && storedRow.platform_role);

  let platformRole = PLATFORM_ROLE.EXECUTOR;
  if (bootstrapSuperAdminIds.has(normalizedUserId)) {
    platformRole = PLATFORM_ROLE.SUPER_ADMIN;
  } else if (storedRole) {
    platformRole = storedRole;
  } else if (globalVerifierIds.has(normalizedUserId)) {
    platformRole = PLATFORM_ROLE.ADMIN;
  }

  return {
    user_id: normalizedUserId,
    platform_role: platformRole,
    is_super_admin: platformRole === PLATFORM_ROLE.SUPER_ADMIN,
    is_admin: isAdminRole(platformRole),
    menu_permissions: resolveMenuPermissions(platformRole, storedRow && storedRow.menu_permissions_json),
    source:
      platformRole === PLATFORM_ROLE.SUPER_ADMIN && bootstrapSuperAdminIds.has(normalizedUserId)
        ? 'bootstrap_super_admin'
        : storedRole
        ? 'stored'
        : globalVerifierIds.has(normalizedUserId)
        ? 'legacy_global_verifier'
        : 'default_executor',
    created_at: storedRow && storedRow.created_at,
    updated_at: storedRow && storedRow.updated_at,
    updated_by_userid: storedRow && storedRow.updated_by_userid,
  };
};

// upsertPlatformAccessRow
// 是什么：平台权限写入函数。
// 做什么：按 user_id 插入或更新显式角色分配，并记录操作人。
// 为什么：超级管理员需要在系统管理页内直接调整管理员与执行对象权限。
const upsertPlatformAccessRow = async ({ userId, platformRole, updatedByUserId }) => {
  const normalizedUserId = normalizeText(userId);
  const normalizedRole = normalizePlatformRole(platformRole);
  const normalizedUpdatedByUserId = normalizeText(updatedByUserId);
  const existingRow = await getStoredPlatformAccessRow(normalizedUserId);

  if (!normalizedUserId || !normalizedRole || normalizedRole === PLATFORM_ROLE.SUPER_ADMIN) {
    return null;
  }

  const nextMenuPermissionsJson =
    normalizedRole === PLATFORM_ROLE.ADMIN
      ? normalizeText(existingRow && existingRow.menu_permissions_json) || '[]'
      : '[]';

  await runSql(
    `INSERT INTO platform_user_access (
      user_id,
      platform_role,
      menu_permissions_json,
      updated_by_userid,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      platform_role = excluded.platform_role,
      menu_permissions_json = excluded.menu_permissions_json,
      updated_by_userid = excluded.updated_by_userid,
      updated_at = datetime('now')`,
    [normalizedUserId, normalizedRole, nextMenuPermissionsJson, normalizedUpdatedByUserId]
  );

  return getEffectivePlatformAccess(normalizedUserId);
};

// updatePlatformMenuPermissions
// 是什么：平台菜单权限更新函数。
// 做什么：为指定管理员写入显式菜单集合，并记录操作人。
// 为什么：超级管理员需要在系统设置页中按人裁剪菜单，而不是只能依赖固定角色映射。
const updatePlatformMenuPermissions = async ({ userId, menuPermissions, updatedByUserId }) => {
  const normalizedUserId = normalizeText(userId);
  const normalizedUpdatedByUserId = normalizeText(updatedByUserId);
  const normalizedMenuPermissions = normalizeMenuPermissionList(menuPermissions);
  const access = await getEffectivePlatformAccess(normalizedUserId);

  if (!normalizedUserId || access.is_super_admin || access.platform_role !== PLATFORM_ROLE.ADMIN) {
    return null;
  }

  if (normalizedMenuPermissions.length === 0) {
    return null;
  }

  await runSql(
    `INSERT INTO platform_user_access (
      user_id,
      platform_role,
      menu_permissions_json,
      updated_by_userid,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      platform_role = excluded.platform_role,
      menu_permissions_json = excluded.menu_permissions_json,
      updated_by_userid = excluded.updated_by_userid,
      updated_at = datetime('now')`,
    [
      normalizedUserId,
      PLATFORM_ROLE.ADMIN,
      JSON.stringify(normalizedMenuPermissions),
      normalizedUpdatedByUserId,
    ]
  );

  return getEffectivePlatformAccess(normalizedUserId);
};

// resolvePlatformRoleMap
// 是什么：多用户角色索引构建函数。
// 做什么：为给定用户 ID 列表一次性计算有效平台角色映射。
// 为什么：团队统计会批量读取创建人与执行人角色，逐条查询会造成不必要的数据库往返。
const resolvePlatformRoleMap = async (userIds = []) => {
  const normalizedUserIds = Array.from(
    new Set((Array.isArray(userIds) ? userIds : []).map((item) => normalizeText(item)).filter(Boolean))
  );
  const roleMap = new Map();

  if (normalizedUserIds.length === 0) {
    return roleMap;
  }

  const storedRows = await allSql(
    `SELECT user_id, platform_role
       FROM platform_user_access
      WHERE user_id IN (${normalizedUserIds.map(() => '?').join(', ')})`,
    normalizedUserIds
  );
  const storedRoleMap = new Map(
    storedRows.map((item) => [normalizeText(item && item.user_id), normalizePlatformRole(item && item.platform_role)])
  );
  const bootstrapSuperAdminIds = new Set(parseBootstrapSuperAdminIds());
  const globalVerifierIds = new Set(parseIdListFromEnv(process.env.GLOBAL_VERIFIERS || ''));

  normalizedUserIds.forEach((userId) => {
    let platformRole = PLATFORM_ROLE.EXECUTOR;

    if (bootstrapSuperAdminIds.has(userId)) {
      platformRole = PLATFORM_ROLE.SUPER_ADMIN;
    } else if (storedRoleMap.get(userId)) {
      platformRole = storedRoleMap.get(userId);
    } else if (globalVerifierIds.has(userId)) {
      platformRole = PLATFORM_ROLE.ADMIN;
    }

    roleMap.set(userId, platformRole);
  });

  return roleMap;
};

module.exports = {
  PLATFORM_ROLE,
  PLATFORM_MENU,
  normalizePlatformRole,
  normalizeMenuPermissionList,
  parseBootstrapSuperAdminIds,
  buildMenuPermissionsByRole,
  resolveMenuPermissions,
  isAdminRole,
  listStoredPlatformAccessRows,
  getStoredPlatformAccessRow,
  getEffectivePlatformAccess,
  upsertPlatformAccessRow,
  updatePlatformMenuPermissions,
  resolvePlatformRoleMap,
};
