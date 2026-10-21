/* fm-sdr-tuner/frontend.js
 *
 * Client half of the FM-SDR-Tuner Control plugin. Injected into fm-dx-webserver
 * as a <script> after jQuery/jQuery-UI and webserver.js, so those globals
 * (jQuery `$`, `addIconToPluginPanel`, `togglePopup`, `sendToast`) are available.
 *
 * It adds a toolbar button that opens a draggable/resizable floating window with
 * live tuner telemetry and the SDR-specific settings the XDR protocol can't carry
 * (gain/AGC, SDRplay LNA/antenna, RTL AGC, stereo blend). It never tunes —
 * frequency, bandwidth, volume etc. are owned by the main webserver UI. It talks
 * to frontend_server.js over fm-dx-webserver's plugin WebSocket (/data_plugins,
 * same origin) — never directly to the tuner — so it works unchanged behind an
 * HTTPS/reverse-proxy front end and inherits the server's banlist/anti-spam.
 */
(function () {
    'use strict';

    var PANEL_ID = 'popup-panel-fm-sdr-tuner';
    var BTN_ID = 'fm-sdr-tuner-btn';
    // We talk to the server over fm-dx-webserver's plugin WebSocket
    // (/data_plugins, same origin as the page). The server (frontend_server.js)
    // polls the tuner and fans out status; we send control/subscribe messages.
    var READY_EVENT = 'fm-sdr-tuner-ready';
    var STATUS_EVENT = 'fm-sdr-tuner-status';
    var CONTROL_TYPE = 'fm-sdr-tuner-control';
    var SUB_TYPE = 'fm-sdr-tuner-sub';

    // "Reset to defaults" payloads. Kept device-specific so a reset never sends
    // keys the connected device rejects (which would come back ok:false). No
    // frequency — the popup never tunes (that's the main webserver UI over XDR).
    var DEFAULTS_COMMON = { agc: true };
    var DEFAULTS_SDRPLAY = { lna: 8, antenna: 0, bias_tee: false };
    var DEFAULTS_RTL = { rtl_agc: false };
    var currentSource = '';

    function resetDefaults() {
        var payload = {};
        Object.assign(payload, DEFAULTS_COMMON,
            currentSource === 'sdrplay' ? DEFAULTS_SDRPLAY : DEFAULTS_RTL);
        send(payload);
    }

    // Require a couple of consecutive failures before declaring the tuner
    // offline, so a slow first status or a transient hiccup doesn't flash it.
    var failCount = 0;
    var ws = null;
    var wsReady = false;
    var serverToken = null;
    var subscribed = false;
    var reconnectTimer = null;

    // ---- helpers -----------------------------------------------------------

    function $id(id) { return document.getElementById(id); }
    function setV(id, v) { var e = $id(id); if (e) e.textContent = v; }
    // Only write a value if the field isn't being edited right now.
    function setField(id, v) {
        var e = $id(id);
        if (e && document.activeElement !== e && v !== undefined && v !== null) e.value = v;
    }
    function setActive(id, on) { var e = $id(id); if (e) e.classList.toggle('active', !!on); }
    function markOnline() { failCount = 0; var e = $id('fst-offline'); if (e) e.style.display = 'none'; }
    function markOffline() { if (++failCount >= 2) { var e = $id('fst-offline'); if (e) e.style.display = 'block'; } }

    // ---- styling -----------------------------------------------------------
    // Scoped to #popup-panel-fm-sdr-tuner and built on the webserver's CSS
    // custom properties so it themes automatically. The .popup-window frame,
    // blur and border come from the webserver's modal.css.
    function injectStyle() {
        if ($id('fm-sdr-tuner-style')) return;
        var css = [
            // .popup-window is position:absolute with no offset; since we append
            // to <body> it would land at the bottom of the page. Give it an
            // explicit starting position so it floats in view (draggable after).
            '#' + PANEL_ID + ' { width: 460px; top: 70px; left: 70px; max-height: 85vh; z-index: 10000; }',
            '#' + PANEL_ID + ' .popup-content { padding: 10px 14px 14px; overflow-y: auto; max-height: calc(85vh - 48px); font-family: "Titillium Web", sans-serif; color: var(--color-text); }',
            '#' + PANEL_ID + ' .fst-offline { display: none; background: rgb(183,28,28); color: #fff; border-radius: 6px; padding: 6px 10px; margin: 4px 0 8px; font-weight: 600; }',
            '#' + PANEL_ID + ' .fst-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px 8px; background: var(--color-1-transparent); border-radius: 10px; padding: 8px 10px; margin-bottom: 10px; }',
            '#' + PANEL_ID + ' .fst-cell { display: flex; flex-direction: column; min-width: 0; }',
            '#' + PANEL_ID + ' .fst-k { font-size: .6rem; letter-spacing: .04em; color: var(--color-text-2); text-transform: uppercase; opacity: .8; }',
            '#' + PANEL_ID + ' .fst-v { font-size: 1.05rem; font-weight: 700; line-height: 1.2; }',
            '#' + PANEL_ID + ' .fst-cell.warn { background: rgb(183,28,28); border-radius: 6px; padding: 0 4px; margin: -2px -4px; }',
            '#' + PANEL_ID + ' .fst-cell.good .fst-v { color: var(--color-main-bright); }',
            '#' + PANEL_ID + ' fieldset { border: 1px solid var(--color-3); border-radius: 8px; margin: 8px 0; padding: 6px 10px 10px; }',
            '#' + PANEL_ID + ' legend { padding: 0 6px; font-size: .8rem; color: var(--color-main-bright); text-transform: uppercase; letter-spacing: .04em; }',
            '#' + PANEL_ID + ' .fst-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; flex-wrap: wrap; }',
            '#' + PANEL_ID + ' .fst-row label { flex: 0 0 8.5rem; font-size: .85rem; }',
            '#' + PANEL_ID + ' input[type=number] { width: 6.5rem; }',
            '#' + PANEL_ID + ' input { background: var(--color-1); color: var(--color-text); border: 1px solid var(--color-3); border-radius: 5px; padding: 3px 6px; font-family: inherit; }',
            '#' + PANEL_ID + ' small { color: var(--color-text-2); opacity: .7; font-size: .72rem; }',
            '#' + PANEL_ID + ' .fst-btn { background: var(--color-2); color: var(--color-text); border: 1px solid var(--color-3); border-radius: 5px; padding: 3px 10px; cursor: pointer; font-family: inherit; }',
            '#' + PANEL_ID + ' .fst-btn:hover { filter: brightness(1.2); }',
            '#' + PANEL_ID + ' .fst-btn.active { background: var(--color-main-bright); color: var(--color-main); border-color: var(--color-main-bright); font-weight: 700; }',
            '#' + PANEL_ID + ' .fst-btn.wide { width: 100%; margin: 3px 0; padding: 6px; }',
            '#' + PANEL_ID + ' input[type=range] { flex: 1 1 6rem; accent-color: var(--color-main-bright); }',
            '@media only screen and (max-width: 768px) {',
            '  #' + PANEL_ID + ' { width: calc(100% - 20px); left: 10px; top: 10px; max-height: calc(100vh - 20px); }',
            '  #' + PANEL_ID + ' .popup-content { max-height: calc(100vh - 68px); }',
            '  #' + PANEL_ID + ' .fst-stats { grid-template-columns: repeat(2, 1fr); }',
            '}'
        ].join('\n');
        var s = document.createElement('style');
        s.id = 'fm-sdr-tuner-style';
        s.textContent = css;
        document.head.appendChild(s);
    }

    // ---- markup ------------------------------------------------------------
    function buildPanel() {
        if ($id(PANEL_ID)) return;
        var stat = function (k, id) {
            return '<div class="fst-cell" id="cell-' + id + '"><span class="fst-k">' + k +
                '</span><span class="fst-v" id="' + id + '">–</span></div>';
        };
        var html =
            '<div class="popup-window" id="' + PANEL_ID + '">' +
            '  <div class="popup-header hover-brighten flex-center">' +
            '    <p class="color-4" style="margin:0;padding-left:10px;">FM-SDR-Tuner</p>' +
            '    <button class="popup-close">✖</button>' +
            '  </div>' +
            '  <div class="popup-content">' +
            '    <div class="fst-offline" id="fst-offline">Tuner offline</div>' +
            '    <div class="fst-stats">' +
            stat('Signal', 'vSignal') + stat('dBFS', 'vDbfs') + stat('SNR', 'vSnr') +
            stat('Peak dev', 'vPeak') + stat('Overload', 'vOverload') +
            stat('Stereo', 'vStereo') + stat('Pilot', 'vPilot') + stat('RDS dev', 'vRdsDev') +
            stat('RDS BER', 'vBer') + stat('RDS grps', 'vGroups') +
            '    </div>' +
            '    <button class="fst-btn wide" id="fst-defaults">Reset to defaults</button>' +
            '    <button class="fst-btn wide" id="fst-resetstats">Reset stats (MPX/RDS window)</button>' +
            '    <fieldset><legend>Gain</legend>' +
            '      <div class="fst-row"><label>Auto gain (AGC)</label><button class="fst-btn" id="fst-agcOn">On</button><button class="fst-btn" id="fst-agcOff">Off</button></div>' +
            '      <div class="fst-row"><label>Manual gain (dB)</label><input type="number" id="fst-gain" step="1"><small>when AGC off</small></div>' +
            '    </fieldset>' +
            '    <fieldset id="fst-sdrplay"><legend>SDRplay (RSP)</legend>' +
            '      <div class="fst-row"><label>LNA state</label><input type="number" id="fst-lna" min="0" max="27"><small>0 = most gain</small></div>' +
            '      <div class="fst-row" id="fst-antRow"><label>Antenna</label><input type="number" id="fst-ant" min="0" max="2"></div>' +
            '      <div class="fst-row"><label>Bias tee</label><button class="fst-btn" id="fst-biasOn">On</button><button class="fst-btn" id="fst-biasOff">Off</button></div>' +
            '    </fieldset>' +
            '    <fieldset id="fst-rtl"><legend>RTL-SDR</legend>' +
            '      <div class="fst-row"><label>RTL digital AGC</label><button class="fst-btn" id="fst-rtlAgcOn">On</button><button class="fst-btn" id="fst-rtlAgcOff">Off</button></div>' +
            '    </fieldset>' +
            '    <fieldset><legend>Audio</legend>' +
            '      <div class="fst-row"><label>Stereo blend</label><input type="range" id="fst-blend" min="0" max="2" step="1"><span id="fst-blendLbl">normal</span></div>' +
            '    </fieldset>' +
            '  </div>' +
            '</div>';
        $('body').append(html);
    }

    // ---- refresh from status ----------------------------------------------
    function refresh(s) {
        if (!s || s.ok === false || s.frequency_hz === undefined) {
            markOffline();
            return;
        }
        markOnline();

        currentSource = s.source || '';
        var sdrplay = (s.source === 'sdrplay');
        $id('fst-sdrplay').style.display = sdrplay ? '' : 'none';
        $id('fst-rtl').style.display = sdrplay ? 'none' : '';
        $id('fst-antRow').style.display = (s.antenna_count > 1) ? '' : 'none';

        setV('vSignal', (s.signal || 0).toFixed(0) + '/120');
        setV('vDbfs', s.dbfs !== undefined ? s.dbfs.toFixed(1) : '–');
        setV('vSnr', s.snr !== undefined ? s.snr.toFixed(1) + ' dB' : '–');
        setV('vPeak', s.mpx_peak_khz !== undefined ? '±' + s.mpx_peak_khz.toFixed(1) + 'k' : '–');
        setV('vOverload', s.overload ? 'YES' : 'no');
        $id('cell-vOverload').classList.toggle('warn', !!s.overload);
        setV('vStereo', s.stereo ? 'STEREO' : 'mono');
        $id('cell-vStereo').classList.toggle('good', !!s.stereo);
        setV('vPilot', s.pilot_khz !== undefined ? '±' + s.pilot_khz.toFixed(1) + 'k' : '–');
        setV('vRdsDev', s.rds_dev_khz !== undefined ? '±' + s.rds_dev_khz.toFixed(1) + 'k' : '–');
        setV('vBer', s.rds_ber !== undefined ? (100 * s.rds_ber).toFixed(2) + '%' : '–');
        setV('vGroups', s.rds_groups !== undefined ? s.rds_groups : '–');

        setField('fst-gain', s.gain_db);
        setField('fst-lna', s.lna);
        setField('fst-ant', s.antenna);

        setActive('fst-agcOn', s.auto_gain); setActive('fst-agcOff', !s.auto_gain);
        setActive('fst-biasOn', s.bias_tee); setActive('fst-biasOff', !s.bias_tee);
        setActive('fst-rtlAgcOn', s.rtl_agc); setActive('fst-rtlAgcOff', !s.rtl_agc);

        if (s.blend !== undefined) {
            setField('fst-blend', s.blend);
            $id('fst-blendLbl').textContent = ['soft', 'normal', 'aggressive'][s.blend] || s.blend;
        }
    }

    // ---- network (plugin WebSocket) ---------------------------------------
    function panelOpen() {
        return !!$id(PANEL_ID) && $('#' + PANEL_ID).is(':visible');
    }

    function wsSend(obj) {
        if (ws && wsReady) {
            try { ws.send(JSON.stringify(obj)); return true; } catch { /* ignore */ }
        }
        return false;
    }
    function subscribe(on) {
        if (!wsReady) {
            if (!on) subscribed = false;
            return;
        }
        if (subscribed === on) return;
        if (wsSend({ type: SUB_TYPE, value: on ? 1 : 0 })) subscribed = on;
    }
    // Apply an SDR control (server gates it against the allowlist and broadcasts
    // the resulting status back to all panels).
    function send(obj) { wsSend({ type: CONTROL_TYPE, value: obj }); }

    function wsConnect() {
        var proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
        serverToken = null;
        subscribed = false;
        try {
            ws = new WebSocket(proto + '//' + location.host + '/data_plugins');
        } catch {
            scheduleReconnect();
            return;
        }
        ws.onopen = function () {
            wsReady = true;
            if (panelOpen()) subscribe(true); // resume telemetry after a reconnect
        };
        ws.onmessage = function (ev) {
            var m;
            try { m = JSON.parse(ev.data); } catch { return; }
            if (m && m.type === READY_EVENT && !serverToken && m.value &&
                typeof m.value.token === 'string') {
                serverToken = m.value.token;
            } else if (m && m.type === STATUS_EVENT && serverToken && m.value &&
                m.value.token === serverToken && m.value.status &&
                typeof m.value.status === 'object') {
                refresh(m.value.status);
            }
        };
        ws.onclose = function () {
            wsReady = false;
            serverToken = null;
            subscribed = false;
            if (panelOpen()) markOffline();
            scheduleReconnect();
        };
        ws.onerror = function () { try { ws.close(); } catch { /* ignore */ } };
    }
    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function () { reconnectTimer = null; wsConnect(); }, 2000);
    }

    // ---- wiring ------------------------------------------------------------
    function wire() {
        var on = function (id, ev, fn) { var e = $id(id); if (e) e.addEventListener(ev, fn); };
        var num = function (el) { return +el.value; };

        on('fst-gain', 'change', function () { send({ gain_db: num(this) }); });
        on('fst-lna', 'change', function () { send({ lna: num(this) }); });
        on('fst-ant', 'change', function () { send({ antenna: num(this) }); });

        on('fst-agcOn', 'click', function () { send({ agc: true }); });
        on('fst-agcOff', 'click', function () { send({ agc: false }); });
        on('fst-biasOn', 'click', function () { send({ bias_tee: true }); });
        on('fst-biasOff', 'click', function () { send({ bias_tee: false }); });
        on('fst-rtlAgcOn', 'click', function () { send({ rtl_agc: true }); });
        on('fst-rtlAgcOff', 'click', function () { send({ rtl_agc: false }); });
        on('fst-defaults', 'click', resetDefaults);
        on('fst-resetstats', 'click', function () { send({ action: 'reset_stats' }); });

        on('fst-blend', 'input', function () {
            $id('fst-blendLbl').textContent = ['soft', 'normal', 'aggressive'][this.value];
        });
        on('fst-blend', 'change', function () { send({ blend: num(this) }); });

        // Close button (initPopups already ran before we injected, so bind ourselves).
        $('#' + PANEL_ID + ' .popup-close').on('click', function () {
            $('#' + PANEL_ID).fadeOut(200);
            subscribe(false); // stop the server polling the tuner for us
        });

        // Make it draggable/resizable like the native popups.
        if ($.fn.draggable) {
            $('#' + PANEL_ID).draggable({ handle: '.popup-header', containment: 'body' });
        }
        if ($.fn.resizable) {
            $('#' + PANEL_ID).resizable({ minWidth: 360, minHeight: 330, containment: 'body' });
        }

        // Native togglePopup() hides every other popup directly. Observe the
        // final display state so that being hidden by another popup also stops
        // this panel's server-side polling subscription.
        var panel = $id(PANEL_ID);
        if (panel && typeof MutationObserver !== 'undefined') {
            new MutationObserver(function () {
                subscribe(panelOpen());
            }).observe(panel, { attributes: true, attributeFilter: ['style'] });
        }
    }

    // Open/toggle the panel; togglePopup (modal.js) may not have loaded yet, so
    // fall back to a plain fade toggle. (Sub)scribe based on the resulting state
    // so the server only polls the tuner while a panel is actually open.
    function openPanel() {
        var willShow = !panelOpen();
        if (typeof togglePopup === 'function') togglePopup('#' + PANEL_ID);
        else $('#' + PANEL_ID).fadeToggle(200);
        subscribe(willShow);
    }

    // Add the toolbar button. webserver.js loads plugins.js (addIconToPluginPanel)
    // asynchronously AFTER our script runs, so we keep retrying: prefer the native
    // helper, and after a short grace fall back to appending the button ourselves
    // (the .scrollable-container toolbar is present in the static HTML).
    function addButton() {
        if ($id(BTN_ID)) return true;
        if (typeof addIconToPluginPanel === 'function') {
            addIconToPluginPanel(BTN_ID, 'SDR', 'solid', 'sliders', 'FM-SDR-Tuner settings');
        } else if ($('.scrollable-container').length) {
            $('.scrollable-container').append(
                '<button class="no-bg color-4 hover-brighten" id="' + BTN_ID + '" ' +
                'style="padding:6px;width:64px;min-width:64px;" title="FM-SDR-Tuner settings">' +
                '<i class="fa-solid fa-sliders fa-lg top-10"></i><br>' +
                '<span style="font-size:10px;color:var(--color-main-bright)!important;">SDR</span></button>');
        } else {
            return false; // toolbar not in the DOM yet
        }
        $('#' + BTN_ID).off('click').on('click', openPanel);
        return true;
    }

    // ---- init --------------------------------------------------------------
    $(function () {
        injectStyle();
        buildPanel();
        wire();

        // Retry adding the button: wait ~2s for the native helper to load, then
        // use the fallback; keep trying up to ~15s for the toolbar to appear.
        var tries = 0;
        (function tryAdd() {
            if ($id(BTN_ID)) return;
            var helperReady = (typeof addIconToPluginPanel === 'function');
            if ((helperReady || tries >= 8) && addButton()) return;
            if (tries++ < 60) setTimeout(tryAdd, 250);
        })();

        wsConnect();
        console.log('FM-SDR-Tuner Control plugin loaded.');
    });
})();
