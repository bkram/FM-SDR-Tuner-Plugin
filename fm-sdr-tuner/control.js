'use strict';

// The server-side control boundary lives in a small dependency-free module so
// its allowlist can be tested without booting fm-dx-webserver.
const ALLOWED_KEYS = new Set([
    'gain_db', 'agc', 'auto_gain',
    'lna', 'antenna', 'bias_tee',
    'rtl_agc', 'blend',
]);
const ALLOWED_ACTIONS = new Set(['reset_stats']);

function filterControl(input) {
    const out = {};
    const dropped = [];
    for (const key of Object.keys(input || {})) {
        if (key === 'action') {
            if (ALLOWED_ACTIONS.has(input.action)) out.action = input.action;
            else dropped.push('action=' + input.action);
        } else if (ALLOWED_KEYS.has(key)) {
            out[key] = input[key];
        } else {
            dropped.push(key);
        }
    }
    return { body: out, dropped };
}

module.exports = { filterControl };
