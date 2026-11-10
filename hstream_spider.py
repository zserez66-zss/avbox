# -*- coding: utf-8 -*-
"""HStream（hstream.moe）TVBox / CatVodSpider 源

Laravel + Livewire + Alpine，页面里没有直接写播放地址，流程是：
  1. 详情页里的隐藏域 <input id="e_id" value="2051"> 是集数 id
  2. POST /player/api  {"episode_id": 2051}  ->  返回 stream_url 和一组 CDN 域名
     （Laravel 要求带 XSRF-TOKEN，所以先 GET 一次页面拿 cookie）
  3. 播放地址 = {cdn}/{stream_url}/x264.720p.mp4（DASH 另有 720/1080/2160 的 manifest.mpd）
列表/搜索都在 /search?order=...&page=N，每页 25 条，页尾有 "of N results" 可算总页数。
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
    BASE_URL = "https://hstream.moe"
    PER_PAGE = 25
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        "Referer": BASE_URL + "/",
    }

    def __init__(self):
        super().__init__()
        self.name = "HStream"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        html_text = self._get(self._search_url("recently-uploaded", 1))
        return {"class": self._classes(), "filters": {}, "list": self._parse_list(html_text),
                "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_list(self._get(self._search_url("recently-uploaded", 1)))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1) or 1
        url = self._tid_url(str(tid or "recently-uploaded"), page)
        html_text = self._get(url)
        data = self._parse_list(html_text)
        return {"page": page, "pagecount": self._pagecount(html_text, page, len(data)),
                "limit": self.PER_PAGE, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        raw = str(ids[0])
        url = raw if raw.startswith("http") else self.BASE_URL + "/hentai/" + raw.strip("/")
        html_text = self._get(url)
        if not html_text:
            return result
        name = self._clean(self._match(html_text, r'"name"\s*:\s*"([^"]+)"')
                           or self._match(html_text, r'property="og:title"[^>]*content="([^"]+)"'))
        pic = self._match(html_text, r'property="og:image"[^>]*content="([^"]+)"')
        desc = self._clean(self._match(html_text, r'"description"\s*:\s*"([^"]*)"'))
        tags = ",".join(dict.fromkeys([self._clean(x) for x in re.findall(
            r'/search\?[^"]*tags%5B0%5D=[a-z0-9\-]+[^"]*"[^>]*>\s*([^<]{1,20})\s*<', html_text)]))
        urls = self._lines(url, html_text)
        if not urls:
            urls = ["正片$" + url]
        result["list"].append({"vod_id": url, "vod_name": name or url, "vod_pic": pic,
                               "type_name": tags, "vod_year": "", "vod_area": "",
                               "vod_remarks": "", "vod_actor": "", "vod_director": "",
                               "vod_content": desc or name, "vod_play_from": "HStream",
                               "vod_play_url": "#".join(urls)})
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1) or 1
        url = self.BASE_URL + "/search?q=" + urllib.parse.quote(str(key or ""))
        if page > 1:
            url += "&page=%d" % page
        html_text = self._get(url)
        data = self._parse_list(html_text)
        return {"page": page, "pagecount": self._pagecount(html_text, page, len(data)),
                "limit": self.PER_PAGE, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        hdr = {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0, "header": hdr}
        if not id:
            return result
        if ".mp4" in id or ".m3u8" in id or ".mpd" in id:
            return result
        raw = str(id)
        url = raw if raw.startswith("http") else self.BASE_URL + "/hentai/" + raw.strip("/")
        html_text = self._get(url)
        eid = self._eid(html_text)
        info = self._api(eid, url) if eid else {}
        best = self._pick_domain(info)
        if best:
            result["url"] = best
            return result
        result["parse"] = 1
        return result

    def isVideoFormat(self, url):
        return bool(re.search(r'\.(mp4|m3u8|mpd)(\?|$)', str(url or ""), re.I))

    def manualVideoCheck(self):
        return False

    # ---------------- 内部 ----------------

    def _classes(self):
        if self._class_cache:
            return self._class_cache
        self._class_cache = [
            {"type_id": "recently-uploaded", "type_name": "最新上传"},
            {"type_id": "recently-released", "type_name": "最新发布"},
            {"type_id": "view-count", "type_name": "最多观看"},
            {"type_id": "tag:4k-48fps", "type_name": "4K 48Fps"},
            {"type_id": "tag:uncensored", "type_name": "无码"},
            {"type_id": "tag:big-boobs", "type_name": "巨乳"},
            {"type_id": "tag:maid", "type_name": "女仆"},
            {"type_id": "tag:school-girl", "type_name": "校服"},
            {"type_id": "tag:succubus", "type_name": "魅魔"},
            {"type_id": "tag:elf", "type_name": "精灵"},
            {"type_id": "tag:milf", "type_name": "熟女"},
            {"type_id": "tag:tentacle", "type_name": "触手"},
        ]
        return self._class_cache

    def _search_url(self, order, page):
        url = "%s/search?order=%s" % (self.BASE_URL, order)
        if page > 1:
            url += "&page=%d" % page
        return url

    def _tid_url(self, tid, page):
        if tid.startswith("tag:"):
            return "%s/search?order=recently-uploaded&tags%%5B0%%5D=%s%s" % (
                self.BASE_URL, urllib.parse.quote(tid[4:]), ("&page=%d" % page) if page > 1 else "")
        return self._search_url(tid, page)

    def _parse_list(self, html_text):
        data, seen = [], set()
        for blk in re.split(r'(?=wire:key="episode-)', html_text or "")[1:]:
            blk = blk[:2200]
            href = self._match(blk, r'<a\s+href="(https?://[^"]+/hentai/[^"]+)"')
            if not href:
                continue
            name = self._clean(self._match(blk, r'<img[^>]*alt="([^"]+)"'))
            pic = self._match(blk, r'<img[^>]*src="([^"]+)"')
            if href in seen or not name:
                continue
            seen.add(href)
            data.append({"vod_id": href, "vod_name": name,
                         "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic), "vod_remarks": ""})
        return data

    def _pagecount(self, html_text, page, got):
        m = re.search(r'of\s*<span[^>]*>\s*(\d+)\s*</span>\s*results', html_text or "")
        if m:
            total = self._to_int(m.group(1))
            return max(1, (total + self.PER_PAGE - 1) // self.PER_PAGE)
        return page if got < 10 else page + 1

    def _eid(self, html_text):
        return self._match(html_text, r'id="e_id"[^>]*value="([^"]*)"')

    def _api(self, eid, page_url=""):
        """POST /player/api；Laravel 需要 XSRF-TOKEN，先保证有 cookie。"""
        if not eid:
            return {}
        if not self.session.cookies.get("XSRF-TOKEN"):
            self._get(self.BASE_URL + "/")
        tok = urllib.parse.unquote(self.session.cookies.get("XSRF-TOKEN") or "")
        h = {"Content-Type": "application/json", "Accept": "application/json",
             "X-Requested-With": "XMLHttpRequest",
             "Referer": page_url or (self.BASE_URL + "/"),
             "Origin": self.BASE_URL}
        if tok:
            h["X-XSRF-TOKEN"] = tok
        try:
            r = self.session.post(self.BASE_URL + "/player/api", json={"episode_id": eid},
                                  headers=h, timeout=20, verify=False)
            if r.status_code == 200:
                return r.json() or {}
        except Exception:
            pass
        return {}

    def _mp4_url(self, domain, stream_url):
        return "%s/%s/x264.720p.mp4" % (str(domain).rstrip("/"), str(stream_url).strip("/"))

    def _lines(self, page_url, html_text):
        eid = self._eid(html_text)
        info = self._api(eid, page_url) if eid else {}
        stream_url = info.get("stream_url") or ""
        if not stream_url:
            return []
        doms = list(info.get("stream_domains") or []) + list(info.get("asia_stream_domains") or [])
        doms = [d for d in dict.fromkeys(doms) if d][:5]
        # 详情页不做连通性探测（太慢），播放时 playerContent 会自动挑能连的
        urls = ["线路%d$%s" % (i + 1, self._mp4_url(d, stream_url)) for i, d in enumerate(doms)]
        for q, label in (("1080", "1080P(DASH)"), ("2160", "4K(DASH)")):
            mpd = self._dash(doms, stream_url, q)
            if mpd:
                urls.append(label + "$" + mpd)
        return urls

    def _dash(self, doms, stream_url, quality):
        """DASH 清单：{cdn}/{stream}/2160/manifest.mpd，挑第一个能通的域名。"""
        for d in doms[:3]:
            u = "%s/%s/%s/manifest.mpd" % (str(d).rstrip("/"), str(stream_url).strip("/"), quality)
            try:
                r = self.session.get(u, headers={"User-Agent": self.HEADERS["User-Agent"],
                                                 "Referer": self.BASE_URL + "/",
                                                 "Range": "bytes=0-120"},
                                     timeout=5, verify=False)
                if r.status_code in (200, 206) and "MPD" in r.text[:200]:
                    return u
            except Exception:
                continue
        return ""

    def _live(self, doms, stream_url):
        """并发探测各 CDN 是否可用（每个 4 秒超时）。"""
        def check(d):
            try:
                r = self.session.get(self._mp4_url(d, stream_url),
                                     headers={"User-Agent": self.HEADERS["User-Agent"],
                                              "Referer": self.BASE_URL + "/",
                                              "Range": "bytes=0-99"},
                                     timeout=4, verify=False, stream=True)
                next(r.iter_content(16), b"")
                code = r.status_code
                r.close()
                return d if code in (200, 206) else None
            except Exception:
                return None
        try:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=min(6, len(doms) or 1)) as ex:
                out = list(ex.map(check, doms))
        except Exception:
            out = []
        return [x for x in out if x]

    def _pick_domain(self, info):
        """播放时挑一个能连通的 CDN。"""
        stream_url = info.get("stream_url") or ""
        if not stream_url:
            return ""
        doms = list(info.get("stream_domains") or []) + list(info.get("asia_stream_domains") or [])
        for d in dict.fromkeys(doms):
            if not d:
                continue
            u = self._mp4_url(d, stream_url)
            try:
                r = self.session.get(u, headers={"User-Agent": self.HEADERS["User-Agent"],
                                                 "Referer": self.BASE_URL + "/",
                                                 "Range": "bytes=0-99"},
                                     timeout=8, verify=False, stream=True)
                next(r.iter_content(32), b"")
                r.close()
                if r.status_code in (200, 206):
                    return u
            except Exception:
                continue
        return ""

    def _get(self, url):
        try:
            r = self.session.get(url, headers=self.HEADERS, timeout=20, verify=False)
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
