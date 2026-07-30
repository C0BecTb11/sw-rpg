-- Этап: авторизация + базовая таблица персонажей
-- Выполнено в Supabase SQL Editor

create table characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  name text not null,
  faction_id uuid,
  role text default 'member',
  bio text,
  created_at timestamptz default now()
);

alter table characters enable row level security;

create policy "Users can view all characters"
  on characters for select
  using (true);

create policy "Users can insert their own character"
  on characters for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own character"
  on characters for update
  using (auth.uid() = user_id);
