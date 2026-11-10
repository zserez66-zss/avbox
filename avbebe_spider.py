# -*- coding: utf-8 -*-
"""Avbebe（avbebe.com）TVBox / CatVodSpider 源

WordPress + jNews 主题，详情页播放器是 FV Flowplayer，地址藏在
`<div id="wpfp_..." data-item="{&quot;sources&quot;:[...]}">` 这段
HTML 转义 JSON 里，解出来就是 m3u8。

注意：m3u8（52cute.com）和分片都校验 Referer，不带
`Referer: https://avbebe.com/` 会 403。
"""
import html
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
    BASE_URL = "https://avbebe.com"
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }

    def __init__(self):
        super().__init__()
        self.name = "Avbebe"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        html_text = self._get(self.BASE_URL + "/?post_type=post")
        return {"class": self._classes(), "filters": {}, "list": self._parse_list(html_text),
                "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_list(self._get(self.BASE_URL + "/?post_type=post"))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1) or 1
        path = str(tid or "").strip("/")
        if not path:
            url = self.BASE_URL + "/?post_type=post" + ("&paged=%d" % page if page > 1 else "")
        else:
            url = self.BASE_URL + "/" + "/".join(urllib.parse.quote(s) for s in path.split("/") if s)
            if page > 1:
                url += "/page/%d" % page
        html_text = self._get(url)
        data = self._parse_list(html_text)
        return {"page": page, "pagecount": self._pagecount(html_text, page, len(data)),
                "limit": 36, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        raw = str(ids[0])
        url = raw if raw.startswith("http") else self.BASE_URL + "/archives/" + raw.strip("/")
        html_text = self._get(url)
        if not html_text:
            return result
        item = self._player_item(html_text) or {}
        sources = [x.get("src") for x in (item.get("sources") or []) if isinstance(x, dict) and x.get("src")]
        if not sources:
            embed = self._embed_m3u8(html_text)
            if embed:
                sources = [embed]
        name = self._clean(item.get("fv_title") or "")
        if not name:
            name = self._clean(self._match(html_text, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)')
                               or self._match(html_text, r'<h1[^>]*>(.*?)</h1>'))
        pic = item.get("splash") or self._match(html_text, r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)')
        dur = self._dur(item.get("duration"))
        ld = self._ld(html_text)
        cats = ",".join([self._clean(x) for x in (ld.get("articleSection") or []) if x])
        urls = []
        for i, src in enumerate(sources):
            if src:
                urls.append(("正片" if i == 0 else "线路%d" % (i + 1)) + "$" + src)
        if not urls:
            return result
        result["list"].append({"vod_id": url, "vod_name": name, "vod_pic": pic, "type_name": cats,
                               "vod_year": "", "vod_area": "", "vod_remarks": dur, "vod_actor": "",
                               "vod_director": "", "vod_content": name, "vod_play_from": "Avbebe",
                               "vod_play_url": "#".join(urls)})
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1) or 1
        url = self.BASE_URL + "/?s=" + urllib.parse.quote(str(key or ""))
        if page > 1:
            url += "&page=%d" % page
        html_text = self._get(url)
        data = self._parse_list(html_text)
        return {"page": page, "pagecount": self._pagecount(html_text, page, len(data)),
                "limit": 36, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        hdr = {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0, "header": hdr}
        if not id:
            return result
        if ".m3u8" in id or ".mp4" in id:
            return result
        raw = str(id)
        if "/e/" in raw:                       # 直接拿到嵌入播放器地址
            m3u8 = self._embed_of(raw)
            if m3u8:
                result["url"] = m3u8
                return result
        url = raw if raw.startswith("http") else self.BASE_URL + "/archives/" + raw.strip("/")
        page = self._get(url)
        item = self._player_item(page) or {}
        for s in item.get("sources") or []:
            if isinstance(s, dict) and s.get("src"):
                result["url"] = s["src"]
                return result
        m3u8 = self._embed_m3u8(page)
        if m3u8:
            result["url"] = m3u8
            return result
        result["parse"] = 1
        return result

    def isVideoFormat(self, url):
        return bool(re.search(r'\.(m3u8|mp4)(\?|$)', str(url or ""), re.I))

    def manualVideoCheck(self):
        return False

    # ---------------- 内部 ----------------

    def _classes(self):
        if self._class_cache:
            return self._class_cache
        self._class_cache = [
            {"type_id": "archives/category/new", "type_name": "新番"},
            {"type_id": "archives/category/h動畫影片", "type_name": "動畫卡通"},
            {"type_id": "archives/category/3d動畫", "type_name": "3D動畫"},
            {"type_id": "archives/category/泡麵番", "type_name": "泡麵番"},
            {"type_id": "archives/category/成人h漫畫", "type_name": "綜合漫畫"},
            {"type_id": "archives/category/高清中字", "type_name": "高清中字"},
            {"type_id": "archives/category/馬賽克破解", "type_name": "馬賽克破解"},
            {"type_id": "archives/category/高清素人", "type_name": "高清素人"},
            {"type_id": "archives/category/高清素人/絕美逸品", "type_name": "絕美逸品"},
            {"type_id": "archives/category/華語av", "type_name": "華語AV"},
        ]
        return self._class_cache

    def _parse_list(self, html_text):
        data, seen = [], set()
        for blk in re.findall(r'<article[^>]*class="[^"]*jeg_post[^"]*"[\s\S]*?</article>', html_text or ""):
            href = self._match(blk, r'href="(https?://[^"]*/archives/\d+)"')
            if not href:
                continue
            name = self._clean(self._match(blk, r'<h3[^>]*class="[^"]*jeg_post_title[^"]*"[^>]*>\s*<a[^>]*>(.*?)</a>')
                               or self._match(blk, r'<img[^>]*alt="([^"]+)"'))
            pic = self._match(blk, r'data-src="([^"]+)"') or self._match(blk, r'<img[^>]+src="(https?://[^"]+)"')
            remarks = self._clean(self._match(blk, r'fa-clock-o[^>]*></i>\s*([^<]+)'))
            if href in seen or not name:
                continue
            seen.add(href)
            data.append({"vod_id": href, "vod_name": name, "vod_pic": pic, "vod_remarks": remarks})
        return data

    def _player_item(self, html_text):
        m = re.search(r'data-item="([^"]+)"', html_text or "")
        if not m:
            return {}
        try:
            return json.loads(html.unescape(m.group(1)))
        except Exception:
            try:
                return json.loads(html.unescape(m.group(1)).replace("\\/", "/"))
            except Exception:
                return {}

    def _ld(self, html_text):
        """详情页的 JSON-LD 里有 articleSection（分类），比 HTML 干净。"""
        out = {}
        for raw in re.findall(r'<script[^>]+application/ld\+json[^>]*>([\s\S]*?)</script>', html_text or "", re.I):
            try:
                d = json.loads(raw.strip())
            except Exception:
                continue
            items = d.get("@graph") if isinstance(d, dict) and d.get("@graph") else (d if isinstance(d, list) else [d])
            for it in items:
                if isinstance(it, dict) and (it.get("articleSection") or it.get("@type") in ("VideoObject", "Article", "BlogPosting")):
                    for k, v in it.items():
                        out.setdefault(k, v)
        return out

    def _embed_m3u8(self, html_text):
        """部分文章用 <iframe src="https://play.52cute.com/e/XXX"> 播放，
        进去后 <source src="...index.m3u8">。"""
        for u in re.findall(r'<iframe[^>]+src="([^"]+)"', html_text or ""):
            if "/e/" in u or "52cute" in u:
                m3u8 = self._embed_of(u)
                if m3u8:
                    return m3u8
        return ""

    def _embed_of(self, url):
        page = self._get(url)
        if not page:
            return ""
        m = re.search(r'(https?://[^"\'\s]+?\.m3u8[^"\'\s]*)', page)
        return m.group(1) if m else ""

    def _pagecount(self, html_text, page, got):
        m = re.search(r'Page\s+\d+\s+of\s+(\d+)', html_text or "")
        if m:
            return self._to_int(m.group(1), page)
        return page if got < 10 else page + 1

    def _get(self, url):
        try:
            r = self.session.get(url, headers=self.HEADERS, timeout=20, verify=False)
            r.encoding = "utf-8"
            if r.status_code < 400 and "Just a moment" not in r.text:
                return r.text
        except Exception:
            pass
        return ""

    def _dur(self, sec):
        try:
            sec = int(sec)
        except Exception:
            return ""
        if sec <= 0:
            return ""
        h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
        return ("%d:%02d:%02d" % (h, m, s)) if h else ("%d:%02d" % (m, s))

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
