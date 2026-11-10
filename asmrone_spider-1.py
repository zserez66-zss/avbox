# -*- coding: utf-8 -*-
"""ASMR.one（www.asmr.one）TVBox / CatVodSpider 源

接口（都是公开的，不需要登录）：
  列表   https://api.asmr-200.com/api/works?page=1&pageSize=24&order=release&sort=desc
  搜索   /api/search/{关键词}?page=N           （每页 20 条）
  详情   /api/work/{id}
  音轨   /api/tracks/{id}?v=2                  （文件夹树，里面有 audio 文件）
  音频   audio.mediaStreamUrl 或 /api/media/stream/{hash}   —— 直链，无需 token

如果想要登录态（少数作品可能需要），把下面 USERNAME / PASSWORD 填上即可，
源会自动 POST /api/auth/me 取 JWT 并带上 Authorization，失败时自动退回匿名访问。
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


# ---- 账号混淆（不是加密，只是不让明文直接出现在文件里） ----
_K = "aSmR0nE7"


def _dec(s, k=_K):
    """base64 + 循环异或，把账号密码从明文变成乱码。"""
    import base64
    raw = base64.b64decode(s)
    return bytes(b ^ ord(k[i % len(k)]) for i, b in enumerate(raw)).decode("utf-8")


class Spider(BaseSpider):
    BASE_URL = "https://www.asmr.one"
    API = "https://api.asmr-200.com/api"

    # 已填入账号（混淆存储）：启动后自动 POST /api/auth/me 换 JWT，401 自动重登
    USERNAME = _dec("GyAIIFUUcwE=")
    PASSWORD = _dec("ADEOYwJdcQJX")

    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
        "Origin": BASE_URL,
        "Referer": BASE_URL + "/",
    }

    def __init__(self):
        super().__init__()
        self.name = "ASMR.one"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None
        self._token = ""

    def init(self, extend="{}"):
        try:
            cfg = json.loads(extend) if isinstance(extend, str) and extend.strip() else {}
        except Exception:
            cfg = {}
        if isinstance(cfg, dict):
            if cfg.get("username"):
                self.USERNAME = str(cfg.get("username"))
            if cfg.get("password"):
                self.PASSWORD = str(cfg.get("password"))
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        works, _total = self._works(1, "release", "desc")
        return {"class": self._classes(), "filters": {}, "list": [self._item(w) for w in works],
                "parse": 0, "jx": 0}

    def homeVideoContent(self):
        works, _total = self._works(1, "release", "desc")
        return {"list": [self._item(w) for w in works]}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1) or 1
        tid = str(tid or "release:desc")
        if tid.startswith("kw:"):
            works, total = self._search(tid[3:], page)
        else:
            order, _, sort = tid.partition(":")
            works, total = self._works(page, order or "release", sort or "desc")
        return {"page": page, "pagecount": max(1, (total + 23) // 24) if total else page,
                "limit": 24, "total": total or len(works),
                "list": [self._item(w) for w in works], "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        wid = self._wid(ids[0])
        if not wid:
            return result
        work = self._get_json("%s/work/%s" % (self.API, wid)) or {}
        tracks = self._get_json("%s/tracks/%s?v=2" % (self.API, wid)) or []
        audios = []
        self._walk(tracks if isinstance(tracks, list) else [tracks], audios)
        if not audios:
            return result
        name = work.get("title") or audios[0].get("workTitle") or str(wid)
        pic = work.get("mainCoverUrl") or work.get("samCoverUrl") or work.get("thumbnailCoverUrl") or ""
        tags = "、".join([self._tag(t) for t in (work.get("tags") or [])][:8])
        vas = "、".join([v.get("name", "") for v in (work.get("vas") or []) if v.get("name")])
        content = "\n".join([x for x in [
            name,
            ("社团：" + str(work.get("name"))) if work.get("name") else "",
            ("声优：" + vas) if vas else "",
            ("时长：" + self._dur(work.get("duration"))) if self._dur(work.get("duration")) else "",
            ("标签：" + tags) if tags else "",
        ] if x])
        items = []
        for i, f in enumerate(audios):
            u = f.get("mediaStreamUrl") or self._stream(f.get("hash"))
            if not u:
                continue
            t = self._clean(f.get("title") or ("音轨%d" % (i + 1)))
            t = re.sub(r'\.(mp3|wav|flac|m4a|ogg|aac)$', '', t, flags=re.I)
            items.append(t + "$" + u)
        if not items:
            return result
        result["list"].append({"vod_id": str(wid), "vod_name": name, "vod_pic": pic,
                               "type_name": tags, "vod_year": str(work.get("release") or "")[:4],
                               "vod_area": "", "vod_remarks": self._dur(work.get("duration")),
                               "vod_actor": vas, "vod_director": "", "vod_content": content,
                               "vod_play_from": "ASMR", "vod_play_url": "#".join(items)})
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1) or 1
        works, total = self._search(str(key or ""), page)
        return {"page": page, "pagecount": max(1, (total + 19) // 20) if total else page,
                "limit": 20, "total": total or len(works),
                "list": [self._item(w) for w in works], "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        hdr = {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0, "header": hdr}
        if not id:
            return result
        raw = str(id)
        if raw.startswith("http"):
            return result
        result["url"] = self._stream(raw)
        return result

    def isVideoFormat(self, url):
        return bool(re.search(r'\.(mp3|wav|flac|m4a|ogg|aac|mp4|m3u8)(\?|$)', str(url or ""), re.I))

    def manualVideoCheck(self):
        return False

    # ---------------- 内部 ----------------

    def _classes(self):
        if self._class_cache:
            return self._class_cache
        self._class_cache = [
            {"type_id": "release:desc", "type_name": "最新发布"},
            {"type_id": "dl_count:desc", "type_name": "最热门"},
            {"type_id": "rate_average_2dp:desc", "type_name": "评分最高"},
            {"type_id": "price:asc", "type_name": "价格从低"},
            {"type_id": "kw:简体中文", "type_name": "中文版"},
            {"type_id": "kw:耳舐め", "type_name": "舔耳"},
            {"type_id": "kw:ささやき", "type_name": "耳语"},
            {"type_id": "kw:バイノーラル", "type_name": "双耳录音"},
        ]
        return self._class_cache

    def _works(self, page, order, sort):
        d = self._get_json("%s/works?page=%d&pageSize=24&order=%s&sort=%s" % (self.API, page, order, sort))
        p = (d or {}).get("pagination") or {}
        return (d or {}).get("works") or [], self._to_int(p.get("totalCount"))

    def _search(self, kw, page):
        d = self._get_json("%s/search/%s?page=%d" % (self.API, urllib.parse.quote(str(kw)), page))
        p = (d or {}).get("pagination") or {}
        return (d or {}).get("works") or [], self._to_int(p.get("totalCount"))

    def _walk(self, nodes, out):
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            if n.get("type") == "folder":
                self._walk(n.get("children") or [], out)
            elif n.get("type") == "audio":
                out.append(n)
            elif str(n.get("title") or "").lower().endswith((".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac")):
                out.append(n)

    def _item(self, w):
        return {"vod_id": str(w.get("id")), "vod_name": w.get("title") or "",
                "vod_pic": w.get("mainCoverUrl") or w.get("samCoverUrl") or "",
                "vod_remarks": self._dur(w.get("duration"))}

    def _wid(self, raw):
        s = str(raw or "").strip()
        if s.startswith("http"):
            s = urllib.parse.urlparse(s).path.rstrip("/").split("/")[-1]
        return s if s.isdigit() else ""

    def _stream(self, h):
        if not h:
            return ""
        u = "%s/media/stream/%s" % (self.API, urllib.parse.quote(str(h)))
        if self._token:
            u += "?token=" + urllib.parse.quote(self._token)
        return u

    def _login(self):
        if not (self.USERNAME and self.PASSWORD):
            return ""
        try:
            r = self.session.post(self.API + "/auth/me",
                                  json={"name": self.USERNAME, "password": self.PASSWORD},
                                  headers={"Authorization": "", "Content-Type": "application/json"},
                                  timeout=20, verify=False)
            if r.status_code == 200:
                self._token = (r.json() or {}).get("token") or ""
        except Exception:
            self._token = ""
        return self._token

    def _get_json(self, url):
        """填了账号就先登录拿 token；遇到 401 再重登一次。"""
        if self.USERNAME and self.PASSWORD and not self._token:
            self._login()
        try:
            r = self.session.get(url, headers=({"Authorization": "Bearer " + self._token} if self._token else None),
                                 timeout=25, verify=False)
            if r.status_code == 401 and self.USERNAME and self.PASSWORD:
                if self._login():
                    r = self.session.get(url, headers={"Authorization": "Bearer " + self._token},
                                         timeout=25, verify=False)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return {}

    def _tag(self, t):
        if isinstance(t, dict):
            i18n = t.get("i18n") or {}
            for k in ("zh-cn", "zh-tw", "ja-jp", "en-us"):
                if (i18n.get(k) or {}).get("name"):
                    return i18n[k]["name"]
            return str(t.get("name") or t.get("id") or "")
        return str(t)

    def _dur(self, ms):
        try:
            sec = int(ms) // 1000
        except Exception:
            return ""
        if sec <= 0:
            return ""
        h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
        return ("%d:%02d:%02d" % (h, m, s)) if h else ("%d:%02d" % (m, s))

    def _clean(self, text):
        text = re.sub(r'<.*?>', '', text or '')
        return re.sub(r'\s+', ' ', text).strip()

    def _to_int(self, v, default=0):
        try:
            return int(str(v).strip())
        except Exception:
            return default
