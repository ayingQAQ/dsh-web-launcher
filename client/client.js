window.__ModuleLoader__.load({ id: 'dsh-web-launcher', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const h = React.createElement
  const NS = 'dsh-web-launcher'

  const zh = {
    title: 'DSH 一键启动器',
    description: '桌面快捷方式由当前 DSH 插件自动同步。',
    ready: '快捷方式已就绪',
    missing: '快捷方式尚未创建',
    loading: '正在检查…',
    setup: '重新创建',
    remove: '移除快捷方式',
    working: '正在处理…',
    failed: '操作失败',
  }
  const en = {
    title: 'DSH Web Launcher',
    description: 'The desktop shortcut is synchronized by this DSH plugin.',
    ready: 'Desktop shortcut is ready',
    missing: 'Desktop shortcut is not installed',
    loading: 'Checking…',
    setup: 'Recreate',
    remove: 'Remove shortcut',
    working: 'Working…',
    failed: 'Action failed',
  }

  async function request(path, method = 'GET') {
    const response = await fetch(path, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    })
    const payload = await response.json()
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`)
    return payload.status
  }

  function LauncherRow({ t }) {
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)

    const load = React.useCallback(async () => {
      try {
        setStatus(await request('/dsh-web-launcher/status'))
        setError(null)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }, [])

    React.useEffect(() => { load() }, [load])

    const act = React.useCallback(async (path) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        setStatus(await request(path, 'POST'))
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    }, [busy])

    const installed = status?.shortcut === true && status?.runtime === true
    const button = {
      border: '1px solid var(--dsw-alias-line-border, #d0d7de)',
      borderRadius: 8,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, #1f2328)',
      cursor: busy ? 'default' : 'pointer',
      font: 'inherit',
      padding: '6px 10px',
    }

    return h('section', {
      style: {
        display: 'flex', alignItems: 'center', gap: 16, minHeight: 72,
        borderBottom: '1px solid var(--dsw-alias-line-border, #d8dee4)', padding: '12px 0',
      },
    },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 500 } }, t('title')),
      h('div', { style: { marginTop: 3, fontSize: 12, opacity: 0.7 } }, t('description')),
      h('div', {
        style: { marginTop: 4, fontSize: 12, color: error ? '#c23737' : installed ? '#238636' : undefined },
        role: error ? 'alert' : 'status',
      }, error ? `${t('failed')}: ${error}` : status === null ? t('loading') : installed ? t('ready') : t('missing')),
    ),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } },
      h('button', { type: 'button', disabled: busy, style: button, onClick: () => act('/dsh-web-launcher/setup') }, busy ? t('working') : t('setup')),
      installed ? h('button', { type: 'button', disabled: busy, style: button, onClick: () => act('/dsh-web-launcher/remove') }, t('remove')) : null,
    ))
  }

  exports.inject = ['slots', 'locale']
  exports.apply = (ctx) => {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-launcher: dictionaries')
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'dsh-web-launcher',
      order: 40,
      locale: NS,
    }, LauncherRow))
  }

  return module.exports
}})
