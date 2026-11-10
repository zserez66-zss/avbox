# -*- coding: utf-8 -*-
"""RedGIFs (redgifs.com) —— TVBox / CatVodSpider 源。

站点形态（2026-11-08 沙箱实测）：
  - RedGIFs 是 GIF 风格短视频站，走官方公开 API v2，全程 JSON，无 HTML 解析。
  - 匿名鉴权：GET /v2/auth/temporary 返回 {"token": JWT}，无需账号/密钥，
    以 Authorization: Bearer 发送；令牌过期/无效时接口返回 401，
    本源自动换新令牌重试一次。
    注意：令牌与请求方「设备」绑定——换出口 IP 再用会 401 WrongSender
    （沙箱代理多出口时裸 requests 每请求换 IP 必中招），故全源共用一个
    requests.Session 贯穿取令牌与所有接口调用（真机单设备单 IP 同理）。
  - 信息流没有独立 /trending 路径（404），统一走搜索端点：
      GET /v2/gifs/search?order=trending|latest&count=30&page=N
    不带 search_text 即全站流；合法 order: top/top7/top28/latest/score/trending。
  - 分区（niche）：GET /v2/niches 分页列表（按订阅数降序，共 1841 个），
    单个分区内容走 GET /v2/niches/<slug>/gifs?count=30&page=N
    （注意：该端点传 order=trending 会 400，尽管报错文案把它列为合法值；
      本源不传 order 用默认排序，已实测出内容）。
    搜索端点的 niche 参数会被忽略，不能拿来做分区。
  - 单条详情：GET /v2/gifs/<id> → {"gif": {...}, "user": {...}}，实测可用。
  - 条目 urls 自带 media.redgifs.com 直链：hd（含声音轨）/ sd / silent（无声）/
    poster / thumbnail；hd 直链普通带 UA 的 GET 即 200 video/mp4，无需 Referer。
  - type=2 的条目是图片帖（urls 里只有 .jpg，没有 mp4），本源在列表里过滤掉；
    只收有 mp4 的 type=1 视频条目。
  - 分类 type_id 全部用 ASCII 令牌（hot/new/n0..n12），分区 slug 在源内映射，
    避免客户端把非 ASCII tid 百分号编码后静默返回空的老问题。
"""
import time
import requests
from urllib.parse import unquote

try:
    import urllib3
    urllib3.disable_warnings()
except Exception:
    pass

try:
    from base.spider import Spider as BaseSpider
except ImportError:
    class BaseSpider:
        pass


class Spider(BaseSpider):
    API = "https://api.redgifs.com"
    UA = ("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
          "Chrome/120 Mobile Safari/537.36")
    PER_PAGE = 30
    MAX_PAGES = 200  # 接口 pages 动辄数千，封顶到可浏览深度
    # (令牌 tid, 显示名)；分区 slug 在 NICHES 里按令牌映射，均为实测存在的分区
    FEEDS = [("hot", "热门"), ("new", "最新")]
    NICHES = [
        ("n0", "just-boobs", "Just Boobs"),
        ("n1", "blowjobs", "Blowjobs"),
        ("n2", "thick-booty", "Thick Booty"),
        ("n3", "lips-that-grip", "Lips That Grip"),
        ("n4", "legal-teens", "Legal Teens"),
        ("n5", "amateur-girls", "Amateur Girls"),
        ("n6", "real-orgasms", "Real Orgasms"),
        ("n7", "tik-tok", "Tik Tok"),
        ("n8", "real-couples", "Real Couples"),
        ("n9", "rough-sex", "Rough Sex"),
        ("n10", "creampies", "Creampies"),
        ("n11", "girls-finishing-the-job", "Girls Finishing The Job"),
        ("n12", "goth-girls", "Goth Girls"),
    ]
    FEED_ORDER = {"hot": "trending", "new": "latest"}

    def __init__(self):
        super().__init__()
        self.name = "RedGIFs"
        self._token = None
        self._sess = requests.Session()  # 令牌绑设备/出口，全源共用一个会话
        self._meta = {}  # gif id -> 原始条目，供 detail 兜底回填

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------------- 对外接口 ----------------

    def homeContent(self, filter):
        items, _ = self._feed("trending", 1)
        return {"class": self._classes(), "filters": {},
                "list": items, "parse": 0, "jx": 0}

    def homeVideoContent(self):
        items, _ = self._feed("trending", 1)
        return {"list": items}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        tid = unquote(str(tid or "hot")).strip()
        if tid in self.FEED_ORDER:
            items, pages = self._feed(self.FEED_ORDER[tid], page)
        else:
            slug = dict((t, s) for t, s, _ in self.NICHES).get(tid)
            if slug:
                items, pages = self._niche(slug, page)
            else:
                items, pages = self._feed("trending", page)
        return {"page": page,
                "pagecount": self._pagecount(pages, page, len(items)),
                "limit": self.PER_PAGE, "total": 99999,
                "list": items, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        gid = self._clean_id(ids[0])
        if not gid:
            return result
        gif = None
        payload = self._api_get("/v2/gifs/" + gid)
        if isinstance(payload, dict):
            gif = payload.get("gif")
        cached = self._meta.get(gid)
        if not isinstance(gif, dict):
            gif = cached
        if not isinstance(gif, dict):
            return result
        vod = self._to_vod(gif)
        if not vod:
            return result
        play = self._play_url(gif)
        detail = dict(vod)
        detail.update({
            "type_name": "、".join((gif.get("tags") or [])[:5]),
            "vod_year": "", "vod_area": "",
            "vod_actor": str(gif.get("userName") or ""),
            "vod_director": "",
            "vod_content": str(gif.get("description") or "").strip(),
            "vod_play_from": "播放",
            "vod_play_url": ("正片$" + play) if play else "",
        })
        result["list"].append(detail)
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        key = str(key or "").strip()
        if not key:
            return {"page": page, "pagecount": 1, "limit": self.PER_PAGE,
                    "total": 0, "list": [], "parse": 0, "jx": 0}
        items, pages = self._search(key, page)
        return {"page": page,
                "pagecount": self._pagecount(pages, page, len(items)),
                "limit": self.PER_PAGE,
                "total": pages * self.PER_PAGE if pages else len(items),
                "list": items, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        url = str(id or "").strip()
        if url and not url.startswith("http"):
            # 兜底：传进来的是 gif id 而不是直链时现查一次
            payload = self._api_get("/v2/gifs/" + self._clean_id(url))
            if isinstance(payload, dict) and isinstance(payload.get("gif"), dict):
                url = self._play_url(payload["gif"]) or ""
        return {"parse": 0, "playUrl": "", "url": url, "jx": 0,
                "header": {"User-Agent": self.UA}}

    # ---------------- API 层 ----------------

    def _headers(self):
        h = {"User-Agent": self.UA, "Accept": "application/json"}
        if self._token:
            h["Authorization"] = "Bearer " + self._token
        return h

    def _refresh_token(self):
        try:
            r = self._sess.get(self.API + "/v2/auth/temporary",
                               headers={"User-Agent": self.UA,
                                        "Accept": "application/json"},
                               timeout=20, verify=False)
            if r.status_code == 200:
                tok = (r.json() or {}).get("token")
                if tok:
                    self._token = str(tok)
                    return True
        except Exception:
            pass
        return False

    def _api_get(self, path, params=None):
        """带令牌的 GET；401 时换新令牌重试一次。任何异常吞掉返回 None。"""
        if not self._token and not self._refresh_token():
            return None
        for attempt in range(2):
            try:
                r = self._sess.get(self.API + path, params=params,
                                   headers=self._headers(),
                                   timeout=20, verify=False)
                if r.status_code == 401 and attempt == 0:
                    if self._refresh_token():
                        continue
                    return None
                if r.status_code == 200:
                    return r.json()
                return None
            except Exception:
                if attempt == 0:
                    time.sleep(1)
                    continue
                return None
        return None

    def _feed(self, order, page):
        return self._gif_page("/v2/gifs/search",
                              {"order": order, "count": self.PER_PAGE,
                               "page": page})

    def _niche(self, slug, page):
        # 该端点不接 order=trending（400），用默认排序
        return self._gif_page("/v2/niches/" + slug + "/gifs",
                              {"count": self.PER_PAGE, "page": page})

    def _search(self, key, page):
        return self._gif_page("/v2/gifs/search",
                              {"search_text": key, "order": "trending",
                               "count": self.PER_PAGE, "page": page})

    def _gif_page(self, path, params):
        payload = self._api_get(path, params)
        if not isinstance(payload, dict):
            return [], 0
        items = []
        for raw in payload.get("gifs") or []:
            vod = self._to_vod(raw)
            if vod:
                items.append(vod)
        pages = payload.get("pages")
        return items, pages if isinstance(pages, int) and pages > 0 else 0

    # ---------------- 条目 ----------------

    def _classes(self):
        out = [{"type_id": t, "type_name": n} for t, n in self.FEEDS]
        out += [{"type_id": t, "type_name": n} for t, _, n in self.NICHES]
        return out

    def _play_url(self, gif):
        urls = gif.get("urls") or {}
        for k in ("hd", "sd", "silent"):
            u = str(urls.get(k) or "").strip()
            if u.startswith("http") and u.split("?")[0].endswith(".mp4"):
                return u
        return ""

    def _to_vod(self, raw):
        if not isinstance(raw, dict):
            return None
        gid = str(raw.get("id") or "").strip()
        if not gid:
            return None
        if not self._play_url(raw):
            return None  # type=2 图片帖（无 mp4）跳过
        urls = raw.get("urls") or {}
        pic = str(urls.get("poster") or urls.get("thumbnail") or "").strip()
        if not pic.startswith("http"):
            pic = ""
        title = str(raw.get("description") or "").replace("\n", " ").strip()
        if not title:
            user = str(raw.get("userName") or "").strip()
            tags = [str(t) for t in (raw.get("tags") or [])[:3]]
            title = " ".join(x for x in [user] + tags if x).strip() or gid
        remarks = self._remarks(raw)
        vod = {"vod_id": gid, "vod_name": title,
               "vod_pic": pic, "vod_remarks": remarks}
        self._meta[gid] = raw
        return vod

    def _remarks(self, raw):
        parts = []
        dur = raw.get("duration")
        if isinstance(dur, (int, float)) and dur > 0:
            sec = int(round(dur))
            parts.append("%d:%02d" % (sec // 60, sec % 60))
        views = raw.get("views")
        if isinstance(views, int) and views > 0:
            parts.append("▶ " + self._fmt_num(views))
        return " · ".join(parts)

    def _fmt_num(self, n):
        if n >= 1000000:
            return "%.1fM" % (n / 1000000.0)
        if n >= 1000:
            return "%.1fK" % (n / 1000.0)
        return str(n)

    def _clean_id(self, value):
        """兼容传进来的是 gif id / watch 页 / ifr 页 URL。"""
        s = unquote(str(value or "")).strip()
        if s.startswith("http"):
            s = s.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        return s.lower()

    def _pagecount(self, pages, page, got):
        if pages and pages >= page:
            return min(pages, self.MAX_PAGES)
        return page if got < self.PER_PAGE else page + 1

    # ---------------- 工具 ----------------

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
