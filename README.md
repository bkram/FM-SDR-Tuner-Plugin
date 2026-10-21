# FM-SDR-Tuner Control — fm-dx-webserver plugin

A plugin for [fm-dx-webserver](https://github.com/NoobishSVK/fm-dx-webserver) that adds a
draggable, resizable floating window for the SDR-specific settings exposed by
[FM-SDR-Tuner](https://github.com/Bkram/FM-SDR-Tuner)'s REST control API.

fm-dx-webserver already speaks the XDR/FM-DX protocol to the tuner for tuning and telemetry,
but XDR has no vocabulary for the SDR back-end's own knobs — manual gain, SDRplay
LNA/antenna/bias-tee, RTL digital AGC, stereo blend. FM-SDR-Tuner exposes those over an
anonymous HTTP REST API; this plugin is the front-end for it, styled to match the webserver's
look and feel.

## What you get

- An **SDR** button in the plugin toolbar that opens a floating, draggable, topmost window
  themed to match fm-dx-webserver.
- Live telemetry (~1 Hz while open): signal, dBFS, SNR, peak deviation, overload, stereo
  lock, pilot/RDS deviation, RDS BER and group count.
- Device-aware **SDR settings** (RTL-SDR vs SDRplay): gain / auto-gain, SDRplay
  LNA / antenna / bias-T, RTL digital AGC, stereo blend, plus **Reset stats** and
  **Reset to defaults**.

The panel exposes **only** the SDR-specific knobs XDR can't carry. Anything fm-dx-webserver
already owns — frequency/tuning, bandwidth, volume, force-mono, start/stop — is intentionally
omitted **and gated server-side** (see [Security](#security--trust-model)), so those commands
can't reach the tuner through the plugin even via a crafted request. "Reset to defaults"
resets SDR settings only and never changes the frequency.

## How it works

The browser never talks to the tuner directly. The panels and the server-side half
(`fm-sdr-tuner/frontend_server.js`) communicate over fm-dx-webserver's **plugin WebSocket**
(`/data_plugins`, same origin as the page):

```
panels ── {type:"fm-sdr-tuner-sub"}      (open/close: start/stop polling)
          {type:"fm-sdr-tuner-control"}  ─┐
                                           ▼
                              fm-dx-webserver /data_plugins  (session + banlist + anti-spam)
                                           │  frontend_server.js (allowlist)
                                           ▼
                              FM-SDR-Tuner REST  (GET /api/status, POST /api/control)
                                           │
   panels ◀── {type:"fm-sdr-tuner-status"}  broadcast (server polls once/sec while watched)
```

The server polls the tuner's `/api/status` **once per second** (only while a panel is open)
and broadcasts it to all panels, so N viewers don't mean N× load on the tuner. Control
messages are gated against an allowlist before being POSTed to the tuner. Using the plugin
WebSocket means the plugin inherits fm-dx-webserver's session handling, **banlist and
anti-spam**, and the tuner can stay bound to `127.0.0.1`.

### Behind a reverse proxy / HTTPS

It works unchanged behind an HTTPS terminator, an nginx/Caddy reverse proxy, a Cloudflare
tunnel, or fm-dx-webserver's built-in tunnel. The panel connects to `/data_plugins` on the
**same origin** it was served from (auto `ws://`/`wss://`), so it rides the same connection
as the rest of the UI and the tuner link is made server-side (localhost→localhost), never
traversing the proxy. The only requirement is that fm-dx-webserver is mounted at the **origin
root** (`https://host/`) — like the webserver itself, the plugin does not support a sub-path
mount. Make sure the proxy forwards WebSocket upgrades for `/data_plugins` (fm-dx-webserver's
main UI already needs this).

## Files

```
fm-sdr-tuner.js                  # plugin descriptor (pluginConfig)
fm-sdr-tuner/frontend.js         # injected client UI
fm-sdr-tuner/frontend_server.js  # server-side WebSocket backend (auto-loaded when enabled)
fm-sdr-tuner/control.js          # server-side control allowlist/filter
```

## Install

1. Copy `fm-sdr-tuner.js` **and** the `fm-sdr-tuner/` directory into your webserver's
   `plugins/` folder:

   ```
   fm-dx-webserver/plugins/fm-sdr-tuner.js
   fm-dx-webserver/plugins/fm-sdr-tuner/frontend.js
   fm-dx-webserver/plugins/fm-sdr-tuner/frontend_server.js
   fm-dx-webserver/plugins/fm-sdr-tuner/control.js
   ```

2. Enable it, either:
   - in the admin UI: **Setup → Plugins → select "FM-SDR-Tuner Control" → Save**, or
   - by adding its front-end path to `config.json`:

     ```json
     "plugins": ["fm-sdr-tuner/frontend.js"]
     ```

3. *(Optional)* set the tuner URL in `config.json` if it isn't the default
   `http://127.0.0.1:9090` (e.g. a different port, or a tuner on another host):

   ```json
   "fmSdrTuner": { "restUrl": "http://127.0.0.1:9090" }
   ```

4. Restart fm-dx-webserver. On start you should see:

   ```
   Plugin FM-SDR-Tuner Control 1.0 initialized successfully.
   Plugin frontend_server loaded successfully!
   [fm-sdr-tuner] plugin WebSocket ready on /data_plugins -> http://127.0.0.1:9090
   ```

   On Linux/macOS the webserver symlinks the front-end file into `web/js/plugins/`
   automatically; on Windows it links the directory as a junction. After enabling,
   **hard-refresh** the browser (Cmd/Ctrl+Shift+R) to pick up the plugin script.

## Enable the tuner's REST API

In `fm-sdr-tuner.ini`:

```ini
[rest]
enabled = true
port = 9090
bind_address = 127.0.0.1
```

or launch the tuner with `--rest-port 9090`.

## Security / trust model

The FM-SDR-Tuner REST API is **unauthenticated by design** and intended for localhost or a
trusted LAN — run fm-dx-webserver on a trusted network. The plugin adds these safeguards:

- **Fixed target.** The tuner URL is taken solely from `config.json` (`fmSdrTuner.restUrl`);
  clients cannot redirect the server at a different host. There is no SSRF surface.
- **Server-side allowlist.** Every control message is filtered against `ALLOWED_KEYS` /
  `ALLOWED_ACTIONS` in `control.js` before it is POSTed to the tuner. Only SDR
  settings pass; tuning (`freq_*`/`frequency`), bandwidth, volume, force-mono and
  `action:start`/`stop` are dropped. To adjust what the plugin may control, edit those sets.
- **Authenticated status envelopes.** The backend sends telemetry directly to each subscribed
  panel with a random per-connection token. The panel rejects status-shaped messages copied
  onto the shared plugin bus by another client.
- **Inherited protections.** Because traffic goes over `/data_plugins`, it passes through
  fm-dx-webserver's session handling, banlist and anti-spam.

Note: control is **not** gated to admins — anyone who can reach the panel can change SDR
settings (not tuning). On a `publicTuner`, restrict control by putting fm-dx-webserver behind
auth, or add an admin check in `applyControl()`.

## Troubleshooting

- **Panel shows "Tuner offline"** — the tuner's REST API isn't reachable from the webserver
  host, or the `/data_plugins` WebSocket dropped (it takes two consecutive failures to show).
  Check `[rest] enabled/port` and `curl http://127.0.0.1:9090/api/status` from the webserver
  host, and that any reverse proxy forwards WebSocket upgrades for `/data_plugins`.
- **No SDR button** — confirm the plugin is enabled and (Linux/macOS) the symlink
  `web/js/plugins/fm-sdr-tuner/frontend.js` exists; then hard-refresh the browser.
- **Changes not showing after an update** — the browser caches the plugin JS; hard-refresh
  (Cmd/Ctrl+Shift+R).
- **SDRplay-only controls missing on RTL (or vice-versa)** — expected; the panel shows only
  the section matching the connected device (`source` / `antenna_count`). Applying a
  device-specific setting to the wrong device is silently ignored, not an error.

## License

GPLv3 — see [LICENSE](LICENSE). © Bkram Developments. Consistent with FM-SDR-Tuner and
fm-dx-webserver, which are also GPLv3.
