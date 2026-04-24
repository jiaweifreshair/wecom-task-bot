const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------------------------------------------------------------------------
// 纯函数移植自 frontend/pages/CalendarManager.tsx
// 这些函数是纯逻辑，不依赖 React 或 DOM，可直接在 Node.js 中测试。
// ---------------------------------------------------------------------------

/**
 * buildComparableParticipantUserIds
 * 优先使用内部参与人列表，缺失时回退到日历归属人/组织者，输出去重后的账号集合。
 */
function buildComparableParticipantUserIds(participantUserIds, fallbackUserId) {
  if (!Array.isArray(participantUserIds)) {
    participantUserIds = [];
  }
  const normalizedIds = Array.from(
    new Set(
      participantUserIds
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (normalizedIds.length > 0) {
    return normalizedIds;
  }

  const normalizedFallbackUserId = String(fallbackUserId || '').trim().toLowerCase();
  return normalizedFallbackUserId ? [normalizedFallbackUserId] : [];
}

/**
 * canUserViewCalendarEvent
 * 管理员可见全部事件，普通成员仅可见"自己创建"或"需要自己执行/参与"的事件。
 */
function canUserViewCalendarEvent(event, options) {
  if (options.isAdmin) {
    return true;
  }

  const normalizedCurrentUserId = String(options.currentUserId || '').trim().toLowerCase();
  if (!normalizedCurrentUserId) {
    return false;
  }

  const comparableParticipantUserIds = buildComparableParticipantUserIds(
    event.attendeeUserIds,
    event.ownerUserId
  );
  return comparableParticipantUserIds.includes(normalizedCurrentUserId);
}

/**
 * canUserMutateCalendarEvent
 * 管理员可修改全部事件，普通成员仅可修改自己创建的事件。
 */
function canUserMutateCalendarEvent(event, options) {
  if (options.isAdmin) {
    return true;
  }

  const normalizedCurrentUserId = String(options.currentUserId || '').trim().toLowerCase();
  const normalizedOwnerUserId = String(event.ownerUserId || '').trim().toLowerCase();
  if (!normalizedCurrentUserId || !normalizedOwnerUserId) {
    return false;
  }

  return normalizedCurrentUserId === normalizedOwnerUserId;
}

// ---------------------------------------------------------------------------
// Arbitraries（生成器）
// ---------------------------------------------------------------------------

/** 生成非空 userId 字符串 */
const userIdArb = fc.stringMatching(/^[a-zA-Z0-9_]{1,30}$/);

/** 生成 attendeeUserIds 数组（0-5 个成员） */
const attendeeUserIdsArb = fc.array(userIdArb, { minLength: 0, maxLength: 5 });

/** 生成一个日历事件（含 attendeeUserIds 和 ownerUserId） */
const calendarEventArb = fc.record({
  attendeeUserIds: attendeeUserIdsArb,
  ownerUserId: userIdArb,
});

/** 生成一个仅含 ownerUserId 的事件（用于 mutate 测试） */
const mutateEventArb = fc.record({
  ownerUserId: userIdArb,
});

// ---------------------------------------------------------------------------
// Property 5: 日程查看权限判定
// **Validates: Requirements 3.1, 3.2, 5.1**
//
// 使用 fast-check 生成随机用户和事件组合，验证 canUserViewCalendarEvent 返回值符合权限矩阵：
// - 管理员（isAdmin=true）可查看所有事件
// - 普通成员（isAdmin=false）仅可查看自己参与或创建的事件
// ---------------------------------------------------------------------------

test('Property 5.1: 管理员（isAdmin=true）始终可以查看任意事件', () => {
  fc.assert(
    fc.property(calendarEventArb, userIdArb, (event, currentUserId) => {
      const result = canUserViewCalendarEvent(event, {
        currentUserId,
        isAdmin: true,
      });
      assert.strictEqual(result, true, '管理员应始终可查看任意事件');
    }),
    { numRuns: 300 }
  );
});

test('Property 5.2: EXECUTOR 可以查看自己作为参与人的事件', () => {
  fc.assert(
    fc.property(
      attendeeUserIdsArb,
      userIdArb,
      userIdArb,
      (otherAttendees, ownerUserId, currentUserId) => {
        // 将 currentUserId 加入参与人列表
        const attendeeUserIds = [...otherAttendees, currentUserId];
        const event = { attendeeUserIds, ownerUserId };
        const result = canUserViewCalendarEvent(event, {
          currentUserId,
          isAdmin: false,
        });
        assert.strictEqual(result, true, 'EXECUTOR 应可查看自己参与的事件');
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 5.3: EXECUTOR 可以查看自己创建的事件（即使不在参与人列表中）', () => {
  fc.assert(
    fc.property(userIdArb, (userId) => {
      // 空参与人列表，但 ownerUserId 是自己 → 回退到 ownerUserId
      const event = { attendeeUserIds: [], ownerUserId: userId };
      const result = canUserViewCalendarEvent(event, {
        currentUserId: userId,
        isAdmin: false,
      });
      assert.strictEqual(result, true, 'EXECUTOR 应可查看自己创建的事件');
    }),
    { numRuns: 300 }
  );
});

test('Property 5.4: EXECUTOR 无法查看与自己无关的事件', () => {
  fc.assert(
    fc.property(
      calendarEventArb,
      userIdArb,
      (event, currentUserId) => {
        // 确保 currentUserId 不在参与人列表中，也不是 owner
        const lowerCurrent = currentUserId.trim().toLowerCase();
        const isAttendee = event.attendeeUserIds.some(
          (id) => String(id || '').trim().toLowerCase() === lowerCurrent
        );
        const isOwner = String(event.ownerUserId || '').trim().toLowerCase() === lowerCurrent;

        // 只在确实无关时断言
        fc.pre(!isAttendee && !isOwner);

        const result = canUserViewCalendarEvent(event, {
          currentUserId,
          isAdmin: false,
        });

        // 如果有参与人列表，则按参与人判定；如果没有，则按 ownerUserId 判定
        // 由于 pre 已排除了 currentUserId 在参与人或 owner 中的情况，结果应为 false
        assert.strictEqual(result, false, 'EXECUTOR 不应查看与自己无关的事件');
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 5.5: 空 currentUserId 的非管理员无法查看任何事件', () => {
  fc.assert(
    fc.property(calendarEventArb, (event) => {
      const result = canUserViewCalendarEvent(event, {
        currentUserId: '',
        isAdmin: false,
      });
      assert.strictEqual(result, false, '空 userId 的非管理员不应查看任何事件');
    }),
    { numRuns: 200 }
  );
});

test('Property 5.6: 查看权限判定对 userId 大小写不敏感', () => {
  fc.assert(
    fc.property(userIdArb, userIdArb, (ownerUserId, currentUserId) => {
      const event = { attendeeUserIds: [currentUserId.toUpperCase()], ownerUserId };
      const result = canUserViewCalendarEvent(event, {
        currentUserId: currentUserId.toLowerCase(),
        isAdmin: false,
      });
      assert.strictEqual(result, true, '查看权限应对 userId 大小写不敏感');
    }),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// Property 6: 日程编辑权限判定
// **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 5.3**
//
// 使用 fast-check 生成随机用户和事件组合，验证 canUserMutateCalendarEvent 返回值符合权限矩阵：
// - 管理员（isAdmin=true）可编辑/删除任意事件
// - 普通成员（isAdmin=false）仅可编辑/删除自己创建的事件
// ---------------------------------------------------------------------------

test('Property 6.1: 管理员（isAdmin=true）始终可以编辑任意事件', () => {
  fc.assert(
    fc.property(mutateEventArb, userIdArb, (event, currentUserId) => {
      const result = canUserMutateCalendarEvent(event, {
        currentUserId,
        isAdmin: true,
      });
      assert.strictEqual(result, true, '管理员应始终可编辑任意事件');
    }),
    { numRuns: 300 }
  );
});

test('Property 6.2: EXECUTOR 可以编辑自己创建的事件', () => {
  fc.assert(
    fc.property(userIdArb, (userId) => {
      const event = { ownerUserId: userId };
      const result = canUserMutateCalendarEvent(event, {
        currentUserId: userId,
        isAdmin: false,
      });
      assert.strictEqual(result, true, 'EXECUTOR 应可编辑自己创建的事件');
    }),
    { numRuns: 300 }
  );
});

test('Property 6.3: EXECUTOR 无法编辑他人创建的事件', () => {
  fc.assert(
    fc.property(userIdArb, userIdArb, (ownerUserId, currentUserId) => {
      // 确保两个 userId 不同
      fc.pre(ownerUserId.trim().toLowerCase() !== currentUserId.trim().toLowerCase());

      const event = { ownerUserId };
      const result = canUserMutateCalendarEvent(event, {
        currentUserId,
        isAdmin: false,
      });
      assert.strictEqual(result, false, 'EXECUTOR 不应编辑他人创建的事件');
    }),
    { numRuns: 300 }
  );
});

test('Property 6.4: 空 currentUserId 的非管理员无法编辑任何事件', () => {
  fc.assert(
    fc.property(mutateEventArb, (event) => {
      const result = canUserMutateCalendarEvent(event, {
        currentUserId: '',
        isAdmin: false,
      });
      assert.strictEqual(result, false, '空 userId 的非管理员不应编辑任何事件');
    }),
    { numRuns: 200 }
  );
});

test('Property 6.5: 空 ownerUserId 的事件，非管理员无法编辑', () => {
  fc.assert(
    fc.property(userIdArb, (currentUserId) => {
      const event = { ownerUserId: '' };
      const result = canUserMutateCalendarEvent(event, {
        currentUserId,
        isAdmin: false,
      });
      assert.strictEqual(result, false, '空 ownerUserId 的事件，非管理员不应可编辑');
    }),
    { numRuns: 200 }
  );
});

test('Property 6.6: 编辑权限判定对 userId 大小写不敏感', () => {
  fc.assert(
    fc.property(userIdArb, (userId) => {
      const event = { ownerUserId: userId.toUpperCase() };
      const result = canUserMutateCalendarEvent(event, {
        currentUserId: userId.toLowerCase(),
        isAdmin: false,
      });
      assert.strictEqual(result, true, '编辑权限应对 userId 大小写不敏感');
    }),
    { numRuns: 200 }
  );
});

test('Property 6.7: 编辑权限蕴含查看权限 — 可编辑则必可查看', () => {
  fc.assert(
    fc.property(
      calendarEventArb,
      userIdArb,
      fc.boolean(),
      (event, currentUserId, isAdmin) => {
        const canMutate = canUserMutateCalendarEvent(event, { currentUserId, isAdmin });
        if (canMutate) {
          const canView = canUserViewCalendarEvent(event, { currentUserId, isAdmin });
          assert.strictEqual(canView, true, '可编辑事件必须同时可查看');
        }
      }
    ),
    { numRuns: 300 }
  );
});
