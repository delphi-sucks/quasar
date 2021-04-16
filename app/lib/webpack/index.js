const createChain = require('./create-chain')
const { log } = require('../helpers/logger')
const extensionRunner = require('../app-extension/extensions-runner')

async function getWebpackConfig (chain, cfg, {
  name,
  cfgExtendBase = cfg.build,
  hookSuffix = '',
  cmdSuffix = '',
  invokeParams
}) {
  await extensionRunner.runHook('chainWebpack' + hookSuffix, async hook => {
    log(`Extension(${hook.api.extId}): Chaining ${name ? name + ' ' : ''}Webpack config`)
    await hook.fn(chain, invokeParams, hook.api)
  })

  if (typeof cfgExtendBase[ 'chainWebpack' + cmdSuffix ] === 'function') {
    log(`Chaining ${name ? name + ' ' : ''}Webpack config`)
    await cfgExtendBase[ 'chainWebpack' + cmdSuffix ](chain, invokeParams)
  }

  const webpackConfig = chain.toConfig()

  await extensionRunner.runHook('extendWebpack' + hookSuffix, async hook => {
    log(`Extension(${hook.api.extId}): Extending ${name ? name + ' ' : ''}Webpack config`)
    await hook.fn(webpackConfig, invokeParams, hook.api)
  })

  if (typeof cfgExtendBase[ 'extendWebpack' + cmdSuffix ] === 'function') {
    log(`Extending ${name ? name + ' ' : ''}Webpack config`)
    await cfgExtendBase[ 'extendWebpack' + cmdSuffix ](webpackConfig, invokeParams)
  }

  if (cfg.ctx.dev) {
    webpackConfig.optimization = webpackConfig.optimization || {}
    webpackConfig.optimization.emitOnErrors = false

    webpackConfig.infrastructureLogging = Object.assign(
      { colors: true, level: 'warn' },
      webpackConfig.infrastructureLogging
    )
  }
  else {
    // webpackConfig.cache = false // webpackConfig.cache || { type: 'filesystem' }
  }

  // TODO: enable when webpack5 work is complete
  webpackConfig.cache = false

  return webpackConfig
}

async function getSPA (cfg) {
  const chain = createChain(cfg, 'SPA')

  require('./spa')(chain, cfg)

  return await getWebpackConfig(chain, cfg, {
    name: 'SPA',
    invokeParams: { isClient: true, isServer: false }
  })
}

async function getPWA (cfg) {
  // inner function so csw gets created first
  // (affects progress bar order)

  function getRenderer () {
    const chain = createChain(cfg, 'PWA')

    require('./spa')(chain, cfg) // extending a SPA
    require('./pwa')(chain, cfg)

    return getWebpackConfig(chain, cfg, {
      name: 'PWA',
      invokeParams: { isClient: true, isServer: false }
    })
  }

  if (cfg.pwa.workboxPluginMode !== 'InjectManifest') {
    return { renderer: await getRenderer() }
  }

  const createCSW = require('./pwa/create-custom-sw')
  const cswBuildName = 'Custom Service Worker'

  // csw - custom service worker
  const csw = await getWebpackConfig(createCSW(cfg, cswBuildName), cfg, {
    name: cswBuildName,
    cfgExtendBase: cfg.pwa,
    hookSuffix: 'PwaCustomSW',
    cmdSuffix: 'CustomSW',
    invokeParams: { isClient: true, isServer: false }
  })

  return { csw, renderer: await getRenderer() }
}

async function getCordova (cfg) {
  const chain = createChain(cfg, 'Cordova')

  require('./cordova')(chain, cfg)

  return await getWebpackConfig(chain, cfg, {
    name: 'Cordova',
    invokeParams: { isClient: true, isServer: false }
  })
}

async function getCapacitor (cfg) {
  const chain = createChain(cfg, 'Capacitor')
  require('./capacitor')(chain, cfg)

  return await getWebpackConfig(chain, cfg, {
    name: 'Capacitor',
    invokeParams: { isClient: true, isServer: false }
  })
}

async function getElectron (cfg) {
  const rendererChain = createChain(cfg, 'Renderer process')
  const preloadChain = require('./electron/preload')(cfg, 'Preload process')
  const mainChain = require('./electron/main')(cfg, 'Main process')

  require('./electron/renderer')(rendererChain, cfg)

  return {
    renderer: await getWebpackConfig(rendererChain, cfg, {
      name: 'Renderer process',
      invokeParams: { isClient: true, isServer: false }
    }),
    preload: await getWebpackConfig(preloadChain, cfg, {
      name: 'Preload process',
      cfgExtendBase: cfg.electron,
      hookSuffix: 'PreloadElectronProcess',
      cmdSuffix: 'Preload',
      invokeParams: { isClient: false, isServer: true }
    }),
    main: await getWebpackConfig(mainChain, cfg, {
      name: 'Main process',
      cfgExtendBase: cfg.electron,
      hookSuffix: 'MainElectronProcess',
      cmdSuffix: 'Main',
      invokeParams: { isClient: false, isServer: true }
    })
  }
}

async function getSSR (cfg) {
  const client = createChain(cfg, 'Client')
  require('./ssr/client')(client, cfg)
  if (cfg.ctx.mode.pwa) {
    require('./pwa')(client, cfg) // extending a PWA
  }

  const server = createChain(cfg, 'Server')
  require('./ssr/server')(server, cfg)

  const webserver = require('./ssr/webserver')(cfg, 'Webserver')

  return {
    webserver: await getWebpackConfig(webserver, cfg, {
      name: 'Webserver',
      cfgExtendBase: cfg.ssr,
      hookSuffix: 'Webserver',
      cmdSuffix: 'Webserver',
      invokeParams: { isClient: false, isServer: true }
    }),

    client: await getWebpackConfig(client, cfg, {
      name: 'Client',
      invokeParams: { isClient: true, isServer: false }
    }),

    server: await getWebpackConfig(server, cfg, {
      name: 'Server',
      invokeParams: { isClient: false, isServer: true }
    })
  }
}

async function getBEX (cfg) {
  const rendererChain = createChain(cfg, 'Renderer process')
  const mainChain = createChain(cfg, 'Main process')

  require('./bex/renderer')(rendererChain, cfg) // before SPA so we can set some vars
  require('./spa')(rendererChain, cfg) // extending a SPA

  require('./bex/main')(mainChain, cfg)

  return {
    renderer: await getWebpackConfig(rendererChain, cfg, {
      name: 'Renderer process',
      invokeParams: { isClient: true, isServer: false }
    }),
    main: await getWebpackConfig(mainChain, cfg, {
      name: 'Main process',
      hookSuffix: 'MainBexProcess',
      invokeParams: { isClient: true, isServer: false }
    })
  }
}

module.exports = async function (cfg) {
  const mode = cfg.ctx.mode

  if (mode.ssr) {
    return await getSSR(cfg)
  }
  else if (mode.electron) {
    return await getElectron(cfg)
  }
  else if (mode.cordova) {
    return await getCordova(cfg)
  }
  else if (mode.capacitor) {
    return await getCapacitor(cfg)
  }
  else if (mode.pwa) {
    return await getPWA(cfg)
  }
  else if (mode.bex) {
    return await getBEX(cfg)
  }
  else {
    return await getSPA(cfg)
  }
}
