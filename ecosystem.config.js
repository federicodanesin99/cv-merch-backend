// ecosystem.config.js
module.exports = {
    apps: [
      {
        name: 'server',
        script: './server.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        env: {
          NODE_ENV: 'production'
        }
      },
      {
        name: 'gmail-parser',
        script: './gmail-parser-oauth.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '300M',
        cron_restart: '0 */6 * * *', // Restart ogni 6 ore (opzionale)
        env: {
          NODE_ENV: 'production'
        }
      }
    ]
  };
