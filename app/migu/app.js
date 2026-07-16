import http from "node:http"
import fs from "node:fs"
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { printBlue, printGreen, printMagenta, printRed } from "./utils/colorOut.js";
import { delay } from "./utils/fetchList.js";
import { channel, interfaceStr } from "./utils/appUtils.js";

// 运行时长
var hours = 0
let loading = false
const runtimeConfigPath = process.env.FN_IPTV_MIGU_CONFIG || "/migu-data/config.json"
const rateTypes = new Set(["2", "3", "4", "7", "9"])

function normalizeRateType(value) {
  const next = String(value || "3").trim()
  return rateTypes.has(next) ? next : "3"
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
  return {
    userId: String(config.userId || userId || "").trim(),
    token: String(config.token || token || "").trim(),
    rateType: normalizeRateType(config.rateType),
    hiddenGroups: parseHiddenGroups(config.hiddenGroups)
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
    const response = await fetch(current, {
      redirect: "manual",
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
  }
  throw new Error("too many redirects")
}

async function sendProxiedUrl(res, targetUrl) {
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

const server = http.createServer(async (req, res) => {

  while (loading) {
    await delay(50)
  }

  loading = true

  // 获取请求方法、URL 和请求头
  let { method, url, headers } = req;
  // 身份认证
  if (pass != "") {
    const urlSplit = url.split("/")
    if (urlSplit[1] != pass) {
      printRed(`身份认证失败`)
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(`身份认证失败`); // 发送文件内容
      loading = false
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
  printMagenta("请求地址：" + url)

  if (method === "HEAD") {
    res.writeHead(200, {
      "Content-Type": "application/json;charset=UTF-8",
    });
    res.end();
    loading = false;
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
          hiddenGroups: creds.hiddenGroups.join(",")
        }))
      } else if (method === "POST") {
        const oldConfig = loadRuntimeConfig()
        const body = JSON.parse(await readBody(req) || "{}")
        const nextUserId = String(body.userId || "").trim()
        const nextToken = String(body.token || "").trim()
        const nextRateType = normalizeRateType(body.rateType)
        const nextHiddenGroups = Object.prototype.hasOwnProperty.call(body, "hiddenGroups")
          ? parseHiddenGroups(body.hiddenGroups)
          : parseHiddenGroups(oldConfig.hiddenGroups)
        if (!nextUserId || !nextToken) {
          res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ error: "missing userId or token" }))
        } else {
          saveRuntimeConfig({ userId: nextUserId, token: nextToken, rateType: nextRateType, hiddenGroups: nextHiddenGroups })
          res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ ok: true, rateType: nextRateType, hiddenGroups: nextHiddenGroups.join(",") }))
        }
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ error: "method not allowed" }))
      }
    } catch (error) {
      printRed(error.message)
      res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ error: error.message }))
    }
    loading = false
    return
  }

  if (method != "GET") {
    res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify({
      data: '请使用GET请求',
    }));
    printRed(`使用非GET请求:${method}`)

    loading = false
    return
  }

  const interfaceList = "/,/interface.txt,/m3u,/txt,/playback.xml,/main.m3u"

  if (url.startsWith("/proxy?")) {
    try {
      const targetUrl = new URL(`http://127.0.0.1${url}`).searchParams.get("url")
      if (!targetUrl) {
        throw new Error("missing proxy url")
      }
      await sendProxiedUrl(res, targetUrl)
    } catch (error) {
      printRed(error.message)
      res.writeHead(502, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(error.message)
    }
    loading = false
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
    loading = false
    return
  }

  // 频道
  const result = await channel(url, urlUserId, urlToken, urlRateType)

  // 结果异常
  if (result.code != 302) {

    printRed(result.desc)
    res.writeHead(result.code, {
      'Content-Type': 'application/json;charset=UTF-8',
    });
    res.end(result.desc)
    loading = false
    return
  }

  try {
    await sendProxiedUrl(res, result.playURL)
  } catch (error) {
    printRed(error.message)
    res.writeHead(502, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(error.message)
  }

  loading = false
})

server.listen(port, async () => {
  const updateInterval = parseInt(programInfoUpdateInterval)
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
