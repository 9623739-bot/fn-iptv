import http from "node:http"
import fs from "node:fs"
import { createHash } from "node:crypto"
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { channel, clearChannelCache, interfaceStr } from "./utils/appUtils.js";

// 运行时长
var hours = 0
const runtimeConfigPath = process.env.FN_IPTV_MIGU_CONFIG || "/migu-data/config.json"
const rateTypes = new Set(["auto", "2", "3", "4", "7", "9"])
const restartScheduleTypes = new Set(["off", "daily", "weekly", "monthly"])
const onlineDevices = new Map()
const onlineWindowMs = 60 * 1000
const maxRestartTimerMs = 24 * 60 * 60 * 1000
const segmentCacheTtlMs = 45 * 1000
const segmentCacheMaxBytes = 256 * 1024 * 1024
const segmentCache = new Map()
const segmentInflight = new Map()
let segmentCacheBytes = 0
const segmentStats = {
  startedAt: Date.now(),
  requests: 0,
  memoryHits: 0,
  inflightHits: 0,
  cacheMisses: 0,
  upstreamFetches: 0,
  upstreamBytes: 0,
  upstreamErrors: 0,
  cacheWrites: 0,
  evictions: 0,
  bytesServedFromMemory: 0
}
let restartTimer = null

function normalizeRateType(value) {
  const next = String(value || "auto").trim()
  return rateTypes.has(next) ? next : "auto"
}

function normalizeRestartIntervalHours(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, 720)
}

function normalizeRestartScheduleType(value) {
  const next = String(value || "off").trim()
  return restartScheduleTypes.has(next) ? next : "off"
}

function normalizeRestartWeekday(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < 0 || n > 6) return 1
  return n
}

function normalizeRestartMonthDay(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 31)
}

function normalizeRestartTime(value) {
  const text = String(value || "").trim()
  const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (!match) return "04:00"
  return `${match[1].padStart(2, "0")}:${match[2]}`
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1"
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

function scheduledDate(year, month, day, hour, minute) {
  return new Date(year, month, Math.min(day, daysInMonth(year, month)), hour, minute, 0, 0)
}

function nextScheduledRestartAt(config, now = new Date()) {
  const type = config.restartScheduleType
  if (type === "off") return null
  const [hour, minute] = config.restartScheduleTime.split(":").map((item) => parseInt(item, 10))
  if (type === "daily") {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }
  if (type === "weekly") {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
    let days = (config.restartScheduleWeekday - now.getDay() + 7) % 7
    if (days === 0 && next <= now) days = 7
    next.setDate(next.getDate() + days)
    return next
  }
  if (type === "monthly") {
    let next = scheduledDate(now.getFullYear(), now.getMonth(), config.restartScheduleMonthDay, hour, minute)
    if (next <= now) {
      next = scheduledDate(now.getFullYear(), now.getMonth() + 1, config.restartScheduleMonthDay, hour, minute)
    }
    return next
  }
  return null
}

function parseHiddenGroups(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "")
  return raw.split(/[,，;；\n\r]+/).map((item) => item.trim()).filter(Boolean)
}

function isHiddenGroup(group, hiddenGroups) {
  const current = String(group || "").trim()
  return parseHiddenGroups(hiddenGroups).some((hidden) => {
    return current === hidden || current.startsWith(`${hidden}-`) || current.startsWith(`${hidden}－`)
  })
}

function loadRuntimeConfig() {
  try {
    return JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"))
  } catch (error) {
    return {}
  }
}

function saveRuntimeConfig(config) {
  const dir = runtimeConfigPath.substring(0, runtimeConfigPath.lastIndexOf("/"))
  if (dir) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(runtimeConfigPath, JSON.stringify(config, null, 2))
}

function currentCreds() {
  const config = loadRuntimeConfig()
  const hasUserId = Object.prototype.hasOwnProperty.call(config, "userId")
  const hasToken = Object.prototype.hasOwnProperty.call(config, "token")
  return {
    userId: String(hasUserId ? config.userId : (userId || "")).trim(),
    token: String(hasToken ? config.token : (token || "")).trim(),
    rateType: normalizeRateType(config.rateType),
    hiddenGroups: parseHiddenGroups(config.hiddenGroups),
    lowLatencyMode: normalizeBoolean(config.lowLatencyMode),
    restartIntervalHours: normalizeRestartIntervalHours(config.restartIntervalHours),
    restartScheduleType: normalizeRestartScheduleType(config.restartScheduleType),
    restartScheduleWeekday: normalizeRestartWeekday(config.restartScheduleWeekday),
    restartScheduleMonthDay: normalizeRestartMonthDay(config.restartScheduleMonthDay),
    restartScheduleTime: normalizeRestartTime(config.restartScheduleTime)
  }
}

function restartService(reason, delayMs = 700) {
  printYellow(`准备重启服务: ${reason}`)
  setTimeout(() => process.exit(0), delayMs)
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
  const config = currentCreds()
  const candidates = []
  if (config.restartIntervalHours > 0) {
    candidates.push({ reason: "定时重启", at: Date.now() + config.restartIntervalHours * 60 * 60 * 1000 })
  }
  const scheduled = nextScheduledRestartAt(config)
  if (scheduled) {
    candidates.push({ reason: "计划重启", at: scheduled.getTime() })
  }
  const next = candidates.filter((item) => item.at > Date.now()).sort((a, b) => a.at - b.at)[0]
  if (!next) return
  const delayMs = Math.max(100, next.at - Date.now())
  restartTimer = setTimeout(() => {
    if (delayMs > maxRestartTimerMs) {
      scheduleRestart()
      return
    }
    restartService(next.reason, 100)
  }, Math.min(delayMs, maxRestartTimerMs))
  printGreen(`下次计划重启: ${new Date(next.at).toISOString()}`)
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  return forwarded || req.socket.remoteAddress || ""
}

function shortUserAgent(value) {
  return String(value || "未知播放器").split(/\s+/).slice(0, 3).join(" ")
}

function channelNameByPid(pid) {
  if (!pid) return ""
  const files = ["interfaceTXT.txt", "interface.txt"]
  const pidPattern = new RegExp(`/(?:migu/)?${pid}(?:[/?#]|$)`)
  for (const file of files) {
    try {
      const text = fs.readFileSync(`${process.cwd()}/${file}`, "utf8")
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const nextLine = i + 1 < lines.length ? lines[i + 1] : ""
        if (pidPattern.test(line)) {
          if (line.startsWith("#EXTINF")) return (line.match(/,(.*)$/) || [, ""])[1].trim()
          if (i > 0 && lines[i - 1].startsWith("#EXTINF")) return (lines[i - 1].match(/,(.*)$/) || [, ""])[1].trim()
          return (line.split(",")[0] || "").trim()
        }
        if (line.startsWith("#EXTINF") && pidPattern.test(nextLine)) {
          return (line.match(/,(.*)$/) || [, ""])[1].trim()
        }
        if (!line.startsWith("#EXTINF") && line.includes(",") && pidPattern.test(line.split(",").slice(1).join(","))) {
          return (line.split(",")[0] || "").trim()
        }
      }
    } catch (error) {}
  }
  return ""
}

function safeLogUrl(url) {
  if (String(url || "").startsWith("/proxy?")) {
    return "/proxy?url=<hidden>"
  }
  return url
}

function isLikelyPlaylistUrl(url) {
  return /\.m3u8(?:[?#]|$)/i.test(String(url || ""))
}

function isCacheableSegmentUrl(url) {
  return /\.(ts|m4s|mp4|aac)(?:[?#]|$)/i.test(String(url || ""))
}

function segmentCacheKey(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    return decodeURIComponent(parsed.pathname)
  } catch (error) {
    return String(targetUrl || "").split("?")[0]
  }
}

function touchDevice(req) {
  const ip = clientIp(req)
  const ua = shortUserAgent(req.headers["user-agent"])
  const id = `${ip}|${ua}`
  const old = onlineDevices.get(id)
  if (old) {
    old.lastActiveAt = Date.now()
    old.online = true
  }
}

function recordDevice(req, pid = "") {
  const ip = clientIp(req)
  const ua = shortUserAgent(req.headers["user-agent"])
  const id = `${ip}|${ua}`
  const now = Date.now()
  const old = onlineDevices.get(id) || {}
  onlineDevices.set(id, {
    id: createHash("sha256").update(id).digest("hex").slice(0, 12),
    ip,
    userAgent: ua,
    channelId: pid || old.channelId || "",
    channelName: (pid && channelNameByPid(pid)) || old.channelName || "",
    lastActiveAt: now,
    online: true
  })
}

function pruneSegmentCache() {
  const now = Date.now()
  for (const [key, item] of segmentCache) {
    if (item.expiresAt <= now) {
      segmentCache.delete(key)
      segmentCacheBytes -= item.size
      segmentStats.evictions += 1
    }
  }
  while (segmentCacheBytes > segmentCacheMaxBytes) {
    const oldest = segmentCache.keys().next().value
    if (!oldest) break
    const item = segmentCache.get(oldest)
    segmentCache.delete(oldest)
    segmentCacheBytes -= item ? item.size : 0
    segmentStats.evictions += 1
  }
}

function segmentCacheHeaders(proxied) {
  return {
    "Content-Type": proxied.contentType || "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Length": proxied.body.length,
    "X-Fn-Iptv-Cache": proxied.cacheHit ? "HIT" : "MISS"
  }
}

async function fetchSegmentCached(targetUrl) {
  segmentStats.requests += 1
  pruneSegmentCache()
  const cacheKey = segmentCacheKey(targetUrl)
  const now = Date.now()
  const cached = segmentCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    segmentCache.delete(cacheKey)
    segmentCache.set(cacheKey, cached)
    segmentStats.memoryHits += 1
    segmentStats.bytesServedFromMemory += cached.size
    return { ...cached.proxied, cacheHit: true }
  }
  if (segmentInflight.has(cacheKey)) {
    segmentStats.inflightHits += 1
    const proxied = await segmentInflight.get(cacheKey)
    return { ...proxied, cacheHit: true }
  }
  segmentStats.cacheMisses += 1
  segmentStats.upstreamFetches += 1
  const pending = fetchFollow(targetUrl).then((proxied) => {
    const size = proxied.body.length
    const status = proxied.status || 200
    segmentStats.upstreamBytes += size
    if (status >= 200 && status < 300 && size > 0 && size <= segmentCacheMaxBytes) {
      const previous = segmentCache.get(cacheKey)
      if (previous) {
        segmentCacheBytes -= previous.size
      }
      segmentCache.set(cacheKey, {
        proxied,
        size,
        expiresAt: Date.now() + segmentCacheTtlMs
      })
      segmentCacheBytes += size
      segmentStats.cacheWrites += 1
      pruneSegmentCache()
    }
    return proxied
  }).catch((error) => {
    segmentStats.upstreamErrors += 1
    throw error
  }).finally(() => {
    segmentInflight.delete(cacheKey)
  })
  segmentInflight.set(cacheKey, pending)
  const proxied = await pending
  return { ...proxied, cacheHit: false }
}

function segmentStatsPayload() {
  const reusableRequests = segmentStats.memoryHits + segmentStats.inflightHits
  return {
    startedAt: segmentStats.startedAt,
    uptimeSeconds: Math.max(0, Math.round((Date.now() - segmentStats.startedAt) / 1000)),
    requests: segmentStats.requests,
    memoryHits: segmentStats.memoryHits,
    inflightHits: segmentStats.inflightHits,
    reusableRequests,
    cacheMisses: segmentStats.cacheMisses,
    upstreamFetches: segmentStats.upstreamFetches,
    upstreamBytes: segmentStats.upstreamBytes,
    upstreamErrors: segmentStats.upstreamErrors,
    cacheWrites: segmentStats.cacheWrites,
    evictions: segmentStats.evictions,
    bytesServedFromMemory: segmentStats.bytesServedFromMemory,
    hitRate: segmentStats.requests ? Math.round((reusableRequests / segmentStats.requests) * 1000) / 10 : 0,
    currentSegments: segmentCache.size,
    currentBytes: Math.max(0, segmentCacheBytes),
    inflightRequests: segmentInflight.size,
    ttlSeconds: Math.round(segmentCacheTtlMs / 1000),
    maxBytes: segmentCacheMaxBytes
  }
}

function devicesPayload() {
  const now = Date.now()
  const devices = Array.from(onlineDevices.values()).map((item) => ({
    ...item,
    online: now - item.lastActiveAt <= onlineWindowMs,
    secondsAgo: Math.max(0, Math.round((now - item.lastActiveAt) / 1000))
  })).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return {
    onlineCount: devices.filter((item) => item.online).length,
    streamCache: segmentStatsPayload(),
    devices
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function stripCredsFromInterface(content, currentUserId, currentToken) {
  if (!content || !currentUserId || !currentToken) return content
  const plain = `/${currentUserId}/${currentToken}/`
  const encoded = `/${encodeURIComponent(currentUserId)}/${encodeURIComponent(currentToken)}/`
  return String(content).split(plain).join("/").split(encoded).join("/")
}

function filterM3uGroups(content, hiddenGroups) {
  if (!parseHiddenGroups(hiddenGroups).length) return content
  const lines = String(content || "").split(/\r?\n/)
  const result = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith("#EXTINF")) {
      const group = (line.match(/group-title="([^"]*)"/i) || [, ""])[1].trim()
      skipping = isHiddenGroup(group, hiddenGroups)
      if (!skipping) result.push(line)
      continue
    }
    if (skipping) {
      if (line && !line.startsWith("#")) skipping = false
      continue
    }
    result.push(line)
  }
  return result.join("\n")
}

function filterTxtGroups(content, hiddenGroups) {
  if (!parseHiddenGroups(hiddenGroups).length) return content
  const lines = String(content || "").split(/\r?\n/)
  const result = []
  let skipping = false
  for (const line of lines) {
    const groupMatch = line.match(/^(.+),#genre#\s*$/)
    if (groupMatch) {
      skipping = isHiddenGroup(groupMatch[1], hiddenGroups)
      if (!skipping) result.push(line)
      continue
    }
    if (!skipping) result.push(line)
  }
  return result.join("\n")
}

function filterInterfaceGroups(content, url, hiddenGroups) {
  if (String(content || "").trim().startsWith("#EXTM3U")) return filterM3uGroups(content, hiddenGroups)
  if (url === "/m3u" || url === "/main.m3u") return filterM3uGroups(content, hiddenGroups)
  if (url === "/txt" || url === "/interface.txt") return filterTxtGroups(content, hiddenGroups)
  return content
}

function playlistProxyUrl(targetUrl) {
  return `/migu/proxy?url=${encodeURIComponent(targetUrl)}`
}

function isPlaylist(contentType, url, body) {
  const type = String(contentType || "").toLowerCase()
  return type.includes("mpegurl") || type.includes("vnd.apple") || /\.m3u8(\?|$)/i.test(url) || body.toString("utf8", 0, 16).startsWith("#EXTM3U")
}

function rewritePlaylist(body, baseUrl) {
  return body.toString("utf8").split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      return line
    }
    try {
      return playlistProxyUrl(new URL(trimmed, baseUrl).href)
    } catch (error) {
      return line
    }
  }).join("\n")
}

async function fetchFollow(url, maxRedirects = 6) {
  let current = url
  for (let i = 0; i <= maxRedirects; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    let response
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Mobile Safari/537.36",
          "Referer": "https://www.miguvideo.com/"
        }
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) {
          throw new Error(`redirect without location: ${response.status}`)
        }
        current = new URL(location, current).href
        continue
      }
      const body = Buffer.from(await response.arrayBuffer())
      return {
        body,
        contentType: response.headers.get("content-type") || "",
        finalUrl: current,
        status: response.status
      }
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("upstream request timeout")
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error("too many redirects")
}

async function sendProxiedUrl(res, targetUrl, req = null, pid = "") {
  if (req) recordDevice(req, pid)
  const proxied = await fetchFollow(targetUrl)
  if (isPlaylist(proxied.contentType, proxied.finalUrl, proxied.body)) {
    res.writeHead(200, {
      "Content-Type": "application/vnd.apple.mpegurl;charset=UTF-8",
      "Cache-Control": "no-store"
    })
    res.end(rewritePlaylist(proxied.body, proxied.finalUrl))
    return
  }
  res.writeHead(proxied.status || 200, {
    "Content-Type": proxied.contentType || "application/octet-stream",
    "Cache-Control": "no-store"
  })
  res.end(proxied.body)
}

async function sendCachedSegmentUrl(res, targetUrl) {
  const proxied = await fetchSegmentCached(targetUrl)
  res.writeHead(proxied.status || 200, segmentCacheHeaders(proxied))
  res.end(proxied.body)
}

const server = http.createServer(async (req, res) => {
  // 获取请求方法、URL 和请求头
  let { method, url, headers } = req;
  // 身份认证
  if (pass != "") {
    const urlSplit = url.split("/")
    if (urlSplit[1] != pass) {
      printRed(`身份认证失败`)
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(`身份认证失败`); // 发送文件内容
      return
    } else {
      printGreen("身份认证成功")
      // 有密码且传入用户信息
      if (urlSplit.length > 3) {
        url = url.substring(pass.length + 1)
      } else {
        url = urlSplit.length == 2 ? "/" : "/" + urlSplit[urlSplit.length - 1]
      }
    }
  }

  let urlToken = ""
  let urlUserId = ""
  let currentConfig = currentCreds()
  let urlRateType = currentConfig.rateType
  let hiddenGroups = currentConfig.hiddenGroups
  let showAllGroups = false
  // 匹配是否存在用户信息
  if (/\/{1}[^\/\s]{1,}\/{1}[^\/\s]{1,}/.test(url)) {
    const urlSplit = url.split("/")
    if (urlSplit.length >= 3) {
      urlUserId = urlSplit[1]
      urlToken = urlSplit[2]
      url = urlSplit.length == 3 ? "/" : "/" + urlSplit[urlSplit.length - 1]
    }
  } else {
    currentConfig = currentCreds()
    urlUserId = currentConfig.userId
    urlToken = currentConfig.token
    urlRateType = currentConfig.rateType
    hiddenGroups = currentConfig.hiddenGroups
  }

  try {
    const requestUrl = new URL(`http://127.0.0.1${url}`)
    const requestPath = requestUrl.pathname
    showAllGroups = requestUrl.searchParams.get("all") === "1"
    if (["/", "/config", "/interface.txt", "/m3u", "/txt", "/playback.xml", "/main.m3u"].indexOf(requestPath) !== -1) {
      url = requestPath
    }
  } catch (error) {}

  // printGreen("")
  printMagenta("请求地址：" + safeLogUrl(url))

  if (method === "HEAD") {
    res.writeHead(200, {
      "Content-Type": "application/json;charset=UTF-8",
    });
    res.end();
    return;
  }

  if (url === "/config") {
    try {
      if (method === "GET") {
        const creds = currentCreds()
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({
          configured: !!(creds.userId && creds.token),
          rateType: creds.rateType,
          hiddenGroups: creds.hiddenGroups.join(","),
          lowLatencyMode: creds.lowLatencyMode,
          restartIntervalHours: creds.restartIntervalHours,
          restartScheduleType: creds.restartScheduleType,
          restartScheduleWeekday: creds.restartScheduleWeekday,
          restartScheduleMonthDay: creds.restartScheduleMonthDay,
          restartScheduleTime: creds.restartScheduleTime
        }))
      } else if (method === "POST") {
        const oldConfig = loadRuntimeConfig()
        const body = JSON.parse(await readBody(req) || "{}")
        const clearCredentials = body.clearCredentials === true
        const nextUserId = clearCredentials
          ? ""
          : String(body.userId || oldConfig.userId || userId || "").trim()
        const nextToken = clearCredentials
          ? ""
          : String(body.token || oldConfig.token || token || "").trim()
        const nextRateType = normalizeRateType(body.rateType)
        const nextHiddenGroups = Object.prototype.hasOwnProperty.call(body, "hiddenGroups")
          ? parseHiddenGroups(body.hiddenGroups)
          : parseHiddenGroups(oldConfig.hiddenGroups)
        const nextLowLatencyMode = normalizeBoolean(body.lowLatencyMode)
        const nextRestartIntervalHours = normalizeRestartIntervalHours(body.restartIntervalHours)
        const nextRestartScheduleType = normalizeRestartScheduleType(body.restartScheduleType)
        const nextRestartScheduleWeekday = normalizeRestartWeekday(body.restartScheduleWeekday)
        const nextRestartScheduleMonthDay = normalizeRestartMonthDay(body.restartScheduleMonthDay)
        const nextRestartScheduleTime = normalizeRestartTime(body.restartScheduleTime)
        saveRuntimeConfig({
          userId: nextUserId,
          token: nextToken,
          rateType: nextRateType,
          hiddenGroups: nextHiddenGroups,
          lowLatencyMode: nextLowLatencyMode,
          restartIntervalHours: nextRestartIntervalHours,
          restartScheduleType: nextRestartScheduleType,
          restartScheduleWeekday: nextRestartScheduleWeekday,
          restartScheduleMonthDay: nextRestartScheduleMonthDay,
          restartScheduleTime: nextRestartScheduleTime
        })
        clearChannelCache()
        scheduleRestart()
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({
          ok: true,
          configured: !!(nextUserId && nextToken),
          rateType: nextRateType,
          hiddenGroups: nextHiddenGroups.join(","),
          lowLatencyMode: nextLowLatencyMode,
          restartIntervalHours: nextRestartIntervalHours,
          restartScheduleType: nextRestartScheduleType,
          restartScheduleWeekday: nextRestartScheduleWeekday,
          restartScheduleMonthDay: nextRestartScheduleMonthDay,
          restartScheduleTime: nextRestartScheduleTime
        }))
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ error: "method not allowed" }))
      }
    } catch (error) {
      printRed(error.message)
      res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ error: error.message }))
    }
    return
  }

  if (url === "/devices") {
    res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify(devicesPayload()))
    return
  }

  if (url === "/restart") {
    res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify({ ok: true }))
    restartService("手动重启")
    return
  }

  if (method != "GET") {
    res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify({
      data: '请使用GET请求',
    }));
    printRed(`使用非GET请求:${method}`)
    return
  }

  const interfaceList = "/,/interface.txt,/m3u,/txt,/playback.xml,/main.m3u"

  if (url.startsWith("/proxy?")) {
    try {
      const targetUrl = new URL(`http://127.0.0.1${url}`).searchParams.get("url")
      if (!targetUrl) {
        throw new Error("missing proxy url")
      }
      const pid = new URL(targetUrl).searchParams.get("ProgramID") || ""
      if (isLikelyPlaylistUrl(targetUrl)) {
        await sendProxiedUrl(res, targetUrl, req, pid)
      } else if (isCacheableSegmentUrl(targetUrl)) {
        touchDevice(req)
        await sendCachedSegmentUrl(res, targetUrl)
      } else {
        touchDevice(req)
        await sendProxiedUrl(res, targetUrl)
      }
    } catch (error) {
      printRed(error.message)
      res.writeHead(502, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(error.message)
    }
    return
  }

  // 接口
  if (interfaceList.indexOf(url) !== -1) {
    const interfaceObj = interfaceStr(url, headers, urlUserId, urlToken)
    if (interfaceObj.content == null) {
      interfaceObj.content = "获取失败"
    }
    // 设置响应头
    res.setHeader('Content-Type', interfaceObj.contentType);
    if (url == "/m3u") {
      res.setHeader('content-disposition', "inline; filename=\"interface.m3u\"");
    }
    res.statusCode = 200;
    let content = stripCredsFromInterface(interfaceObj.content, urlUserId, urlToken)
    if (!showAllGroups) {
      content = filterInterfaceGroups(content, url, hiddenGroups)
    }
    res.end(content); // 发送文件内容
    return
  }

  // 频道
  const pid = (url.split("/")[1] || "").split("?")[0]
  recordDevice(req, pid)
  const result = await channel(url, urlUserId, urlToken, urlRateType)

  // 结果异常
  if (result.code != 302) {

    printRed(result.desc)
    res.writeHead(result.code, {
      'Content-Type': 'application/json;charset=UTF-8',
    });
    res.end(result.desc)
    return
  }

  try {
    await sendProxiedUrl(res, result.playURL, req, pid)
  } catch (error) {
    printRed(error.message)
    res.writeHead(502, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(error.message)
  }
})

server.listen(port, async () => {
  const updateInterval = parseInt(programInfoUpdateInterval)
  scheduleRestart()
  // 更新
  setInterval(async () => {
    printBlue(`准备更新文件 ${getDateTimeStr(new Date())}`)
    hours += updateInterval
    try {
      await update(hours)
    } catch (error) {
      console.log(error)
      printRed("更新失败")
    }

    printBlue(`当前已运行${hours}小时`)
  }, updateInterval * 60 * 60 * 1000);

  try {
    // 初始化数据
    await update(hours)
  } catch (error) {
    console.log(error)
    printRed("更新失败")
  }

  printGreen(`本地地址: http://localhost:${port}${pass == "" ? "" : "/" + pass}`)
  printGreen(`本程序完全免费，如果您是通过付费渠道获取，那么恭喜你成功被骗了`)
  printGreen("开源地址: https://github.com/develop202/migu_video 欢迎issue 感谢star")
  if (host != "") {
    printGreen(`自定义地址: ${host}${pass == "" ? "" : "/" + pass}`)
  }
})
