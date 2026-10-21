// Flat ESLint config for the FM-SDR-Tuner Control plugin.
// Run with: npm run lint
export default [
    { ignores: ['node_modules/**', 'eslint.config.mjs'] },

    // Plugin descriptor — loaded by fm-dx-webserver via require() (CommonJS).
    {
        files: ['fm-sdr-tuner.js'],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'commonjs',
            globals: { module: 'readonly' },
        },
        rules: {
            'no-unused-vars': 'warn',
            'no-undef': 'error',
            eqeqeq: ['warn', 'smart'],
        },
    },

    // Dependency-free Node test suite.
    {
        files: ['test/**/*.js', 'fm-sdr-tuner/control.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { require: 'readonly', module: 'readonly' },
        },
        rules: {
            'no-unused-vars': 'warn',
            'no-undef': 'error',
            eqeqeq: ['warn', 'smart'],
        },
    },

    // Client UI — injected into the fm-dx-webserver page (browser + jQuery +
    // webserver-provided globals). ES5-style on purpose (no build step).
    {
        files: ['fm-sdr-tuner/frontend.js'],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'script',
            globals: {
                window: 'readonly', document: 'readonly', location: 'readonly',
                WebSocket: 'readonly', localStorage: 'readonly', fetch: 'readonly',
                MutationObserver: 'readonly',
                setTimeout: 'readonly', setInterval: 'readonly', console: 'readonly',
                $: 'readonly', jQuery: 'readonly',
                addIconToPluginPanel: 'readonly', togglePopup: 'readonly',
                sendToast: 'readonly', initTooltips: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': 'warn',
            'no-undef': 'error',
            eqeqeq: ['warn', 'smart'],
            'no-implicit-globals': 'warn',
        },
    },

    // Server backend — auto-loaded by fm-dx-webserver in Node (CommonJS).
    {
        files: ['fm-sdr-tuner/frontend_server.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly', module: 'readonly', process: 'readonly',
                fetch: 'readonly', AbortController: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                setInterval: 'readonly', URL: 'readonly', console: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': 'warn',
            'no-undef': 'error',
            eqeqeq: ['warn', 'smart'],
        },
    },
];
