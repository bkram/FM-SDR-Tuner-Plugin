'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterControl } = require('../fm-sdr-tuner/control');

test('allows SDR controls including bias tee and stats reset', () => {
    const input = {
        gain_db: 20,
        agc: false,
        lna: 8,
        antenna: 1,
        bias_tee: true,
        rtl_agc: false,
        blend: 2,
        action: 'reset_stats',
    };

    assert.deepEqual(filterControl(input), { body: input, dropped: [] });
});

test('drops tuning and lifecycle controls', () => {
    const result = filterControl({
        frequency: 101700000,
        bandwidth_khz: 200,
        volume: 100,
        action: 'start',
    });

    assert.deepEqual(result.body, {});
    assert.deepEqual(result.dropped, [
        'frequency',
        'bandwidth_khz',
        'volume',
        'action=start',
    ]);
});

test('ignores non-object and empty input', () => {
    assert.deepEqual(filterControl(null), { body: {}, dropped: [] });
    assert.deepEqual(filterControl(undefined), { body: {}, dropped: [] });
});
