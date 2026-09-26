import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SongUrlResult } from "./unblock";
import { serverLog } from "../../main/logger";
import axios from "axios";
import getKuwoSongUrl from "./kuwo";
import getBodianSongUrl from "./bodian";

// 媒体代理允许的音源域名后缀
const MEDIA_HOST_WHITELIST = [
  ".kuwo.cn",
  ".kuwo.com.cn",
  ".126.net",
  ".126.com",
  ".163.com",
];

// 校验域名是否在白名单内
const isAllowedMediaHost = (host: string) =>
  MEDIA_HOST_WHITELIST.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));

/**
 * 直接获取 网易云云盘 链接
 * Thank @939163156
 * Power by GD音乐台(music.gdstudio.xyz)
 */
const getNeteaseSongUrl = async (id: number | string): Promise<SongUrlResult> => {
  try {
    if (!id) return { code: 404, url: null };
    const baseUrl = "https://music-api.gdstudio.xyz/api.php";
    const result = await axios.get(baseUrl, {
      params: { types: "url", id },
    });
    const songUrl = result.data.url;
    serverLog.log("🔗 NeteaseSongUrl URL:", songUrl);
    return { code: 200, url: songUrl };
  } catch (error) {
    serverLog.error("❌ Get NeteaseSongUrl Error:", error);
    return { code: 404, url: null };
  }
};

// 初始化 UnblockAPI
export const initUnblockAPI = async (fastify: FastifyInstance) => {
  // 主信息
  fastify.get("/unblock", (_, reply) => {
    reply.send({
      name: "UnblockAPI",
      description: "SPlayer UnblockAPI service",
      author: "@imsyy",
      content:
        "部分接口采用 @939163156 by GD音乐台(music.gdstudio.xyz)，仅供本人学习使用，不可传播下载内容，不可用于商业用途。",
    });
  });
  // netease
  fastify.get(
    "/unblock/netease",
    async (
      req: FastifyRequest<{ Querystring: { [key: string]: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = req.query;
      const result = await getNeteaseSongUrl(id);
      return reply.send(result);
    },
  );
  // 构造匹配信息（fallback 用 lastIndexOf 兼容歌名含连字符的情况）
  const buildMatchInfo = (query: { [key: string]: string }) => {
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
  // kuwo
  fastify.get(
    "/unblock/kuwo",
    async (
      req: FastifyRequest<{ Querystring: { [key: string]: string } }>,
      reply: FastifyReply,
    ) => {
      const result = await getKuwoSongUrl(buildMatchInfo(req.query));
      return reply.send(result);
    },
  );
  // bodian
  fastify.get(
    "/unblock/bodian",
    async (
      req: FastifyRequest<{ Querystring: { [key: string]: string } }>,
      reply: FastifyReply,
    ) => {
      const result = await getBodianSongUrl(buildMatchInfo(req.query));
      return reply.send(result);
    },
  );
  // 媒体代理：浏览器端解锁音源无 CORS 头，经本地同源代理播放
  fastify.get(
    "/unblock/mediaproxy",
    async (
      req: FastifyRequest<{ Querystring: { [key: string]: string } }>,
      reply: FastifyReply,
    ) => {
      const target = req.query.u;
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return reply.code(400).send({ code: 400, msg: "无效地址" });
      }
      // 协议与域名白名单校验
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !isAllowedMediaHost(parsed.hostname)
      ) {
        return reply.code(403).send({ code: 403, msg: "域名未授权" });
      }
      try {
        const upstream = await axios({
          method: "GET",
          url: parsed.toString(),
          responseType: "stream",
          validateStatus: () => true,
          headers: {
            // 透传 Range 以支持拖动
            ...(req.headers.range ? { Range: req.headers.range } : {}),
            "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
          },
        });
        reply.code(upstream.status || 502);
        reply.header("accept-ranges", "bytes");
        // 仅回传播放所需响应头
        ["content-type", "content-length", "content-range"].forEach((h) => {
          const v = upstream.headers[h];
          if (v) reply.header(h, v as string);
        });
        return reply.send(upstream.data);
      } catch (error) {
        serverLog.error("❌ MediaProxy Error:", error);
        return reply.code(502).send({ code: 502, msg: "代理失败" });
      }
    },
  );
  serverLog.info("🌐 Register UnblockAPI successfully");
};
