const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------------------------------------------------------------------------
// 纯函数移植自 frontend/pages/CalendarManager.tsx
// 这些函数是纯逻辑，不依赖 React 或 DOM，可直接在 Node.js 中测试。
// ---------------------------------------------------------------------------

/**
 * toUnixSeconds
 * 将 datetime-local 字符串转换为秒级时间戳。
 */
function toUnixSeconds(input) {
  if (!String(input || '').trim()) {
    return undefined;
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return Math.floor(date.getTime() / 1000);
}

/**
 * hasInvalidDateTimeRange
 * 在开始/结束时间都已填写后，校验结束时间是否严格晚于开始时间。
 * - 任一为空 → false（未填完不算无效）
 * - 任一无法解析 → true（无效）
 * - endTime <= startTime → true（无效）
 * - endTime > startTime → false（有效）
 */
function hasInvalidDateTimeRange(startAt, endAt) {
  const normalizedStartAt = String(startAt || '').trim();
  const normalizedEndAt = String(endAt || '').trim();
  if (!normalizedStartAt || !normalizedEndAt) {
    return false;
  }

  const startTime = toUnixSeconds(normalizedStartAt);
  const endTime = toUnixSeconds(normalizedEndAt);
  if (!startTime || !endTime) {
    return true;
  }

  return endTime <= startTime;
}

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
 * findConflictingEvent
 * 在同一日历事件集合内检测与目标时间段重叠且有共同参与人的首个事件。
 */
function findConflictingEvent(events, options) {
  const targetCalId = String(options.calId || '').trim();
  const targetStartTime = Number(options.startTime || 0);
  const targetEndTime = Number(options.endTime || 0);
  const excludeEventId = String(options.excludeEventId || '').trim();
  const targetParticipantUserIds = buildComparableParticipantUserIds(
    options.participantUserIds,
    options.fallbackOwnerUserId
  );

  if (!targetCalId || !targetStartTime || !targetEndTime || targetEndTime <= targetStartTime) {
    return null;
  }

  return (
    events.find((event) => {
      if (excludeEventId && event.id === excludeEventId) {
        return false;
      }
      if (String(event.calId || '').trim() !== targetCalId) {
        return false;
      }

      const overlap = targetStartTime < event.endTime && event.startTime < targetEndTime;
      if (!overlap) {
        return false;
      }

      const existingParticipantUserIds = buildComparableParticipantUserIds(
        event.attendeeUserIds,
        event.ownerUserId
      );
      if (targetParticipantUserIds.length > 0 && existingParticipantUserIds.length > 0) {
        const existingParticipantSet = new Set(existingParticipantUserIds);
        const hasSharedParticipant = targetParticipantUserIds.some((item) =>
          existingParticipantSet.has(item)
        );
        if (!hasSharedParticipant) {
          return false;
        }
      }

      return true;
    }) || null
  );
}

// ---------------------------------------------------------------------------
// Arbitraries（生成器）
// ---------------------------------------------------------------------------

/** 生成有效的 datetime-local 字符串（YYYY-MM-DDTHH:mm） */
const datetimeLocalArb = fc
  .record({
    year: fc.integer({ min: 2020, max: 2030 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ year, month, day, hour, minute }) => {
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    const h = String(hour).padStart(2, '0');
    const min = String(minute).padStart(2, '0');
    return `${year}-${m}-${d}T${h}:${min}`;
  });

/** 生成非空 userId 字符串 */
const userIdArb = fc.stringMatching(/^[a-zA-Z0-9_]{1,30}$/);

/** 生成正整数 Unix 秒时间戳（合理范围） */
const unixSecondsArb = fc.integer({ min: 1577836800, max: 1893456000 }); // 2020-01-01 ~ 2030-01-01

/** 生成 calId */
const calIdArb = fc.stringMatching(/^cal_[a-z0-9]{1,20}$/);

/** 生成 eventId */
const eventIdArb = fc.stringMatching(/^evt_[a-z0-9]{1,20}$/);

/** 生成一个 CalendarBoardEvent */
const boardEventArb = fc.record({
  id: eventIdArb,
  calId: calIdArb,
  summary: fc.string({ minLength: 1, maxLength: 20 }),
  description: fc.string({ maxLength: 20 }),
  location: fc.string({ maxLength: 20 }),
  startTime: unixSecondsArb,
  endTime: unixSecondsArb,
  attendeesCount: fc.integer({ min: 0, max: 5 }),
  attendeeUserIds: fc.array(userIdArb, { minLength: 0, maxLength: 3 }),
  ownerUserId: userIdArb,
  source: fc.constant('test'),
}).filter((e) => e.endTime > e.startTime);

// ---------------------------------------------------------------------------
// Property 8: 日程时间范围校验
// **Validates: Requirements 4.4**
//
// 使用 fast-check 生成随机时间对，验证 hasInvalidDateTimeRange 判定正确：
// - 任一输入为空 → false
// - 任一输入无法解析 → true
// - endTime <= startTime → true
// - endTime > startTime → false
// ---------------------------------------------------------------------------

test('Property 8.1: 任一输入为空时返回 false（未填完不算无效）', () => {
  fc.assert(
    fc.property(datetimeLocalArb, (validDatetime) => {
      assert.strictEqual(
        hasInvalidDateTimeRange('', validDatetime),
        false,
        '开始时间为空时应返回 false'
      );
      assert.strictEqual(
        hasInvalidDateTimeRange(validDatetime, ''),
        false,
        '结束时间为空时应返回 false'
      );
      assert.strictEqual(
        hasInvalidDateTimeRange('', ''),
        false,
        '两者都为空时应返回 false'
      );
    }),
    { numRuns: 200 }
  );
});

test('Property 8.2: 无法解析的时间字符串返回 true', () => {
  const garbageArb = fc.stringMatching(/^[a-z]{3,10}$/);
  fc.assert(
    fc.property(datetimeLocalArb, garbageArb, (validDatetime, garbage) => {
      assert.strictEqual(
        hasInvalidDateTimeRange(garbage, validDatetime),
        true,
        '开始时间无法解析时应返回 true'
      );
      assert.strictEqual(
        hasInvalidDateTimeRange(validDatetime, garbage),
        true,
        '结束时间无法解析时应返回 true'
      );
    }),
    { numRuns: 200 }
  );
});

test('Property 8.3: endTime > startTime 时返回 false（有效范围）', () => {
  fc.assert(
    fc.property(
      datetimeLocalArb,
      fc.integer({ min: 1, max: 720 }),
      (startDatetime, minutesOffset) => {
        const startDate = new Date(startDatetime);
        fc.pre(!Number.isNaN(startDate.getTime()));
        const endDate = new Date(startDate.getTime() + minutesOffset * 60 * 1000);
        // 使用本地时间构造 datetime-local 字符串，避免 UTC/本地时区不一致
        const pad = (n) => String(n).padStart(2, '0');
        const endDatetime = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;

        assert.strictEqual(
          hasInvalidDateTimeRange(startDatetime, endDatetime),
          false,
          '结束时间严格晚于开始时间时应返回 false'
        );
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 8.4: endTime <= startTime 时返回 true（无效范围）', () => {
  fc.assert(
    fc.property(datetimeLocalArb, (datetime) => {
      const date = new Date(datetime);
      fc.pre(!Number.isNaN(date.getTime()));

      // 相同时间 → endTime == startTime → true
      assert.strictEqual(
        hasInvalidDateTimeRange(datetime, datetime),
        true,
        '开始和结束时间相同时应返回 true'
      );

      // 结束时间早于开始时间 → true
      const earlierDate = new Date(date.getTime() - 3600 * 1000);
      const earlierDatetime = earlierDate.toISOString().slice(0, 16);
      assert.strictEqual(
        hasInvalidDateTimeRange(datetime, earlierDatetime),
        true,
        '结束时间早于开始时间时应返回 true'
      );
    }),
    { numRuns: 300 }
  );
});

test('Property 8.5: hasInvalidDateTimeRange 与 toUnixSeconds 一致性', () => {
  fc.assert(
    fc.property(datetimeLocalArb, datetimeLocalArb, (startAt, endAt) => {
      const startTime = toUnixSeconds(startAt);
      const endTime = toUnixSeconds(endAt);
      fc.pre(startTime !== undefined && endTime !== undefined);

      const result = hasInvalidDateTimeRange(startAt, endAt);
      const expected = endTime <= startTime;
      assert.strictEqual(
        result,
        expected,
        `hasInvalidDateTimeRange 应与 toUnixSeconds 比较结果一致: start=${startTime}, end=${endTime}`
      );
    }),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// Property 9: 日程时间冲突检测
// **Validates: Requirements 4.5**
//
// 使用 fast-check 生成随机事件集合和目标时间区间，验证 findConflictingEvent 检测正确：
// - 无效参数返回 null
// - 不同 calId 不冲突
// - 被排除的 eventId 不冲突
// - 无共同参与人不冲突
// - 时间重叠且有共同参与人时检测到冲突
// ---------------------------------------------------------------------------

test('Property 9.1: 无效参数（空 calId / 无效时间）返回 null', () => {
  fc.assert(
    fc.property(
      fc.array(boardEventArb, { minLength: 0, maxLength: 5 }),
      unixSecondsArb,
      unixSecondsArb,
      (events, t1, t2) => {
        // 空 calId
        assert.strictEqual(
          findConflictingEvent(events, { calId: '', startTime: t1, endTime: t2 }),
          null,
          '空 calId 应返回 null'
        );

        // endTime <= startTime
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        if (lo === hi) {
          assert.strictEqual(
            findConflictingEvent(events, { calId: 'cal_test', startTime: lo, endTime: hi }),
            null,
            'endTime == startTime 应返回 null'
          );
        }
        assert.strictEqual(
          findConflictingEvent(events, { calId: 'cal_test', startTime: hi, endTime: lo }),
          null,
          'endTime < startTime 应返回 null'
        );
      }
    ),
    { numRuns: 200 }
  );
});

test('Property 9.2: 不同 calId 的事件不会被检测为冲突', () => {
  fc.assert(
    fc.property(
      boardEventArb,
      calIdArb,
      userIdArb,
      (event, targetCalId, userId) => {
        // 确保 calId 不同
        fc.pre(event.calId !== targetCalId);

        const result = findConflictingEvent([event], {
          calId: targetCalId,
          startTime: event.startTime,
          endTime: event.endTime,
          participantUserIds: event.attendeeUserIds,
          fallbackOwnerUserId: userId,
        });
        assert.strictEqual(result, null, '不同 calId 不应冲突');
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 9.3: excludeEventId 匹配的事件被排除', () => {
  fc.assert(
    fc.property(boardEventArb, userIdArb, (event, userId) => {
      // 使用完全相同的时间和参与人，但排除该事件
      const result = findConflictingEvent([event], {
        calId: event.calId,
        startTime: event.startTime,
        endTime: event.endTime,
        excludeEventId: event.id,
        participantUserIds: event.attendeeUserIds.length > 0 ? event.attendeeUserIds : [userId],
        fallbackOwnerUserId: event.ownerUserId,
      });
      assert.strictEqual(result, null, '被排除的事件不应被检测为冲突');
    }),
    { numRuns: 300 }
  );
});

test('Property 9.4: 时间不重叠的事件不冲突', () => {
  fc.assert(
    fc.property(
      boardEventArb,
      fc.integer({ min: 1, max: 86400 }),
      (event, gap) => {
        // 目标区间在事件之后，且有间隔
        const targetStart = event.endTime + gap;
        const targetEnd = targetStart + 3600;

        const result = findConflictingEvent([event], {
          calId: event.calId,
          startTime: targetStart,
          endTime: targetEnd,
          participantUserIds: event.attendeeUserIds,
          fallbackOwnerUserId: event.ownerUserId,
        });
        assert.strictEqual(result, null, '时间不重叠的事件不应冲突');
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 9.5: 无共同参与人的重叠事件不冲突', () => {
  fc.assert(
    fc.property(
      boardEventArb,
      userIdArb,
      userIdArb,
      (event, targetUser, eventUser) => {
        // 确保参与人完全不同
        fc.pre(targetUser.toLowerCase() !== eventUser.toLowerCase());
        fc.pre(!event.attendeeUserIds.some(
          (id) => String(id || '').trim().toLowerCase() === targetUser.toLowerCase()
        ));
        fc.pre(event.ownerUserId.toLowerCase() !== targetUser.toLowerCase());

        // 构造事件只有 eventUser 作为参与人
        const isolatedEvent = {
          ...event,
          attendeeUserIds: [eventUser],
          ownerUserId: eventUser,
        };

        // 目标区间完全重叠
        const result = findConflictingEvent([isolatedEvent], {
          calId: isolatedEvent.calId,
          startTime: isolatedEvent.startTime,
          endTime: isolatedEvent.endTime,
          participantUserIds: [targetUser],
          fallbackOwnerUserId: targetUser,
        });
        assert.strictEqual(result, null, '无共同参与人的重叠事件不应冲突');
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 9.6: 时间重叠且有共同参与人时检测到冲突', () => {
  fc.assert(
    fc.property(
      boardEventArb,
      userIdArb,
      (event, sharedUser) => {
        // 构造事件包含 sharedUser
        const eventWithShared = {
          ...event,
          attendeeUserIds: [...event.attendeeUserIds, sharedUser],
        };

        // 目标区间与事件重叠（取事件中间点构造重叠区间）
        const midPoint = Math.floor((event.startTime + event.endTime) / 2);
        const targetStart = midPoint;
        const targetEnd = event.endTime + 3600;

        fc.pre(targetEnd > targetStart);

        const result = findConflictingEvent([eventWithShared], {
          calId: eventWithShared.calId,
          startTime: targetStart,
          endTime: targetEnd,
          participantUserIds: [sharedUser],
          fallbackOwnerUserId: sharedUser,
        });
        assert.notStrictEqual(result, null, '时间重叠且有共同参与人时应检测到冲突');
        assert.strictEqual(result.id, eventWithShared.id, '应返回冲突的事件');
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 9.7: 相邻边界（endTime == startTime）不算重叠', () => {
  fc.assert(
    fc.property(boardEventArb, userIdArb, (event, sharedUser) => {
      const eventWithShared = {
        ...event,
        attendeeUserIds: [sharedUser],
      };

      // 目标区间紧接在事件之后：targetStart == event.endTime
      const targetStart = event.endTime;
      const targetEnd = targetStart + 3600;

      const result = findConflictingEvent([eventWithShared], {
        calId: eventWithShared.calId,
        startTime: targetStart,
        endTime: targetEnd,
        participantUserIds: [sharedUser],
        fallbackOwnerUserId: sharedUser,
      });
      assert.strictEqual(result, null, '相邻边界不应算作重叠');
    }),
    { numRuns: 300 }
  );
});
