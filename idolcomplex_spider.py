# -*- coding: utf-8 -*-
"""IdolComplex (Sankaku 系图站) 的 TVBox / CatVodSpider 源。

站点是 SPA, 数据走官方公开 API: https://i.sankakuapi.com/posts (匿名可读)。
本源只收视频帖 (file_type=video/*), 图片帖不进列表。
分类的 type_id 直接就是站点的 booru 查询串 (order/tag), 全部实测有数据:
  order:popularity / order:recent / order:score / order:quality / cosplay / pov / uncensored / portrait
播放地址是带签名的直链 (mp4/webm), 会过期: 列表只存帖子页 URL,
detailContent / playerContent 每次都回 API 现取最新 file_url。
注意: 匿名 API 不能用排除标签 (带 -xxx 会 429), 搜索词按 booru 语义 (空格=AND)。
"""
import re
import time
import urllib.parse
import requests

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
    BASE_URL = "https://www.idolcomplex.com"
    API_URL = "https://i.sankakuapi.com"
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        "Accept": "application/vnd.sankaku.api+json;v=2",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    # type_id = booru 查询串 (自动补 video 过滤的在 _query 里处理)
    CLASSES = [
        {"type_name": "热门视频", "type_id": "order:popularity video"},
        {"type_name": "最新视频", "type_id": "order:recent video"},
        {"type_name": "高分视频", "type_id": "order:score video"},
        {"type_name": "高质量", "type_id": "order:quality video"},
        {"type_name": "Cosplay", "type_id": "cosplay video"},
        {"type_name": "POV", "type_id": "pov video"},
        {"type_name": "无码", "type_id": "uncensored video"},
        {"type_name": "竖屏", "type_id": "portrait video"},
    ]
    LIMIT = 40
    # 拼标题时跳过的元标签
    _META_TAGS = {
        "video", "mp4", "webm", "has_audio", "h264_(codec)", "large_filesize",
        "small_filesize", "medium_filesize", "animated", "sound", "video_duration",
    }

    def __init__(self):
        super().__init__()
        self.name = "IdolComplex"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------- 基础 ----------
    def _to_int(self, v, default=1):
        try:
            return int(v)
        except Exception:
            return default

    def _api(self, path, params=None):
        """调 Sankaku API; 429 时退避重试一次; 任何异常返回 None。"""
        url = self.API_URL + path
        for attempt in (0, 1):
            try:
                r = self.session.get(url, params=params or {}, timeout=15, verify=False)
                if r.status_code == 429 and attempt == 0:
                    time.sleep(2)
                    continue
                if r.status_code != 200:
                    return None
                return r.json()
            except Exception:
                if attempt == 0:
                    time.sleep(1)
                    continue
                return None
        return None

    def _posts(self, tags, page):
        data = self._api("/posts", {"page": page, "limit": self.LIMIT, "tags": tags})
        return data if isinstance(data, list) else []

    def _title(self, post):
        names = []
        for t in post.get("tag_names") or []:
            tl = str(t).lower()
            if tl in self._META_TAGS or "aspect_ratio" in tl or tl.endswith("_(codec)"):
                continue
            names.append(str(t).replace("_", " "))
            if len(names) >= 4:
                break
        return " · ".join(names) if names else "视频 #%s" % post.get("id")

    def _remarks(self, post):
        parts = []
        dur = post.get("duration") or post.get("video_duration")
        try:
            d = float(dur)
            if d > 0:
                parts.append("%d:%02d" % (int(d) // 60, int(d) % 60))
        except Exception:
            pass
        score = post.get("total_score")
        if score:
            parts.append("★%s" % score)
        return " ".join(parts)

    def _vod(self, post):
        if not str(post.get("file_type") or "").startswith("video"):
            return None
        pid = post.get("id")
        if not pid:
            return None
        return {
            "vod_id": "%s/posts/%s" % (self.BASE_URL, pid),
            "vod_name": self._title(post),
            "vod_pic": post.get("preview_url") or "",
            "vod_remarks": self._remarks(post),
        }

    def _list(self, tags, page):
        out = []
        for p in self._posts(tags, page):
            v = self._vod(p)
            if v:
                out.append(v)
        return out

    # ---------- TVBox 接口 ----------
    def homeContent(self, filter):
        return {"class": self.CLASSES, "filters": {},
                "list": self._list("order:popularity video", 1), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._list("order:popularity video", 1)}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        tags = str(tid or "order:popularity video")
        data = self._list(tags, page)
        pagecount = page + 3 if len(data) >= self.LIMIT - 5 else page
        return {"page": page, "pagecount": pagecount, "limit": self.LIMIT,
                "total": 99999, "list": data, "parse": 0, "jx": 0}

    def _post_id(self, raw):
        m = re.search(r"(\d+)", str(raw or ""))
        return m.group(1) if m else ""

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        pid = self._post_id(ids[0])
        if not pid:
            return result
        post = self._api("/posts/" + pid)
        if not isinstance(post, dict):
            return result
        file_url = post.get("file_url") or ""
        vod = {
            "vod_id": "%s/posts/%s" % (self.BASE_URL, pid),
            "vod_name": self._title(post),
            "vod_pic": post.get("preview_url") or "",
            "vod_remarks": self._remarks(post),
            "vod_actor": (post.get("author") or {}).get("display_name", ""),
            "type_name": post.get("file_type", ""),
            "vod_content": "标签: " + " ".join(str(t).replace("_", " ") for t in (post.get("tag_names") or [])[:20]),
            "vod_play_from": "正片",
            "vod_play_url": "正片$" + file_url if file_url else "",
        }
        result["list"] = [vod]
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        kw = str(key or "").strip()
        if not kw:
            return {"list": [], "parse": 0, "jx": 0}
        tags = kw if "video" in kw.split() else kw + " video"
        return {"page": page, "pagecount": page + 1, "limit": self.LIMIT,
                "total": 99999, "list": self._list(tags, page), "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        url = str(id or "")
        # 传进来的是帖子页/帖号而不是直链时, 回 API 现取最新签名地址
        if "/posts/" in url or url.isdigit():
            pid = self._post_id(url)
            post = self._api("/posts/" + pid) if pid else None
            if isinstance(post, dict) and post.get("file_url"):
                url = post["file_url"]
        return {"parse": 0, "jx": 0, "url": url,
                "header": {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}}
