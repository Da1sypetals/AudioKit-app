use anyhow::{Context, Result, bail, ensure};
use reqwest::header::{HeaderMap, HeaderValue, REFERER, USER_AGENT};
use serde::Deserialize;

const LYRIC_URL: &str = "https://music.163.com/api/song/lyric";
const SONG_DETAIL_URL: &str = "https://music.163.com/api/song/detail/";
const USER_AGENT_VALUE: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct SongMeta {
    pub id: u64,
    pub name: String,
    pub artists: String,
    pub album: String,
}

#[derive(Debug, Deserialize)]
struct LyricResponse {
    code: i64,
    nolyric: Option<bool>,
    uncollected: Option<bool>,
    lrc: Option<LyricBody>,
}

#[derive(Debug, Deserialize)]
struct LyricBody {
    lyric: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SongDetailResponse {
    code: i64,
    songs: Option<Vec<SongItem>>,
}

#[derive(Debug, Deserialize)]
struct SongItem {
    name: String,
    artists: Vec<ArtistItem>,
    album: AlbumItem,
}

#[derive(Debug, Deserialize)]
struct ArtistItem {
    name: String,
}

#[derive(Debug, Deserialize)]
struct AlbumItem {
    name: String,
}

pub struct NeteaseClient {
    http: reqwest::Client,
}

impl NeteaseClient {
    pub fn new() -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
        headers.insert(REFERER, HeaderValue::from_static("https://music.163.com/"));
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .context("创建 HTTP 客户端失败")?;
        Ok(Self { http })
    }

    pub async fn fetch_song_meta(&self, id: u64) -> Result<SongMeta> {
        let response = self
            .http
            .get(SONG_DETAIL_URL)
            .query(&[("id", id.to_string()), ("ids", format!("[{id}]"))])
            .send()
            .await
            .with_context(|| format!("请求歌曲详情失败：{id}"))?;
        ensure!(
            response.status().is_success(),
            "歌曲详情 HTTP 状态异常：{}",
            response.status()
        );
        let payload: SongDetailResponse = response
            .json()
            .await
            .with_context(|| format!("解析歌曲详情失败：{id}"))?;
        ensure!(payload.code == 200, "歌曲详情接口返回 code={}", payload.code);
        let songs = payload.songs.unwrap_or_default();
        ensure!(!songs.is_empty(), "歌曲详情为空：{id}");
        let song = &songs[0];
        ensure!(!song.name.is_empty(), "歌曲名称为空：{id}");
        ensure!(!song.artists.is_empty(), "歌手列表为空：{id}");
        let artists = song
            .artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        Ok(SongMeta {
            id,
            name: song.name.clone(),
            artists,
            album: song.album.name.clone(),
        })
    }

    pub async fn fetch_lrc(&self, id: u64) -> Result<String> {
        let response = self
            .http
            .get(LYRIC_URL)
            .query(&[
                ("os", "pc".to_string()),
                ("id", id.to_string()),
                ("lv", "-1".to_string()),
                ("tv", "-1".to_string()),
            ])
            .send()
            .await
            .with_context(|| format!("请求歌词失败：{id}"))?;
        ensure!(
            response.status().is_success(),
            "歌词 HTTP 状态异常：{}",
            response.status()
        );
        let payload: LyricResponse = response
            .json()
            .await
            .with_context(|| format!("解析歌词失败：{id}"))?;
        ensure!(payload.code == 200, "歌词接口返回 code={}", payload.code);
        if payload.nolyric == Some(true) {
            bail!("该歌曲为纯音乐，没有 LRC：{id}");
        }
        if payload.uncollected == Some(true) {
            bail!("该歌曲尚未收录歌词：{id}");
        }
        let lyric = payload
            .lrc
            .and_then(|body| body.lyric)
            .unwrap_or_default();
        let lyric = lyric.trim().to_string();
        ensure!(!lyric.is_empty(), "歌词内容为空：{id}");
        Ok(lyric)
    }
}
