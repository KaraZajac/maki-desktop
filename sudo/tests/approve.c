/*
 * What sudo does with an approval plugin, and no more, for tests without root: load it, open it
 * for this user, and check a command sudoers has said yes to. Exits 0 if it would run, 1 if not,
 * 2 if the plugin wouldn't start. sudo_plugin(5)'s structures, as sudo_plugin.h has them.
 *
 *     cc -o approve approve.c -ldl
 *     approve PLUGIN.so [OPTION=VALUE...] -- COMMAND [ARGUMENT...]
 *
 * The options are the plugin's own, as sudo.conf gives them. The command runs as root, from here,
 * with the environment sudo's env_reset gives it, and MAKI_TEST_ENV's `NAME=value` besides (what a
 * command line would set).
 */
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*sudo_printf_t)(int msg_type, const char *fmt, ...);
struct approval_plugin {
    unsigned int type;
    unsigned int version;
    int (*open)(unsigned int version, void *conversation, sudo_printf_t sudo_plugin_printf, char *const settings[],
        char *const user_info[], int submit_optind, char *const submit_argv[], char *const submit_envp[],
        char *const plugin_options[], const char **errstr);
    void (*close)(void);
    int (*check)(char *const command_info[], char *const run_argv[], char *const run_envp[], const char **errstr);
    int (*show_version)(int verbose);
};

/* as sudo's, with no terminal: errors to stderr, the rest to stdout */
static int say(int msg_type, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    int n = vfprintf((msg_type & 0xff) == 0x0003 ? stderr : stdout, fmt, ap);
    va_end(ap);
    return n;
}

static char *join(const char *name, const char *value)
{
    char *s = malloc(strlen(name) + strlen(value) + 1);
    strcpy(s, name);
    strcat(s, value);
    return s;
}

int main(int argc, char *argv[])
{
    int dash = 1;
    while (dash < argc && strcmp(argv[dash], "--") != 0)
        dash++;
    if (argc < 3 || dash >= argc - 1) {
        fprintf(stderr, "approve PLUGIN.so [OPTION=VALUE...] -- COMMAND [ARGUMENT...]\n");
        return 2;
    }
    void *handle = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        fprintf(stderr, "approve: %s\n", dlerror());
        return 2;
    }
    struct approval_plugin *plugin = dlsym(handle, "maki_approval");
    if (!plugin || plugin->type != 4) {
        fprintf(stderr, "approve: no approval plugin maki_approval in it\n");
        return 2;
    }

    char *options[64] = { 0 };
    for (int i = 2, n = 0; i < dash && n < 63; i++)
        options[n++] = argv[i];
    const char *user = getenv("USER") ? getenv("USER") : "user";
    char uid[32], host[256] = "localhost", cwd[4096] = "/";
    snprintf(uid, sizeof uid, "uid=%u", (unsigned)getuid());
    gethostname(host, sizeof host - 1);
    if (!getcwd(cwd, sizeof cwd))
        strcpy(cwd, "/");
    char *user_info[] = { join("user=", user), uid, join("host=", host), join("cwd=", cwd), "tty=/dev/pts/9", NULL };
    char *envp[3] = { 0 };
    int e = 0;
    if (getenv("XDG_RUNTIME_DIR"))
        envp[e++] = join("XDG_RUNTIME_DIR=", getenv("XDG_RUNTIME_DIR"));
    if (getenv("TMPDIR"))
        envp[e++] = join("TMPDIR=", getenv("TMPDIR"));
    char *none[] = { NULL };

    const char *path = argv[dash + 1];
    char *command_info[] = { join("command=", path[0] == '/' ? path : join("/usr/bin/", path)), "runas_user=root",
        "runas_uid=0", "runas_gid=0", NULL };
    char **run_argv = &argv[dash + 1];
    char line[8192] = "";
    for (int i = dash + 1; i < argc; i++) {
        if (i > dash + 1)
            strncat(line, " ", sizeof line - strlen(line) - 1);
        strncat(line, argv[i], sizeof line - strlen(line) - 1);
    }
    char *run_envp[] = { "HOME=/root", "PATH=/usr/sbin:/usr/bin", join("SUDO_COMMAND=", line), join("SUDO_USER=", user),
        getenv("MAKI_TEST_ENV"), NULL };

    const char *errstr = NULL;
    int opened = plugin->open((1 << 16) | 22, NULL, say, none, user_info, 0, none, envp, options, &errstr);
    if (opened == 0) {
        fprintf(stderr, "approve: not for %s: sudoers alone decides\n", user);
        return 0;
    }
    if (opened != 1)
        return 2;
    int checked = plugin->check(command_info, run_argv, run_envp, &errstr);
    if (errstr)
        fprintf(stderr, "approve: logged: %s\n", errstr);
    plugin->close();
    return checked == 1 ? 0 : 1;
}
