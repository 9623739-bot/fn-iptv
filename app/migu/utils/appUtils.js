import { get302URL, getAndroidURL, getAndroidURL720p, printLoginInfo } from "./androidURL.js";
import { createHash } from "node:crypto";
import { readFileSync } from "./fileUtil.js";
import { host, pass, rateType as defaultRateType, token, userId } from "../config.js";
import { printDebug, printGreen, printGrey, printRed, printYellow } from "./colorOut.js";

// url缓存 降低请求频率
const urlCache = {}
const preferredRateCache = {}
const autoRateTypes = ["9", "7", "4", "3", "2"]

function cacheScope(urlUserId, urlToken) {
  if (!urlUserId || !urlToken) return "anonymous"
  return createHash("sha256").update(`${urlUserId}:${urlToken}`).digest("hex").slice(0, 16)
}

function clearChannelCache() {
  Object.keys(urlCache).forEach((key) => {
    delete urlCache[key]
  })
  printGreen("已清空播放缓存")
}

function normalizeFetchError(error) {
  if (error && error.name === "AbortError") {
    return new Error("upstream request timeout")
  }
  return error
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Mobile Safari/537.36",
        "Referer": "https://www.miguvideo.com/",
        ...(options.headers || {})
      }
    })
    return {
      ok: response.ok,
      text: await response.text(),
      url: response.url || url
    }
  } catch (error) {
    throw normalizeFetchError(error)
  } finally {
    clearTimeout(timer)
  }
}

async function validatePlaylistUrl(playUrl, depth = 0) {
  if (!playUrl || depth > 2) return false
  const response = await fetchTextWithTimeout(playUrl, { cache: "no-store" })
  if (!response.ok) return false
  if (!response.text.trim().startsWith("#EXTM3U")) return false
  const mediaLine = response.text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"))
  if (!mediaLine) return false
  const mediaUrl = new URL(mediaLine, response.url || playUrl).href
  if (/\.m3u8(\?|$)/i.test(mediaUrl)) return validatePlaylistUrl(mediaUrl, depth + 1)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const segmentResponse = await fetch(mediaUrl, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Mobile Safari/537.36",
        "Referer": "https://www.miguvideo.com/",
        "Range": "bytes=0-1"
      }
    })
    if (segmentResponse.body) {
      try { await segmentResponse.body.cancel() } catch (error) {}
    }
    return segmentResponse.ok
  } catch (error) {
    throw normalizeFetchError(error)
  } finally {
    clearTimeout(timer)
  }
}

function prioritizedAutoRates(preferredRateType) {
  if (!preferredRateType || !autoRateTypes.includes(preferredRateType)) {
    return autoRateTypes
  }
  return [preferredRateType].concat(autoRateTypes.filter((item) => item !== preferredRateType))
}

function interfaceStr(url, headers, urlUserId, urlToken) {

  let result = {
    content: null,
    contentType: 'text/plain;charset=UTF-8'
  }
  let fileName = process.cwd() + "/interface.txt"
  switch (url) {
    case "/playback.xml":
      fileName = process.cwd() + "/playback.xml"
      result.contentType = "text/xml;charset=UTF-8"
      break;

    case "/txt":
      fileName = process.cwd() + "/interfaceTXT.txt"
      break;

    case "/m3u":
      result.contentType = "audio/x-mpegurl; charset=utf-8"
      break;

    case "/main.m3u":
      result.contentType = "application/octet-stream; charset=utf-8"
      break;

    default:
      break;
  }
  try {
    result.content = readFileSync(fileName)
  } catch (error) {
    printRed("文件获取失败")
    console.log(error)
    return result
  }
  if (url == "/playback.xml") {
    return result
  }

  let replaceHost = `http://${headers.host}`

  if (host != "" && (headers["x-real-ip"] || headers["x-forwarded-for"] || host.indexOf(headers.host) != -1)) {
    replaceHost = host
  }

  if (pass != "") {
    replaceHost = `${replaceHost}/${pass}`
  }

  if (urlUserId != userId && urlToken != token) {
    replaceHost = `${replaceHost}/${urlUserId}/${urlToken}`
  }

  result.content = `${result.content}`.replaceAll("${replace}", replaceHost);

  return result
}

async function channel(url, urlUserId, urlToken, runtimeRateType) {

  let result = {
    code: 200,
    pID: "",
    desc: "服务异常",
    playURL: ""
  }
  // 处理频道ID
  let urlSplit = url.split("/")[1]
  let pid = urlSplit
  let params = ""
  const selectedRateType = String(runtimeRateType || defaultRateType || "auto")

  // 处理回放参数
  if (urlSplit.match(/\?/)) {
    printGreen("处理传入参数")

    const urlSplit1 = urlSplit.split("?")
    pid = urlSplit1[0]
    params = urlSplit1[1]
  } else {
    printGrey("无参数传入")
  }

  const accountScope = cacheScope(urlUserId, urlToken)
  const cacheKey = `${pid}:${params}:${selectedRateType}:${accountScope}`
  const preferredRateKey = `${pid}:${accountScope}`

  if (isNaN(pid)) {
    result.desc = "地址格式错误"
    return result
  }

  printYellow("频道ID " + pid)

  // 是否存在缓存
  const cache = channelCache(cacheKey, pid, params)
  if (cache.haveCache) {
    result.code = cache.code
    result.playURL = cache.playURL
    result.desc = cache.cacheDesc
    return result
  }

  let resObj = {}
  const requestedRateTypes = selectedRateType === "auto" ? prioritizedAutoRates(preferredRateCache[preferredRateKey]) : [selectedRateType]
  try {
    for (const rateType of requestedRateTypes) {
      printYellow(`尝试清晰度 ${rateType}`)
      try {
        // 未登录请求720p
        if (Number(rateType) >= 3 && (urlUserId == "" || urlToken == "")) {
          resObj = await getAndroidURL720p(pid)
        } else {
          resObj = await getAndroidURL(urlUserId, urlToken, pid, rateType)
        }
      } catch (error) {
        console.log(error)
        resObj = { url: "", content: { message: "链接请求出错" } }
      }
      if (resObj.url != "") {
        if (selectedRateType === "auto") {
          let canPlay = false
          try {
            canPlay = await validatePlaylistUrl(resObj.url)
          } catch (error) {
            printYellow(`清晰度 ${rateType} 链接验证超时或出错，尝试降级`)
          }
          if (!canPlay) {
            printYellow(`清晰度 ${rateType} 链接验证失败，尝试降级`)
            resObj = { url: "", content: { message: "播放链接验证失败" } }
            continue
          }
        }
        printGreen(`清晰度 ${rateType} 获取成功`)
        if (selectedRateType === "auto") {
          preferredRateCache[preferredRateKey] = rateType
        }
        break
      }
      printYellow(`清晰度 ${rateType} 获取失败，尝试降级`)
    }
  } catch (error) {
    console.log(error)
    result.desc = "链接请求出错"
    return result
  }
  printDebug(`添加加密字段后链接 ${resObj.url}`)


  // 可以正确跳转了 不需要再手动过滤了
  // if (resObj.url != "") {
  //   const location = await get302URL(resObj)
  //   if (location != "") {
  //     resObj.url = location
  //   }
  // }
  printLoginInfo(resObj)
  // printRed(resObj.url)
  printGreen(`添加节目缓存 ${pid}`)
  // 缓存有效时长
  let addTime = 10 * 60 * 1000
  // 节目调整
  if (resObj.url == "") {
    addTime = 15 * 1000
  }
  // 加入缓存
  urlCache[cacheKey] = {
    // 成功链接缓存10分钟，失败结果缓存15秒
    valTime: Date.now() + addTime,
    url: resObj.url,
    content: resObj.content,
  }

  if (resObj.url == "") {
    let msg = resObj.content != null ? resObj.content.message : "节目调整，暂不提供服务"
    result.desc = `${pid} ${msg}`
    return result
  }
  let playURL = resObj.url

  // 添加回放参数
  if (params != "") {
    const resultParams = new URLSearchParams(params);
    for (const [key, value] of resultParams) {
      playURL = `${playURL}&${key}=${value}`
    }
  }

  printGreen("链接获取成功")
  result.code = 302
  result.playURL = playURL
  return result
}

function channelCache(cacheKey, pid, params) {
  let cache = {
    haveCache: false,
    code: 200,
    pID: "",
    playURL: "",
    cacheDesc: ""
  }
  if (typeof urlCache[cacheKey] === "object") {
    const valTime = urlCache[cacheKey].valTime - Date.now()
    // 缓存是否有效
    if (valTime >= 0) {
      cache.haveCache = true
      let playURL = urlCache[cacheKey].url
      let msg = "节目调整，暂不提供服务"
      if (urlCache[cacheKey].content != null) {
        printLoginInfo(urlCache[cacheKey])
        msg = urlCache[cacheKey].content.message
      }
      // 节目调整
      if (playURL == "") {
        cache.cacheDesc = `${pid} ${msg}`
        return cache
      }

      // 添加回放参数
      if (params != "") {
        const resultParams = new URLSearchParams(params);
        for (const [key, value] of resultParams) {
          playURL = `${playURL}&${key}=${value}`
        }
      }
      printGreen("使用缓存数据")
      cache.code = 302
      cache.cacheDesc = "缓存获取成功"
      cache.playURL = playURL
      return cache
    }
  }
  cache.cacheDesc = "暂无缓存"
  return cache
}

export { interfaceStr, channel, channelCache, clearChannelCache }
