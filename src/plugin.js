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
    return new URL(origin).host === host
  } catch {
    return false
  }
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
        await handleAction(response, desktopStatus)
      },
    }),
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-web-launcher/setup',
      handler: async (request, response) => {
        if (!methodOnly(request, response, 'POST')) return
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

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = mountRoutes(host)
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-web-launcher: management routes')
  })
}
