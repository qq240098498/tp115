// 反推：手上是对方那边定好的当地时刻，倒过来算我们这边是几点几分、哪一天。
// 对方时区可能实行夏令时，同一个当地时刻在回拨那天会对应前后两个实际瞬间，
// 两个都要算出来；拨快那天被跳过的当地时刻则一个都没有，要说明白
const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const { validateDate, validateTime, dayOffsetText } = require('./convert');
const { effectiveOffsetAt, skippedWindows } = require('./dst');

const DAY_MS = 86400000;
const pad = (num) => String(num).padStart(2, '0');

// 把 UTC 毫秒拆成页面要看的日期、时刻与星期
function splitUtc(ms) {
  const date = new Date(ms);
  return {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
    weekday: WEEKDAY_NAMES[date.getUTCDay()],
  };
}

function pickZone(data, id, field, label) {
  const zoneId = pickText(id);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', `请选择${label}`, field);
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', field);
  return zone;
}

// 一个时区可能用来解读当地时刻的偏移：标准偏移，加上夏令时偏移（如果登记了）
function candidateOffsets(zone) {
  const offsets = [zone.offsetMinutes];
  if (zone.usesDst && Number.isInteger(zone.dstOffsetMinutes) && !offsets.includes(zone.dstOffsetMinutes)) {
    offsets.push(zone.dstOffsetMinutes);
  }
  return offsets;
}

// 正推校验：从反推得到的我们这边时刻出发，重新折算回对方当地时刻，必须与输入一致。
// 我们这边那一刻若也落在重复小时里会有多个合法瞬间，只要有一个能推回输入就算通过
function forwardCheck(target, source, sourceDate, sourceTime, expectDate, expectTime) {
  const [year, month, day] = sourceDate.split('-').map(Number);
  const [hour, minute] = sourceTime.split(':').map(Number);
  const sourceLocalMs = Date.UTC(year, month - 1, day, hour, minute);
  let first = null;
  for (const offset of candidateOffsets(source)) {
    const utcMs = sourceLocalMs - offset * 60000;
    if (effectiveOffsetAt(source, utcMs).offsetMinutes !== offset) continue;
    const back = splitUtc(utcMs + effectiveOffsetAt(target, utcMs).offsetMinutes * 60000);
    if (!first) first = back;
    if (back.date === expectDate && back.time === expectTime) {
      return { ok: true, date: back.date, time: back.time };
    }
  }
  return { ok: false, date: first ? first.date : '', time: first ? first.time : '' };
}

// 反推主流程：给对方时区的一个当地时刻，列出我们这边对应的时刻
function reverse(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date, 'reverseDate');
  const time = validateTime(input.time, 'reverseTime');
  const data = load();
  const target = pickZone(data, input.targetZoneId, 'targetZoneId', '对方时区');
  const source = pickZone(data, input.sourceZoneId, 'sourceZoneId', '我们这边时区');

  const localMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const localDay = Math.floor(localMs / DAY_MS);

  // 逐个候选偏移试算：哪个偏移折算出的瞬间，对方时区当时确实用这个偏移，哪个就算一个解
  const matches = [];
  candidateOffsets(target).forEach((offset) => {
    const utcMs = localMs - offset * 60000;
    const targetActual = effectiveOffsetAt(target, utcMs);
    if (targetActual.offsetMinutes !== offset) return;
    const sourceActual = effectiveOffsetAt(source, utcMs);
    const utc = splitUtc(utcMs);
    const sourceLocalMs = utcMs + sourceActual.offsetMinutes * 60000;
    const sourceLocal = splitUtc(sourceLocalMs);
    const sourceDayOffset = Math.floor(sourceLocalMs / DAY_MS) - localDay;
    matches.push({
      utcMs,
      utcDate: utc.date,
      utcTime: utc.time,
      targetOffsetMinutes: targetActual.offsetMinutes,
      targetOffsetText: offsetText(targetActual.offsetMinutes),
      targetDst: targetActual.dst,
      sourceDate: sourceLocal.date,
      sourceTime: sourceLocal.time,
      sourceWeekday: sourceLocal.weekday,
      sourceDayOffset,
      sourceDayOffsetText: dayOffsetText(sourceDayOffset),
      sourceOffsetMinutes: sourceActual.offsetMinutes,
      sourceOffsetText: offsetText(sourceActual.offsetMinutes),
      sourceDst: sourceActual.dst,
      verify: forwardCheck(target, source, sourceLocal.date, sourceLocal.time, date.text, time.text),
    });
  });

  matches.sort((a, b) => a.utcMs - b.utcMs);
  matches.forEach((item, index) => { item.order = index + 1; });

  let status = 'normal';
  let statusText = '对方这个当地时刻对应唯一一个实际时刻';
  if (matches.length === 2) {
    status = 'ambiguous';
    statusText = '对方这个当地时刻落在夏令时回拨的重复小时里，对应前后两个实际时刻，两个都列在下面';
  } else if (matches.length === 0) {
    status = 'gap';
    const hit = skippedWindows(target, date.year).find((span) => localMs >= span.startLocalMs && localMs < span.endLocalMs);
    if (hit) {
      const from = splitUtc(hit.startLocalMs);
      const to = splitUtc(hit.endLocalMs);
      statusText = `对方这个当地时刻在当地不存在：${from.date} ${from.time} 拨快到 ${to.time}，这段当地时刻被跳过了`;
    } else {
      statusText = '对方这个当地时刻在当地不存在，请核对对方给出的日期与时刻';
    }
  }

  const allOk = matches.length > 0 && matches.every((item) => item.verify.ok);
  const verification = matches.length === 0
    ? null
    : {
        ok: allOk,
        text: allOk
          ? matches.length === 2
            ? `把两个结果分别正推回对方时区，当地时刻都是 ${date.text} ${time.text}，与输入一致`
            : `把这个结果正推回对方时区，当地时刻是 ${date.text} ${time.text}，与输入一致`
          : '有结果正推回对方时区后与输入不一致，请检查档案里的偏移与夏令时规则',
      };

  return {
    input: {
      date: date.text,
      time: time.text,
      targetZoneId: target.id,
      targetZoneName: target.name,
      targetZoneDisplayName: target.displayName,
      sourceZoneId: source.id,
      sourceZoneName: source.name,
      sourceZoneDisplayName: source.displayName,
    },
    status,
    statusText,
    matches: matches.map(({ utcMs, ...rest }) => rest),
    verification,
    lookedUpAt: new Date().toISOString(),
  };
}

module.exports = { reverse };
