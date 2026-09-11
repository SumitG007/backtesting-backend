module.exports = {
  apps: [
    {
      name: 'BackTesting',
      cwd: __dirname,
      script: 'src/server.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      // PM2's APM hook (require-in-the-middle) can load dual-package ESM
      // entry files via require(), which crashes Node with:
      // "SyntaxError: Cannot use import statement outside a module"
      pmx: false,
      automation: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
