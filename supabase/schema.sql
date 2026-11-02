create table if not exists public.trainer_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.trainer_snapshots enable row level security;

drop policy if exists "Users can read own snapshot" on public.trainer_snapshots;
drop policy if exists "Users can insert own snapshot" on public.trainer_snapshots;
drop policy if exists "Users can update own snapshot" on public.trainer_snapshots;

create policy "Users can read own snapshot"
on public.trainer_snapshots
for select
using (auth.uid() = user_id);

create policy "Users can insert own snapshot"
on public.trainer_snapshots
for insert
with check (auth.uid() = user_id);

create policy "Users can update own snapshot"
on public.trainer_snapshots
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create table if not exists public.trainer_snapshot_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.trainer_snapshot_history enable row level security;

drop policy if exists "Users can read own history" on public.trainer_snapshot_history;
drop policy if exists "Users can insert own history" on public.trainer_snapshot_history;

create policy "Users can read own history"
on public.trainer_snapshot_history
for select
using (auth.uid() = user_id);

create policy "Users can insert own history"
on public.trainer_snapshot_history
for insert
with check (auth.uid() = user_id);
