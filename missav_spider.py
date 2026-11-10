# -*- coding: utf-8 -*-
"""MissAV（missav.ws）TVBox / CatVodSpider 源

取流方式：详情页里的播放器是 eval 打包过的 JS，解包后拿到
surrit.com 的 m3u8（1080p / 720p / playlist 三档），播放必须带
Referer: https://missav.ws/ ，否则 403。
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
    BASE_URL = "https://missav.ws"
    LOCALE = "cn"
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }

    def __init__(self):
        super().__init__()
        self.name = "MissAV"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None
        self._page_cache = {}

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        html = self._get(self._url("new"))
        return {"class": self._classes(), "filters": self._filters(), "list": self._parse_list(html), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_list(self._get(self._url("new")))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        path = str(tid or "new").strip("/")
        fv = ""
        if isinstance(extend, dict):
            fv = str(extend.get("filter") or "").strip()
        if fv:
            path, fv = self._apply_filter(path, fv)
        url = self._url(path, page, fv)
        html = self._get(url)
        data = self._parse_list(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 24, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        raw = str(ids[0])
        url = raw if raw.startswith("http") else self._url(raw.strip("/"))
        html = self._get(url)
        if not html:
            return result
        name = self._clean(self._match(html, r'<h1[^>]*>(.*?)</h1>')
                           or self._match(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)')
                           or self._match(html, r'<title>(.*?)</title>'))
        pic = (self._match(html, r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)')
               or self._match(html, r'<video[^>]+data-poster=["\']([^"\']+)')
               or self._match(html, r'<img[^>]+data-src=["\']([^"\']+)'))
        tags = ",".join(dict.fromkeys([self._clean(x) for x in re.findall(r'/genres/[^"\']*["\'][^>]*>\s*([^<]{1,20})\s*<', html)][:20]))
        m3u8 = self._m3u8(html)
        if m3u8:
            self._page_cache[m3u8] = url
        result["list"].append({"vod_id": url, "vod_name": name,
                               "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
                               "type_name": tags, "vod_year": "", "vod_area": "",
                               "vod_remarks": "", "vod_actor": tags, "vod_director": "",
                               "vod_content": name, "vod_play_from": "MissAV",
                               "vod_play_url": "正片$" + (m3u8 or url)})
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        html = self._get(self._url("search/" + urllib.parse.quote(str(key)), page))
        data = self._parse_list(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 24, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        hdr = {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0, "header": hdr}
        if not id:
            return result
        if ".m3u8" in id or ".mp4" in id:
            if self._token_alive(id):
                return result
            page = self._page_cache.get(id)
            if page:
                fresh = self._m3u8(self._get(page))
                if fresh:
                    result["url"] = fresh
            return result
        play_page = id if str(id).startswith("http") else self._url(str(id).strip("/"))
        html = self._get(play_page)
        m3u8 = self._m3u8(html)
        if m3u8:
            result["url"] = m3u8
            self._page_cache[m3u8] = play_page
        else:
            result["url"] = play_page
            result["parse"] = 1
        return result

    # ---------------- 内部 ----------------

    def _classes(self):
        if self._class_cache:
            return self._class_cache
        self._class_cache = [
            {"type_id": "new", "type_name": "最新"},
            {"type_id": "release", "type_name": "发行"},
            {"type_id": "chinese-subtitle", "type_name": "中文字幕"},
            {"type_id": "genres/单体作品", "type_name": "单体作品"},
            {"type_id": "genres/高清", "type_name": "高清"},
            {"type_id": "genres/独家", "type_name": "独家"},
            {"type_id": "genres/中出", "type_name": "中出"},
            {"type_id": "genres/VR", "type_name": "VR"},
        ]
        return self._class_cache

    def _url(self, path, page=1, fv=""):
        segs = [s for s in str(path).strip("/").split("/") if s]
        url = self.BASE_URL + "/" + self.LOCALE + "/" + "/".join(urllib.parse.quote(s) for s in segs)
        params = []
        if fv:
            params.append("filters=" + urllib.parse.quote(fv, safe=","))
        if page and page > 1:
            params.append("page=" + str(page))
        return url + ("?" + "&".join(params) if params else "")

    def _filters(self):
        opts = [
            {"n": "全部", "v": ""},
            {"n": "中文字幕", "v": "chinese-subtitle"},
            {"n": "单体作品", "v": "individual"},
            {"n": "合集", "v": "multiple"},
            {"n": "中文字幕+单体", "v": "chinese-subtitle,individual"},
        ]
        return {c["type_id"]: [{"key": "filter", "name": "筛选", "value": opts}] for c in self._classes()}

    def _apply_filter(self, path, fv):
        """站点只有 chinese-subtitle / individual / multiple 三个筛选值。
        最新、发行两个分区对 filters 不生效，改用专门的中文字幕分区。"""
        parts = [p for p in str(fv).split(",") if p]
        if "chinese-subtitle" in parts and path in ("new", "release"):
            path = "chinese-subtitle"
            parts = [p for p in parts if p != "chinese-subtitle"]
        return path, ",".join(parts)

    def _pagecount(self, html, page, got):
        pages = [int(x) for x in re.findall(r'[?&]page=(\d+)', html or "")]
        pages = [p for p in pages if 0 < p < 100000]
        if pages:
            return max(pages)
        return page if got < 10 else page + 1

    def _parse_list(self, html):
        data, seen = [], set()
        html = html or ""
        chunks = re.split(r'(?=<div[^>]*class="[^"]*thumbnail[^"]*")', html)
        for blk in chunks[1:]:
            blk = blk[:3000]
            if "/preview.mp4" not in blk:      # 视频卡片才有预览片，用来剔掉导航块
                continue
            href = self._match(blk, r'<a\s+href="([^"]+)"')
            if not href:
                continue
            href = self._clean_url(urllib.parse.urljoin(self.BASE_URL + "/", href))
            if "/" + self.LOCALE + "/" not in href:
                continue
            name = self._clean(self._match(blk, r'<img[^>]*alt="([^"]{4,})"') or self._match(blk, r'alt="([^"]{4,})"'))
            pic = self._match(blk, r'<img[^>]*(?:data-src|src)="(https?://[^"]+)"')
            if href in seen or not name:
                continue
            seen.add(href)
            data.append({"vod_id": href, "vod_name": name,
                         "vod_pic": pic or "", "vod_remarks": ""})
        return data

    def _clean_url(self, url):
        # 站点会给部分链接加 /dmNNN/ 分片前缀，去掉后一样能访问
        return re.sub(r'^(https?://[^/]+)/dm\d+/', r'\1/', url)

    def _get(self, url, headers=None):
        h = dict(self.HEADERS)
        h["Referer"] = self.BASE_URL + "/"
        if headers:
            h.update(headers)
        try:
            r = self.session.get(url, headers=h, timeout=20, verify=False)
            r.encoding = "utf-8"
            if r.status_code < 400 and "Just a moment" not in r.text:
                return r.text
        except Exception:
            pass
        return ""

    def _unpack(self, html):
        """解 eval(function(p,a,c,k,e,d){...}('...',a,c,'k'.split('|'),0,{})) 打包脚本。"""
        m = re.search(r"eval\(function\(p,a,c,k,e,[rd]\).*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)", html or "", re.S)
        if not m:
            return ""
        p = m.group(1).replace("\\'", "'").replace('\\"', '"')
        c = int(m.group(3))
        k = m.group(4).split("|")

        def b36(n):
            d = "0123456789abcdefghijklmnopqrstuvwxyz"
            out = ""
            while n:
                out = d[n % 36] + out
                n //= 36
            return out or "0"

        for i in range(min(c, len(k)) - 1, -1, -1):
            if k[i]:
                p = re.sub(r'\b' + b36(i) + r'\b', lambda _m, v=k[i]: v, p)
        return p

    def _m3u8(self, html):
        urls = []
        js = self._unpack(html)
        if js:
            urls += re.findall(r'https?://[^\'"\s]+\.m3u8[^\'"\s]*', js)
        if not urls:
            urls += re.findall(r'https?://[^\'"\s]+\.m3u8[^\'"\s]*', html or "")
        urls = list(dict.fromkeys(urls))
        if not urls:
            return ""

        def score(u):
            if "1080" in u:
                return 3
            if "720" in u:
                return 2
            return 1
        urls.sort(key=score, reverse=True)
        return urls[0]

    def _token_alive(self, url):
        return True

    def _match(self, text, pattern):
        m = re.search(pattern, text or "", re.S | re.I)
        return m.group(1).strip() if m and m.lastindex else ""

    def _clean(self, text):
        text = re.sub(r'<.*?>', '', text or '')
        for a, b in (('&nbsp;', ' '), ('&amp;', '&'), ('&#038;', '&'), ('&quot;', '"'), ('&#039;', "'")):
            text = text.replace(a, b)
        return re.sub(r'\s+', ' ', text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
