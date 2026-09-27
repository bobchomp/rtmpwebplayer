// Backs the Stats page's "Export in Template" button - a single-channel
// export shaped to match a specific manually-compiled spreadsheet the admin
// uses: one row per service (date + AM/PM) with website/facebook/youtube as
// columns, plus a stacked bar chart of the same data. This is a different
// shape from the row-per-play export.csv/xlsx/pdf routes, which stay as-is.
//
// exceljs (already used for export.xlsx) has no native chart-writing
// support at all, and the one npm package that does (xlsx-chart) hasn't
// been touched since 2022 and drags in old, largely-abandoned dependencies.
// Rather than build on either, the chart here is rendered by hand as an SVG
// (full control, zero extra runtime surface for that part) and rasterized
// with sharp (actively maintained, ships prebuilt binaries for Alpine/musl,
// so the Docker image needs no build-toolchain changes) before being
// embedded as a picture - visually identical when opened, just not a
// click-to-edit native Excel chart.

const ExcelJS = require('exceljs');
const sharp = require('sharp');
const plays = require('./plays');

// The server's own OS clock is very likely UTC, not the church's local
// time - computing "before/after 1pm" in raw UTC would misclassify
// services during British Summer Time (UTC+1, roughly late March to late
// October). Intl's timeZone support is built into Node (no dependency
// needed) and handles the DST transition correctly.
const LONDON_TZ = 'Europe/London';
const AM_PM_CUTOFF_HOUR = 13; // 1pm

const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, hour: 'numeric', hourCycle: 'h23' });
const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: LONDON_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const labelFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, day: '2-digit', month: 'short' });

function londonHour(date) {
  return Number(hourFormatter.format(date));
}

// 'YYYY-MM-DD' in London local time, used purely as a stable sort/group key
// (not displayed) - en-CA formats as YYYY-MM-DD directly.
function londonDateKey(date) {
  return dateKeyFormatter.format(date);
}

// e.g. "04jan" - matches the existing manually-compiled sheet's format
// (zero-padded day, lowercase three-letter month, no separator).
function londonDateLabel(date) {
  const parts = labelFormatter.formatToParts(date);
  const day = parts.find((p) => p.type === 'day').value;
  const month = parts.find((p) => p.type === 'month').value.toLowerCase();
  return `${day}${month}`;
}

function half(date) {
  return londonHour(date) < AM_PM_CUTOFF_HOUR ? 'AM' : 'PM';
}

// One row per (date, half) bucket actually present in the data, sorted
// chronologically. website = count of website plays whose firstPlayAt
// falls in that bucket; facebook/youtube = summed from Restream-imported
// aggregate rows (see restreamImport.js) whose firstPlayAt (the source
// event's start time) falls in that bucket. Missing platforms stay
// undefined (rendered as a blank cell), not 0 - matching the source sheet,
// where a blank means "no data for that platform that service" rather than
// "confirmed zero viewers".
function buildServiceRows({ channelId, from, to }) {
  const rows = plays.listPlays({ channelId, from, to });
  const buckets = new Map(); // bucketKey -> { label, sortMs, website, facebook, youtube }

  rows.forEach((p) => {
    if (!p.firstPlayAt) return;
    const date = new Date(p.firstPlayAt);
    if (Number.isNaN(date.getTime())) return;
    const bucketKey = `${londonDateKey(date)}-${half(date)}`;

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        label: `${londonDateLabel(date)} ${half(date)}`,
        sortMs: date.getTime(),
        website: undefined,
        facebook: undefined,
        youtube: undefined,
      });
    }
    const bucket = buckets.get(bucketKey);
    bucket.sortMs = Math.min(bucket.sortMs, date.getTime());

    if (p.platform === 'website') {
      bucket.website = (bucket.website || 0) + 1;
    } else if (p.platform === 'facebook') {
      bucket.facebook = (bucket.facebook || 0) + (Number(p.views) || 0);
    } else if (p.platform === 'youtube') {
      bucket.youtube = (bucket.youtube || 0) + (Number(p.views) || 0);
    }
  });

  return Array.from(buckets.values()).sort((a, b) => a.sortMs - b.sortMs);
}

const SERIES = [
  { key: 'website', color: '#4472C4', label: 'website' },
  { key: 'facebook', color: '#ED7D31', label: 'facebook' },
  { key: 'youtube', color: '#A5A5A5', label: 'youtube' },
];

// A plain hand-built stacked bar chart - only what this one export needs
// (three stacked series, category labels along the bottom, a simple
// legend), not a general-purpose charting engine.
function renderChartSvg(serviceRows) {
  const width = 1100;
  const height = 480;
  const marginLeft = 50;
  const marginRight = 20;
  const marginTop = 30;
  const marginBottom = 90;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const totals = serviceRows.map((r) => (r.website || 0) + (r.facebook || 0) + (r.youtube || 0));
  const maxTotal = Math.max(1, ...totals);
  // Round the axis max up to a "nice" number so gridlines land on round values.
  const niceMax = Math.ceil(maxTotal / 20) * 20 || 20;

  const barCount = serviceRows.length || 1;
  const barSlot = plotWidth / barCount;
  const barWidth = Math.min(24, barSlot * 0.6);

  const yScale = (value) => plotHeight - (value / niceMax) * plotHeight;

  let bars = '';
  serviceRows.forEach((row, i) => {
    const x = marginLeft + i * barSlot + (barSlot - barWidth) / 2;
    let stackedSoFar = 0;
    SERIES.forEach((s) => {
      const value = row[s.key] || 0;
      if (!value) return;
      const yTop = marginTop + yScale(stackedSoFar + value);
      const yBottom = marginTop + yScale(stackedSoFar);
      const barHeight = Math.max(0, yBottom - yTop);
      bars += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${s.color}" />`;
      stackedSoFar += value;
    });
  });

  let xLabels = '';
  serviceRows.forEach((row, i) => {
    const x = marginLeft + i * barSlot + barSlot / 2;
    const y = marginTop + plotHeight + 14;
    xLabels += `<text x="${x.toFixed(1)}" y="${y}" font-size="10" fill="#333" text-anchor="end" `
      + `transform="rotate(-60 ${x.toFixed(1)} ${y})" font-family="DejaVu Sans, sans-serif">${escapeXml(row.label)}</text>`;
  });

  const gridStep = niceMax / 5;
  let gridLines = '';
  let yLabels = '';
  for (let i = 0; i <= 5; i += 1) {
    const value = gridStep * i;
    const y = marginTop + yScale(value);
    gridLines += `<line x1="${marginLeft}" y1="${y.toFixed(1)}" x2="${marginLeft + plotWidth}" y2="${y.toFixed(1)}" stroke="#e0e0e0" stroke-width="1" />`;
    yLabels += `<text x="${marginLeft - 8}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#333" text-anchor="end" font-family="DejaVu Sans, sans-serif">${Math.round(value)}</text>`;
  }

  let legend = '';
  SERIES.forEach((s, i) => {
    const lx = marginLeft + i * 110;
    const ly = 12;
    legend += `<rect x="${lx}" y="${ly}" width="12" height="12" fill="${s.color}" />`;
    legend += `<text x="${lx + 16}" y="${ly + 10}" font-size="11" fill="#333" font-family="DejaVu Sans, sans-serif">${escapeXml(s.label)}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />`
    + legend
    + gridLines
    + `<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotHeight}" stroke="#888" stroke-width="1" />`
    + `<line x1="${marginLeft}" y1="${marginTop + plotHeight}" x2="${marginLeft + plotWidth}" y2="${marginTop + plotHeight}" stroke="#888" stroke-width="1" />`
    + bars
    + xLabels
    + yLabels
    + `</svg>`;
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

async function buildTemplateWorkbook({ channelId, channelName, from, to }) {
  const serviceRows = buildServiceRows({ channelId, from, to });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.columns = [
    { header: 'Date', key: 'label', width: 12 },
    { header: 'website', key: 'website', width: 10 },
    { header: 'facebook', key: 'facebook', width: 10 },
    { header: 'youtube', key: 'youtube', width: 10 },
    { header: 'Total Views', key: 'total', width: 13 },
  ];

  serviceRows.forEach((row, i) => {
    const excelRow = i + 2; // header is row 1
    sheet.addRow({
      label: row.label,
      website: row.website,
      facebook: row.facebook,
      youtube: row.youtube,
      total: { formula: `SUM(B${excelRow}:D${excelRow})` },
    });
  });

  if (serviceRows.length) {
    const svg = renderChartSvg(serviceRows);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const imageId = workbook.addImage({ buffer: png, extension: 'png' });
    sheet.addImage(imageId, {
      tl: { col: 6, row: 1 },
      ext: { width: 1100 * 0.6, height: 480 * 0.6 },
    });
  }

  return workbook;
}

module.exports = { buildServiceRows, buildTemplateWorkbook };
