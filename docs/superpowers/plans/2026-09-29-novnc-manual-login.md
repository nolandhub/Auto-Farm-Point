# Automatic Manual-Login Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Follow-up, same day:** after this plan was carried out, the sign-in thresholds were tightened (no code requested by the bot, stop at the first code page, stop on the third visit to a looping step, `stuck` marker for every other failure). See "Sign-in thresholds" in the spec. Task 1 below describes the first version.

**Goal:** When the bot cannot sign in to an account on its own, the extension opens the bot's own browser in a tab (noVNC) so the user can finish the sign-in by hand, then closes it and reruns the account.

**Architecture:** `Login.ts` logs a `MANUAL_LOGIN_REQUIRED` marker where it gives up. The control API watches every log line, records those requests, and runs the bot's existing `manual-login` command on a virtual display served by noVNC on port 6080. The extension polls `GET /manual-login` every minute, starts a sign-in for a new request, opens the page, and on success closes it and reruns the account.

**Tech Stack:** TypeScript (bot, Patchright), Node 24 ESM (control API), Chrome MV3 extension (plain ESM), Docker (Debian `node:24-slim`), Xvfb + x11vnc + websockify + noVNC.

**Spec:** `docs/superpowers/specs/2026-09-29-novnc-manual-login-design.md`

## Global Constraints

- Marker format, exactly: `MANUAL_LOGIN_REQUIRED | email=<email> | reason=<reason>`; reasons `email-code-only`, `no-supported-method`, `email-verification` (and, after the follow-up, `stuck`).
- Manual-login timeout: 15 minutes. Only one manual login at a time.
- noVNC page: port `6080`, path `/vnc.html?autoconnect=1&resize=scale`, published on `127.0.0.1` only.
- API routes behind the shared token and `API_ALLOW_MANUAL_LOGIN=true`: `GET`, `POST`, `DELETE /manual-login`.
- Bot/API style: 4 spaces, single quotes, no semicolons, printWidth 120. Extension style: 2 spaces, double quotes, semicolons.
- Test commands: extension `node --test test/` (host Node 18, `.js` only); API `cd Microsoft-Rewards-Script && node --test scripts/api/*.test.js`; TypeScript tests `docker run --rm -v "$PWD":/w -w /w node:24-alpine node --test test/login-state.test.ts` from the repo root.
- No commits: the user commits on their own.
- Restart the bot container only after `GET /status` reports `"state":"idle"`.

---

### Task 1: Bot logs a manual-login marker where it gives up

**Files:**
- Modify: `Microsoft-Rewards-Script/src/browser/auth/LoginState.ts`
- Modify: `Microsoft-Rewards-Script/src/browser/auth/Login.ts` (imports; a private helper; the give-up points in `SIGN_IN_METHOD_PICKER`, `EMAIL_VERIFICATION_INPUT`, `OTP_CODE_ENTRY`)
- Test: `test/login-state.test.ts`

**Interfaces:**
- Produces: `manualLoginMarker(email: string, reason: ManualLoginReason): string` and `type ManualLoginReason` in `LoginState.ts`. The log line format is what Task 2's `parseManualLoginMarker` reads.

- [ ] **Step 1: Write the failing test** (add to `test/login-state.test.ts`, and add `manualLoginMarker` to its import list)

```ts
test('the manual-login marker names the account and the reason', () => {
    assert.equal(
        manualLoginMarker('me@example.com', 'email-code-only'),
        'MANUAL_LOGIN_REQUIRED | email=me@example.com | reason=email-code-only'
    )
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker run --rm -v "$PWD":/w -w /w node:24-alpine node --test test/login-state.test.ts`
Expected: FAIL, `does not provide an export named 'manualLoginMarker'`

- [ ] **Step 3: Implement** (append to `LoginState.ts`)

```ts
export type ManualLoginReason = 'email-code-only' | 'no-supported-method' | 'email-verification'

/**
 * The line the control API watches for (parseManualLoginMarker in
 * scripts/api/manualLoginManager.js): this account needs a person to sign in.
 */
export function manualLoginMarker(email: string, reason: ManualLoginReason): string {
    return `MANUAL_LOGIN_REQUIRED | email=${email} | reason=${reason}`
}
```

- [ ] **Step 4: Run it to verify it passes**

Same command. Expected: all tests pass.

- [ ] **Step 5: Log the marker in `Login.ts`**

Import `manualLoginMarker` and `type ManualLoginReason` from `./LoginState`.

Private helper, next to `normalizeSignInText`:

```ts
    private requireManualLogin(account: Account, reason: ManualLoginReason): void {
        this.bot.logger.error(this.bot.isMobile, 'LOGIN', manualLoginMarker(account.email, reason))
    }
```

Call it right before the `return false` that follows each of these existing error/warn logs:
- `'No supported non-interactive sign-in method is available; email-code fallback requires interactive stdin'` → `this.requireManualLogin(account, 'email-code-only')`
- `` `No supported sign-in method available${...}` `` → `this.requireManualLogin(account, 'no-supported-method')`
- `'Email verification requires a configured password or interactive stdin'` → `this.requireManualLogin(account, 'email-verification')`
- `'No usable email verification alternative found'` → `this.requireManualLogin(account, 'email-verification')`
- the email-code loop guard in `OTP_CODE_ENTRY` → `this.requireManualLogin(account, 'email-code-only')`, with a message saying the extension opens a manual sign-in page.

- [ ] **Step 6: Type-check by building the image**

Run: `cd Microsoft-Rewards-Script && docker compose build 2>&1 | grep -E "error|Built"`
Expected: `Image microsoft-rewards-script-local Built`, no `error TS`.

---

### Task 2: API manual-login manager

**Files:**
- Create: `Microsoft-Rewards-Script/scripts/api/manualLoginManager.js`
- Test: `Microsoft-Rewards-Script/scripts/api/manualLoginManager.test.js`

**Interfaces:**
- Consumes: the marker format from Task 1.
- Produces:
  - `parseManualLoginMarker(message) → { email, reason } | null`
  - `class ManualLoginManager({ projectRoot, display=':99', webPort=6080, vncPort=5900, timeoutMs=900000, spawn, kill, displayReady, wait, note })`
  - `observeLog(entry)`: records a request from a log entry `{ message, receivedAt }`
  - `getStatus() → { state, email, platform, startedAt, endedAt, exitCode, webPort, path, requests: [{ email, reason, at }] }`, where `state` is one of `idle | running | succeeded | failed | timedOut | cancelled`
  - `async start(email, platform='both') → status`; throws `{ code: 'ALREADY_RUNNING' }` or `{ code: 'BAD_REQUEST' }`
  - `cancel() → status`; throws `{ code: 'NOT_RUNNING' }`

- [ ] **Step 1: Write the failing tests** (the committed `manualLoginManager.test.js`: marker parsing, request recording, start order and arguments, success clears the request and stops helpers, failure keeps it, one at a time, bad platform, cancel, timeout, display that never starts)
- [ ] **Step 2: Run them to verify they fail**: `cd Microsoft-Rewards-Script && node --test scripts/api/manualLoginManager.test.js` → `Cannot find module './manualLoginManager.js'`
- [ ] **Step 3: Implement `scripts/api/manualLoginManager.js`** (the committed file: Xvfb `:99` 1920x1080, x11vnc `-localhost -nopw -forever -shared`, websockify `--web /usr/share/novnc 6080 localhost:5900`, then `node scripts/main/manualLogin.js <email> --platform <platform>` with `DISPLAY=:99` and without `FORCE_HEADLESS`; process groups signalled with `process.kill(-pid)`; 15-minute timeout)
- [ ] **Step 4: Run the tests to verify they pass**: `cd Microsoft-Rewards-Script && node --test scripts/api/*.test.js` → all pass.

---

### Task 3: Manual login inside the bot container

**Files:**
- Modify: `Microsoft-Rewards-Script/scripts/api/server.js` (import, setting, manager, log hook, route, endpoint list)
- Modify: `Microsoft-Rewards-Script/Dockerfile` (runtime stage)
- Modify: `Microsoft-Rewards-Script/compose.override.yaml` and `netsky/compose.override.yaml` (identical)

**Interfaces:**
- Consumes: `ManualLoginManager`, from Task 2.
- Produces: HTTP `GET /manual-login` → status; `POST /manual-login {email, platform?}` → 202 status, 404 `UNKNOWN_ACCOUNT`, 409 `ALREADY_RUNNING`, 400 `BAD_REQUEST`; `DELETE /manual-login` → 200 status, 409 `NOT_RUNNING`; all 403 `MANUAL_LOGIN_DISABLED` unless `API_ALLOW_MANUAL_LOGIN=true`. noVNC on `127.0.0.1:6080`.

- [ ] **Step 1: Wire the manager into `server.js`**: import `ManualLoginManager`; `const ALLOW_MANUAL_LOGIN = envBool('API_ALLOW_MANUAL_LOGIN', false)`; after the log-echo `pm.on('log', ...)` create `const manualLogin = new ManualLoginManager({ projectRoot, note: (level, message) => pm.note(level, message) })` and `pm.on('log', entry => manualLogin.observeLog(entry))`; list `'GET|POST|DELETE /manual-login'` in `GET /`; add the `/manual-login` route right before `// start` (403 when disabled; GET status; DELETE cancel or 409; POST looks the email up in `loadAccounts()`, 404 when unknown, then `manualLogin.start(account.email, body.platform ?? 'both')` with 409/400/500 mapping).
- [ ] **Step 2: Give the image a visible browser and noVNC**: add `xvfb x11vnc novnc websockify` to the runtime `apt-get install`; replace `npx patchright install --with-deps --only-shell chromium` with `npx patchright install --with-deps chromium`; copy `scripts/utils.js` and `scripts/main/manualLogin.js` next to `scripts/env.js`.
- [ ] **Step 3: Enable it in both `compose.override.yaml` copies**: `API_ALLOW_MANUAL_LOGIN: 'true'` and port `'127.0.0.1:6080:6080'`; `diff` the two copies (no output).
- [ ] **Step 4: Build, and recreate the container only while the bot is idle** (`GET /status` must print `"state":"idle"` before `docker compose up -d`).
- [ ] **Step 5: Smoke test without signing in**: `POST /manual-login {"email":"dotrang290418@gmail.com","platform":"mobile"}` → 202 running; `http://127.0.0.1:6080/vnc.html` → 200; screenshot the noVNC page from inside the container and check it shows the Microsoft sign-in page (type nothing, no code is sent); `DELETE /manual-login` → cancelled, and no `Xvfb|x11vnc|websockify|manualLogin` process left.

---

### Task 4: Extension logic for manual logins

**Files:**
- Modify: `src/core/constants.js` (a `manualLogin` storage key)
- Modify: `src/core/netsky.js` (client calls; badge)
- Create: `src/core/manual-login.js`
- Test: `test/netsky.test.js`, create `test/manual-login.test.js`

**Interfaces:**
- Consumes: the Task 3 HTTP API.
- Produces:
  - client methods `manualLoginStatus()`, `startManualLogin(email, platform?)`, `cancelManualLogin()`
  - `badgeFor({ ..., manual })`: `manual: true` gives `{ text: "!", color: "#b45309" }`
  - in `manual-login.js`: `requestKey(request)`, `nextRequest(status, handled)`, `pageUrl(connectionUrl, status)`, `async openManualLogin({ api, connectionUrl, email, tabs, storage })`, `async tickManualLogin({ api, connectionUrl, tabs, storage }) → "opened" | "rerun" | null`, `async checkManualLogin()`

- [ ] **Step 1: Write the failing tests**: in `test/netsky.test.js`, "manual-login calls use the right paths" and "the badge asks for attention while a manual sign-in is open"; create `test/manual-login.test.js` (page URL, request order, open once and close on end, rerun after success, rerun waits while busy, older API left alone).
- [ ] **Step 2: Run them to verify they fail**: `node --test test/netsky.test.js test/manual-login.test.js`.
- [ ] **Step 3: Implement**: `STORAGE_KEYS.manualLogin = "manualLogin.v1"`; the three client calls; `badgeFor` gains `manual`; `refreshBadge` reads `api.manualLoginStatus().catch(() => null)` alongside status and logs; create `src/core/manual-login.js`.
- [ ] **Step 4: Run the tests to verify they pass**: `node --test test/` → all pass.

---

### Task 5: Wire it into the worker and the manager page

**Files:**
- Modify: `background.js`
- Modify: `manage/manage.js`
- Modify: `src/core/i18n-bot.js`
- Modify: `src/core/constants.js` (`BUILD`)
- Modify: `run.md` (a short user note)

- [ ] **Step 1: Worker**: import `checkManualLogin`; call it with `refreshBadge` on the `ALARMS.netsky` alarm and at the end of the cold-start IIFE.
- [ ] **Step 2: Strings**: `manualLogin` ("Sign in by hand" / "Đăng nhập thủ công") and `manualLoginOpened` ("Sign-in page opened in a new tab." / "Đã mở trang đăng nhập ở tab mới.") next to `resetSession`.
- [ ] **Step 3: Manager button**: import `openManualLogin`; a `signIn` button before `remove`, disabled while busy; `signInByHand(account)` reads the connection URL and calls `act("accStatus", () => openManualLogin({ api, connectionUrl: url, email: account.email }), t(lang, "manualLoginOpened"))`.
- [ ] **Step 4: Version**: `BUILD` → `"2026-09-29.4"`, so the popup's reload banner reminds the user to reload the extension.
- [ ] **Step 5: User note**: a row in the "Lỗi thường gặp" table of `run.md`.
- [ ] **Step 6: Run all tests**: extension, API and TypeScript commands above → all pass.
- [ ] **Step 7: Hand over**: the user reloads the extension in `edge://extensions` and does the first real sign-in of `dotrang290418@gmail.com`.
