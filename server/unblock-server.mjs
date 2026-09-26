/**
 * 网页端 Unblock 服务（独立 Node.js 实现）
 *
 * 用途：在 Docker / Railway 等 web 部署下替代 electron/server/unblock 的 Fastify 路由。
 *      前端 unlockSongUrl 调用 /api/unblock/<server>，nginx 反代到本服务。
 *
 * 端口：默认 25885，可通过 UNBLOCK_API_PORT 环境变量覆盖。
 *
 * 端点：
 *   GET /unblock/netease?id=xxx
 *   GET /unblock/kuwo?keyword=xxx&songName=xxx&artist=xxx
 *   GET /unblock/bodian?keyword=xxx&songName=xxx&artist=xxx
 *
 * 返回：{ code: number, url: string | null }
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { encryptQuery } from "../electron/server/unblock/kwDES.js";

const PORT = Number(process.env.UNBLOCK_API_PORT || 25885);
const HOST = process.env.UNBLOCK_API_HOST || "127.0.0.1";

// 通用 UA
const UA_KUWO = "okhttp/3.10.0";
const UA_BODIAN = "Dart/2.19 (dart:io)";

// ============== 匹配工具 ==============
const normalizeName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();

const normalizeArtist = (artist) =>
  String(artist || "")
    .toLowerCase()
    .replace(/[&/、，,;；]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isSongMatch = (resultName, resultArtist, match) => {
  const normalizedResult = normalizeName(resultName);
  const normalizedOriginal = normalizeName(match.songName);
  if (!normalizedResult) return false;
  if (normalizedOriginal) {
    if (
      !normalizedResult.includes(normalizedOriginal) &&
      !normalizedOriginal.includes(normalizedResult)
    ) {
      return false;
    }
  }
  if (resultArtist && match.artist) {
    const a = normalizeArtist(resultArtist);
    const b = normalizeArtist(match.artist);
    if (a && b) {
      if (!a.includes(b) && !b.includes(a)) return false;
    }
  }
  return true;
};

// 从 query 构造匹配信息
const buildMatchInfo = (query) => {
  let songName = query.songName || "";
  let artist = query.artist || "";
  if (!songName && query.keyword) {
    const lastIdx = query.keyword.lastIndexOf("-");
    if (lastIdx > 0) {
      songName = query.keyword.slice(0, lastIdx).trim();
      artist = artist || query.keyword.slice(lastIdx + 1).trim();
    } else {
      songName = query.keyword.trim();
    }
  }
  return { keyword: query.keyword || "", songName, artist };
};

// ============== Netease（GD音乐台公网 API） ==============
const getNeteaseSongUrl = async (id) => {
  if (!id) return { code: 404, url: null };
  try {
    const url = `https://music-api.gdstudio.xyz/api.php?types=url&id=${encodeURIComponent(id)}`;
    const res = await fetch(url);
    if (!res.ok) return { code: 404, url: null };
    const data = await res.json();
    console.log("🔗 NeteaseSongUrl URL:", data?.url);
    return { code: 200, url: data?.url || null };
  } catch (e) {
    console.error("❌ Get NeteaseSongUrl Error:", e);
    return { code: 404, url: null };
  }
};

// ============== Kuwo ==============
const getKuwoSongId = async (match) => {
  try {
    const keyword = encodeURIComponent(match.keyword);
    const url =
      "http://search.kuwo.cn/r.s?&correct=1&stype=comprehensive&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=" +
      keyword;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (
      !data ||
      data.content.length < 2 ||
      !data.content[1].musicpage ||
      data.content[1].musicpage.abslist.length < 1
    ) {
      return null;
    }
    for (const item of data.content[1].musicpage.abslist) {
      const songId = item?.MUSICRID;
      if (!songId) continue;
      if (isSongMatch(item?.SONGNAME || "", item?.ARTIST || "", match)) {
        return songId.slice("MUSIC_".length);
      }
    }
    console.warn(`⚠️ Kuwo 搜索结果均不匹配原曲: "${match.songName}"`);
    return null;
  } catch (e) {
    console.error("❌ Get KuwoSongId Error:", e);
    return null;
  }
};

const getKuwoSongUrl = async (match) => {
  try {
    if (!match.keyword) return { code: 404, url: null };
    const songId = await getKuwoSongId(match);
    if (!songId) return { code: 404, url: null };
    const PackageName = "kwplayer_ar_5.1.0.0_B_jiakong_vh.apk";
    const url =
      "http://mobi.kuwo.cn/mobi.s?f=kuwo&q=" +
      encryptQuery(
        `corp=kuwo&source=${PackageName}&p2p=1&type=convert_url2&sig=0&format=mp3&rid=${songId}`,
      );
    const res = await fetch(url, { headers: { "User-Agent": UA_KUWO } });
    if (!res.ok) return { code: 404, url: null };
    const text = await res.text();
    const urlMatch = text.match(/http[^\s$"]+/);
    if (urlMatch) {
      console.log("🔗 KuwoSong URL:", urlMatch[0]);
      return { code: 200, url: urlMatch[0] };
    }
    return { code: 404, url: null };
  } catch (e) {
    console.error("❌ Get KuwoSong URL Error:", e);
    return { code: 404, url: null };
  }
};

// ============== Bodian ==============
const getRandomDeviceId = () => {
  const min = 0;
  const max = 100000000000;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
};
const deviceId = getRandomDeviceId();

const formatBodian = (song) => ({
  id: song.MUSICRID.split("_").pop(),
  name: song.SONGNAME,
  duration: song.DURATION * 1000,
  album: { id: song.ALBUMID, name: song.ALBUM },
  artists: song.ARTIST.split("&").map((name, index) => ({
    id: index ? null : song.ARTISTID,
    name,
  })),
});

const searchBodian = async (match) => {
  try {
    const keyword = encodeURIComponent(match.keyword.replace(" - ", " "));
    const url =
      "http://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8" +
      "&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=" +
      keyword;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (
      !data ||
      data.content.length < 2 ||
      !data.content[1].musicpage ||
      data.content[1].musicpage.abslist.length < 1
    ) {
      return null;
    }
    const list = data.content[1].musicpage.abslist.map(formatBodian);
    for (const item of list) {
      if (!item?.id) continue;
      const artistStr = item.artists?.map((a) => a.name).join("&") || "";
      if (isSongMatch(item.name || "", artistStr, match)) {
        return item.id;
      }
    }
    console.warn(`⚠️ Bodian 搜索结果均不匹配原曲: "${match.songName}"`);
    return null;
  } catch (e) {
    console.error("❌ Get BodianSongId Error:", e);
    return null;
  }
};

const generateSign = (str) => {
  const url = new URL(str);
  const currentTime = Date.now();
  str += `&timestamp=${currentTime}`;
  const filteredChars = str
    .substring(str.indexOf("?") + 1)
    .replace(/[^a-zA-Z0-9]/g, "")
    .split("")
    .sort();
  const dataToEncrypt = `kuwotest${filteredChars.join("")}${url.pathname}`;
  const md5 = createHash("md5").update(dataToEncrypt).digest("hex");
  return `${str}&sign=${md5}`;
};

const sendBodianAdFreeRequest = async () => {
  try {
    const adurl =
      "http://bd-api.kuwo.cn/api/service/advert/watch?uid=-1&token=&timestamp=1724306124436&sign=15a676d66285117ad714e8c8371691da";
    const headers = {
      "user-agent": UA_BODIAN,
      plat: "ar",
      channel: "aliopen",
      devid: deviceId,
      ver: "3.9.0",
      host: "bd-api.kuwo.cn",
      qimei36: "1e9970cbcdc20a031dee9f37100017e1840e",
      "content-type": "application/json; charset=utf-8",
    };
    const body = JSON.stringify({
      type: 5,
      subType: 5,
      musicId: 0,
      adToken: "",
    });
    await fetch(adurl, { method: "POST", headers, body }).catch(() => {});
  } catch (e) {
    console.error("❌ Get Bodian Ad Free Error:", e);
  }
};

const getBodianSongUrl = async (match) => {
  try {
    if (!match.keyword) return { code: 404, url: null };
    const songId = await searchBodian(match);
    if (!songId) return { code: 404, url: null };
    const headers = {
      "user-agent": UA_BODIAN,
      plat: "ar",
      channel: "aliopen",
      devid: deviceId,
      ver: "3.9.0",
      host: "bd-api.kuwo.cn",
      "X-Forwarded-For": "1.0.1.114",
    };
    let audioUrl = `http://bd-api.kuwo.cn/api/play/music/v2/audioUrl?&br=${"320kmp3"}&musicId=${songId}`;
    audioUrl = generateSign(audioUrl);
    await sendBodianAdFreeRequest();
    const res = await fetch(audioUrl, { headers });
    if (!res.ok) return { code: 404, url: null };
    const data = await res.json();
    if (typeof data === "object" && data?.data?.audioUrl) {
      console.log("🔗 BodianSong URL:", data.data.audioUrl);
      return { code: 200, url: data.data.audioUrl };
    }
    return { code: 404, url: null };
  } catch (e) {
    console.error("❌ Get BodianSong URL Error:", e);
    return { code: 404, url: null };
  }
};

// ============== 路由 ==============
const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const parseQuery = (urlStr) => {
  const idx = urlStr.indexOf("?");
  if (idx === -1) return {};
  const params = new URLSearchParams(urlStr.slice(idx + 1));
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
};

// ============== 媒体代理（解决 web 端 crossOrigin + CORS 问题） ==============
// 第三方音源（酷我/波点的腾讯 COS、网易 CDN）不返回 CORS 头，
// 而 AudioElementPlayer 强制 crossOrigin="anonymous"（为了频谱/均衡器），
// 导致浏览器拒绝加载。本代理把这些音源包装为同源资源。
// 透传 Range 请求头，支持拖动进度条（206 Partial Content）。

const MEDIA_PROXY_ALLOWED_HOSTS = [
  "music.126.net",        // 网易云官方 CDN
  "m701.music.126.net",
  "m704.music.126.net",
  "m801.music.126.net",
  "m804.music.126.net",
  "music.163.com",
  "interface.music.163.com",
  "kuwo.cn",              // 酷我/波点
  "bd-api.kuwo.cn",
  "search.kuwo.cn",
  "mobi.kuwo.cn",
  "gdstudio.xyz",         // GD音乐台
  "music-api.gdstudio.xyz",
  "myqcloud.com",         // 腾讯 COS（酷我/波点常用）
  "oss-cn-hangzhou.aliyuncs.com",  // 阿里 OSS（备用）
];

const isHostAllowed = (hostname) => {
  const h = hostname.toLowerCase();
  return MEDIA_PROXY_ALLOWED_HOSTS.some((allowed) =>
    h === allowed || h.endsWith("." + allowed),
  );
};

// 媒体代理需要透传的请求头
const PROXY_REQUEST_HEADERS = [
  "range",
  "user-agent",
  "accept",
  "accept-encoding",
  "referer",
];

// 媒体代理需要透传的响应头
const PROXY_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
];

const handleMediaProxy = async (req, res) => {
  const url = req.url || "";
  const { url: targetUrl } = parseQuery(url);
  if (!targetUrl) {
    sendJson(res, 400, { error: "Missing 'url' parameter" });
    return;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    sendJson(res, 400, { error: "Invalid url" });
    return;
  }

  // 域名白名单
  if (!isHostAllowed(parsed.hostname)) {
    console.warn(`⚠️ mediaproxy blocked: ${parsed.hostname}`);
    sendJson(res, 403, {
      error: "Host not allowed",
      host: parsed.hostname,
    });
    return;
  }

  // 协议白名单（仅 http/https）
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    sendJson(res, 400, { error: "Only http/https allowed" });
    return;
  }

  // 构造转发请求头
  const forwardHeaders = {};
  for (const key of PROXY_REQUEST_HEADERS) {
    const v = req.headers[key];
    if (v) forwardHeaders[key] = v;
  }
  // 修正 Host：必须用目标域名，不能用本机
  forwardHeaders.host = parsed.hostname;
  // 修正 Referer：部分 CDN 校验 Referer，给个合理的
  if (!forwardHeaders.referer) {
    forwardHeaders.referer = `${parsed.protocol}//${parsed.hostname}/`;
  }

  console.log(`🔄 mediaproxy: ${parsed.href.substring(0, 100)}`);

  try {
    const upstream = await fetch(parsed.href, {
      method: req.method,
      headers: forwardHeaders,
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error(`❌ mediaproxy upstream ${upstream.status}: ${parsed.href.substring(0, 80)}`);
      sendJson(res, upstream.status, {
        error: "Upstream error",
        status: upstream.status,
      });
      return;
    }

    // 透传响应头
    const respHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Cache-Control": "public, max-age=3600",
    };
    for (const key of PROXY_RESPONSE_HEADERS) {
      const v = upstream.headers.get(key);
      if (v) respHeaders[key] = v;
    }
    // 没有 Content-Length 时禁用缓冲（流式）
    if (!respHeaders["content-length"]) {
      respHeaders["transfer-encoding"] = "chunked";
    }

    res.writeHead(upstream.status, respHeaders);
    // 流式转发 body
    const reader = upstream.body?.getReader();
    if (reader) {
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
        res.end();
      };
      pump().catch((e) => {
        console.error("❌ mediaproxy stream error:", e);
        // 客户端可能已断开，安全关闭即可
        try { res.end(); } catch (err) { console.error("res.end failed:", err); }
      });
    } else {
      res.end();
    }
  } catch (e) {
    console.error("❌ mediaproxy fetch error:", e);
    sendJson(res, 502, { error: "Upstream fetch failed", detail: String(e) });
  }
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = req.url || "/";
  console.log(`[${new Date().toISOString()}] ${req.method} ${url}`);
  try {
    // /unblock/mediaproxy?url=<第三方音源URL>
    if (url.startsWith("/unblock/mediaproxy")) {
      await handleMediaProxy(req, res);
      return;
    }
    // /unblock/netease
    if (url.startsWith("/unblock/netease")) {
      const { id } = parseQuery(url);
      const result = await getNeteaseSongUrl(id);
      sendJson(res, 200, result);
      return;
    }
    // /unblock/kuwo
    if (url.startsWith("/unblock/kuwo")) {
      const match = buildMatchInfo(parseQuery(url));
      const result = await getKuwoSongUrl(match);
      sendJson(res, 200, result);
      return;
    }
    // /unblock/bodian
    if (url.startsWith("/unblock/bodian")) {
      const match = buildMatchInfo(parseQuery(url));
      const result = await getBodianSongUrl(match);
      sendJson(res, 200, result);
      return;
    }
    // 健康检查
    if (url === "/" || url === "/unblock") {
      sendJson(res, 200, {
        name: "SPlayer UnblockAPI (web)",
        description: "Standalone unblock service for web deployment",
        endpoints: [
          "/unblock/netease",
          "/unblock/kuwo",
          "/unblock/bodian",
          "/unblock/mediaproxy?url=<音源URL>",
        ],
      });
      return;
    }
    sendJson(res, 404, { code: 404, url: null, error: "Not Found" });
  } catch (e) {
    console.error("❌ Unblock server error:", e);
    sendJson(res, 500, { code: 500, url: null, error: String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🌐 SPlayer UnblockAPI (web) running at http://${HOST}:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`     GET /unblock/netease?id=<songId>`);
  console.log(`     GET /unblock/kuwo?keyword=<songName-artist>&songName=<>&artist=<>`);
  console.log(`     GET /unblock/bodian?keyword=<songName-artist>&songName=<>&artist=<>`);
  console.log(`     GET /unblock/mediaproxy?url=<音源URL> (白名单: 126.net/163.com/kuwo.cn/gdstudio.xyz/myqcloud.com)`);
});

// 优雅退出
const shutdown = (sig) => {
  console.log(`\n${sig} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
