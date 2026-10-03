#!/usr/bin/env node
/**
 * Мастер настройки: проверяет Node и Chrome, подключает Telegram-бота (chat_id ловится сам —
 * достаточно нажать Start), спрашивает диапазон дат и записывает всё в .env.
 *
 *   npm run setup
 *
 * Монитор на это время должен быть остановлен: Telegram отдаёт сообщения бота только одному процессу.
 */
'use strict';

const fs = require('fs');
const readline = require('readline/promises');
const { readEnvFile, writeEnv } = require('./src/config');
const { isoDate, today, addDays } = require('./src/util');

const CHROME_PATHS = {
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

async function tg(token, method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (j.error_code === 409) {
    throw new Error('бота уже слушает другой процесс — остановите монитор (npm start) на время настройки');
  }
  if (!j.ok) throw new Error(j.description);
  return j.result;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def || '';
  const yes = (a) => /^(y|yes|д|да)?$/i.test(a.trim());
  const env = readEnvFile();

  console.log('── Настройка монитора слотов ──\n');

  // 1. Окружение
  const node = Number(process.versions.node.split('.')[0]);
  if (node < 20) {
    console.log(`✘ Нужен Node.js 20 или новее, у вас ${process.versions.node}. Скачать: https://nodejs.org`);
    process.exit(1);
  }
  const chrome = (CHROME_PATHS[process.platform] || []).find((p) => p && fs.existsSync(p));
  if (!chrome) {
    console.log('✘ Google Chrome не найден. Установите его (https://www.google.com/chrome/) и запустите setup снова.');
    process.exit(1);
  }
  console.log(`✔ Node.js ${process.versions.node}, Google Chrome найден`);

  // 2. Бот
  let token = env.TG_TOKEN || '';
  let me = token ? await tg(token, 'getMe').catch(() => null) : null;
  if (me && !yes(await ask(`\nБот @${me.username} уже подключён. Оставить его? (Д/н)`, ''))) me = null;
  while (!me) {
    console.log(
      '\nНужен свой Telegram-бот (это бесплатно и занимает минуту):\n' +
        '  1. Откройте в Telegram @BotFather и отправьте /newbot\n' +
        '  2. Придумайте боту имя и username (должен заканчиваться на «bot»)\n' +
        '  3. BotFather пришлёт токен вида 123456789:AAE… — вставьте его сюда'
    );
    token = await ask('Токен');
    me = await tg(token, 'getMe').catch((e) => console.log(`✘ Telegram не принял токен: ${e.message}`));
  }
  console.log(`✔ Бот: @${me.username}`);

  // 3. Владелец: ловим первое личное сообщение боту — так узнаём chat_id, искать его руками не нужно.
  let chatId = me.username && token === env.TG_TOKEN ? env.TG_CHAT_ID : '';
  if (chatId && !yes(await ask(`Алерты сейчас идут в chat_id ${chatId}. Оставить? (Д/н)`, ''))) chatId = '';
  if (!chatId) {
    const old = await tg(token, 'getUpdates', { timeout: 0 });
    let offset = old.length ? old[old.length - 1].update_id + 1 : 0;
    console.log(`\nОткройте https://t.me/${me.username} и нажмите «Start» (или напишите боту что угодно). Жду до 10 минут…`);
    for (const until = Date.now() + 10 * 60_000; !chatId && Date.now() < until; ) {
      const updates = await tg(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!chatId && m?.chat?.type === 'private') {
          chatId = String(m.chat.id);
          console.log(`✔ Владелец бота: ${[m.from.first_name, m.from.last_name].filter(Boolean).join(' ')} (chat_id ${chatId})`);
        }
      }
    }
    await tg(token, 'getUpdates', { offset, timeout: 0 }); // пометить прочитанным, чтобы монитор не увидел этот /start
    if (!chatId) {
      console.log('✘ Сообщение так и не пришло. Запустите setup ещё раз.');
      process.exit(1);
    }
  }
  await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ Бот подключён к монитору слотов — сюда будут приходить алерты.' });

  // 4. Даты
  const askDate = async (q, def) => {
    for (;;) {
      const v = await ask(q, def);
      if (isoDate.test(v) && !Number.isNaN(Date.parse(v))) return v;
      console.log('  формат: ГГГГ-ММ-ДД, например 2026-11-15');
    }
  };
  const from = await askDate('\nИскать слоты с даты', env.DATE_FROM > today() ? env.DATE_FROM : today());
  let to = await askDate('по дату', env.DATE_TO > from ? env.DATE_TO : addDays(from, 60));
  while (to < from) to = await askDate('Конечная дата раньше начальной. По дату', addDays(from, 60));

  writeEnv({
    TG_TOKEN: token,
    TG_CHAT_ID: chatId,
    DATE_FROM: from,
    DATE_TO: to,
    POLL_SECONDS: env.POLL_SECONDS || 120,
    HOLD_AFTER_ALERT_MIN: env.HOLD_AFTER_ALERT_MIN ?? 10,
  });
  rl.close();

  console.log(
    `\n✔ Настройки сохранены в .env (даты можно менять там же, перезапуск не нужен)\n\n` +
      `Запуск мониторинга:  npm start\n` +
      `Чтобы алерты получал ещё кто-то — пусть откроет https://t.me/${me.username} и нажмёт Start,\n` +
      `вам придёт запрос с кнопками «Пустить / Нет».`
  );
}

main().catch((e) => {
  console.error(`\n✘ ${e.message}`);
  process.exit(1);
});
