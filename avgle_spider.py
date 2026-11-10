# -*- coding: utf-8 -*-
"""Avgle（avgle.net）TVBox / CatVodSpider 源

站点是普通 PHP 模板站：
  列表   /index.php?page=N、/popular.php、/episodes.php
  分类   /category.php?slug=xxx&page=N
  标签   /tag.php?slug=xxx&page=N
  搜索   /search.php?q=关键词
  详情   /video.php?slug=xxx
播放地址不在 HTML 里，而在详情页的
  playEndpoint = "/video_source.php?v=..&fid=..&exp=..&token=.."
这个带签名、有时效的接口里，GET 它返回 {"ok":true,"url":"...mp4?verify=.."}，
是 CDN 上的 mp4 直链（无需 Referer）。
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
    BASE_URL = "https://avgle.net"
    LANG = "ja"
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en;q=0.8,zh-CN;q=0.7",
        "Referer": BASE_URL + "/",
    }

    def __init__(self):
        super().__init__()
        self.name = "Avgle"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        html_text = self._get(self.BASE_URL + "/index.php?page=1&lang=" + self.LANG)
        return {"class": self._classes(), "filters": {}, "list": self._parse_list(html_text),
                "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_list(self._get(self.BASE_URL + "/index.php?page=1&lang=" + self.LANG))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1) or 1
        html_text = self._get(self._tid_url(str(tid or "index.php"), page))
        data = self._parse_list(html_text)
        return {"page": page, "pagecount": self._pagecount(html_text, page, len(data)),
                "limit": 30, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        raw = str(ids[0])
        url = raw if raw.startswith("http") else self.BASE_URL + raw
        html_text = self._get(url)
        if not html_text:
            return result
        name = self._clean(self._match(html_text, r'<h1[^>]*>(.*?)</h1>')
                           or self._match(html_text, r'<title>(.*?)</title>').split(" - ")[0])
        pic = self._match(html_text, r'<video[^>]+poster="([^"]+)"')
        if not pic:
            pic = self._match(html_text, r'<img[^>]+src="(/javstream_thumbnails/[^"]+)"')
        desc = self._clean(self._match(html_text, r'property="og:description"[^>]*content="([^"]*)"'))
        play = self._src(html_text, url)
        if not play:
            return result
        result["list"].append({"vod_id": url, "vod_name": name, "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
                               "type_name": "", "vod_year": "", "vod_area": "",
                               "vod_remarks": "", "vod_actor": "", "vod_director": "",
                               "vod_content": desc or name, "vod_play_from": "Avgle",
                               "vod_play_url": "正片$" + play})
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1) or 1
        url = "%s/search.php?q=%s&lang=%s" % (self.BASE_URL, urllib.parse.quote(str(key or "")), self.LANG)
        if page > 1:
            url += "&page=%d" % page
        html_text = self._get(url)
        data = self._parse_list(html_text)
        return {"page": page, "pagecount": self._pagecount(html_text, page, len(data)),
                "limit": 30, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        hdr = {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0, "header": hdr}
        if not id:
            return result
        raw = str(id)
        if ".mp4" in raw or ".m3u8" in raw:
            return result
        url = raw if raw.startswith("http") else self.BASE_URL + raw
        play = self._src(self._get(url), url)
        if play:
            result["url"] = play
        else:
            result["parse"] = 1
        return result

    def isVideoFormat(self, url):
        return bool(re.search(r'\.(mp4|m3u8)(\?|$)', str(url or ""), re.I))

    def manualVideoCheck(self):
        return False

    # ---------------- 内部 ----------------

    def _classes(self):
        if self._class_cache:
            return self._class_cache
        cats = [
            ("fc2", "FC2"), ("x-market", "X-Market"), ("pcolle", "Pcolle"),
            ("voyvid", "VoyVid"), ("palpis", "Palpis"), ("adl-d", "ADL-D"),
            ("gcolle", "Gcolle"), ("peepspot", "PeepSpot"), ("10genkyo", "10Genkyo"),
        ]
        self._class_cache = [
            {"type_id": "index.php", "type_name": "最新"},
            {"type_id": "popular.php", "type_name": "人气"},
            {"type_id": "episodes.php", "type_name": "最新发布"},
        ] + [{"type_id": "category.php?slug=" + s, "type_name": n} for s, n in cats]
        return self._class_cache

    def _tid_url(self, tid, page):
        if "?" in tid:
            base, _, _q = tid.partition("?")
            url = "%s/%s?%s" % (self.BASE_URL, base, _q)
        else:
            url = "%s/%s" % (self.BASE_URL, tid)
        url += ("&" if "?" in url else "?") + "page=%d" % page
        url += "&lang=" + self.LANG
        return url

    def _parse_list(self, html_text):
        data, seen = [], set()
        for blk in re.split(r'(?=<a class="card)', html_text or "")[1:]:
            blk = blk[:1800]
            href = self._match(blk, r'href="(/video\.php\?slug=[^"]+)"')
            if not href:
                continue
            href = href.replace("&amp;", "&")
            name = self._clean(self._match(blk, r'<h3[^>]*>(.*?)</h3>')
                               or self._match(blk, r'<img[^>]+alt="([^"]+)"'))
            pic = self._match(blk, r'<img[^>]+src="([^"]+)"')
            full = self.BASE_URL + href
            if full in seen or not name:
                continue
            seen.add(full)
            data.append({"vod_id": full, "vod_name": name,
                         "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic), "vod_remarks": ""})
        return data

    def _src(self, html_text, page_url):
        """走 playEndpoint 换出真实的 mp4 直链。"""
        ep = self._match(html_text, r'playEndpoint\s*=\s*"([^"]+)"')
        if not ep:
            return ""
        ep = ep.replace("&amp;", "&")
        try:
            r = self.session.get(urllib.parse.urljoin(self.BASE_URL, ep),
                                 headers={"User-Agent": self.HEADERS["User-Agent"], "Referer": page_url},
                                 timeout=20, verify=False)
            if r.status_code == 200:
                d = r.json()
                if d.get("ok") and d.get("url"):
                    return d["url"]
        except Exception:
            pass
        return ""

    def _pagecount(self, html_text, page, got):
        pages = [int(x) for x in re.findall(r'[?&]page=(\d+)', html_text or "")]
        pages = [p for p in pages if 0 < p < 100000]
        if pages:
            return max(pages)
        return page if got < 20 else page + 1

    def _get(self, url):
        try:
            r = self.session.get(url, headers=self.HEADERS, timeout=20, verify=False)
            r.encoding = "utf-8"
            if r.status_code < 400:
                return r.text
        except Exception:
            pass
        return ""

    def _match(self, text, pattern):
        m = re.search(pattern, text or "", re.S | re.I)
        return m.group(1).strip() if m and m.lastindex else ""

    def _clean(self, text):
        text = re.sub(r'<.*?>', '', text or '')
        for a, b in (('&nbsp;', ' '), ('&amp;', '&'), ('&#038;', '&'), ('&quot;', '"'), ('&#039;', "'")):
            text = text.replace(a, b)
        return re.sub(r'\s+', ' ', text).strip()

    def _to_int(self, v, default=0):
        try:
            return int(str(v).strip())
        except Exception:
            return default
