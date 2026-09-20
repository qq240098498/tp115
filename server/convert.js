const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const { effectiveOffsetMinutes, resolveLocal } = require('./dst');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;
const MINUTE_MS = 60000;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value, field) {
  const target = field || 'date';
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', target);
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', target);
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', target);
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', target);
  }
  return { text: date, year, month, day };
}

function validateTime(value, field) {
  const target = field || 'time';
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', target);
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', target);
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 把某个瞬间（已含偏移折算）拆成当地的日期、时刻与星期几
function localParts(ms) {
  const date = new Date(ms);
  return {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
    weekday: WEEKDAY_NAMES[date.getUTCDay()],
    dayIndex: Math.floor(ms / DAY_MS),
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 换算：来源当地时刻先落成实际瞬间，再按各时区当时生效的偏移逐个折算
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  // 来源时刻落在被跳过的时段时当地根本没有这一刻；落在重复的时段时按第一次出现换算并说明
  const resolved = resolveLocal(source, date, time);
  if (resolved.status === 'impossible') {
    throw new ApiError(400, 'SOURCE_TIME_IMPOSSIBLE', '来源时区的这个当地时刻不存在：正好落在夏令时切换被跳过的时段里', 'time');
  }
  const instant = resolved.candidates[0];
  const utcMs = instant.utcMs;
  const sourceOffset = instant.offsetMinutes;
  const sourceNote = resolved.status === 'ambiguous'
    ? `来源时刻落在夏令时结束重复的一小时里，这里按第一次出现（${instant.kind === 'dst' ? '夏令时' : '标准时'}）换算`
    : '';
  const baseDay = Math.floor((utcMs + sourceOffset * MINUTE_MS) / DAY_MS);
  const utc = localParts(utcMs);

  const results = data.zones.map((zone) => {
    const zoneOffset = effectiveOffsetMinutes(zone, utcMs);
    const local = localParts(utcMs + zoneOffset * MINUTE_MS);
    const dayOffset = local.dayIndex - baseDay;
    const diffMinutes = zoneOffset - sourceOffset;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zoneOffset,
      offsetText: offsetText(zoneOffset),
      localDate: local.date,
      localTime: local.time,
      weekday: local.weekday,
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      dstActive: zone.usesDst && zoneOffset === zone.dstOffsetMinutes,
      isSource: zone.id === source.id,
    };
  });

  results.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(sourceOffset),
      usesDst: source.usesDst,
      dstActive: source.usesDst && sourceOffset === source.dstOffsetMinutes,
    },
    standard: { date: utc.date, time: utc.time },
    sourceNote,
    zonesInScope: data.zones.length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

// 正推验证：拿反推出的我们这边时刻，从来源时区正推回对方当地时刻，核对与输入是否一致
function verifyCandidate(source, target, candidate, sourceLocal, inputDate, inputTime) {
  const sourceDate = { year: sourceLocal.year, month: sourceLocal.month, day: sourceLocal.day };
  const sourceTime = { hour: sourceLocal.hour, minute: sourceLocal.minute };
  const back = resolveLocal(source, sourceDate, sourceTime);
  const hit = back.candidates.some((item) => item.utcMs === candidate.utcMs);
  const targetOffset = effectiveOffsetMinutes(target, candidate.utcMs);
  const targetLocal = localParts(candidate.utcMs + targetOffset * MINUTE_MS);
  const matches = hit && targetLocal.date === inputDate.text && targetLocal.time === inputTime.text;
  const text = matches
    ? `通过：由我们这边 ${sourceLocal.date} ${sourceLocal.time} 正推回对方当地为 ${targetLocal.date} ${targetLocal.time}，与输入一致`
    : `未通过：由我们这边 ${sourceLocal.date} ${sourceLocal.time} 正推回对方当地为 ${targetLocal.date} ${targetLocal.time}，与输入的 ${inputDate.text} ${inputTime.text} 不一致`;
  return { verified: matches, text };
}

// 反推：给对方那边的当地时刻，推出我们这边对应的日期与时刻。
// 对方时刻落在重复的一小时里时对应两个实际瞬间，两个都按先后列出；
// 落在被跳过的一小时里时当地没有这一刻，直接说明。
function reverseConvert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date, 'reverseDate');
  const time = validateTime(input.time, 'reverseTime');
  const targetZoneId = pickText(input.targetZoneId);
  const sourceZoneId = pickText(input.sourceZoneId);
  if (!targetZoneId) throw new ApiError(400, 'TARGET_ZONE_REQUIRED', '请选择对方所在时区', 'targetZoneId');
  if (!sourceZoneId) throw new ApiError(400, 'SOURCE_ZONE_REQUIRED', '请选择我们这边的时区', 'sourceZoneId');

  const data = load();
  const target = data.zones.find((item) => item.id === targetZoneId);
  if (!target) throw new ApiError(404, 'TARGET_ZONE_NOT_FOUND', '对方所在时区没有登记过', 'targetZoneId');
  const source = data.zones.find((item) => item.id === sourceZoneId);
  if (!source) throw new ApiError(404, 'SOURCE_ZONE_NOT_FOUND', '我们这边的时区没有登记过', 'sourceZoneId');

  const resolved = resolveLocal(target, date, time);
  const targetDay = Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);

  const candidates = resolved.candidates.map((candidate, index) => {
    const sourceOffset = effectiveOffsetMinutes(source, candidate.utcMs);
    const sourceLocal = localParts(candidate.utcMs + sourceOffset * MINUTE_MS);
    const utc = localParts(candidate.utcMs);
    const dayOffset = sourceLocal.dayIndex - targetDay;
    const verify = verifyCandidate(source, target, candidate, sourceLocal, date, time);
    return {
      order: index + 1,
      occurrenceText: resolved.status === 'ambiguous' ? (index === 0 ? '第一次' : '第二次') : '唯一对应',
      offsetKind: candidate.kind,
      offsetKindText: candidate.kind === 'dst' ? '夏令时' : '标准时',
      targetOffsetText: offsetText(candidate.offsetMinutes),
      utcDate: utc.date,
      utcTime: utc.time,
      sourceDate: sourceLocal.date,
      sourceTime: sourceLocal.time,
      sourceWeekday: sourceLocal.weekday,
      sourceDayOffset: dayOffset,
      sourceDayOffsetText: dayOffsetText(dayOffset),
      sourceOffsetText: offsetText(sourceOffset),
      verified: verify.verified,
      verifyText: verify.text,
    };
  });

  const passed = candidates.filter((item) => item.verified).length;
  let conclusion;
  if (candidates.length === 0) {
    conclusion = '没有可反推的结果，无法进行正推验证';
  } else if (passed === candidates.length && candidates.length === 1) {
    conclusion = '通过：按我们这边的时间正推回对方当地，日期时刻与输入完全一致';
  } else if (passed === candidates.length) {
    conclusion = `${passed} 个结果全部通过：无论对应哪个瞬间，正推回对方当地都与输入一致`;
  } else {
    conclusion = `${candidates.length} 个结果里有 ${candidates.length - passed} 个未通过正推验证，请把情况反馈给维护者`;
  }

  let statusText;
  let detail;
  if (resolved.status === 'ambiguous') {
    statusText = '对应两个瞬间';
    detail = '对方这个当地时刻落在夏令时结束重复的一小时里，对应两个实际瞬间，我们这边各有一个时刻，已按先后全部列出';
  } else if (resolved.status === 'impossible') {
    statusText = '对方当地时刻不存在';
    detail = '对方这个当地时刻落在夏令时开始被跳过的一小时里，当地没有这一刻，无法反推';
  } else {
    statusText = '唯一对应';
    detail = '对方这个当地时刻只对应一个实际瞬间';
  }

  return {
    input: {
      date: date.text,
      time: time.text,
      targetZoneId: target.id,
      targetZoneName: target.name,
      targetDisplayName: target.displayName,
      sourceZoneId: source.id,
      sourceZoneName: source.name,
      sourceDisplayName: source.displayName,
    },
    status: resolved.status,
    statusText,
    detail,
    candidates,
    verification: {
      checked: candidates.length,
      passed,
      allPassed: candidates.length > 0 && passed === candidates.length,
      conclusion,
    },
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, reverseConvert, validateDate, validateTime, diffText, dayOffsetText };
