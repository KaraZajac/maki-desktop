//! The plugin as sudo calls it, through `maki_approval`'s functions, against a stand-in for maki
//! desktop that answers as maki's Sudo app would: signing what it's sent with a key, the one in the
//! key file or another.

use std::ffi::{c_char, CStr, CString};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use maki_sudo::{maki_approval, SUDO_APPROVAL_PLUGIN};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// C strings, and the NULL-terminated array of them sudo passes.
struct Strings {
    _owned: Vec<CString>,
    ptrs: Vec<*const c_char>,
}

impl Strings {
    fn new(items: &[&str]) -> Strings {
        let owned: Vec<CString> = items.iter().map(|s| CString::new(*s).unwrap()).collect();
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        Strings {
            _owned: owned,
            ptrs,
        }
    }
    fn ptr(&self) -> *const *const c_char {
        self.ptrs.as_ptr()
    }
}

/// How the stand-in answers.
#[derive(Clone, Copy)]
enum Says {
    Yes,
    YesByAnother,
    No,
    NoApp,
    NotLinked,
}

/// A folder of the test's own with a key file and a socket that answers once as `says`; what it
/// was sent comes back on the channel.
fn stand_in(name: &str, says: Says) -> (PathBuf, mpsc::Receiver<Vec<u8>>) {
    let dir = std::env::temp_dir().join(format!("maki-sudo-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let maki = SigningKey::from_bytes(&[7; 32]);
    std::fs::write(
        dir.join("sudo.pub"),
        format!(
            "# the test's\nmaki-sudo-ed25519 {} test\n",
            B64.encode(maki.verifying_key().as_bytes())
        ),
    )
    .unwrap();
    std::fs::set_permissions(dir.join("sudo.pub"), std::fs::Permissions::from_mode(0o644)).unwrap();
    let listener = UnixListener::bind(dir.join("maki.sock")).unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let Ok((mut s, _)) = listener.accept() else {
            return;
        };
        let mut line = Vec::new();
        let mut b = [0u8; 1];
        while s.read(&mut b).unwrap_or(0) == 1 && b[0] != b'\n' {
            line.push(b[0]);
        }
        let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(
            (v["type"].as_str(), v["app"].as_str()),
            (Some("appMessage"), Some("com.leviathan.maki.sudo"))
        );
        let message = B64.decode(v["data"].as_str().unwrap()).unwrap();
        let signed = [&b"maki sudo approval\0"[..], &message[1..]].concat();
        let answer = |status: &str, answer: &[u8]| {
            format!("{{\"id\":1,\"ok\":true,\"type\":\"appMessage\",\"status\":\"{status}\",\"data\":\"{}\"}}\n", B64.encode(answer))
        };
        let reply = match says {
            Says::Yes => answer(
                "approved",
                &[&[0u8][..], &maki.sign(&signed).to_bytes()].concat(),
            ),
            Says::YesByAnother => answer(
                "approved",
                &[
                    &[0u8][..],
                    &SigningKey::from_bytes(&[8; 32]).sign(&signed).to_bytes(),
                ]
                .concat(),
            ),
            Says::No => answer("approved", &[1]),
            Says::NoApp => answer("no match", &[]),
            Says::NotLinked => "{\"id\":1,\"ok\":false,\"error\":\"maki is not linked\"}\n".into(),
        };
        s.write_all(reply.as_bytes()).unwrap();
        tx.send(message).unwrap();
    });
    (dir, rx)
}

fn uid() -> String {
    // SAFETY: getuid can't fail
    unsafe { libc::getuid() }.to_string()
}

/// sudo runs one command at a time, and the plugin keeps what open found for check: so do these.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// open, then check, as sudo calls them: what each returned, and what check put in errstr.
fn run(
    dir: &Path,
    options: &[&str],
    user: &str,
    command_info: &[&str],
    argv: &[&str],
    envp: &[&str],
) -> (i32, Option<i32>, String) {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(maki_approval.kind, SUDO_APPROVAL_PLUGIN);
    let key = format!("key={}", dir.join("sudo.pub").display());
    let socket = format!("socket={}", dir.join("maki.sock").display());
    let mut all = vec![key.as_str(), socket.as_str()];
    all.extend(options);
    let options = Strings::new(&all);
    let (user, uid) = (format!("user={user}"), format!("uid={}", uid()));
    let user_info = Strings::new(&[
        &user,
        &uid,
        "host=laptop",
        "cwd=/home/kara",
        "tty=/dev/pts/3",
    ]);
    let (none, empty) = (Strings::new(&[]), Strings::new(&[]));
    let mut errstr: *const c_char = std::ptr::null();
    // SAFETY: as sudo calls it, with arrays that outlive the calls
    unsafe {
        let opened = maki_approval.open.unwrap()(
            1 << 16 | 22,
            std::ptr::null(),
            None,
            none.ptr(),
            user_info.ptr(),
            0,
            none.ptr(),
            empty.ptr(),
            options.ptr(),
            &mut errstr,
        );
        if opened != 1 {
            return (opened, None, String::new());
        }
        let (info, argv, envp) = (
            Strings::new(command_info),
            Strings::new(argv),
            Strings::new(envp),
        );
        let checked = maki_approval.check.unwrap()(info.ptr(), argv.ptr(), envp.ptr(), &mut errstr);
        let why = if errstr.is_null() {
            String::new()
        } else {
            CStr::from_ptr(errstr).to_string_lossy().into_owned()
        };
        maki_approval.close.unwrap()();
        (opened, Some(checked), why)
    }
}

const INFO: &[&str] = &[
    "command=/usr/bin/systemctl",
    "runas_user=root",
    "runas_uid=0",
    "runas_gid=0",
];
const ARGV: &[&str] = &["systemctl", "restart", "nginx"];
const ENVP: &[&str] = &[
    "HOME=/root",
    "PATH=/usr/sbin:/usr/bin",
    "TERM=xterm",
    "LD_PRELOAD=/tmp/x.so",
];

#[test]
fn a_command_runs_once_maki_signs_the_request_it_was_sent() {
    let (dir, sent) = stand_in("yes", Says::Yes);
    assert_eq!(
        run(&dir, &[], "kara", INFO, ARGV, ENVP),
        (1, Some(1), String::new())
    );
    let message = sent.recv().unwrap();
    assert_eq!(message[0], b'R');
    // after the nonce: the host, who asked, as whom, the group, where; the command, its arguments,
    // and of its environment what every command doesn't get
    let rest = &message[33..];
    let mut want =
        b"\x06laptop\x04kara\x04root\x00\x0a\x00/home/kara\x00\x00\x0a/dev/pts/3\x00\x00".to_vec();
    want.extend(b"\x12\x00/usr/bin/systemctl\x03\x09\x00systemctl\x07\x00restart\x05\x00nginx");
    want.extend(b"\x01\x14\x00LD_PRELOAD=/tmp/x.so");
    assert_eq!(rest, want);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_no_or_a_yes_that_isnt_makis_doesnt_run_it() {
    for (name, says, why) in [
        ("no", Says::No, "denied on maki"),
        ("another", Says::YesByAnother, "not signed by maki"),
        ("noapp", Says::NoApp, "no Sudo app on maki"),
        ("unlinked", Says::NotLinked, "maki isn't linked"),
    ] {
        let (dir, _) = stand_in(name, says);
        assert_eq!(
            run(&dir, &[], "kara", INFO, ARGV, ENVP),
            (1, Some(0), why.to_string()),
            "{name}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
    // no maki desktop
    let (dir, _) = stand_in("gone", Says::Yes);
    std::fs::remove_file(dir.join("maki.sock")).unwrap();
    assert_eq!(run(&dir, &[], "kara", INFO, ARGV, ENVP).1, Some(0));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_user_it_isnt_for_goes_ahead_and_a_bad_setup_stops_sudo() {
    let (dir, _) = stand_in("users", Says::No);
    // not one of the users: sudo leaves the plugin out
    assert_eq!(
        run(&dir, &["users=alice,bob"], "kara", INFO, ARGV, ENVP).0,
        0
    );
    assert_eq!(
        run(&dir, &["users=alice, kara"], "kara", INFO, ARGV, ENVP).1,
        Some(0)
    );
    // a key file anyone could change, or an option it doesn't know: sudo won't run anything
    let (dir2, _) = stand_in("setup", Says::Yes);
    assert_eq!(run(&dir2, &["colour=blue"], "kara", INFO, ARGV, ENVP).0, -1);
    assert_eq!(run(&dir2, &["timeout=1"], "kara", INFO, ARGV, ENVP).0, -1);
    std::fs::set_permissions(
        dir2.join("sudo.pub"),
        std::fs::Permissions::from_mode(0o666),
    )
    .unwrap();
    assert_eq!(run(&dir2, &[], "kara", INFO, ARGV, ENVP).0, -1);
    std::fs::remove_dir_all(&dir).unwrap();
    std::fs::remove_dir_all(&dir2).unwrap();
}

#[test]
fn what_maki_cant_be_sent_whole_doesnt_run() {
    let (dir, _) = stand_in("long", Says::Yes);
    let long = "x".repeat(5000);
    assert_eq!(
        run(&dir, &[], "kara", INFO, &["echo", &long], ENVP),
        (1, Some(0), "too long for maki".to_string())
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
