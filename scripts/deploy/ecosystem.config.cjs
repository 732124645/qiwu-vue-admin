// PM2 app for scripts/deploy/server-deploy.sh: cluster mode behind the `current` symlink, so
// `pm2 startOrReload` replaces the workers one by one. PM2 is a global server tool, not a dependency.
// Settings come from deploy.env next to bin/ (the deploy script exports them).
const root = process.env.QW_DEPLOY_ROOT || '/srv/qiwu'
const server = `${root}/current/apps/server`

module.exports = {
  apps: [
    {
      name: process.env.QW_PM2_NAME || 'qiwu-server',
      cwd: server,
      script: 'dist/main.js',
      // absolute: a cluster worker's start directory is not guaranteed to be the app directory
      node_args: `--env-file-if-exists=${server}/.env.local --env-file-if-exists=${server}/.env`,
      exec_mode: 'cluster',
      instances: Number(process.env.QW_PM2_INSTANCES || 2),
      listen_timeout: 30000, // a new worker counts as up once it listens
      kill_timeout: 10000, // shutdown hooks close the database and Redis connections
      min_uptime: '30s',
      max_restarts: 10,
      autorestart: true,
      time: true,
      merge_logs: true,
      error_file: `${root}/logs/server-error.log`,
      out_file: `${root}/logs/server-out.log`,
      env_production: { NODE_ENV: 'production' },
    },
  ],
}
