mod netease;
mod song_id;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Parser;
use netease::NeteaseClient;
use song_id::parse_song_id;

#[derive(Parser, Debug)]
#[command(name = "netease-lrc", about = "根据网易云歌曲链接或 ID 下载 LRC")]
struct Args {
    /// 网易云歌曲链接或纯数字歌曲 ID
    song: String,
    /// 输出路径；缺省时按「歌名 - 歌手.lrc」写入当前目录
    #[arg(short, long)]
    output: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let id = parse_song_id(&args.song)?;
    let client = NeteaseClient::new()?;
    let meta = client.fetch_song_meta(id).await?;
    let lrc = client.fetch_lrc(id).await?;
    let output = match args.output {
        Some(path) => path,
        None => PathBuf::from(default_filename(&meta.name, &meta.artists)),
    };
    write_lrc(&output, &lrc).await?;
    println!(
        "已写入 {}（{} - {} / {} / id={}）",
        output.display(),
        meta.name,
        meta.artists,
        meta.album,
        meta.id
    );
    Ok(())
}

fn default_filename(name: &str, artists: &str) -> String {
    format!("{} - {}.lrc", sanitize_filename(name), sanitize_filename(artists))
}

fn sanitize_filename(input: &str) -> String {
    let sanitized: String = input
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let sanitized = sanitized.trim().trim_matches('.');
    if sanitized.is_empty() {
        "untitled".to_string()
    } else {
        sanitized.to_string()
    }
}

async fn write_lrc(path: &Path, lrc: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("创建输出目录失败：{}", parent.display()))?;
        }
    }
    tokio::fs::write(path, format!("{lrc}\n"))
        .await
        .with_context(|| format!("写入 LRC 失败：{}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".scratch")
    }

    #[test]
    fn 文件名会替换非法字符() {
        assert_eq!(sanitize_filename("疏狂客"), "疏狂客");
        assert_eq!(sanitize_filename("a/b:c"), "a_b_c");
        assert_eq!(sanitize_filename("   "), "untitled");
    }

    #[tokio::test]
    async fn 下载示例歌曲_lrc() {
        let id = parse_song_id(
            "https://music.163.com/song?id=1869883885&uct2=U2FsdGVkX19q1Tz7CRqJXU7HED0+j0DcLtCbg0kdSVU=",
        )
        .unwrap();
        assert_eq!(id, 1869883885);

        let client = NeteaseClient::new().unwrap();
        let meta = client.fetch_song_meta(id).await.unwrap();
        assert_eq!(meta.name, "疏狂客");
        assert!(meta.artists.contains("冽冽"));
        assert!(meta.artists.contains("双笙"));

        let lrc = client.fetch_lrc(id).await.unwrap();
        assert!(lrc.contains("[00:00.000]"));
        assert!(lrc.contains("山尽处是烟江"));
        assert!(lrc.contains("三千里明月光"));

        let output = scratch_dir().join("疏狂客.lrc");
        write_lrc(&output, &lrc).await.unwrap();
        let written = tokio::fs::read_to_string(&output).await.unwrap();
        assert!(!written.is_empty());
        assert!(written.contains("山尽处是烟江"));
    }
}
