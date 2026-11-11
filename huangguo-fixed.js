// 黄果短剧 huangguo.js —— XPTV 扩展（修复版 v3）
// ============================================================
// 来源：Yswag/xptv-extensions js/huangguo.js（2026-09-30，commit 16647b6）
// 修复原因：
//   2026-11-09 起，黄果官网把播放接口收进单一入口
//   POST /api/edge/request，旧的页面解析方式拿不到播放地址，
//   所以 XPTV 只能看到封面、播不了。
//
// v3 修正（2026-11-11，针对 v2 在真机 XPTV 上点播一直卡在
//   “正在解析视频直链…”的问题）：
//   真机现象：列表、集数都能刷出来（GET 通路正常），但一点播放就
//   无限转圈，永远不报错。根因已定位：
//   1）服务端本身没问题 —— 2026-11-11 当天实测，edge 播放接口对
//      117（高三爱情故事，第 1/2 集）和 2833 都是 0.4~0.8 秒返回
//      真实 m3u8；内层 GET 方式调播放接口实测 404，没有 GET 替代路；
//      旧 play 接口返回 video_url:""（空），videoInitialData 也空，
//      播放只能走 edge POST，别无他路（与 zxsos/HGhub 的 api_play
//      一致：先 POST 新接口，不行再 GET 旧 play 接口；其 Rust 侧
//      客户端带 20 秒总超时 + 10 秒连接超时，绝不无限等）。
//   2）v2 的 edge() / httpGet() 完全没有超时：$fetch.post 一旦在
//      XPTV 真机里不返回（Xu 的手机走小火箭 edgetunnel 慢节点，
//      且直连 huangguoai.com 本来就不通），await 就永远挂起，
//      第二条线路、旧接口、HTML 兜底一行都执行不到，getPlayinfo
//      永远不返回，XPTV 就只能一直显示“正在解析视频直链…”。
//      另外 XPTV 的 $fetch 本身就支持 timeout 选项（仓库里 cupfox.js
//      的用法：$fetch.get(url, { headers, timeout: 20000 }）），
//      v2 没传，等于用了无限等待。
//   所以 v3 的策略：
//   1）所有 $fetch 调用都传 timeout（XPTV 原生机制）；
//   2）再加一层 Promise.race 硬超时（setTimeout，XPTV 脚本里可用，
//      novipnoad.js 就在用），防止 $fetch 本身忽略 timeout 而挂起；
//   3）getPlayinfo 全程设 15 秒总预算：edge 先试 10 秒，不行再试
//      备用线路（剩余预算内），然后旧接口、HTML 各试剩余时间，
//      到点没拿到地址就立刻返回 { urls: [] }，让 XPTV 报错而不是
//      无限转圈；列表/详情的 GET 也同样加超时，不再无限等。
//
// 结构与原版保持一致：getConfig / getCards / getTracks / getPlayinfo / search
// 封面直接用接口返回的 cover（含 auth_key），不再走图片代理/解密。
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SITE = 'https://huangguoai.com'
const BASES = ['https://huangguoai.com', 'https://huangguoai.ai'] // 主站 + 备用线路
const PAGE_SIZE = 20
// 超时预算（毫秒）：XPTV 真机上任何一次请求都不能无限等。
// 单次 GET/POST 上限 10 秒；getPlayinfo 全程上限 15 秒。
const REQ_TIMEOUT = 10000
const PLAY_TOTAL_TIMEOUT = 15000

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

// 硬超时：Promise.race + setTimeout。$fetch 本身也传 timeout 选项，
// 但万一它在真机里忽略 timeout 或底层挂起，这一层保证调用方
// 一定能在 ms 内拿到结果（超时则抛错，由调用方走下一步兜底）。
// 注意：race 超时后底层的 $fetch 请求可能还在后台跑，但调用方
// 不再等它——XPTV 拿到返回值就能继续，不会卡在转圈上。
function withTimeout(promise, ms) {
    ms = ms > 0 ? ms : REQ_TIMEOUT
    let timer = null
    const timeoutP = new Promise(function (_resolve, reject) {
        timer = setTimeout(function () { reject(new Error('timeout after ' + ms + 'ms')) }, ms)
    })
    return Promise.race([promise, timeoutP]).then(
        function (v) { if (timer) clearTimeout(timer); return v },
        function (e) { if (timer) clearTimeout(timer); throw e }
    )
}

// GET，返回 { json, text }；json 为解析后的对象（失败为 null），text 为原始文本
async function httpGet(url, ms) {
    ms = ms || REQ_TIMEOUT
    const headers = {
        'User-Agent': UA,
        'Accept': 'application/json, text/html, */*',
        'Referer': SITE + '/',
    }
    let reqP
    if (typeof $fetch !== 'undefined' && $fetch && typeof $fetch.get === 'function') {
        // XPTV 原生支持 timeout 选项（cupfox.js 的用法），必须传，
        // 否则真机上默认可能是无限等待。
        reqP = $fetch.get(url, { headers: headers, timeout: ms })
    } else if (typeof axios !== 'undefined' && axios && typeof axios.get === 'function') {
        reqP = axios.get(url, { headers: headers, timeout: ms })
    } else {
        throw new Error('no http client')
    }
    const res = await withTimeout(Promise.resolve(reqP), ms)
    const raw = res && res.data !== undefined ? res.data : res
    if (typeof raw === 'string') return { json: toJson(raw), text: raw }
    return { json: raw, text: typeof raw === 'object' ? JSON.stringify(raw) : '' }
}

// 直接调后端接口（不用 edge 信封）：返回后端 data 字段；失败返回 null
// 兼容两种返回形态：{"status":1,"data":{...}} 和 {"data":{...}}
async function apiGet(path, ms) {
    for (const base of BASES) {
        try {
            const r = await httpGet(base + path, ms)
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
// ms：本次调用的总超时预算（默认 REQ_TIMEOUT），两条线路共享——
// 第一条线路超时/失败后，只在预算还有剩余时才试第二条，绝不让
// 两条线路的等待时间叠加成无限转圈。
// 返回后端 data 字段；失败返回 null。主站失败自动试备用线路。
// 关键：XPTV 的 $fetch.post 必须传 JSON 字符串（jsonify），传对象体
// 会被当成表单发出去，服务器回 415/400 —— v1 在真机上就是这么死的。
async function edge(method, path, bodyObj, ms) {
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
    const budget = ms || REQ_TIMEOUT
    const started = Date.now()
    for (const base of BASES) {
        const left = budget - (Date.now() - started)
        if (left <= 1000) break // 预算快用完就别再开新请求
        try {
            let reqP
            if (typeof $fetch !== 'undefined' && $fetch && typeof $fetch.post === 'function') {
                reqP = $fetch.post(base + '/api/edge/request', jsonify(envelope), { headers: headers, timeout: left })
            } else if (typeof axios !== 'undefined' && axios && typeof axios.post === 'function') {
                reqP = axios.post(base + '/api/edge/request', envelope, { headers: headers, timeout: left })
            } else {
                throw new Error('no http client')
            }
            const res = await withTimeout(Promise.resolve(reqP), left)
            const json = toJson(res && res.data !== undefined ? res.data : res)
            if (!json) continue
            if (json.data !== undefined) return json.data
            if (json.streams !== undefined || json.video_url !== undefined) return json
        } catch (e) {
            // 超时或失败：换下一条线路（预算内）
        }
    }
    return null
}

// ---------- HTML 兜底（原版方式） ----------

async function fetchHtml(url, ms) {
    try {
        const r = await httpGet(url, ms)
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
async function playFromHtmlPage(pageUrl, ep, ms) {
    try {
        const html = await fetchHtml(pageUrl, ms)
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
    // 全程总预算 15 秒：到点无论哪一步没回来，都立刻返回空结果，
    // 让 XPTV 显示错误而不是无限转圈。v2 的教训就是没有任何一步
    // 设限，edge POST 一挂，整个 getPlayinfo 永远不返回。
    const deadline = Date.now() + PLAY_TOTAL_TIMEOUT
    const left = function () { return deadline - Date.now() }
    try {
        // 1）新接口：POST /api/videos/{id}/episodes/{ep}/playback（edge 信封，JSON 字符串体）
        //    占大头预算 10 秒；两条线路共享这 10 秒，不叠加。
        const data = await edge('POST', '/api/videos/' + id + '/episodes/' + ep + '/playback', {}, REQ_TIMEOUT)
        let url = ''
        if (data) {
            const streams = data.streams || {}
            url = streams.main || streams.hevc || data.video_url || data.video_url_hevc || ''
        }
        // 2）旧兜底接口：直接 GET /api/videos/{id}/play?ep={ep}&page_texts=0
        //    （实测目前返回空，但万一哪天恢复，仍可兜底；只花剩余预算）
        if (!url && left() > 2000) {
            const legacy = await apiGet('/api/videos/' + id + '/play?ep=' + ep + '&page_texts=0', Math.min(6000, left()))
            if (legacy) url = legacy.video_url || legacy.video_url_hevc || ''
        }
        // 3）最后一道：解析剧集页 videoInitialData（原版方式；同上，实测已空）
        if (!url && left() > 2000) {
            const pageUrl = ext.url || (SITE + '/video/' + id + (ep === '1' ? '/' : '/ep-' + ep + '/'))
            url = await playFromHtmlPage(pageUrl, ep, Math.min(6000, left()))
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
