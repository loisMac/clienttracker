import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'
import { isSupabaseConfigured, supabase } from './lib/supabase'

type DayOfWork = 'Tuesday' | 'Friday'

type BankedSession = {
  id: string
  bankedOn: string
  expiresOn: string
  usedOn?: string
}

type InPersonClient = {
  id: string
  name: string
  bankedSessions: BankedSession[]
}

type OnlineClient = {
  id: string
  name: string
  lastCallOn: string
  notes: string
}

type ScheduleEntry = {
  id: string
  clientName: string
  day: DayOfWork
  time: string
  notes: string
}

type AppState = {
  inPersonClients: InPersonClient[]
  onlineClients: OnlineClient[]
  schedule: ScheduleEntry[]
}

type BackupFile = {
  version: number
  exportedAt: string
  data: AppState
}

type CloudSaveState = 'idle' | 'saving' | 'saved' | 'error'

type CloudHistoryItem = {
  id: string
  created_at: string
  payload: AppState
}

const STORAGE_KEY = 'clienttracker.app.v1'
const SNAPSHOT_STORAGE_KEY = 'clienttracker.backups.v1'
const SNAPSHOT_VERSION = 1
const MAX_LOCAL_SNAPSHOTS = 20
const CLOUD_TABLE = 'trainer_snapshots'
const CLOUD_HISTORY_TABLE = 'trainer_snapshot_history'
type AuthMode = 'password' | 'magic-link'
const OWNER_EMAIL = (import.meta.env.VITE_OWNER_EMAIL as string | undefined)
  ?.trim()
  .toLowerCase()

const initialState: AppState = {
  inPersonClients: [],
  onlineClients: [],
  schedule: [],
}

const todayIso = () => new Date().toISOString().slice(0, 10)

const toDate = (isoDate: string) => {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const formatDate = (isoDate: string) => {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(toDate(isoDate))
}

const addMonths = (isoDate: string, months: number) => {
  const date = toDate(isoDate)
  date.setMonth(date.getMonth() + months)
  return date.toISOString().slice(0, 10)
}

const isExpired = (expiresOn: string, referenceDate = todayIso()) => {
  return toDate(expiresOn) < toDate(referenceDate)
}

const daysUntil = (targetDate: string, referenceDate = todayIso()) => {
  const msInDay = 1000 * 60 * 60 * 24
  const delta = toDate(targetDate).getTime() - toDate(referenceDate).getTime()
  return Math.ceil(delta / msInDay)
}

const makeId = () => crypto.randomUUID()

const mapSupabaseAuthError = (errorMessage: string) => {
  const normalized = errorMessage.toLowerCase()

  if (normalized.includes('rate limit')) {
    return 'Too many email requests. Wait a few minutes, then try again or use password sign-in.'
  }

  if (normalized.includes('invalid login credentials')) {
    return 'Email or password is incorrect.'
  }

  return errorMessage
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const isBankedSession = (value: unknown): value is BankedSession => {
  if (!isRecord(value)) {
    return false
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.bankedOn !== 'string' ||
    typeof value.expiresOn !== 'string'
  ) {
    return false
  }

  return value.usedOn === undefined || typeof value.usedOn === 'string'
}

const isInPersonClient = (value: unknown): value is InPersonClient => {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.bankedSessions) &&
    value.bankedSessions.every(isBankedSession)
  )
}

const isOnlineClient = (value: unknown): value is OnlineClient => {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.lastCallOn === 'string' &&
    typeof value.notes === 'string'
  )
}

const isScheduleEntry = (value: unknown): value is ScheduleEntry => {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.clientName === 'string' &&
    (value.day === 'Tuesday' || value.day === 'Friday') &&
    typeof value.time === 'string' &&
    typeof value.notes === 'string'
  )
}

const isAppState = (value: unknown): value is AppState => {
  if (!isRecord(value)) {
    return false
  }

  return (
    Array.isArray(value.inPersonClients) &&
    value.inPersonClients.every(isInPersonClient) &&
    Array.isArray(value.onlineClients) &&
    value.onlineClients.every(isOnlineClient) &&
    Array.isArray(value.schedule) &&
    value.schedule.every(isScheduleEntry)
  )
}

const loadInitialState = (): AppState => {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (!saved) {
    return initialState
  }

  try {
    const parsed = JSON.parse(saved) as unknown
    return isAppState(parsed) ? parsed : initialState
  } catch {
    return initialState
  }
}

const saveLocalSnapshot = (state: AppState) => {
  const nextSnapshot = {
    createdAt: new Date().toISOString(),
    data: state,
  }

  const existingRaw = localStorage.getItem(SNAPSHOT_STORAGE_KEY)
  if (!existingRaw) {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify([nextSnapshot]))
    return
  }

  try {
    const existing = JSON.parse(existingRaw) as Array<{
      createdAt: string
      data: AppState
    }>

    const lastSnapshot = existing[0]
    if (lastSnapshot && JSON.stringify(lastSnapshot.data) === JSON.stringify(state)) {
      return
    }

    const merged = [nextSnapshot, ...existing].slice(0, MAX_LOCAL_SNAPSHOTS)
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(merged))
  } catch {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify([nextSnapshot]))
  }
}

function App() {
  const [state, setState] = useState<AppState>(loadInitialState)

  const [inPersonName, setInPersonName] = useState('')
  const [onlineName, setOnlineName] = useState('')
  const [onlineLastCallOn, setOnlineLastCallOn] = useState(todayIso())
  const [onlineNotes, setOnlineNotes] = useState('')
  const [scheduleClientName, setScheduleClientName] = useState('')
  const [scheduleDay, setScheduleDay] = useState<DayOfWork>('Tuesday')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [scheduleNotes, setScheduleNotes] = useState('')
  const [bankDateByClient, setBankDateByClient] = useState<Record<string, string>>({})
  const [bulkInPersonNames, setBulkInPersonNames] = useState('')
  const [quickClientId, setQuickClientId] = useState('')
  const [message, setMessage] = useState('')
  const [authMode, setAuthMode] = useState<AuthMode>('password')
  const [showAdvancedAuth, setShowAdvancedAuth] = useState(false)
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudPassword, setCloudPassword] = useState('')
  const [cloudConfirmPassword, setCloudConfirmPassword] = useState('')
  const [passwordResetEmail, setPasswordResetEmail] = useState('')
  const [cloudUserId, setCloudUserId] = useState<string | null>(null)
  const [cloudUserEmail, setCloudUserEmail] = useState<string | null>(null)
  const [cloudReadyForSync, setCloudReadyForSync] = useState(!isSupabaseConfigured)
  const [cloudLoading, setCloudLoading] = useState(false)
  const [cloudSaveState, setCloudSaveState] = useState<CloudSaveState>('idle')
  const [cloudSaveError, setCloudSaveError] = useState<string | null>(null)
  const [lastLocalSaveAt, setLastLocalSaveAt] = useState<string | null>(null)
  const [lastCloudSyncAt, setLastCloudSyncAt] = useState<string | null>(null)
  const [historyItems, setHistoryItems] = useState<CloudHistoryItem[]>([])
  const [isOnline, setIsOnline] = useState<boolean>(window.navigator.onLine)
  const backupImportRef = useRef<HTMLInputElement>(null)
  const lastHistoryDateRef = useRef<string>('')

  useEffect(() => {
    let rafId = 0

    const updatePointer = (clientX: number, clientY: number) => {
      const centerX = window.innerWidth / 2
      const centerY = window.innerHeight / 2
      const deltaX = clientX - centerX
      const deltaY = clientY - centerY

      cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--pointer-x', `${deltaX}px`)
        document.documentElement.style.setProperty('--pointer-y', `${deltaY}px`)
      })
    }

    const handleMove = (event: MouseEvent) => {
      updatePointer(event.clientX, event.clientY)
    }

    const handleReset = () => {
      updatePointer(window.innerWidth / 2, window.innerHeight / 2)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseleave', handleReset)
    handleReset()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseleave', handleReset)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    saveLocalSnapshot(state)
    setLastLocalSaveAt(new Date().toISOString())
  }, [state])

  useEffect(() => {
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const loadCloudSnapshot = async (userId: string) => {
    if (!supabase) {
      return
    }

    setCloudLoading(true)
    const { data, error } = await supabase
      .from(CLOUD_TABLE)
      .select('payload, updated_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      setMessage(`Cloud load failed: ${error.message}`)
      setCloudReadyForSync(true)
      setCloudLoading(false)
      return
    }

    const payload = data?.payload as unknown
    if (payload && isAppState(payload)) {
      setState(payload)
      setMessage('Loaded latest cloud backup')
    }

    if (data?.updated_at) {
      setLastCloudSyncAt(data.updated_at)
    }

    setCloudReadyForSync(true)
    setCloudLoading(false)
  }

  const loadCloudHistory = async (userId: string) => {
    if (!supabase) {
      return
    }

    const { data, error } = await supabase
      .from(CLOUD_HISTORY_TABLE)
      .select('id, payload, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(7)

    if (error) {
      return
    }

    const items = (data ?? [])
      .map((row) => {
        const payload = row.payload as unknown
        if (!isAppState(payload)) {
          return null
        }

        return {
          id: row.id as string,
          payload,
          created_at: row.created_at as string,
        }
      })
      .filter((item): item is CloudHistoryItem => item !== null)

    setHistoryItems(items)
    if (items[0]) {
      lastHistoryDateRef.current = items[0].created_at.slice(0, 10)
    }
  }

  const restoreCloudHistoryItem = (item: CloudHistoryItem) => {
    if (
      !window.confirm(
        `Restore backup from ${new Date(item.created_at).toLocaleString('en-GB')}?`,
      )
    ) {
      return
    }

    setState(item.payload)
    setMessage('Cloud restore point loaded')
  }

  useEffect(() => {
    if (!supabase) {
      return
    }

    let isMounted = true

    const initializeSession = async () => {
      setCloudLoading(true)
      const { data, error } = await supabase.auth.getSession()

      if (!isMounted) {
        return
      }

      if (error) {
        setMessage(`Could not read cloud session: ${error.message}`)
        setCloudLoading(false)
        setCloudReadyForSync(true)
        return
      }

      const user = data.session?.user ?? null
      setCloudUserId(user?.id ?? null)
      setCloudUserEmail(user?.email ?? null)

      if (user) {
        if (OWNER_EMAIL && user.email?.toLowerCase() !== OWNER_EMAIL) {
          await supabase.auth.signOut()
          setMessage(`This app is locked to owner account: ${OWNER_EMAIL}`)
          setCloudLoading(false)
          setCloudReadyForSync(true)
          return
        }
        await loadCloudSnapshot(user.id)
        await loadCloudHistory(user.id)
      } else {
        setCloudLoading(false)
        setCloudReadyForSync(true)
        setCloudSaveState('idle')
      }
    }

    void initializeSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null
      setCloudUserId(user?.id ?? null)
      setCloudUserEmail(user?.email ?? null)

      if (user) {
        if (OWNER_EMAIL && user.email?.toLowerCase() !== OWNER_EMAIL) {
          void supabase.auth.signOut()
          setMessage(`This app is locked to owner account: ${OWNER_EMAIL}`)
          return
        }

        void loadCloudSnapshot(user.id)
        void loadCloudHistory(user.id)
      } else {
        setCloudReadyForSync(true)
        setHistoryItems([])
        setCloudSaveState('idle')
      }
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !cloudUserId || !cloudReadyForSync) {
      return
    }

    const timeoutId = window.setTimeout(async () => {
      setCloudSaveState('saving')
      setCloudSaveError(null)

      const { error } = await supabase.from(CLOUD_TABLE).upsert({
        user_id: cloudUserId,
        payload: state,
        updated_at: new Date().toISOString(),
      })

      if (error) {
        setMessage(`Cloud save failed: ${error.message}`)
        setCloudSaveState('error')
        setCloudSaveError(error.message)
        return
      }

      const nowIso = new Date().toISOString()
      setLastCloudSyncAt(nowIso)
      setCloudSaveState('saved')

      const todayKey = nowIso.slice(0, 10)
      if (lastHistoryDateRef.current !== todayKey) {
        const { error: historyError } = await supabase.from(CLOUD_HISTORY_TABLE).insert({
          user_id: cloudUserId,
          payload: state,
        })

        if (!historyError) {
          lastHistoryDateRef.current = todayKey
          await loadCloudHistory(cloudUserId)
        }
      }
    }, 700)

    return () => window.clearTimeout(timeoutId)
  }, [state, cloudReadyForSync, cloudUserId])

  const bankedOverview = useMemo(() => {
    const allSessions = state.inPersonClients.flatMap((client) =>
      client.bankedSessions.map((session) => ({
        ...session,
        clientName: client.name,
      })),
    )

    const available = allSessions.filter(
      (session) => !session.usedOn && !isExpired(session.expiresOn),
    )

    const expiringSoon = available.filter(
      (session) => daysUntil(session.expiresOn) <= 14,
    )

    const expiredUnused = allSessions.filter(
      (session) => !session.usedOn && isExpired(session.expiresOn),
    )

    return {
      availableCount: available.length,
      expiringSoonCount: expiringSoon.length,
      expiredUnusedCount: expiredUnused.length,
    }
  }, [state.inPersonClients])

  const onlineOverview = useMemo(() => {
    const due = state.onlineClients.filter((client) => {
      const dueOn = addMonths(client.lastCallOn, 1)
      return daysUntil(dueOn) <= 7
    })
    const overdue = state.onlineClients.filter((client) => {
      const dueOn = addMonths(client.lastCallOn, 1)
      return daysUntil(dueOn) < 0
    })

    return {
      dueSoonCount: due.length,
      overdueCount: overdue.length,
    }
  }, [state.onlineClients])

  const groupedSchedule = useMemo(() => {
    const tuesday = state.schedule
      .filter((entry) => entry.day === 'Tuesday')
      .sort((a, b) => a.time.localeCompare(b.time))
    const friday = state.schedule
      .filter((entry) => entry.day === 'Friday')
      .sort((a, b) => a.time.localeCompare(b.time))

    return { Tuesday: tuesday, Friday: friday }
  }, [state.schedule])

  const attentionItems = useMemo(() => {
    const items: Array<{ id: string; text: string }> = []

    state.inPersonClients.forEach((client) => {
      const expiredCount = client.bankedSessions.filter(
        (session) => !session.usedOn && isExpired(session.expiresOn),
      ).length

      if (expiredCount > 0) {
        items.push({
          id: `bank-${client.id}`,
          text: `${client.name}: ${expiredCount} expired banked session${
            expiredCount === 1 ? '' : 's'
          }`,
        })
      }
    })

    state.onlineClients.forEach((client) => {
      const nextDue = addMonths(client.lastCallOn, 1)
      const overdueDays = Math.abs(daysUntil(nextDue))
      if (daysUntil(nextDue) < 0) {
        items.push({
          id: `online-${client.id}`,
          text: `${client.name}: online call overdue by ${overdueDays} day${
            overdueDays === 1 ? '' : 's'
          }`,
        })
      }
    })

    return items
  }, [state.inPersonClients, state.onlineClients])

  useEffect(() => {
    if (!quickClientId) {
      return
    }

    const stillExists = state.inPersonClients.some((client) => client.id === quickClientId)
    if (!stillExists) {
      setQuickClientId('')
    }
  }, [quickClientId, state.inPersonClients])

  const addInPersonClient = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = inPersonName.trim()

    if (!name) {
      return
    }

    setState((current) => ({
      ...current,
      inPersonClients: [
        ...current.inPersonClients,
        {
          id: makeId(),
          name,
          bankedSessions: [],
        },
      ],
    }))

    setInPersonName('')
    setMessage(`Added in-person client: ${name}`)
  }

  const bankSession = (clientId: string, bankedOnInput?: string) => {
    const bankedOn = bankedOnInput || todayIso()

    setState((current) => ({
      ...current,
      inPersonClients: current.inPersonClients.map((client) => {
        if (client.id !== clientId) {
          return client
        }

        const activeBank = client.bankedSessions.filter(
          (session) => !session.usedOn && !isExpired(session.expiresOn),
        )

        if (activeBank.length >= 4) {
          setMessage(
            `${client.name} already has 4 active banked sessions. Use one before banking another.`,
          )
          return client
        }

        const newSession: BankedSession = {
          id: makeId(),
          bankedOn,
          expiresOn: addMonths(bankedOn, 3),
        }

        setMessage(`Banked 1 session for ${client.name}`)

        return {
          ...client,
          bankedSessions: [...client.bankedSessions, newSession],
        }
      }),
    }))
  }

  const useOldestBankedSession = (clientId: string) => {
    const usedOn = todayIso()

    setState((current) => ({
      ...current,
      inPersonClients: current.inPersonClients.map((client) => {
        if (client.id !== clientId) {
          return client
        }

        const oldestAvailable = client.bankedSessions
          .filter((session) => !session.usedOn && !isExpired(session.expiresOn))
          .sort((a, b) => a.bankedOn.localeCompare(b.bankedOn))[0]

        if (!oldestAvailable) {
          setMessage(`${client.name} has no available banked sessions to use.`)
          return client
        }

        setMessage(`Used 1 banked session for ${client.name}`)

        return {
          ...client,
          bankedSessions: client.bankedSessions.map((session) =>
            session.id === oldestAvailable.id ? { ...session, usedOn } : session,
          ),
        }
      }),
    }))
  }

  const removeInPersonClient = (clientId: string) => {
    setState((current) => ({
      ...current,
      inPersonClients: current.inPersonClients.filter(
        (client) => client.id !== clientId,
      ),
    }))
    setBankDateByClient((current) => {
      const next = { ...current }
      delete next[clientId]
      return next
    })
    setMessage('Removed in-person client')
  }

  const addOnlineClient = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = onlineName.trim()

    if (!name) {
      return
    }

    setState((current) => ({
      ...current,
      onlineClients: [
        ...current.onlineClients,
        {
          id: makeId(),
          name,
          lastCallOn: onlineLastCallOn,
          notes: onlineNotes.trim(),
        },
      ],
    }))

    setOnlineName('')
    setOnlineNotes('')
    setOnlineLastCallOn(todayIso())
    setMessage(`Added online client: ${name}`)
  }

  const markOnlineCallDone = (clientId: string) => {
    const completedOn = todayIso()
    setState((current) => ({
      ...current,
      onlineClients: current.onlineClients.map((client) =>
        client.id === clientId ? { ...client, lastCallOn: completedOn } : client,
      ),
    }))
    setMessage('Marked monthly call complete')
  }

  const removeOnlineClient = (clientId: string) => {
    setState((current) => ({
      ...current,
      onlineClients: current.onlineClients.filter((client) => client.id !== clientId),
    }))
    setMessage('Removed online client')
  }

  const addScheduleEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const clientName = scheduleClientName.trim()

    if (!clientName) {
      return
    }

    setState((current) => ({
      ...current,
      schedule: [
        ...current.schedule,
        {
          id: makeId(),
          clientName,
          day: scheduleDay,
          time: scheduleTime,
          notes: scheduleNotes.trim(),
        },
      ],
    }))

    setScheduleClientName('')
    setScheduleNotes('')
    setScheduleDay('Tuesday')
    setScheduleTime('09:00')
    setMessage(`Added schedule slot for ${clientName}`)
  }

  const removeScheduleEntry = (entryId: string) => {
    setState((current) => ({
      ...current,
      schedule: current.schedule.filter((entry) => entry.id !== entryId),
    }))
    setMessage('Removed schedule slot')
  }

  const clearAllData = () => {
    if (!window.confirm('Clear all clients and schedule data?')) {
      return
    }
    setState(initialState)
    setMessage('All tracker data cleared')
  }

  const exportBackup = () => {
    const backup: BackupFile = {
      version: SNAPSHOT_VERSION,
      exportedAt: new Date().toISOString(),
      data: state,
    }

    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: 'application/json',
    })

    const fileDate = new Date().toISOString().slice(0, 10)
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `clienttracker-backup-${fileDate}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    setMessage('Backup exported')
  }

  const promptImportBackup = () => {
    backupImportRef.current?.click()
  }

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown

      let dataCandidate: unknown = parsed
      if (isRecord(parsed) && 'data' in parsed) {
        dataCandidate = parsed.data
      }

      if (!isAppState(dataCandidate)) {
        setMessage('Backup file is invalid')
        event.target.value = ''
        return
      }

      setState(dataCandidate)
      setMessage('Backup imported successfully')
    } catch {
      setMessage('Could not import backup file')
    }

    event.target.value = ''
  }

  const addBulkInPersonClients = () => {
    const names = bulkInPersonNames
      .split(/\n|,/)
      .map((name) => name.trim())
      .filter(Boolean)

    if (names.length === 0) {
      return
    }

    setState((current) => ({
      ...current,
      inPersonClients: [
        ...current.inPersonClients,
        ...names.map((name) => ({
          id: makeId(),
          name,
          bankedSessions: [],
        })),
      ],
    }))

    setBulkInPersonNames('')
    setMessage(`Added ${names.length} in-person client${names.length === 1 ? '' : 's'}`)
  }

  const quickBankToday = () => {
    if (!quickClientId) {
      setMessage('Pick a client first for quick banking.')
      return
    }

    bankSession(quickClientId, todayIso())
  }

  const sendMagicLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      return
    }

    const email = cloudEmail.trim()
    if (!email) {
      return
    }

    if (OWNER_EMAIL && email.toLowerCase() !== OWNER_EMAIL) {
      setMessage(`Use owner account email: ${OWNER_EMAIL}`)
      return
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
      },
    })

    if (error) {
      setMessage(`Could not send magic link: ${mapSupabaseAuthError(error.message)}`)
      return
    }

    setMessage('Magic link sent. Open your email to sign in.')
    setCloudEmail('')
  }

  const signInWithPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      return
    }

    const email = cloudEmail.trim()
    if (!email || !cloudPassword) {
      setMessage('Enter both email and password.')
      return
    }

    if (OWNER_EMAIL && email.toLowerCase() !== OWNER_EMAIL) {
      setMessage(`Use owner account email: ${OWNER_EMAIL}`)
      return
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: cloudPassword,
    })

    if (error) {
      setMessage(`Could not sign in: ${mapSupabaseAuthError(error.message)}`)
      return
    }

    setCloudPassword('')
    setCloudConfirmPassword('')
    setMessage('Signed in successfully. Cloud sync is active.')
  }

  const createPasswordAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      return
    }

    const email = cloudEmail.trim()
    if (!email || !cloudPassword) {
      setMessage('Enter both email and password.')
      return
    }

    if (OWNER_EMAIL && email.toLowerCase() !== OWNER_EMAIL) {
      setMessage(`Use owner account email: ${OWNER_EMAIL}`)
      return
    }

    if (cloudPassword.length < 10) {
      setMessage('Use a stronger password: at least 10 characters.')
      return
    }

    if (cloudPassword !== cloudConfirmPassword) {
      setMessage('Password and confirm password do not match.')
      return
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password: cloudPassword,
      options: {
        emailRedirectTo: window.location.origin,
      },
    })

    if (error) {
      setMessage(`Could not create account: ${mapSupabaseAuthError(error.message)}`)
      return
    }

    setCloudPassword('')
    setCloudConfirmPassword('')

    if (data.session) {
      setMessage('Account created and signed in. Cloud sync is active.')
      return
    }

    setMessage('Account created. Check your email once to confirm, then sign in.')
  }

  const sendPasswordReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      return
    }

    const email = passwordResetEmail.trim().toLowerCase()
    if (!email) {
      setMessage('Enter your email for password reset.')
      return
    }

    if (OWNER_EMAIL && email !== OWNER_EMAIL) {
      setMessage(`Use owner account email: ${OWNER_EMAIL}`)
      return
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })

    if (error) {
      setMessage(`Could not send reset email: ${mapSupabaseAuthError(error.message)}`)
      return
    }

    setPasswordResetEmail('')
    setMessage('Password reset email sent.')
  }

  const signOutCloud = async () => {
    if (!supabase) {
      return
    }

    await supabase.auth.signOut()
    setCloudUserId(null)
    setCloudUserEmail(null)
    setLastCloudSyncAt(null)
    setCloudSaveState('idle')
    setCloudSaveError(null)
    setHistoryItems([])
    setMessage('Signed out from cloud sync')
  }

  const pullLatestFromCloud = async () => {
    if (!cloudUserId) {
      return
    }
    await loadCloudSnapshot(cloudUserId)
  }

  return (
    <main className="app-shell">
      <header className="top-hero">
        <p className="eyebrow">christiemitchellpt planner</p>
        <h1>Hey Christie, here's your week.</h1>
        <p className="intro">
          One place to track banked sessions, monthly online calls, and your
          Tuesday/Friday diary.
        </p>
        <div className="hero-motion" aria-hidden="true">
          <span className="motion-chip electric"></span>
          <span className="motion-chip sage"></span>
          <span className="motion-dot"></span>
        </div>
        <div className="stat-grid">
          <article className="stat-card">
            <p className="stat-label">Active banked sessions</p>
            <p className="stat-value">{bankedOverview.availableCount}</p>
          </article>
          <article className="stat-card warning">
            <p className="stat-label">Expiring in 14 days</p>
            <p className="stat-value">{bankedOverview.expiringSoonCount}</p>
          </article>
          <article className="stat-card alert">
            <p className="stat-label">Online calls overdue</p>
            <p className="stat-value">{onlineOverview.overdueCount}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Calls due this week</p>
            <p className="stat-value">{onlineOverview.dueSoonCount}</p>
          </article>
        </div>
        <div className="toolbar">
          <button type="button" className="ghost" onClick={clearAllData}>
            Reset all data
          </button>
          <button type="button" className="ghost" onClick={exportBackup}>
            Export backup
          </button>
          <button type="button" className="ghost" onClick={promptImportBackup}>
            Import backup
          </button>
          <input
            ref={backupImportRef}
            type="file"
            className="file-input"
            accept="application/json"
            onChange={importBackup}
          />
          {message ? <p className="message">{message}</p> : null}
        </div>
      </header>

      {attentionItems.length > 0 ? (
        <section className="attention-strip" aria-label="Needs attention">
          <p className="attention-title">Needs attention</p>
          <ul>
            {attentionItems.map((item) => (
              <li key={item.id} className="attention-pill">
                <span className="attention-icon" aria-hidden="true">
                  !
                </span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="save-status" aria-label="Save status">
        <span>
          Local: {lastLocalSaveAt ? `Saved ${new Date(lastLocalSaveAt).toLocaleTimeString('en-GB')}` : 'Pending'}
        </span>
        <span>
          Cloud:{' '}
          {!isSupabaseConfigured
            ? 'Not configured'
            : !isOnline
              ? 'Offline'
              : cloudUserId
                ? cloudSaveState === 'saving'
                  ? 'Saving...'
                  : cloudSaveState === 'saved'
                    ? `Saved ${lastCloudSyncAt ? new Date(lastCloudSyncAt).toLocaleTimeString('en-GB') : 'now'}`
                    : cloudSaveState === 'error'
                      ? 'Sync issue'
                      : 'Connected'
                : 'Signed out'}
        </span>
        {cloudSaveError ? <span className="save-error">{cloudSaveError}</span> : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Login and backups</h2>
          <p>
            Everything saves in this browser. Cloud sync keeps a second copy so
            nothing gets lost.
          </p>
        </div>

        {!isSupabaseConfigured ? (
          <div className="cloud-box">
            <p className="muted">
              Cloud sync is off. Add VITE_SUPABASE_URL and
              VITE_SUPABASE_ANON_KEY in .env to turn on sign-in and auto backup.
            </p>
          </div>
        ) : (
          <div className="cloud-box">
            {OWNER_EMAIL ? (
              <p className="muted owner-note">Owner account: {OWNER_EMAIL}</p>
            ) : null}
            {cloudUserEmail ? (
              <>
                <p>
                  Signed in as <strong>{cloudUserEmail}</strong>
                </p>
                <div className="status-row">
                  <button type="button" className="ghost" onClick={pullLatestFromCloud}>
                    Pull latest backup
                  </button>
                  <button type="button" className="ghost" onClick={signOutCloud}>
                    Sign out
                  </button>
                </div>

                {historyItems.length > 0 ? (
                  <div className="restore-list">
                    <p className="muted">Recent restore points</p>
                    <ul>
                      {historyItems.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => restoreCloudHistoryItem(item)}
                          >
                            Restore {new Date(item.created_at).toLocaleString('en-GB')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="auth-toggle" role="tablist" aria-label="Auth method">
                  <button
                    type="button"
                    className={authMode === 'password' ? 'tab active' : 'tab'}
                    onClick={() => setAuthMode('password')}
                  >
                    Password sign-in
                  </button>
                  {showAdvancedAuth ? (
                    <button
                      type="button"
                      className={authMode === 'magic-link' ? 'tab active' : 'tab'}
                      onClick={() => setAuthMode('magic-link')}
                    >
                      Magic link
                    </button>
                  ) : null}
                </div>

                {authMode === 'password' ? (
                  <div className="auth-stack">
                    <form className="inline-form auth-form" onSubmit={signInWithPassword}>
                      <label>
                        Email
                        <input
                          type="email"
                          value={cloudEmail}
                          onChange={(event) => setCloudEmail(event.target.value)}
                          placeholder="trainer@email.com"
                          autoComplete="username"
                          required
                        />
                      </label>
                      <label>
                        Password
                        <input
                          type="password"
                          value={cloudPassword}
                          onChange={(event) => setCloudPassword(event.target.value)}
                          autoComplete="current-password"
                          required
                        />
                      </label>
                      <button type="submit">Sign in</button>
                    </form>

                    <form className="inline-form auth-form" onSubmit={createPasswordAccount}>
                      <label>
                        Confirm password
                        <input
                          type="password"
                          value={cloudConfirmPassword}
                          onChange={(event) => setCloudConfirmPassword(event.target.value)}
                          autoComplete="new-password"
                          required
                        />
                      </label>
                      <button type="submit" className="ghost">
                        Create account
                      </button>
                    </form>

                    <form className="inline-form cloud-form" onSubmit={sendPasswordReset}>
                      <label>
                        Forgot password email
                        <input
                          type="email"
                          value={passwordResetEmail}
                          onChange={(event) => setPasswordResetEmail(event.target.value)}
                          placeholder="owner@email.com"
                          autoComplete="email"
                          required
                        />
                      </label>
                      <button type="submit" className="ghost">
                        Send reset link
                      </button>
                    </form>
                  </div>
                ) : (
                  <form className="inline-form cloud-form" onSubmit={sendMagicLink}>
                    <label>
                      Email for cloud sync
                      <input
                        type="email"
                        value={cloudEmail}
                        onChange={(event) => setCloudEmail(event.target.value)}
                        placeholder="trainer@email.com"
                        autoComplete="email"
                        required
                      />
                    </label>
                    <button type="submit">Send magic link</button>
                  </form>
                )}

                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    setShowAdvancedAuth((value) => !value)
                    setAuthMode('password')
                  }}
                >
                  {showAdvancedAuth ? 'Hide advanced options' : 'Show advanced options'}
                </button>

                {showAdvancedAuth ? (
                  <p className="muted">Magic link can be rate-limited. Use password sign-in for daily use.</p>
                ) : null}
              </>
            )}

            <p className="muted">
              Cloud status:{' '}
              <strong>
                {cloudLoading
                  ? 'Syncing...'
                  : cloudUserId
                    ? 'Signed in and auto-saving'
                    : 'Not signed in'}
              </strong>
              {lastCloudSyncAt
                ? ` | Last sync: ${new Date(lastCloudSyncAt).toLocaleString('en-GB')}`
                : ''}
            </p>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>In-person clients and banked sessions</h2>
          <p>
            Rules: max 4 active banked sessions each, and each one expires after
            3 months.
          </p>
        </div>

        <form className="inline-form" onSubmit={addInPersonClient}>
          <label>
            Client name
            <input
              value={inPersonName}
              onChange={(event) => setInPersonName(event.target.value)}
              placeholder="e.g. Sarah Dean"
              required
            />
          </label>
          <button type="submit">Add in-person client</button>
        </form>

        <div className="quick-tools">
          <label>
            Quick bank today for
            <select
              value={quickClientId}
              onChange={(event) => setQuickClientId(event.target.value)}
            >
              <option value="">Pick client</option>
              {state.inPersonClients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ghost" onClick={quickBankToday}>
            Bank session today
          </button>
        </div>

        <div className="bulk-add">
          <label>
            Bulk add in-person clients (one per line)
            <textarea
              value={bulkInPersonNames}
              onChange={(event) => setBulkInPersonNames(event.target.value)}
              placeholder={`Amy\nJordan\nMegan`}
            />
          </label>
          <button type="button" className="ghost" onClick={addBulkInPersonClients}>
            Add all names
          </button>
        </div>

        <div className="client-grid">
          {state.inPersonClients.length === 0 ? (
            <p className="empty">No in-person clients yet.</p>
          ) : (
            state.inPersonClients.map((client) => {
              const activeSessions = client.bankedSessions.filter(
                (session) => !session.usedOn && !isExpired(session.expiresOn),
              )
              const expiredSessions = client.bankedSessions.filter(
                (session) => !session.usedOn && isExpired(session.expiresOn),
              )

              return (
                <article
                  key={client.id}
                  className={
                    expiredSessions.length > 0 ? 'client-card overdue-card' : 'client-card'
                  }
                >
                  <div className="client-row">
                    <h3>
                      {client.name}
                      {expiredSessions.length > 0 ? (
                        <span className="overdue-icon" aria-label="Has overdue sessions">
                          !
                        </span>
                      ) : null}
                    </h3>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => removeInPersonClient(client.id)}
                    >
                      Remove
                    </button>
                  </div>

                  <p className="mini-stats">
                    Active bank: <strong>{activeSessions.length}</strong>/4 | Expired
                    unused: <strong>{expiredSessions.length}</strong>
                  </p>

                  <div className="banking-row">
                    <label>
                      Banked on date
                      <input
                        type="date"
                        value={bankDateByClient[client.id] || todayIso()}
                        onChange={(event) =>
                          setBankDateByClient((current) => ({
                            ...current,
                            [client.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="button-row">
                    <button
                      type="button"
                      onClick={() =>
                        bankSession(client.id, bankDateByClient[client.id] || todayIso())
                      }
                    >
                      Bank 1 session
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => useOldestBankedSession(client.id)}
                    >
                      Use oldest banked session
                    </button>
                  </div>

                  {client.bankedSessions.length > 0 ? (
                    <ul className="session-list">
                      {client.bankedSessions
                        .slice()
                        .sort((a, b) => a.bankedOn.localeCompare(b.bankedOn))
                        .map((session) => {
                          const expired = !session.usedOn && isExpired(session.expiresOn)
                          return (
                            <li key={session.id}>
                              <span>
                                Banked {formatDate(session.bankedOn)} - expires{' '}
                                {formatDate(session.expiresOn)}
                              </span>
                              <strong
                                className={
                                  session.usedOn
                                    ? 'badge success'
                                    : expired
                                      ? 'badge danger'
                                      : 'badge neutral'
                                }
                              >
                                {session.usedOn
                                  ? `Used ${formatDate(session.usedOn)}`
                                  : expired
                                    ? 'Expired'
                                    : 'Available'}
                              </strong>
                            </li>
                          )
                        })}
                    </ul>
                  ) : null}
                </article>
              )
            })
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Online clients and monthly calls</h2>
          <p>Track last call date so you can instantly see what's due.</p>
        </div>

        <form className="inline-form online-form" onSubmit={addOnlineClient}>
          <label>
            Client name
            <input
              value={onlineName}
              onChange={(event) => setOnlineName(event.target.value)}
              placeholder="e.g. Maya Finn"
              required
            />
          </label>
          <label>
            Last call completed on
            <input
              type="date"
              value={onlineLastCallOn}
              onChange={(event) => setOnlineLastCallOn(event.target.value)}
              required
            />
          </label>
          <label>
            Notes
            <input
              value={onlineNotes}
              onChange={(event) => setOnlineNotes(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <button type="submit">Add online client</button>
        </form>

        <div className="client-grid">
          {state.onlineClients.length === 0 ? (
            <p className="empty">No online clients yet.</p>
          ) : (
            state.onlineClients.map((client) => {
              const nextDue = addMonths(client.lastCallOn, 1)
              const deltaDays = daysUntil(nextDue)
              const statusClass =
                deltaDays < 0 ? 'badge danger' : deltaDays <= 7 ? 'badge warn' : 'badge neutral'

              const statusText =
                deltaDays < 0
                  ? `Overdue by ${Math.abs(deltaDays)} day${Math.abs(deltaDays) === 1 ? '' : 's'}`
                  : deltaDays === 0
                    ? 'Due today'
                    : `Due in ${deltaDays} day${deltaDays === 1 ? '' : 's'}`

              return (
                <article
                  key={client.id}
                  className={
                    deltaDays < 0
                      ? 'client-card overdue-card'
                      : deltaDays <= 7
                        ? 'client-card due-soon-card'
                        : 'client-card'
                  }
                >
                  <div className="client-row">
                    <h3>
                      {client.name}
                      {deltaDays < 0 ? (
                        <span className="overdue-icon" aria-label="Overdue call">
                          !
                        </span>
                      ) : null}
                    </h3>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => removeOnlineClient(client.id)}
                    >
                      Remove
                    </button>
                  </div>

                  <p className="mini-stats">
                    Last call: <strong>{formatDate(client.lastCallOn)}</strong> | Next due:{' '}
                    <strong>{formatDate(nextDue)}</strong>
                  </p>

                  <p className="notes">{client.notes || 'No notes yet.'}</p>

                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => markOnlineCallDone(client.id)}
                    >
                      Call done today
                    </button>
                    <span className={statusClass}>{statusText}</span>
                  </div>
                </article>
              )
            })
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Tuesday + Friday schedule</h2>
          <p>Your week laid out clearly, sorted by time.</p>
        </div>

        <form className="inline-form schedule-form" onSubmit={addScheduleEntry}>
          <label>
            Client
            <input
              value={scheduleClientName}
              onChange={(event) => setScheduleClientName(event.target.value)}
              placeholder="Client name"
              required
            />
          </label>
          <label>
            Day
            <select
              value={scheduleDay}
              onChange={(event) => setScheduleDay(event.target.value as DayOfWork)}
            >
              <option value="Tuesday">Tuesday</option>
              <option value="Friday">Friday</option>
            </select>
          </label>
          <label>
            Time
            <input
              type="time"
              value={scheduleTime}
              onChange={(event) => setScheduleTime(event.target.value)}
              required
            />
          </label>
          <label>
            Notes
            <input
              value={scheduleNotes}
              onChange={(event) => setScheduleNotes(event.target.value)}
              placeholder="Gym floor / online warm-up / etc"
            />
          </label>
          <button type="submit">Add slot</button>
        </form>

        <div className="week-grid">
          {(['Tuesday', 'Friday'] as DayOfWork[]).map((day) => (
            <article key={day} className="day-column">
              <h3>{day}</h3>
              {groupedSchedule[day].length === 0 ? (
                <p className="empty">No sessions planned.</p>
              ) : (
                <ul>
                  {groupedSchedule[day].map((entry) => (
                    <li key={entry.id}>
                      <div>
                        <strong>{entry.time}</strong>
                        <p>{entry.clientName}</p>
                        {entry.notes ? <small>{entry.notes}</small> : null}
                      </div>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => removeScheduleEntry(entry.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App
