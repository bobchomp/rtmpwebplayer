const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit-table');
const { readDb } = require('../db');
const { requireAuth } = require('../authMiddleware');
const plays = require('../plays');

const router = express.Router();

// Shared by all three export formats - same columns/order as the on-screen
// table, so a CSV/Excel/PDF export always matches what you were just
// looking at, filters included.
const EXPORT_COLUMNS = [
  { header: 'Latest Play', key: 'latestPlayAt' },
  { header: 'Channel', key: 'channelName' },
  { header: 'Title', key: 'title' },
  { header: 'Description', key: 'description' },
  { header: 'Type', key: 'type' },
  { header: 'IP Address', key: 'ip' },
  { header: 'Country', key: 'country' },
  { header: 'Region', key: 'region' },
  { header: 'City', key: 'city' },
  { header: 'First Play', key: 'firstPlayAt' },
];

function exportRows(req) {
  return plays.listPlays({
    channelId: req.query.channelId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
  });
}

// Human-readable description of whatever filters are active, used as the
// PDF's subtitle so the export is self-explanatory once it's saved/printed
// and separated from the dashboard it came from.
function exportFilterSummary(req) {
  const parts = [];
  if (req.query.channelId) {
    const db = readDb();
    const channel = db.channels[req.query.channelId];
    parts.push(channel ? channel.name : 'Unknown channel');
  } else {
    parts.push('All channels');
  }
  if (req.query.from || req.query.to) {
    const from = req.query.from ? new Date(req.query.from).toLocaleDateString() : 'the start';
    const to = req.query.to ? new Date(req.query.to).toLocaleDateString() : 'now';
    parts.push(`${from} to ${to}`);
  }
  return parts.join(' - ');
}

// Cloudflare (and most CDNs) set this to the actual visitor's IP - req.ip
// would otherwise reflect the CDN/proxy hop instead, even with Express's
// trust proxy setting, since that only accounts for the CDN's own X-Forwarded-For.
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

// Called from the embed player itself once real playback starts, and then
// periodically while it keeps playing. Public - viewers aren't logged in -
// so this only ever writes a play record, never reveals anything back about
// the channel. Skipped entirely for an admin session, since the dashboard's
// own live preview loads this exact same player - without this, checking on
// your own stream would count as a viewer and pollute the Stats history.
router.post('/track', (req, res) => {
  const isAdmin = !!(req.session && req.session.isAdmin);
  const channelId = req.body && req.body.channelId;
  if (!isAdmin && typeof channelId === 'string' && channelId) {
    plays.recordPlay({
      channelId,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
  }
  res.status(204).end();
});

router.get('/', requireAuth, (req, res) => {
  const db = readDb();
  const channels = Object.values(db.channels)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rows = plays.listPlays({
    channelId: req.query.channelId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
  });

  res.json({ channels, plays: rows });
});

function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// Admin-only bulk delete, driven by the Stats page's row checkboxes/"Delete
// selected" button. Body is { ids: [...] } rather than a query string, since
// this can legitimately be a large batch (e.g. selecting hundreds of rows).
router.delete('/', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.filter((id) => typeof id === 'string')
    : [];
  if (!ids.length) return res.status(400).json({ error: 'ids is required' });

  const deletedCount = plays.deletePlays(ids);
  res.json({ deletedCount });
});

router.get('/export.csv', requireAuth, (req, res) => {
  const rows = exportRows(req);

  const lines = [EXPORT_COLUMNS.map((c) => csvField(c.header)).join(',')];
  rows.forEach((p) => {
    lines.push(EXPORT_COLUMNS.map((c) => csvField(p[c.key])).join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="stats.csv"');
  res.send(lines.join('\n'));
});

// Actual dates (not strings) for latestPlayAt/firstPlayAt so the sheet
// stays sortable/filterable in Excel like any other date column, matching
// the dd/mm/yyyy the dashboard itself shows.
const EXCEL_DATE_KEYS = new Set(['latestPlayAt', 'firstPlayAt']);
const EXCEL_DATE_FORMAT = 'dd/mm/yyyy hh:mm';

router.get('/export.xlsx', requireAuth, async (req, res) => {
  const rows = exportRows(req);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stats');
  sheet.columns = EXPORT_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.max(c.header.length + 2, 16),
    style: EXCEL_DATE_KEYS.has(c.key) ? { numFmt: EXCEL_DATE_FORMAT } : undefined,
  }));
  sheet.getRow(1).font = { bold: true };

  rows.forEach((p) => {
    const row = {};
    EXPORT_COLUMNS.forEach((c) => {
      row[c.key] = EXCEL_DATE_KEYS.has(c.key) && p[c.key] ? new Date(p[c.key]) : p[c.key];
    });
    sheet.addRow(row);
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="stats.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// Landscape so all 10 columns (Description especially) have room to breathe
// instead of being squeezed into a portrait page.
router.get('/export.pdf', requireAuth, async (req, res) => {
  const rows = exportRows(req);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="stats.pdf"');

  const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  doc.fontSize(16).text('Stats Export', { align: 'left' });
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor('#666').text(exportFilterSummary(req));
  doc.fillColor('#000');
  doc.moveDown(1);

  await doc.table(
    {
      headers: EXPORT_COLUMNS.map((c) => c.header),
      rows: rows.map((p) => EXPORT_COLUMNS.map((c) => (p[c.key] === null || p[c.key] === undefined ? '' : String(p[c.key])))),
    },
    {
      columnsSize: [80, 70, 90, 140, 45, 70, 60, 70, 70, 80],
      prepareHeader: () => doc.fontSize(8).font('Helvetica-Bold'),
      prepareRow: () => doc.fontSize(8).font('Helvetica'),
    }
  );

  doc.end();
});

module.exports = router;
