import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = dirname(SERVER_DIR)

loadEnvFile(join(APP_DIR, '.env'))

const PORT = Number(process.env.OWNVIEW_SIGNAL_PORT ?? 8787)
const HOST = process.env.OWNVIEW_HOST ?? '127.0.0.1'
const PUBLIC_URL = process.env.OWNVIEW_PUBLIC_URL ?? `http://${HOST}:${PORT}`
const ALLOWED_ORIGIN = process.env.OWNVIEW_ALLOWED_ORIGIN ?? '*'
const AGENT_SHARED_KEY = process.env.OWNVIEW_AGENT_SHARED_KEY ?? ''
const MAX_AGENT_FRAME_BYTES = 2_500_000
const DIST_DIR = join(APP_DIR, 'dist')
const DATA_DIR = join(SERVER_DIR, 'data')
const AUDIT_LOG_PATH = join(DATA_DIR, 'audit-log.jsonl')
const sessions = new Map()
const clients = new Map()
const agents = new Map()
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function parseIceServers() {
  if (!process.env.OWNVIEW_ICE_SERVERS) {
    return [{ urls: 'stun:stun.l.google.com:19302' }]
  }

  try {
    const parsed = JSON.parse(process.env.OWNVIEW_ICE_SERVERS)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const iceServers = parseIceServers()

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-ownview-token',
  })
  res.end(JSON.stringify(body))
}

function sendPlain(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': ALLOWED_ORIGIN,
  })
  res.end(body)
}

async function serveStatic(url, res) {
  const pathname = decodeURIComponent(url.pathname)
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  const normalizedPath = normalize(relativePath)
  if (normalizedPath.startsWith('..')) {
    sendPlain(res, 403, 'forbidden')
    return true
  }

  let filePath = join(DIST_DIR, normalizedPath)
  try {
    const fileStat = await stat(filePath)
    if (fileStat.isDirectory()) {
      filePath = join(filePath, 'index.html')
    }
  } catch {
    filePath = join(DIST_DIR, 'index.html')
  }

  try {
    const content = await readFile(filePath)
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    })
    res.end(content)
    return true
  } catch {
    sendPlain(res, 404, 'not found')
    return true
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function makeDeviceId() {
  return `${Math.floor(100_000_000 + Math.random() * 900_000_000)}`
}

function makePassword() {
  return randomBytes(3).toString('hex').toUpperCase()
}

function formatDeviceIdForServer(deviceId) {
  return `${deviceId.slice(0, 3)} ${deviceId.slice(3, 6)} ${deviceId.slice(6)}`
}

function makeSessionToken() {
  return randomBytes(24).toString('base64url')
}

function makeTokenExpiry() {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString()
}

function publicSession(session) {
  return {
    deviceId: session.deviceId,
    password: session.password,
    status: session.status,
    partnerId: session.partnerId,
    pendingRole: session.pendingRole,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    tokenExpiresAt: session.tokenExpiresAt,
  }
}

function sessionResponse(session, extra = {}) {
  return {
    session: publicSession(session),
    token: session.token,
    ...extra,
  }
}

function publicAuditEntry(entry) {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    deviceId: entry.deviceId,
    partnerId: entry.partnerId,
    event: entry.event,
    status: entry.status,
    message: entry.message,
    metadata: entry.metadata,
  }
}

async function appendAudit(session, event, message, metadata = {}) {
  const entry = publicAuditEntry({
    id: randomBytes(8).toString('hex'),
    timestamp: new Date().toISOString(),
    deviceId: session.deviceId,
    partnerId: session.partnerId,
    event,
    status: session.status,
    message,
    metadata,
  })

  await mkdir(DATA_DIR, { recursive: true })
  await appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

async function readRecentAudit(deviceId, limit = 12) {
  try {
    const content = await readFile(AUDIT_LOG_PATH, 'utf8')
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => !deviceId || entry.deviceId === deviceId)
      .slice(-limit)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function getOrCreateSession(deviceId = makeDeviceId()) {
  const existing = sessions.get(deviceId)
  if (existing) return existing

  const now = new Date().toISOString()
  const session = {
    deviceId,
    password: makePassword(),
    status: 'ready',
    partnerId: '',
    pendingRole: '',
    token: makeSessionToken(),
    tokenExpiresAt: makeTokenExpiry(),
    createdAt: now,
    updatedAt: now,
    log: ['Session credentials created'],
  }
  sessions.set(deviceId, session)
  return session
}

function createSession() {
  let deviceId = makeDeviceId()
  while (sessions.has(deviceId)) {
    deviceId = makeDeviceId()
  }

  return getOrCreateSession(deviceId)
}

function getExistingSession(deviceId) {
  return sessions.get(deviceId)
}

function requireExistingSession(res, deviceId) {
  const session = getExistingSession(deviceId)
  if (session) return session

  json(res, 404, { error: 'session not found' })
  return undefined
}

function tokenFromRequest(req, url) {
  return req.headers['x-ownview-token'] ?? url.searchParams.get('token') ?? ''
}

function isAuthorized(req, url, session) {
  const token = tokenFromRequest(req, url)
  return Boolean(token && token === session.token && Date.parse(session.tokenExpiresAt) > Date.now())
}

function requireSessionAuth(req, res, url, session) {
  if (isAuthorized(req, url, session)) return true

  json(res, 401, { error: 'valid session token is required' })
  return false
}

async function updateSession(session, patch, logLine, event = 'session.updated', metadata = {}) {
  Object.assign(session, patch, { updatedAt: new Date().toISOString() })
  if (logLine) session.log.push(logLine)
  const auditEntry = await appendAudit(session, event, logLine ?? event, metadata)
  broadcast(session.deviceId, {
    type: 'session:update',
    session: publicSession(session),
    logLine,
    auditEntry,
  })
  return auditEntry
}

async function resetPeerSession(session, logLine, event, metadata = {}) {
  const peer = session.partnerId ? getExistingSession(session.partnerId) : undefined
  await updateSession(session, { status: 'ready', partnerId: '', pendingRole: '' }, logLine, event, metadata)
  notifyAgent(session.deviceId, { type: 'support.rejected' })

  if (peer) {
    await updateSession(peer, { status: 'ready', partnerId: '', pendingRole: '' }, logLine, event, metadata)
    notifyAgent(peer.deviceId, { type: 'support.rejected' })
  }
}

function broadcast(deviceId, payload) {
  const sessionClients = clients.get(deviceId)
  if (!sessionClients) return

  const message = JSON.stringify(payload)
  for (const socket of sessionClients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message)
    }
  }
}

function broadcastBinary(deviceId, payload) {
  const sessionClients = clients.get(deviceId)
  if (!sessionClients) return

  for (const socket of sessionClients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload, { binary: true })
    }
  }
}

function notifyAgent(deviceId, payload) {
  const agent = [...agents.values()].find((candidate) => candidate.deviceId === deviceId)
  if (agent?.socket.readyState === WebSocket.OPEN) {
    agent.socket.send(JSON.stringify(payload))
  }
}

function safeSignalType(type) {
  return ['offer', 'answer', 'ice-candidate'].includes(type) ? type : ''
}

function sanitizeAgentInput(input) {
  if (!input || typeof input !== 'object') return undefined
  const kind = String(input.kind ?? '')

  if (kind === 'mouse') {
    const action = String(input.action ?? '')
    if (!['move', 'down', 'up', 'wheel'].includes(action)) return undefined

    return {
      kind,
      action,
      x: clampNumber(input.x, 0, 1),
      y: clampNumber(input.y, 0, 1),
      button: String(input.button ?? 'left').slice(0, 12),
      deltaY: clampNumber(input.deltaY, -2000, 2000),
    }
  }

  if (kind === 'keyboard') {
    const action = String(input.action ?? '')
    const keyCode = Number(input.keyCode)
    if (!['down', 'up'].includes(action) || !Number.isInteger(keyCode) || keyCode < 1 || keyCode > 255) return undefined

    return {
      kind,
      action,
      keyCode,
      key: String(input.key ?? '').slice(0, 32),
    }
  }

  return undefined
}

function clampNumber(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}

function parseBinaryFrame(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (buffer.length < 5) return undefined

  const metadataLength = buffer.readUInt32LE(0)
  if (metadataLength < 2 || metadataLength > 64_000 || buffer.length < 4 + metadataLength + 2) return undefined

  const metadata = JSON.parse(buffer.subarray(4, 4 + metadataLength).toString('utf8'))
  const image = buffer.subarray(4 + metadataLength)
  if (image.length > MAX_AGENT_FRAME_BYTES || image[0] !== 0xff || image[1] !== 0xd8) return undefined

  return { metadata, image }
}

function buildBinaryFrame(metadata, image) {
  const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf8')
  const lengthBuffer = Buffer.allocUnsafe(4)
  lengthBuffer.writeUInt32LE(metadataBuffer.length, 0)
  return Buffer.concat([lengthBuffer, metadataBuffer, image])
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    json(res, 204, {})
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { ok: true, sessions: sessions.size, publicUrl: PUBLIC_URL })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      json(res, 200, {
        publicUrl: PUBLIC_URL,
        iceServers,
        secureContextRequired: true,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/agents') {
      json(res, 200, {
        agents: [...agents.values()].map((agent) => ({
          id: agent.id,
          deviceId: agent.deviceId,
          name: agent.name,
          connectedAt: agent.connectedAt,
          lastSeenAt: agent.lastSeenAt,
          lastFrameAt: agent.lastFrameAt,
          frameCount: agent.frameCount,
          requireVisibleApproval: agent.requireVisibleApproval,
          allowRemoteInput: agent.allowRemoteInput,
        })),
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const session = createSession()
      await appendAudit(session, 'session.created', 'Session credentials created')
      json(res, 201, sessionResponse(session, { log: session.log, audit: await readRecentAudit(session.deviceId) }))
      return
    }

    const auditMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/audit$/)
    if (req.method === 'GET' && auditMatch) {
      const session = requireExistingSession(res, auditMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      json(res, 200, { audit: await readRecentAudit(auditMatch[1]) })
      return
    }

    const waitMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/wait$/)
    if (req.method === 'POST' && waitMatch) {
      const session = requireExistingSession(res, waitMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      await updateSession(session, { status: 'waiting', partnerId: '', pendingRole: '' }, 'Device opened for assisted connection', 'session.waiting')
      json(res, 200, sessionResponse(session, { log: session.log, audit: await readRecentAudit(session.deviceId) }))
      return
    }

    const refreshMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/refresh$/)
    if (req.method === 'POST' && refreshMatch) {
      const oldId = refreshMatch[1]
      const oldSession = requireExistingSession(res, oldId)
      if (!oldSession) return
      if (!requireSessionAuth(req, res, url, oldSession)) return
      sessions.delete(oldId)
      const session = createSession()
      await updateSession(session, { status: 'ready' }, 'Session credentials refreshed', 'credentials.refreshed', { previousDeviceId: oldId })
      json(res, 200, sessionResponse(session, { log: session.log, audit: await readRecentAudit(session.deviceId) }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/connect') {
      json(res, 410, { error: 'legacy unauthenticated connect endpoint is disabled' })
      return
    }

    const connectMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/connect$/)
    if (req.method === 'POST' && connectMatch) {
      const body = await readBody(req)
      const partnerId = String(body.partnerId ?? '').replace(/\D/g, '')
      if (!partnerId) {
        json(res, 400, { error: 'partnerId is required' })
        return
      }

      const session = requireExistingSession(res, connectMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      if (partnerId === session.deviceId) {
        json(res, 400, { error: 'cannot connect to the same session' })
        return
      }

      const partner = getExistingSession(partnerId)
      if (!partner) {
        json(res, 404, { error: 'partner session not found' })
        return
      }

      if (!['ready', 'waiting'].includes(partner.status)) {
        json(res, 409, { error: 'partner is not available', session: publicSession(partner) })
        return
      }

      await updateSession(session, { status: 'pending', partnerId, pendingRole: 'requester' }, `Waiting for partner ${partnerId} approval`, 'consent.requested.outbound')
      await updateSession(partner, { status: 'pending', partnerId: session.deviceId, pendingRole: 'approver' }, `Control request received from ${session.deviceId}`, 'consent.requested.inbound')
      const partnerAgent = [...agents.values()].find((agent) => agent.deviceId === partner.deviceId)
      if (partnerAgent?.socket.readyState === WebSocket.OPEN) {
        partnerAgent.socket.send(JSON.stringify({
          type: 'support.request',
          requesterId: session.deviceId,
          requesterLabel: formatDeviceIdForServer(session.deviceId),
        }))
      }
      json(res, 200, sessionResponse(session, { log: session.log, audit: await readRecentAudit(session.deviceId) }))
      return
    }

    const approveMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/approve$/)
    if (req.method === 'POST' && approveMatch) {
      const session = requireExistingSession(res, approveMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      if (session.status !== 'pending') {
        json(res, 409, { error: 'session is not awaiting approval', session: publicSession(session) })
        return
      }

      if (session.pendingRole !== 'approver') {
        json(res, 409, { error: 'only the receiving device can approve this request', session: publicSession(session) })
        return
      }

      const requester = session.partnerId ? getExistingSession(session.partnerId) : undefined
      await updateSession(session, { status: 'connected', pendingRole: '' }, `Control approved for partner ${session.partnerId}`, 'consent.approved')
      if (requester) {
        await updateSession(requester, { status: 'connected', pendingRole: '' }, `Partner ${session.deviceId} approved control`, 'consent.approved.remote')
      }
      json(res, 200, sessionResponse(session, { log: session.log, audit: await readRecentAudit(session.deviceId) }))
      return
    }

    const rejectMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/reject$/)
    if (req.method === 'POST' && rejectMatch) {
      const session = requireExistingSession(res, rejectMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      const rejectedPartner = session.partnerId
      await resetPeerSession(session, `Control rejected for partner ${rejectedPartner || 'unknown'}`, 'consent.rejected', { rejectedPartner })
      json(res, 200, sessionResponse(session, { log: session.log, audit: await readRecentAudit(session.deviceId) }))
      return
    }

    const endMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/end$/)
    if (req.method === 'POST' && endMatch) {
      const session = requireExistingSession(res, endMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      await resetPeerSession(session, 'Session ended and access revoked', 'session.ended')
      json(res, 200, sessionResponse(session, { log: session.log, audit: await readRecentAudit(session.deviceId) }))
      return
    }

    const messageMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/messages$/)
    if (req.method === 'POST' && messageMatch) {
      const body = await readBody(req)
      const text = String(body.text ?? '').trim()
      if (!text) {
        json(res, 400, { error: 'text is required' })
        return
      }

      const session = requireExistingSession(res, messageMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      session.log.push(`Chat: ${text}`)
      const auditEntry = await appendAudit(session, 'chat.sent', 'Chat message sent', { length: text.length })
      broadcast(session.deviceId, { type: 'chat', text })
      broadcast(session.deviceId, { type: 'audit', auditEntry })

      const peer = session.partnerId ? getExistingSession(session.partnerId) : undefined
      if (peer) {
        peer.log.push(`Chat from ${session.deviceId}: ${text}`)
        const peerAuditEntry = await appendAudit(peer, 'chat.received', `Chat message received from ${session.deviceId}`, {
          length: text.length,
          senderId: session.deviceId,
        })
        broadcast(peer.deviceId, { type: 'chat', text })
        broadcast(peer.deviceId, { type: 'audit', auditEntry: peerAuditEntry })
      }

      json(res, 201, { ok: true, auditEntry })
      return
    }

    const agentInputMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/agent-input$/)
    if (req.method === 'POST' && agentInputMatch) {
      const body = await readBody(req)
      const input = sanitizeAgentInput(body.input)
      if (!input) {
        json(res, 400, { error: 'valid input payload is required' })
        return
      }

      const session = requireExistingSession(res, agentInputMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      if (session.status !== 'connected' || !session.partnerId) {
        json(res, 409, { error: 'remote input requires a connected native agent session' })
        return
      }

      const agent = [...agents.values()].find((candidate) => candidate.deviceId === session.partnerId)
      if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
        json(res, 409, { error: 'connected partner is not a native Windows agent' })
        return
      }

      if (!agent.allowRemoteInput) {
        json(res, 403, { error: 'remote input is disabled on the Windows agent' })
        return
      }

      agent.socket.send(JSON.stringify({
        type: 'agent.input',
        requesterId: session.deviceId,
        input,
      }))
      json(res, 202, { ok: true })
      return
    }

    const webRtcMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/webrtc$/)
    if (req.method === 'POST' && webRtcMatch) {
      const body = await readBody(req)
      const signalType = safeSignalType(String(body.type ?? ''))
      if (!signalType) {
        json(res, 400, { error: 'type must be offer, answer, or ice-candidate' })
        return
      }

      const session = requireExistingSession(res, webRtcMatch[1])
      if (!session) return
      if (!requireSessionAuth(req, res, url, session)) return
      if (session.status !== 'connected' || !session.partnerId) {
        json(res, 409, { error: 'WebRTC signaling requires a connected peer session' })
        return
      }

      const peer = getExistingSession(session.partnerId)
      if (!peer || peer.status !== 'connected') {
        json(res, 409, { error: 'connected peer is not available' })
        return
      }

      const payload = typeof body.payload === 'object' && body.payload !== null ? body.payload : {}
      const auditEntry = await appendAudit(session, `webrtc.${signalType}.sent`, `WebRTC ${signalType} relayed`, {
        recipientId: peer.deviceId,
        payloadKeys: Object.keys(payload),
      })
      const peerAuditEntry = await appendAudit(peer, `webrtc.${signalType}.received`, `WebRTC ${signalType} received`, {
        senderId: session.deviceId,
        payloadKeys: Object.keys(payload),
      })

      broadcast(peer.deviceId, {
        type: 'webrtc',
        signal: {
          type: signalType,
          from: session.deviceId,
          payload,
        },
        auditEntry: peerAuditEntry,
      })
      broadcast(session.deviceId, { type: 'audit', auditEntry })
      json(res, 202, { ok: true, auditEntry })
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(url, res)
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : 'server error' })
  }
})

const wss = new WebSocketServer({ noServer: true })
const agentWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const target = url.pathname === '/ws' ? wss : url.pathname === '/agent' ? agentWss : undefined

  if (!target) {
    socket.destroy()
    return
  }

  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit('connection', ws, req)
  })
})

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const deviceId = String(url.searchParams.get('deviceId') ?? '').replace(/\D/g, '')
  const token = String(url.searchParams.get('token') ?? '')
  if (!deviceId) {
    socket.close(1008, 'deviceId is required')
    return
  }

  const session = getExistingSession(deviceId)
  if (!session) {
    socket.close(1008, 'session not found')
    return
  }

  if (!(token && token === session.token && Date.parse(session.tokenExpiresAt) > Date.now())) {
    socket.close(1008, 'valid session token is required')
    return
  }

  const sessionClients = clients.get(deviceId) ?? new Set()
  sessionClients.add(socket)
  clients.set(deviceId, sessionClients)

  socket.send(JSON.stringify({
    type: 'session:update',
    session: publicSession(session),
    logLine: 'Realtime channel connected',
  }))

  socket.on('close', () => {
    sessionClients.delete(socket)
    if (sessionClients.size === 0) clients.delete(deviceId)
  })
})

agentWss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (AGENT_SHARED_KEY && url.searchParams.get('agentKey') !== AGENT_SHARED_KEY) {
    socket.close(1008, 'agent authentication failed')
    return
  }

  const agentId = randomBytes(8).toString('hex')
  const fallbackName = String(url.searchParams.get('name') ?? 'Windows Agent').slice(0, 80)
  const now = new Date().toISOString()
  const session = createSession()
  session.status = 'waiting'
  session.log.push('Native Windows agent connected')

  const agent = {
    id: agentId,
    deviceId: session.deviceId,
    name: fallbackName,
    connectedAt: now,
    lastSeenAt: now,
    lastFrameAt: '',
    frameCount: 0,
    requireVisibleApproval: true,
    allowRemoteInput: false,
    socket,
  }
  agents.set(agentId, agent)

  socket.send(JSON.stringify({
    type: 'agent.registered',
    id: agentId,
    deviceId: session.deviceId,
    deviceLabel: formatDeviceIdForServer(session.deviceId),
    publicUrl: PUBLIC_URL,
  }))

  socket.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        agent.lastSeenAt = new Date().toISOString()
        const agentSession = getExistingSession(agent.deviceId)
        if (!agentSession || agentSession.status !== 'connected' || !agentSession.partnerId) return

        const frame = parseBinaryFrame(data)
        if (!frame || frame.metadata?.type !== 'agent.screen.frame') return

        agent.lastFrameAt = new Date().toISOString()
        agent.frameCount += 1
        broadcastBinary(agentSession.partnerId, buildBinaryFrame({
          type: 'agent:screen-frame',
          from: agent.deviceId,
          width: Number(frame.metadata.width) || 0,
          height: Number(frame.metadata.height) || 0,
          virtualScreen: typeof frame.metadata.virtualScreen === 'object' && frame.metadata.virtualScreen !== null ? frame.metadata.virtualScreen : undefined,
          monitors: Array.isArray(frame.metadata.monitors) ? frame.metadata.monitors : [],
          capturedAt: String(frame.metadata.capturedAt ?? new Date().toISOString()),
          encoding: 'jpeg',
        }, frame.image))
        return
      }

      const message = JSON.parse(String(data))
      agent.lastSeenAt = new Date().toISOString()

      if (message.type === 'agent.hello') {
        agent.name = String(message.name ?? fallbackName).slice(0, 80)
        agent.requireVisibleApproval = Boolean(message.requireVisibleApproval)
        agent.allowRemoteInput = Boolean(message.allowRemoteInput)
      }

      if (message.type === 'agent.approve') {
        const agentSession = getExistingSession(agent.deviceId)
        if (!agentSession || agentSession.status !== 'pending' || agentSession.pendingRole !== 'approver') return

        const requester = agentSession.partnerId ? getExistingSession(agentSession.partnerId) : undefined
        await updateSession(agentSession, { status: 'connected', pendingRole: '' }, `Native agent approved partner ${agentSession.partnerId}`, 'agent.consent.approved')
        if (requester) {
          await updateSession(requester, { status: 'connected', pendingRole: '' }, `Agent ${agentSession.deviceId} approved control`, 'agent.consent.approved.remote')
        }
        socket.send(JSON.stringify({ type: 'support.approved', requesterId: agentSession.partnerId }))
      }

      if (message.type === 'agent.reject') {
        const agentSession = getExistingSession(agent.deviceId)
        if (!agentSession) return

        const rejectedPartner = agentSession.partnerId
        await resetPeerSession(agentSession, `Native agent rejected partner ${rejectedPartner || 'unknown'}`, 'agent.consent.rejected', { rejectedPartner })
        socket.send(JSON.stringify({ type: 'support.rejected', requesterId: rejectedPartner }))
      }

      if (message.type === 'agent.screen.frame') {
        const agentSession = getExistingSession(agent.deviceId)
        if (!agentSession || agentSession.status !== 'connected' || !agentSession.partnerId) return

        const image = typeof message.image === 'string' ? message.image : ''
        if (!image.startsWith('data:image/jpeg;base64,') || image.length > MAX_AGENT_FRAME_BYTES) return

        agent.lastFrameAt = new Date().toISOString()
        agent.frameCount += 1
        broadcast(agentSession.partnerId, {
          type: 'agent:screen-frame',
          from: agent.deviceId,
          image,
          width: Number(message.width) || 0,
          height: Number(message.height) || 0,
          virtualScreen: typeof message.virtualScreen === 'object' && message.virtualScreen !== null ? message.virtualScreen : undefined,
          monitors: Array.isArray(message.monitors) ? message.monitors : [],
          capturedAt: String(message.capturedAt ?? new Date().toISOString()),
        })
      }
    } catch {
      socket.send(JSON.stringify({ type: 'agent.error', error: 'invalid message' }))
    }
  })

  socket.on('close', async () => {
    agents.delete(agentId)
    const agentSession = getExistingSession(agent.deviceId)
    if (agentSession) {
      await resetPeerSession(agentSession, 'Native agent disconnected', 'agent.disconnected')
      sessions.delete(agent.deviceId)
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`OwnView server listening on http://${HOST}:${PORT}`)
  console.log(`Configured public URL: ${PUBLIC_URL}`)
})
