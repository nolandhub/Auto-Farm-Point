# Automatic manual-login page (noVNC)

Date: 2026-09-29

## Purpose

A fallback for accounts the bot cannot sign in to unattended: passwordless
accounts that only offer an emailed code or a passkey, and other verification
steps that need a human. The automated login stays the default. When it gives
up, the extension opens the bot's own browser in a tab so the user can finish
the sign-in by hand (for example: Send code, paste the code from the email).
Nobody types a command.

## Flow

1. **The bot gives up on an account.** At each point where the login has no
   unattended way forward, `Login.ts` logs one machine-readable line and fails
   that account; the run continues with the other accounts:
   `MANUAL_LOGIN_REQUIRED | email=<email> | reason=<reason>`
   Reasons: `email-code-only` (a code sent to email or phone is the only way
   in), `no-supported-method` (the sign-in method picker offers nothing
   usable), `email-verification` (email verification with no password
   configured), `stuck` (any other failure, or a login going in circles).
2. **The API records it; the extension notices.** The API sees every log
   line, so it records each marker as a request (`email`, `reason`, `at`) and
   lists them in `GET /manual-login`. The extension's per-minute refresh reads
   that list (the badge only reads the last 60 log lines and could miss a
   marker). For a request it has not handled yet (keyed by email and `at`,
   remembered in `chrome.storage.local`), it calls `POST /manual-login {email}`
   and opens `http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale` in a
   new tab. The badge shows an amber `!` while a manual login is open.
3. **The user signs in** in that tab.
4. **Done.** `manual-login` saves the session once the browser has stayed on
   `rewards.bing.com` for five seconds (desktop session too, one after the
   other). The API reports `succeeded`; the extension closes the tab it opened
   and starts a run for that account with `POST /start {accountIndex}`. If the
   bot is busy, it waits and starts that run once the bot is idle.
5. **Nobody came.** After 15 minutes without success the API stops the
   browser and reports `timedOut`.

The manager page also gets a "Manual login" button per account, which does
steps 2-4 on demand.

Triggering from the extension, not from the API, is deliberate: an open Edge
means someone is probably at the machine. A 07:00 run that fails with nobody
around does not leave a browser waiting; the page opens the next time Edge is
running.

## Sign-in thresholds

Requesting codes the bot cannot read gets the account locked, so the bot fails
as early as possible and never asks for a code itself. The one code is the
one the user requests in the manual-login tab.

- **"Get a code to sign in".** Without an interactive terminal, before pressing
  the primary button the bot reads the page subtitle. If it names an email
  address or phone number (full or masked with `*`, `x` or `•`, in any page
  language), that button would send a code there: the bot does not press it
  and gives up with `email-code-only`. An Authenticator page names neither, so
  its button is still pressed.
- **"Enter your code"** (Microsoft sent a code on its own after the email
  step). The bot tries the page's alternative-method link, which sends
  nothing. If that does not leave the page, it gives up at once; it no longer
  presses Back, which leads to a page that sends another code.
- **Going in circles.** The third visit in one login to a step that makes no
  progress when repeated (send code, enter code, footer action, method picker,
  email verification, passkey prompt, unknown page) ends the login with
  `stuck`, instead of running on to the 25-iteration limit.
- **Any other failure** of the login loop, and the iteration limit itself,
  also log `stuck`, so the manual page opens. Explicit Microsoft errors (such
  as a wrong password) do not: the log says what to fix.
- Only the first marker of a login is logged, so a specific reason is not
  replaced by the generic `stuck`.

## Components

### Bot (`src/browser/auth/Login.ts`, `LoginState.ts`)

`manualLoginMarker`, `mentionsProof` and `shouldStopLoginCycle` in
`LoginState.ts`; a `requireManualLogin` helper in `Login.ts`, called at every
give-up point above.

### Image (`Dockerfile`)

The runtime image gains the full Patchright Chromium (it shipped only the
headless shell), `x11vnc`, `novnc` and `websockify`; Xvfb is listed too. It
also copies `scripts/utils.js` and `scripts/main/manualLogin.js`. It has to be
the main image: the API runs inside the bot container, and letting it start
other containers would need the Docker socket, which is root on the host.

### API

- `scripts/api/manualLoginManager.js`: one manual login at a time. `start(email,
  platform)` starts Xvfb on `:99` (1920x1080), x11vnc on that display
  (loopback, shared, no password), websockify serving noVNC on port 6080, then
  `node scripts/main/manualLogin.js <email> --platform <platform>` with
  `DISPLAY=:99`. `getStatus()` returns `{ state: idle | running | succeeded |
  failed | timedOut | cancelled, email, platform, startedAt, endedAt,
  exitCode, webPort, path, requests }`. `cancel()` stops everything. A
  15-minute timeout cancels with `timedOut`. When manual-login exits, the
  display, VNC and websockify processes stop.
- Routes in `server.js`, all behind the shared token and
  `API_ALLOW_MANUAL_LOGIN=true`:
  - `GET /manual-login` → status
  - `POST /manual-login { email, platform? }` → 202 and status; 409 if one is
    running; 404 if the email is not a configured account
  - `DELETE /manual-login` → cancel
- `compose.override.yaml` (and its source copy `netsky/compose.override.yaml`):
  `API_ALLOW_MANUAL_LOGIN: 'true'` and port `127.0.0.1:6080:6080`.

### Extension

- `src/core/netsky.js`: client calls `manualLoginStatus`, `startManualLogin`,
  `cancelManualLogin`; `badgeFor` shows an amber `!` while a manual login runs.
- `src/core/manual-login.js`: `nextRequest`, `pageUrl`, `openManualLogin`,
  `tickManualLogin`, `checkManualLogin`.
- `background.js`: runs `checkManualLogin` every minute and on worker start.
- `manage/`: a "Manual login" button per account.
- `src/core/i18n-bot.js`: English and Vietnamese strings.

## Security

noVNC has no password but listens on `127.0.0.1` only, like the control API,
and runs only while a manual login is in progress.

## Testing

- Extension: unit tests for the client calls, the badge and the manual-login
  flow (open once, close on end, rerun, wait while busy, older API).
- API: unit tests for the manual-login lifecycle (start, success, failure,
  timeout, cancel, one-at-a-time, display failure) with fake commands.
- Bot: the marker format, `mentionsProof` (including the subtitle Microsoft
  showed for a passwordless account), and the cycle threshold.
- Build the image; start a manual login for an existing account, confirm the
  noVNC page answers on 6080 and Chromium is on the display, then cancel it
  without entering an email or requesting a code.
- The first real sign-in (`dotrang290418@gmail.com`) is done by the user.
