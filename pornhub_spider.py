# -*- coding: utf-8 -*-
"""Pornhub (cn.pornhub.com) TVBox / CatVodSpider 源。

站点形态（2026-11 实测）：
  - 纯 requests 可达，服务端直接出完整 HTML（首页约 1.2MB）
  - 列表卡片：<li class="pcVideoListItem ... videoblock"，
    data-video-vkey 是 viewkey，标题在 a.linkVideoThumb 的 title 里，
    时长是 <var class="duration">
  - 详情页 /view_video.php?viewkey=<vkey>，播放数据在 flashvars_<id> 的
    mediaDefinitions 里：format=hls 的 videoUrl 是签名 master.m3u8
  - master.m3u8 是多码率 variant playlist，源里会下钻一层，
    直接返回码率最高的 media playlist（分片是真 TS）
  - 所有直链（m3u8 / 缩略图）都是签名 + 绑定请求 IP + 约 2 小时有效，
    所以 vod_play_url 只存详情页地址，每次播放时现回详情页解析，
    在用户自己的设备/网络上解析出来的链就是绑用户 IP 的，能播
  - 分类：/categories 页里有 90 个 /video?c=<id> 分类，homeContent 时
    实时抓取（抓不到时用内置的几个常用分类兜底）
  - 排序：o=cm 最新、o=ht 最热门、o=mv 最多观看、o=tr 最高分
  - 搜索：/video/search?search=<关键词>

约定：单文件、只依赖 requests、Python 3、vod_id 一律用绝对 URL。
"""
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
    BASE_URL = "https://cn.pornhub.com"
    FALLBACK_URLS = ["https://cn.pornhub.com", "https://www.pornhub.com"]
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    FIXED_CLASSES = [
        {"type_id": "", "type_name": "全部视频"},
        {"type_id": "o=cm", "type_name": "最新"},
        {"type_id": "o=ht", "type_name": "最热门"},
        {"type_id": "o=mv", "type_name": "最多观看"},
        {"type_id": "o=tr", "type_name": "最高分"},
    ]
    FALLBACK_CLASSES = [
        {"type_id": "c=1", "type_name": "亚洲人"},
        {"type_id": "c=111", "type_name": "日本人"},
        {"type_id": "c=86", "type_name": "卡通"},
        {"type_id": "c=241", "type_name": "Cosplay"},
        {"type_id": "c=65", "type_name": "3P"},
    ]

    def __init__(self):
        super().__init__()
        self.name = "Pornhub"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    def homeContent(self, filter):
        _, data = self._get_cards(self.BASE_URL + "/")
        return {"class": self._classes(), "filters": {},
                "list": data, "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_cards(self._get(self.BASE_URL + "/"))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        frag = str(tid or "").strip()
        url = self.BASE_URL + "/video"
        qs = frag + ("&" if frag else "") + ("page=%d" % page if page > 1 else "")
        if qs:
            url += "?" + qs
        html, data = self._get_cards(url)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 36, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        url = self._watch_url(ids[0])
        html = self._get(url)
        if not html:
            return result
        fv = self._flashvars(html)
        name = self._clean((fv or {}).get("video_title")
                           or self._match(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)')
                           or self._match(html, r'<title>(.*?)</title>'))
        name = re.sub(r'\s*-\s*Pornhub\.com\s*$', '', name)
        pic = (fv or {}).get("image_url") or self._match(html, r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)')
        content = self._clean(self._match(html, r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)'))
        result["list"].append({
            "vod_id": url, "vod_name": name,
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, str(pic or "")),
            "type_name": "", "vod_year": "", "vod_area": "",
            "vod_remarks": "", "vod_actor": "", "vod_director": "",
            "vod_content": content,
            "vod_play_from": "HLS",
            "vod_play_url": "正片$" + url,
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        url = self.BASE_URL + "/video/" + "search?search=" + urllib.parse.quote(str(key))
        if page > 1:
            url += "&page=%d" % page
        html, data = self._get_cards(url)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 36, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0,
                  "header": {"User-Agent": self.HEADERS["User-Agent"], "Referer": self.BASE_URL + "/"}}
        if not id:
            return result
        id = str(id)
        if ".m3u8" in id or ".mp4" in id:
            return result
        watch = self._watch_url(id)
        html = self._get(watch)
        direct = self._resolve_play(html, watch)
        if direct:
            result["url"] = direct
            result["header"] = {"User-Agent": self.HEADERS["User-Agent"], "Referer": watch}
        else:
            result["url"] = watch
            result["parse"] = 1
        return result

    # ---------------- 内部 ----------------

    def _classes(self):
        if self._class_cache:
            return self._class_cache
        classes = [dict(c) for c in self.FIXED_CLASSES]
        seen = set()
        html = self._get(self.BASE_URL + "/categories")
        for m in re.finditer(r'href="/video\?c=(\d+)"[^>]*>\s*<strong>([^<]+)</strong>', html or ""):
            cid, name = m.group(1), self._clean(m.group(2))
            if cid in seen or not name:
                continue
            seen.add(cid)
            classes.append({"type_id": "c=" + cid, "type_name": name})
        if len(classes) <= len(self.FIXED_CLASSES):
            classes += [dict(c) for c in self.FALLBACK_CLASSES]
        self._class_cache = classes
        return classes

    def _get_cards(self, url):
        """列表页抓取 + 解析；站点偶尔会限流返回空页，空了就退避重试。"""
        html = self._get(url)
        data = self._parse_cards(html)
        for _ in range(2):
            if data:
                break
            time.sleep(2)
            html2 = self._get(url)
            data2 = self._parse_cards(html2)
            if data2:
                html, data = html2, data2
        return html, data

    def _watch_url(self, raw):
        raw = str(raw or "").strip()
        if raw.startswith("http"):
            return raw
        m = re.search(r'viewkey=([A-Za-z0-9]+)', raw)
        vkey = m.group(1) if m else raw
        return self.BASE_URL + "/view_video.php?viewkey=" + vkey

    def _parse_cards(self, html):
        data, seen = [], set()
        if not html:
            return data
        blocks = re.split(r'<li class="pcVideoListItem', html)
        for block in blocks[1:]:
            vkey = (self._match(block, r'data-video-vkey="([^"]+)"')
                    or self._match(block, r'view_video\.php\?viewkey=([A-Za-z0-9]+)'))
            if not vkey or vkey in seen:
                continue
            name = self._clean(self._match(block, r'title="([^"]+)"[^>]*class="[^"]*linkVideoThumb')
                               or self._match(block, r'<img[^>]+alt="([^"]+)"')
                               or self._match(block, r'<span class="title">[\s\S]*?<a[^>]*>([^<]+)</a>'))
            if not name:
                continue
            pic = (self._match(block, r'<img[^>]+src="(https?://[^"]*phncdn[^"]*)"')
                   or self._match(block, r'data-image="(https?://[^"]+)"')
                   or self._match(block, r'<img[^>]+src="([^"]+)"'))
            remarks = self._clean(self._match(block, r'<var class="duration">([^<]+)</var>'))
            seen.add(vkey)
            data.append({"vod_id": self.BASE_URL + "/view_video.php?viewkey=" + vkey,
                         "vod_name": name,
                         "vod_pic": pic,
                         "vod_remarks": remarks})
        return data

    def _flashvars(self, html):
        m = re.search(r'flashvars_\d+\s*=\s*(\{[\s\S]*?\});', html or "")
        if m:
            try:
                return json.loads(m.group(1))
            except Exception:
                pass
        return None

    def _media_definitions(self, html):
        fv = self._flashvars(html)
        if fv and isinstance(fv.get("mediaDefinitions"), list):
            return fv["mediaDefinitions"]
        # 兜底：定位 mediaDefinitions 数组做括号匹配
        idx = (html or "").find('"mediaDefinitions"')
        if idx == -1:
            return []
        start = html.find('[', idx)
        if start == -1:
            return []
        depth = 0
        for i in range(start, len(html)):
            if html[i] == '[':
                depth += 1
            elif html[i] == ']':
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(html[start:i + 1])
                    except Exception:
                        return []
        return []

    def _resolve_play(self, html, watch):
        if not html:
            return ""
        defs = self._media_definitions(html)
        hls = [d for d in defs if isinstance(d, dict) and d.get("format") == "hls" and d.get("videoUrl")]
        hls.sort(key=lambda d: int(d.get("quality") or 0), reverse=True)
        for d in hls:
            master = str(d["videoUrl"]).replace("&amp;", "&")
            media = self._media_playlist(master, watch)
            if media:
                return media
        # 兜底：mp4 的 remote 定义，videoUrl 是一个 get_media 接口，要再取一层
        mp4s = [d for d in defs if isinstance(d, dict) and d.get("format") == "mp4" and d.get("videoUrl")]
        for d in mp4s:
            u = str(d["videoUrl"]).replace("&amp;", "&")
            if ".mp4" in u:
                return u
            body = self._get(u, headers={"Referer": watch})
            found = self._match(body, r'"videoUrl"\s*:\s*"(https?://[^"]+\.mp4[^"]*)').replace("\\/", "/")
            if found:
                return found.replace("&amp;", "&")
        return self._match(html, r'["\'](https?://[^"\']+\.m3u8[^"\']*)').replace("&amp;", "&")

    def _media_playlist(self, master, referer):
        """master 是 variant playlist 时下钻到码率最高的那条 media playlist，
        并逐条验活（个别码率的签名链会 410，验不过就降到下一条）。"""
        body = self._get(master, headers={"Referer": referer})
        if not body or "#EXTM3U" not in body:
            return master  # 取不到就把 master 交给播放器自己处理
        if "#EXT-X-STREAM-INF" not in body:
            return master
        variants = []
        lines = body.splitlines()
        for i, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF"):
                bw = self._to_int(self._match(line, r'BANDWIDTH=(\d+)'), 0)
                for j in range(i + 1, len(lines)):
                    if lines[j].strip():
                        variants.append((bw, urllib.parse.urljoin(master, lines[j].strip())))
                        break
        variants.sort(key=lambda x: -x[0])
        for _, vurl in variants:
            vbody = self._get(vurl, headers={"Referer": referer})
            if vbody and "#EXTINF" in vbody:
                return vurl
        return master

    def _pagecount(self, html, page, got):
        text = (html or "").replace("&amp;", "&")
        nums = []
        for href in re.findall(r'href="([^"]+)"', text):
            nums += [int(n) for n in re.findall(r'[?&]page=(\d+)', href)]
        nums = [n for n in nums if 0 < n < 100000]
        if nums:
            return max(max(nums), page)
        return page if got < 20 else page + 1

    def _get(self, url, headers=None):
        for real in self._candidate_urls(url):
            h = dict(self.HEADERS)
            if headers:
                h.update(headers)
            for _ in range(4):
                try:
                    r = self.session.get(real, headers=h, timeout=20, verify=False)
                    r.encoding = "utf-8"
                    if r.status_code < 400 and "Just a moment" not in r.text and "cf-browser-verification" not in r.text:
                        return r.text
                except Exception:
                    pass
                time.sleep(0.8)
        return ""

    def _candidate_urls(self, url):
        urls = [str(url or "")]
        p = urllib.parse.urlparse(urls[0])
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
        text = re.sub(r'<.*?>', '', str(text or ''))
        for a, b in (('&nbsp;', ' '), ('&amp;', '&'), ('&#038;', '&'), ('&quot;', '"'), ('&#039;', "'")):
            text = text.replace(a, b)
        return re.sub(r'\s+', ' ', text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
