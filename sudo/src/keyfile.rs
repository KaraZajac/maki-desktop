//! The key file (/etc/maki/sudo.pub): the public keys of the makis whose yes counts, kept by root.
//! sudo trusts an answer only if one of them signed it.
//!
//! ```text
//! # maki uni's Sudo app
//! maki-sudo-ed25519 7Tg0BuoiCjCYPn09UWk3Czpx6m3r03pL9c7Kl0Ln4dI= uni
//! ```
//!
//! A line for each: `maki-sudo-ed25519`, the key (32 bytes, base64), then a comment if you like.
//! The file and its folder must be the plugin's user's (root's, under sudo), and written by no one
//! else: whoever can change the file can say yes for maki.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use base64::Engine;
use ed25519_dalek::VerifyingKey;

pub const KIND: &str = "maki-sudo-ed25519";
pub const DEFAULT: &str = "/etc/maki/sudo.pub";

/// The keys in a key file's text.
pub fn parse(text: &str) -> Result<Vec<VerifyingKey>, String> {
    let mut keys = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut words = line.split_whitespace();
        let (kind, key) = (words.next(), words.next());
        let key = match (kind, key) {
            (Some(KIND), Some(key)) => base64::engine::general_purpose::STANDARD.decode(key).ok(),
            _ => None,
        };
        let key = key
            .and_then(|k| <[u8; 32]>::try_from(k).ok())
            .and_then(|k| VerifyingKey::from_bytes(&k).ok());
        match key {
            Some(key) => keys.push(key),
            None => return Err(format!("line {} isn't `{KIND} KEY`", n + 1)),
        }
    }
    if keys.is_empty() {
        return Err("it has no keys".into());
    }
    Ok(keys)
}

/// Whether the plugin's user (root, under sudo) owns it and no one else can write to it; a
/// symbolic link isn't followed.
fn guarded(path: &Path, what: &str) -> Result<(), String> {
    let m = fs::symlink_metadata(path).map_err(|e| format!("{what} {}: {e}", path.display()))?;
    if m.file_type().is_symlink() {
        return Err(format!("{what} {} is a symbolic link", path.display()));
    }
    // SAFETY: geteuid can't fail
    let me = unsafe { libc::geteuid() };
    if m.uid() != me {
        return Err(format!(
            "{what} {} isn't {}'s",
            path.display(),
            if me == 0 { "root" } else { "this user" }
        ));
    }
    if m.mode() & 0o022 != 0 {
        return Err(format!(
            "{what} {} can be changed by others",
            path.display()
        ));
    }
    Ok(())
}

/// The keys in the file at `path`, once it and its folder are checked.
pub fn read(path: &Path) -> Result<Vec<VerifyingKey>, String> {
    guarded(path, "the key file")?;
    guarded(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
        "the key file's folder",
    )?;
    if !fs::symlink_metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
    {
        return Err(format!("the key file {} isn't a file", path.display()));
    }
    let text =
        fs::read_to_string(path).map_err(|e| format!("the key file {}: {e}", path.display()))?;
    parse(&text).map_err(|e| format!("the key file {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    const KEY: &str = "7Tg0BuoiCjCYPn09UWk3Czpx6m3r03pL9c7Kl0Ln4dI=";

    #[test]
    fn a_key_file_is_keys_and_comments() {
        let keys = parse(&format!("# maki uni\n{KIND} {KEY} uni\n\n  {KIND} {KEY}\n")).unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(keys[0].as_bytes()),
            KEY
        );
        for bad in [
            "",
            "# only a comment\n",
            "ssh-ed25519 AAAA",
            &format!("{KIND} {}", &KEY[..40]),
            KIND,
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn only_a_file_no_one_else_can_change_is_read() {
        let dir = std::env::temp_dir().join(format!("maki-sudo-keys-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let file = dir.join("sudo.pub");
        fs::write(&file, format!("{KIND} {KEY}\n")).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read(&file).unwrap().len(), 1);
        // writable by the group, or anyone
        fs::set_permissions(&file, fs::Permissions::from_mode(0o664)).unwrap();
        assert!(read(&file).unwrap_err().contains("changed by others"));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(read(&file).unwrap_err().contains("folder"));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        // a link to it
        let link = dir.join("link.pub");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read(&link).unwrap_err().contains("symbolic link"));
        assert!(read(&dir.join("missing.pub")).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
