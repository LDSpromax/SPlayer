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

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = req.url || "/";
  console.log(`[${new Date().toISOString()}] ${req.method} ${url}`);
  try {
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
        endpoints: ["/unblock/netease", "/unblock/kuwo", "/unblock/bodian"],
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
});

// 优雅退出
const shutdown = (sig) => {
  console.log(`\n${sig} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
