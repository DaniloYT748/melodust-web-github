# Melodust Web

Музичний плеєр у браузері (PWA) із синхронізацією акаунта між пристроями.

- `index.html`, `css/`, `js/`, `icons/`, `sw.js` — сайт (статика)
- `server/` — Node.js-сервер: акаунти, синхронізація в реальному часі (WebSocket), відновлення пароля через Resend

## Швидкий старт

```bash
cd server
npm install
cp .env.example .env     # заповни RESEND_API_KEY, MAIL_FROM, SITE_URL
node --env-file=.env server.js    # http://localhost:3000 — і сайт, і API
npm test                 # інтеграційні тести (Node 22+)
```

Деталі розгортання, nginx і змінні середовища — у [`server/README.md`](server/README.md).

## Розгортання
- **Сайт окремо** (статика, CityHost/GitHub Pages): залий вміст репозиторію без `server/`, у `js/config.js` вкажи адресу сервера.
- **Сервер** (потрібен Node.js 18+, не GitHub Pages): VPS або Node-хостинг, дані в `DATA_DIR`.

> Не комітьте `.env` і `server/data/` — там ключі та хеші паролів.
