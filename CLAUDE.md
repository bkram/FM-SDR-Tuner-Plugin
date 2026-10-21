# CLAUDE.md

Project guidance for working in this repo. For end-user install/config, see [README.md](README.md).

## What this is

A server-side plugin for **fm-dx-webserver** (`../fm-dx-webserver`) that adds a floating
window for the SDR-specific settings exposed over the REST control API of **FM-SDR-Tuner**
(`../FM-SDR-Tuner`). It matches the webserver's look and feel (native `.popup-window`, CSS
custom properties, `addIconToPluginPanel`).

## Why it exists

fm-dx-webserver already talks to the tuner over the **XDR/FM-DX protocol** (TCP 7373) for
tuning + telemetry, and streams **audio** separately (the user routes tuner audio → BlackHole →
webserver input). But XDR has no vocabulary for the SDR back-end's own knobs. FM-SDR-Tuner
exposes those over an anonymous HTTP **REST API** (default `http://127.0.0.1:9090`); this
plugin is the front-end for that REST API. XDR and REST run side by side.

## Architecture

```
panels ──{sub}/{control} over WebSocket──▶ /data_plugins  (session+banlist+antispam)
                                              frontend_server.js (allowlist)
                                           ──▶ FM-SDR-Tuner REST (/api/status,/api/control)
panels ◀──{status} broadcast (server polls tuner 1×/s while ≥1 panel is subscribed)
```

- **Plugin WebSocket** (`/data_plugins`), not browser-direct-to-tuner and not HTTP. Chosen
  (over the earlier HTTP proxy) so N viewers = one tuner poll (server polls, fans out), and
  to inherit fm-dx-webserver's session/banlist/anti-spam. Works behind HTTPS/reverse proxies
  (same-origin `ws`/`wss`); requires a root mount + WS-upgrade passthrough for `/data_plugins`.
- **Message types**: client→server `fm-sdr-tuner-control` (apply) and `fm-sdr-tuner-sub`
  (1/0 on panel open/close); server→clients `fm-sdr-tuner-status` (broadcast). Note
  `/data_plugins` rebroadcasts any client JSON to all clients. The backend therefore sends a
  private `fm-sdr-tuner-ready` token to each connection and sends status directly to each
  subscriber; panels accept only status envelopes carrying their connection's token.
- **Tuner URL is fixed** by `config.json` `fmSdrTuner.restUrl` (no client override → no SSRF).
- **Server-side allowlist** (`ALLOWED_KEYS`/`ALLOWED_ACTIONS`) is the authoritative gate:
  only SDR settings pass. Tuning/frequency, bandwidth, volume, force-mono, start/stop are
  dropped even via a crafted message — the panel is **SDR settings only**; the main webserver
  owns tuning (XDR) and those other knobs.

## Files (the deliverable)

- `fm-sdr-tuner.js` — plugin descriptor (`pluginConfig`, `frontEndPath`). fm-dx-webserver
  reads this at startup and symlinks the front-end into `web/js/plugins/`.
- `fm-sdr-tuner/frontend.js` — injected client UI: floating panel, WS client (status render +
  control/subscribe). Device-aware (RTL vs SDRplay via `source`/`antenna_count`).
- `fm-sdr-tuner/frontend_server.js` — the WS backend. Auto-loaded (~3 s after boot) only when
  the plugin is enabled; naming must stay `<frontEndPath minus .js>_server.js`.
- `fm-sdr-tuner/control.js` — dependency-free control allowlist/filter used by the backend and
  its Node test suite.
- `README.md` — installation manual. `LICENSE` — GPLv3. Lint tooling: `package.json`,
  `eslint.config.mjs`, `.markdownlint.json` — `npm run lint` (eslint + markdownlint-cli2).

## How it hooks into fm-dx-webserver (contract)

- Enabled when its `frontEndPath` is in `config.json` `plugins[]` (or admin Setup → Plugins).
- Front-end is injected as `<script src="js/plugins/fm-sdr-tuner/frontend.js">` at the bottom
  of `web/index.ejs`.
- The backend uses `pluginsApi.getPluginsWss()` (the `/data_plugins` server), adds a
  `connection`/`message` listener, and sends authenticated status envelopes directly to
  subscribed sockets. Tuner URL comes from `pluginsApi.getServerConfig()`.
- `serverRequire()` resolves webserver modules relative to this file (copied install) and
  falls back to `require.main` (works when the plugin dir is **symlinked** in for dev).

## Gotchas learned

- `webserver.js` loads `plugins.js`/`modal.js` **asynchronously after** our script, so
  `addIconToPluginPanel`/`togglePopup` may be undefined at `$(document).ready`. `addButton()`
  retries and falls back to appending the button itself.
- `.popup-window` is `position:absolute` with no offset; appended to `<body>` it lands at the
  page bottom, so the panel sets its own `top/left/z-index` to float on top.
- The browser caches the plugin JS — after editing `frontend.js`, **hard-refresh**
  (Cmd/Ctrl+Shift+R). Editing `frontend_server.js` needs a webserver restart.

## Boundaries

- Do **not** manage the user's `fm-sdr-tuner` process or the audio routing — the user runs
  the tuner and routes audio to BlackHole; fm-dx-webserver consumes BlackHole as input.
- Keep changes to the plugin. Touch fm-dx-webserver only for install/config (e.g.
  `config.json`), and ask before restarting long-running processes the user controls.

## Testing end-to-end

1. Tuner: `./build/fm-sdr-tuner --source rtl_sdr -f 98000 --auto-start --rest-port 9090`
   (SDRplay needs the `build-sdrplay/` build — see below; add `-P <pw>` if the webserver's
   `xdrd.xdrdPassword` is set; audio flags as the user prefers).
2. Webserver: `cd ../fm-dx-webserver && node index.js`; expect
   `[fm-sdr-tuner] plugin WebSocket ready on /data_plugins …`.
3. WS check: connect a WebSocket to `ws://localhost:8080/data_plugins`, send
   `{"type":"fm-sdr-tuner-sub","value":1}` → receive `{"type":"fm-sdr-tuner-status",...}`
   ~1×/s; send `{"type":"fm-sdr-tuner-control","value":{"gain_db":20}}` → status reflects it,
   `{"value":{"freq_khz":95000}}` is gated (dropped, logged).
4. Browser: click **SDR**, confirm the floating panel shows live telemetry and controls work.
5. Lint: `npm install && npm run lint` (eslint + markdownlint-cli2) — must be clean.

### SDRplay note

`build/` is compiled **without** SDRplay support (stub → `--source sdrplay` always fails
silently). Build with SDRplay via `cmake -S . -B build-sdrplay -DFM_TUNER_ENABLE_SDRPLAY=ON &&
cmake --build build-sdrplay`. `connect()` in `src/sdrplay_device.cpp` has instrumentation that
prints the exact failing step (Open/GetDevices/SelectDevice/GetDeviceParams) + API version.
