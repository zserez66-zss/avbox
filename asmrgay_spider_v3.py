# -*- coding: utf-8 -*-
"""asmrgay.com（ASMR 基佬中心）TVBox / CatVodSpider 源。

站点本质是一个 OpenList 网盘前端，没有 HTML 可抓，全部走 JSON API：
  POST /api/fs/list   {path, page, per_page, refresh} -> 目录分页
  POST /api/fs/get    {path}                          -> raw_url 直链
  POST /api/fs/search {parent, keywords, page, per_page, scope} -> 全盘搜索
匿名可用，无需 token。音频文件点开即播（provider=Local，raw_url 支持 Range）。

浏览模型：
  分类 = /asmr 下的 9 个分类目录 + asmr2~asmr6 五个盘根
  列表里文件夹 vod_id 以 'D' 开头、媒体文件以 'F' 开头
  详情：文件 -> 单集；文件夹 -> 本层文件做一辑的集数，
        每个子文件夹再各自成一辑（子文件夹只有子目录时再下探一层）

v2 修复（真机分类点进去全空）：
  v1 的 type_id 直接用中文路径，部分 TVBox 客户端回传 tid 时会做
  URL 编码/改写，路径对不上 -> API 查无此目录 -> 空列表。
  v2 分类 type_id 改为纯 ASCII 令牌（k1..k14），内部映射到真实路径；
  所有入口参数再做防御性 unquote，编码过的 id 也能还原。

v3 加固（真机首页列表也为空 = 接口调用本身失败）：
  _api 改为 45 秒超时 + 最多 3 次重试（间隔递增），
  单次网络抖动/跨境慢速不再直接把整页打成空。
  注：裸域 asmrgay.com 证书异常，不可作备用入口（已实测）。
"""
import math
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
    BASE_URL = "https://www.asmrgay.com"
    HEADERS = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Accept": "application/json, text/plain, */*",
        "Referer": BASE_URL + "/",
    }
    MEDIA_EXTS = (".mp3", ".mp4", ".m4a", ".wav", ".flac", ".ogg",
                  ".opus", ".aac", ".mkv", ".m4v")
    PER_PAGE = 100
    # type_id 用纯 ASCII 令牌，避免客户端回传时把中文路径编码/改写坏
    CLASSES = [
        ("k1", "/asmr/中文音声", "中文音声"),
        ("k2", "/asmr/亚太", "亚太"),
        ("k3", "/asmr/女性向", "女性向"),
        ("k4", "/asmr/未分类", "未分类"),
        ("k5", "/asmr/橙澄子汉化组", "橙澄子汉化组"),
        ("k6", "/asmr/清软喵", "清软喵"),
        ("k7", "/asmr/英语音声", "英语音声"),
        ("k8", "/asmr/音声汉化", "音声汉化"),
        ("k9", "/asmr/风花雪月汉化组", "风花雪月汉化组"),
        ("k10", "/asmr2", "asmr2"),
        ("k11", "/asmr3", "asmr3"),
        ("k12", "/asmr4", "asmr4"),
        ("k13", "/asmr5", "asmr5"),
        ("k14", "/asmr6", "asmr6"),
    ]
    CLASS_MAP = {tok: path for tok, path, _ in CLASSES}

    def __init__(self):
        super().__init__()
        self.name = "asmrgay"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------------- TVBox 接口 ----------------

    def homeContent(self, filter):
        classes = [{"type_id": tok, "type_name": name}
                   for tok, _, name in self.CLASSES]
        data = self._list_page("/asmr/中文音声", 1)
        return {"class": classes, "filters": {},
                "list": data["list"], "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._list_page("/asmr/中文音声", 1)["list"]}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        path = self._resolve_tid(tid)
        data = self._list_page(path, page)
        return {"page": page, "pagecount": data["pagecount"],
                "limit": self.PER_PAGE, "total": data["total"],
                "list": data["list"], "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        raw = self._unquote(str(ids[0] or ""))
        kind, path = raw[:1], raw[1:]
        if kind not in ("D", "F"):
            # 兜底：直接传了裸路径时按扩展名猜
            path = raw
            kind = "F" if self._is_media(path) else "D"
        if not path.startswith("/"):
            path = "/" + path
        if kind == "F":
            name = self._stem(path.rsplit("/", 1)[-1])
            result["list"].append({
                "vod_id": "F" + path, "vod_name": name, "vod_pic": "",
                "type_name": "", "vod_year": "", "vod_area": "",
                "vod_remarks": "", "vod_actor": "", "vod_director": "",
                "vod_content": path,
                "vod_play_from": "播放",
                "vod_play_url": name + "$" + "F" + path,
            })
            return result
        # 文件夹：一辑 = 本层文件；每个子文件夹再各自成一辑
        items = self._list_all(path)
        main_eps = []
        subs = []
        for it in items:
            full = path.rstrip("/") + "/" + it["name"]
            if it.get("is_dir"):
                subs.append((it["name"], full))
            elif self._is_media(it["name"]):
                main_eps.append(self._stem(it["name"]) + "$" + "F" + full)
        folder_name = path.rstrip("/").rsplit("/", 1)[-1] or "根目录"
        if main_eps:
            result["list"].append(self._vod("D" + path, folder_name,
                                            main_eps, path))
        for sub_name, sub_path in subs:
            eps = self._folder_eps(sub_path)
            if eps:
                result["list"].append(self._vod("D" + sub_path, sub_name,
                                                eps, sub_path))
        if not result["list"] and main_eps == [] and not subs:
            result["list"].append(self._vod("D" + path, folder_name, [], path))
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        out = {"page": page, "pagecount": 1, "limit": self.PER_PAGE,
               "total": 0, "list": [], "parse": 0, "jx": 0}
        data = self._api("/api/fs/search", {
            "parent": "/", "keywords": str(key or ""),
            "page": page, "per_page": self.PER_PAGE, "scope": 0})
        if not data:
            return out
        total = data.get("total") or 0
        out["total"] = total
        out["pagecount"] = max(1, int(math.ceil(total / float(self.PER_PAGE))))
        for it in data.get("content") or []:
            parent = (it.get("parent") or "/").rstrip("/")
            full = parent + "/" + it["name"]
            item = self._item(it, full)
            if item:
                out["list"].append(item)
        return out

    def playerContent(self, flag, id, vipFlags):
        result = {"parse": 0, "playUrl": "", "url": "", "jx": 0,
                  "header": {"User-Agent": self.HEADERS["User-Agent"]}}
        raw = self._unquote(str(id or ""))
        path = raw[1:] if raw[:1] in ("D", "F") else raw
        if not path.startswith("/"):
            path = "/" + path
        data = self._api("/api/fs/get", {"path": path})
        url = ((data or {}).get("raw_url") or "").strip()
        if url:
            result["url"] = url
        else:
            result["parse"] = 1
            result["url"] = self.BASE_URL + urllib.parse.quote(path)
        return result

    # ---------------- 入口参数还原 ----------------

    @staticmethod
    def _unquote(text):
        """反复 URL 解码（有些客户端会编码一到两层），最多 3 次到稳定为止"""
        s = str(text or "")
        for _ in range(3):
            u = urllib.parse.unquote(s)
            if u == s:
                break
            s = u
        return s

    def _resolve_tid(self, tid):
        """分类 id -> 真实路径：令牌查表；裸路径/被编码的路径也兜底还原"""
        s = self._unquote(tid).strip()
        if s in self.CLASS_MAP:
            return self.CLASS_MAP[s]
        path = s if s.startswith("/") else "/" + s
        return path

    # ---------------- OpenList API ----------------

    def _api(self, api_path, payload):
        """带重试的 API 调用：跨境链路慢/抖动时单次失败不直接判空"""
        import time
        last_exc = None
        for attempt in range(3):
            try:
                r = self.session.post(self.BASE_URL + api_path, json=payload,
                                      timeout=45, verify=False)
                if r.status_code != 200:
                    last_exc = "HTTP %s" % r.status_code
                else:
                    body = r.json()
                    if body.get("code") != 200:
                        return None  # 业务级失败（如路径不存在），不重试
                    return body.get("data") or {}
            except Exception as e:
                last_exc = e
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
        return None

    def _list_page(self, path, page):
        """分类页：一页 fs/list -> {list,total,pagecount}"""
        data = self._api("/api/fs/list", {
            "path": path, "page": page,
            "per_page": self.PER_PAGE, "refresh": False})
        if data is None:
            return {"list": [], "total": 0, "pagecount": 1}
        total = data.get("total") or 0
        items = []
        for it in data.get("content") or []:
            full = path.rstrip("/") + "/" + it["name"]
            item = self._item(it, full)
            if item:
                items.append(item)
        return {"list": items, "total": total,
                "pagecount": max(1, int(math.ceil(total / float(self.PER_PAGE))))}

    def _list_all(self, path):
        """拉完一个目录的全部条目（详情拼集数用）"""
        all_items, page = [], 1
        while page <= 50:
            data = self._api("/api/fs/list", {
                "path": path, "page": page,
                "per_page": self.PER_PAGE, "refresh": False})
            if not data:
                break
            content = data.get("content") or []
            all_items.extend(content)
            total = data.get("total") or 0
            if len(all_items) >= total or not content:
                break
            page += 1
        return all_items

    # ---------------- 条目拼装 ----------------

    def _item(self, it, full_path):
        name = it.get("name") or ""
        if it.get("is_dir"):
            return {"vod_id": "D" + full_path, "vod_name": name,
                    "vod_pic": self._pic(it), "vod_remarks": "文件夹"}
        if self._is_media(name):
            mb = (it.get("size") or 0) / 1048576.0
            return {"vod_id": "F" + full_path,
                    "vod_name": self._stem(name),
                    "vod_pic": self._pic(it),
                    "vod_remarks": "%.1f MB" % mb}
        return None

    def _folder_eps(self, path):
        """一个文件夹的集数：本层媒体文件；没有就下探一层合并"""
        items = self._list_all(path)
        eps = []
        subdirs = []
        for it in items:
            full = path.rstrip("/") + "/" + it["name"]
            if it.get("is_dir"):
                subdirs.append(full)
            elif self._is_media(it["name"]):
                eps.append(self._stem(it["name"]) + "$" + "F" + full)
        if eps:
            return eps
        for sub in subdirs:
            for it in self._list_all(sub):
                full = sub.rstrip("/") + "/" + it["name"]
                if not it.get("is_dir") and self._is_media(it["name"]):
                    eps.append(self._stem(it["name"]) + "$" + "F" + full)
        return eps

    def _vod(self, vod_id, name, eps, path):
        return {"vod_id": vod_id, "vod_name": name, "vod_pic": "",
                "type_name": "", "vod_year": "", "vod_area": "",
                "vod_remarks": "%d 集" % len(eps) if eps else "",
                "vod_actor": "", "vod_director": "", "vod_content": path,
                "vod_play_from": "播放",
                "vod_play_url": "#".join(eps)}

    def _pic(self, it):
        thumb = (it.get("thumb") or "").strip()
        if thumb:
            return urllib.parse.urljoin(self.BASE_URL, thumb)
        return ""

    def _is_media(self, name):
        return str(name or "").lower().endswith(self.MEDIA_EXTS)

    def _stem(self, filename):
        return re.sub(r"\.[A-Za-z0-9]{2,5}$", "", str(filename or ""))

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
