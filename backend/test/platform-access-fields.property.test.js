const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// platform-access.js 顶层 require('../models/db') 会触发 sqlite3 native 模块加载。
// 在未编译 native 绑定的环境中，提前注入一个空的 db stub 避免加载失败。
const Module = require('node:module');
const originalResolveFilename = Module._resolveFilename;
const dbStub = { all: () => {}, get: () => {}, run: () => {} };
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '../models/db' && parent && parent.filename && parent.filename.includes('platform-access')) {
    return '__db_stub__';
  }
  return originalResolveFilename.call(this, request, parent, ...rest);
};
require.cache.__db_stub__ = { id: '__db_stub__', filename: '__db_stub__', loaded: true, exports: dbStub };

const {
  PLATFORM_ROLE,
  normalizePlatformRole,
  isAdminRole,
  resolveMenuPermissions,
  buildMenuPermissionsByRole,
} = require('../src/services/platform-access');

// 恢复原始 _resolveFilename
Module._resolveFilename = originalResolveFilename;

// ---------------------------------------------------------------------------
// Property 7: 平台权限返回字段完整性
// **Validates: Requirements 3.7**
//
// 使用 fast-check 生成随机用户输入，验证平台权限相关纯函数返回对象字段完整且值域合法。
// 由于 getEffectivePlatformAccess 依赖数据库，此处测试构成其返回值的纯函数链：
//   normalizePlatformRole → isAdminRole / buildMenuPermissionsByRole / resolveMenuPermissions
// 以及 buildApiUserProfile 的等价逻辑（该函数未导出，在此复现其核心行为）。
// ---------------------------------------------------------------------------

const VALID_ROLES = [PLATFORM_ROLE.SUPER_ADMIN, PLATFORM_ROLE.ADMIN, PLATFORM_ROLE.EXECUTOR];

/**
 * Arbitrary: 生成合法的平台角色字符串
 */
const validRoleArb = fc.constantFrom(...VALID_ROLES);

/**
 * Arbitrary: 生成随机 userId（非空字符串）
 */
const userIdArb = fc.stringMatching(/^[a-zA-Z0-9_]{1,30}$/);

/**
 * Arbitrary: 生成随机输入（可能是合法角色、非法字符串、null、undefined 等）
 */
const anyRoleInputArb = fc.oneof(
  validRoleArb,
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
  fc.constant('  ADMIN  '),
  fc.constant('super_admin'),
  fc.constant('executor'),
  fc.constant('UNKNOWN_ROLE')
);

/**
 * 复现 buildApiUserProfile 核心逻辑（api.js 中未导出）
 * 模拟 authenticateToken 中间件 + buildApiUserProfile 的完整链路
 */
function buildProfileFromRole(platformRole) {
  const normalizedRole = normalizePlatformRole(platformRole) || PLATFORM_ROLE.EXECUTOR;
  return {
    platform_role: normalizedRole,
    is_admin: isAdminRole(normalizedRole),
    is_super_admin: normalizedRole === PLATFORM_ROLE.SUPER_ADMIN,
    menu_permissions: resolveMenuPermissions(normalizedRole, null),
  };
}

// ---------------------------------------------------------------------------
// 属性 7.1: 对任意合法角色，buildProfileFromRole 始终返回全部 4 个必需字段
// ---------------------------------------------------------------------------
test('Property 7.1: 合法角色输入始终返回 platform_role, is_admin, is_super_admin, menu_permissions 四个字段', () => {
  fc.assert(
    fc.property(validRoleArb, (role) => {
      const profile = buildProfileFromRole(role);

      assert.ok('platform_role' in profile, '缺少 platform_role 字段');
      assert.ok('is_admin' in profile, '缺少 is_admin 字段');
      assert.ok('is_super_admin' in profile, '缺少 is_super_admin 字段');
      assert.ok('menu_permissions' in profile, '缺少 menu_permissions 字段');
    }),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.2: platform_role 始终为三个合法值之一
// ---------------------------------------------------------------------------
test('Property 7.2: platform_role 始终为 SUPER_ADMIN, ADMIN, EXECUTOR 之一', () => {
  fc.assert(
    fc.property(anyRoleInputArb, (roleInput) => {
      const profile = buildProfileFromRole(roleInput);

      assert.ok(
        VALID_ROLES.includes(profile.platform_role),
        `platform_role "${profile.platform_role}" 不在合法值域内`
      );
    }),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.3: is_admin 和 is_super_admin 始终为布尔值
// ---------------------------------------------------------------------------
test('Property 7.3: is_admin 和 is_super_admin 始终为布尔值', () => {
  fc.assert(
    fc.property(anyRoleInputArb, (roleInput) => {
      const profile = buildProfileFromRole(roleInput);

      assert.strictEqual(typeof profile.is_admin, 'boolean', 'is_admin 应为布尔值');
      assert.strictEqual(typeof profile.is_super_admin, 'boolean', 'is_super_admin 应为布尔值');
    }),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.4: menu_permissions 始终为数组
// ---------------------------------------------------------------------------
test('Property 7.4: menu_permissions 始终为数组', () => {
  fc.assert(
    fc.property(anyRoleInputArb, (roleInput) => {
      const profile = buildProfileFromRole(roleInput);

      assert.ok(Array.isArray(profile.menu_permissions), 'menu_permissions 应为数组');
    }),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.5: SUPER_ADMIN 角色 → is_admin=true, is_super_admin=true
// ---------------------------------------------------------------------------
test('Property 7.5: SUPER_ADMIN 角色时 is_admin 和 is_super_admin 均为 true', () => {
  fc.assert(
    fc.property(userIdArb, (_userId) => {
      const profile = buildProfileFromRole(PLATFORM_ROLE.SUPER_ADMIN);

      assert.strictEqual(profile.is_admin, true, 'SUPER_ADMIN 的 is_admin 应为 true');
      assert.strictEqual(profile.is_super_admin, true, 'SUPER_ADMIN 的 is_super_admin 应为 true');
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.6: ADMIN 角色 → is_admin=true, is_super_admin=false
// ---------------------------------------------------------------------------
test('Property 7.6: ADMIN 角色时 is_admin=true, is_super_admin=false', () => {
  fc.assert(
    fc.property(userIdArb, (_userId) => {
      const profile = buildProfileFromRole(PLATFORM_ROLE.ADMIN);

      assert.strictEqual(profile.is_admin, true, 'ADMIN 的 is_admin 应为 true');
      assert.strictEqual(profile.is_super_admin, false, 'ADMIN 的 is_super_admin 应为 false');
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.7: EXECUTOR 角色 → is_admin=false, is_super_admin=false
// ---------------------------------------------------------------------------
test('Property 7.7: EXECUTOR 角色时 is_admin 和 is_super_admin 均为 false', () => {
  fc.assert(
    fc.property(userIdArb, (_userId) => {
      const profile = buildProfileFromRole(PLATFORM_ROLE.EXECUTOR);

      assert.strictEqual(profile.is_admin, false, 'EXECUTOR 的 is_admin 应为 false');
      assert.strictEqual(profile.is_super_admin, false, 'EXECUTOR 的 is_super_admin 应为 false');
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.8: normalizePlatformRole 对任意输入只返回合法角色或空串
// ---------------------------------------------------------------------------
test('Property 7.8: normalizePlatformRole 对任意输入只返回合法角色或空串', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined)), (input) => {
      const result = normalizePlatformRole(input);

      assert.ok(
        VALID_ROLES.includes(result) || result === '',
        `normalizePlatformRole 返回非法值: "${result}"`
      );
    }),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 属性 7.9: buildMenuPermissionsByRole 对任意合法角色返回非空数组
// ---------------------------------------------------------------------------
test('Property 7.9: buildMenuPermissionsByRole 对合法角色始终返回非空数组', () => {
  fc.assert(
    fc.property(validRoleArb, (role) => {
      const menus = buildMenuPermissionsByRole(role);

      assert.ok(Array.isArray(menus), '应返回数组');
      assert.ok(menus.length > 0, '合法角色的菜单权限不应为空');
    }),
    { numRuns: 100 }
  );
});
