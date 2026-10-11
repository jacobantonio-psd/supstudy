# Assignment tracker + quiz server

Requires Node.js 18 or newer. No packages to install.

1. Set your API key (keep it secret, never put it in the HTML):
   - Mac/Linux: `export ANTHROPIC_API_KEY=your-key-here`
   - Windows PowerShell: `$env:ANTHROPIC_API_KEY="your-key-here"`
2. Run: `node server.js` (or `npm start`), then open http://localhost:3000

To put it online, deploy this folder to a Node host (Render, Railway, Fly.io, etc.), and set `ANTHROPIC_API_KEY` as a secret in that host's settings.

Optional settings:
- `QUIZ_MODEL`: model name to use (default `claude-sonnet-5-5`)
- `QUIZ_HOURLY_LIMIT`: quizzes allowed per IP per hour (default 60). This protects your API bill.
- `PORT`: port to listen on (default 3000)

Note: the per-IP limit trusts the `X-Forwarded-For` header, so it is only reliable behind a proxy you control. Set a spending limit in your Anthropic console as well.
