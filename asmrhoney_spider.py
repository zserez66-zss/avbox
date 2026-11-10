# -*- coding: utf-8 -*-
"""ASMRHoney（asmrhoney.com）TVBox / CatVodSpider 源

站点没有 HTML 页面可抓，数据全是静态 JSON：
  /data/clips-page-N.json     列表（每页 48 条，共 40 页）
  /data/clips/<slug>.json     详情（含 videoUrl / video480Url 直链 mp4）
  /data/clips-search.json     全量索引（约 2908 条，用于搜索与标签筛选）
  /data/clips-meta.json       总数/页数
  /data/triggers.json         标签中文名
mp4 直链无需 Referer，parse=0 直接播放。
"""
import json
import re
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
    BASE_URL = "https://asmrhoney.com"
    DATA = BASE_URL + "/data"
    PER_PAGE = 24
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }

    def __init__(self):
        super().__init__()
        self.name = "ASMRHoney"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None
        self._idx = None
        self._meta = None
        self._trg = None

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        clips = self._page(1)
        return {"class": self._classes(), "filters": {}, "list": [self._item(c) for c in clips],
                "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": [self._item(c) for c in self._page(1)]}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1) or 1
        tid = str(tid or "new").strip("/")
        if tid in ("new", "latest", ""):
            clips = self._page(page)
            pages = self._to_int((self._meta or {}).get("pages"), 40) or 40
            return {"page": page, "pagecount": pages, "limit": self.PER_PAGE, "total": 99999,
                    "list": [self._item(c) for c in clips], "parse": 0, "jx": 0}
        pool = self._filtered(tid)
        total = len(pool)
        start = (page - 1) * self.PER_PAGE
        pagecount = max(1, (total + self.PER_PAGE - 1) // self.PER_PAGE)
        return {"page": page, "pagecount": pagecount, "limit": self.PER_PAGE, "total": total,
                "list": [self._item(c) for c in pool[start:start + self.PER_PAGE]], "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        slug = self._slug_of(ids[0])
        if not slug:
            return result
        clip = self._one(slug)
        if not clip:
            return result
        tags = "、".join([self._label(t) for t in clip.get("tags", []) if t][:8])
        dur = self._dur(clip.get("duration"))
        name = clip.get("title") or slug
        pic = clip.get("coverUrl") or clip.get("coverWebpUrl") or ""
        content = "\n".join([x for x in [
            name,
            "作者：" + str(clip.get("creator") or ""),
            "时长：" + dur if dur else "",
            "标签：" + tags if tags else "",
            (clip.get("description") or "")[:300],
        ] if x])
        urls = []
        if clip.get("videoUrl"):
            urls.append("高清$" + clip["videoUrl"])
        if clip.get("video480Url"):
            urls.append("标清$" + clip["video480Url"])
        if not urls and clip.get("backgroundAudioUrl"):
            urls.append("音频$" + clip["backgroundAudioUrl"])
        if not urls:
            return result
        result["list"].append({"vod_id": slug, "vod_name": name, "vod_pic": pic,
                               "type_name": tags, "vod_year": str(clip.get("publishedAt") or "")[:4],
                               "vod_area": "", "vod_remarks": dur, "vod_actor": str(clip.get("creator") or ""),
                               "vod_director": "", "vod_content": content,
                               "vod_play_from": "ASMRHoney", "vod_play_url": "#".join(urls)})
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1) or 1
        kw = str(key or "").strip().lower()
        pool = []
        if kw:
            for c in self._index():
                hay = " ".join(str(c.get(k) or "") for k in ("title", "title_en", "title_ja", "title_ko", "creator")).lower()
                if kw in hay:
                    pool.append(c)
        total = len(pool)
        start = (page - 1) * self.PER_PAGE
        return {"page": page, "pagecount": max(1, (total + self.PER_PAGE - 1) // self.PER_PAGE),
                "limit": self.PER_PAGE, "total": total,
                "list": [self._item(c) for c in pool[start:start + self.PER_PAGE]], "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        hdr = {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0, "header": hdr}
        if not id:
            return result
        if str(id).startswith("http"):
            return result
        clip = self._one(self._slug_of(id))
        if clip:
            result["url"] = clip.get("videoUrl") or clip.get("video480Url") or clip.get("backgroundAudioUrl") or ""
        return result

    def isVideoFormat(self, url):
        return bool(re.search(r'\.(mp4|m3u8|m4a|mp3)(\?|$)', str(url or ""), re.I))

    def manualVideoCheck(self):
        return False

    # ---------------- 内部 ----------------

    def _classes(self):
        if self._class_cache:
            return self._class_cache
        self._class_cache = [
            {"type_id": "new", "type_name": "最新"},
            {"type_id": "tag:sfw", "type_name": "助眠向"},
            {"type_id": "tag:nsfw", "type_name": "成人向"},
            {"type_id": "tag:mouth_sounds", "type_name": "口腔音"},
            {"type_id": "tag:ear_licking", "type_name": "耳舐"},
            {"type_id": "tag:trigger_sounds", "type_name": "触发音"},
            {"type_id": "tag:roleplay", "type_name": "角色扮演"},
            {"type_id": "tag:whisper", "type_name": "耳语"},
            {"type_id": "creator:shuuukifan", "type_name": "ShuuukiFan"},
            {"type_id": "creator:susuxuejie", "type_name": "Susu学姐"},
            {"type_id": "creator:cherrycrush", "type_name": "CherryCrush"},
            {"type_id": "creator:yuuu226", "type_name": "Yuuu"},
        ]
        return self._class_cache

    def _filtered(self, tid):
        kind, _, val = tid.partition(":")
        pool = self._index()
        if kind == "tag":
            return [c for c in pool if val in (c.get("tags") or [])]
        if kind == "creator":
            return [c for c in pool if c.get("creator") == val]
        return pool

    def _item(self, c):
        return {"vod_id": c.get("slug"), "vod_name": c.get("title") or c.get("slug"),
                "vod_pic": c.get("coverUrl") or c.get("coverWebpUrl") or "",
                "vod_remarks": self._dur(c.get("duration"))}

    def _page(self, page):
        d = self._get_json("%s/clips-page-%d.json" % (self.DATA, max(1, page)))
        return (d or {}).get("clips") or []

    def _one(self, slug):
        if not slug:
            return {}
        d = self._get_json("%s/clips/%s.json" % (self.DATA, urllib.parse.quote(str(slug))))
        return (d or {}).get("clip") or {}

    def _index(self):
        if self._idx is not None:
            return self._idx
        d = self._get_json(self.DATA + "/clips-search.json") or {}
        clips = d.get("clips") or []
        clips.sort(key=lambda c: str(c.get("publishedAt") or ""), reverse=True)
        self._idx = clips
        return clips

    def _meta(self):
        if self._meta is None:
            self._meta = self._get_json(self.DATA + "/clips-meta.json") or {}
        return self._meta

    def _labels(self):
        if self._trg is None:
            d = self._get_json(self.DATA + "/triggers.json") or {}
            self._trg = {}
            for t in d.get("triggers") or []:
                self._trg[t.get("slug")] = t.get("label_zh") or t.get("label_en") or t.get("slug")
        return self._trg

    def _label(self, slug):
        return self._labels().get(slug, slug)

    def _slug_of(self, raw):
        s = str(raw or "").strip()
        if s.startswith("http"):
            s = urllib.parse.urlparse(s).path.strip("/").split("/")[-1]
        return s.replace(".json", "")

    def _dur(self, sec):
        try:
            sec = int(sec)
        except Exception:
            return ""
        if sec <= 0:
            return ""
        h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
        return ("%d:%02d:%02d" % (h, m, s)) if h else ("%d:%02d" % (m, s))

    def _get_json(self, url):
        try:
            r = self.session.get(url, timeout=25, verify=False)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return {}

    def _to_int(self, v, default=0):
        try:
            return int(str(v).strip())
        except Exception:
            return default
