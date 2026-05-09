require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { z } = require('zod');

const {
  WEB_PORT = '3000',
  DB_PATH = 'cases.db',
} = process.env;

const resolvedDbPath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.resolve(process.cwd(), DB_PATH);

fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

const db = new Database(resolvedDbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS imported_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    customer_email TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    source TEXT NOT NULL DEFAULT 'upload',
    imported_at TEXT NOT NULL,
    import_job_id TEXT NOT NULL
  )
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_tickets_external_id
  ON imported_tickets (external_id)
  WHERE external_id IS NOT NULL AND external_id <> ''
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_import_jobs (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    file_name TEXT,
    total_rows INTEGER NOT NULL,
    imported_rows INTEGER NOT NULL,
    failed_rows INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_import_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_job_id TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    row_data TEXT NOT NULL,
    error_message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

const insertTicketStmt = db.prepare(`
  INSERT INTO imported_tickets (
    external_id, title, description, customer_email, status, priority, source, imported_at, import_job_id
  ) VALUES (
    @external_id, @title, @description, @customer_email, @status, @priority, @source, @imported_at, @import_job_id
  )
`);

const insertImportJobStmt = db.prepare(`
  INSERT INTO ticket_import_jobs (
    id, source_type, file_name, total_rows, imported_rows, failed_rows, created_at
  ) VALUES (
    @id, @source_type, @file_name, @total_rows, @imported_rows, @failed_rows, @created_at
  )
`);

const insertImportErrorStmt = db.prepare(`
  INSERT INTO ticket_import_errors (
    import_job_id, row_number, row_data, error_message, created_at
  ) VALUES (
    @import_job_id, @row_number, @row_data, @error_message, @created_at
  )
`);

const getImportErrorsStmt = db.prepare(`
  SELECT id, import_job_id, row_number, row_data, error_message, created_at
  FROM ticket_import_errors
  WHERE import_job_id = ?
  ORDER BY row_number ASC, id ASC
`);

const listTicketsStmt = db.prepare(`
  SELECT id, external_id, title, description, customer_email, status, priority, source, imported_at
  FROM imported_tickets
  WHERE (
    @status IS NULL OR @status = '' OR status = @status
  )
  AND (
    @search IS NULL OR @search = '' OR
    title LIKE @searchLike OR
    description LIKE @searchLike OR
    customer_email LIKE @searchLike OR
    external_id LIKE @searchLike
  )
  ORDER BY datetime(imported_at) DESC, id DESC
  LIMIT @limit
`);

const STATUS_VALUES = ['open', 'pending', 'closed'];
const PRIORITY_VALUES = ['low', 'medium', 'high', 'critical'];

const ticketSchema = z.object({
  external_id: z.string().trim().optional().nullable(),
  title: z.string().trim().min(1, 'title er påkrevd').max(200),
  description: z.string().trim().max(5000).optional().default(''),
  customer_email: z.string().trim().email('customer_email må være gyldig e-post').optional().nullable(),
  status: z.enum(STATUS_VALUES).optional().default('open'),
  priority: z.enum(PRIORITY_VALUES).optional().default('medium'),
});

function nowIso() {
  return new Date().toISOString();
}

function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeKeyName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function pickRowValue(row, candidates) {
  for (const key of Object.keys(row)) {
    const normalized = normalizeKeyName(key);
    if (candidates.includes(normalized)) {
      return row[key];
    }
  }
  return undefined;
}

function normalizeRow(row) {
  const externalId = pickRowValue(row, ['external_id', 'id', 'ticket_id', 'ticketid']);
  const title = pickRowValue(row, ['title', 'subject', 'tittel']);
  const description = pickRowValue(row, ['description', 'body', 'beskrivelse']);
  const customerEmail = pickRowValue(row, ['customer_email', 'email', 'kunde_epost', 'kunde_email']);
  const status = pickRowValue(row, ['status']);
  const priority = pickRowValue(row, ['priority', 'prioritet']);

  return {
    external_id: externalId == null ? null : String(externalId).trim(),
    title: title == null ? '' : String(title).trim(),
    description: description == null ? '' : String(description).trim(),
    customer_email: customerEmail == null || String(customerEmail).trim() === ''
      ? null
      : String(customerEmail).trim(),
    status: normalizeStatus(status),
    priority: normalizePriority(priority),
  };
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return 'open';

  if (['open', 'åpen', 'apen'].includes(value)) return 'open';
  if (['pending', 'avventer', 'in_progress', 'under_behandling'].includes(value)) return 'pending';
  if (['closed', 'lukket'].includes(value)) return 'closed';

  return value;
}

function normalizePriority(priority) {
  const value = String(priority || '').trim().toLowerCase();
  if (!value) return 'medium';

  if (['low', 'lav'].includes(value)) return 'low';
  if (['medium', 'middels'].includes(value)) return 'medium';
  if (['high', 'høy', 'hoy'].includes(value)) return 'high';
  if (['critical', 'kritisk'].includes(value)) return 'critical';

  return value;
}

function parseIncomingFile(file) {
  const name = (file.originalname || '').toLowerCase();
  const buffer = file.buffer;

  if (name.endsWith('.json')) {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('JSON-filen må være en liste av ticket-objekter.');
    }
    return parsed;
  }

  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  if (!Array.isArray(records)) {
    throw new Error('Kunne ikke lese CSV-filen.');
  }

  return records;
}

const runImportTransaction = db.transaction(({ rows, sourceType, fileName, jobId }) => {
  const createdAt = nowIso();
  let importedRows = 0;
  let failedRows = 0;

  rows.forEach((rawRow, index) => {
    const rowNumber = index + 1;

    try {
      const normalized = normalizeRow(rawRow);
      const validated = ticketSchema.parse(normalized);

      insertTicketStmt.run({
        external_id: validated.external_id || null,
        title: validated.title,
        description: validated.description || '',
        customer_email: validated.customer_email || null,
        status: validated.status,
        priority: validated.priority,
        source: sourceType,
        imported_at: createdAt,
        import_job_id: jobId,
      });

      importedRows += 1;
    } catch (error) {
      failedRows += 1;
      insertImportErrorStmt.run({
        import_job_id: jobId,
        row_number: rowNumber,
        row_data: JSON.stringify(rawRow),
        error_message: String(error?.message || error),
        created_at: createdAt,
      });
    }
  });

  insertImportJobStmt.run({
    id: jobId,
    source_type: sourceType,
    file_name: fileName || null,
    total_rows: rows.length,
    imported_rows: importedRows,
    failed_rows: failedRows,
    created_at: createdAt,
  });

  return {
    jobId,
    totalRows: rows.length,
    importedRows,
    failedRows,
  };
});

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ticket-import', timestamp: nowIso() });
});

app.post('/api/tickets/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Mangler fil. Bruk multipart/form-data med feltet file.' });
  }

  let rows;
  try {
    rows = parseIncomingFile(req.file);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || error) });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Filen inneholder ingen rader.' });
  }

  const jobId = createJobId();

  try {
    const summary = runImportTransaction({
      rows,
      sourceType: 'file_upload',
      fileName: req.file.originalname,
      jobId,
    });

    return res.status(201).json({
      message: 'Import fullført',
      ...summary,
      errorsUrl: `/api/tickets/import/errors/${summary.jobId}`,
    });
  } catch (error) {
    return res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post('/api/tickets/import-json', (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Body må være en ikke-tom array av tickets.' });
  }

  const jobId = createJobId();

  try {
    const summary = runImportTransaction({
      rows,
      sourceType: 'json_api',
      fileName: null,
      jobId,
    });

    return res.status(201).json({
      message: 'Import fullført',
      ...summary,
      errorsUrl: `/api/tickets/import/errors/${summary.jobId}`,
    });
  } catch (error) {
    return res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get('/api/tickets', (req, res) => {
  const status = req.query.status ? String(req.query.status).toLowerCase() : null;
  const search = req.query.search ? String(req.query.search).trim() : null;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));

  const tickets = listTicketsStmt.all({
    status,
    search,
    searchLike: search ? `%${search}%` : null,
    limit,
  });

  return res.json({ count: tickets.length, tickets });
});

app.get('/api/tickets/import/errors/:jobId', (req, res) => {
  const { jobId } = req.params;
  const errors = getImportErrorsStmt.all(jobId);
  return res.json({ count: errors.length, errors });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  const indexPath = path.join(process.cwd(), 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.status(404).send('Ingen frontend funnet.');
});

app.listen(Number(WEB_PORT), () => {
  console.log(`[WEB] Ticket import server kjører på http://localhost:${WEB_PORT}`);
});
