// 黄果短剧 huangguo.js —— XPTV 扩展（修复版）
// ============================================================
// 来源：Yswag/xptv-extensions js/huangguo.js（2026-09-30，commit 16647b6）
// 修复原因：
//   2026-11-09 起，黄果官网把所有 /api/** 接口收进单一入口
//   POST /api/edge/request，旧的页面解析方式失效：
//   剧集页里 id="videoInitialData" 的 epPlaySrcs / videoSrc 已为空，
//   所以 XPTV 只能看到封面、播不了。
//   新接口（对照 zxsos/HGhub v1.2.19 的 src/api.ts / src-tauri/src/net.rs
//   与 Minireel/HGhub Issue #32 实测验证）：
//     POST https://huangguoai.com/api/edge/request
//     请求体 {"method":"POST","path":"/api/videos/{id}/episodes/{ep}/playback",
//              "body":"<base64('{}')>","content_type":"application/json"}
//     返回 {"status":1,"data":{"streams":{"main":"https://...m3u8?auth_key=..."}}}
//   游客播放不需要登录 / 不需要 Authorization。
//   2026-11-11 实测：2833 第 1、2 集均返回真实 m3u8，
//   GET 该 m3u8 返回 HTTP 200、#EXTM3U，可正常播放。
//   旧的 GET /api/videos/{id}/play?ep={ep} 兜底接口仍保留，
//   但实测已返回空 video_url，仅作第二道保险。
//
// 结构与原版保持一致：getConfig / getCards / getTracks / getPlayinfo / search
// 列表、详情也改走同一 edge 接口，不再解析 HTML（更快、更稳）。
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
    // 先转 UTF-8 字节
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

// ---------- 核心：走 /api/edge/request ----------
// method: 'GET' | 'POST'
// path:   '/api/videos?page=1&size=20' 这类后端真实路径
// bodyObj: POST 时传 {}；GET 时传 null（body 为空串）
// 返回后端 data 字段；失败返回 null。主站失败自动试备用线路。
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
                res = await $fetch.post(base + '/api/edge/request', envelope, { headers: headers })
            } else if (typeof axios !== 'undefined' && axios && typeof axios.post === 'function') {
                res = await axios.post(base + '/api/edge/request', envelope, { headers: headers })
            } else {
                throw new Error('no http client')
            }
            const json = toJson(res && res.data !== undefined ? res.data : res)
            if (json && json.status === 1 && json.data !== undefined) return json.data
            // status 不为 1 也可能是后端直接返回的 data，兜底看一眼
            if (json && json.data !== undefined && json.status !== undefined) return null
        } catch (e) {
            // 换下一条线路
        }
    }
    return null
}

// ---------- 列表项格式统一 ----------

function toCard(item) {
    const id = String(item.id != null ? item.id : item.video_id || '')
    if (!id) return null
    let remarks = ''
    if (item.episode_count != null) remarks = '共' + item.episode_count + '集'
    if (item.is_finished) remarks += ' · 已完结'
    if (item.score != null && item.score !== '') remarks += (remarks ? ' · ' : '') + '评分 ' + item.score
    if (item.metric_value != null) remarks = '热度 ' + item.metric_value
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
    for (const it of items) {
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
    try {
        if (id === 'home') {
            const data = await edge('GET', '/api/videos?page=' + page + '&size=' + PAGE_SIZE)
            return jsonify({ list: toCardList(data && data.items), page: page })
        }
        if (id === 'ranks/hot') {
            // 排行榜接口不分页，只在第 1 页返回
            if (page > 1) return jsonify({ list: [], page: page })
            const data = await edge('GET', '/api/ranks/hot')
            return jsonify({ list: toCardList(data && data.items), page: page })
        }
        // ai-duanju / ai-manju / ai-huanlian / ai-mogai
        const data = await edge('GET', '/api/videos/category/' + encodeURIComponent(id) + '?page=' + page + '&size=' + PAGE_SIZE)
        return jsonify({ list: toCardList(data && data.items), page: page })
    } catch (e) {
        return jsonify({ list: [], page: page })
    }
}

async function getTracks(ext) {
    ext = argsify(ext)
    let id = String(ext.id || '')
    if (!id && ext.url) {
        const m = String(ext.url).match(/\/video\/(\d+)/)
        if (m) id = m[1]
    }
    if (!id) return jsonify({ list: [] })
    try {
        const data = await edge('GET', '/api/videos/' + id)
        const eps = (data && data.episodes) || []
        const tracks = eps.map((ep) => ({
            name: ep.title || ('第' + ep.ep_num + '集'),
            pan: '',
            ext: {
                id: id,
                ep: String(ep.ep_num),
                url: SITE + '/video/' + id + '/ep-' + ep.ep_num + '/',
            },
        }))
        // 详情接口没有 episodes 时（极少数），至少给第 1 集
        if (tracks.length === 0) {
            tracks.push({
                name: '第1集',
                pan: '',
                ext: { id: id, ep: '1', url: SITE + '/video/' + id + '/' },
            })
        }
        return jsonify({ list: [{ title: '选集', tracks: tracks }] })
    } catch (e) {
        return jsonify({ list: [] })
    }
}

// 从旧的剧集页解析 videoInitialData（最后一道兜底，原版逻辑）
async function playFromHtmlPage(pageUrl, ep) {
    try {
        let res
        if (typeof $fetch !== 'undefined' && $fetch && typeof $fetch.get === 'function') {
            res = await $fetch.get(pageUrl, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } })
        } else if (typeof axios !== 'undefined' && axios && typeof axios.get === 'function') {
            res = await axios.get(pageUrl, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } })
        } else return ''
        const html = res && res.data !== undefined ? res.data : res
        if (typeof html !== 'string') return ''
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
        // 1）新接口：POST /api/videos/{id}/episodes/{ep}/playback
        const data = await edge('POST', '/api/videos/' + id + '/episodes/' + ep + '/playback', {})
        let url = ''
        if (data) {
            const streams = data.streams || {}
            url = streams.main || streams.hevc || data.video_url || data.video_url_hevc || ''
        }
        // 2）旧兜底接口：GET /api/videos/{id}/play?ep={ep}&page_texts=0
        if (!url) {
            const legacy = await edge('GET', '/api/videos/' + id + '/play?ep=' + ep + '&page_texts=0')
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
    try {
        const data = await edge('GET', '/api/search?q=' + encodeURIComponent(text) + '&page=' + page + '&size=' + PAGE_SIZE)
        return jsonify({ list: toCardList(data && data.items), page: page })
    } catch (e) {
        return jsonify({ list: [], page: page })
    }
}
