'use strict';
/**
 * Telegram-бот: уведомления, кнопки и подписки.
 *
 * Владелец — TG_CHAT_ID из .env (его пишет `npm run setup`). Любой другой человек жмёт /start,
 * владельцу приходит «пустить?» с кнопками; одобренные получают алерты о слотах.
 * Служебные сообщения (ошибки, капча) идут только владельцу.
 */

const { log, sleep, esc } = require('./util');
const { PATHS, readJson, writeJson } = require('./config');

const TG_LIMIT = 3800; // потолок Telegram — 4096, держим запас

const HELP = '/status — что сейчас с мониторингом\n/stop — отписаться от алертов';

class TgError extends Error {
  constructor(description, code) {
    super(description);
    this.code = code;
  }
}

/** Режет длинный текст по строкам на куски, которые пролезут в одно сообщение. */
function chunks(text) {
  const out = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > TG_LIMIT) {
      out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** [[['текст', 'callback:data'], …], …] → reply_markup */
const keyboard = (rows) => ({
  inline_keyboard: rows.map((row) => row.map(([text, data]) => ({ text, callback_data: data }))),
});

const userName = (u) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');

class Bot {
  constructor(token, ownerId) {
    this.token = token;
    this.ownerId = String(ownerId || '');
    this.offset = 0;
    this.commands = new Map();
    this.callbacks = new Map();
    this.onText = null; // обработчик свободного текста от своих (например, код из письма)
    this.statusText = () => 'нет данных';
    this.subs = readJson(PATHS.subscribers, { approved: [], pending: [] });

    this.callback('sub', (q, [verdict, id]) => this.decide(q, verdict, id));
    this.command('/stop', (m) => this.unsubscribe(m));
    this.command('/status', (m) => this.send(m.chat.id, this.statusText()));
    this.command('/help', (m) => this.send(m.chat.id, HELP));
  }

  get enabled() {
    return !!(this.token && this.ownerId);
  }

  // ─── Низкий уровень ───────────────────────────────────────────────────────

  async api(method, params = {}, form = null) {
    const r = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      form
        ? { method: 'POST', body: form }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }
    );
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok) throw new TgError(j.description, j.error_code);
    return j.result;
  }

  /** Для уведомлений: ошибка Telegram не должна ронять мониторинг. */
  async safe(method, params, form) {
    try {
      return await this.api(method, params, form);
    } catch (e) {
      log(`Telegram ${method}:`, e.message);
      return null;
    }
  }

  async send(chatId, html, { buttons } = {}) {
    if (!this.enabled) return log('[tg]', html.replace(/<[^>]+>/g, ''));
    const parts = chunks(html);
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      last = await this.safe('sendMessage', {
        chat_id: chatId,
        text: parts[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(buttons && i === parts.length - 1 ? { reply_markup: keyboard(buttons) } : {}),
      });
    }
    return last;
  }

  async sendPhoto(chatId, png, caption, { buttons } = {}) {
    if (!this.enabled || !png) return this.send(chatId, esc(caption), { buttons });
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption.slice(0, 1000));
    form.append('photo', new Blob([png], { type: 'image/png' }), 'screen.png');
    if (buttons) form.append('reply_markup', JSON.stringify(keyboard(buttons)));
    return this.safe('sendPhoto', null, form);
  }

  edit(chatId, messageId, html, { buttons } = {}) {
    if (!this.enabled) return null;
    return this.safe('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: keyboard(buttons) } : {}),
    });
  }

  answer(callbackId, text = '') {
    return this.safe('answerCallbackQuery', { callback_query_id: callbackId, text });
  }

  // ─── Кому писать ──────────────────────────────────────────────────────────

  isOwner(id) {
    return String(id) === this.ownerId;
  }

  isMember(id) {
    return this.isOwner(id) || this.subs.approved.some((s) => s.id === String(id));
  }

  recipients() {
    return [this.ownerId, ...this.subs.approved.map((s) => s.id)];
  }

  /** Алерт всем подписчикам. Возвращает отправленные сообщения — их можно потом отредактировать. */
  async broadcast(html, opts) {
    const sent = [];
    for (const id of this.recipients()) {
      const m = await this.send(id, html, opts);
      if (m) sent.push(m);
    }
    return sent;
  }

  toOwner(html, opts) {
    return this.send(this.ownerId, html, opts);
  }

  async screenToOwner(page, caption) {
    const png = await page.screenshot().catch(() => null);
    return this.sendPhoto(this.ownerId, png, caption);
  }

  // ─── Команды и кнопки ─────────────────────────────────────────────────────

  command(name, handler) {
    this.commands.set(name, handler);
  }

  /** Кнопки с callback_data вида «prefix:arg1:arg2». */
  callback(prefix, handler) {
    this.callbacks.set(prefix, handler);
  }

  /** Long polling в фоне — работает и без белого IP, и без вебхуков. */
  start() {
    if (!this.enabled) return;
    (async () => {
      for (;;) {
        try {
          const updates = await this.api('getUpdates', {
            offset: this.offset,
            timeout: 50,
            allowed_updates: ['message', 'callback_query'],
          });
          for (const u of updates) {
            this.offset = u.update_id + 1;
            await this.handle(u).catch((e) => log('бот: ошибка обработки:', e.message));
          }
        } catch (e) {
          log(
            e.code === 409
              ? 'Telegram: этого бота уже слушает другой процесс — второй монитор или setup?'
              : `Telegram getUpdates: ${e.message}`
          );
          await sleep(5000);
        }
      }
    })();
  }

  async handle(u) {
    if (u.callback_query) {
      const q = u.callback_query;
      const [prefix, ...args] = (q.data || '').split(':');
      const handler = this.callbacks.get(prefix);
      if (!handler || !this.isMember(q.from.id)) return this.answer(q.id, 'Нет доступа');
      return handler(q, args);
    }

    const m = u.message;
    if (!m?.text) return;
    const cmd = m.text.trim().split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();
    if (cmd === '/start') return this.subscribe(m);
    if (!this.isMember(m.chat.id)) return this.send(m.chat.id, 'Нажмите /start, чтобы запросить доступ к алертам.');
    const handler = this.commands.get(cmd);
    if (handler) return handler(m);
    if (this.onText && (await this.onText(m))) return;
    return this.send(m.chat.id, HELP);
  }

  // ─── Подписки ─────────────────────────────────────────────────────────────

  saveSubs() {
    writeJson(PATHS.subscribers, this.subs);
  }

  async subscribe(m) {
    const id = String(m.chat.id);
    if (this.isOwner(id)) return this.send(id, `Вы владелец этого бота.\n${HELP}`);
    if (this.isMember(id)) return this.send(id, `Вы уже подписаны на алерты.\n${HELP}`);
    if (this.subs.pending.some((p) => p.id === id)) return this.send(id, 'Заявка уже у владельца бота, ждите.');

    const name = userName(m.from);
    this.subs.pending.push({ id, name });
    this.saveSubs();
    await this.send(id, 'Запрос отправлен владельцу бота. Как только он одобрит — начнут приходить алерты.');
    await this.toOwner(`👤 <b>${esc(name)}</b> хочет получать алерты о слотах.`, {
      buttons: [[['✅ Пустить', `sub:yes:${id}`], ['❌ Нет', `sub:no:${id}`]]],
    });
  }

  async decide(q, verdict, id) {
    if (!this.isOwner(q.from.id)) return this.answer(q.id, 'Решает только владелец');
    const p = this.subs.pending.find((x) => x.id === id);
    if (!p) return this.answer(q.id, 'Заявка уже обработана');

    this.subs.pending = this.subs.pending.filter((x) => x.id !== id);
    if (verdict === 'yes') this.subs.approved.push(p);
    this.saveSubs();

    await this.answer(q.id);
    await this.edit(
      q.message.chat.id,
      q.message.message_id,
      verdict === 'yes' ? `✅ ${esc(p.name)} подключён` : `❌ ${esc(p.name)} — отказано`
    );
    await this.send(
      id,
      verdict === 'yes' ? `✅ Готово — будете получать алерты о слотах.\n${HELP}` : 'Владелец бота отклонил запрос.'
    );
  }

  async unsubscribe(m) {
    const id = String(m.chat.id);
    if (this.isOwner(id)) return this.send(id, 'Владелец не может отписаться — остановите монитор (Ctrl+C).');
    const s = this.subs.approved.find((x) => x.id === id);
    this.subs.approved = this.subs.approved.filter((x) => x.id !== id);
    this.saveSubs();
    await this.send(id, 'Вы отписаны. /start — подписаться снова.');
    if (s) await this.toOwner(`👋 ${esc(s.name)} отписался от алертов`);
  }
}

module.exports = { Bot, TgError };
