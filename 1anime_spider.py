# -*- coding: utf-8 -*-
"""第一动漫 (1anime.me) TVBox / CatVodSpider 源。

站点形态（2026-11 实测）：
  - 苹果CMS (MacCMS)，模板 mxone
  - 列表卡片：<div class="module-item">，详情链接 /voddetail/<id>.html，
    封面在 img[data-src]，备注在 .module-item-text
  - 分类：站点导航只有「绅士」一支还有内容，/vodshow/<tid>-... 形式翻页
    （12 段，页码在第 9 段）；其余频道 (TV动画/剧场版等) 站点本身列表为空
  - 搜索：/vodsearch/<关键词>-... （14 段，页码在第 11 段），
    结果卡片是 <div class="module-search-item">
  - 详情：选集在 #glist-<sid> 里，播放页 /vodplay/<id>-<sid>-<nid>.html
  - 播放页有 player_aaaa JSON，url 是直链 .m3u8 / .mp4（encrypt=0）

约定：单文件、只依赖 requests、Python 3、vod_id 一律用绝对 URL。
"""
import base64
import json
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
    BASE_URL = "https://1anime.me"
    FALLBACK_URLS = ["https://1anime.me"]
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    # 来自站点真实导航 + vodshow 实测（每个都有内容）；不要凭想象加
    CLASSES = [
        {"type_id": "3", "type_name": "绅士"},
        {"type_id": "20", "type_name": "里番"},
        {"type_id": "21", "type_name": "短片"},
        {"type_id": "22", "type_name": "3D"},
    ]

    def __init__(self):
        super().__init__()
        self.name = "第一动漫"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._page_cache = {}   # 播放直链 -> 播放页 URL

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        html = self._get(self.BASE_URL + "/")
        return {"class": [dict(c) for c in self.CLASSES], "filters": {},
                "list": self._parse_list(html), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_list(self._get(self.BASE_URL + "/"))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        tid = str(tid or "3").strip()
        # /vodshow/<tid>-... 共 12 段，页码在第 9 段（index 8）
        parts = [tid] + [""] * 11
        if page > 1:
            parts[8] = str(page)
        url = self.BASE_URL + "/vodshow/" + "-".join(parts) + ".html"
        html = self._get(url)
        data = self._parse_list(html)
        return {"page": page, "pagecount": self._pagecount_show(html, page, len(data)),
                "limit": 72, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        url = self._detail_url(ids[0])
        html = self._get(url)
        if not html:
            return result
        name = self._clean(self._match(html, r'<h1[^>]*>(.*?)</h1>')
                           or self._match(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)'))
        pic = self._match(html, r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)')
        content = self._clean(self._match(html, r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)'))
        year, area = self._year_area(html)
        froms, urls = self._episodes(html)
        if not urls:
            return result
        result["list"].append({
            "vod_id": url, "vod_name": name,
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
            "type_name": "", "vod_year": year, "vod_area": area,
            "vod_remarks": "", "vod_actor": "", "vod_director": "",
            "vod_content": content,
            "vod_play_from": "$$$".join(froms),
            "vod_play_url": "$$$".join(urls),
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        # /vodsearch/<wd>-... 共 14 段，页码在第 11 段（index 10）
        parts = [urllib.parse.quote(str(key))] + [""] * 13
        if page > 1:
            parts[10] = str(page)
        url = self.BASE_URL + "/vodsearch/" + "-".join(parts) + ".html"
        html = self._get(url)
        data = self._parse_search(html) or self._parse_list(html)
        return {"page": page, "pagecount": self._pagecount_search(html, page, len(data)),
                "limit": 24, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0,
                  "header": {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}}
        if not id:
            return result
        id = str(id)
        if ".m3u8" in id or ".mp4" in id:
            return result
        play_page = id if id.startswith("http") else urllib.parse.urljoin(self.BASE_URL, id)
        direct = self._play_direct(play_page)
        if direct:
            self._page_cache[direct] = play_page
            result["url"] = direct
            result["header"] = {"User-Agent": self.HEADERS["User-Agent"], "Referer": play_page}
        else:
            result["url"] = play_page
            result["parse"] = 1
        return result

    # ---------------- 内部 ----------------

    def _detail_url(self, raw):
        raw = str(raw or "").strip()
        if raw.startswith("http"):
            return raw
        m = re.search(r'(\d+)', raw)
        return self.BASE_URL + "/voddetail/" + (m.group(1) if m else raw) + ".html"

    def _vodshow_url(self, tid, page):
        parts = [str(tid)] + [""] * 11
        if page > 1:
            parts[8] = str(page)
        return self.BASE_URL + "/vodshow/" + "-".join(parts) + ".html"

    def _parse_list(self, html):
        """首页 / 分类页卡片：按 <div class="module-item"> 切块。"""
        data, seen = [], set()
        if not html:
            return data
        chunks = re.split(r'<div class="module-item">', html)
        for chunk in chunks[1:]:
            href = self._match(chunk, r'href=["\'](/voddetail/\d+\.html)["\']')
            if not href:
                continue
            full = urllib.parse.urljoin(self.BASE_URL, href)
            if full in seen:
                continue
            name = self._clean(self._match(chunk, r'class=["\']module-item-title["\'][^>]*title=["\']([^"\']+)')
                               or self._match(chunk, r'class=["\']module-item-title["\'][^>]*>([^<]+)')
                               or self._match(chunk, r'<a href=["\']/voddetail/\d+\.html["\'] title=["\']([^"\']+)')
                               or self._match(chunk, r'alt=["\']([^"\']+)'))
            if not name:
                continue
            pic = (self._match(chunk, r'data-src=["\']([^"\']+)')
                   or self._match(chunk, r'<img[^>]+src=["\']([^"\']+)'))
            remarks = self._clean(self._match(chunk, r'<div class="module-item-text">(.*?)</div>'))
            seen.add(full)
            data.append({"vod_id": full, "vod_name": name,
                         "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
                         "vod_remarks": remarks})
        return data

    def _parse_search(self, html):
        """搜索结果卡片：<div class="module-search-item">。"""
        data, seen = [], set()
        if not html:
            return data
        chunks = re.split(r'<div class="module-search-item">', html)
        for chunk in chunks[1:]:
            href = self._match(chunk, r'<h3>\s*<a href=["\'](/voddetail/\d+\.html)["\']')
            if not href:
                href = self._match(chunk, r'href=["\'](/voddetail/\d+\.html)["\']')
            if not href:
                continue
            full = urllib.parse.urljoin(self.BASE_URL, href)
            if full in seen:
                continue
            name = self._clean(self._match(chunk, r'<h3>\s*<a[^>]+title=["\']([^"\']+)')
                               or self._match(chunk, r'<h3>\s*<a[^>]*>([^<]+)')
                               or self._match(chunk, r'alt=["\']([^"\']+)'))
            if not name:
                continue
            pic = (self._match(chunk, r'data-src=["\']([^"\']+)')
                   or self._match(chunk, r'<img[^>]+src=["\']([^"\']+)'))
            remarks = self._clean(self._match(chunk, r'class=["\']video-serial["\'][^>]*>([^<]+)'))
            seen.add(full)
            data.append({"vod_id": full, "vod_name": name,
                         "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
                         "vod_remarks": remarks})
        return data

    def _episodes(self, html):
        """详情页选集：线路名在 .module-tab-item 的 data-dropdown-value，
        第 sid 个线路对应 #glist-<sid>，里面的 vodplay 链接就是选集。"""
        tab_names = re.findall(r'data-dropdown-value=["\']([^"\']+)["\']', html or "")
        groups = {}
        for m in re.finditer(r'id=["\']glist-(\d+)["\']', html or ""):
            sid = int(m.group(1))
            start = m.start()
            nxt = re.search(r'id=["\']glist-\d+["\']', html[start + 10:])
            end = start + 10 + nxt.start() if nxt else len(html)
            seg = html[start:end]
            eps, seen = [], set()
            for a in re.finditer(r'href=["\'](/vodplay/[^"\']+)["\'][^>]*>(.*?)</a>', seg, re.S):
                href = a.group(1)
                if href in seen:
                    continue
                seen.add(href)
                ep = self._clean(a.group(2)) or self._clean(self._match(a.group(0), r'title=["\']([^"\']+)'))
                ep = re.sub(r'^.*?第', '第', ep) if '第' in ep else ep
                eps.append((ep or ("第%d集" % (len(eps) + 1)), urllib.parse.urljoin(self.BASE_URL, href)))
            if eps:
                groups[sid] = eps
        if not groups:
            # 兜底：整页 vodplay 链接按 sid 分组
            for a in re.finditer(r'href=["\'](/vodplay/\d+-(\d+)-\d+\.html)["\'][^>]*>(.*?)</a>', html or "", re.S):
                sid = int(a.group(2))
                ep = self._clean(a.group(3))
                if not ep or ep in ("立即播放",):
                    continue
                href = urllib.parse.urljoin(self.BASE_URL, a.group(1))
                groups.setdefault(sid, [])
                if href not in [u for _, u in groups[sid]]:
                    groups[sid].append((ep, href))
        froms, urls = [], []
        for i, sid in enumerate(sorted(groups)):
            name = tab_names[i] if i < len(tab_names) else ("线路%d" % sid)
            froms.append(name)
            urls.append("#".join("%s$%s" % (ep, u) for ep, u in groups[sid]))
        return froms, urls

    def _play_direct(self, play_page):
        html = self._get(play_page)
        if not html:
            return ""
        m = re.search(r'player_aaaa\s*=\s*(\{.*?\})\s*</script>', html, re.S)
        if not m:
            return self._match(html, r'["\'](https?://[^"\']+\.(?:m3u8|mp4)[^"\']*)')
        try:
            data = json.loads(m.group(1))
        except Exception:
            return self._match(m.group(1), r'"url"\s*:\s*"([^"]+)"').replace("\\/", "/")
        url = str(data.get("url") or "")
        try:
            enc = int(data.get("encrypt") or 0)
        except Exception:
            enc = 0
        if enc == 1:
            url = urllib.parse.unquote(url)
        elif enc == 2:
            try:
                url = urllib.parse.unquote(base64.b64decode(url).decode("utf-8", "ignore"))
            except Exception:
                pass
        return urllib.parse.urljoin(self.BASE_URL, url)

    def _year_area(self, html):
        year, area = "", ""
        for href in re.findall(r'href=["\'](/vodshow/[^"\']+)["\']', html or ""):
            core = href.split("/")[-1].replace(".html", "")
            fields = urllib.parse.unquote(core).split("-")
            if len(fields) == 12:
                if fields[1] and not area:
                    area = fields[1]
                if fields[11].isdigit() and len(fields[11]) == 4 and not year:
                    year = fields[11]
            if year and area:
                break
        return year, area

    def _pagecount_show(self, html, page, got):
        nums = []
        for href in re.findall(r'href=["\'](/vodshow/[^"\']+)["\']', html or ""):
            fields = href.split("/")[-1].replace(".html", "").split("-")
            if len(fields) == 12 and fields[8].isdigit():
                nums.append(int(fields[8]))
        if nums:
            return max(max(nums), page)
        return page if got < 10 else page + 1

    def _pagecount_search(self, html, page, got):
        nums = []
        for href in re.findall(r'href=["\'](/vodsearch/[^"\']+)["\']', html or ""):
            fields = href.split("/")[-1].replace(".html", "").split("-")
            if len(fields) == 14 and fields[10].isdigit():
                nums.append(int(fields[10]))
        if nums:
            return max(max(nums), page)
        return page if got < 10 else page + 1

    def _get(self, url, headers=None):
        for real in self._candidate_urls(url):
            h = dict(self.HEADERS)
            if headers:
                h.update(headers)
            for _ in range(5):
                try:
                    r = self.session.get(real, headers=h, timeout=15, verify=False)
                    r.encoding = "utf-8"
                    if r.status_code < 400 and "Just a moment" not in r.text and "cf-browser-verification" not in r.text:
                        return r.text
                except Exception:
                    pass
                time.sleep(0.8)
        return ""

    def _candidate_urls(self, url):
        urls = [url]
        p = urllib.parse.urlparse(str(url or ""))
        if p.netloc:
            for host in self.FALLBACK_URLS:
                hp = urllib.parse.urlparse(host)
                if hp.netloc and hp.netloc != p.netloc:
                    urls.append(host + p.path + ("?" + p.query if p.query else ""))
        return list(dict.fromkeys(urls))

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
