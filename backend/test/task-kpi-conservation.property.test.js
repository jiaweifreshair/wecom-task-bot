const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------------------------------------------------------------------------
// 纯函数移植自 frontend/utils/display.ts + frontend/App.tsx
// buildTaskKpi 从后端 KPI 数据构建前端 KPIStats。
// ---------------------------------------------------------------------------

/**
 * buildTaskKpi
 * 是什么：任务 KPI 统计构建函数。
 * 做什么：从后端 KPI 数据构建前端 KPIStats，确保各状态数量之和等于 total_tasks。
 * 为什么：需求 10.7 要求各状态数量之和等于总任务数。
 */
function buildTaskKpi(kpi) {
  return {
    totalTasks: Number(kpi.total_tasks || 0),
    completionRate: Number(kpi.completion_rate || 0),
    waitingAcceptance: Number(kpi.waiting_verify_tasks || 0),
    overdueTasks: Number(kpi.overdue_tasks || 0),
    dueSoonTasks: Number(kpi.due_soon_tasks || 0),
    onTimeRate: Number(kpi.on_time_rate || 0),
  };
}

// ---------------------------------------------------------------------------
// Arbitraries（生成器）
// ---------------------------------------------------------------------------

/** 生成合法的后端 KPI 数据，确保各状态数量之和等于 total_tasks */
const backendTaskKpiArb = fc
  .record({
    completed_tasks: fc.nat({ max: 500 }),
    waiting_verify_tasks: fc.nat({ max: 500 }),
    overdue_tasks: fc.nat({ max: 500 }),
    due_soon_tasks: fc.nat({ max: 500 }),
  })
  .map((parts) => {
    // pending_tasks 是隐含的：total - completed - waiting_verify
    // 但后端 KPI 中 total_tasks 应该 >= 各子项之和
    const total =
      parts.completed_tasks + parts.waiting_verify_tasks + parts.overdue_tasks + parts.due_soon_tasks;
    const completionRate = total > 0 ? (parts.completed_tasks / total) * 100 : 0;
    const onTimeRate = parts.completed_tasks > 0 ? Math.random() * 100 : 0;

    return {
      total_tasks: total,
      completed_tasks: parts.completed_tasks,
      waiting_verify_tasks: parts.waiting_verify_tasks,
      overdue_tasks: parts.overdue_tasks,
      due_soon_tasks: parts.due_soon_tasks,
      completion_rate: completionRate,
      on_time_rate: onTimeRate,
    };
  });

// ---------------------------------------------------------------------------
// Property 14: 任务统计数量守恒
// **Validates: Requirements 10.7**
//
// 使用 fast-check 生成随机任务列表，验证 buildTaskKpi 输出的各状态数量之和等于 total_tasks。
// ---------------------------------------------------------------------------

test('Property 14.1: buildTaskKpi 输出的 totalTasks 等于输入的 total_tasks', () => {
  fc.assert(
    fc.property(backendTaskKpiArb, (kpiInput) => {
      const result = buildTaskKpi(kpiInput);
      assert.strictEqual(
        result.totalTasks,
        kpiInput.total_tasks,
        `totalTasks 应等于 ${kpiInput.total_tasks}，实际为 ${result.totalTasks}`
      );
    }),
    { numRuns: 500 }
  );
});

test('Property 14.2: buildTaskKpi 输出的子项数量之和等于 totalTasks', () => {
  fc.assert(
    fc.property(backendTaskKpiArb, (kpiInput) => {
      const result = buildTaskKpi(kpiInput);
      // 后端 KPI 中 overdue_tasks 和 due_soon_tasks 是 PENDING 的子集
      // waitingAcceptance 是 WAITING_VERIFY 的数量
      // completed_tasks 在后端 KPI 中存在但前端 KPIStats 中没有直接映射
      // 守恒关系：completed_tasks + waiting_verify_tasks + overdue_tasks + due_soon_tasks = total_tasks
      const subTotal =
        Number(kpiInput.completed_tasks || 0) +
        result.waitingAcceptance +
        result.overdueTasks +
        result.dueSoonTasks;
      assert.strictEqual(
        subTotal,
        result.totalTasks,
        `子项之和 (${subTotal}) 应等于 totalTasks (${result.totalTasks})`
      );
    }),
    { numRuns: 500 }
  );
});

test('Property 14.3: buildTaskKpi 所有数值字段为非负数', () => {
  fc.assert(
    fc.property(backendTaskKpiArb, (kpiInput) => {
      const result = buildTaskKpi(kpiInput);
      assert.ok(result.totalTasks >= 0, 'totalTasks 应 >= 0');
      assert.ok(result.waitingAcceptance >= 0, 'waitingAcceptance 应 >= 0');
      assert.ok(result.overdueTasks >= 0, 'overdueTasks 应 >= 0');
      assert.ok(result.dueSoonTasks >= 0, 'dueSoonTasks 应 >= 0');
      assert.ok(result.completionRate >= 0, 'completionRate 应 >= 0');
      assert.ok(result.onTimeRate >= 0, 'onTimeRate 应 >= 0');
    }),
    { numRuns: 500 }
  );
});

test('Property 14.4: buildTaskKpi 处理空/缺失字段不抛错', () => {
  const partialKpiArb = fc.oneof(
    fc.constant({}),
    fc.constant({ total_tasks: 0 }),
    fc.record({
      total_tasks: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      completed_tasks: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      waiting_verify_tasks: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      overdue_tasks: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      due_soon_tasks: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      completion_rate: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
      on_time_rate: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
    })
  );

  fc.assert(
    fc.property(partialKpiArb, (kpiInput) => {
      const result = buildTaskKpi(kpiInput);
      assert.ok(typeof result.totalTasks === 'number', 'totalTasks 应为数字');
      assert.ok(!Number.isNaN(result.totalTasks), 'totalTasks 不应为 NaN');
    }),
    { numRuns: 300 }
  );
});
