# Как устроен сайт записи

Справка для доработок: что известно о consulat.gouv.fr (движок TROOV) и почему код устроен так, как устроен.
Всё проверено вживую 2026-10-03.

## Браузер и капча

- Вход закрыт Cloudflare Turnstile. Bundled Chromium от Playwright он не пускает, настоящий Google Chrome
  под [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) проходит сам, без кликов.
- Cookie Cloudflare нет: Turnstile только выдаёт токен, который уходит при создании сессии.
- Кнопка «Доступ к услугам» активна раньше, чем готов токен. Ждать надо непустой `input[name="cf-turnstile-response"]`
  и заранее удалить `localStorage['resa-sid']` — иначе фронт отправит протухшую сессию с пустой капчей,
  получит 401 `CAPTCHA_FAILED` и зависнет.
- Linux + Wayland (терминал VS Code): Chrome падает на Qt-шиме → `--ozone-platform=x11`,
  env `XDG_SESSION_TYPE=x11`, `QT_QPA_PLATFORM=xcb`.

## Флоу до календаря

1. (иногда) диалог «продолжить прошлую сессию?» → `Нет`
2. `Доступ к услугам`
3. строка `.service-applicant` с текстом `раткосрочные визы` (первая «K» на сайте латинская) → `Больше` → `Подтвердить`.
   С двумя заявителями сайт не пускает к календарю → один человек = одна запись.
4. галочка «Важная информация» → `Назначить встречу` → календарь

## API (`https://api.consulat.gouv.fr/api/team/{teamId}/…`)

Заголовки: `x-gouv-web`, `x-gouv-app-id` — перехватываются из запросов самой страницы.

| Запрос | Что делает |
|---|---|
| `POST reservations-session` | Создаёт сессию. Тело `{standaloneServiceName, sessionId:null, captcha:<токен Turnstile>}` → документ с `_id` (= `resa-sid`). **Новая сессия = новый токен**, чисто через API не пересоздать |
| `POST reservations-session/{sid}/update-step-value` | Сохраняет шаг: `servicesStep`, `importantInformationStep`, `slotsStep`, `mainContactDetailsStep` |
| `GET reservations/get-interval?serviceId=…` | Окно бронирования `{start, end}` |
| `POST reservations/exclude-days` | **Все дни окна без мест** (не только праздники) — весь календарь одним запросом |
| `GET reservations/availability?name=…&date=…&places=1&matching=&maxCapacity=1&sessionId=…` | Время на день: `[{"time":"10:30","capacity":1,…}]`. Сайт сам его дёргает, только если места где-то есть — иначе URL собираем по образцу |

- Сессия живёт **2–6 минут** от создания, запросы availability её не продлевают. Умерла → 404/418 `SESSION_EXPIRED`.
- Лимит частоты: несколько десятков запросов подряд → 429 на несколько минут, общий на IP
  (мешает и ручной записи из того же браузера).
- Выбранный в сессии слот держится за ней: другим он на это время не виден.

## Форма записи

- Календарь — v-calendar: месяцы листаются `.vc-arrow.is-right`, день — `.vc-day.id-YYYY-MM-DD .vc-day-content`.
- Время — `.btn-custom-slot` с текстом `09:30`, затем кнопка «Проверить календарь 1/1».
- «Ваши контактные данные»: `#lastname`, `#firstname`, `#email`, `#email-confirm`,
  `#phone` + выпадающий список кода страны (по умолчанию +995), `#birthdate` (маска ДД.ММ.ГГГГ),
  `select.custom-fields-input` «цель пребывания» (туризм / семья / Делово́й / учёба, кратко- и долгосрочные).
  Кнопка «Подтвердите ваши данные».
- «Подтвердите ваш запрос» (шаг 5 из 6): галочка `#checkbox-1`, **второй Turnstile**, кнопка «Подтвердить».
- Что после «Подтвердить» (шаг 6: письмо с кодом/ссылкой или сразу готово) — ещё не видели.
  `src/booking.js` на этот случай пишет в лог все ответы API и спрашивает код в Telegram, если появится поле ввода.
