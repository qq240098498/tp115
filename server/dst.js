// 夏令时规则的落法：把档案里"某月第几个星期几的几点几分"算成具体年份的切换瞬间，
// 再回答某个瞬间某个时区实际生效的偏移。开始规则按标准偏移解读（拨快前的当地时刻），
// 结束规则按夏令时偏移解读（拨回前的当地时刻），与档案备注里的写法一致

// 某年某月第几个（或最后一个）星期几是这个月的几号
function ruleDayOfMonth(year, rule) {
  const daysInMonth = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, rule.month - 1, 1)).getUTCDay();
  const first = 1 + ((rule.weekday - firstWeekday + 7) % 7);
  if (rule.week === 'last') {
    return first + Math.floor((daysInMonth - first) / 7) * 7;
  }
  // 最短的二月也有完整的四个同一星期几，第四个一定落在月内
  return first + (Number(rule.week) - 1) * 7;
}

// 切换瞬间（UTC 毫秒）：offsetMinutes 取解读这段规则所用的偏移
function transitionUtcMs(zone, rule, year, offsetMinutes) {
  const day = ruleDayOfMonth(year, rule);
  return Date.UTC(year, rule.month - 1, day, rule.hour, rule.minute) - offsetMinutes * 60000;
}

function dstReady(zone) {
  return Boolean(zone && zone.usesDst && zone.dstStart && zone.dstEnd && Number.isInteger(zone.dstOffsetMinutes));
}

// 某一年前后夏令时的生效区间 [startMs, endMs)。结束规则算出来不晚于开始规则时，
// 说明是南半球跨年段，结束落在下一年；跨年段要求下一年也在生效年份内，
// 否则像"二〇一九年起停止"的档案会在最后一年平白多出一段夏令时
function dstIntervals(zone, aroundYear) {
  if (!dstReady(zone)) return [];
  const intervals = [];
  for (let year = aroundYear - 1; year <= aroundYear + 1; year += 1) {
    if (year < zone.fromYear || (zone.toYear !== null && year > zone.toYear)) continue;
    const startMs = transitionUtcMs(zone, zone.dstStart, year, zone.offsetMinutes);
    let endMs = transitionUtcMs(zone, zone.dstEnd, year, zone.dstOffsetMinutes);
    if (endMs <= startMs) {
      if (zone.toYear !== null && year + 1 > zone.toYear) continue;
      endMs = transitionUtcMs(zone, zone.dstEnd, year + 1, zone.dstOffsetMinutes);
    }
    intervals.push({ startMs, endMs });
  }
  return intervals;
}

// 某个瞬间实际生效的偏移，以及那一刻是否处于夏令时
function effectiveOffsetAt(zone, utcMs) {
  if (!dstReady(zone)) return { offsetMinutes: zone.offsetMinutes, dst: false };
  const aroundYear = new Date(utcMs).getUTCFullYear();
  const hit = dstIntervals(zone, aroundYear).some((span) => utcMs >= span.startMs && utcMs < span.endMs);
  return hit
    ? { offsetMinutes: zone.dstOffsetMinutes, dst: true }
    : { offsetMinutes: zone.offsetMinutes, dst: false };
}

// 拨快时被跳过的当地时段（这样的当地时刻不存在），供反推时说明"对方这个时刻不存在"
function skippedWindows(zone, aroundYear) {
  return dstIntervals(zone, aroundYear).map((span) => ({
    startLocalMs: span.startMs + zone.offsetMinutes * 60000,
    endLocalMs: span.startMs + zone.dstOffsetMinutes * 60000,
  }));
}

module.exports = {
  ruleDayOfMonth,
  transitionUtcMs,
  dstIntervals,
  effectiveOffsetAt,
  skippedWindows,
};
