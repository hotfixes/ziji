// 黄果短剧 huangguo.js —— DBH 专用版 v5
// ===========================================================
// 给 DBH 用的 (App Store 工具箱, 良陈, 扩展插件导 js 源).
// DBH 兼容 XPTV 规范的 js 源, 但运行环境没有公开文档, 和真 XPTV
// 并不完全一样. 之前的情况:
//   - 列表/详情/搜索在 DBH 里能刷 (v2/v4 已验证), 播放一直卡在
//     "解析视频直链", 点了没反应也不报错.
//   - 上游 Yswag 9c888831 是给 XPTV (JavaScriptCore) 写的, 播放那步
//     依赖两点, 在 DBH 里都没证实: $fetch.post 返回里有 resp.status
//     和 resp.data, 以及文件末尾用 getPlayinfo = _hgPlayinfo 重赋值;
//     拿不到明文地址就走加密 edge 通道 (ECDH/HKDF/AES-256-GCM),
//     DBH 很可能根本不支持那套加密.
//   - 2026-11-18 实测: 站的播放接口本身是通的 (直接 POST 和 edge
//     信封都能拿到 m3u8), 列表/详情/搜索接口也全是 200, 所以问题
//     在 DBH 运行环境, 不在站那边.
//
// 本版相对上游 9c888831 和 v4 的改动 (只改 DBH 里可疑的那几处,
// 列表/详情/搜索沿用 v4 在 DBH 里已验证的写法):
//   1. getPlayinfo 直接定义, 文件末尾没有任何重赋值.
//   2. 播放主路改走现在的直接接口 POST /api/videos/:id/episodes/:ep/
//      playback (上游 9c888831 用的就是这条, 2026-11-18 实测通),
//      不走 edge 信封; edge 信封只作备用, 再不行走旧 GET 播放接口
//      和剧集页 videoInitialData.
//   3. $fetch.post 的返回做归一化, 兼容多种形态:
//      {status,data} / {statusCode,body} / 直接就是解析好的对象 /
//      直接就是 JSON 字符串 / data 是字符串. 哪种都认, 不只认一种.
//   4. 全程不用加密通道, 不用 crypto/ECDH/HKDF/AES, 不用 setTimeout、
//      clearTimeout、Promise.race (XPTV/DBH 脚本环境里根本没有
//      setTimeout, v3 就是死在这里: 第一次调用就抛 ReferenceError,
//      列表直接归零). 超时只用 $fetch.post 自带的 timeout 选项,
//      且只用在播放上; 如果它立刻抛错 (选项本身被拒, 不是超时),
//      去掉 timeout 再试一次. 列表/详情的 GET 不传 timeout.
//   5. 播放 $fetch.post 传 JSON 字符串 '{}', 不传对象体
//      (XPTV/DBH 的 $fetch.post 不自动把对象转 JSON, 传对象会
//      被当成表单发出去, 服务器直接拒收, v1 就是这么死的).
//
// 结构与原版一致: getConfig / getCards / getTracks / getPlayinfo / search
// 入口函数由宿主调用, 依赖宿主提供的 jsonify / argsify / $fetch.
// ===========================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SITE = 'https://huangguoai.com'
const BASES = ['https://huangguoai.com', 'https://huangguoai.ai']
const PAGE_SIZE = 20
const REQ_TIMEOUT = 10000

const TABS = [
    { name: '首页', id: 'home' },
    { name: 'AI成人短剧', id: 'ai-duanju' },
    { name: 'AI成人漫剧', id: 'ai-manju' },
    { name: 'AI换脸', id: 'ai-huanlian' },
    { name: 'AI魔改', id: 'ai-mogai' },
    { name: '排行榜', id: 'ranks/hot' },
]

// ---------- 小工具 ----------

function b64encode(str) {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const bytes = []
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i)
        if (c < 0x80) bytes.push(c)
        else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)) }
        else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
            const c2 = str.charCodeAt(++i)
            const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
            bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
        } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const b1 = bytes[i], b2 = i + 1 < bytes.length ? bytes[i + 1] : 0, b3 = i + 2 < bytes.length ? bytes[i + 2] : 0
        out += abc[b1 >> 2] + abc[((b1 & 3) << 4) | (b2 >> 4)] + (i + 1 < bytes.length ? abc[((b2 & 15) << 2) | (b3 >> 6)] : '=') + (i + 2 < bytes.length ? abc[b3 & 63] : '=')
    }
    return out
}

function toJson(data) {
    if (data == null) return null
    if (typeof data === 'object') return data
    if (typeof data === 'string') {
        try { return JSON.parse(data) } catch (e) { return null }
    }
    return null
}

function stripTags(s) {
    return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim()
}

function cleanPic(u) {
    u = String(u || '').trim()
    if (!u || u.indexOf('cover-placeholder') !== -1) return ''
    if (u.indexOf('//') === 0) u = 'https:' + u
    else if (u.charAt(0) === '/') u = SITE + u
    const q = u.indexOf('?')
    if (q !== -1) u = u.slice(0, q)
    return u
}

// ---------- 底层请求 ----------
// 注意: 脚本环境里没有 setTimeout / clearTimeout, 本文件任何地方
// 都不用它们, 也不用 Promise.race. 列表/详情的 GET 直接 await
// $fetch.get(url, { headers }), 不传 timeout.

// 把 $fetch 任意一种返回形态归一化成 { status, json, text }.
// 兼容: {status,data} / {statusCode,body} / 直接是对象 /
// 直接是 JSON 字符串 / data 本身是字符串.
function normResp(res) {
    if (res == null) return { status: 0, json: null, text: '' }
    if (typeof res === 'string') return { status: 200, json: toJson(res), text: res }
    const raw = res.data !== undefined ? res.data : (res.body !== undefined ? res.body : res)
    const status = res.status !== undefined ? res.status : (res.statusCode !== undefined ? res.statusCode : (res.code !== undefined ? res.code : 200))
    if (typeof raw === 'string') return { status: status, json: toJson(raw), text: raw }
    if (typeof raw === 'object') return { status: status, json: raw, text: '' }
    return { status: status, json: null, text: '' }
}

async function httpGet(url) {
    const headers = {
        'User-Agent': UA,
        'Accept': 'application/json, text/html, */*',
        'Referer': SITE + '/',
    }
    let res
    if (typeof $fetch !== 'undefined' && $fetch && typeof $fetch.get === 'function') {
        res = await $fetch.get(url, { headers: headers })
    } else if (typeof axios !== 'undefined' && axios && typeof axios.get === 'function') {
        res = await axios.get(url, { headers: headers })
    } else {
        throw new Error('no http client')
    }
    return normResp(res)
}

// POST, 只用于播放. 传 JSON 字符串体, 带原生 timeout 选项;
// 如果立刻抛错 (<1 秒, 说明选项本身被拒, 不是超时), 去掉 timeout 再试一次.
async function httpPostJson(url, bodyStr) {
    const headers = {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': SITE,
        'Referer': SITE + '/',
    }
    if (typeof $fetch !== 'undefined' && $fetch && typeof $fetch.post === 'function') {
        const t0 = Date.now()
        try {
            const res = await $fetch.post(url, bodyStr, { headers: headers, timeout: REQ_TIMEOUT })
            return normResp(res)
        } catch (e) {
            if (Date.now() - t0 < 1000) {
                const res = await $fetch.post(url, bodyStr, { headers: headers })
                return normResp(res)
            }
            throw e
        }
    } else if (typeof axios !== 'undefined' && axios && typeof axios.post === 'function') {
        const res = await axios.post(url, bodyStr, { headers: headers, timeout: REQ_TIMEOUT })
        return normResp(res)
    }
    throw new Error('no http client')
}

async function apiGet(path) {
    for (let i = 0; i < BASES.length; i++) {
        try {
            const r = await httpGet(BASES[i] + path)
            const json = r.json
            if (!json) continue
            if (json.data !== undefined) return json.data
            if (json.items !== undefined || json.episodes !== undefined) return json
        } catch (e) { /* 换下一条线路 */ }
    }
    return null
}

async function fetchHtml(url) {
    try {
        const r = await httpGet(url)
        return r.text || ''
    } catch (e) {
        return ''
    }
}

// ---------- 播放: 直接 POST (主路) ----------

function pickStream(data) {
    if (!data) return ''
    const streams = data.streams || {}
    return streams.main || streams.hevc || data.video_url || data.video_url_hevc || ''
}

// 主路: POST /api/videos/:id/episodes/:ep/playback, body '{}' 字符串.
async function directPlayback(id, ep) {
    for (let i = 0; i < BASES.length; i++) {
        try {
            const r = await httpPostJson(BASES[i] + '/api/videos/' + id + '/episodes/' + encodeURIComponent(ep) + '/playback', '{}')
            if (r.status !== 200 && r.status !== 1) continue
            const data = r.json && r.json.data !== undefined ? r.json.data : r.json
            const url = pickStream(data)
            if (url) return url
        } catch (e) { /* 换下一条线路 / 走备用 */ }
    }
    return ''
}

// 备用: edge 信封 POST /api/edge/request (v4 的路, 2026-11-18 实测仍通).
async function edgePlayback(id, ep) {
    const envelope = {
        method: 'POST',
        path: '/api/videos/' + id + '/episodes/' + ep + '/playback',
        body: b64encode('{}'),
        content_type: 'application/json',
    }
    for (let i = 0; i < BASES.length; i++) {
        try {
            const r = await httpPostJson(BASES[i] + '/api/edge/request', jsonify(envelope))
            const data = r.json && r.json.data !== undefined ? r.json.data : r.json
            const url = pickStream(data)
            if (url) return url
        } catch (e) { /* 换下一条线路 / 走下一道兜底 */ }
    }
    return ''
}

// ---------- HTML 解析兜底 ----------

function stripScripts(html) {
    return html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
}

function extractDiv(html, start) {
    const tagRe = /<\/?div\b[^>]*>/g
    tagRe.lastIndex = start
    let depth = 0
    let m
    while ((m = tagRe.exec(html)) !== null) {
        if (m[0].charAt(1) === '/') { depth--; if (depth === 0) return html.slice(start, m.index + m[0].length) }
        else depth++
    }
    return html.slice(start)
}

function parseCardsFromHtml(html) {
    const out = []
    const seen = {}
    if (!html) return out
    const body = stripScripts(html.slice(html.indexOf('</head>') !== -1 ? html.indexOf('</head>') : 0))
    const reGrid = /<div class="hg-card-grid[^"]*"[^>]*>/g
    const chunks = []
    let g
    while ((g = reGrid.exec(body)) !== null) {
        chunks.push({ active: g[0].indexOf('is-active') !== -1, html: extractDiv(body, g.index) })
    }
    const act = chunks.filter(function (c) { return c.active })
    const scopes = (act.length ? act : chunks).map(function (c) { return c.html })
    const srcList = scopes.length ? scopes : [body]
    for (let s = 0; s < srcList.length; s++) {
        const src = srcList[s]
        const re = /<a class="hg-drama-card__cover-link" href="\/video\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/g
        let m
        while ((m = re.exec(src)) !== null) {
            const id = m[1]
            if (seen[id]) continue
            seen[id] = true
            const inner = m[2] || ''
            const img = /data-src="([^"]+)"/.exec(inner) || /src="([^"]+)"/.exec(inner) || []
            const alt = /alt="([^"]*)"/.exec(inner) || []
            const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 1200)
            const score = /hg-drama-card__score">([^<]+)</.exec(tail)
            const ep = /hg-drama-card__episode"[^>]*>(?:<i[^>]*>([^<]*)<\/i>)?([^<]*)/.exec(tail)
            const name = stripTags(alt[1] || '')
            if (!id || !name) continue
            out.push({ id: id, title: name, cover: cleanPic(img[1] || ''), remarks: (score ? stripTags(score[1]) : '') + (ep ? ' ' + stripTags((ep[2] || '').trim()) : '') })
        }
    }
    if (out.length > 0) return out
    // 排行榜页是另一种卡片结构
    const reRank = /<a href="\/video\/(\d+)\/" class="hg-rank-item__cover">([\s\S]*?)<\/a>/g
    let rm
    while ((rm = reRank.exec(body)) !== null) {
        const id = rm[1]
        if (seen[id]) continue
        seen[id] = true
        const inner = rm[2] || ''
        const img = /data-src="([^"]+)"/.exec(inner) || /src="([^"]+)"/.exec(inner) || []
        const alt = /alt="([^"]*)"/.exec(inner) || []
        const name = stripTags(alt[1] || '')
        if (!id || !name) continue
        out.push({ id: id, title: name, cover: cleanPic(img[1] || '') })
    }
    return out
}

function parseEpisodesFromHtml(html, id) {
    const eps = {}
    if (!html) return []
    const re1 = /<a class="hg-web-play__ep[^"]*"[^>]*data-ep-id="(\d+)"[^>]*>/g
    let m
    while ((m = re1.exec(html)) !== null) eps[m[1]] = true
    const re2 = new RegExp('/video/' + id + '/ep-(\\d+)/', 'g')
    while ((m = re2.exec(html)) !== null) eps[m[1]] = true
    const nums = Object.keys(eps).map(function (n) { return parseInt(n, 10) }).sort(function (a, b) { return a - b })
    return nums
}

async function playFromHtmlPage(pageUrl, ep) {
    try {
        const html = await fetchHtml(pageUrl)
        if (!html) return ''
        const m = html.match(/id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/)
        if (!m) return ''
        let url = ''
        try {
            const j = JSON.parse(m[1])
            const play = (j && j.epPlaySrcs) || {}
            url = play[ep] || j.videoSrc || ''
        } catch (e) { /* 解析失败 */ }
        if (url) url = url.replace(/\\u0026/g, '&')
        if (url && url.indexOf('http') !== 0) {
            const u = url.match(/(https?:\/\/[^\s"']+)/)
            url = u ? u[1] : ''
        }
        return url
    } catch (e) {
        return ''
    }
}

// ---------- 列表项格式统一 ----------

function toCard(item) {
    const id = String(item.id != null ? item.id : item.video_id || '')
    if (!id) return null
    let remarks = item.remarks || ''
    if (!remarks) {
        if (item.episode_count != null) remarks = '共' + item.episode_count + '集'
        if (item.episode) remarks = String(item.episode)
        if (item.is_finished) remarks += ' · 已完结'
        if (item.score != null && item.score !== '') remarks += (remarks ? ' · ' : '') + '评分 ' + item.score
        if (item.metric_value != null) remarks = '热度 ' + item.metric_value
    }
    return {
        vod_id: id,
        vod_name: item.title || item.name || '',
        vod_pic: cleanPic(item.cover || item.pic || item.thumb || ''),
        vod_remarks: remarks,
        ext: { id: id },
    }
}

function toCardList(items) {
    const list = []
    if (!items) return list
    const arr = Array.isArray(items) ? items : (items.items || [])
    for (let i = 0; i < arr.length; i++) {
        const card = toCard(arr[i])
        if (card) list.push(card)
    }
    return list
}

// ---------- XPTV 入口 (直接定义, 文件末尾不做任何重赋值) ----------

async function getConfig() {
    return jsonify({
        ver: 1,
        title: '黄果短剧',
        site: SITE,
        tabs: TABS.map(function (t) { return { name: t.name, ext: { id: t.id } } }),
    })
}

async function getCards(ext) {
    ext = argsify(ext)
    const id = String(ext.id || 'home').replace(/^\//, '')
    const page = Math.max(1, parseInt(ext.page) || 1)
    let list = []
    try {
        if (id === 'home') {
            const data = await apiGet('/api/videos?page=' + page + '&size=' + PAGE_SIZE)
            list = toCardList(data && data.items)
            if (list.length === 0 && page === 1) {
                list = toCardList(parseCardsFromHtml(await fetchHtml(SITE + '/')))
            }
        } else if (id === 'ranks/hot') {
            if (page > 1) return jsonify({ list: [], page: page })
            const data = await apiGet('/api/ranks/hot')
            list = toCardList(data && data.items)
            if (list.length === 0) {
                list = toCardList(parseCardsFromHtml(await fetchHtml(SITE + '/ranks/hot/')))
            }
        } else {
            const data = await apiGet('/api/videos/category/' + encodeURIComponent(id) + '?page=' + page + '&size=' + PAGE_SIZE)
            list = toCardList(data && data.items)
            if (list.length === 0 && page === 1) {
                list = toCardList(parseCardsFromHtml(await fetchHtml(SITE + '/' + id + '/')))
            }
        }
    } catch (e) {
        try {
            if (list.length === 0 && page === 1) {
                const url = id === 'home' ? SITE + '/' : id === 'ranks/hot' ? SITE + '/ranks/hot/' : SITE + '/' + id + '/'
                list = toCardList(parseCardsFromHtml(await fetchHtml(url)))
            }
        } catch (e2) { /* 保持空列表 */ }
    }
    return jsonify({ list: list, page: page })
}

async function getTracks(ext) {
    ext = argsify(ext)
    let id = String(ext.id || '')
    if (!id && ext.url) {
        const m = String(ext.url).match(/\/video\/(\d+)/)
        if (m) id = m[1]
    }
    if (!id) return jsonify({ list: [] })
    let tracks = []
    try {
        const data = await apiGet('/api/videos/' + id)
        const eps = (data && data.episodes) || []
        tracks = eps.map(function (ep) {
            return {
                name: ep.title || ('第' + ep.ep_num + '集'),
                pan: '',
                ext: { id: id, ep: String(ep.ep_num), url: SITE + '/video/' + id + '/ep-' + ep.ep_num + '/' },
            }
        })
        if (tracks.length === 0) {
            const nums = parseEpisodesFromHtml(await fetchHtml(SITE + '/video/' + id + '/'), id)
            tracks = nums.map(function (n) {
                return {
                    name: '第' + n + '集',
                    pan: '',
                    ext: { id: id, ep: String(n), url: SITE + '/video/' + id + (n === 1 ? '/' : '/ep-' + n + '/') },
                }
            })
        }
        if (tracks.length === 0) {
            tracks.push({ name: '第1集', pan: '', ext: { id: id, ep: '1', url: SITE + '/video/' + id + '/' } })
        }
    } catch (e) {
        if (tracks.length === 0) {
            tracks.push({ name: '第1集', pan: '', ext: { id: id, ep: '1', url: SITE + '/video/' + id + '/' } })
        }
    }
    return jsonify({ list: [{ title: '选集', tracks: tracks }] })
}

async function getPlayinfo(ext) {
    ext = argsify(ext)
    let id = String(ext.id || '')
    const ep = String(ext.ep || '1')
    if (!id && ext.url) {
        const m = String(ext.url).match(/\/video\/(\d+)/)
        if (m) id = m[1]
    }
    if (!id) return jsonify({ urls: [] })
    try {
        // 1) 主路: 直接 POST 播放接口
        let url = await directPlayback(id, ep)
        // 2) 备用: edge 信封
        if (!url) url = await edgePlayback(id, ep)
        // 3) 旧接口: 直接 GET /api/videos/:id/play
        if (!url) {
            const legacy = await apiGet('/api/videos/' + id + '/play?ep=' + ep + '&page_texts=0')
            if (legacy) url = legacy.video_url || legacy.video_url_hevc || ''
        }
        // 4) 最后一道: 剧集页 videoInitialData
        if (!url) {
            const pageUrl = ext.url || (SITE + '/video/' + id + (ep === '1' ? '/' : '/ep-' + ep + '/'))
            url = await playFromHtmlPage(pageUrl, ep)
        }
        if (!url) return jsonify({ urls: [] })
        return jsonify({
            urls: [url],
            headers: [{ 'User-Agent': UA, 'Referer': SITE + '/' }],
        })
    } catch (e) {
        return jsonify({ urls: [] })
    }
}

async function search(ext) {
    ext = argsify(ext)
    const text = String(ext.text || ext.wd || '').trim()
    const page = Math.max(1, parseInt(ext.page) || 1)
    if (!text) return jsonify({ list: [], page: 1 })
    let list = []
    try {
        const data = await apiGet('/api/search?q=' + encodeURIComponent(text) + '&page=' + page + '&size=' + PAGE_SIZE)
        list = toCardList(data && data.items)
        if (list.length === 0 && page === 1) {
            list = toCardList(parseCardsFromHtml(await fetchHtml(SITE + '/search/?keyword=' + encodeURIComponent(text))))
        }
    } catch (e) { /* 保持空列表 */ }
    return jsonify({ list: list, page: page })
}
