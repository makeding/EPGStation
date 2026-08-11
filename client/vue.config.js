module.exports = {
    transpileDependencies: ['vuetify'],
    publicPath: './',
    css: {
        loaderOptions: {
            sass: {
                api: 'legacy',
            },
        },
    },
    chainWebpack: config => {
        // ios で reload 時に更新内容が反映されないため
        config.plugins.delete('preload');
        config.plugin('replace-node-fs').use(require('webpack').NormalModuleReplacementPlugin, [/^node:fs$/, resource => {
            resource.request = require.resolve('./src/empty-node-fs.js');
        }]);
    },
};
