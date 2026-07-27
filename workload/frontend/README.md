# asmDB workload frontend

The Fabric item manifest opens the editor at `/sync-hub`. This is a single-surface React app, so the browser route is handled by the app, not by separate files on the static host.

**The host must serve `index.html` for unknown paths, or the Fabric editor panel renders blank.**

Deployment fallbacks included here:

- `public/staticwebapp.config.json` configures Azure Static Web Apps `navigationFallback` to `/index.html` and excludes `/assets/*` so genuinely missing hashed bundles still 404.
- `public/_redirects` provides the same SPA fallback for hosts that understand Netlify-style redirects.
- For a plain nginx/static host, use the equivalent rule:

```nginx
location /assets/ { try_files $uri =404; }
location / { try_files $uri /index.html; }
```

Keep `src/workload-constants.ts` in sync with the workload manifest fields named in that file. The frontend workload ID, SyncHub item type and editor path must be changed there first, then reflected in the manifest.

