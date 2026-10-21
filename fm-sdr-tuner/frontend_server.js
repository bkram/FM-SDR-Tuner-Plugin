// fm-sdr-tuner/frontend_server.js
//
// Server-side half of the FM-SDR-Tuner Control plugin. fm-dx-webserver loads
// this file (~3s after boot) when the plugin is enabled. It talks to the panels
// over fm-dx-webserver's plugin WebSocket (/data_plugins), which gives us the
// server's session handling, banlist and anti-spam for free:
//
//   • telemetry: the server polls the tuner's REST /api/status ONCE per second
//     (only while at least one panel is subscribed) and fans it out directly
//     panels as { type: "fm-sdr-tuner-status", value: <status> }.
//   • control:   a panel sends { type: "fm-sdr-tuner-control", value: {...} };
//     the server gates it against an allowlist, POSTs it to the tuner, and
//     sends the fresh status to every subscribed panel.
//   • subscribe: a panel sends { type: "fm-sdr-tuner-sub", value: 1|0 } when it
//     opens/closes, so the tuner is only polled while someone is watching.
//
// Browsers never talk to the tuner directly (no CORS / mixed-content), the tuner
// stays bound to 127.0.0.1, and it all works behind an HTTPS/reverse proxy since
// /data_plugins is same-origin. The tuner base URL is fixed by config.json
// `fmSdrTuner.restUrl`; control is allowlisted so only SDR settings pass —
// never tuning/start/stop. The tuner REST API is unauthenticated by design and
// meant for a trusted LAN.

// Resolve webserver modules relative to this file (normal copied install) and,
// if that fails (e.g. this plugin dir is symlinked in during development, so
// Node resolves the real path outside plugins/), relative to the webserver's
// entry point (require.main → index.js in the webserver root).
const path = require('path');
const crypto = require('crypto');
function serverRequire(mod) {
    try {
        return require('../../server/' + mod);
    } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND' && require.main && require.main.filename) {
            return require(path.join(path.dirname(require.main.filename), 'server', mod));
        }
        throw e;
    }
}

const pluginsApi = serverRequire('plugins_api');
const { logInfo, logWarn, logError } = serverRequire('console');
const { filterControl } = require('./control');

const FALLBACK_URL = 'http://127.0.0.1:9090';
const TUNER_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 1000;
const READY_EVENT = 'fm-sdr-tuner-ready';
const STATUS_EVENT = 'fm-sdr-tuner-status';
const CONTROL_TYPE = 'fm-sdr-tuner-control';
const SUB_TYPE = 'fm-sdr-tuner-sub';

// The tuner base URL is fixed by config (co-located with the webserver).
function getTunerUrl() {
    const cfg = pluginsApi.getServerConfig() || {};
    const url = cfg.fmSdrTuner && cfg.fmSdrTuner.restUrl;
    return (typeof url === 'string' && url.trim()) ? url.trim().replace(/\/+$/, '') : FALLBACK_URL;
}

// Fetch JSON from the tuner with a timeout; never throws (returns an error
// object the panel renders as "offline").
async function tunerFetch(pathname, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TUNER_TIMEOUT_MS);
    try {
        const r = await fetch(getTunerUrl() + pathname, { ...init, signal: controller.signal });
        return await r.json();
    } catch (err) {
        const reason = err.name === 'AbortError' ? 'timeout' : err.message;
        return { ok: false, error: `tuner unreachable: ${reason}` };
    } finally {
        clearTimeout(timer);
    }
}

// The host's /data_plugins socket rebroadcasts all client messages. Send status
// directly to subscribed sockets with a per-connection token so a client cannot
// impersonate the server by publishing a STATUS_EVENT onto that shared bus.
const clientTokens = new WeakMap();

function sendToClient(ws, type, value) {
    if (ws.readyState !== ws.OPEN) return false;
    try {
        ws.send(JSON.stringify({ type, value }));
        return true;
    } catch (err) {
        logWarn(`[fm-sdr-tuner] Failed to send ${type}: ${err.message}`);
        return false;
    }
}

function broadcastStatus(status) {
    for (const ws of subscribers) {
        const token = clientTokens.get(ws);
        if (!token || !sendToClient(ws, STATUS_EVENT, { token, status })) {
            subscribers.delete(ws);
        }
    }
}

// Panels that currently have their window open (so we only poll when watched).
const subscribers = new Set();
let polling = false;

async function pollTick() {
    if (subscribers.size === 0 || polling) return;
    polling = true;
    try {
        broadcastStatus(await tunerFetch('/api/status', { method: 'GET' }));
    } finally {
        polling = false;
    }
}

async function applyControl(value) {
    const { body, dropped } = filterControl(value);
    if (dropped.length) {
        logWarn(`[fm-sdr-tuner] Blocked disallowed control key(s): ${dropped.join(', ')}`);
    }
    if (Object.keys(body).length === 0) return;
    const j = await tunerFetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    // Reply carries fresh status; send it (or the error) to all subscribed panels.
    broadcastStatus(j && j.status ? j.status : j);
}

function register() {
    const wss = pluginsApi.getPluginsWss();
    if (!wss) {
        logError('[fm-sdr-tuner] plugin WebSocket server unavailable; not registered.');
        return;
    }
    wss.on('connection', (ws) => {
        const token = crypto.randomBytes(24).toString('hex');
        clientTokens.set(ws, token);
        sendToClient(ws, READY_EVENT, { token });

        ws.on('message', (raw) => {
            let m;
            try {
                m = JSON.parse(raw.toString());
            } catch {
                return; // not JSON / not for us
            }
            if (!m || typeof m !== 'object') return;
            if (m.type === CONTROL_TYPE) {
                applyControl(m.value);
            } else if (m.type === SUB_TYPE) {
                if (m.value) {
                    subscribers.add(ws);
                    pollTick(); // push an immediate status on open
                } else {
                    subscribers.delete(ws);
                }
            }
        });
        ws.on('close', () => subscribers.delete(ws));
    });
    setInterval(pollTick, POLL_INTERVAL_MS);
    logInfo(`[fm-sdr-tuner] plugin WebSocket ready on /data_plugins -> ${getTunerUrl()}`);
}

register();

module.exports = { register };
