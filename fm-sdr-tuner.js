// Plugin configuration, this is used in the administration when plugins are loaded
var pluginConfig = {
    name: 'FM-SDR-Tuner Control',
    version: '1.0',
    author: 'Bkram Developments',
    frontEndPath: 'fm-sdr-tuner/frontend.js'
}

// Backend (server) changes live in fm-sdr-tuner/frontend_server.js, which
// fm-dx-webserver auto-loads (~3s after boot) whenever this plugin is enabled.

// Don't change anything below here if you are making your own plugin
module.exports = {
    pluginConfig
}
