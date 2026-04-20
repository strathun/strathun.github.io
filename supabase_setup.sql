-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- Game sessions table
create table if not exists game_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  game text not null,
  platform text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  duration_ms bigint not null,
  note text default '',
  manual boolean default false,
  created_at timestamptz default now()
);

-- Row level security: users can only see/edit their own sessions
alter table game_sessions enable row level security;

create policy "Users can view own sessions"
  on game_sessions for select
  using (auth.uid() = user_id);

create policy "Users can insert own sessions"
  on game_sessions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own sessions"
  on game_sessions for update
  using (auth.uid() = user_id);

create policy "Users can delete own sessions"
  on game_sessions for delete
  using (auth.uid() = user_id);

-- Index for fast queries by user + date
create index if not exists game_sessions_user_start on game_sessions(user_id, start_time desc);
