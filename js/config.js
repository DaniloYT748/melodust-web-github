/* Melodust Web — sync server settings.
   api: ''  -> the sync server is on the same address as this site (server/server.js serves both)
   api: 'https://sync.example.com' -> the sync server lives on another address (set ALLOWED_ORIGINS there if you restrict CORS)
   disabled: true -> hide account sync completely */
window.MW_SYNC = { api: '', disabled: false };
