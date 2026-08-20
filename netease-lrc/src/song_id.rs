use anyhow::{Result, bail, ensure};

pub fn parse_song_id(input: &str) -> Result<u64> {
    let input = input.trim();
    ensure!(!input.is_empty(), "歌曲链接或 ID 不能为空");

    if input.chars().all(|c| c.is_ascii_digit()) {
        let id: u64 = input.parse().expect("纯数字 ID 解析失败");
        ensure!(id > 0, "歌曲 ID 必须大于零");
        return Ok(id);
    }

    ensure!(
        input.contains("music.163.com"),
        "只接受网易云音乐链接或纯数字歌曲 ID"
    );

    if let Some(id) = query_id(input) {
        return Ok(id);
    }
    if let Some(id) = path_id(input) {
        return Ok(id);
    }
    bail!("无法从链接中解析歌曲 ID：{input}");
}

fn query_id(input: &str) -> Option<u64> {
    let bytes = input.as_bytes();
    let mut i = 0;
    while i + 3 < bytes.len() {
        let at_boundary = i == 0 || matches!(bytes[i - 1], b'?' | b'&');
        if at_boundary && bytes[i] == b'i' && bytes[i + 1] == b'd' && bytes[i + 2] == b'=' {
            return parse_digits(&input[i + 3..]);
        }
        i += 1;
    }
    None
}

fn path_id(input: &str) -> Option<u64> {
    const MARKER: &str = "/song/";
    let start = input.find(MARKER)? + MARKER.len();
    parse_digits(&input[start..])
}

fn parse_digits(s: &str) -> Option<u64> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let id: u64 = digits.parse().ok()?;
    (id > 0).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::parse_song_id;

    #[test]
    fn 解析纯数字_id() {
        assert_eq!(parse_song_id("1869883885").unwrap(), 1869883885);
        assert_eq!(parse_song_id("  1869883885\n").unwrap(), 1869883885);
    }

    #[test]
    fn 解析标准歌曲页链接() {
        let url = "https://music.163.com/song?id=1869883885&uct2=U2FsdGVkX19q1Tz7CRqJXU7HED0+j0DcLtCbg0kdSVU=";
        assert_eq!(parse_song_id(url).unwrap(), 1869883885);
    }

    #[test]
    fn 解析hash路由链接() {
        assert_eq!(
            parse_song_id("https://music.163.com/#/song?id=1869883885").unwrap(),
            1869883885
        );
    }

    #[test]
    fn 解析移动端链接() {
        assert_eq!(
            parse_song_id("https://y.music.163.com/m/song?id=1869883885").unwrap(),
            1869883885
        );
    }

    #[test]
    fn 解析路径形式链接() {
        assert_eq!(
            parse_song_id("https://music.163.com/song/1869883885").unwrap(),
            1869883885
        );
    }

    #[test]
    fn 拒绝空输入() {
        assert!(parse_song_id("").is_err());
        assert!(parse_song_id("   ").is_err());
    }

    #[test]
    fn 拒绝零_id() {
        assert!(parse_song_id("0").is_err());
    }

    #[test]
    fn 拒绝非网易云链接() {
        assert!(parse_song_id("https://example.com/song?id=1869883885").is_err());
    }

    #[test]
    fn 不会把userid当成歌曲_id() {
        assert_eq!(
            parse_song_id("https://music.163.com/song?userid=123&id=1869883885").unwrap(),
            1869883885
        );
    }
}
