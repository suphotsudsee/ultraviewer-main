import {
  CheckCircle2,
  Clipboard,
  CloudUpload,
  Network,
  KeyRound,
  Lock,
  Maximize2,
  Minimize2,
  MessageSquareText,
  MonitorUp,
  PhoneOff,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Signal,
  XCircle,
  UserRoundCheck,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import './App.css'

type SessionState = 'ready' | 'waiting' | 'pending' | 'connected'

interface SessionSnapshot {
  deviceId: string
  password: string
  status: SessionState
  partnerId: string
  pendingRole: '' | 'requester' | 'approver'
  createdAt: string
  updatedAt: string
  tokenExpiresAt: string
}

interface SessionResponse {
  session: SessionSnapshot
  token?: string
  log?: string[]
  audit?: AuditEntry[]
}

interface AuditEntry {
  id: string
  timestamp: string
  deviceId: string
  partnerId: string
  event: string
  status: SessionState
  message: string
  metadata?: Record<string, unknown>
}

interface PublicConfig {
  publicUrl: string
  iceServers: RTCIceServer[]
  secureContextRequired: boolean
}

interface AgentInfo {
  id: string
  deviceId: string
  name: string
  connectedAt: string
  lastSeenAt: string
  lastFrameAt: string
  frameCount: number
  requireVisibleApproval: boolean
  allowRemoteInput: boolean
}

type RealtimeMessage =
  | { type: 'session:update'; session: SessionSnapshot; logLine?: string; auditEntry?: AuditEntry }
  | { type: 'chat'; text: string }
  | { type: 'audit'; auditEntry: AuditEntry }
  | { type: 'webrtc'; signal: WebRtcSignal; auditEntry?: AuditEntry }
  | {
    type: 'agent:screen-frame'
    from: string
    image: string
    width: number
    height: number
    capturedAt: string
    virtualScreen?: ScreenBounds
    monitors?: ScreenMonitor[]
  }

interface ScreenBounds {
  x: number
  y: number
  width: number
  height: number
}

interface ScreenMonitor extends ScreenBounds {
  id: string
  name: string
  primary: boolean
}

interface ScreenFrameMeta {
  virtualScreen: ScreenBounds
  monitors: ScreenMonitor[]
}

interface WebRtcSignal {
  type: WebRtcSignalType
  from: string
  payload: WebRtcPayload
}

type WebRtcSignalType = 'offer' | 'answer' | 'ice-candidate'

type WebRtcPayload = RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, unknown>

type AgentInput =
  | { kind: 'mouse'; action: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: string; deltaY?: number }
  | { kind: 'keyboard'; action: 'down' | 'up'; keyCode: number; key: string }

const fallbackSession: SessionSnapshot = {
  deviceId: '000000000',
  password: 'LOCAL',
  status: 'ready',
  partnerId: '',
  pendingRole: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tokenExpiresAt: new Date().toISOString(),
}

async function postJson<T>(url: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-ownview-token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, {
    headers: token ? { 'x-ownview-token': token } : undefined,
  })

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
}

function formatDeviceId(deviceId: string) {
  return `${deviceId.slice(0, 3)} ${deviceId.slice(3, 6)} ${deviceId.slice(6)}`
}

function App() {
  const [session, setSession] = useState<SessionSnapshot>(fallbackSession)
  const [partnerId, setPartnerId] = useState('')
  const [chatText, setChatText] = useState('')
  const [serverOnline, setServerOnline] = useState(false)
  const [sessionToken, setSessionToken] = useState('')
  const [publicConfig, setPublicConfig] = useState<PublicConfig>({
    publicUrl: window.location.origin,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    secureContextRequired: true,
  })
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [signalLog, setSignalLog] = useState<string[]>([])
  const [rtcState, setRtcState] = useState('idle')
  const [dataText, setDataText] = useState('')
  const [dataMessages, setDataMessages] = useState<string[]>([])
  const [isSharingScreen, setIsSharingScreen] = useState(false)
  const [hasRemoteScreen, setHasRemoteScreen] = useState(false)
  const [agentScreenFrame, setAgentScreenFrame] = useState('')
  const [isRemoteFullscreen, setIsRemoteFullscreen] = useState(false)
  const [screenFrameMeta, setScreenFrameMeta] = useState<ScreenFrameMeta>({
    virtualScreen: { x: 0, y: 0, width: 1, height: 1 },
    monitors: [],
  })
  const [selectedMonitorId, setSelectedMonitorId] = useState('all')
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const localScreenStreamRef = useRef<MediaStream | null>(null)
  const remoteScreenStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteScreenRef = useRef<HTMLDivElement | null>(null)
  const [messages, setMessages] = useState<string[]>([
    'System ready. Every support session requires visible user consent.',
    'Share your ID and password only with a trusted support operator.',
  ])

  const appendMessage = useCallback((message: string) => {
    setMessages((current) => [...current.slice(-7), message])
  }, [])

  const applySessionResponse = useCallback((response: SessionResponse) => {
    setSession(response.session)
    if (response.token) {
      setSessionToken(response.token)
    }
    if (response.log?.length) {
      setMessages(response.log.slice(-6))
    }
    if (response.audit) {
      setAuditEntries(response.audit)
    }
  }, [])

  const appendAudit = useCallback((entry: AuditEntry) => {
    setAuditEntries((current) => [...current.filter((item) => item.id !== entry.id), entry].slice(-8))
  }, [])

  const appendSignal = useCallback((message: string) => {
    setSignalLog((current) => [...current.slice(-5), message])
  }, [])

  const appendDataMessage = useCallback((message: string) => {
    setDataMessages((current) => [...current.slice(-5), message])
  }, [])

  const selectedMonitor = useMemo(() => {
    if (selectedMonitorId === 'all') return undefined
    return screenFrameMeta.monitors.find((monitor) => monitor.id === selectedMonitorId)
  }, [screenFrameMeta.monitors, selectedMonitorId])

  const sendAgentInput = useCallback(async (input: AgentInput) => {
    if (session.status !== 'connected' || !agentScreenFrame) return

    try {
      await postJson(`/api/sessions/${session.deviceId}/agent-input`, { input }, sessionToken)
    } catch {
      appendSignal('remote input was rejected by the agent or server')
    }
  }, [agentScreenFrame, appendSignal, session.deviceId, session.status, sessionToken])

  const pointerInputFromEvent = useCallback((
    event: MouseEvent<HTMLElement> | WheelEvent<HTMLElement>,
    action: 'move' | 'down' | 'up' | 'wheel',
  ): AgentInput => {
    const rect = event.currentTarget.getBoundingClientRect()
    const localX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const localY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    const virtual = screenFrameMeta.virtualScreen
    const x = selectedMonitor
      ? (selectedMonitor.x - virtual.x + (localX * selectedMonitor.width)) / virtual.width
      : localX
    const y = selectedMonitor
      ? (selectedMonitor.y - virtual.y + (localY * selectedMonitor.height)) / virtual.height
      : localY
    const buttons = ['left', 'middle', 'right']
    return {
      kind: 'mouse',
      action,
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      button: buttons[event.button] ?? 'left',
      deltaY: action === 'wheel' ? Number((event as WheelEvent<HTMLElement>).deltaY) : 0,
    }
  }, [screenFrameMeta.virtualScreen, selectedMonitor])

  const keyCodeFromEvent = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key.length === 1) return event.key.toUpperCase().charCodeAt(0)

    const keyMap: Record<string, number> = {
      Backspace: 0x08,
      Tab: 0x09,
      Enter: 0x0d,
      Shift: 0x10,
      Control: 0x11,
      Alt: 0x12,
      Escape: 0x1b,
      Space: 0x20,
      PageUp: 0x21,
      PageDown: 0x22,
      End: 0x23,
      Home: 0x24,
      ArrowLeft: 0x25,
      ArrowUp: 0x26,
      ArrowRight: 0x27,
      ArrowDown: 0x28,
      Delete: 0x2e,
    }
    return keyMap[event.key] ?? 0
  }, [])

  const relayWebRtcSignal = useCallback(async (type: WebRtcSignalType, payload: WebRtcPayload) => {
    await postJson(`/api/sessions/${session.deviceId}/webrtc`, { type, payload }, sessionToken)
    appendSignal(`sent ${type} to ${formatDeviceId(session.partnerId)}`)
  }, [appendSignal, session.deviceId, session.partnerId, sessionToken])

  const attachDataChannel = useCallback((channel: RTCDataChannel) => {
    dataChannelRef.current = channel
    setRtcState(`data channel ${channel.readyState}`)

    channel.onopen = () => {
      setRtcState('data channel open')
      appendSignal('RTC data channel open')
    }
    channel.onclose = () => {
      setRtcState('data channel closed')
      appendSignal('RTC data channel closed')
    }
    channel.onerror = () => {
      setRtcState('data channel error')
      appendSignal('RTC data channel error')
    }
    channel.onmessage = (event) => {
      appendDataMessage(`Peer: ${String(event.data)}`)
    }
  }, [appendDataMessage, appendSignal])

  const createPeerConnection = useCallback(() => {
    peerConnectionRef.current?.close()

    const peerConnection = new RTCPeerConnection({
      iceServers: publicConfig.iceServers,
    })

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        void relayWebRtcSignal('ice-candidate', event.candidate.toJSON())
      }
    }
    peerConnection.onconnectionstatechange = () => {
      setRtcState(peerConnection.connectionState)
      appendSignal(`RTC ${peerConnection.connectionState}`)
      if (peerConnection.connectionState === 'failed' && session.status === 'connected') {
        void peerConnection.createOffer({ iceRestart: true })
          .then(async (offer) => {
            await peerConnection.setLocalDescription(offer)
            await relayWebRtcSignal('offer', offer)
            appendSignal('RTC ICE restart sent')
          })
          .catch(() => appendSignal('RTC ICE restart failed'))
      }
    }
    peerConnection.ondatachannel = (event) => {
      appendSignal('received RTC data channel')
      attachDataChannel(event.channel)
    }
    peerConnection.ontrack = (event) => {
      const [stream] = event.streams
      if (!stream) return

      remoteScreenStreamRef.current = stream
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream
      }
      setHasRemoteScreen(true)
      appendSignal('received remote screen track')
    }

    peerConnectionRef.current = peerConnection
    setRtcState('peer created')
    return peerConnection
  }, [appendSignal, attachDataChannel, publicConfig.iceServers, relayWebRtcSignal, session.status])

  const handleWebRtcSignal = useCallback(async (signal: WebRtcSignal) => {
    if (signal.type === 'offer') {
      const peerConnection = createPeerConnection()
      await peerConnection.setRemoteDescription(signal.payload as RTCSessionDescriptionInit)
      const answer = await peerConnection.createAnswer()
      await peerConnection.setLocalDescription(answer)
      await relayWebRtcSignal('answer', answer)
      appendSignal(`answered offer from ${formatDeviceId(signal.from)}`)
      return
    }

    if (signal.type === 'answer') {
      const peerConnection = peerConnectionRef.current
      if (!peerConnection) {
        appendSignal('received answer without peer connection')
        return
      }

      await peerConnection.setRemoteDescription(signal.payload as RTCSessionDescriptionInit)
      appendSignal(`applied answer from ${formatDeviceId(signal.from)}`)
      return
    }

    if (signal.type === 'ice-candidate') {
      const peerConnection = peerConnectionRef.current
      if (!peerConnection) {
        appendSignal('received ICE before peer connection')
        return
      }

      await peerConnection.addIceCandidate(signal.payload as RTCIceCandidateInit)
      appendSignal(`added ICE from ${formatDeviceId(signal.from)}`)
    }
  }, [appendSignal, createPeerConnection, relayWebRtcSignal])

  useEffect(() => {
    let cancelled = false

    async function createSession() {
      try {
        const response = await postJson<SessionResponse>('/api/sessions')
        if (cancelled) return
        setServerOnline(true)
        applySessionResponse(response)
      } catch {
        if (cancelled) return
        setServerOnline(false)
        appendMessage('Local UI mode: signaling server is not reachable.')
      }
    }

    createSession()

    return () => {
      cancelled = true
    }
  }, [appendMessage, applySessionResponse])

  useEffect(() => {
    let cancelled = false

    async function loadConfig() {
      try {
        const config = await getJson<PublicConfig>('/api/config')
        if (!cancelled) setPublicConfig(config)
      } catch {
        if (!cancelled) appendMessage('Using default WebRTC network config.')
      }
    }

    loadConfig()

    return () => {
      cancelled = true
    }
  }, [appendMessage])

  useEffect(() => {
    let cancelled = false

    async function loadAgents() {
      try {
        const response = await getJson<{ agents: AgentInfo[] }>('/api/agents')
        if (!cancelled) setAgents(response.agents)
      } catch {
        if (!cancelled) setAgents([])
      }
    }

    loadAgents()
    const timer = window.setInterval(loadAgents, 5000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!serverOnline || !sessionToken || session.deviceId === fallbackSession.deviceId) return

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/ws?deviceId=${session.deviceId}&token=${encodeURIComponent(sessionToken)}`,
    )

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as RealtimeMessage
      if (message.type === 'session:update') {
        setSession(message.session)
        if (message.logLine) appendMessage(message.logLine)
        if (message.auditEntry) appendAudit(message.auditEntry)
        return
      }

      if (message.type === 'audit') {
        appendAudit(message.auditEntry)
        return
      }

      if (message.type === 'webrtc') {
        appendSignal(`received ${message.signal.type} from ${formatDeviceId(message.signal.from)}`)
        if (message.auditEntry) appendAudit(message.auditEntry)
        void handleWebRtcSignal(message.signal).catch(() => {
          appendSignal(`failed to apply ${message.signal.type}`)
        })
        return
      }

      if (message.type === 'agent:screen-frame') {
        setAgentScreenFrame(message.image)
        const virtualScreen = message.virtualScreen ?? { x: 0, y: 0, width: message.width || 1, height: message.height || 1 }
        const monitors = message.monitors ?? []
        setScreenFrameMeta({ virtualScreen, monitors })
        setSelectedMonitorId((current) => (
          current === 'all' || monitors.some((monitor) => monitor.id === current) ? current : 'all'
        ))
        return
      }

      appendMessage(`Chat: ${message.text}`)
    }

    socket.onerror = () => {
      setServerOnline(false)
      appendMessage('Realtime channel disconnected.')
    }

    return () => {
      socket.close()
    }
  }, [appendAudit, appendMessage, appendSignal, handleWebRtcSignal, serverOnline, session.deviceId, sessionToken])

  useEffect(() => {
    if (session.status !== 'connected') {
      peerConnectionRef.current?.close()
      peerConnectionRef.current = null
      dataChannelRef.current = null
      localScreenStreamRef.current?.getTracks().forEach((track) => track.stop())
      localScreenStreamRef.current = null
      remoteScreenStreamRef.current = null
      if (localVideoRef.current) localVideoRef.current.srcObject = null
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
      setRtcState('idle')
      setIsSharingScreen(false)
      setHasRemoteScreen(false)
      setAgentScreenFrame('')
      setSelectedMonitorId('all')
      setDataMessages([])
      setSignalLog([])
    }
  }, [session.status])

  useEffect(() => {
    if (remoteVideoRef.current && remoteScreenStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteScreenStreamRef.current
    }
  }, [hasRemoteScreen])

  useEffect(() => {
    if (localVideoRef.current && localScreenStreamRef.current) {
      localVideoRef.current.srcObject = localScreenStreamRef.current
    }
  }, [isSharingScreen])

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsRemoteFullscreen(document.fullscreenElement === remoteScreenRef.current)
    }

    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    if (!serverOnline || !sessionToken || session.deviceId === fallbackSession.deviceId) return

    let cancelled = false

    async function loadAudit() {
      try {
        const response = await getJson<{ audit: AuditEntry[] }>(`/api/sessions/${session.deviceId}/audit`, sessionToken)
        if (!cancelled) setAuditEntries(response.audit)
      } catch {
        if (!cancelled) appendMessage('Audit log is not reachable.')
      }
    }

    loadAudit()

    return () => {
      cancelled = true
    }
  }, [appendMessage, serverOnline, session.deviceId, sessionToken])

  const status = useMemo(() => {
    if (session.status === 'connected') {
      return { label: 'Connected', detail: 'Remote support session is active', tone: 'connected' }
    }

    if (session.status === 'waiting') {
      return { label: 'Waiting', detail: 'Your device is open for approved support', tone: 'waiting' }
    }

    if (session.status === 'pending') {
      if (session.pendingRole === 'requester') {
        return { label: 'Waiting approval', detail: 'The partner must approve before access starts', tone: 'pending' }
      }

      return { label: 'Approval needed', detail: 'Review the incoming request before access starts', tone: 'pending' }
    }

    return { label: 'Ready', detail: 'Create credentials or start a support session', tone: 'ready' }
  }, [session.pendingRole, session.status])

  async function refreshCredentials() {
    try {
      const response = await postJson<SessionResponse>(`/api/sessions/${session.deviceId}/refresh`, undefined, sessionToken)
      setServerOnline(true)
      applySessionResponse(response)
    } catch {
      appendMessage('Could not refresh credentials because the server is offline.')
    }
  }

  async function startWaiting() {
    try {
      const response = await postJson<SessionResponse>(`/api/sessions/${session.deviceId}/wait`, undefined, sessionToken)
      setServerOnline(true)
      applySessionResponse(response)
    } catch {
      appendMessage('Could not open this device for support because the server is offline.')
    }
  }

  async function connectToPartner() {
    const cleanPartnerId = partnerId.replace(/\D/g, '')
    if (!cleanPartnerId) return

    try {
      const response = await postJson<SessionResponse>(
        `/api/sessions/${session.deviceId}/connect`,
        { partnerId: cleanPartnerId },
        sessionToken,
      )
      setServerOnline(true)
      applySessionResponse(response)
    } catch {
      appendMessage('Could not start the support workflow because the server is offline.')
    }
  }

  async function endSession() {
    try {
      const response = await postJson<SessionResponse>(`/api/sessions/${session.deviceId}/end`, undefined, sessionToken)
      setPartnerId('')
      applySessionResponse(response)
    } catch {
      appendMessage('Could not end the server session. Local UI remains visible.')
    }
  }

  async function toggleRemoteFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }

      await remoteScreenRef.current?.requestFullscreen()
    } catch {
      appendMessage('Fullscreen is blocked by the browser. Click inside the remote screen and try again.')
    }
  }

  async function approveSession() {
    try {
      const response = await postJson<SessionResponse>(`/api/sessions/${session.deviceId}/approve`, undefined, sessionToken)
      applySessionResponse(response)
    } catch {
      appendMessage('Approval failed because the server rejected the current session state.')
    }
  }

  async function rejectSession() {
    try {
      const response = await postJson<SessionResponse>(`/api/sessions/${session.deviceId}/reject`, undefined, sessionToken)
      setPartnerId('')
      applySessionResponse(response)
    } catch {
      appendMessage('Rejection failed because the server is offline.')
    }
  }

  async function sendMessage() {
    const cleanText = chatText.trim()
    if (!cleanText) return
    setChatText('')

    try {
      await postJson(`/api/sessions/${session.deviceId}/messages`, { text: cleanText }, sessionToken)
    } catch {
      appendMessage(`Me: ${cleanText}`)
      appendMessage('Message stayed local because the signaling server is offline.')
    }
  }

  async function startRtcDataChannel() {
    if (session.status !== 'connected') {
      appendSignal('connect the session before starting RTC')
      return
    }

    try {
      const peerConnection = createPeerConnection()
      const channel = peerConnection.createDataChannel('ownview-control')
      attachDataChannel(channel)
      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      await relayWebRtcSignal('offer', offer)
      setRtcState('offer sent')
    } catch {
      appendSignal('failed to start RTC')
    }
  }

  async function shareScreen() {
    if (session.status !== 'connected') {
      appendSignal('connect the session before sharing screen')
      return
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      localScreenStreamRef.current = screenStream
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream
      }
      setIsSharingScreen(true)

      const peerConnection = peerConnectionRef.current ?? createPeerConnection()
      const needsOffer = peerConnection.signalingState === 'stable'
      for (const track of screenStream.getVideoTracks()) {
        peerConnection.addTrack(track, screenStream)
        track.onended = () => {
          setIsSharingScreen(false)
          appendSignal('screen sharing stopped')
        }
      }

      if (needsOffer || peerConnection.signalingState === 'stable') {
        const offer = await peerConnection.createOffer()
        await peerConnection.setLocalDescription(offer)
        await relayWebRtcSignal('offer', offer)
        appendSignal('screen share offer sent')
      } else {
        appendSignal('screen added; waiting for RTC negotiation')
      }
    } catch {
      appendSignal('screen sharing was cancelled or blocked')
    }
  }

  function stopScreenShare() {
    localScreenStreamRef.current?.getTracks().forEach((track) => track.stop())
    localScreenStreamRef.current = null
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
    setIsSharingScreen(false)
    appendSignal('screen sharing stopped')
  }

  function sendDataChannelMessage() {
    const cleanText = dataText.trim()
    if (!cleanText) return

    const channel = dataChannelRef.current
    if (!channel || channel.readyState !== 'open') {
      appendSignal('data channel is not open')
      return
    }

    channel.send(cleanText)
    appendDataMessage(`Me: ${cleanText}`)
    setDataText('')
  }

  function closeRtc() {
    dataChannelRef.current?.close()
    peerConnectionRef.current?.close()
    localScreenStreamRef.current?.getTracks().forEach((track) => track.stop())
    dataChannelRef.current = null
    peerConnectionRef.current = null
    localScreenStreamRef.current = null
    remoteScreenStreamRef.current = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    setRtcState('closed')
    setIsSharingScreen(false)
    setHasRemoteScreen(false)
    appendSignal('closed local RTC')
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="OwnView navigation">
        <div className="brand">
          <div className="brand-mark">
            <MonitorUp size={24} />
          </div>
          <div>
            <strong>OwnView</strong>
            <span>Assist</span>
          </div>
        </div>

        <nav className="nav-list">
          <button className="nav-item active" title="Remote support">
            <MonitorUp size={18} />
            <span>Support</span>
          </button>
          <button className="nav-item" title="Security">
            <ShieldCheck size={18} />
            <span>Security</span>
          </button>
          <button className="nav-item" title="Settings">
            <Settings size={18} />
            <span>Settings</span>
          </button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Remote Support Console</p>
            <h1>OwnView Assist</h1>
          </div>
          <div className={`status-pill ${status.tone}`}>
            <span />
            <div>
              <strong>{status.label}</strong>
              <small>{status.detail}</small>
            </div>
          </div>
        </header>

        <div className="main-grid">
          <section className="panel access-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Receive support</p>
                <h2>My device credentials</h2>
              </div>
              <button className="icon-button" onClick={refreshCredentials} title="Refresh credentials">
                <RefreshCw size={18} />
              </button>
            </div>

            <div className="credential-box">
              <label>ID</label>
              <strong>{formatDeviceId(session.deviceId)}</strong>
              <button
                className="ghost-button"
                onClick={() => navigator.clipboard.writeText(session.deviceId)}
                title="Copy ID"
              >
                <Clipboard size={16} />
                Copy
              </button>
            </div>

            <div className="credential-box password">
              <label>Password</label>
              <strong>{session.password}</strong>
              <KeyRound size={20} />
            </div>

            <button className="primary-button" onClick={startWaiting}>
              <UserRoundCheck size={18} />
              Open for support
            </button>

            <div className="notice">
              <Lock size={18} />
              <span>Control must be approved on this screen before access starts.</span>
            </div>
          </section>

          <section className="panel connect-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Help another device</p>
                <h2>Connect to partner</h2>
              </div>
              <ShieldCheck size={22} />
            </div>

            <label className="field">
              Partner ID
              <input
                value={partnerId}
                onChange={(event) => setPartnerId(event.target.value)}
                placeholder="Example: 123 456 789"
                inputMode="numeric"
              />
            </label>

            <div className="mode-row">
              <button className="mode active">Control</button>
              <button className="mode">View only</button>
              <button className="mode">File transfer</button>
            </div>

            <button className="primary-button dark" onClick={connectToPartner}>
              <MonitorUp size={18} />
              Start connection
            </button>
          </section>

          <section className="session-stage">
            <div className="remote-screen" ref={remoteScreenRef}>
              <div className="remote-toolbar">
                <span>DESKTOP-OWNVIEW</span>
                <div>
                  <button title={isRemoteFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleRemoteFullscreen}>
                    {isRemoteFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                  <button title="Send file"><CloudUpload size={16} /></button>
                  <button title="End session" onClick={endSession}><PhoneOff size={16} /></button>
                </div>
              </div>
              <div className="screen-content">
                {session.status === 'pending' && session.pendingRole === 'approver' ? (
                  <div className="consent-card">
                    <ShieldCheck size={42} />
                    <strong>Approve remote control?</strong>
                    <span>
                      Partner {formatDeviceId(session.partnerId || '000000000')} is requesting access. Approve only if
                      you can see and trust the support operator.
                    </span>
                    <div className="consent-actions">
                      <button className="reject-button" onClick={rejectSession}>
                        <XCircle size={18} />
                        Reject
                      </button>
                      <button className="approve-button" onClick={approveSession}>
                        <CheckCircle2 size={18} />
                        Approve
                      </button>
                    </div>
                  </div>
                ) : session.status === 'pending' ? (
                  <div className="consent-card outbound">
                    <ShieldCheck size={42} />
                    <strong>Waiting for approval</strong>
                    <span>
                      Request sent to {formatDeviceId(session.partnerId || '000000000')}. The remote user
                      must approve on their screen before this session can connect.
                    </span>
                    <button className="reject-button single" onClick={rejectSession}>
                      <XCircle size={18} />
                      Cancel request
                    </button>
                  </div>
                ) : (
                  <>
                    {hasRemoteScreen ? (
                      <video
                        ref={remoteVideoRef}
                        className="remote-video"
                        autoPlay
                        playsInline
                        muted
                      />
                    ) : agentScreenFrame ? (
                      <div className="remote-frame-shell">
                        {screenFrameMeta.monitors.length > 1 && (
                          <div className="monitor-tabs">
                            <button
                              className={selectedMonitorId === 'all' ? 'active' : ''}
                              type="button"
                              onClick={() => setSelectedMonitorId('all')}
                            >
                              All
                            </button>
                            {screenFrameMeta.monitors.map((monitor, index) => (
                              <button
                                className={selectedMonitorId === monitor.id ? 'active' : ''}
                                key={monitor.id}
                                type="button"
                                onClick={() => setSelectedMonitorId(monitor.id)}
                              >
                                {monitor.name || `Display ${index + 1}`}
                              </button>
                            ))}
                          </div>
                        )}
                        <div
                          className={selectedMonitor ? 'remote-frame-crop' : 'remote-frame-crop all'}
                          tabIndex={0}
                          style={{
                            aspectRatio: selectedMonitor
                              ? `${selectedMonitor.width} / ${selectedMonitor.height}`
                              : `${screenFrameMeta.virtualScreen.width} / ${screenFrameMeta.virtualScreen.height}`,
                          }}
                          onMouseMove={(event) => {
                            if (event.buttons) void sendAgentInput(pointerInputFromEvent(event, 'move'))
                          }}
                          onMouseDown={(event) => {
                            event.currentTarget.focus()
                            event.preventDefault()
                            void sendAgentInput(pointerInputFromEvent(event, 'down'))
                          }}
                          onMouseUp={(event) => {
                            event.preventDefault()
                            void sendAgentInput(pointerInputFromEvent(event, 'up'))
                          }}
                          onContextMenu={(event) => event.preventDefault()}
                          onWheel={(event) => {
                            event.preventDefault()
                            void sendAgentInput(pointerInputFromEvent(event, 'wheel'))
                          }}
                          onKeyDown={(event) => {
                            const keyCode = keyCodeFromEvent(event)
                            if (!keyCode) return
                            event.preventDefault()
                            void sendAgentInput({ kind: 'keyboard', action: 'down', keyCode, key: event.key })
                          }}
                          onKeyUp={(event) => {
                            const keyCode = keyCodeFromEvent(event)
                            if (!keyCode) return
                            event.preventDefault()
                            void sendAgentInput({ kind: 'keyboard', action: 'up', keyCode, key: event.key })
                          }}
                        >
                          <img
                            className="remote-frame"
                            src={agentScreenFrame}
                            alt="Native Windows agent screen"
                            style={selectedMonitor ? {
                              width: `${(screenFrameMeta.virtualScreen.width / selectedMonitor.width) * 100}%`,
                              height: `${(screenFrameMeta.virtualScreen.height / selectedMonitor.height) * 100}%`,
                              left: `${((screenFrameMeta.virtualScreen.x - selectedMonitor.x) / selectedMonitor.width) * 100}%`,
                              top: `${((screenFrameMeta.virtualScreen.y - selectedMonitor.y) / selectedMonitor.height) * 100}%`,
                            } : undefined}
                          />
                        </div>
                      </div>
                    ) : (
                      <>
                        <MonitorUp size={56} />
                        <strong>{session.status === 'connected' ? 'Remote screen preview' : 'No active session'}</strong>
                        <span>
                          {session.status === 'connected'
                            ? 'Waiting for WebRTC screen share or native Windows agent frames.'
                            : 'Start a connection or open this device for support to show a remote screen.'}
                        </span>
                      </>
                    )}
                    {isSharingScreen && (
                      <div className="local-preview">
                        <video ref={localVideoRef} autoPlay playsInline muted />
                        <span>Sharing this screen</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="panel side-panel">
            <div className="panel-header compact">
              <h2>Chat</h2>
              <MessageSquareText size={20} />
            </div>

            <div className="message-list">
              {messages.map((message, index) => (
                <p key={`${message}-${index}`}>{message}</p>
              ))}
            </div>

            <div className="chat-input">
              <input
                value={chatText}
                onChange={(event) => setChatText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') sendMessage()
                }}
                placeholder="Type a message"
              />
              <button onClick={sendMessage} title="Send message">
                <Send size={16} />
              </button>
            </div>
          </section>

          <section className="panel audit-panel">
            <div className="panel-header compact">
              <h2>Audit Trail</h2>
              <CheckCircle2 size={20} />
            </div>
            <div className="audit-list">
              {auditEntries.length === 0 ? (
                <p>No persisted audit events yet.</p>
              ) : auditEntries.map((entry) => (
                <article key={entry.id}>
                  <strong>{entry.event}</strong>
                  <span>{entry.message}</span>
                  <small>{new Date(entry.timestamp).toLocaleTimeString()} / {entry.status}</small>
                </article>
              ))}
            </div>
          </section>

          <section className="panel signal-panel">
            <div className="panel-header compact">
              <h2>Signal Server</h2>
              <Signal size={20} />
            </div>
            <p className={serverOnline ? 'server-state online' : 'server-state offline'}>
              {serverOnline ? 'Online at /api and /ws' : 'Offline, using local UI state'}
            </p>
            <small>Public URL {publicConfig.publicUrl}</small>
            <small>Token expires {new Date(session.tokenExpiresAt).toLocaleTimeString()}</small>
          </section>

          <section className="panel webrtc-panel">
            <div className="panel-header compact">
              <h2>WebRTC Data</h2>
              <Network size={20} />
            </div>
            <p className="rtc-state">RTC: {rtcState}</p>
            <div className="signal-actions">
              <button onClick={startRtcDataChannel}>Start RTC</button>
              <button onClick={isSharingScreen ? stopScreenShare : shareScreen}>
                {isSharingScreen ? 'Stop Share' : 'Share Screen'}
              </button>
              <button onClick={closeRtc}>Close</button>
            </div>
            <input
              className="rtc-input"
              value={dataText}
              onChange={(event) => setDataText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') sendDataChannelMessage()
              }}
              placeholder="Data channel message"
            />
            <button className="send-data-button" onClick={sendDataChannelMessage}>Send data message</button>
            <div className="signal-log data-log">
              {dataMessages.length === 0 ? (
                <p>No data channel messages yet.</p>
              ) : dataMessages.map((entry, index) => (
                <p key={`${entry}-${index}`}>{entry}</p>
              ))}
            </div>
            <div className="signal-log">
              {signalLog.length === 0 ? (
                <p>No RTC events yet.</p>
              ) : signalLog.map((entry, index) => (
                <p key={`${entry}-${index}`}>{entry}</p>
              ))}
            </div>
          </section>

          <section className="panel agents-panel">
            <div className="panel-header compact">
              <h2>Windows Agents</h2>
              <MonitorUp size={20} />
            </div>
            <div className="agent-list">
              {agents.length === 0 ? (
                <p>No native agents connected.</p>
              ) : agents.map((agent) => (
                <article key={agent.id}>
                  <div className="agent-title-row">
                    <strong>{agent.name}</strong>
                    <button type="button" onClick={() => setPartnerId(agent.deviceId)}>Use ID</button>
                  </div>
                  <span>ID {formatDeviceId(agent.deviceId)}</span>
                  <span>Last seen {new Date(agent.lastSeenAt).toLocaleTimeString()}</span>
                  <span>
                    Frames {agent.frameCount ?? 0}
                    {agent.lastFrameAt ? ` / last ${new Date(agent.lastFrameAt).toLocaleTimeString()}` : ' / none yet'}
                  </span>
                  <small>
                    Approval {agent.requireVisibleApproval ? 'required' : 'not required'} / Input {agent.allowRemoteInput ? 'allowed' : 'disabled'}
                  </small>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  )
}

export default App
