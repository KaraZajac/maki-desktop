//! maki's sudo approval plugin (sudo_plugin(5)): once sudoers says yes to a command, it asks maki's
//! Sudo app about it, through maki desktop's socket and the link, and the command runs only if
//! maki's owner says yes on maki, where it's shown whole. The answer is maki's Ed25519 signature of
//! the request, which holds a fresh nonce, and the plugin checks it against the keys in a file root
//! owns: nothing on the computer can say yes for maki, not with the user's password nor sudo's
//! remembered one, nor by standing in for maki desktop. If maki can't be asked, the command
//! doesn't run.
//!
//! In /etc/sudo.conf (sudo 1.9 or later):
//!
//! ```text
//! Plugin maki_approval /usr/local/libexec/maki/maki_sudo.so [key=FILE] [users=NAME,...] [timeout=SECONDS] [socket=PATH]
//! ```
//!
//! - `key`: the key file (`keyfile::DEFAULT`, /etc/maki/sudo.pub): whose yes counts.
//! - `users`: only these users' commands wait for maki; others' go ahead on sudoers' say alone.
//!   Everyone's, if not given.
//! - `timeout`: how long to wait for maki's answer, in seconds (90).
//! - `socket`: maki desktop's socket, if not where it puts it for the user.

pub mod bridge;
pub mod keyfile;
pub mod request;

use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use bridge::{Answered, Failed};
use request::{Command, SIGNED};

pub const SUDO_APPROVAL_PLUGIN: c_uint = 4;
/// Approval plugins came with sudo 1.9.0's plugin API, 1.15; sudo checks the major version alone.
pub const SUDO_API_VERSION: c_uint = (1 << 16) | 15;
pub const SUDO_CONV_ERROR_MSG: c_int = 0x0003;
pub const SUDO_CONV_INFO_MSG: c_int = 0x0004;
pub const SUDO_CONV_PREFER_TTY: c_int = 0x2000;

/// sudo's printf, for telling the user things.
pub type Printf = unsafe extern "C" fn(msg_type: c_int, fmt: *const c_char, ...) -> c_int;
type Strings = *const *const c_char;

/// `struct approval_plugin`, as sudo_plugin.h has it.
#[repr(C)]
pub struct ApprovalPlugin {
    pub kind: c_uint,
    pub version: c_uint,
    #[allow(clippy::type_complexity)]
    pub open: Option<
        unsafe extern "C" fn(
            version: c_uint,
            conversation: *const c_void,
            printf: Option<Printf>,
            settings: Strings,
            user_info: Strings,
            submit_optind: c_int,
            submit_argv: Strings,
            submit_envp: Strings,
            plugin_options: Strings,
            errstr: *mut *const c_char,
        ) -> c_int,
    >,
    pub close: Option<unsafe extern "C" fn()>,
    pub check: Option<
        unsafe extern "C" fn(
            command_info: Strings,
            run_argv: Strings,
            run_envp: Strings,
            errstr: *mut *const c_char,
        ) -> c_int,
    >,
    pub show_version: Option<unsafe extern "C" fn(verbose: c_int) -> c_int>,
}

/// What sudo.conf names: `Plugin maki_approval …/maki_sudo.so`.
#[no_mangle]
pub static maki_approval: ApprovalPlugin = ApprovalPlugin {
    kind: SUDO_APPROVAL_PLUGIN,
    version: SUDO_API_VERSION,
    open: Some(open),
    close: Some(close),
    check: Some(check),
    show_version: Some(show_version),
};

/// What open found out, for check.
struct State {
    printf: Option<Printf>,
    user: Vec<u8>,
    uid: u32,
    host: Vec<u8>,
    cwd: Vec<u8>,
    tty: Vec<u8>,
    keys: Vec<VerifyingKey>,
    timeout: Duration,
    sockets: Vec<PathBuf>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// A NULL-terminated array of C strings.
unsafe fn strings(p: Strings) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    if p.is_null() {
        return out;
    }
    let mut i = 0;
    loop {
        let s = *p.add(i);
        if s.is_null() {
            return out;
        }
        out.push(CStr::from_ptr(s).to_bytes().to_vec());
        i += 1;
    }
}

/// `name=value`'s value.
fn value<'a>(list: &'a [Vec<u8>], name: &str) -> Option<&'a [u8]> {
    list.iter().find_map(|kv| {
        kv.strip_prefix(name.as_bytes())
            .and_then(|rest| rest.strip_prefix(b"="))
    })
}

fn number(b: &[u8]) -> Option<u32> {
    std::str::from_utf8(b).ok()?.parse().ok()
}

/// Says `line` to the user, through sudo: on the terminal, as sudo asks for a password, else on
/// stderr, never in the command's output.
fn say(printf: Option<Printf>, line: &str) {
    tell(printf, SUDO_CONV_ERROR_MSG | SUDO_CONV_PREFER_TTY, line)
}

fn tell(printf: Option<Printf>, kind: c_int, line: &str) {
    let (Some(printf), Ok(line)) = (printf, CString::new(line)) else {
        return;
    };
    // SAFETY: sudo's printf, with a format that takes one string, and it
    unsafe {
        printf(kind, c"%s\n".as_ptr(), line.as_ptr());
    }
}

/// The plugin's options and the user's details: None if this user's commands needn't wait.
fn opened(
    options: &[Vec<u8>],
    user_info: &[Vec<u8>],
    envp: &[Vec<u8>],
    printf: Option<Printf>,
) -> Result<Option<State>, String> {
    let (mut key, mut users, mut timeout, mut socket) = (
        PathBuf::from(keyfile::DEFAULT),
        None,
        Duration::from_secs(90),
        None,
    );
    for option in options {
        let text = String::from_utf8_lossy(option);
        let (name, v) = text.split_once('=').unwrap_or((&text, ""));
        match name {
            "key" => key = PathBuf::from(v),
            "users" => {
                let named: Vec<Vec<u8>> = v
                    .split(',')
                    .map(|u| u.trim().as_bytes().to_vec())
                    .filter(|u| !u.is_empty())
                    .collect();
                // naming no one would leave everyone to sudoers alone: not a way to turn it off
                if named.is_empty() {
                    return Err("users= names no one".into());
                }
                users = Some(named)
            }
            "timeout" => {
                let s = v
                    .parse::<u64>()
                    .ok()
                    .filter(|s| (5..=600).contains(s))
                    .ok_or("timeout is seconds, 5 to 600")?;
                timeout = Duration::from_secs(s);
            }
            "socket" => socket = Some(PathBuf::from(v)),
            _ => return Err(format!("no option {name}: key, users, timeout or socket")),
        }
    }
    let user = value(user_info, "user")
        .ok_or("sudo didn't say who's asking")?
        .to_vec();
    let uid = value(user_info, "uid")
        .and_then(number)
        .ok_or("sudo didn't say who's asking")?;
    if users.is_some_and(|u| !u.contains(&user)) {
        return Ok(None);
    }
    let keys = keyfile::read(&key)?;
    let sockets = match socket {
        Some(s) => vec![s],
        None => bridge::sockets(uid, value(envp, "XDG_RUNTIME_DIR"), value(envp, "TMPDIR")),
    };
    Ok(Some(State {
        printf,
        user,
        uid,
        host: value(user_info, "host").unwrap_or(b"").to_vec(),
        cwd: value(user_info, "cwd").unwrap_or(b"").to_vec(),
        tty: value(user_info, "tty").unwrap_or(b"").to_vec(),
        keys,
        timeout,
        sockets,
    }))
}

unsafe extern "C" fn open(
    _version: c_uint,
    _conversation: *const c_void,
    printf: Option<Printf>,
    _settings: Strings,
    user_info: Strings,
    _submit_optind: c_int,
    _submit_argv: Strings,
    submit_envp: Strings,
    plugin_options: Strings,
    errstr: *mut *const c_char,
) -> c_int {
    let (options, user_info, envp) = (
        strings(plugin_options),
        strings(user_info),
        strings(submit_envp),
    );
    let result = std::panic::catch_unwind(|| opened(&options, &user_info, &envp, printf))
        .unwrap_or_else(|_| Err("it failed".into()));
    match result {
        Ok(Some(state)) => {
            *STATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(state);
            1
        }
        // not this user's: sudo leaves the plugin out
        Ok(None) => 0,
        Err(why) => {
            say(printf, &format!("maki: sudo can't ask maki: {why}"));
            if !errstr.is_null() {
                *errstr = c"maki's plugin couldn't start".as_ptr();
            }
            -1
        }
    }
}

unsafe extern "C" fn close() {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

unsafe extern "C" fn show_version(_verbose: c_int) -> c_int {
    let printf = STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|s| s.printf);
    // with sudo's own versions, on stdout
    tell(
        printf,
        SUDO_CONV_INFO_MSG,
        concat!(
            "maki's sudo approval plugin version ",
            env!("CARGO_PKG_VERSION")
        ),
    );
    1
}

/// Why a command didn't run, for the log (sudo keeps it), and what the user is told.
struct Denied {
    logged: &'static CStr,
    said: String,
}

fn denied(logged: &'static CStr, said: impl Into<String>) -> Denied {
    Denied {
        logged,
        said: said.into(),
    }
}

/// The name of the user with `uid`, or `#uid`.
fn user_name(uid: u32) -> Vec<u8> {
    let mut buf = vec![0u8; 16 * 1024];
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: the buffers are ours and as big as we say
    let r = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pw,
            buf.as_mut_ptr() as *mut c_char,
            buf.len(),
            &mut found,
        )
    };
    if r == 0 && !found.is_null() && !pw.pw_name.is_null() {
        // SAFETY: getpwuid_r filled it in, NUL-terminated
        return unsafe { CStr::from_ptr(pw.pw_name) }.to_bytes().to_vec();
    }
    format!("#{uid}").into_bytes()
}

/// Asks maki about a command, and checks its answer: Ok if it runs.
fn approve(
    state: &State,
    command_info: &[Vec<u8>],
    argv: &[Vec<u8>],
    envp: &[Vec<u8>],
    nonce: [u8; 32],
) -> Result<(), Denied> {
    let command = value(command_info, "command")
        .ok_or_else(|| denied(c"no command", "maki: sudo didn't say what it would run"))?;
    let runas_user = match value(command_info, "runas_user") {
        Some(u) if !u.is_empty() => u.to_vec(),
        _ => user_name(
            value(command_info, "runas_euid")
                .or(value(command_info, "runas_uid"))
                .and_then(number)
                .unwrap_or(0),
        ),
    };
    let sudoedit = value(command_info, "sudoedit") == Some(b"true");
    let envp: Vec<&[u8]> = envp.iter().map(|v| &v[..]).collect();
    let c = Command {
        host: &state.host,
        user: &state.user,
        runas_user: &runas_user,
        runas_group: value(command_info, "runas_group").unwrap_or(b""),
        cwd: value(command_info, "cwd").unwrap_or(&state.cwd),
        chroot: value(command_info, "chroot").unwrap_or(b""),
        tty: &state.tty,
        sudoedit,
        edit_files: if sudoedit {
            value(command_info, "sudoedit_nfiles")
                .and_then(number)
                .unwrap_or(0) as usize
        } else {
            0
        },
        command,
        argv: argv.iter().map(|a| &a[..]).collect(),
        env: request::notable(&envp),
    };
    let body = request::body(&nonce, &c).map_err(|_| {
        denied(
            c"too long for maki",
            "maki: that command is too long for maki to show whole, so it isn't run",
        )
    })?;
    let mut message = vec![b'R'];
    message.extend_from_slice(&body);
    let asked = || {
        say(
            state.printf,
            "maki: look at maki's screen, and say yes there to run it",
        )
    };
    let Answered { status, answer } = bridge::ask(
        &state.sockets,
        state.uid,
        bridge::APP,
        &message,
        state.timeout,
        asked,
    )
    .map_err(|e| match e {
        Failed::NotRunning => denied(
            c"maki desktop isn't running",
            "maki: maki desktop isn't running, so maki can't be asked",
        ),
        Failed::NotTheirs => denied(
            c"not maki desktop",
            "maki: what answered isn't maki desktop, so it isn't run",
        ),
        Failed::NotLinked => denied(
            c"maki isn't linked",
            "maki: maki isn't linked: plug it in, with maki desktop running",
        ),
        Failed::TimedOut => denied(c"no answer from maki", "maki: no answer from maki in time"),
        Failed::Odd(why) => denied(c"maki desktop said no", format!("maki: {why}")),
    })?;
    match (status.as_str(), answer.first()) {
        ("approved", Some(0)) => {}
        ("approved", Some(1)) => {
            return Err(denied(c"denied on maki", "maki: you said no on maki"))
        }
        ("approved", Some(2)) => {
            return Err(denied(c"no answer on maki", "maki: no answer on maki"))
        }
        ("approved", Some(3)) | ("locked", _) => {
            return Err(denied(
                c"maki is locked",
                "maki: maki is locked: enter its PIN, then try again",
            ))
        }
        ("approved", Some(4)) => {
            return Err(denied(
                c"maki couldn't show it",
                "maki: maki couldn't show that command whole, so it isn't run",
            ))
        }
        ("no match", _) => {
            return Err(denied(
                c"no Sudo app on maki",
                "maki: maki hasn't the Sudo app: add it from the maki store, in maki desktop",
            ))
        }
        ("unavailable", _) => {
            return Err(denied(
                c"maki is busy",
                "maki: maki is busy (another app is open on it): close it, then try again",
            ))
        }
        ("timed out", _) => {
            return Err(denied(
                c"no answer from maki",
                "maki: no answer from maki in time",
            ))
        }
        (status, _) => return Err(denied(c"maki said no", format!("maki: {status}"))),
    }
    let signed = [SIGNED, &body].concat();
    let signature = answer
        .get(1..65)
        .and_then(|s| Signature::from_slice(s).ok());
    match signature {
        Some(sig)
            if answer.len() == 65 && state.keys.iter().any(|k| k.verify(&signed, &sig).is_ok()) =>
        {
            Ok(())
        }
        _ => Err(denied(
            c"not signed by maki",
            "maki: that yes isn't signed by the maki sudo trusts, so it isn't run",
        )),
    }
}

unsafe extern "C" fn check(
    command_info: Strings,
    run_argv: Strings,
    run_envp: Strings,
    errstr: *mut *const c_char,
) -> c_int {
    let (command_info, argv, envp) = (strings(command_info), strings(run_argv), strings(run_envp));
    let guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(state) = guard.as_ref() else {
        return -1;
    };
    let mut nonce = [0u8; 32];
    if getrandom::getrandom(&mut nonce).is_err() {
        say(
            state.printf,
            "maki: no randomness for a nonce, so it isn't run",
        );
        return -1;
    }
    let result = std::panic::catch_unwind(|| approve(state, &command_info, &argv, &envp, nonce))
        .unwrap_or_else(|_| {
            Err(denied(
                c"maki's plugin failed",
                "maki: something went wrong asking maki, so it isn't run",
            ))
        });
    match result {
        Ok(()) => 1,
        Err(Denied { logged, said }) => {
            say(state.printf, &said);
            if !errstr.is_null() {
                *errstr = logged.as_ptr();
            }
            0
        }
    }
}
