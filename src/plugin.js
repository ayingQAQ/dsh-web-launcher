import { desktopStatus, removeDesktopSetup, setup } from './index.js'

export const name = 'dsh-web-launcher'

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && url.host === host
  } catch {
    return false
  }
}

function authorize(host, request, response) {
  // Desktop management is local-only even when DSH itself binds to the LAN.
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress)) {
    sendJson(response, 403, { ok: false, error: 'desktop management is local-only' })
    return false
  }
  const connection = host.connection
  if (typeof connection.admit === 'function') {
    const admission = connection.admit(request)
    if (admission && !('rejection' in admission) && admission.peer) return true
    sendJson(response, admission?.rejection || 403, { ok: false, error: 'DSH authentication required' })
    return false
  }
  // Old releases have no admission API; do not fall back to unauthenticated
  // management on an unknown future Connection implementation.
  sendJson(response, 503, { ok: false, error: '当前 DSH 不支持安全管理接口，请使用启动器 CLI 管理快捷方式' })
  return false
}

function methodOnly(request, response, method) {
  if (request.method === method) return true
  response.writeHead(405, { allow: method })
  response.end()
  return false
}

async function handleAction(response, action) {
  try {
    const result = await action()
    sendJson(response, 200, { ok: true, status: result })
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function mountRoutes(host) {
  return [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-web-launcher/status',
      handler: async (request, response) => {
        if (!methodOnly(request, response, 'GET')) return
        if (!authorize(host, request, response)) return
        await handleAction(response, async () => ({ ...await desktopStatus(), instanceId: String(process.pid) }))
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-web-launcher/setup',
      handler: async (request, response) => {
        if (!methodOnly(request, response, 'POST')) return
        if (!authorize(host, request, response)) return
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        await handleAction(response, async () => {
          await setup({ quiet: true })
          return desktopStatus()
        })
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-web-launcher/remove',
      handler: async (request, response) => {
        if (!methodOnly(request, response, 'POST')) return
        if (!authorize(host, request, response)) return
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        await handleAction(response, removeDesktopSetup)
      },
    }),
  ]
}

export function apply(ctx, config) {
  if (process.platform !== 'win32') return

  if (config?.autoSetup !== false) {
    setup({ quiet: true }).catch((error) => {
      ctx.logger?.warn(`[dsh-web-launcher] desktop setup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  ctx.inject(['webServer', 'connection'], (host) => {
    host.effect(() => {
      const disposers = mountRoutes(host)
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-web-launcher: management routes')
  })
}
