# -*- coding: utf-8 -*-
"""Pektino (pektino.com) —— TVBox / CatVodSpider 源。

站点形态：
  - pektino.com 是「X 视频保存排行榜」（原 twitter-ero-video-ranking.com /
    truvaze.com）的现行域名，条目来自站内公开 JSON 接口
    GET /api/media，条目自带 mp4 直链（多为 video.twimg.com），无详情页解析。
  - 接口契约（取自该接口的开源客户端源码，2026-11-08 核对）：
      参数 page(1 起) / per_page=30 / range(必填) / ids="" / category="" /
           isFilteredOnly="0" / sort="pv"，头 Accept: application/json
      range 取值：日榜=timely（不是 daily，传错返回空列表）、周榜=weekly、
                  月榜=monthly、总榜=all
      返回 {"items": [...], "currentPage": int, "lastPage": int}
      item 字段：id（推文 id）/ mp4（直链）/ thumbnail / title（可空）/
                 pv / favorite / tweet_url / url_cd
  - 接口没有关键词参数，本源不提供搜索（searchContent 恒返回空）。
  - Aibox DS 版已在真机验证：分类可加载出内容，接口与上述参数无误；
    本 py 版的播放走 TVBox 栈（playerContent 直通 mp4 + UA 头，
    twimg 直链由下载器以普通 requests 拉取验证过，无需 Referer）。
"""
import hashlib
import re
import time
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
    BASE_URL = "https://pektino.com"
    API_URL = BASE_URL + "/api/media"
    FALLBACK_URLS = ["https://pektino.com"]
    UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
    HEADERS = {"User-Agent": UA, "Accept": "application/json"}
    PER_PAGE = 30
    # (type_id=range 取值, type_name)；range 必须原样传，timely 是日榜
    RANGES = [("timely", "日榜"), ("weekly", "周榜"),
              ("monthly", "月榜"), ("all", "总榜")]

    def __init__(self):
        super().__init__()
        self.name = "Pektino"
        self._meta = {}  # mp4 直链 -> (标题, 封面, 备注)，供 detailContent 回填

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------------- 对外接口 ----------------

    def homeContent(self, filter):
        items, _ = self._fetch_range("timely", 1)
        return {"class": self._classes(), "filters": {},
                "list": items, "parse": 0, "jx": 0}

    def homeVideoContent(self):
        items, _ = self._fetch_range("timely", 1)
        return {"list": items}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        rng = str(tid or "timely")
        if rng not in dict(self.RANGES):
            rng = "timely"
        items, last = self._fetch_range(rng, page)
        pagecount = last if last >= page else (page if len(items) < self.PER_PAGE else page + 1)
        return {"page": page, "pagecount": pagecount,
                "limit": self.PER_PAGE,
                "total": last * self.PER_PAGE if last else 99999,
                "list": items, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        url = str(ids[0] or "").strip()
        if not url.startswith("http"):
            return result
        name, pic, remarks = self._meta.get(url, ("", "", ""))
        if not name:
            name = self._name_from_url(url)
        result["list"].append({
            "vod_id": url, "vod_name": name, "vod_pic": pic,
            "type_name": "", "vod_year": "", "vod_area": "",
            "vod_remarks": remarks, "vod_actor": "", "vod_director": "",
            "vod_content": "",
            "vod_play_from": "播放",
            "vod_play_url": "播放$" + url,
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        # 接口契约没有关键词参数，不伪造搜索
        page = self._to_int(pg, 1)
        return {"page": page, "pagecount": 1, "limit": self.PER_PAGE,
                "total": 0, "list": [], "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        # mp4 直链直通；twimg 文件普通请求即可拉取，只带 UA，不带 Referer
        return {"parse": 0, "playUrl": "", "url": id or "", "jx": 0,
                "header": {"User-Agent": self.UA}}

    # ---------------- 接口与条目 ----------------

    def _classes(self):
        return [{"type_id": tid, "type_name": name} for tid, name in self.RANGES]

    def _fetch_range(self, range_value, page):
        """拉一页榜单，返回 (vod 列表, lastPage)。任何异常都吞掉返回空。"""
        params = {"page": page, "per_page": self.PER_PAGE,
                  "range": range_value, "ids": "", "category": "",
                  "isFilteredOnly": "0", "sort": "pv"}
        payload = None
        for attempt in range(2):  # 失败短重试一次（同系站点突发请求会限流）
            try:
                r = requests.get(self.API_URL, params=params,
                                 headers=self.HEADERS, timeout=15, verify=False)
                if r.status_code < 400:
                    payload = r.json()
                    break
            except Exception:
                payload = None
            if attempt == 0:
                time.sleep(1)
        if not isinstance(payload, dict):
            return [], 0
        items = []
        for raw in payload.get("items") or []:
            vod = self._to_vod(raw)
            if vod:
                items.append(vod)
        last = payload.get("lastPage")
        return items, last if isinstance(last, int) and last > 0 else 0

    def _to_vod(self, raw):
        if not isinstance(raw, dict):
            return None
        mp4 = str(raw.get("mp4") or "").strip()
        if not mp4.startswith("http"):
            # 兼容个别条目用其他字段名给直链（客户端同款兜底）
            for key in ("url", "video_url", "src", "source"):
                cand = str(raw.get(key) or "").strip()
                if cand.startswith("http"):
                    mp4 = cand
                    break
        if not mp4.startswith("http"):
            return None
        tid = str(raw.get("id") or "").strip()
        name = str(raw.get("title") or "").strip() or tid or self._name_from_url(mp4)
        pic = str(raw.get("thumbnail") or "").strip()
        if not pic.startswith("http"):
            pic = ""
        pv = raw.get("pv")
        remarks = "▶ %s" % pv if pv is not None and str(pv) != "" else ""
        self._meta[mp4] = (name, pic, remarks)
        return {"vod_id": mp4, "vod_name": name,
                "vod_pic": pic, "vod_remarks": remarks}

    def _name_from_url(self, url):
        """无标题时从直链里取一个稳定标识：优先路径里的推文数字 id，其次文件名。"""
        path = str(url or "").split("?")[0]
        for part in path.strip("/").split("/"):
            if part.isdigit() and len(part) >= 15:
                return "视频 " + part
        stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0] if "/" in path else ""
        if stem:
            return "视频 " + stem
        return "视频 " + hashlib.md5(str(url).encode()).hexdigest()[:16]

    # ---------------- 工具 ----------------

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
