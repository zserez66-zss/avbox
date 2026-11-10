# -*- coding: utf-8 -*-
"""Hanime1.me TVBox / CatVodSpider 源。

站点形态（2026-11 实测）：
  - 详情页 /watch?v=<id>，页面里 <video id="player"> 有多个 <source>，
    是带签名的直链 mp4（vdownload.hembed.com，720p/480p 等，size 属性标画质）
  - 签名直链约 13 小时过期，所以 vod_play_url 只存 watch 页地址，
    每次播放时 playerContent 回 watch 页现取直链
  - 列表有两种卡片：首页/普通列表是 .video-item-container（横版缩略图），
    genre 落地页是 .search-videos（竖版封面）；两种卡片的标题/图都在
    <a href=".../watch?v=<id>"> 里面，统一按这个锚点解析
  - 列表混有外站广告卡片（链接不是 watch 页），按 href 形态过滤掉
  - 浏览/分类/搜索都是同一个搜索接口：参数 query / genre / sort / page，
    分页器是标准 ?page=N（总页数很大，裏番 73 页、全部 373 页）

约定：单文件、只依赖 requests、Python 3、vod_id 一律用绝对 URL。
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
    BASE_URL = "https://hanime1.me"
    SEARCH_URL = BASE_URL + "/search"
    FALLBACK_URLS = ["https://hanime1.me"]
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    # type_id 是搜索接口的参数串，全部来自站点导航/筛选弹窗，不要凭想象加
    CLASSES = [
        {"type_id": "sort=最新上傳", "type_name": "最新上傳"},
        {"type_id": "genre=裏番", "type_name": "裏番"},
        {"type_id": "genre=泡麵番", "type_name": "泡麵番"},
        {"type_id": "genre=Motion Anime", "type_name": "Motion Anime"},
        {"type_id": "genre=3DCG", "type_name": "3DCG"},
        {"type_id": "genre=2.5D", "type_name": "2.5D"},
        {"type_id": "genre=2D動畫", "type_name": "2D動畫"},
        {"type_id": "genre=AI生成", "type_name": "AI生成"},
        {"type_id": "genre=MMD", "type_name": "MMD"},
        {"type_id": "genre=Cosplay", "type_name": "Cosplay"},
        {"type_id": "genre=新番預告", "type_name": "新番預告"},
    ]

    def __init__(self):
        super().__init__()
        self.name = "Hanime1"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        html = self._get(self.BASE_URL + "/")
        return {"class": [dict(c) for c in self.CLASSES], "filters": {},
                "list": self._parse_cards(html), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_cards(self._get(self.BASE_URL + "/"))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        params = dict(urllib.parse.parse_qsl(str(tid or ""), keep_blank_values=True))
        url = self._search_url(params, page)
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 60, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        url = self._watch_url(ids[0])
        html = self._get(url)
        if not html:
            return result
        name = self._clean(self._match(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)'))
        name = re.sub(r'\s*-\s*Hanime1\.me\s*$', '', name)
        if not name:
            name = self._clean(self._match(html, r'<title>(.*?)</title>'))
            name = re.sub(r'\s*-.*$', '', name)
        pic = self._match(html, r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)')
        content = self._clean(self._match(html, r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)'))
        author = self._clean(self._match(html, r'href=["\'][^"\']*\?query=[^"\']+["\'][^>]*>([^<]+)</a>'))
        result["list"].append({
            "vod_id": url, "vod_name": name,
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
            "type_name": "", "vod_year": "", "vod_area": "",
            "vod_remarks": "", "vod_actor": author, "vod_director": "",
            "vod_content": content,
            "vod_play_from": "正片",
            "vod_play_url": "正片$" + url,
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        url = self._search_url({"query": str(key)}, page)
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 60, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0,
                  "header": {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}}
        if not id:
            return result
        id = str(id)
        if ".mp4" in id or ".m3u8" in id:
            return result
        watch = self._watch_url(id)
        direct = self._best_source(self._get(watch))
        if direct:
            result["url"] = direct
            result["header"] = {"User-Agent": self.HEADERS["User-Agent"], "Referer": watch}
        else:
            result["url"] = watch
            result["parse"] = 1
        return result

    # ---------------- 内部 ----------------

    def _search_url(self, params, page):
        q = dict(params or {})
        if page and int(page) > 1:
            q["page"] = str(page)
        return self.SEARCH_URL + "?" + urllib.parse.urlencode(q)

    def _watch_url(self, raw):
        raw = str(raw or "").strip()
        if raw.startswith("http"):
            return raw
        m = re.search(r'(\d+)', raw)
        return self.BASE_URL + "/watch?v=" + (m.group(1) if m else raw)

    def _parse_cards(self, html):
        """两种卡片统一解析：抓 <a href=".../watch?v=ID">...</a> 整块，
        标题和图都在块里；外站广告卡片 href 不是 watch 页，天然过滤。"""
        data, seen = [], set()
        if not html:
            return data
        pat = re.compile(r'<a[^>]+href=["\']((?:https://hanime1\.me)?/watch\?v=(\d+))["\'][^>]*>([\s\S]*?)</a>', re.I)
        for m in pat.finditer(html):
            vid = m.group(2)
            if vid in seen:
                continue
            block = m.group(3)
            name = self._clean(self._match(block, r'<div class="title">(.*?)</div>')
                               or self._match(block, r'<div class="home-rows-videos-title">(.*?)</div>')
                               or self._match(block, r'<img[^>]+alt=["\']([^"\']+)'))
            if not name:
                continue
            pic = (self._match(block, r'<img[^>]+src=["\']([^"\']+)')
                   or self._match(block, r'data-src=["\']([^"\']+)'))
            remarks = self._clean(self._match(block, r'<div class="duration">(.*?)</div>'))
            seen.add(vid)
            data.append({"vod_id": self.BASE_URL + "/watch?v=" + vid,
                         "vod_name": name,
                         "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
                         "vod_remarks": remarks})
        return data

    def _best_source(self, html):
        """watch 页 <video> 里的 <source src size>，取 size 最大的直链。"""
        best, best_size = "", -1
        for m in re.finditer(r'<source[^>]+src=["\']([^"\']+)["\'][^>]*>', html or "", re.I):
            tag = m.group(0)
            sm = re.search(r'size=["\'](\d+)["\']', tag)
            size = int(sm.group(1)) if sm else 0
            if size > best_size:
                best, best_size = m.group(1), size
        if not best:
            best = self._match(html, r'["\'](https?://[^"\']+\.mp4[^"\']*)')
        return best.replace("&amp;", "&")

    def _pagecount(self, html, page, got):
        nums = []
        for href in re.findall(r'href=["\']([^"\']+)["\']', (html or "").replace("&amp;", "&")):
            nums += [int(n) for n in re.findall(r'[?&]page=(\d+)', href)]
        nums = [n for n in nums if 0 < n < 100000]
        if nums:
            return max(max(nums), page)
        return page if got < 20 else page + 1

    def _get(self, url, headers=None):
        h = dict(self.HEADERS)
        if headers:
            h.update(headers)
        for _ in range(5):
            try:
                r = self.session.get(url, headers=h, timeout=15, verify=False)
                r.encoding = "utf-8"
                if r.status_code < 400 and "Just a moment" not in r.text and "cf-browser-verification" not in r.text:
                    return r.text
            except Exception:
                pass
            time.sleep(0.8)
        return ""

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
