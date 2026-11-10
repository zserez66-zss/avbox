# -*- coding: utf-8 -*-
"""TwittHub (www.twitthub.com) —— TVBox / CatVodSpider 源。

站点形态（2026-11-08 侦察）：
  - X / Twitter 视频聚合站，无分类，只有一个「最新」流：
    约 5608 条、每页 24 条、234 页，分页 /?page=N
  - 搜索：/?q=<关键词> 服务端出卡（同一套卡片网格）
  - 列表卡片（按结构解析，不依赖 class 名）：主锚点
    <a href="/v/<推文status id>" aria-label="观看<标题> - @<handle> 分享的视频">
    内含 supabase 图床的 webp 缩略图与时长文本（如 33:15）；
    同一 /v/<id> 还会以标题链接再出现一次，按 status id 去重；
    作者链接 <a href="/author/<handle>">，卡片另有日期与播放量文本
  - 详情页 /v/<id> 的 id 就是原推文 status id
  - 本站对机房出口有 Vercel Security Checkpoint（沙箱里 requests 拿 429）：
    取到验证页时一律返回空列表，绝不把验证页当内容解析；
    真机（用户网络/浏览器环境）可正常打开
  - 播放解析走 FixTweet 公开 API（沙箱可达、已实测）：
    GET https://api.fxtwitter.com/<handle>/status/<status id>
    -> tweet.media.videos[].formats 里挑 container=mp4 的最高 bitrate，
    退回 videos[].url；均为 video.twimg.com 的 MP4 直链，
    Range 探测 206 / video/mp4 / ftyp，不需要 Referer；
    API 失败时退回 parse:1 打开本站详情页
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
    BASE_URL = "https://www.twitthub.com"
    FX_URL = "https://api.fxtwitter.com"
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    CLASSES = [("latest", "最新")]
    PAGE_SIZE = 24

    def __init__(self):
        super().__init__()
        self.name = "TwittHub"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------------- 对外接口 ----------------

    def homeContent(self, filter):
        html = self._get(self.BASE_URL + "/?page=1")
        return {"class": self._classes(), "filters": {},
                "list": self._parse_cards(html), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_cards(self._get(self.BASE_URL + "/?page=1"))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        url = "%s/?page=%d" % (self.BASE_URL, page)
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": self.PAGE_SIZE, "total": 99999, "list": data,
                "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        handle, sid = self._split_ref(ids[0])
        if not sid:
            return result
        ref = (handle + "/" + sid) if handle else sid
        name = ("@%s 的视频" % handle) if handle else "视频"
        result["list"].append({
            "vod_id": ref, "vod_name": name, "vod_pic": "",
            "type_name": "", "vod_year": "", "vod_area": "",
            "vod_remarks": "", "vod_actor": "", "vod_director": "",
            "vod_content": "",
            "vod_play_from": "播放",
            "vod_play_url": "播放$" + ref,
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        url = "%s/?q=%s" % (self.BASE_URL, urllib.parse.quote(str(key), safe=""))
        if page > 1:
            url += "&page=%d" % page
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": self.PAGE_SIZE, "total": 99999, "list": data,
                "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        handle, sid = self._split_ref(id)
        mp4 = self._resolve_mp4(handle, sid) if sid else ""
        if mp4:
            return {"parse": 0, "playUrl": "", "url": mp4, "jx": 0,
                    "header": {"User-Agent": self.HEADERS["User-Agent"]}}
        # 解析失败：把本站详情页交给播放器解析（兜底）
        fallback = (self.BASE_URL + "/v/" + sid) if sid else str(id or "")
        return {"parse": 1, "playUrl": "", "url": fallback, "jx": 1,
                "header": {"User-Agent": self.HEADERS["User-Agent"]}}

    # ---------------- 播放解析（FixTweet API） ----------------

    def _resolve_mp4(self, handle, sid):
        if not sid:
            return ""
        api = "%s/%s/status/%s" % (self.FX_URL, handle or "i", sid)
        try:
            r = self.session.get(api, timeout=15, verify=False,
                                 headers={"User-Agent": self.HEADERS["User-Agent"],
                                          "Accept": "application/json"})
            if r.status_code >= 400:
                return ""
            tweet = (r.json() or {}).get("tweet") or {}
        except Exception:
            return ""
        media = tweet.get("media") or {}
        videos = media.get("videos") or []
        if not videos:
            for item in media.get("all") or []:
                if isinstance(item, dict) and item.get("type") == "video":
                    videos.append(item)
        best_url, best_rate = "", -1
        for v in videos:
            if not isinstance(v, dict):
                continue
            for f in v.get("formats") or []:
                if not isinstance(f, dict):
                    continue
                u = f.get("url") or ""
                if not u.endswith(".mp4") and ".mp4" not in u:
                    continue
                if f.get("container") not in (None, "mp4"):
                    continue
                rate = f.get("bitrate") or 0
                if rate > best_rate:
                    best_url, best_rate = u, rate
            if not best_url and v.get("url"):
                best_url = v["url"]
        return best_url

    # ---------------- 列表解析 ----------------

    def _classes(self):
        return [{"type_id": slug, "type_name": name} for slug, name in self.CLASSES]

    def _parse_cards(self, html):
        """卡片：以 href=/v/<id> 的锚点切块（下一卡片锚点为界），块内取图/时长/作者/标题。"""
        html = html or ""
        if not html or self._is_checkpoint(html):
            return []
        anchors = [(m.start(), m.group(1), m.group(0)) for m in
                   re.finditer(r'<a\b[^>]*href=["\']/v/(\d{10,})["\'][^>]*>', html, re.I)]
        data, seen = [], set()
        for i, (start, sid, tag) in enumerate(anchors):
            if sid in seen:
                continue
            # 块边界：下一个「不同 id」的卡片锚点（同 id 的标题链接仍算本卡内容）
            end = len(html)
            for j in range(i + 1, len(anchors)):
                if anchors[j][1] != sid:
                    end = anchors[j][0]
                    break
            block = html[start:min(end, start + 8000)]
            card = self._parse_block(block, tag, sid)
            if card:
                seen.add(sid)
                data.append(card)
        return data

    def _parse_block(self, block, anchor_tag, sid):
        img = self._match(block, r"<img\b[^>]*\bsrc=[\"']([^\"']+)")
        if not img:
            return None
        label = (self._match(anchor_tag, r'aria-label=["\']([^"\']*)')
                 or self._match(block, r"<img\b[^>]*\balt=[\"']([^\"']*)"))
        handle = self._match(block, r'href=["\']/author/([A-Za-z0-9_]+)["\']')
        if not handle:
            hm = re.search(r"@([A-Za-z0-9_]+)\s*分享的视频", label)
            handle = hm.group(1) if hm else ""
        title = self._title_from_label(label, handle)
        text = re.sub(r"<img\b[^>]*>", " ", block)
        text = re.sub(r"<[^>]+>", " ", text)
        duration = self._match(text, r"\b(\d{1,2}:\d{2}(?::\d{2})?)\b")
        views = self._match(text, r"([\d.]+\s*万|[\d,]{2,})\s*(?:播放|次观看|views?)")
        remarks = duration
        if views:
            remarks = (remarks + " · " if remarks else "") + "▶" + views.strip()
        return {
            "vod_id": (handle + "/" + sid) if handle else sid,
            "vod_name": title or (("@" + handle) if handle else sid),
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, img),
            "vod_remarks": remarks,
        }

    def _title_from_label(self, label, handle):
        t = self._clean(label)
        if t.startswith("观看"):
            t = t[len("观看"):].strip()
        if t.endswith("分享的视频"):
            t = t[:-len("分享的视频")].strip()
        if handle:
            suffix = "- @" + handle
            if t.endswith(suffix):
                t = t[:-len(suffix)].strip()
            t = t.rstrip("-").strip() if t == "@" + handle else t
        if not t or (handle and t == "@" + handle):
            return ("@" + handle) if handle else t
        return t

    def _pagecount(self, html, page, got):
        html = html or ""
        nums = [int(n) for n in re.findall(r"[?&]page=(\d+)", html)]
        m = re.search(r"共\s*(\d+)\s*页", html)
        if m:
            nums.append(int(m.group(1)))
        nums = [n for n in nums if 0 < n < 100000]
        if nums:
            return max(max(nums), page)
        if got >= self.PAGE_SIZE:
            return 999
        return page

    def _is_checkpoint(self, html):
        head = (html or "")[:4000]
        return "Vercel Security Checkpoint" in head or "vercel" in head.lower() and "checkpoint" in head.lower()

    # ---------------- 工具 ----------------

    def _split_ref(self, ref):
        s = str(ref or "").strip()
        m = re.search(r"/v/(\d{10,})", s)
        if m:
            hm = re.search(r"/author/([A-Za-z0-9_]+)", s)
            return (hm.group(1) if hm else ""), m.group(1)
        m = re.search(r"([A-Za-z0-9_]+)/(\d{10,})", s)
        if m:
            return m.group(1), m.group(2)
        m = re.search(r"(\d{10,})", s)
        if m:
            return "", m.group(1)
        return "", ""

    def _get(self, url, headers=None):
        h = dict(self.HEADERS)
        if headers:
            h.update(headers)
        for attempt in range(2):
            try:
                r = self.session.get(url, headers=h, timeout=15, verify=False)
                r.encoding = "utf-8"
                if r.status_code == 429 or self._is_checkpoint(r.text):
                    return ""  # Vercel 验证页：不解析、不重试硬闯
                if r.status_code < 400:
                    return r.text
                return ""
            except Exception:
                pass
            if attempt == 0:
                time.sleep(1)
        return ""

    def _match(self, text, pattern):
        m = re.search(pattern, text or "", re.S | re.I)
        return m.group(1).strip() if m and m.lastindex else ""

    def _clean(self, text):
        text = re.sub(r"<.*?>", "", text or "", flags=re.S)
        for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&#038;", "&"),
                     ("&quot;", '"'), ("&#039;", "'"), ("&lt;", "<"), ("&gt;", ">")):
            text = text.replace(a, b)
        return re.sub(r"\s+", " ", text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
