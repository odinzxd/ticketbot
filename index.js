require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const Database = require('better-sqlite3');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID = '',
  DOMMER_ROLE_NAME = 'Dommer',
  SAKSBEHANDLER_ROLE_NAME = 'Saksbehandler',
  ADMIN_ROLE_NAME = 'Admin',
  ADMIN_USER_ID = '',
  CASE_CATEGORY_NAME = 'Saker',
  ARCHIVE_CATEGORY_NAME = 'Arkiv',
  START_CHANNEL_NAME = 'start-sak',
  COURT_CODE = 'TINGR',
  BOT_SIGNATURE = 'Med vennlig hilsen Tuva Hansen (Sekretær Oslo Tingrett)',
  DB_PATH = 'cases.db',
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('[BOOT] Mangler nødvendige miljøvariabler. Sjekk .env-filen.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ---------------------------------------------------------------------------
// Database — SQLite med WAL for ytelse
// ---------------------------------------------------------------------------
const resolvedDbPath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.resolve(process.cwd(), DB_PATH);
fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

const db = new Database(resolvedDbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    case_number TEXT PRIMARY KEY,
    creator_id  TEXT NOT NULL,
    assigned_to TEXT,
    priority    TEXT NOT NULL DEFAULT 'Medium',
    witnesses   TEXT NOT NULL DEFAULT '[]',
    case_type   TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    complainant TEXT NOT NULL,
    defendant   TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    closed_at   TEXT,
    channel_id  TEXT UNIQUE
  )
`);

try {
  db.exec("ALTER TABLE cases ADD COLUMN priority TEXT NOT NULL DEFAULT 'Medium'");
} catch (error) {
  if (!String(error.message).toLowerCase().includes('duplicate column name')) {
    throw error;
  }
}

try {
  db.exec("ALTER TABLE cases ADD COLUMN witnesses TEXT NOT NULL DEFAULT '[]'");
} catch (error) {
  if (!String(error.message).toLowerCase().includes('duplicate column name')) {
    throw error;
  }
}

db.prepare("UPDATE cases SET priority = 'Medium' WHERE priority IS NULL OR priority = ''").run();
db.prepare("UPDATE cases SET witnesses = '[]' WHERE witnesses IS NULL OR witnesses = ''").run();

db.exec(`
  CREATE TABLE IF NOT EXISTS case_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    actor_id    TEXT,
    actor_tag   TEXT,
    details     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// ---------------------------------------------------------------------------
// Forberedte SQL-statements
// ---------------------------------------------------------------------------
const insertCaseStmt = db.prepare(`
  INSERT INTO cases (
    case_number, creator_id, assigned_to, priority, witnesses, case_type, title, description,
    complainant, defendant, status, created_at, closed_at, channel_id
  ) VALUES (
    @case_number, @creator_id, @assigned_to, @priority, @witnesses, @case_type, @title, @description,
    @complainant, @defendant, @status, @created_at, @closed_at, @channel_id
  )
`);

const insertRecoveredCaseStmt = db.prepare(`
  INSERT OR IGNORE INTO cases (
    case_number, creator_id, assigned_to, priority, witnesses, case_type, title, description,
    complainant, defendant, status, created_at, closed_at, channel_id
  ) VALUES (
    @case_number, @creator_id, @assigned_to, @priority, @witnesses, @case_type, @title, @description,
    @complainant, @defendant, @status, @created_at, @closed_at, @channel_id
  )
`);

const getCaseByChannelStmt  = db.prepare('SELECT * FROM cases WHERE channel_id = ?');
const getCaseByNumberStmt   = db.prepare('SELECT * FROM cases WHERE case_number = ?');
const getCasesByCreatorStmt = db.prepare(`
  SELECT *
  FROM cases
  WHERE creator_id = ?
  ORDER BY
    CASE priority
      WHEN 'Kritisk' THEN 0
      WHEN 'Høy' THEN 1
      WHEN 'Medium' THEN 2
      WHEN 'Lav' THEN 3
      ELSE 4
    END,
    datetime(created_at) DESC
`);
const updateAssignedStmt    = db.prepare('UPDATE cases SET assigned_to = ?, status = ? WHERE case_number = ?');
const closeCaseStmt         = db.prepare('UPDATE cases SET status = ?, closed_at = ? WHERE case_number = ?');
const archiveCaseStmt       = db.prepare('UPDATE cases SET status = ? WHERE case_number = ?');
const reopenCaseStmt        = db.prepare('UPDATE cases SET status = ?, closed_at = NULL WHERE case_number = ?');
const updateStatusStmt      = db.prepare('UPDATE cases SET status = ? WHERE case_number = ?');
const updatePriorityStmt    = db.prepare('UPDATE cases SET priority = ? WHERE case_number = ?');
const updateWitnessesStmt   = db.prepare('UPDATE cases SET witnesses = ? WHERE case_number = ?');
const updateCaseChannelStmt = db.prepare('UPDATE cases SET channel_id = ? WHERE case_number = ?');
const getArchivedCaseNumbersStmt = db.prepare("SELECT case_number FROM cases WHERE status = 'Arkivert'");
const deleteEventsByCaseStmt = db.prepare('DELETE FROM case_events WHERE case_number = ?');
const deleteArchivedCasesStmt = db.prepare("DELETE FROM cases WHERE status = 'Arkivert'");

const insertCaseEventStmt = db.prepare(`
  INSERT INTO case_events (case_number, event_type, actor_id, actor_tag, details, created_at)
  VALUES (@case_number, @event_type, @actor_id, @actor_tag, @details, @created_at)
`);
const getCaseEventsStmt = db.prepare(
  'SELECT * FROM case_events WHERE case_number = ? ORDER BY created_at DESC, id DESC LIMIT ?',
);
const getBotSettingStmt = db.prepare('SELECT value FROM bot_settings WHERE key = ?');
const upsertBotSettingStmt = db.prepare(`
  INSERT INTO bot_settings (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

// ---------------------------------------------------------------------------
// Konstanter
// ---------------------------------------------------------------------------
const CASE_TYPES = [
  { label: 'Tvistesak',  value: 'Tvistesak',  description: 'Sivile tvister mellom parter' },
  { label: 'Straffesak', value: 'Straffesak',  description: 'Sak relatert til strafferettslige forhold' },
  { label: 'Voldsskade erstatning', value: 'Voldsskade erstatning', description: 'Erstatningssak for voldsskade' },
];

const CASE_TYPE_CHOICES = [
  { name: 'Tvistesak', value: 'Tvistesak' },
  { name: 'Straffesak', value: 'Straffesak' },
  { name: 'Voldsskade erstatning', value: 'Voldsskade erstatning' },
];

const PRIORITY_CHOICES = [
  { name: 'Lav', value: 'Lav' },
  { name: 'Medium', value: 'Medium' },
  { name: 'Høy', value: 'Høy' },
  { name: 'Kritisk', value: 'Kritisk' },
];

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Opprett/oppdater en startkanal for nye saker'),
  new SlashCommandBuilder()
    .setName('sett_sakskategori')
    .setDescription('Sett kategori for aktive saker (kun admin)')
    .addChannelOption(option =>
      option.setName('kategori')
        .setDescription('Kategorien som skal brukes for aktive saker')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('sett_arkivkategori')
    .setDescription('Sett kategori for arkiverte saker (kun admin)')
    .addChannelOption(option =>
      option.setName('kategori')
        .setDescription('Kategorien som skal brukes for arkiverte saker')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('sett_startkanal')
    .setDescription('Sett tekstkanal for startpanel (kun admin)')
    .addChannelOption(option =>
      option.setName('kanal')
        .setDescription('Tekstkanalen som skal brukes til startpanel')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('ny_sak')
    .setDescription('Opprett en ny sak'),
  new SlashCommandBuilder()
    .setName('konverter_ticket')
    .setDescription('Konverter en eksisterende ticket-kanal til en sak (beholder kanaltilganger)')
    .addStringOption(option =>
      option.setName('sakstype')
        .setDescription('Sakstype for den konverterte saken')
        .setRequired(true)
        .addChoices(...CASE_TYPE_CHOICES),
    )
    .addChannelOption(option =>
      option.setName('kanal')
        .setDescription('Kanalen som skal konverteres (standard: gjeldende kanal)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom genereres et nytt.')
        .setRequired(false),
    )
    .addStringOption(option =>
      option.setName('tittel')
        .setDescription('Valgfri tittel på saken')
        .setRequired(false)
        .setMaxLength(100),
    )
    .addStringOption(option =>
      option.setName('beskrivelse')
        .setDescription('Valgfri beskrivelse av saken')
        .setRequired(false)
        .setMaxLength(1000),
    )
    .addStringOption(option =>
      option.setName('prioritet')
        .setDescription('Valgfri prioritet')
        .setRequired(false)
        .addChoices(...PRIORITY_CHOICES),
    )
    .addUserOption(option =>
      option.setName('oppretter')
        .setDescription('Valgfri bruker som skal stå som oppretter')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('flytt_arkiv')
    .setDescription('Flytt en sak til arkivkategori')
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom brukes gjeldende kanal.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('gjenapne_sak')
    .setDescription('Gjenåpne en lukket eller arkivert sak (kun staff)')
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom brukes gjeldende kanal.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('legg_til_medlem')
    .setDescription('Gi et medlem tilgang til sakskanalen')
    .addUserOption(option =>
      option.setName('bruker')
        .setDescription('Medlemmet som skal få tilgang')
        .setRequired(true),
    )
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom brukes gjeldende kanal.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('fjern_fra_sak')
    .setDescription('Fjern et medlems tilgang fra sakskanalen (kun staff)')
    .addUserOption(option =>
      option.setName('bruker')
        .setDescription('Medlemmet som skal miste tilgang')
        .setRequired(true),
    )
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom brukes gjeldende kanal.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('sett_status')
    .setDescription('Sett status på en sak (kun staff)')
    .addStringOption(option =>
      option.setName('status')
        .setDescription('Ny status')
        .setRequired(true)
        .addChoices(
          { name: 'Åpen', value: 'Åpen' },
          { name: 'Under behandling', value: 'Under behandling' },
          { name: 'Avventer svar', value: 'Avventer svar' },
          { name: 'Lukket', value: 'Lukket' },
        ),
    )
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom brukes gjeldende kanal.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('sett_prioritet')
    .setDescription('Sett prioritet på en sak')
    .addStringOption(option =>
      option.setName('prioritet')
        .setDescription('Ny prioritet')
        .setRequired(true)
        .addChoices(...PRIORITY_CHOICES),
    )
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom brukes gjeldende kanal.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('legg_til_vitne')
    .setDescription('Legg til vitne med navn og forklaring på en sak')
    .addStringOption(option =>
      option.setName('navn')
        .setDescription('Navn på vitnet')
        .setRequired(true)
        .setMaxLength(100),
    )
    .addStringOption(option =>
      option.setName('forklaring')
        .setDescription('Forklaring fra vitnet')
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addStringOption(option =>
      option.setName('saksnummer')
        .setDescription('Valgfritt saksnummer. Lar du den stå tom brukes gjeldende kanal.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('slett_arkiv')
    .setDescription('Slett hele arkivet (kun admin)'),
  new SlashCommandBuilder()
    .setName('send_melding')
    .setDescription('Send en melding som botten i en kanal (kun admin)')
    .addStringOption(option =>
      option.setName('melding')
        .setDescription('Meldingen som skal sendes')
        .setRequired(true)
        .setMaxLength(1800),
    )
    .addChannelOption(option =>
      option.setName('kanal')
        .setDescription('Kanalen meldingen skal sendes i (standard: gjeldende kanal)')
        .setRequired(false),
    ),
].map(command => command.toJSON());

// ---------------------------------------------------------------------------
// Hjelpefunksjoner — logging
// ---------------------------------------------------------------------------
function logAction(action, details) {
  console.log(`[${new Date().toISOString()}] [${action}] ${details}`);
}

function recordCaseEvent(caseNumber, eventType, actor, details) {
  insertCaseEventStmt.run({
    case_number: caseNumber,
    event_type:  eventType,
    actor_id:    actor?.id   || null,
    actor_tag:   actor?.tag  || null,
    details,
    created_at:  new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner — svar
// ---------------------------------------------------------------------------
function safeReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner — formatering
// ---------------------------------------------------------------------------
function formatTimestamp(isoString) {
  if (!isoString) return 'Ikke satt';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return `${date.toLocaleDateString('nb-NO')} ${date.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' })}`;
}

function truncate(text, max = 1024) {
  if (!text) return 'Ikke oppgitt';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizePriority(input) {
  const value = (input || '').trim().toLowerCase();
  if (value === 'lav') return 'Lav';
  if (value === 'høy' || value === 'hoy') return 'Høy';
  if (value === 'kritisk') return 'Kritisk';
  return 'Medium';
}

function getPriorityEmoji(priority) {
  if (priority === 'Kritisk' || priority === 'Høy') return '🟥';
  if (priority === 'Medium') return '🟨';
  if (priority === 'Lav') return '🟩';
  return '⬜';
}

function getOptionalModalValue(interaction, fieldId) {
  try {
    return interaction.fields.getTextInputValue(fieldId);
  } catch {
    return '';
  }
}

function parseWitnessNamesInput(raw) {
  if (!raw) return [];
  return raw.split('\n').filter(line => line.trim());
}

function getDocumentationRequirements(caseType) {
  const requirements = {
    'Voldsskade erstatning': {
      title: '⚖️ Voldsskade Erstatning',
      description: 'Erstatningssak for voldsskade med krav om kompensasjon.',
      docs: [
        'Helserapport og legens vurdering (med navn på lege)',
        'Detaljert hendelseforløp',
        'Bevis for pådratt skade (medisinske rapporter, kvitteringer, osv.)',
      ],
    },
    'Straffesak': {
      title: '🚔 Straffesak',
      description: 'Sak relatert til strafferettslige forhold.',
      docs: [
        'Relevante paragrafer fra lovverk',
        'Kort beskrivelse av hendelsen',
        'Vitner (navn og kontaktinformasjon)',
      ],
    },
    'Tvistesak': {
      title: '⚖️ Tvistesak',
      description: 'Sivile tvister mellom parter.',
      docs: [
        'Detaljert beskrivelse av den andre part(en)',
        'Bakgrunn for tvisten',
        'Relevant dokumentasjon og bevis',
        'Krav og søksmål',
      ],
    },
  };
  return requirements[caseType] || null;
}

function parseWitnessNamesInput(raw) {
  if (!raw) return [];

  const seen = new Set();
  const names = [];

  for (const item of raw.split(/[;,\n]/)) {
    const name = item.trim();
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    names.push(name.slice(0, 100));
    if (names.length >= 10) break;
  }

  return names;
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner — saksnummer
// ---------------------------------------------------------------------------
function getCourtCode(guild) {
  const fallback = guild?.name || COURT_CODE;
  const normalized = fallback
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z]/g, '');
  return (normalized || 'TINGR').slice(0, 5);
}

function getCaseTypeCode(caseType) {
  const map = { Tvistesak: 'TVI', Straffesak: 'STR', 'Voldsskade erstatning': 'VOL' };
  return map[caseType] || 'GEN';
}

function generateCaseNumber(caseType, guild) {
  const year    = String(new Date().getFullYear()).slice(-2);
  const seq     = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const type    = getCaseTypeCode(caseType);
  const court   = getCourtCode(guild);
  return `${year}-${seq}${type}-${court}`;
}

function getCaseChannelSuffix(caseNumber) {
  return caseNumber
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function getPriorityChannelEmoji(priority) {
  if (priority === 'Kritisk' || priority === 'Høy') return '🔴';
  if (priority === 'Lav') return '🟢';
  return '🟡';
}

function getShortCaseReference(caseNumber) {
  const match = String(caseNumber || '').toUpperCase().match(/^(\d{2})-(\d{6})([A-Z]{3})-[A-Z]+$/);
  if (match) {
    const [, year, seq, type] = match;
    return `${year}-${type.toLowerCase()}-${seq.slice(-4)}`;
  }

  return getCaseChannelSuffix(caseNumber).slice(0, 18) || 'sak';
}

function buildCaseChannelName(caseData) {
  const emoji = getPriorityChannelEmoji(caseData.priority || 'Medium');
  const shortRef = getShortCaseReference(caseData.case_number);
  return `${emoji}-sak-${shortRef}`;
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner — roller & tilgang
// ---------------------------------------------------------------------------
function getRoleByName(guild, roleName) {
  return guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase()) || null;
}

function getConfiguredRoles(guild) {
  return {
    dommer:        getRoleByName(guild, DOMMER_ROLE_NAME),
    saksbehandler: getRoleByName(guild, SAKSBEHANDLER_ROLE_NAME),
    admin:         getRoleByName(guild, ADMIN_ROLE_NAME),
  };
}

function hasRole(member, roleName) {
  return member.roles.cache.some(r => r.name.toLowerCase() === roleName.toLowerCase());
}

function hasAnyStaffRole(member) {
  return [DOMMER_ROLE_NAME, SAKSBEHANDLER_ROLE_NAME, ADMIN_ROLE_NAME].some(n => hasRole(member, n));
}

function isConfiguredAdminUser(userId) {
  return Boolean(ADMIN_USER_ID) && userId === ADMIN_USER_ID;
}

function isAdmin(member)       {
  if (ADMIN_USER_ID) return isConfiguredAdminUser(member?.id);
  return hasRole(member, ADMIN_ROLE_NAME);
}
function isJudge(member)       { return hasRole(member, DOMMER_ROLE_NAME); }
function isCaseHandler(member) { return hasRole(member, SAKSBEHANDLER_ROLE_NAME); }

function hasGuildAdminAccess(interaction) {
  if (ADMIN_USER_ID) {
    return isConfiguredAdminUser(interaction.user.id);
  }
  return isAdmin(interaction.member)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.guild?.ownerId === interaction.user.id;
}

function getBotSetting(key) {
  return getBotSettingStmt.get(key)?.value || null;
}

function setBotSetting(key, value) {
  upsertBotSettingStmt.run(key, value);
}

function canManageCase(member, caseData) {
  if (!member) return false;
  if (isAdmin(member) || isJudge(member)) return true;
  if (isCaseHandler(member) && caseData.assigned_to === member.id) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner — sak-oppslag
// ---------------------------------------------------------------------------
function normalizeCaseNumber(caseNumber) {
  return String(caseNumber || '').trim().toUpperCase();
}

function resolveCaseFromInteraction(interaction) {
  const num = normalizeCaseNumber(interaction.options?.getString('saksnummer'));
  return num
    ? getCaseByNumberStmt.get(num)
    : getCaseByChannelStmt.get(interaction.channelId);
}

function extractCaseNumberFromLegacyMessage(interaction) {
  const embeds = interaction.message?.embeds || [];
  for (const embed of embeds) {
    const titleMatch = String(embed?.title || '').match(/Saksmappe\s*•\s*(.+)$/i);
    if (titleMatch?.[1]) return normalizeCaseNumber(titleMatch[1]);

    const fields = embed?.fields || [];
    const caseField = fields.find(field => String(field?.name || '').toLowerCase() === 'saksnummer');
    if (caseField?.value) return normalizeCaseNumber(caseField.value);
  }

  const topicMatch = String(interaction.channel?.topic || '').match(/Sak\s+([A-Z0-9\-]+)/i);
  if (topicMatch?.[1]) return normalizeCaseNumber(topicMatch[1]);

  return '';
}

function extractCreatorIdFromLegacyContext(interaction) {
  const fromMessage = String(interaction.message?.content || '').match(/<@(\d+)>/);
  if (fromMessage?.[1]) return fromMessage[1];

  const fromTopic = String(interaction.channel?.topic || '').match(/Opprettet av\s+(\d+)/i);
  if (fromTopic?.[1]) return fromTopic[1];

  return interaction.user.id;
}

function extractCaseTypeFromLegacyContext(interaction, caseNumber) {
  const embedTypeField = interaction.message?.embeds
    ?.flatMap(embed => embed?.fields || [])
    ?.find(field => String(field?.name || '').toLowerCase() === 'type');

  const fromField = String(embedTypeField?.value || '').trim();
  if (fromField) return fromField;

  const match = String(caseNumber || '').toUpperCase().match(/^\d{2}-\d{6}([A-Z]{3})-/);
  const code = match?.[1] || '';
  if (code === 'TVI') return 'Tvistesak';
  if (code === 'STR') return 'Straffesak';
  if (code === 'VOL') return 'Voldsskade erstatning';
  return 'Ukjent';
}

function recoverLegacyCaseFromInteraction(interaction, caseNumber) {
  const normalizedCaseNumber = normalizeCaseNumber(caseNumber);
  if (!normalizedCaseNumber) return null;

  const creatorId = extractCreatorIdFromLegacyContext(interaction);
  const caseType = extractCaseTypeFromLegacyContext(interaction, normalizedCaseNumber);

  const recoveredCase = {
    case_number: normalizedCaseNumber,
    creator_id: creatorId,
    assigned_to: null,
    priority: 'Medium',
    witnesses: '[]',
    case_type: caseType,
    title: `Gjenopprettet sak ${normalizedCaseNumber}`,
    description: 'Sak gjenopprettet automatisk fra legacy knappedata.',
    complainant: 'Ikke oppgitt',
    defendant: 'Ikke oppgitt',
    status: 'Åpen',
    created_at: new Date().toISOString(),
    closed_at: null,
    channel_id: interaction.channelId,
  };

  insertRecoveredCaseStmt.run(recoveredCase);
  const persisted = getCaseByNumberStmt.get(normalizedCaseNumber);
  if (persisted) {
    if (persisted.channel_id !== interaction.channelId) {
      updateCaseChannelStmt.run(interaction.channelId, persisted.case_number);
    }
    logAction('CASE_RECOVERED', `${persisted.case_number} ble gjenopprettet fra legacy-data i kanal ${interaction.channelId}`);
    return getCaseByNumberStmt.get(persisted.case_number);
  }

  return null;
}

function resolveCaseFromButtonInteraction(interaction, caseNumber) {
  const normalizedCaseNumber = normalizeCaseNumber(caseNumber);
  const caseByNumber = getCaseByNumberStmt.get(normalizedCaseNumber);
  if (caseByNumber) {
    if (caseByNumber.channel_id !== interaction.channelId) {
      updateCaseChannelStmt.run(interaction.channelId, caseByNumber.case_number);
      logAction('CASE_CHANNEL_REPAIRED', `${caseByNumber.case_number} kanal oppdatert til ${interaction.channelId}`);
      return getCaseByNumberStmt.get(caseByNumber.case_number);
    }
    return caseByNumber;
  }

  const caseByChannel = getCaseByChannelStmt.get(interaction.channelId);
  if (caseByChannel) return caseByChannel;

  const legacyCaseNumber = extractCaseNumberFromLegacyMessage(interaction);
  if (legacyCaseNumber) {
    const caseByLegacyData = getCaseByNumberStmt.get(legacyCaseNumber);
    if (caseByLegacyData) {
      if (caseByLegacyData.channel_id !== interaction.channelId) {
        updateCaseChannelStmt.run(interaction.channelId, caseByLegacyData.case_number);
        logAction('CASE_CHANNEL_REPAIRED', `${caseByLegacyData.case_number} kanal oppdatert via legacy-oppslag til ${interaction.channelId}`);
      }
      return getCaseByNumberStmt.get(caseByLegacyData.case_number);
    }

    const recoveredCase = recoverLegacyCaseFromInteraction(interaction, legacyCaseNumber);
    if (recoveredCase) return recoveredCase;
  }

  logAction(
    'CASE_LOOKUP_MISS',
    `Fant ikke sak via knapp. customId=${interaction.customId} kanal=${interaction.channelId} guild=${interaction.guildId}`,
  );
  return null;
}

function getCaseChannel(guild, caseData) {
  if (!caseData?.channel_id) return null;
  return guild.channels.cache.get(caseData.channel_id) || null;
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner — Discord UI (embeds, knapper, modals, menyer)
// ---------------------------------------------------------------------------
function buildCaseEmbed(caseData, guild) {
  const assignedMember = caseData.assigned_to ? guild.members.cache.get(caseData.assigned_to) : null;
  const witnesses = parseJsonArray(caseData.witnesses);
  const priority = caseData.priority || 'Medium';
  const priorityColorMap = {
    Lav: 0x2ecc71,
    Medium: 0x3498db,
    Høy: 0xe67e22,
    Kritisk: 0xe74c3c,
  };
  const colorMap = {
    Åpen:     0x3498db,
    Tildelt:  0xf1c40f,
    'Under behandling': 0xf1c40f,
    'Avventer svar': 0x9b59b6,
    Lukket:   0xe74c3c,
    Arkivert: 0x95a5a6,
  };

  const embed = new EmbedBuilder()
    .setColor(colorMap[caseData.status] || priorityColorMap[priority] || 0x2c3e50)
    .setTitle(`Saksmappe • ${caseData.case_number}`)
    .setDescription(truncate(caseData.description, 4096))
    .addFields(
      { name: 'Saksnummer',    value: caseData.case_number,                                    inline: true },
      { name: 'Type',          value: caseData.case_type,                                       inline: true },
      { name: 'Status',        value: caseData.status,                                          inline: true },
      { name: 'Prioritet',     value: `${getPriorityEmoji(priority)} ${priority}`,              inline: true },
      { name: 'Opprettet av',  value: `<@${caseData.creator_id}>`,                              inline: true },
      { name: 'Saksbehandler', value: assignedMember ? `<@${assignedMember.id}>` : 'Ikke tildelt', inline: true },
      { name: 'Sakstittel',    value: truncate(caseData.title),                                 inline: false },
      { name: 'Opprettet',     value: formatTimestamp(caseData.created_at),                     inline: true },
      { name: 'Lukket',        value: formatTimestamp(caseData.closed_at),                      inline: true },
    )
    .setFooter({ text: 'Profesjonelt saksbehandlingssystem' })
    .setTimestamp(new Date(caseData.created_at));

  if (witnesses.length > 0) {
    embed.addFields({
      name: `Vitner (${witnesses.length})`,
      value: witnesses.slice(0, 6).map((w, i) => `${i + 1}. **${truncate(w.name, 80)}** — ${truncate(w.explanation, 140)}`).join('\n'),
      inline: false,
    });
  }

  return embed;
}

function buildCaseActionRows(caseData) {
  const isClosed   = caseData.status === 'Lukket';
  const isArchived = caseData.status === 'Arkivert';

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`take_case:${caseData.case_number}`)
        .setLabel('Ta sak').setStyle(ButtonStyle.Primary)
        .setDisabled(isClosed || isArchived),
      new ButtonBuilder()
        .setCustomId(`close_case:${caseData.case_number}`)
        .setLabel('Lukk sak').setStyle(ButtonStyle.Danger)
        .setDisabled(isClosed || isArchived),
      new ButtonBuilder()
        .setCustomId(`archive_case:${caseData.case_number}`)
        .setLabel('Arkiver').setStyle(ButtonStyle.Secondary)
        .setDisabled(isArchived),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`status_btn:${caseData.case_number}:open`)
        .setLabel('Sett Åpen').setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed || isArchived),
      new ButtonBuilder()
        .setCustomId(`status_btn:${caseData.case_number}:processing`)
        .setLabel('Under behandling').setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed || isArchived),
      new ButtonBuilder()
        .setCustomId(`status_btn:${caseData.case_number}:waiting`)
        .setLabel('Avventer svar').setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed || isArchived),
    ),
  ];
}

function buildCaseHistoryEmbed(caseData, events) {
  const lines = events.length > 0
    ? events.map(e => `• ${formatTimestamp(e.created_at)} — ${truncate(e.details, 180)}`)
    : ['Ingen historikk registrert ennå.'];

  return new EmbedBuilder()
    .setColor(0x8e44ad)
    .setTitle(`Sakshistorikk • ${caseData.case_number}`)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Status', value: caseData.status,                                           inline: true },
      { name: 'Type',   value: caseData.case_type,                                        inline: true },
      { name: 'Kanal',  value: caseData.channel_id ? `<#${caseData.channel_id}>` : 'Ingen kanal', inline: true },
    )
    .setTimestamp();
}

function createCaseSelectMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('new_case_type_select')
      .setPlaceholder('Velg type sak')
      .addOptions(CASE_TYPES),
  );
}

function createCaseModal(caseType) {
  return new ModalBuilder()
    .setCustomId(`new_case_modal:${caseType}`)
    .setTitle(`Ny sak • ${caseType}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('title')
          .setLabel('Navn på saken').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('description')
          .setLabel('Beskrivelse').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true),
      ),
    );
}


function createWitnessModal(caseNumber) {
  return new ModalBuilder()
    .setCustomId(`witness_modal:${caseNumber}`)
    .setTitle('Legg til vitne')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('witness_name')
          .setLabel('Navn på vitnet')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('witness_explanation')
          .setLabel('Forklaring')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );
}

function createInitialWitnessRow(caseNumber) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`add_witness_start:${caseNumber}`)
      .setLabel('Legg til vitne nå')
      .setStyle(ButtonStyle.Secondary),
  );
}

function createStartPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('start_case')
      .setLabel('Start sak')
      .setStyle(ButtonStyle.Success),
  );
}

function buildStartPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Start ny sak')
    .setDescription('Trykk på **Start sak** for å velge sakstype og opprette en ny sak.')
    .setFooter({ text: 'Saksopprettelse' })
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Kommandoregistrering — med fallback til global registrering
// ---------------------------------------------------------------------------
async function registerCommands(guildIds = []) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const uniqueGuildIds = [...new Set([
    ...(GUILD_ID ? [GUILD_ID] : []),
    ...guildIds,
  ])];

  let registeredGuildCount = 0;

  for (const guildId of uniqueGuildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: COMMANDS });
      registeredGuildCount += 1;
      logAction('COMMANDS', `Slash commands registrert mot guild ${guildId}.`);
    } catch (error) {
      if (error?.code === 50001) {
        console.warn(`[REGISTER_COMMANDS_WARNING] Mangler tilgang til guild ${guildId}. Hopper over denne guilden.`);
        continue;
      }
      throw error;
    }
  }

  if (registeredGuildCount === 0) {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS });
    logAction('COMMANDS', 'Slash commands registrert globalt. Det kan ta litt tid før de vises i Discord.');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    logAction('COMMANDS', 'Globale kommandoer tømt for å unngå duplikater mot guild-kommandoer.');
  }

  return { scope: registeredGuildCount > 0 ? 'guild' : 'global', guildCount: registeredGuildCount };
}

// ---------------------------------------------------------------------------
// Kanaloperasjoner
// ---------------------------------------------------------------------------
function findConfiguredCategory(guild, settingKey, fallbackName) {
  const configuredId = getBotSetting(settingKey);
  if (configuredId) {
    const configured = guild.channels.cache.get(configuredId);
    if (configured?.type === ChannelType.GuildCategory) return configured;
  }

  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === fallbackName.toLowerCase(),
  ) || null;
}

async function ensureCategory(guild, fallbackName, settingKey) {
  let category = findConfiguredCategory(guild, settingKey, fallbackName);
  if (!category) {
    category = await guild.channels.create({
      name: fallbackName,
      type: ChannelType.GuildCategory,
      reason: `Automatisk opprettet: ${fallbackName}`,
    });
    logAction('CATEGORY_CREATE', `${fallbackName} (${category.id})`);
  }

  if (settingKey) setBotSetting(settingKey, category.id);
  return category;
}

async function createCaseChannel(guild, caseData, creatorId) {
  const caseCategory = await ensureCategory(guild, CASE_CATEGORY_NAME, 'case_category');

  const permissionOverwrites = buildActiveCasePermissionOverwrites(guild, creatorId);

  return guild.channels.create({
    name: buildCaseChannelName(caseData),
    type: ChannelType.GuildText,
    parent: caseCategory.id,
    permissionOverwrites,
    topic: `Sak ${caseData.case_number} • ${caseData.case_type} • Opprettet av ${creatorId}`,
    reason: `Ny sak: ${caseData.case_number}`,
  });
}

function buildActiveCasePermissionOverwrites(guild, creatorId) {
  const { dommer, saksbehandler, admin } = getConfiguredRoles(guild);

  // Alle kan opprette saker — staff-roller legges til om de finnes.
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    { id: creatorId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];

  const staffRoles = [
    { role: dommer,        permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { role: saksbehandler, permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { role: admin,         permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
  ];

  for (const { role, permissions } of staffRoles) {
    if (!role) continue;
    permissionOverwrites.push({ id: role.id, allow: permissions });
  }

  return permissionOverwrites;
}

function buildArchivedCasePermissionOverwrites(guild) {
  const { dommer } = getConfiguredRoles(guild);

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels],
    },
  ];

  if (dommer) {
    permissionOverwrites.push({
      id: dommer.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  return permissionOverwrites;
}

async function postCaseMessage(channel, caseData) {
  const docReq = getDocumentationRequirements(caseData.case_type);
  const extraEmbeds = [];
  if (docReq) {
    extraEmbeds.push(
      new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`📋 Påkrevd dokumentasjon – ${docReq.title}`)
        .setDescription(docReq.description)
        .addFields({
          name: 'Dokumentasjon som må leveres',
          value: docReq.docs.map(d => `• ${d}`).join('\n'),
          inline: false,
        })
        .setFooter({ text: 'Sørg for at all dokumentasjon er på plass før videre behandling' }),
    );
  }
  await channel.send({
    content: `Sak opprettet for <@${caseData.creator_id}>`,
    embeds: [buildCaseEmbed(caseData, channel.guild), ...extraEmbeds],
    components: buildCaseActionRows(caseData),
  });
}

async function refreshCaseMessage(channel, caseData) {
  const messages = await channel.messages.fetch({ limit: 20 });
  const target   = messages.find(m => m.author.id === client.user.id && m.components.length > 0);
  if (!target) return;
  await target.edit({
    embeds: [buildCaseEmbed(caseData, channel.guild)],
    components: buildCaseActionRows(caseData),
  });
}

async function syncCaseChannelPresentation(channel, caseData) {
  const expectedName = buildCaseChannelName(caseData);
  if (channel.name !== expectedName) {
    await channel.setName(expectedName, `Oppdatert prioritet for sak ${caseData.case_number}`);
  }
}

async function moveCaseToArchive(channel, caseData, actor) {
  const archiveCategory = await ensureCategory(channel.guild, ARCHIVE_CATEGORY_NAME, 'archive_category');
  await channel.setParent(archiveCategory.id, { lockPermissions: false });
  archiveCaseStmt.run('Arkivert', caseData.case_number);

  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);
  await refreshCaseMessage(channel, updatedCase);
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('Sak arkivert')
      .setDescription(`Saken ${caseData.case_number} er flyttet til arkiv av ${actor.tag}.`).setTimestamp()],
  });

  recordCaseEvent(caseData.case_number, 'ARCHIVED', actor, `Saken ble arkivert av ${actor.tag}.`);
  logAction('CASE_ARCHIVED', `${caseData.case_number} arkivert av ${actor.tag}`);
  return updatedCase;
}

async function moveCaseToActiveCategory(channel, caseData) {
  const caseCategory = await ensureCategory(channel.guild, CASE_CATEGORY_NAME, 'case_category');
  await channel.setParent(caseCategory.id, { lockPermissions: false });
  await channel.permissionOverwrites.set(
    buildActiveCasePermissionOverwrites(channel.guild, caseData.creator_id),
    `Gjenåpnet sak ${caseData.case_number}: tilganger gjenopprettet`,
  );
}

async function ensureStartChannel(guild) {
  const configuredId = getBotSetting('start_channel');
  let channel = configuredId ? guild.channels.cache.get(configuredId) : null;
  if (!channel || channel.type !== ChannelType.GuildText) {
    channel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name.toLowerCase() === START_CHANNEL_NAME.toLowerCase(),
    );
  }

  if (!channel) {
    channel = await guild.channels.create({
      name: START_CHANNEL_NAME,
      type: ChannelType.GuildText,
      reason: 'Startkanal for saksopprettelse',
    });
    logAction('START_CHANNEL_CREATE', `${channel.name} (${channel.id})`);
  }

  setBotSetting('start_channel', channel.id);

  return channel;
}

async function postOrUpdateStartPanel(channel) {
  const messages = await channel.messages.fetch({ limit: 30 });
  const existing = messages.find(
    m => m.author.id === client.user.id
      && m.components.some(row => row.components.some(component => component.customId === 'start_case')),
  );

  const payload = {
    embeds: [buildStartPanelEmbed()],
    components: [createStartPanelRow()],
  };

  if (existing) {
    await existing.edit(payload);
    return existing;
  }

  return channel.send(payload);
}

// ---------------------------------------------------------------------------
// Kommandohåndterere
// ---------------------------------------------------------------------------
async function handleNewCaseCommand(interaction) {
  await interaction.reply({ content: 'Velg sakstype for å fortsette.', components: [createCaseSelectMenu()], flags: MessageFlags.Ephemeral });
}

async function handleConvertTicketCommand(interaction) {
  if (!hasAnyStaffRole(interaction.member))
    return safeReply(interaction, { content: 'Kun staff kan konvertere ticket-kanaler til saker.' });

  const channel = interaction.options.getChannel('kanal') || interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText)
    return safeReply(interaction, { content: 'Du må velge en tekstkanal.' });

  const existingCase = getCaseByChannelStmt.get(channel.id);
  if (existingCase) {
    return safeReply(interaction, {
      content: `Kanalen er allerede knyttet til saken ${existingCase.case_number}. Ingen endringer gjort.`,
    });
  }

  const caseType = interaction.options.getString('sakstype', true);
  const creator = interaction.options.getUser('oppretter') || interaction.user;
  const priority = normalizePriority(interaction.options.getString('prioritet'));
  const title = (interaction.options.getString('tittel') || `Migrert fra ${channel.name}`).trim();
  const description = (interaction.options.getString('beskrivelse')
    || `Ticket-kanalen ${channel.name} ble konvertert til sak av ${interaction.user.tag}.`).trim();

  let caseNumber = normalizeCaseNumber(interaction.options.getString('saksnummer'));
  if (caseNumber) {
    if (getCaseByNumberStmt.get(caseNumber)) {
      return safeReply(interaction, { content: `Saksnummer ${caseNumber} finnes allerede. Velg et annet.` });
    }
  } else {
    caseNumber = generateCaseNumber(caseType, interaction.guild);
    while (getCaseByNumberStmt.get(caseNumber)) caseNumber = generateCaseNumber(caseType, interaction.guild);
  }

  const caseData = {
    case_number: caseNumber,
    creator_id: creator.id,
    assigned_to: null,
    priority,
    witnesses: '[]',
    case_type: caseType,
    title,
    description,
    complainant: 'Ikke oppgitt',
    defendant: 'Ikke oppgitt',
    status: 'Åpen',
    created_at: new Date().toISOString(),
    closed_at: null,
    channel_id: channel.id,
  };

  try {
    insertCaseStmt.run(caseData);
    await syncCaseChannelPresentation(channel, caseData);

    const previousTopic = channel.topic ? ` | Tidligere topic: ${truncate(channel.topic, 180)}` : '';
    await channel.setTopic(
      `Sak ${caseData.case_number} • ${caseData.case_type} • Opprettet av ${caseData.creator_id}${previousTopic}`,
      `Konvertert fra ticket av ${interaction.user.tag}`,
    ).catch(() => null);

    await postCaseMessage(channel, caseData);
    recordCaseEvent(caseData.case_number, 'CONVERTED_FROM_TICKET', interaction.user,
      `Ticket-kanal ${channel.id} ble konvertert til sak ${caseData.case_number}.`);
    logAction('CASE_CONVERTED', `${caseData.case_number} konvertert fra ticket-kanal ${channel.id} av ${interaction.user.tag}`);

    return safeReply(interaction, {
      content: `✅ Kanal ${channel} er konvertert til sak ${caseData.case_number}. Kanaltilganger er beholdt.`,
    });
  } catch (error) {
    console.error('[CONVERT_TICKET_ERROR]', error);
    return safeReply(interaction, { content: `Kunne ikke konvertere kanalen: ${error.message || 'Ukjent feil.'}` });
  }
}

async function handleStartCommand(interaction) {
  if (!hasGuildAdminAccess(interaction))
    return safeReply(interaction, { content: 'Kun admin kan sette opp /start-panelet.' });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const startChannel = await ensureStartChannel(interaction.guild);
  await postOrUpdateStartPanel(startChannel);

  await interaction.editReply({ content: `✅ Startpanel er klart i ${startChannel}.` });
}

async function handleSetCategoryOnlyCommand(interaction, settingType) {
  if (!hasGuildAdminAccess(interaction))
    return safeReply(interaction, { content: 'Kun admin kan sette kanaloppsett.' });

  const category = interaction.options.getChannel('kategori', true);
  if (category.type !== ChannelType.GuildCategory) {
    return safeReply(interaction, { content: 'Du må velge en kategori.' });
  }

  setBotSetting(settingType, category.id);

  const label = settingType === 'case_category' ? 'Sakskategori' : 'Arkivkategori';
  await safeReply(interaction, { content: `✅ ${label} er satt til ${category}.` });
}

async function handleSetStartChannelOnlyCommand(interaction) {
  if (!hasGuildAdminAccess(interaction))
    return safeReply(interaction, { content: 'Kun admin kan sette kanaloppsett.' });

  const channel = interaction.options.getChannel('kanal', true);
  if (channel.type !== ChannelType.GuildText) {
    return safeReply(interaction, { content: 'Du må velge en tekstkanal.' });
  }

  setBotSetting('start_channel', channel.id);
  await postOrUpdateStartPanel(channel);
  await safeReply(interaction, { content: `✅ Startkanal er satt til ${channel}.` });
}

async function handleCaseInfoCommand(interaction) {
  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });
  await safeReply(interaction, { embeds: [buildCaseEmbed(caseData, interaction.guild)] });
}

async function handleMyCasesCommand(interaction) {
  const cases = getCasesByCreatorStmt.all(interaction.user.id);
  if (cases.length === 0) return safeReply(interaction, { content: 'Du har ingen registrerte saker.' });

  const lines = cases.slice(0, 10).map(c => {
    const channelPart = c.channel_id ? `<#${c.channel_id}>` : 'Ingen kanal';
    const priority = c.priority || 'Medium';
    return `• **${c.case_number}** | ${c.case_type} | ${getPriorityEmoji(priority)} ${priority} | ${c.status} | ${channelPart}`;
  });

  await safeReply(interaction, {
    embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('Dine saker')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Viser ${Math.min(cases.length, 10)} av ${cases.length} saker` })
      .setTimestamp()],
  });
}

async function handleMoveArchiveCommand(interaction) {
  if (!hasAnyStaffRole(interaction.member))
    return safeReply(interaction, { content: 'Du har ikke tilgang til å flytte saker til arkiv.' });

  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak å flytte til arkiv.' });
  if (!canManageCase(interaction.member, caseData)) return safeReply(interaction, { content: 'Du kan ikke arkivere denne saken.' });

  const channel = interaction.guild.channels.cache.get(caseData.channel_id);
  if (!channel) return safeReply(interaction, { content: 'Fant ikke sakskanalen for denne saken.' });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await moveCaseToArchive(channel, caseData, interaction.user);
  await interaction.editReply({ content: `Saken ${caseData.case_number} er flyttet til arkiv.` });
}

async function handleDeleteArchiveCommand(interaction) {
  if (!hasGuildAdminAccess(interaction))
    return safeReply(interaction, { content: 'Kun admin kan slette hele arkivet.' });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 1) Slett kanaler i arkivkategorien (hvis den finnes)
  const archiveCategory = findConfiguredCategory(interaction.guild, 'archive_category', ARCHIVE_CATEGORY_NAME);

  let deletedChannels = 0;
  if (archiveCategory) {
    const channelsToDelete = interaction.guild.channels.cache.filter(c => c.parentId === archiveCategory.id);
    for (const [, channel] of channelsToDelete) {
      try {
        await channel.delete(`Arkiv tømt av ${interaction.user.tag}`);
        deletedChannels += 1;
      } catch (error) {
        console.error('[ARCHIVE_DELETE_CHANNEL_ERROR]', error);
      }
    }
  }

  // 2) Slett arkiverte saker + tilhørende events i database
  const archivedCases = getArchivedCaseNumbersStmt.all();
  const tx = db.transaction(() => {
    for (const row of archivedCases) {
      deleteEventsByCaseStmt.run(row.case_number);
    }
    deleteArchivedCasesStmt.run();
  });
  tx();

  recordCaseEvent('SYSTEM', 'ARCHIVE_WIPED', interaction.user,
    `Hele arkivet ble tømt av ${interaction.user.tag}. Slettede kanaler: ${deletedChannels}. Slettede saker: ${archivedCases.length}.`);
  logAction('ARCHIVE_WIPED', `Utført av ${interaction.user.tag}. Kanaler: ${deletedChannels}. Saker: ${archivedCases.length}.`);

  await interaction.editReply({
    content: `✅ Arkivet er tømt. Slettet ${deletedChannels} kanal(er) og ${archivedCases.length} arkivert(e) sak(er).`,
  });
}

async function handleCaseHistoryCommand(interaction) {
  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });

  const events = getCaseEventsStmt.all(caseData.case_number, 10);
  await safeReply(interaction, { embeds: [buildCaseHistoryEmbed(caseData, events)] });
}

async function handleNoteCommand(interaction) {
  if (!hasAnyStaffRole(interaction.member))
    return safeReply(interaction, { content: 'Du har ikke tilgang til å legge til notater.' });

  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });

  const noteText = interaction.options.getString('tekst').trim();
  const channel  = getCaseChannel(interaction.guild, caseData);

  recordCaseEvent(caseData.case_number, 'NOTE', interaction.user, `Notat av ${interaction.user.tag}: ${noteText}`);

  if (channel) {
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle('Nytt notat')
        .setDescription(truncate(noteText, 4096))
        .addFields({ name: 'Lagt til av', value: `<@${interaction.user.id}>` })
        .setTimestamp()],
    });
  }

  await safeReply(interaction, { content: `Notat lagt til på ${caseData.case_number}.` });
}

async function handleReopenCaseCommand(interaction) {
  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });
  if (!canManageCase(interaction.member, caseData)) return safeReply(interaction, { content: 'Du har ikke tilgang til å gjenåpne denne saken.' });
  if (caseData.status !== 'Lukket' && caseData.status !== 'Arkivert')
    return safeReply(interaction, { content: 'Saken er allerede aktiv.' });

  const nextStatus = caseData.assigned_to ? 'Under behandling' : 'Åpen';
  const channel    = getCaseChannel(interaction.guild, caseData);

  reopenCaseStmt.run(nextStatus, caseData.case_number);
  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);

  if (channel) {
    if (caseData.status === 'Arkivert') await moveCaseToActiveCategory(channel, caseData);
    await refreshCaseMessage(channel, updatedCase);
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('Sak gjenåpnet')
        .setDescription(`Saken ${caseData.case_number} er gjenåpnet av <@${interaction.user.id}>.`).setTimestamp()],
    });
  }

  recordCaseEvent(caseData.case_number, 'REOPENED', interaction.user, `Saken ble gjenåpnet av ${interaction.user.tag}.`);
  await safeReply(interaction, { content: `Saken ${caseData.case_number} er gjenåpnet.` });
}

async function handleSetStatusCommand(interaction) {
  if (!hasAnyStaffRole(interaction.member))
    return safeReply(interaction, { content: 'Du har ikke tilgang til å endre status.' });

  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });
  if (!canManageCase(interaction.member, caseData) && !isCaseHandler(interaction.member))
    return safeReply(interaction, { content: 'Du kan ikke endre status på denne saken.' });

  const newStatus = interaction.options.getString('status');
  if (newStatus === 'Lukket') {
    return handleCloseCase(interaction, caseData.case_number);
  }

  updateStatusStmt.run(newStatus, caseData.case_number);
  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);

  const channel = getCaseChannel(interaction.guild, caseData);
  if (channel) {
    await refreshCaseMessage(channel, updatedCase);
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Status oppdatert')
        .setDescription(`Saken ${caseData.case_number} har ny status: **${newStatus}**.`)
        .setTimestamp()],
    });
  }

  recordCaseEvent(caseData.case_number, 'STATUS_UPDATED', interaction.user,
    `Status endret til "${newStatus}" av ${interaction.user.tag}.`);
  await safeReply(interaction, { content: `✅ Status oppdatert til ${newStatus}.` });
}

async function handleSetPriorityCommand(interaction) {
  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });

  const isCreator = interaction.user.id === caseData.creator_id;
  if (!hasAnyStaffRole(interaction.member) && !isCreator)
    return safeReply(interaction, { content: 'Kun staff eller sakens oppretter kan endre prioritet.' });

  const newPriority = normalizePriority(interaction.options.getString('prioritet', true));
  const currentPriority = caseData.priority || 'Medium';
  if (newPriority === currentPriority)
    return safeReply(interaction, { content: `Saken har allerede prioritet ${newPriority}.` });

  updatePriorityStmt.run(newPriority, caseData.case_number);
  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);

  const channel = getCaseChannel(interaction.guild, updatedCase);
  if (channel) {
    await syncCaseChannelPresentation(channel, updatedCase);
    await refreshCaseMessage(channel, updatedCase);
    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Prioritet oppdatert')
        .setDescription(`Saken ${caseData.case_number} har ny prioritet: **${newPriority}**.`)
        .setTimestamp()],
    });
  }

  recordCaseEvent(caseData.case_number, 'PRIORITY_UPDATED', interaction.user,
    `Prioritet endret fra "${currentPriority}" til "${newPriority}" av ${interaction.user.tag}.`);
  await safeReply(interaction, { content: `✅ Prioritet oppdatert til ${newPriority}.` });
}

function resolveStatusFromButtonCode(statusCode) {
  if (statusCode === 'open') return 'Åpen';
  if (statusCode === 'processing') return 'Under behandling';
  if (statusCode === 'waiting') return 'Avventer svar';
  return null;
}

async function handleStatusButton(interaction, caseNumber, statusCode) {
  if (!hasAnyStaffRole(interaction.member))
    return safeReply(interaction, { content: 'Du har ikke tilgang til å endre status.' });

  const caseData = getCaseByNumberStmt.get(caseNumber);
  if (!caseData) return safeReply(interaction, { content: 'Saken ble ikke funnet.' });

  if (!canManageCase(interaction.member, caseData) && !isCaseHandler(interaction.member))
    return safeReply(interaction, { content: 'Du kan ikke endre status på denne saken.' });

  const newStatus = resolveStatusFromButtonCode(statusCode);
  if (!newStatus) return safeReply(interaction, { content: 'Ugyldig statusknapp.' });

  updateStatusStmt.run(newStatus, caseData.case_number);
  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);
  await refreshCaseMessage(interaction.channel, updatedCase);

  recordCaseEvent(caseData.case_number, 'STATUS_UPDATED', interaction.user,
    `Status endret til "${newStatus}" av ${interaction.user.tag} via knapp.`);

  await safeReply(interaction, { content: `✅ Status oppdatert til ${newStatus}.` });
}


async function handleSendMelding(interaction) {
  if (!hasGuildAdminAccess(interaction))
    return safeReply(interaction, { content: 'Kun admin kan bruke denne kommandoen.' });

  const melding  = interaction.options.getString('melding');
  const kanal    = interaction.options.getChannel('kanal') || interaction.channel;
  const fullText = `${melding}\n\n*${BOT_SIGNATURE}*`;

  try {
    await kanal.send({ content: fullText });
    await safeReply(interaction, { content: `Melding sendt i ${kanal}.` });
  } catch (err) {
    await safeReply(interaction, { content: `Kunne ikke sende melding: ${err.message}` });
  }
}

async function handleAddWitnessCommand(interaction) {
  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });

  // Staff eller sakens oppretter kan legge til vitner.
  if (!hasAnyStaffRole(interaction.member) && interaction.user.id !== caseData.creator_id)
    return safeReply(interaction, { content: 'Kun staff eller sakens oppretter kan legge til vitner.' });

  const name = interaction.options.getString('navn').trim();
  const explanation = interaction.options.getString('forklaring').trim();

  return addWitnessToCase(interaction, caseData, name, explanation);
}

async function addWitnessToCase(interaction, caseData, name, explanation) {
  const witnesses = parseJsonArray(caseData.witnesses);

  witnesses.push({ name, explanation, added_by: interaction.user.id, added_at: new Date().toISOString() });
  updateWitnessesStmt.run(JSON.stringify(witnesses), caseData.case_number);

  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);
  const channel = getCaseChannel(interaction.guild, caseData);
  if (channel) {
    await refreshCaseMessage(channel, updatedCase);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x16a085)
          .setTitle('Nytt vitne lagt til')
          .addFields(
            { name: 'Navn', value: truncate(name, 256) },
            { name: 'Forklaring', value: truncate(explanation, 1024) },
            { name: 'Registrert av', value: `<@${interaction.user.id}>` },
          )
          .setTimestamp(),
      ],
    });
  }

  recordCaseEvent(caseData.case_number, 'WITNESS_ADDED', interaction.user,
    `Vitne lagt til: ${name}. Forklaring: ${truncate(explanation, 220)}`);

  return safeReply(interaction, { content: `✅ Vitnet **${name}** er lagt til i ${caseData.case_number}.` });
}

async function handleAddWitnessStartButton(interaction, caseNumber) {
  const caseData = getCaseByNumberStmt.get(caseNumber);
  if (!caseData) return safeReply(interaction, { content: 'Fant ikke saken.' });

  // Sakens oppretter eller staff kan åpne modalen.
  if (!hasAnyStaffRole(interaction.member) && interaction.user.id !== caseData.creator_id)
    return safeReply(interaction, { content: 'Kun staff eller sakens oppretter kan legge til vitner.' });

  await interaction.showModal(createWitnessModal(caseNumber));
}

async function handleWitnessModal(interaction) {
  const caseNumber = interaction.customId.split(':')[1];
  const caseData = getCaseByNumberStmt.get(caseNumber);
  if (!caseData) return safeReply(interaction, { content: 'Fant ikke saken.' });

  if (!hasAnyStaffRole(interaction.member) && interaction.user.id !== caseData.creator_id)
    return safeReply(interaction, { content: 'Kun staff eller sakens oppretter kan legge til vitner.' });

  const name = interaction.fields.getTextInputValue('witness_name').trim();
  const explanation = interaction.fields.getTextInputValue('witness_explanation').trim();
  return addWitnessToCase(interaction, caseData, name, explanation);
}

async function handleCaseTypeSelection(interaction) {
  await interaction.showModal(createCaseModal(interaction.values[0]));
}

async function handleStartCaseButton(interaction) {
  await safeReply(interaction, {
    content: 'Velg sakstype for å fortsette.',
    components: [createCaseSelectMenu()],
  });
}

async function handleAddMember(interaction) {
  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });

  // Kun staff eller sakens oppretter kan legge til medlemmer.
  if (!hasAnyStaffRole(interaction.member) && interaction.user.id !== caseData.creator_id)
    return safeReply(interaction, { content: 'Kun staff eller sakens oppretter kan legge til medlemmer.' });

  const channel = getCaseChannel(interaction.guild, caseData);
  if (!channel) return safeReply(interaction, { content: 'Fant ikke sakskanalen.' });

  const targetMember = interaction.options.getMember('bruker');
  if (!targetMember) return safeReply(interaction, { content: 'Fant ikke det valgte medlemmet i serveren.' });

  // Ikke legg til botten selv.
  if (targetMember.id === client.user.id)
    return safeReply(interaction, { content: 'Kan ikke legge til botten som deltaker.' });

  // Sjekk om personen allerede har tilgang.
  const existing = channel.permissionOverwrites.cache.get(targetMember.id);
  if (existing?.allow.has(PermissionFlagsBits.ViewChannel))
    return safeReply(interaction, { content: `${targetMember} har allerede tilgang til sakskanalen.` });

  await channel.permissionOverwrites.edit(targetMember.id, {
    [PermissionFlagsBits.ViewChannel]:        true,
    [PermissionFlagsBits.SendMessages]:       true,
    [PermissionFlagsBits.ReadMessageHistory]: true,
  }, { reason: `Lagt til i sak ${caseData.case_number} av ${interaction.user.tag}` });

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Nytt medlem lagt til')
        .setDescription(`<@${targetMember.id}> har fått tilgang til saken av <@${interaction.user.id}>.`)
        .setTimestamp(),
    ],
  });

  recordCaseEvent(caseData.case_number, 'MEMBER_ADDED', interaction.user,
    `${targetMember.user.tag} ble lagt til i saken av ${interaction.user.tag}.`);
  logAction('MEMBER_ADDED', `${targetMember.user.tag} lagt til i ${caseData.case_number}`);

  await safeReply(interaction, { content: `✅ ${targetMember} har nå tilgang til sakskanalen.` });
}

async function handleRemoveMember(interaction) {
  if (!hasAnyStaffRole(interaction.member))
    return safeReply(interaction, { content: 'Kun staff kan fjerne medlemmer fra en sak.' });

  const caseData = resolveCaseFromInteraction(interaction);
  if (!caseData) return safeReply(interaction, { content: 'Fant ingen sak for forespørselen.' });

  const channel = getCaseChannel(interaction.guild, caseData);
  if (!channel) return safeReply(interaction, { content: 'Fant ikke sakskanalen.' });

  const targetMember = interaction.options.getMember('bruker');
  if (!targetMember) return safeReply(interaction, { content: 'Fant ikke det valgte medlemmet i serveren.' });

  // Ikke fjern sakens oppretter.
  if (targetMember.id === caseData.creator_id)
    return safeReply(interaction, { content: 'Kan ikke fjerne sakens oppretter fra kanalen.' });

  // Ikke fjern botten eller staff-roller.
  if (targetMember.id === client.user.id || hasAnyStaffRole(targetMember))
    return safeReply(interaction, { content: 'Kan ikke fjerne staff eller botten fra sakskanalen.' });

  const existing = channel.permissionOverwrites.cache.get(targetMember.id);
  if (!existing) return safeReply(interaction, { content: `${targetMember} har ikke en individuell tilgangsoverstyring i sakskanalen.` });

  await channel.permissionOverwrites.delete(targetMember.id,
    `Fjernet fra sak ${caseData.case_number} av ${interaction.user.tag}`);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('Medlem fjernet')
        .setDescription(`<@${targetMember.id}> har mistet tilgang til saken av <@${interaction.user.id}>.`)
        .setTimestamp(),
    ],
  });

  recordCaseEvent(caseData.case_number, 'MEMBER_REMOVED', interaction.user,
    `${targetMember.user.tag} ble fjernet fra saken av ${interaction.user.tag}.`);
  logAction('MEMBER_REMOVED', `${targetMember.user.tag} fjernet fra ${caseData.case_number}`);

  await safeReply(interaction, { content: `✅ ${targetMember} har ikke lenger tilgang til sakskanalen.` });
}


async function handleNewCaseModal(interaction) {
  const caseType    = interaction.customId.split(':')[1];
  const title       = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const priority = 'Medium';

  if (!title || !description)
    return safeReply(interaction, { content: 'Alle felter må fylles ut.' });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let caseNumber = generateCaseNumber(caseType, interaction.guild);
  while (getCaseByNumberStmt.get(caseNumber)) caseNumber = generateCaseNumber(caseType, interaction.guild);

  const caseData = {
    case_number: caseNumber,
    creator_id:  interaction.user.id,
    assigned_to: null,
    priority,
    witnesses: '[]',
    case_type:   caseType,
    title,
    description,
    complainant: 'Ikke oppgitt',
    defendant: 'Ikke oppgitt',
    status:     'Åpen',
    created_at:  new Date().toISOString(),
    closed_at:   null,
    channel_id:  null,
  };

  try {
    // Opprett kanal først, lagre deretter saken når alt er klart.
    const channel = await createCaseChannel(interaction.guild, caseData, interaction.user.id);
    caseData.channel_id = channel.id;
    insertCaseStmt.run(caseData);
    recordCaseEvent(caseNumber, 'CREATED', interaction.user, `Saken ble opprettet av ${interaction.user.tag}.`);
    await postCaseMessage(channel, caseData);
    await interaction.editReply({
      content: `Sak opprettet: **${caseNumber}** i ${channel}. Du kan legge til vitner med en gang:`,
      components: [createInitialWitnessRow(caseNumber)],
    });
    logAction('CASE_CREATED', `${caseNumber} opprettet av ${interaction.user.tag} (${interaction.user.id})`);
  } catch (error) {
    console.error('[CASE_CREATE_ERROR]', error);
    await interaction.editReply({ content: `Kunne ikke opprette sak. ${error.message || 'Ukjent feil.'}` });
  }
}

async function handleTakeCase(interaction, caseNumber) {
  if (!hasAnyStaffRole(interaction.member))
    return safeReply(interaction, { content: 'Du har ikke tilgang til å ta saker.' });

  const caseData = resolveCaseFromButtonInteraction(interaction, caseNumber);
  if (!caseData) return safeReply(interaction, { content: 'Saken ble ikke funnet.' });
  if (caseData.status === 'Lukket' || caseData.status === 'Arkivert')
    return safeReply(interaction, { content: 'Saken kan ikke tas fordi den er lukket eller arkivert.' });

  updateAssignedStmt.run(interaction.user.id, 'Under behandling', caseData.case_number);
  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);
  await refreshCaseMessage(interaction.channel, updatedCase);
  recordCaseEvent(caseData.case_number, 'ASSIGNED', interaction.user, `Saken ble tildelt ${interaction.user.tag} og satt til Under behandling.`);

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('Sak tildelt')
      .setDescription(`Saken ${caseData.case_number} er nå tildelt <@${interaction.user.id}> og satt til **Under behandling**.`).setTimestamp()],
  });
  logAction('CASE_ASSIGNED', `${caseData.case_number} tildelt til ${interaction.user.tag}`);
}

async function handleCloseCase(interaction, caseNumber) {
  const caseData = resolveCaseFromButtonInteraction(interaction, caseNumber);
  if (!caseData) return safeReply(interaction, { content: 'Saken ble ikke funnet.' });
  if (!canManageCase(interaction.member, caseData)) return safeReply(interaction, { content: 'Du har ikke tilgang til å lukke denne saken.' });
  if (caseData.status === 'Lukket') return safeReply(interaction, { content: 'Saken er allerede lukket.' });
  if (caseData.status === 'Arkivert') return safeReply(interaction, { content: 'Saken er allerede arkivert.' });

  const closedAt = new Date().toISOString();
  closeCaseStmt.run('Lukket', closedAt, caseData.case_number);
  const updatedCase = getCaseByNumberStmt.get(caseData.case_number);
  await refreshCaseMessage(interaction.channel, updatedCase);
  recordCaseEvent(caseData.case_number, 'CLOSED', interaction.user, `Saken ble lukket av ${interaction.user.tag}.`);

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Sak lukket')
      .setDescription(`Saken ${caseData.case_number} er lukket av <@${interaction.user.id}>.`)
      .addFields({ name: 'Lukket tidspunkt', value: formatTimestamp(closedAt) })
      .setTimestamp()],
  });
  logAction('CASE_CLOSED', `${caseData.case_number} lukket av ${interaction.user.tag}`);
}

async function handleArchiveCase(interaction, caseNumber) {
  const caseData = resolveCaseFromButtonInteraction(interaction, caseNumber);
  if (!caseData) return safeReply(interaction, { content: 'Saken ble ikke funnet.' });
  if (!canManageCase(interaction.member, caseData)) return safeReply(interaction, { content: 'Du har ikke tilgang til å arkivere denne saken.' });
  await moveCaseToArchive(interaction.channel, caseData, interaction.user);
  await interaction.reply({ content: `Saken ${caseData.case_number} er arkivert.` });
}

// ---------------------------------------------------------------------------
// Discord-hendelser
// ---------------------------------------------------------------------------
client.once(Events.ClientReady, async readyClient => {
  logAction('READY', `Innlogget som ${readyClient.user.tag}`);
  const caseCount = db.prepare('SELECT COUNT(*) AS count FROM cases').get()?.count || 0;
  logAction('DB', `SQLite-fil: ${resolvedDbPath} | saker: ${caseCount}`);
  const guildNames = readyClient.guilds.cache.map(g => `${g.name} (${g.id})`).join(', ') || 'Ingen guilds';
  logAction('GUILDS', `Botten er koblet til: ${guildNames}`);
  try {
    const connectedGuildIds = readyClient.guilds.cache.map(g => g.id);
    await registerCommands(connectedGuildIds);
  } catch (error) {
    console.error('[REGISTER_COMMANDS_ERROR]', error);
  }
});

client.on(Events.GuildCreate, async guild => {
  try {
    await registerCommands([guild.id]);
  } catch (error) {
    console.error('[REGISTER_COMMANDS_ON_GUILD_CREATE_ERROR]', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild())
        return safeReply(interaction, { content: 'Denne kommandoen kan kun brukes i en server.' });

      if (interaction.commandName === 'start')         return handleStartCommand(interaction);
      if (interaction.commandName === 'sett_sakskategori') return handleSetCategoryOnlyCommand(interaction, 'case_category');
      if (interaction.commandName === 'sett_arkivkategori') return handleSetCategoryOnlyCommand(interaction, 'archive_category');
      if (interaction.commandName === 'sett_startkanal') return handleSetStartChannelOnlyCommand(interaction);
      if (interaction.commandName === 'ny_sak')        return handleNewCaseCommand(interaction);
      if (interaction.commandName === 'konverter_ticket') return handleConvertTicketCommand(interaction);
      if (interaction.commandName === 'flytt_arkiv')   return handleMoveArchiveCommand(interaction);
      if (interaction.commandName === 'gjenapne_sak')    return handleReopenCaseCommand(interaction);
      if (interaction.commandName === 'legg_til_medlem') return handleAddMember(interaction);
      if (interaction.commandName === 'fjern_fra_sak')   return handleRemoveMember(interaction);
      if (interaction.commandName === 'sett_status')     return handleSetStatusCommand(interaction);
      if (interaction.commandName === 'sett_prioritet')  return handleSetPriorityCommand(interaction);
      if (interaction.commandName === 'legg_til_vitne')  return handleAddWitnessCommand(interaction);
      if (interaction.commandName === 'slett_arkiv')     return handleDeleteArchiveCommand(interaction);
      if (interaction.commandName === 'send_melding')    return handleSendMelding(interaction);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'new_case_type_select')
      return handleCaseTypeSelection(interaction);

    if (interaction.isModalSubmit() && interaction.customId.startsWith('new_case_modal:'))
      return handleNewCaseModal(interaction);

    if (interaction.isModalSubmit() && interaction.customId.startsWith('witness_modal:'))
      return handleWitnessModal(interaction);

    if (interaction.isButton()) {
      if (interaction.customId === 'start_case') return handleStartCaseButton(interaction);

      const [action, caseNumber, extra] = interaction.customId.split(':');
      if (!action || !caseNumber) return safeReply(interaction, { content: 'Ugyldig handling.' });

      if (action === 'take_case')    return handleTakeCase(interaction, caseNumber);
      if (action === 'close_case')   return handleCloseCase(interaction, caseNumber);
      if (action === 'archive_case') return handleArchiveCase(interaction, caseNumber);
      if (action === 'status_btn')   return handleStatusButton(interaction, caseNumber, extra);
      if (action === 'add_witness_start') return handleAddWitnessStartButton(interaction, caseNumber);
    }
  } catch (error) {
    console.error('[INTERACTION_ERROR]', error);
    await safeReply(interaction, { content: 'Det oppstod en feil under behandling av forespørselen.' });
  }
});

// ---------------------------------------------------------------------------
// Prosessfeilhåndtering
// ---------------------------------------------------------------------------
process.on('uncaughtException',  error  => console.error('[UNCAUGHT_EXCEPTION]', error));
process.on('unhandledRejection', reason => console.error('[UNHANDLED_REJECTION]', reason));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
client.login(DISCORD_TOKEN).catch(error => {
  console.error('[LOGIN_ERROR]', error);
  process.exit(1);
});
