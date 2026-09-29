//! maki desktop's socket, where it takes messages for maki's apps: a JSON object a line, as its
//! bridge reads them. The plugin runs as root and the socket is the user's, so it talks only to a
//! socket the user owns, answered by a process of the user's (by its peer's credentials): it can't
//! be steered into writing to anyone else's. What comes back it doesn't trust, but for maki's
//! signature, which the plugin checks.

use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;

/// maki's Sudo app (the SDK's example `sudo`).
pub const APP: &str = "com.leviathan.maki.sudo";

/// Where maki desktop puts its socket for `uid`, as it does (`$XDG_RUNTIME_DIR`, else the temporary
/// folder): from the user's environment first, then where it usually is.
pub fn sockets(uid: u32, runtime_dir: Option<&[u8]>, tmpdir: Option<&[u8]>) -> Vec<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let name = format!("maki-{uid}.sock");
    let from = |dir: &[u8]| Path::new(std::ffi::OsStr::from_bytes(dir)).join(&name);
    let mut out = Vec::new();
    for dir in [
        runtime_dir.map(from),
        Some(Path::new(&format!("/run/user/{uid}")).join(&name)),
        tmpdir.map(from),
        Some(Path::new("/tmp").join(&name)),
    ]
    .into_iter()
    .flatten()
    {
        if dir.is_absolute() && !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// What maki desktop said: the link's status for the message, and the app's answer.
#[derive(Debug, PartialEq, Eq)]
pub struct Answered {
    pub status: String,
    pub answer: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    /// no socket of the user's, or no one listening
    NotRunning,
    /// a socket or a process that isn't the user's
    NotTheirs,
    NotLinked,
    TimedOut,
    /// something else maki desktop said, or couldn't be read
    Odd(String),
}

/// The uid of the process at the socket's other end.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred {
        pid: 0,
        uid: u32::MAX,
        gid: u32::MAX,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: cred and len are ours, and len says how big cred is
    let r = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    (r == 0 && len as usize == std::mem::size_of::<libc::ucred>()).then_some(cred.uid)
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn peer_uid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid) = (u32::MAX, u32::MAX);
    // SAFETY: uid and gid are ours
    let r = unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) };
    (r == 0).then_some(uid)
}

/// A socket of `uid`'s, with a process of `uid`'s at the other end.
fn open(path: &Path, uid: u32) -> Result<UnixStream, Failed> {
    let m = std::fs::symlink_metadata(path).map_err(|_| Failed::NotRunning)?;
    if !m.file_type().is_socket() || m.uid() != uid {
        return Err(Failed::NotTheirs);
    }
    let s = UnixStream::connect(path).map_err(|_| Failed::NotRunning)?;
    if peer_uid(&s) != Some(uid) {
        return Err(Failed::NotTheirs);
    }
    Ok(s)
}

/// Asks the app `app` on maki, through the first of `sockets` that's the user's and answers;
/// `asked` once it's on its way.
pub fn ask(
    sockets: &[PathBuf],
    uid: u32,
    app: &str,
    message: &[u8],
    timeout: Duration,
    asked: impl Fn(),
) -> Result<Answered, Failed> {
    let mut failed = Failed::NotRunning;
    for path in sockets {
        let mut s = match open(path, uid) {
            Ok(s) => s,
            // a stranger's socket is worth saying, over one that isn't there
            Err(e) => {
                if e == Failed::NotTheirs {
                    failed = e;
                }
                continue;
            }
        };
        let request = serde_json::json!({
            "id": 1,
            "type": "appMessage",
            "app": app,
            "data": base64::engine::general_purpose::STANDARD.encode(message),
        });
        let _ = s.set_write_timeout(Some(Duration::from_secs(5)));
        let _ = s.set_read_timeout(Some(timeout));
        if s.write_all(format!("{request}\n").as_bytes()).is_err() {
            continue;
        }
        asked();
        return read_answer(&mut s);
    }
    Err(failed)
}

/// maki desktop's answer: a line, of JSON.
fn read_answer(s: &mut UnixStream) -> Result<Answered, Failed> {
    let mut got = Vec::new();
    let mut chunk = [0u8; 4096];
    let line = loop {
        match s.read(&mut chunk) {
            Ok(0) => return Err(Failed::Odd("maki desktop hung up".into())),
            Ok(n) => got.extend_from_slice(&chunk[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(Failed::TimedOut)
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Failed::Odd(e.to_string())),
        }
        if let Some(nl) = got.iter().position(|&b| b == b'\n') {
            break &got[..nl];
        }
        // an answer is 4 KiB, in base64, and a little JSON
        if got.len() > 64 * 1024 {
            return Err(Failed::Odd("maki desktop said too much".into()));
        }
    };
    parse_answer(line)
}

pub fn parse_answer(line: &[u8]) -> Result<Answered, Failed> {
    let odd = || Failed::Odd("maki desktop answered oddly".into());
    let v: serde_json::Value = serde_json::from_slice(line).map_err(|_| odd())?;
    if v["ok"] != serde_json::Value::Bool(true) {
        let error = v["error"].as_str().unwrap_or("maki desktop said no");
        return Err(if error.contains("not linked") {
            Failed::NotLinked
        } else {
            Failed::Odd(error.chars().take(200).collect())
        });
    }
    if v["type"] != "appMessage" {
        return Err(odd());
    }
    let status = v["status"]
        .as_str()
        .ok_or_else(odd)?
        .chars()
        .take(64)
        .collect();
    let answer = base64::engine::general_purpose::STANDARD
        .decode(v["data"].as_str().unwrap_or(""))
        .map_err(|_| odd())?;
    if answer.len() > 4096 {
        return Err(odd());
    }
    Ok(Answered { status, answer })
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixListener;

    use super::*;

    #[test]
    fn it_looks_where_maki_desktop_puts_its_socket() {
        let got = sockets(1000, Some(b"/run/user/1000"), None);
        assert_eq!(
            got,
            [
                PathBuf::from("/run/user/1000/maki-1000.sock"),
                PathBuf::from("/tmp/maki-1000.sock")
            ]
        );
        let got = sockets(1000, Some(b"relative"), Some(b"/var/tmp"));
        assert_eq!(
            got,
            [
                PathBuf::from("/run/user/1000/maki-1000.sock"),
                "/var/tmp/maki-1000.sock".into(),
                "/tmp/maki-1000.sock".into()
            ]
        );
    }

    #[test]
    fn answers_are_read_as_maki_desktop_gives_them() {
        let ok = br#"{"id":1,"ok":true,"type":"appMessage","status":"approved","data":"AAEC"}"#;
        assert_eq!(
            parse_answer(ok),
            Ok(Answered {
                status: "approved".into(),
                answer: vec![0, 1, 2]
            })
        );
        assert_eq!(
            parse_answer(br#"{"id":1,"ok":false,"error":"maki is not linked"}"#),
            Err(Failed::NotLinked)
        );
        assert!(matches!(
            parse_answer(br#"{"id":1,"ok":false,"error":"malformed request"}"#),
            Err(Failed::Odd(_))
        ));
        for bad in [
            &b"not json"[..],
            br#"{"ok":true,"type":"install"}"#,
            br#"{"ok":true,"type":"appMessage","status":"approved","data":"!!"}"#,
        ] {
            assert!(
                matches!(parse_answer(bad), Err(Failed::Odd(_))),
                "{:?}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn it_asks_through_the_users_socket_and_waits_so_long() {
        let dir = std::env::temp_dir().join(format!("maki-sudo-bridge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("maki.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let answering = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut b = [0u8; 1];
            while b[0] != b'\n' {
                s.read_exact(&mut b).unwrap();
                got.push(b[0]);
            }
            let v: serde_json::Value = serde_json::from_slice(&got).unwrap();
            assert_eq!(
                (v["type"].as_str(), v["app"].as_str(), v["data"].as_str()),
                (Some("appMessage"), Some(APP), Some("UA=="))
            );
            s.write_all(b"{\"id\":1,\"ok\":true,\"type\":\"appMessage\",\"status\":\"approved\",\"data\":\"AA==\"}\n").unwrap();
            // the next one waits, and waits
            let (s, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(400));
            drop(s);
        });
        // SAFETY: getuid can't fail
        let me = unsafe { libc::getuid() };
        let paths = [dir.join("missing.sock"), path.clone()];
        let asked = std::cell::Cell::new(0);
        let count = || asked.set(asked.get() + 1);
        assert_eq!(
            ask(&paths, me, APP, b"P", Duration::from_secs(5), count),
            Ok(Answered {
                status: "approved".into(),
                answer: vec![0]
            })
        );
        assert_eq!(
            ask(&paths, me, APP, b"P", Duration::from_millis(100), count),
            Err(Failed::TimedOut)
        );
        answering.join().unwrap();
        // another user's socket isn't talked to
        assert_eq!(
            ask(
                std::slice::from_ref(&path),
                me + 1,
                APP,
                b"P",
                Duration::from_secs(1),
                count
            ),
            Err(Failed::NotTheirs)
        );
        assert_eq!(
            ask(
                &[dir.join("missing.sock")],
                me,
                APP,
                b"P",
                Duration::from_secs(1),
                count
            ),
            Err(Failed::NotRunning)
        );
        assert_eq!(asked.get(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
