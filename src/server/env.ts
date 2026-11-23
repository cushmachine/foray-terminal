// The environment Foray hands to what it spawns.
//
// A shell in a session runs as the same user and could read the token
// file anyway, but a program printing `env` to a log or a transcript
// should not carry the token into it. tmux keeps the environment of
// whoever started its server as the global environment of every later
// session, so the scrub applies to every tmux invocation, not only the
// pty that attaches.
//
// Foray's own configuration must not leak either: zsh takes $HOST as the
// machine name (the prompt shows `user@127`), dev servers read $PORT and
// would collide with Foray, and NODE_ENV=production makes `npm install`
// skip devDependencies. The server still reads PORT and HOST itself; this
// only affects what its children see.

/** Variables the server reads for itself that a session has no business seeing. */
const SERVER_CONFIG_VARS = new Set(['HOST', 'PORT', 'NODE_ENV'])

/**
 * What pm2 injects into a managed process, besides PM2_* and pm_*: the app
 * config flattened into lowercase names, and the cluster/IPC channel vars.
 * Found by listing the names in a running pm2-managed Foray's environment.
 * Generic words like `name` and `status` are only stripped when pm2 is
 * evidently the parent (see below), so an unmanaged server keeps a user's
 * own variables of those names.
 */
const PM2_FLATTENED_VARS = new Set([
  'automation', 'autorestart', 'autostart', 'created_at', 'exec_interpreter', 'exec_mode',
  'instance_var', 'instances', 'kill_retry_time', 'km_link', 'log_date_format',
  'max_memory_restart', 'merge_logs', 'name', 'namespace', 'pmx', 'restart_time', 'status',
  'treekill', 'unique_id', 'unstable_restarts', 'username', 'vizion', 'vizion_running',
  'watch', 'windowsHide',
])

/**
 * PM2_* variables a user sets so the pm2 CLI finds its daemon and behaves:
 * the "sync now" deploy session runs pm2 from inside a Foray session and
 * needs PM2_HOME above all. Kept even though pm2 passes them down; the rest
 * of PM2_* (PM2_USAGE, PM2_PROGRAMMATIC, ...) is runtime injection.
 */
const PM2_USER_CONFIG = new Set([
  'PM2_HOME', 'PM2_SILENT', 'PM2_DEBUG', 'PM2_DISCRETE_MODE', 'PM2_MODULE_CONF_FILE',
  'PM2_PID_FILE_PATH', 'PM2_LOG_FILE_PATH', 'PM2_LOG_DATE_FORMAT', 'PM2_SOCKET_USER',
  'PM2_SOCKET_GROUP', 'PM2_NODE_OPTIONS', 'PM2_DAEMON_TITLE', 'PM2_ROOT_PATH',
])

function isPm2Prefixed(key: string): boolean {
  return (key.startsWith('PM2_') && !PM2_USER_CONFIG.has(key)) || key.startsWith('pm_')
    || key.startsWith('NODE_CHANNEL_') || key === 'NODE_APP_INSTANCE'
}

/** Whether this process was started by pm2 (generic names are only stripped then). */
export function runsUnderPm2(env: NodeJS.ProcessEnv): boolean {
  return 'pm_id' in env || 'PM2_HOME' in env || 'pm_exec_path' in env
}

/** Whether a variable of this name is kept out of what Foray spawns. */
export function isStrippedEnvName(key: string, underPm2: boolean): boolean {
  return key.startsWith('FORAY_') || SERVER_CONFIG_VARS.has(key) || isPm2Prefixed(key)
    || (underPm2 && PM2_FLATTENED_VARS.has(key))
}

/** `env` without Foray's own variables, its server config, and pm2's. */
export function sessionEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const underPm2 = runsUnderPm2(env)
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isStrippedEnvName(key, underPm2)) out[key] = value
  }
  return out
}
