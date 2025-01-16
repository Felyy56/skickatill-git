// ecosystem.config.js
module.exports = {
  apps: [{
      name: 'gokart-app',
      script: 'startup.js',
      watch: true,
      ignore_watch: [
          "node_modules",
          "videostate.db",
          "videostate.db-*",
          "logs/*"
      ],
      env: {
          NODE_ENV: 'production',
          PORT: 3000
      },
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_restarts: 10,
      restart_delay: 4000,
      // Nya inställningar för bättre hantering
      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_memory_restart: '200M',
      kill_timeout: 3000,
      wait_ready: true,
      listen_timeout: 3000,
      // Hantering av oväntade krascher
      max_memory_restart: '300M',
      node_args: '--max-old-space-size=300',
      // Förbättrad loggning
      merge_logs: true,
      time: true
  }]
}