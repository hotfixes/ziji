// 黄果短剧 huangguo.js —— XPTV 扩展（修复版 v4）
// ============================================================
// 来源：Yswag/xptv-extensions js/huangguo.js（2026-09-30，commit 16647b6）
// 修复原因：
//   2026-11-09 起，黄果官网把播放接口收进单一入口
//   POST /api/edge/request，旧的页面解析方式拿不到播放地址，
//   所以 XPTV 只能看到封面、播不了。
//
// v4 修正（2026-11-11，针对 v3 在真机 XPTV 上又刷不出封面/列表）：
//   真机现象：v2 列表正常，v3 导入后所有分类又显示“该分类下暂无内容”。
//   根因已复现（Node vm 沙箱，去掉 setTimeout 后跑同一份 v3 文件）：
//   v3 新加的 withTimeout() 用了 setTimeout / clearTimeout，但 XPTV
//   的脚本运行环境里根本没有 setTimeout——第一次调用 httpGet 就抛
//   ReferenceError: setTimeout is not defined，apiGet 两条线路都
//   失败、edge 兜底也失败、HTML 兜底同样走 httpGet 同样抛错，
//   getCards 只能返回 []。Node 里 setTimeout 天生存在，所以 v3 的
//   Node 测试全过、真机全空。v2 没有任何 setTimeout，所以能刷。
//   另外 $fetch.get 传 { headers, timeout } 在真机也可能被拒（
//   复现：$fetch 拒绝未知 timeout 选项时列表同样归零），所以 v4
//   列表/详情/搜索彻底回到 v2 的写法：$fetch.get(url, { headers })
//   不传 timeout、不包任何超时包装。
//   播放仍必须走 edge POST；超时只保留在 edge() 的 $fetch.post 上，
//   用 XPTV 原生 timeout 选项（cupfox.js 的用法），且只影响播放，
//   绝不碰列表。注意：这是 XPTV 里唯一可用的超时机制，没有
//   setTimeout 就做不出 Promise.race 硬超时——如果真机 $fetch
//   忽略 timeout 且 POST 永远不返回，播放仍可能转圈，那时只能
//   换代理节点或走电脑 HGhub，见测试记录。
//
// 结构与原版保持一致：getConfig / getCards / getTracks / getPlayinfo / search
// 封面直接用接口返回的 cover（含 auth_key），不再走图片代理/解密。
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SITE = 'https://huangguoai.com'
const BASES = ['https://huangguoai.com', 'https://huangguoai.ai'] // 主站 + 备用线路
const PAGE_SIZE = 20
// 播放 edge POST 的单次超时（毫秒），只用于 $fetch.post 的原生 timeout
// 选项；列表/详情的 GET 不传 timeout，见文件头 v4 说明。
const REQ_TIMEOUT = 10000

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
// 注意：XPTV 脚本环境里没有 setTimeout / clearTimeout（v3 就是死在
// 这里），所以本文件任何地方都不用它们，也不用 Promise.race 硬超时。
// 列表/详情的 GET 直接 await $fetch.get，和 v2 一模一样。

// GET，返回 { json, text }；json 为解析后的对象（失败为 null），text 为原始文本
async function httpGet(url) {
    const headers = {
        'User-Agent': UA,
        'Accept': 'application/json, text/html, */*',
        'Referer': SITE + '/',
    }
    let res
    if (typeof $fetch !== 'undefined' && $fetch && typeof $fetch.get === 'function') {
        // v2 的写法：只传 { headers }，不传 timeout —— 真机已验证能刷列表。
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
// 超时：只在这里、只在播放的 $fetch.post 上传原生 timeout 选项
// （10 秒）。列表的 GET / edge GET 一律不传 timeout，所以这一步
// 无论如何都不可能再把列表拖垮。如果真机 $fetch 忽略 timeout 且
// POST 永远不返回，播放会像 v2 一样转圈——XPTV 里没有 setTimeout，
// 做不出更强的硬超时，这一点见测试记录，不瞒着。
// 另外：如果 $fetch 立刻拒绝 timeout 选项（<1 秒就抛错，说明不是
// 超时、而是选项本身不被接受），去掉 timeout 再试一次，避免
// 播放被一个本可忽略的选项拖死；正常超时（10 秒才抛）绝不重试。
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
                if (isPost) {
                    const t0 = Date.now()
                    try {
                        res = await $fetch.post(base + '/api/edge/request', jsonify(envelope), { headers: headers, timeout: REQ_TIMEOUT })
                    } catch (e) {
                        // 立刻抛错（<1 秒）= 选项被拒，不是超时：去掉 timeout 再试一次
                        if (Date.now() - t0 < 1000) {
                            res = await $fetch.post(base + '/api/edge/request', jsonify(envelope), { headers: headers })
                        } else throw e
                    }
                } else {
                    // edge GET（列表兜底用）：不传 timeout
                    res = await $fetch.post(base + '/api/edge/request', jsonify(envelope), { headers: headers })
                }
            } else if (typeof axios !== 'undefined' && axios && typeof axios.post === 'function') {
                res = await axios.post(base + '/api/edge/request', envelope, { headers: headers, timeout: REQ_TIMEOUT })
            } else {
                throw new Error('no http client')
            }
            const json = toJson(res && res.data !== undefined ? res.data : res)
            if (!json) continue
            if (json.data !== undefined) return json.data
            if (json.streams !== undefined || json.video_url !== undefined) return json
        } catch (e) {
            // 超时或失败：换下一条线路
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
    // v4：不再设 15 秒总预算——没有 setTimeout 就做不出硬超时，
    // Date.now 预算在 $fetch 挂起时根本执行不到。播放的唯一超时
    // 是 edge() 里 $fetch.post 的原生 timeout 选项（10 秒）。
    try {
        // 1）新接口：POST /api/videos/{id}/episodes/{ep}/playback（edge 信封，JSON 字符串体）
        const data = await edge('POST', '/api/videos/' + id + '/episodes/' + ep + '/playback', {})
        let url = ''
        if (data) {
            const streams = data.streams || {}
            url = streams.main || streams.hevc || data.video_url || data.video_url_hevc || ''
        }
        // 2）旧兜底接口：直接 GET /api/videos/{id}/play?ep={ep}&page_texts=0
        //    （实测目前返回空，但万一哪天恢复，仍可兜底）
        if (!url) {
            const legacy = await apiGet('/api/videos/' + id + '/play?ep=' + ep + '&page_texts=0')
            if (legacy) url = legacy.video_url || legacy.video_url_hevc || ''
        }
        // 3）最后一道：解析剧集页 videoInitialData（原版方式；同上，实测已空）
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
