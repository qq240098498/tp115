// 夏令时规则如何落到具体日期：第几个星期几、切换瞬间、某个瞬间生效的偏移，
// 以及由一个当地时刻反推对应的一个或两个实际瞬间。
// 约定（与 IANA 的 wall-clock 写法一致）：
// - 开始切换的时刻按标准偏移落地（切换前当地用的是标准时）
// - 结束切换的时刻按夏令时偏移落地（切换前当地用的是夏令时）
// - 南半球夏令时跨年，季节按开始年份归属，开始年份落在生效年份区间内才实行

const MINUTE_MS = 60000;

// 规则里的“第几个星期几”换算成某一年的具体日期；week 为 'last' 时取该月最后一个
function ruleDate(year, rule) {
  if (rule.week === 'last') {
    const lastOfMonth = new Date(Date.UTC(year, rule.month, 0));
    const back = (lastOfMonth.getUTCDay() - rule.weekday + 7) % 7;
    return { year, month: rule.month, day: lastOfMonth.getUTCDate() - back };
  }
  const firstOfMonth = new Date(Date.UTC(year, rule.month - 1, 1));
  const forward = (rule.weekday - firstOfMonth.getUTCDay() + 7) % 7;
  return { year, month: rule.month, day: 1 + forward + (Number(rule.week) - 1) * 7 };
}

// 档案的夏令时字段是否齐全，缺任何一项都按不实行处理
function hasDstRule(zone) {
  return Boolean(zone.usesDst && zone.dstStart && zone.dstEnd
    && zone.dstOffsetMinutes !== null && zone.dstOffsetMinutes !== undefined);
}

// 开始切换的瞬间：规则时刻按标准偏移折算
function startInstantMs(zone, year) {
  const date = ruleDate(year, zone.dstStart);
  return Date.UTC(date.year, date.month - 1, date.day, zone.dstStart.hour, zone.dstStart.minute)
    - zone.offsetMinutes * MINUTE_MS;
}

// 结束切换的瞬间：规则时刻按夏令时偏移折算
function endInstantMs(zone, year) {
  const date = ruleDate(year, zone.dstEnd);
  return Date.UTC(date.year, date.month - 1, date.day, zone.dstEnd.hour, zone.dstEnd.minute)
    - zone.dstOffsetMinutes * MINUTE_MS;
}

function yearInScope(zone, year) {
  return year >= zone.fromYear && (zone.toYear === null || zone.toYear === undefined || year <= zone.toYear);
}

// 某个瞬间是否处在夏令时里
function dstActiveAt(zone, utcMs) {
  if (!hasDstRule(zone)) return false;
  const year = new Date(utcMs).getUTCFullYear();
  const start = startInstantMs(zone, year);
  const end = endInstantMs(zone, year);
  if (start < end) {
    // 北半球：开始与结束落在同一年内
    return yearInScope(zone, year) && utcMs >= start && utcMs < end;
  }
  // 南半球：夏令时跨年，按开始年份归属
  if (utcMs >= start) return yearInScope(zone, year);
  if (utcMs < end) return yearInScope(zone, year - 1);
  return false;
}

// 某个瞬间实际生效的偏移（分钟）
function effectiveOffsetMinutes(zone, utcMs) {
  return dstActiveAt(zone, utcMs) ? zone.dstOffsetMinutes : zone.offsetMinutes;
}

// 由一个当地时刻反推实际瞬间：标准偏移与夏令时偏移各试一次，
// 试完再用该瞬间的生效偏移核对，能对上的才算数。
// 结果可能是零个（时刻落在被跳过的时段）、一个（唯一）或两个（时刻落在重复的时段）。
function resolveLocal(zone, date, time) {
  const naiveMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const offsets = [zone.offsetMinutes];
  if (hasDstRule(zone) && !offsets.includes(zone.dstOffsetMinutes)) {
    offsets.push(zone.dstOffsetMinutes);
  }
  const candidates = [];
  offsets.forEach((offset) => {
    const utcMs = naiveMs - offset * MINUTE_MS;
    if (effectiveOffsetMinutes(zone, utcMs) !== offset) return;
    candidates.push({
      utcMs,
      offsetMinutes: offset,
      kind: hasDstRule(zone) && offset === zone.dstOffsetMinutes ? 'dst' : 'standard',
    });
  });
  candidates.sort((a, b) => a.utcMs - b.utcMs);
  if (candidates.length === 0) return { status: 'impossible', candidates };
  if (candidates.length === 1) return { status: 'unique', candidates };
  return { status: 'ambiguous', candidates };
}

module.exports = {
  ruleDate,
  hasDstRule,
  startInstantMs,
  endInstantMs,
  dstActiveAt,
  effectiveOffsetMinutes,
  resolveLocal,
};
