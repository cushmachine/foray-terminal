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

function isPm2Prefixed(key: string): boolean {
  return key.startsWith('PM2_') || key.startsWith('pm_') || key.startsWith('NODE_CHANNEL_')
    || key === 'NODE_APP_INSTANCE'
}

/** `env` without Foray's own variables, its server config, and pm2's. */
export function sessionEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const underPm2 = 'pm_id' in env || 'PM2_HOME' in env || 'pm_exec_path' in env
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('FORAY_')) continue
    if (SERVER_CONFIG_VARS.has(key)) continue
    if (isPm2Prefixed(key)) continue
    if (underPm2 && PM2_FLATTENED_VARS.has(key)) continue
    out[key] = value
  }
  return out
}
