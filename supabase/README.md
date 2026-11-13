# Настройка входа через Google и базы игроков

Делается один раз владельцем проекта. Секреты вводятся **только** в панелях Google и Supabase —
в репозиторий, в `.env`, в переменные GitHub/Render и в чат они не попадают.

## 1. Google Cloud — клиент OAuth

1. Откройте <https://console.cloud.google.com/> и создайте проект (например, «Asyk Atu»).
2. **Google Auth Platform → Branding** (раньше «OAuth consent screen»): тип **External**, название игры,
   почта поддержки. Области доступа (scopes) оставьте стандартные: `openid`, `email`, `profile`.
3. **Audience → Publish app** (статус «In production»). Пока приложение в статусе «Testing», войти смогут
   только адреса, добавленные вручную в «Test users».
4. **Clients → Create client → Web application**:
   - **Authorized JavaScript origins:**
     `https://mejrbekovalibek103-netizen.github.io`, `https://asyk-atu.onrender.com`, `http://localhost:5173`
   - **Authorized redirect URIs:** адрес из Supabase — см. шаг 2.1 (вида
     `https://<ваш-проект>.supabase.co/auth/v1/callback`).
5. Сохраните. Google покажет **Client ID** и **Client secret** — они нужны на следующем шаге.

## 2. Supabase — провайдер Google

1. **Authentication → Sign In / Providers → Google**: включите, скопируйте оттуда **Callback URL**
   (его и нужно вставить в Google на шаге 1.4), вставьте **Client ID** и **Client secret**, сохраните.
2. Там же: провайдер **Email** — выключить; **Anonymous sign-ins** — выключить.
   «Allow new users to sign up» должен быть **включён**: иначе новые игроки не смогут войти через Google.
3. **Authentication → URL Configuration**:
   - **Site URL:** `https://mejrbekovalibek103-netizen.github.io/Asyk-Atu/`
   - **Redirect URLs** (добавить все три):
     `https://mejrbekovalibek103-netizen.github.io/Asyk-Atu/`, `https://asyk-atu.onrender.com/`,
     `http://localhost:5173/`

   Игрок после входа возвращается только на адреса из этого списка — чужой сайт получить вход не сможет.

## 3. Supabase — таблицы и функции

1. **SQL Editor → New query**, вставьте весь файл [`schema.sql`](schema.sql), нажмите **Run**.
   Должно быть «Success. No rows returned». Скрипт можно запускать повторно.
2. Проверьте в **Table Editor**: появились таблицы `profiles` и `asyks`, у обеих отметка **RLS enabled**.

## 4. Проверка

Откройте игру → «Онлайн игра» → «Моя коллекция асыков» → «Войти через Google».
После входа должно показать «10 асыков» и приветствие. При повторном входе — те же 10, без новой выдачи.

## Что где хранится

| Что | Где | Секрет? |
|---|---|---|
| Адрес проекта и публичный ключ Supabase | `.env`, переменные GitHub и Render | нет, они видны в коде сайта |
| Client ID Google | панель Supabase | нет |
| **Client secret Google** | **только панель Supabase** | **да** |
| **Секретный ключ Supabase (`service_role`)** | **нигде в проекте не используется** | **да** |
