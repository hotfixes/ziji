export const meta = {
  id: 'huangguo',
  name: '黄果短剧',
  version: '1.1.0',
  protocol: 1,
  description: '黄果短剧（huangguoai.com）：首页、分类、榜单、搜索、详情、HLS 播放与图文。封面走站点公开的 AES-CBC 图床协议。',
  author: 'community',
  kind: 'source',
  mature: true,
  linkDomains: ['huangguoai.com', 'www.huangguoai.com'],
  defaultHeaders: {
    Referer: 'https://huangguoai.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  },
  timeouts: { read: 15, playback: 20 },
};

const SITE = 'https://huangguoai.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 站点 /static/web/js/plugins/crypto-image-protocol.js 下发的图床协议：
// AES-CBC、无填充，key/iv 为 16 字节 ASCII，接口要的是 Base64（宿主自行解码）。
const IMAGE_KEY_ASCII = 'f5d965df75336270';
const IMAGE_IV_ASCII = '97b60394abc2fbe1';
// 图床换过域名，按前缀识别比硬编码域名稳；已知历史域名一并列出。
const IMAGE_HOSTS = ['pic.qnlycc.cn', 'pic.drleao.cn', 'pic.eanfog.cn', 'pic.zdmhyg.cn', 'pic.tuafjz.cn'];

const SORTS = [
  { id: 'latest', label: '最近更新' },
  { id: 'hot', label: '当前最热' },
  { id: 'original', label: '小蓝原创' },
];

const RANKS = [
  { id: 'rank:hot', label: '热播榜' },
  { id: 'rank:recommend', label: '推荐榜' },
  { id: 'rank:potential', label: '潜力榜' },
];

const FALLBACK_CATEGORIES = [
  { id: '24', label: '短剧', route: 'ai-duanju' },
  { id: '25', label: '漫剧', route: 'ai-manju' },
  { id: '26', label: 'AI换脸', route: 'ai-huanlian' },
  { id: '27', label: 'AI魔改', route: 'ai-mogai' },
];

export default function (hg) {
  let cateCache = null;
  let imageCrypto = null;

  function origin() {
    const cur = hg.endpoint && hg.endpoint.current;
    if (cur && typeof cur.url === 'string' && cur.url) return cur.url.replace(/\/$/, '');
    return SITE;
  }

  function headers() {
    const o = origin();
    return {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Referer: o + '/',
      Origin: o,
    };
  }

  function fail(code, message, extra) {
    throw new hg.PluginError(code, message, extra);
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  function toMs(value) {
    if (value == null || value === '') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
    }
    const ms = Date.parse(String(value).trim().replace(' ', 'T'));
    return Number.isFinite(ms) ? ms : undefined;
  }

  function pageOf(cursor) {
    const n = parseInt(cursor || '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function sizeOf(limit) {
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return 20;
    return Math.min(n, 50);
  }

  function nextOf(pagination, page) {
    if (!pagination || typeof pagination !== 'object') return null;
    const pages = num(pagination.pages);
    if (pages != null && pages > 0) return page < pages ? String(page + 1) : null;
    const total = num(pagination.total);
    const size = num(pagination.size) || 20;
    if (total != null) return page * size < total ? String(page + 1) : null;
    return null;
  }

  // ---- 网络 ----------------------------------------------------------------

  async function api(path, opts) {
    const o = opts || {};
    const req = {
      url: origin() + path,
      method: o.method || 'GET',
      headers: headers(),
      responseType: 'json',
      timeoutMs: o.timeoutMs || 12000,
      retry: o.method === 'POST' ? 0 : 1,
      signal: o.ctx && o.ctx.signal,
    };
    if (o.query) req.query = o.query;
    if (o.body !== undefined) req.body = { json: o.body };

    const res = await hg.http.fetch(req);
    const label = o.label || '站点';
    if (!res.ok) {
      if (res.status === 404) fail('NOT_FOUND', '内容不存在');
      fail('UPSTREAM_ERROR', label + '暂时不可用（HTTP ' + res.status + '）');
    }
    const body = res.data;
    if (!body || typeof body !== 'object' || typeof body.status !== 'number') {
      fail('UPSTREAM_CHANGED', label + '返回结构已变化');
    }
    if (body.status !== 1) {
      const msg = typeof body.msg === 'string' ? body.msg : '';
      if (msg.indexOf('不存在') >= 0) fail('NOT_FOUND', msg || '内容不存在');
      if (msg.indexOf('播放参数') >= 0) fail('INVALID_ARGUMENT', msg);
      fail('UPSTREAM_ERROR', msg || label + '返回失败');
    }
    const data = body.data;
    return data === undefined ? null : data;
  }

  // ---- 图片与封面 ----------------------------------------------------------

  function imageHost(host) {
    const h = String(host || '').toLowerCase();
    if (h.indexOf('pic.') === 0) return true;
    for (let i = 0; i < IMAGE_HOSTS.length; i++) if (IMAGE_HOSTS[i] === h) return true;
    return false;
  }

  function imageCryptoParams() {
    if (!imageCrypto) {
      imageCrypto = {
        key: hg.codec.base64Encode(IMAGE_KEY_ASCII),
        iv: hg.codec.base64Encode(IMAGE_IV_ASCII),
      };
    }
    return imageCrypto;
  }

  function coverRef(url) {
    if (typeof url !== 'string' || !url) return undefined;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch (err) {
      return url;
    }
    if (!imageHost(host)) return url;
    const c = imageCryptoParams();
    return { url, transform: { type: 'aes-cbc', key: c.key, iv: c.iv, padding: 'none' } };
  }

  // ---- 数据映射 ------------------------------------------------------------

  function tagsOf(raw) {
    if (!Array.isArray(raw)) return undefined;
    const out = [];
    for (let i = 0; i < raw.length && out.length < 20; i++) {
      const t = raw[i];
      const name = typeof t === 'string' ? t : t && (t.name || t.title);
      if (!name) continue;
      out.push(String(name).slice(0, 30));
    }
    return out.length ? out : undefined;
  }

  function authorOf(raw) {
    if (!raw || typeof raw !== 'object' || !raw.name) return undefined;
    const id = raw.id != null ? String(raw.id) : String(raw.name);
    const a = { id, name: String(raw.name) };
    const avatar = coverRef(raw.avatar);
    if (avatar) a.avatar = avatar;
    const followers = num(raw.followers);
    if (followers != null) a.followers = followers;
    return a;
  }

  function mediaItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // 列表用 id，榜单条目用 video_id 指代同一部作品。
    const rawId = raw.id != null ? raw.id : raw.video_id;
    const id = rawId != null ? String(rawId) : '';
    const title = String(raw.title || '').trim();
    if (!id || !title) return null;

    const item = { id, title, type: 'short', entryEpisodeId: '1' };

    const cover = coverRef(raw.cover);
    if (cover) item.cover = cover;
    if (raw.description) item.description = String(raw.description);

    const tags = tagsOf(raw.tags);
    if (tags) item.tags = tags;

    const score = num(raw.score);
    if (score != null && score > 0) item.score = score;

    const created = toMs(raw.created_at);
    if (created != null) {
      item.publishedAt = created;
      item.year = new Date(created).getFullYear();
    }

    if (raw.is_finished === true) item.status = 'finished';
    else if (raw.is_finished === false) item.status = 'ongoing';

    const episodeCount = num(raw.episode_count);
    if (episodeCount != null && episodeCount > 0) item.episodeCount = episodeCount;
    const totalEpisodes = num(raw.total_episodes);
    if (totalEpisodes != null && totalEpisodes > 0) item.totalEpisodes = totalEpisodes;

    const duration = num(raw.duration);
    if (duration != null && duration > 0) item.durationSec = duration;

    const stats = {};
    const plays = num(raw.hot);
    if (plays != null) {
      stats.plays = plays;
      stats.hot = plays;
    }
    const likes = num(raw.like_count);
    if (likes != null) stats.likes = likes;
    const favorites = num(raw.collect_count);
    if (favorites != null) stats.favorites = favorites;
    const comments = num(raw.comment_count);
    if (comments != null) stats.comments = comments;

    // 榜单条目把计数放在 metrics 里。
    const metrics = raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : null;
    if (metrics) {
      const mPlay = num(metrics.play);
      if (mPlay != null) {
        stats.plays = mPlay;
        if (stats.hot == null) stats.hot = mPlay;
      }
      const mLike = num(metrics.like);
      if (mLike != null) stats.likes = mLike;
      const mCollect = num(metrics.collect);
      if (mCollect != null) stats.favorites = mCollect;
      const mComment = num(metrics.comment);
      if (mComment != null) stats.comments = mComment;
    }

    if (Object.keys(stats).length) item.stats = stats;

    const author = authorOf(raw.author);
    if (author) item.author = author;

    if (raw.is_original === 1 || raw.is_original === true) item.badge = '原创';
    else if (raw.is_hot === 1 || raw.is_hot === true) item.badge = '热播';
    else if (num(raw.rank) != null && num(raw.rank) > 0) item.badge = '#' + num(raw.rank);

    return item;
  }

  function mapItems(data) {
    let rows = [];
    if (Array.isArray(data)) rows = data;
    else if (data && Array.isArray(data.items)) rows = data.items;
    else if (data && Array.isArray(data.list)) rows = data.list;
    const out = [];
    const seen = {};
    for (let i = 0; i < rows.length && out.length < 100; i++) {
      const item = mediaItem(rows[i]);
      if (!item || seen[item.id]) continue;
      seen[item.id] = true;
      out.push(item);
    }
    return out;
  }

  function pageResult(data, page) {
    return { items: mapItems(data), next: nextOf(data && data.pagination, page) };
  }

  function episodesOf(detail) {
    const rows = detail && Array.isArray(detail.episodes) ? detail.episodes : [];
    const list = [];
    for (let i = 0; i < rows.length; i++) {
      const ep = rows[i];
      if (!ep || typeof ep !== 'object') continue;
      const no = num(ep.ep_num);
      if (no == null || no <= 0) continue;
      const e = { id: String(no), index: 0, episodeNumber: no, label: String(no) };
      if (ep.title) e.title = String(ep.title);
      const dur = num(ep.duration);
      if (dur != null && dur > 0) e.durationSec = dur;
      if (ep.status === 0) {
        e.locked = true;
        e.lockReason = '暂不可播';
      }
      list.push(e);
    }
    list.sort(function (a, b) { return a.episodeNumber - b.episodeNumber; });
    for (let i = 0; i < list.length; i++) list[i].index = i + 1;

    if (list.length) return list;

    const count = num(detail && detail.episode_count) || 1;
    const fallback = [];
    for (let n = 1; n <= count && n <= 5000; n++) {
      fallback.push({ id: String(n), index: n, episodeNumber: n, label: String(n) });
    }
    return fallback;
  }

  // ---- 分类 ----------------------------------------------------------------

  async function categories(ctx) {
    if (cateCache) return cateCache;
    let rows = [];
    try {
      const data = await api('/api/site/categories/video', { ctx: ctx, label: '分类' });
      if (Array.isArray(data)) rows = data;
      else if (data && Array.isArray(data.items)) rows = data.items;
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
    }
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.id == null) continue;
      out.push({
        id: String(row.id),
        label: String(row.name || row.title || row.id),
        route: row.route ? String(row.route) : '',
      });
    }
    cateCache = out.length ? out : FALLBACK_CATEGORIES.slice();
    return cateCache;
  }

  function sortQuery(query, sort) {
    if (sort === 'hot') query.sort = 'hot_window';
    else if (sort === 'original') {
      query.sort = 'hot_window';
      query.is_original = 1;
    }
    return query;
  }

  async function listVideos(query, ctx, label) {
    return api('/api/videos', { query: query, ctx: ctx, label: label || '列表' });
  }

  // ---- 插件对象 ------------------------------------------------------------

  return {
    endpoints: {
      list() {
        return [{ id: 'main', label: '主站', url: SITE }];
      },
    },

    home: {
      async getSections(params, ctx) {
        const cats = await categories(ctx);

        const hotTask = api('/api/ranks/hot', { ctx: ctx, label: '热播榜' }).catch(function () { return null; });
        const latestTask = listVideos({ page: 1, size: 20 }, ctx, '最近更新').catch(function () { return null; });
        const catTasks = [];
        for (let i = 0; i < cats.length; i++) {
          catTasks.push(
            api('/api/videos', {
              query: { cate_id: cats[i].id, page: 1, size: 12 },
              ctx: ctx,
              label: cats[i].label,
            }).catch(function () { return null; })
          );
        }

        const done = await Promise.all([hotTask, latestTask].concat(catTasks));
        const hot = done[0];
        const latest = done[1];

        const sections = [];

        const hotItems = mapItems(hot);
        if (hotItems.length) {
          sections.push({
            id: 'rank:hot',
            title: '热播榜',
            layout: 'banner',
            imageAspect: 'portrait',
            items: hotItems.slice(0, 8).map(function (it) {
              const copy = Object.assign({}, it);
              if (!copy.backdrop && copy.cover) copy.backdrop = copy.cover;
              return copy;
            }),
          });
        }

        const latestItems = mapItems(latest);
        if (latestItems.length) {
          sections.push({
            id: 'latest',
            title: '最近更新',
            layout: 'grid',
            imageAspect: 'portrait',
            items: latestItems,
            more: true,
          });
        }

        for (let i = 0; i < cats.length; i++) {
          const items = mapItems(done[2 + i]);
          if (!items.length) continue;
          sections.push({
            id: 'cate:' + cats[i].id,
            title: cats[i].label,
            layout: 'row',
            imageAspect: 'portrait',
            items: items,
            more: true,
          });
        }

        if (!sections.length) fail('UPSTREAM_ERROR', '首页暂时没有内容');
        return { items: sections, next: null };
      },

      async listSection(params, ctx) {
        const id = String((params && params.sectionId) || '');
        const page = pageOf(params && params.cursor);
        const size = sizeOf(params && params.limit);

        if (id === 'latest') {
          const data = await listVideos({ page: page, size: size }, ctx, '最近更新');
          return pageResult(data, page);
        }
        if (id.indexOf('cate:') === 0) {
          const data = await listVideos({ cate_id: id.slice(5), page: page, size: size }, ctx, '分类');
          return pageResult(data, page);
        }
        if (id.indexOf('rank:') === 0) {
          const data = await api('/api/ranks/' + encodeURIComponent(id.slice(5)), { ctx: ctx, label: '榜单' });
          return { items: mapItems(data), next: null };
        }
        return { items: [], next: null };
      },
    },

    feed: {
      async list(params, ctx) {
        const page = pageOf(params && params.cursor);
        const size = sizeOf(params && params.limit);
        const data = await listVideos({ page: page, size: size }, ctx, '推荐');
        return pageResult(data, page);
      },
    },

    catalog: {
      async getCategories(params, ctx) {
        const cats = await categories(ctx);
        const out = [{ id: 'all', label: '全部', sorts: SORTS }];
        for (let i = 0; i < cats.length; i++) {
          out.push({ id: cats[i].id, label: cats[i].label, sorts: SORTS });
        }
        out.push({ id: 'ranks', label: '排行榜', children: RANKS });
        return out;
      },

      getFilters(params) {
        const id = String((params && params.categoryId) || 'all');
        if (id === 'all' || /^\d+$/.test(id)) return { sorts: SORTS };
        return {};
      },

      async list(params, ctx) {
        const id = String((params && params.categoryId) || 'all');
        const page = pageOf(params && params.cursor);
        const size = sizeOf(params && params.limit);

        if (id === 'ranks' || id.indexOf('rank:') === 0) {
          const type = id === 'ranks' ? 'hot' : id.slice(5);
          const data = await api('/api/ranks/' + encodeURIComponent(type), { ctx: ctx, label: '榜单' });
          return { items: mapItems(data), next: null };
        }

        const query = sortQuery({ page: page, size: size }, params && params.sort);
        if (/^\d+$/.test(id)) query.cate_id = id;

        const data = await listVideos(query, ctx, '分类');
        return pageResult(data, page);
      },
    },

    search: {
      async search(params, ctx) {
        const q = String((params && params.query) || '').trim();
        if (!q) return { items: [], next: null };
        const page = pageOf(params && params.cursor);
        const size = sizeOf(params && params.limit);
        const data = await api('/api/search', { query: { q: q, page: page, size: size }, ctx: ctx, label: '搜索' });
        return pageResult(data, page);
      },

      async trending(params, ctx) {
        try {
          const data = await api('/api/search/hot', { ctx: ctx, label: '热搜' });
          const rows = data && Array.isArray(data.items) ? data.items : [];
          const words = [];
          for (let i = 0; i < rows.length; i++) {
            const word = typeof rows[i] === 'string' ? rows[i] : rows[i] && rows[i].word;
            if (word) words.push(String(word));
          }
          return words;
        } catch (err) {
          if (err && err.code === 'CANCELLED') throw err;
          return [];
        }
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = String((params && params.id) || '').trim();
        if (!id) fail('INVALID_ARGUMENT', '缺少作品 ID');

        const data = await api('/api/videos/' + encodeURIComponent(id), { ctx: ctx, label: '详情' });
        if (!data || typeof data !== 'object') fail('UPSTREAM_CHANGED', '详情结构已变化');

        const item = mediaItem(Object.assign({}, data, { id: data.id != null ? data.id : id }));
        if (!item) fail('UPSTREAM_CHANGED', '详情结构已变化');

        const counts = data.counts;
        if (counts && typeof counts === 'object') {
          item.stats = item.stats || {};
          const hot = num(counts.hot);
          if (hot != null) {
            item.stats.hot = hot;
            item.stats.plays = hot;
          }
          const like = num(counts.like);
          if (like != null) item.stats.likes = like;
          const collect = num(counts.collect);
          if (collect != null) item.stats.favorites = collect;
          const comment = num(counts.comment);
          if (comment != null) item.stats.comments = comment;
        }

        const interaction = data.interaction;
        if (interaction && typeof interaction === 'object') {
          item.interaction = {
            liked: interaction.liked === true,
            favorited: interaction.collected === true,
          };
        }

        const detail = Object.assign({}, item, {
          playlists: [{ id: 'main', label: '正片', kind: 'main', episodes: episodesOf(data) }],
        });

        const people = [];
        const actors = Array.isArray(data.actors) ? data.actors : [];
        for (let i = 0; i < actors.length && people.length < 20; i++) {
          const a = actors[i];
          const name = typeof a === 'string' ? a : a && (a.name || a.actor_name);
          if (name) people.push({ name: String(name), role: '演员' });
        }
        if (people.length) detail.people = people;

        return detail;
      },

      async resolvePlayback(params, ctx) {
        const mediaId = String((params && params.mediaId) || '').trim();
        if (!mediaId) fail('INVALID_ARGUMENT', '缺少作品 ID');

        const epNum = parseInt((params && params.episodeId) || '1', 10);
        if (!Number.isFinite(epNum) || epNum <= 0) fail('INVALID_ARGUMENT', '分集无效');

        // 请求体必须是空 JSON：带上 id/ep 会被上游判为"播放参数无效"。
        const data = await api(
          '/api/videos/' + encodeURIComponent(mediaId) + '/episodes/' + epNum + '/playback',
          { method: 'POST', body: {}, ctx: ctx, label: '播放', timeoutMs: 15000 }
        );

        const raw = data && data.streams;
        if (!raw || typeof raw !== 'object') fail('UPSTREAM_CHANGED', '播放结构已变化');

        const codecs = Array.isArray(params && params.codecs) ? params.codecs : [];
        const order = codecs.indexOf('hevc') >= 0 ? ['hevc', 'main', 'preview'] : ['main', 'hevc', 'preview'];

        const streams = [];
        const seen = {};
        for (let i = 0; i < order.length; i++) {
          const key = order[i];
          const url = raw[key];
          if (typeof url !== 'string' || !url || seen[url]) continue;
          seen[url] = true;
          const stream = {
            url: url,
            kind: 'media',
            format: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'progressive',
            label: key === 'hevc' ? 'HEVC' : key === 'preview' ? '预览' : '正片',
            headers: headers(),
          };
          if (key === 'hevc') stream.codec = 'hevc';
          streams.push(stream);
        }

        if (!streams.length) fail('CONTENT_LOCKED', '没拿到播放地址，可能尚未更新');

        const out = { streams: streams };
        const expiresAt = num(data.timestamp);
        if (expiresAt != null && expiresAt * 1000 > Date.now()) out.expiresAt = expiresAt * 1000;
        return out;
      },

      matchUrl(params) {
        let u;
        try {
          u = new URL(String((params && params.url) || ''));
        } catch (err) {
          return null;
        }
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (host !== 'huangguoai.com') return null;
        const m = u.pathname.match(/\/video\/(\d+)/);
        if (!m) return null;
        const out = { mediaId: m[1] };
        const ep = u.searchParams.get('ep') || u.searchParams.get('episode') || '';
        if (/^\d+$/.test(ep)) out.episodeId = ep;
        return out;
      },
    },

    articles: {
      async list(params, ctx) {
        const page = pageOf(params && params.cursor);
        const size = sizeOf(params && params.limit);
        const data = await api('/api/posts', { query: { page: page, size: size }, ctx: ctx, label: '图文' });
        const rows = data && Array.isArray(data.items) ? data.items : [];
        const items = [];
        for (let i = 0; i < rows.length && items.length < 100; i++) {
          const row = rows[i];
          if (!row || row.id == null) continue;
          const item = { id: String(row.id), title: String(row.title || '图文') };
          const cover = coverRef(row.cover);
          if (cover) item.cover = cover;
          if (row.desc) item.summary = String(row.desc).slice(0, 500);
          const tags = tagsOf(row.tags);
          if (tags) item.tags = tags;
          const published = toMs(row.publish_time || row.created_at);
          if (published != null) item.publishedAt = published;
          const hot = num(row.hot);
          if (hot != null) item.stats = { hot: hot };
          items.push(item);
        }
        return { items: items, next: nextOf(data && data.pagination, page) };
      },

      async getDetail(params, ctx) {
        const id = String((params && params.id) || '').trim();
        if (!id) fail('INVALID_ARGUMENT', '缺少图文 ID');

        const data = await api('/api/posts/' + encodeURIComponent(id), { ctx: ctx, label: '图文详情' });
        if (!data || typeof data !== 'object') fail('NOT_FOUND', '图文不存在');

        const detail = { id: id, title: String(data.title || '图文') };
        const cover = coverRef(data.cover);
        if (cover) detail.cover = cover;

        const body = typeof data.content === 'string' ? data.content : '';
        if (body) {
          if (/<\/?(p|div|br|img|h[1-6]|ul|ol|li|blockquote)\b/i.test(body)) detail.contentHtml = body;
          else detail.contentText = body;
        } else if (data.desc) {
          detail.contentText = String(data.desc);
        }

        const tags = tagsOf(data.tags);
        if (tags) detail.tags = tags;

        const author = authorOf(data.author);
        if (author) detail.author = author;

        const published = toMs(data.publish_time || data.created_at);
        if (published != null) detail.publishedAt = published;

        const counts = data.counts;
        if (counts && typeof counts === 'object') {
          const stats = {};
          const hot = num(counts.hot);
          if (hot != null) stats.hot = hot;
          const like = num(counts.like);
          if (like != null) stats.likes = like;
          if (Object.keys(stats).length) detail.stats = stats;
        }

        return detail;
      },
    },
  };
}