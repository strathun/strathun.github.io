# strathun.github.io

Personal hub — static site hosted on GitHub Pages, backed by Supabase for auth + data.

## Structure

```
strathun.github.io/
├── index.html          # hub homepage
├── assets/
│   ├── style.css       # shared design system
│   └── auth.js         # shared Supabase auth + client
├── games/
│   └── index.html      # game time tracker
└── supabase_setup.sql  # run once in Supabase SQL editor
```

## Adding a new app

1. Create a folder: `mkdir myapp`
2. Copy the nav + auth pattern from `games/index.html`
3. Add a card for it in `index.html` → `.app-grid`
4. Add a link to it in both nav bars

## Stack

- **Hosting**: GitHub Pages (free, auto-deploys on push)
- **Auth + DB**: Supabase (free tier)
- **Frontend**: vanilla HTML/CSS/JS, no build step
