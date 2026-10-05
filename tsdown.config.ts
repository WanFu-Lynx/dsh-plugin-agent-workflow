import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { Plugin } from 'rolldown'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-plugin-agent-workflow'
const CSS_MODULE_PREFIX = '\0workflow-css-module:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

const cssModulePlugin: Plugin = {
  name: 'workflow-css-module-inline',
  resolveId(source, importer) {
    if (!source.endsWith('.module.css')) return null
    const path = importer === undefined ? source : resolve(dirname(importer), source)
    return `${CSS_MODULE_PREFIX}${path}${CSS_VIRTUAL_SUFFIX}`
  },
  async load(id) {
    if (!id.startsWith(CSS_MODULE_PREFIX)) return null
    const path = id.slice(CSS_MODULE_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(path)
    const source = await readFile(path)
    const { code, exports: cssExports } = transform({
      filename: path,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
    const tagId = `${PLUGIN_ID}/${basename(path)}`
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
      "  const tag = document.createElement('style');",
      `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

const nodeConfig: UserConfig = {
  name: PLUGIN_ID,
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

const clientConfig: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => CLIENT_EXTERNALS.includes(id as typeof CLIENT_EXTERNALS[number])
    ? undefined
    : true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssModulePlugin],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeConfig, clientConfig]
