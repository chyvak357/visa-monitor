'use strict';
/**
 * Автозапись одного человека на слот: календарь → время → контактные данные → подтверждение.
 * Шаги и селекторы — SITE.md, «Форма записи».
 *
 * Данные людей — people.json (см. people.example.json). Один человек = один слот.
 */

const { log, sleep, fmtDay } = require('./util');
const { PATHS, readJson } = require('./config');
const { openSession, retryCaptcha, waitTurnstile, sessionFresh, dayTimes, CaptchaStuck } = require('./site');

const API = 'https://api.consulat.gouv.fr/';
const PERSON_FIELDS = ['name', 'lastname', 'firstname', 'email', 'phone', 'birthdate', 'purpose'];
const DEFAULT_DIAL = '+995'; // код страны, выбранный в форме по умолчанию
const SLOT_RELEASE_MS = 7 * 60_000; // брошенная сессия живёт до 6 мин — дольше её слот держаться не должен
const RELEASE_POLL_MS = 15_000; // как часто проверять, не отпустили ли слот

class BookingError extends Error {}
class SlotGone extends BookingError {}

/** Люди из people.json; кривые записи отбрасываются с понятной причиной. */
function loadPeople() {
  const raw = readJson(PATHS.people, []);
  const people = [];
  for (const [i, p] of (Array.isArray(raw) ? raw : []).entries()) {
    const missing = PERSON_FIELDS.filter((k) => !String(p?.[k] ?? '').trim());
    if (missing.length) log(`people.json: у записи №${i + 1} не заполнено: ${missing.join(', ')} — пропускаю`);
    else if (!/^\d{2}\.\d{2}\.\d{4}$/.test(p.birthdate)) log(`people.json: ${p.name} — birthdate должен быть ДД.ММ.ГГГГ`);
    else if (!/^\+\d{6,15}$/.test(p.phone.replace(/[\s()-]/g, ''))) log(`people.json: ${p.name} — phone должен быть вида +995555123456`);
    else people.push(p);
  }
  return people;
}

// «Делово́й» на сайте с ударением — сравниваем без диакритики.
const norm = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Ждёт ответ API на сохранение шага key и проверяет, что сайт его принял. */
function stepSaved(page, key) {
  return page
    .waitForResponse(
      (r) => r.url().includes('/update-step-value') && (r.request().postData() || '').includes(`"key":"${key}"`),
      { timeout: 30_000 }
    )
    .then(async (r) => {
      if (r.status() !== 200) throw new BookingError(`сайт не принял шаг ${key}: ${r.status()} ${(await r.text()).slice(0, 150)}`);
    });
}

/** Календарь: листает до нужного месяца, кликает день, затем время и «Проверить календарь». */
async function pickSlot(page, date, time) {
  const day = page.locator(`.vc-day.id-${date} .vc-day-content`);
  for (let i = 0; i < 12 && !(await day.isVisible().catch(() => false)); i++) {
    await page.locator('.vc-arrow.is-right').first().click();
    await sleep(500);
  }
  if (!(await day.isVisible().catch(() => false))) throw new SlotGone(`в календаре нет дня ${date}`);
  // День открылся уже после загрузки календаря — на странице он серый, нужна новая сессия.
  const disabled = await day
    .evaluate((el) => el.classList.contains('is-disabled') || el.getAttribute('aria-disabled') === 'true')
    .catch(() => false);
  if (disabled) throw new SlotGone(`день ${date} в открытом календаре закрыт`);
  await day.click();

  const slot = page.locator('.btn-custom-slot').filter({ hasText: new RegExp(`^\\s*${time}\\s*$`) }).first();
  await slot.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
    throw new SlotGone(`слот ${date} ${time} уже заняли`);
  });
  await slot.click();
  await sleep(400);

  const saved = stepSaved(page, 'slotsStep');
  await page.getByRole('button', { name: /Проверить календарь|Valider/i }).click();
  await saved;
}

/** Телефон: в форме отдельно код страны (по умолчанию +995) и национальный номер. */
async function fillPhone(page, phone) {
  phone = phone.replace(/[\s()-]/g, '');
  let dial = DEFAULT_DIAL;
  if (!phone.startsWith(DEFAULT_DIAL)) {
    const toggle = page.getByRole('button', { name: /^\+\s*\d+/ }).first();
    await toggle.click();
    await sleep(400);
    // Ищем в выпадающем списке самый длинный код, с которого начинается номер.
    const items = page.locator('.dropdown-menu.show [role=menuitem], .dropdown-menu.show .dropdown-item');
    const texts = await items.allInnerTexts();
    let best = -1;
    let bestCode = '';
    texts.forEach((t, i) => {
      const code = (t.match(/\+\s*(\d{1,4})/) || [])[1];
      if (code && phone.startsWith('+' + code) && code.length > bestCode.length) [best, bestCode] = [i, code];
    });
    if (best < 0) throw new BookingError(`не нашёл код страны для ${phone} — запишитесь вручную или укажите номер +995`);
    await items.nth(best).click();
    dial = '+' + bestCode;
  }
  await page.locator('#phone').fill(phone.slice(dial.length));
}

/** Шаг «Ваши контактные данные». */
async function fillContacts(page, person) {
  await page.locator('#lastname').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#lastname').fill(person.lastname);
  await page.locator('#firstname').fill(person.firstname);
  await page.locator('#email').fill(person.email);
  await page.locator('#email-confirm').fill(person.email);
  await fillPhone(page, person.phone);

  // Дата рождения под маской ДД.ММ.ГГГГ — печатаем посимвольно, fill маску обходит.
  const bd = page.locator('#birthdate');
  await bd.click();
  await bd.fill('');
  await bd.pressSequentially(person.birthdate, { delay: 40 });

  const purpose = page.locator('select.custom-fields-input').first();
  const options = await purpose.locator('option').allInnerTexts();
  const label = options.find((o) => norm(o).includes(norm(person.purpose)));
  if (!label) throw new BookingError(`цель «${person.purpose}» не найдена, есть: ${options.filter(Boolean).join(' / ')}`);
  await purpose.selectOption({ label });

  const saved = stepSaved(page, 'mainContactDetailsStep');
  await page.getByRole('button', { name: /Подтвердите ваши данные|Valider/i }).click();
  await saved.catch(async (e) => {
    const bad = await page.locator('.is-invalid').evaluateAll((els) => els.map((x) => x.id || x.name).filter(Boolean));
    throw new BookingError(bad.length ? `сайт не принял поля: ${bad.join(', ')}` : e.message);
  });
}

/**
 * Финальный шаг: галочка согласия, второй Turnstile, «Подтвердить».
 * dryRun — всё заполнить, но последнюю кнопку не нажимать.
 * askCode(text) — если после подтверждения сайт попросит код из письма, спросить его у человека.
 */
async function confirm(page, { dryRun, onStuck, askCode }) {
  const consent = page.locator('#checkbox-1');
  await consent.waitFor({ state: 'attached', timeout: 30_000 });
  await consent.check({ force: true }).catch(() => consent.click({ force: true }));
  await waitTurnstile(page, onStuck);
  if (dryRun) return { dry: true };

  // Что именно отвечает сайт на подтверждение — пишем всё, первая настоящая запись это покажет.
  const responses = [];
  const onResponse = async (r) => {
    if (!r.url().startsWith(API) || r.request().method() === 'GET') return;
    responses.push(`${r.request().method()} ${r.status()} ${r.url().replace(/^.*\/api\//, '')} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  };
  page.on('response', onResponse);
  try {
    await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await sleep(8000);

    // Если появилось поле ввода — это, скорее всего, код из письма.
    const codeInput = page.locator('input[type=text]:visible, input[type=number]:visible, input:not([type]):visible').first();
    if (askCode && (await codeInput.count())) {
      const code = await askCode();
      if (code) {
        await codeInput.fill(code);
        await page.getByRole('button', { name: /Подтвердить|Valider|Отправить|Envoyer/i }).first().click();
        await sleep(8000);
      }
    }
    for (const r of responses) log('  подтверждение:', r);
    const failed = responses.find((r) => / [45]\d\d /.test(r));
    if (failed) throw new BookingError(`сайт ответил ошибкой: ${failed}`);
    return { responses };
  } catch (e) {
    e.submitted = true; // «Подтвердить» уже нажата — запись могла пройти, повторять вслепую нельзя
    throw e;
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Выбирает слот прямо в календаре, на котором уже стоит окно (sess — его сессия), без перезагрузки.
 * Не вышло (сессия умерла, календарь устарел, человек ушёл со страницы) — открывает календарь заново.
 */
async function toSlot(browser, cfg, date, time, sess, onStuck) {
  const onCalendar = sessionFresh(sess) && (await browser.page.locator('.vc-day').first().isVisible().catch(() => false));
  if (onCalendar) {
    try {
      return await pickSlot(browser.page, date, time);
    } catch (e) {
      log(`в открытом календаре не вышло (${e.message}) — открываю заново`);
    }
  }
  await openSession(browser, cfg, onStuck);
  await pickSlot(browser.page, date, time);
}

/**
 * Слот выбран в сессии, которую бросили из-за капчи: пока она жива, другим (и нам) он не виден.
 * Держим новую сессию, опрашиваем этот день и забираем время, как только сайт его отпустит.
 */
async function toReleasedSlot(browser, cfg, date, time, heldSince, onStuck) {
  const deadline = heldSince + SLOT_RELEASE_MS;
  Promise.resolve(
    onStuck?.(
      `⏳ Браузер перезапущен, слот ${fmtDay(date)} ${time} пока держит брошенная сессия. ` +
        `Жду, пока сайт его отпустит (до ${SLOT_RELEASE_MS / 60_000} мин), и сразу забираю.`
    )
  ).catch(() => {});
  let sess = null;
  for (;;) {
    const reopened = !sessionFresh(sess);
    if (reopened) sess = await openSession(browser, cfg, onStuck);
    try {
      return await pickSlot(browser.page, date, time);
    } catch (e) {
      if (!(e instanceof SlotGone) || Date.now() > deadline) throw e;
      if (!reopened) {
        sess = null; // время отпустили, но календарь на странице устарел — открываем заново
        continue;
      }
    }
    log(`слот ${date} ${time} ещё держит брошенная сессия — жду`);
    let freed = false;
    while (!freed && sessionFresh(sess) && Date.now() < deadline) {
      await sleep(RELEASE_POLL_MS);
      const times = await dayTimes(browser.page, sess, date).catch((e) => log('не смог проверить день:', e.message));
      if (times) freed = times.includes(time);
      else sess = null;
    }
    if (!freed) sess = null; // сессия кончилась или вышел срок — последняя попытка с новой
  }
}

/**
 * Запись: слот → форма → подтверждение. opts.sess — сессия календаря, открытого в окне сейчас:
 * с ней продолжаем в том же окне, без неё начинаем с новой сессии.
 * Застряла финальная капча — перезапускаем браузер и проходим всё заново, дождавшись, пока
 * сайт отпустит слот, взятый брошенной сессией. opts.slotHeld — слот уже взят такой сессией.
 */
async function book(browser, cfg, person, date, time, opts = {}) {
  log(`запись: ${person.name} → ${date} ${time}${opts.dryRun ? ' (пробный прогон)' : ''}`);
  let sess = opts.sess;
  let heldSince = opts.slotHeld ? Date.now() : 0;
  return retryCaptcha(
    browser,
    async () => {
      if (heldSince) await toReleasedSlot(browser, cfg, date, time, heldSince, opts.onStuck);
      else await toSlot(browser, cfg, date, time, sess, opts.onStuck);
      sess = null; // после перезапуска браузера — только новая сессия
      await fillContacts(browser.page, person);
      return confirm(browser.page, opts);
    },
    // Капчу входа openSession перезапускает сам, сюда доходит только капча подтверждения — слот уже взят.
    () => (heldSince = Date.now())
  );
}

/**
 * Слот уже выбран руками в окне робота — дозаполняем форму.
 * slot {date, time} — какой именно: если застрянет финальная капча, запишем на него с нуля.
 */
async function fillAndConfirm(browser, cfg, person, slot, opts = {}) {
  log(`дозаполняю форму за ${person.name}${opts.dryRun ? ' (пробный прогон)' : ''}`);
  const page = browser.page;
  // Человек мог выбрать время, но не нажать «Проверить календарь».
  const accept = page.getByRole('button', { name: /Проверить календарь|Valider/i });
  if (await accept.isVisible().catch(() => false)) {
    const saved = stepSaved(page, 'slotsStep');
    await accept.click();
    await saved;
  }
  await fillContacts(page, person);
  try {
    return await confirm(page, opts);
  } catch (e) {
    if (!(e instanceof CaptchaStuck) || !slot) throw e;
    log('капча не пройдена — перезапускаю браузер и записываю заново');
    await browser.restart();
    return book(browser, cfg, person, slot.date, slot.time, { ...opts, sess: null, slotHeld: true });
  }
}

module.exports = { loadPeople, book, fillAndConfirm, BookingError, SlotGone };
