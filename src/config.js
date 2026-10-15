'use strict';

const fs = require('fs');
const path = require('path');
const { isoDate, today, addDays } = require('./util');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

const PATHS = {
  root: ROOT,
  env: ENV_FILE,
  profile: path.join(ROOT, '.browser-profile'),
  data: path.join(ROOT, 'data'),
  subscribers: path.join(ROOT, 'data', 'subscribers.json'),
  people: path.join(ROOT, 'people.json'),
};

function readEnvFile() {
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return env;
}

/** Обновляет ключи в .env, не трогая остальные строки и комментарии. */
function writeEnv(updates) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  } catch {}
  const left = { ...updates };
  lines = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    if (!m || !(m[1] in left)) return line;
    const v = left[m[1]];
    delete left[m[1]];
    return `${m[1]}=${v}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(left)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}

/** Настройки из .env — читаются заново на каждом круге, поэтому правки применяются без перезапуска. */
function config() {
  const env = readEnvFile();
  const get = (k, d) => process.env[k] ?? env[k] ?? d;
  const cfg = {
    tgToken: get('TG_TOKEN', ''),
    tgChatId: get('TG_CHAT_ID', ''),
    dateFrom: get('DATE_FROM', today()),
    dateTo: get('DATE_TO', addDays(today(), 60)),
    pollSec: Number(get('POLL_SECONDS', 120)),
    holdMin: Number(get('HOLD_AFTER_ALERT_MIN', 10)),
    requestDelayMs: Number(get('REQUEST_DELAY_MS', 300)),
    bookingDryRun: get('BOOKING_DRY_RUN', '0') === '1',
    nestedDisplay: get('NESTED_DISPLAY', ''),
    bookingUrl: get(
      'BOOKING_URL',
      'https://consulat.gouv.fr/ru/ambassade-de-france-a-tbilissi/appointment?name=Service%20des%20Visas'
    ),
  };
  if (!isoDate.test(cfg.dateFrom) || !isoDate.test(cfg.dateTo)) {
    throw new Error(`DATE_FROM/DATE_TO должны быть YYYY-MM-DD, сейчас «${cfg.dateFrom}» / «${cfg.dateTo}»`);
  }
  return cfg;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

module.exports = { PATHS, config, readEnvFile, writeEnv, readJson, writeJson };
