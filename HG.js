// 黄果短剧 huangguo.js —— XPTV 扩展（修复版 v2）
// ============================================================
// 来源：Yswag/xptv-extensions js/huangguo.js（2026-09-30，commit 16647b6）
// 修复原因：
//   2026-11-09 起，黄果官网把播放接口收进单一入口
//   POST /api/edge/request，旧的页面解析方式拿不到播放地址，
//   所以 XPTV 只能看到封面、播不了。
//
// v2 修正（2026-11-11，针对 v1 在真机 XPTV 上列表全空的问题）：
//   v1 的教训 —— v1 在 Node 里用 axios 式桩测试全过（列表 20 条、
//   播放也通），但在真机 XPTV 里所有分类都是“该分类下暂无内容”。
//   根因已在 Node 里复现：v1 的列表/详情/搜索全部走
//   $fetch.post(url, <对象>, ...) 发 edge 信封；
//   XPTV 的 $fetch.post 不像 axios 那样把对象体自动转成 JSON，
//   对象体会被当成表单/纯文本发出去，服务器只认 JSON 字符串体，
//   直接回 415/400，edge() 拿不到 data，只能返回 []。
//   （仓库里其他能用的源都是 $fetch.post(url, jsonify(body), ...)
//   即传 JSON 字符串，这也是 XPTV 的既定用法。已用“表单式”桩复现：
//   v1 在该桩下 getCards=0 条、getPlayinfo=0 条，与真机现象一致。）
//   所以 v2 的策略：
//   1）列表/详情/搜索一律改走 $fetch.get 直接调后端接口
//      （GET /api/videos、/api/videos/category/{slug}、/api/ranks/hot、
//      /api/videos/{id}、/api/search），实测这些接口不用 edge 信封
//      也能直接返回数据，且 $fetch.get 是原版一直在 XPTV 里用的方式；
//   2）只有播放（video_url 为空的那个接口）必须走 edge 信封，
//      此时 $fetch.post 传 JSON 字符串（jsonify），不再传对象；
//   3）每一步都有兜底：接口空了就换 edge，再空就解析 HTML 页面
//      （首页/分类页的 hg-drama-card 卡片、剧集页的 ep-N 链接，
//      原版就是这么拿列表的），绝不静默返回 []。
//
// 结构与原版保持一致：getConfig / getCards / getTracks / getPlayinfo / search
// 封面直接用接口返回的 cover（含 auth_key），不再走图片代理/解密。
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SITE = 'https://huangguoai.com'
const BASES = ['https://huangguoai.com', 'https://huangguoai.ai'] // 主站 + 备用线路
const PAGE_SIZE = 20

// 原版分类（保持不变）
const TABS = [
    { name: '首页', id: 'home' },
    { name: 'AI成人短剧', id: 'ai-duanju' },
    { name: 'AI成人漫剧', id: 'ai-manju' },
    { name: 'AI换脸', id: 'ai-huanlian' },
    { name: 'AI魔改', id: 'ai-mogai' },
    { name: '排行榜', id: 'ranks/hot' },
]

// ---------- 小工具 ----------

// 纯 JS base64（不依赖 btoa / Buffer，XPTV 里也能用）
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

// $fetch / axios 返回的 data 可能是字符串也可能是已解析对象，统一转成对象
function toJson(data) {
    if (data == null) return null
    if (typeof data === 'object') return data
    if (typeof data === 'string') {
        try { return JSON.parse(data) } catch (e) { return null }
    }
    return null
}

// ---------- 底层请求 ----------

// GET，返回 { json, text }；json 为解析后的对象（失败为 null），text 为原始文本
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
    const raw = res && res.data !== undefined ? res.data : res
    if (typeof raw === 'string') return { json: toJson(raw), text: raw }
    return { json: raw, text: typeof raw === 'object' ? JSON.stringify(raw) : '' }
}

// 直接调后端接口（不用 edge 信封）：返回后端 data 字段；失败返回 null
// 兼容两种返回形态：{"status":1,"data":{...}} 和 {"data":{...}}
async function apiGet(path) {
    for (const base of BASES) {
        try {
            const r = await httpGet(base + path)
            const json = r.json
            if (!json) continue
            if (json.data !== undefined) return json.data
            if (json.items !== undefined || json.episodes !== undefined) return json
        } catch (e) { /* 换下一条线路 */ }
    }
    return null
}

// ---------- 核心：走 /api/edge/request（只用于播放） ----------
// method: 'GET' | 'POST'；path 为后端真实路径；bodyObj 为 POST 时的 body
// 返回后端 data 字段；失败返回 null。主站失败自动试备用线路。
// 关键：XPTV 的 $fetch.post 必须传 JSON 字符串（jsonify），传对象体
// 会被当成表单发出去，服务器回 415/400 —— v1 在真机上就是这么死的。
async function edge(method, path, bodyObj) {
    const isPost = method === 'POST'
    const envelope = {
        method: method,
        path: path,
        body: isPost ? b64encode(JSON.stringify(bodyObj || {})) : '',
        content_type: isPost ? 'application/json' : '',
    }
    const headers = {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Referer': SITE + '/',
        'Content-Type': 'application/json',
    }
    for (const base of BASES) {
        try {
            let res
            if (typeof $fetch !== 'undefined' && $fetch && typeof $fetch.post === 'function') {
                res = await $fetch.post(base + '/api/edge/request', jsonify(envelope), { headers: headers })
            } else if (typeof axios !== 'undefined' && axios && typeof axios.post === 'function') {
                res = await axios.post(base + '/api/edge/request', envelope, { headers: headers })
            } else {
                throw new Error('no http client')
            }
            const json = toJson(res && res.data !== undefined ? res.data : res)
            if (!json) continue
            if (json.data !== undefined) return json.data
            if (json.streams !== undefined || json.video_url !== undefined) return json
        } catch (e) {
            // 换下一条线路
        }
    }
    return null
}

// ---------- HTML 兜底（原版方式） ----------

async function fetchHtml(url) {
    try {
        const r = await httpGet(url)
        return r.text || ''
    } catch (e) {
        return ''
    }
}

// 从首页/分类页 HTML 里解析卡片：
// 优先解析页面内嵌 JSON（"title":"...","cover":"...","href":"/video/123/"），
// 其次解析 hg-drama-card__cover-link 锚点（data-src 封面、alt 标题）。
function parseCardsFromHtml(html) {
    const out = []
    const seen = {}
    if (!html) return out
    // 1）内嵌 JSON
    const reJson = /"title":"((?:[^"\\]|\\.)*)","label":"[^"]*","desc":"(?:[^"\\]|\\.)*?","cover":"(https?:[^"]+)","thumb":"[^"]*","score":"([^"]*)","episode":"([^"]*)","href":"\/video\/(\d+)\/"/g
    let m
    while ((m = reJson.exec(html)) !== null) {
        const id = m[5]
        if (seen[id]) continue
        seen[id] = true
        out.push({ id: id, title: m[1].replace(/\\"/g, '"'), cover: m[2], score: m[3], episode_count: null, remarks: (m[4] || '') + (m[3] ? ' · ' + m[3] + '分' : '') })
    }
    if (out.length > 0) return out
    // 2）卡片锚点
    const reCard = /<a[^>]*class="[^"]*(?:hg-drama-card__cover-link|hg-category-item)[^"]*"[^>]*href="\/video\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/g
    while ((m = reCard.exec(html)) !== null) {
        const id = m[1]
        if (seen[id]) continue
        seen[id] = true
        const inner = m[2] || ''
        const src = inner.match(/data-src="(https?:[^"]+)"/) || inner.match(/src="(https?:[^"]+)"/)
        const alt = inner.match(/alt="([^"]*)"/)
        const cover = src ? src[1] : ''
        if (cover.indexOf('cover-placeholder') !== -1) continue
        out.push({ id: id, title: alt ? alt[1] : '', cover: cover })
    }
    return out
}

// 从剧集页 HTML 解析集数链接 /video/{id}/ep-N/
function parseEpisodesFromHtml(html, id) {
    const eps = {}
    if (!html) return []
    const re = new RegExp('/video/' + id + '/ep-(\\d+)/', 'g')
    let m
    while ((m = re.exec(html)) !== null) eps[m[1]] = true
    const nums = Object.keys(eps).map(function (n) { return parseInt(n, 10) }).sort(function (a, b) { return a - b })
    if (nums.length === 0) return []
    return nums
}

// ---------- 列表项格式统一 ----------

function toCard(item) {
    const id = String(item.id != null ? item.id : item.video_id || '')
    if (!id) return null
    let remarks = item.remarks || ''
    if (!remarks) {
        if (item.episode_count != null) remarks = '共' + item.episode_count + '集'
        if (item.is_finished) remarks += ' · 已完结'
        if (item.score != null && item.score !== '') remarks += (remarks ? ' · ' : '') + '评分 ' + item.score
        if (item.metric_value != null) remarks = '热度 ' + item.metric_value
    }
    return {
        vod_id: id,
        vod_name: item.title || '',
        vod_pic: item.cover || '',
        vod_remarks: remarks,
        ext: { id: id },
    }
}

function toCardList(items) {
    const list = []
    if (!items) return list
    const arr = Array.isArray(items) ? items : (items.items || [])
    for (const it of arr) {
        const card = toCard(it)
        if (card) list.push(card)
    }
    return list
}

// ---------- XPTV 入口 ----------

async function getConfig() {
    return jsonify({
        ver: 1,
        title: '黄果短剧',
        site: SITE,
        tabs: TABS.map((t) => ({ name: t.name, ext: { id: t.id } })),
    })
}

async function getCards(ext) {
    ext = argsify(ext)
    const id = String(ext.id || 'home').replace(/^\//, '')
    const page = Math.max(1, parseInt(ext.page) || 1)
    let list = []
    try {
        if (id === 'home') {
            // 1）直接 GET 接口
            const data = await apiGet('/api/videos?page=' + page + '&size=' + PAGE_SIZE)
            list = toCardList(data && data.items)
            // 2）edge 信封
            if (list.length === 0) {
                const ed = await edge('GET', '/api/videos?page=' + page + '&size=' + PAGE_SIZE)
                list = toCardList(ed && ed.items)
            }
            // 3）HTML 首页兜底（原版方式，第 1 页）
            if (list.length === 0 && page === 1) {
                list = toCardList(parseCardsFromHtml(await fetchHtml(SITE + '/')))
            }
        } else if (id === 'ranks/hot') {
            if (page > 1) return jsonify({ list: [], page: page })
            const data = await apiGet('/api/ranks/hot')
            list = toCardList(data && data.items)
            if (list.length === 0) {
                const ed = await edge('GET', '/api/ranks/hot')
                list = toCardList(ed && ed.items)
            }
            if (list.length === 0) {
                list = toCardList(parseCardsFromHtml(await fetchHtml(SITE + '/ranks/hot/')))
            }
        } else {
            // ai-duanju / ai-manju / ai-huanlian / ai-mogai
            const data = await apiGet('/api/videos/category/' + encodeURIComponent(id) + '?page=' + page + '&size=' + PAGE_SIZE)
            list = toCardList(data && data.items)
            if (list.length === 0) {
                const ed = await edge('GET', '/api/videos/category/' + encodeURIComponent(id) + '?page=' + page + '&size=' + PAGE_SIZE)
                list = toCardList(ed && ed.items)
            }
            if (list.length === 0 && page === 1) {
                list = toCardList(parseCardsFromHtml(await fetchHtml(SITE + '/' + id + '/')))
            }
        }
    } catch (e) {
        // 出错也不静默空着：最后一搏走 HTML
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
        // 1）直接 GET 详情接口
        const data = await apiGet('/api/videos/' + id)
        const eps = (data && data.episodes) || []
        tracks = eps.map((ep) => ({
            name: ep.title || ('第' + ep.ep_num + '集'),
            pan: '',
            ext: {
                id: id,
                ep: String(ep.ep_num),
                url: SITE + '/video/' + id + '/ep-' + ep.ep_num + '/',
            },
        }))
        // 2）edge 详情
        if (tracks.length === 0) {
            const ed = await edge('GET', '/api/videos/' + id)
            const eps2 = (ed && ed.episodes) || []
            tracks = eps2.map((ep) => ({
                name: ep.title || ('第' + ep.ep_num + '集'),
                pan: '',
                ext: { id: id, ep: String(ep.ep_num), url: SITE + '/video/' + id + '/ep-' + ep.ep_num + '/' },
            }))
        }
        // 3）HTML 剧集页兜底（原版方式）
        if (tracks.length === 0) {
            const nums = parseEpisodesFromHtml(await fetchHtml(SITE + '/video/' + id + '/'), id)
            tracks = nums.map((n) => ({
                name: '第' + n + '集',
                pan: '',
                ext: { id: id, ep: String(n), url: SITE + '/video/' + id + (n === 1 ? '/' : '/ep-' + n + '/') },
            }))
        }
        if (tracks.length === 0) {
            tracks.push({
                name: '第1集',
                pan: '',
                ext: { id: id, ep: '1', url: SITE + '/video/' + id + '/' },
            })
        }
    } catch (e) {
        if (tracks.length === 0) {
            tracks.push({
                name: '第1集',
                pan: '',
                ext: { id: id, ep: '1', url: SITE + '/video/' + id + '/' },
            })
        }
    }
    return jsonify({ list: [{ title: '选集', tracks: tracks }] })
}

// 从旧的剧集页解析 videoInitialData（最后一道兜底，原版逻辑）
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
        // 1）新接口：POST /api/videos/{id}/episodes/{ep}/playback（edge 信封，JSON 字符串体）
        const data = await edge('POST', '/api/videos/' + id + '/episodes/' + ep + '/playback', {})
        let url = ''
        if (data) {
            const streams = data.streams || {}
            url = streams.main || streams.hevc || data.video_url || data.video_url_hevc || ''
        }
        // 2）旧兜底接口：直接 GET /api/videos/{id}/play?ep={ep}&page_texts=0
        if (!url) {
            const legacy = await apiGet('/api/videos/' + id + '/play?ep=' + ep + '&page_texts=0')
            if (legacy) url = legacy.video_url || legacy.video_url_hevc || ''
        }
        // 3）最后一道：解析剧集页 videoInitialData（原版方式）
        if (!url) {
            const pageUrl = ext.url || (SITE + '/video/' + id + (ep === '1' ? '/' : '/ep-' + ep + '/'))
            url = await playFromHtmlPage(pageUrl, ep)
        }
        if (!url) return jsonify({ urls: [] })
        // m3u8 带 #EXT-X-KEY 加密分片，播放器按相对路径取 key，
        // 必须带 Referer，否则 CDN 可能拒绝。
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
        if (list.length === 0) {
            const ed = await edge('GET', '/api/search?q=' + encodeURIComponent(text) + '&page=' + page + '&size=' + PAGE_SIZE)
            list = toCardList(ed && ed.items)
        }
    } catch (e) { /* 保持空列表 */ }
    return jsonify({ list: list, page: page })
}
