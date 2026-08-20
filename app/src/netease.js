// 网易云音乐歌词抓取，移植自 netease-lrc (Rust)
const LYRIC_URL = 'https://music.163.com/api/song/lyric';
const SONG_DETAIL_URL = 'https://music.163.com/api/song/detail/';
const USER_AGENT_VALUE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseDigits(s) {
  const match = s.match(/^\d+/);
  if (!match) return null;
  const id = Number(match[0]);
  return id > 0 ? id : null;
}

function parseSongId(input) {
  const text = String(input).trim();
  if (!text) throw new Error('歌曲链接或 ID 不能为空');
  if (/^\d+$/.test(text)) {
    const id = Number(text);
    if (id <= 0) throw new Error('歌曲 ID 必须大于零');
    return id;
  }
  if (!text.includes('music.163.com')) {
    throw new Error('只接受网易云音乐链接或纯数字歌曲 ID');
  }
  // query 中的 id= 参数（边界必须是 ? 或 &，避免误匹配 userid）
  for (let i = 0; i + 3 < text.length; i += 1) {
    const atBoundary = i === 0 || text[i - 1] === '?' || text[i - 1] === '&';
    if (atBoundary && text.startsWith('id=', i)) {
      const id = parseDigits(text.slice(i + 3));
      if (id) return id;
    }
  }
  const marker = '/song/';
  const at = text.indexOf(marker);
  if (at >= 0) {
    const id = parseDigits(text.slice(at + marker.length));
    if (id) return id;
  }
  throw new Error(`无法从链接中解析歌曲 ID：${text}`);
}

async function fetchJson(url, params, what) {
  const query = new URLSearchParams(params);
  const response = await fetch(`${url}?${query.toString()}`, {
    headers: { 'User-Agent': USER_AGENT_VALUE, Referer: 'https://music.163.com/' },
  });
  if (!response.ok) throw new Error(`${what} HTTP 状态异常：${response.status}`);
  return response.json();
}

async function fetchSongMeta(id) {
  const payload = await fetchJson(
    SONG_DETAIL_URL,
    { id: String(id), ids: `[${id}]` },
    '歌曲详情'
  );
  if (payload.code !== 200) throw new Error(`歌曲详情接口返回 code=${payload.code}`);
  const song = payload.songs?.[0];
  if (!song) throw new Error(`歌曲详情为空：${id}`);
  if (!song.name) throw new Error(`歌曲名称为空：${id}`);
  if (!song.artists?.length) throw new Error(`歌手列表为空：${id}`);
  return {
    id,
    name: song.name,
    artists: song.artists.map((artist) => artist.name).join(' / '),
    album: song.album?.name || '',
  };
}

async function fetchLrc(id) {
  const payload = await fetchJson(
    LYRIC_URL,
    { os: 'pc', id: String(id), lv: '-1', tv: '-1' },
    '歌词'
  );
  if (payload.code !== 200) throw new Error(`歌词接口返回 code=${payload.code}`);
  if (payload.nolyric === true) throw new Error(`该歌曲为纯音乐，没有 LRC：${id}`);
  if (payload.uncollected === true) throw new Error(`该歌曲尚未收录歌词：${id}`);
  const lyric = (payload.lrc?.lyric || '').trim();
  if (!lyric) throw new Error(`歌词内容为空：${id}`);
  return lyric;
}

async function fetchSong(input) {
  const id = parseSongId(input);
  const [meta, lrc] = await Promise.all([fetchSongMeta(id), fetchLrc(id)]);
  return { ...meta, lrc };
}

module.exports = { parseSongId, fetchSong };
