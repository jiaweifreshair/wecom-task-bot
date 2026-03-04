const { normalizeText } = require('./task-lifecycle');

// TASK_QUERY_SCOPE
// 是什么：任务查询视角枚举常量。
// 做什么：统一定义任务接口支持的 `SELF/TEAM` 两种数据范围语义。
// 为什么：避免路由层散落字符串判断，确保权限策略可复用且可测试。
const TASK_QUERY_SCOPE = {
  SELF: 'SELF',
  TEAM: 'TEAM',
};

// normalizeScopeValue
// 是什么：查询视角标准化函数。
// 做什么：将输入 scope 统一为大写并将 `ALL` 兼容映射为 `TEAM`。
// 为什么：前端或运维可能传入历史值 `all`，需要保证后端策略判断口径一致。
const normalizeScopeValue = (rawScope) => {
  const normalizedScope = normalizeText(rawScope).toUpperCase();

  if (normalizedScope === 'ALL') {
    return TASK_QUERY_SCOPE.TEAM;
  }

  if (normalizedScope === TASK_QUERY_SCOPE.SELF) {
    return TASK_QUERY_SCOPE.SELF;
  }

  if (normalizedScope === TASK_QUERY_SCOPE.TEAM) {
    return TASK_QUERY_SCOPE.TEAM;
  }

  return '';
};

// isGlobalVerifierUser
// 是什么：全局验收人身份判定函数。
// 做什么：判断当前用户是否在 `GLOBAL_VERIFIERS` 列表中。
// 为什么：团队级任务可见范围应与验收权限口径一致，避免“可验收却看不到任务”。
const isGlobalVerifierUser = (currentUserId, globalVerifiers = []) => {
  const normalizedUserId = normalizeText(currentUserId);
  if (!normalizedUserId) {
    return false;
  }

  const verifierSet = new Set(
    (Array.isArray(globalVerifiers) ? globalVerifiers : [])
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );

  return verifierSet.has(normalizedUserId);
};

// resolveTaskQueryScope
// 是什么：任务查询范围决策函数。
// 做什么：根据请求 scope、当前用户与全局验收人配置，输出最终查询策略。
// 为什么：将权限判断从路由抽离，保证任务列表与 KPI 接口使用同一策略，降低偏差风险。
const resolveTaskQueryScope = (options = {}) => {
  const currentUserId = normalizeText(options.currentUserId);
  const normalizedGlobalVerifiers = (Array.isArray(options.globalVerifiers) ? options.globalVerifiers : [])
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const requestedScope = normalizeScopeValue(options.requestedScope);
  const hasGlobalVerifierConfig = normalizedGlobalVerifiers.length > 0;
  const userIsGlobalVerifier = isGlobalVerifierUser(currentUserId, normalizedGlobalVerifiers);
  const teamScopeAllowed = !hasGlobalVerifierConfig || userIsGlobalVerifier;

  if (requestedScope === TASK_QUERY_SCOPE.SELF) {
    return {
      restrictToCurrentUser: true,
      resolvedScope: TASK_QUERY_SCOPE.SELF,
      userIsGlobalVerifier,
      teamScopeAllowed,
    };
  }

  if (requestedScope === TASK_QUERY_SCOPE.TEAM) {
    return {
      restrictToCurrentUser: !teamScopeAllowed,
      resolvedScope: teamScopeAllowed ? TASK_QUERY_SCOPE.TEAM : TASK_QUERY_SCOPE.SELF,
      userIsGlobalVerifier,
      teamScopeAllowed,
    };
  }

  return {
    restrictToCurrentUser: !teamScopeAllowed,
    resolvedScope: teamScopeAllowed ? TASK_QUERY_SCOPE.TEAM : TASK_QUERY_SCOPE.SELF,
    userIsGlobalVerifier,
    teamScopeAllowed,
  };
};

module.exports = {
  TASK_QUERY_SCOPE,
  normalizeScopeValue,
  isGlobalVerifierUser,
  resolveTaskQueryScope,
};
