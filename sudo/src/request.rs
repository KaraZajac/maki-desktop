//! The request maki's Sudo app is sent: what it shows its owner, and signs on a yes (its layout is
//! the app's `Request`'s, in the SDK's examples/sudo).

/// What a signature is of: this, then the request.
pub const SIGNED: &[u8] = b"maki sudo approval\0";
/// The most a message to an app can be: the `R`, then the request.
pub const MOST: usize = 4096;

/// A command sudo would run, as sudoers passed it on.
#[derive(Debug, Default)]
pub struct Command<'a> {
    pub host: &'a [u8],
    pub user: &'a [u8],
    pub runas_user: &'a [u8],
    /// if not the user's own group
    pub runas_group: &'a [u8],
    pub cwd: &'a [u8],
    pub chroot: &'a [u8],
    pub tty: &'a [u8],
    pub sudoedit: bool,
    /// for sudoedit, how many of the arguments, at the end, are its files
    pub edit_files: usize,
    pub command: &'a [u8],
    /// argv[0] first
    pub argv: Vec<&'a [u8]>,
    /// what it's given beyond what every command gets
    pub env: Vec<&'a [u8]>,
}

/// It doesn't fit: too long for a message to maki, or for one of its fields.
#[derive(Debug, PartialEq, Eq)]
pub struct TooLong;

fn str8(out: &mut Vec<u8>, b: &[u8]) -> Result<(), TooLong> {
    out.push(u8::try_from(b.len()).map_err(|_| TooLong)?);
    out.extend_from_slice(b);
    Ok(())
}

fn str16(out: &mut Vec<u8>, b: &[u8]) -> Result<(), TooLong> {
    out.extend_from_slice(&u16::try_from(b.len()).map_err(|_| TooLong)?.to_le_bytes());
    out.extend_from_slice(b);
    Ok(())
}

fn list(out: &mut Vec<u8>, items: &[&[u8]]) -> Result<(), TooLong> {
    out.push(u8::try_from(items.len()).map_err(|_| TooLong)?);
    for item in items {
        str16(out, item)?;
    }
    Ok(())
}

/// The request (what follows the `R`).
pub fn body(nonce: &[u8; 32], c: &Command) -> Result<Vec<u8>, TooLong> {
    let mut out = nonce.to_vec();
    str8(&mut out, c.host)?;
    str8(&mut out, c.user)?;
    str8(&mut out, c.runas_user)?;
    str8(&mut out, c.runas_group)?;
    str16(&mut out, c.cwd)?;
    str16(&mut out, c.chroot)?;
    str8(&mut out, c.tty)?;
    out.push(c.sudoedit as u8);
    out.push(u8::try_from(c.edit_files).map_err(|_| TooLong)?);
    str16(&mut out, c.command)?;
    list(&mut out, &c.argv)?;
    list(&mut out, &c.env)?;
    if 1 + out.len() > MOST {
        return Err(TooLong);
    }
    Ok(out)
}

/// What every command sudo runs is given, so maki needn't show them: what sudo's env_reset sets,
/// and what distributions' sudoers keep for everyone (Fedora's env_keep, Debian's), none of which
/// changes what a program does as root beyond how it talks.
const EVERY: &[&str] = &[
    "COLORS",
    "COLORTERM",
    "DISPLAY",
    "HISTSIZE",
    "HOME",
    "HOSTNAME",
    "KDEDIR",
    "LANG",
    "LANGUAGE",
    "LINGUAS",
    "LOGNAME",
    "LS_COLORS",
    "MAIL",
    "QTDIR",
    "SHELL",
    "SUDO_COMMAND",
    "SUDO_GID",
    "SUDO_HOME",
    "SUDO_PS1",
    "SUDO_UID",
    "SUDO_USER",
    "TERM",
    "TZ",
    "USER",
    "USERNAME",
    "XAUTHORITY",
    "_XKB_CHARSET",
];

/// Where sudo's secure_path looks, on the distributions that set one: a PATH of only these, in
/// any order, is what every command gets.
const SECURE_PATH: &[&str] = &[
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/snap/bin",
    "/var/lib/snapd/snap/bin",
];

/// Of the environment a command runs with, what maki shows: all but what every command gets. An
/// LD_PRELOAD set on the command line (sudoers lets `ALL` do it) shows, as does a PATH that looks
/// anywhere but the system's own places, and anything else a program might take a hint from.
pub fn notable<'a>(envp: &[&'a [u8]]) -> Vec<&'a [u8]> {
    envp.iter()
        .copied()
        .filter(|var| {
            let Some(eq) = var.iter().position(|&b| b == b'=') else {
                return true;
            };
            let (name, value) = (&var[..eq], &var[eq + 1..]);
            let name = std::str::from_utf8(name).unwrap_or("");
            if name == "PATH" {
                return !value
                    .split(|&b| b == b':')
                    .all(|dir| SECURE_PATH.iter().any(|s| s.as_bytes() == dir));
            }
            !(EVERY.contains(&name)
                || (name.len() > 3
                    && name.starts_with("LC_")
                    && name[3..].bytes().all(|b| b.is_ascii_uppercase())))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_laid_out_as_the_app_reads_it() {
        let c = Command {
            host: b"laptop",
            user: b"kara",
            runas_user: b"root",
            cwd: b"/home/kara",
            tty: b"/dev/pts/3",
            command: b"/usr/bin/systemctl",
            argv: vec![b"systemctl", b"restart", b"nginx"],
            ..Command::default()
        };
        let b = body(&[1; 32], &c).unwrap();
        let mut want = vec![1u8; 32];
        want.extend(b"\x06laptop\x04kara\x04root\x00");
        want.extend(b"\x0a\x00/home/kara\x00\x00\x0a/dev/pts/3\x00\x00");
        want.extend(
            b"\x12\x00/usr/bin/systemctl\x03\x09\x00systemctl\x07\x00restart\x05\x00nginx\x00",
        );
        assert_eq!(b, want);
    }

    #[test]
    fn what_wont_fit_maki_is_too_long() {
        let long = vec![b'x'; 256];
        let c = Command {
            host: &long,
            runas_user: b"root",
            command: b"/bin/true",
            argv: vec![b"true"],
            ..Command::default()
        };
        assert_eq!(body(&[0; 32], &c), Err(TooLong));
        let arg = [b'a'; 100];
        let many: Vec<&[u8]> = std::iter::repeat_n(&arg[..], 40).collect();
        let c = Command {
            runas_user: b"root",
            command: b"/bin/echo",
            argv: many,
            ..Command::default()
        };
        assert_eq!(body(&[0; 32], &c), Err(TooLong));
        let few: Vec<&[u8]> = std::iter::repeat_n(&arg[..], 39).collect();
        let c = Command {
            runas_user: b"root",
            command: b"/bin/echo",
            argv: few,
            ..Command::default()
        };
        assert!(body(&[0; 32], &c).unwrap().len() < MOST);
    }

    #[test]
    fn maki_shows_the_environment_but_what_every_command_gets() {
        let env: Vec<&[u8]> = vec![
            b"HOME=/root",
            b"LANG=en_US.UTF-8",
            b"LC_TIME=C",
            b"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
            b"SUDO_COMMAND=/usr/bin/true",
            b"TERM=xterm-256color",
            b"LD_PRELOAD=/tmp/x.so",
            b"PATH=/home/kara/bin:/usr/bin",
            b"PYTHONPATH=/tmp",
            b"LC_=odd",
            b"LC_lower=odd",
            b"NOEQUALS",
        ];
        let shown: Vec<&[u8]> = notable(&env);
        assert_eq!(
            shown,
            [
                &b"LD_PRELOAD=/tmp/x.so"[..],
                b"PATH=/home/kara/bin:/usr/bin",
                b"PYTHONPATH=/tmp",
                b"LC_=odd",
                b"LC_lower=odd",
                b"NOEQUALS"
            ]
        );
        // an empty PATH entry is the current directory: shown
        assert_eq!(notable(&[b"PATH=/usr/bin:"]).len(), 1);
    }
}
