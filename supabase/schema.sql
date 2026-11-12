-- Video Stüdyo – Supabase şeması. Supabase panelinde SQL Editor → New query → yapıştır → Run.
-- Her kullanıcı yalnızca kendi videolarını, kütüphanesini ve dosyalarını görür (RLS).

-- Videolar: video.json tamamı "data" içinde; "manifest" = {dosyaAdı: boyut}
create table if not exists public.videos (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  name text,
  data jsonb not null,
  manifest jsonb not null default '{}'::jsonb,
  summary jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.videos enable row level security;
drop policy if exists "own videos" on public.videos;
create policy "own videos" on public.videos
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Kütüphane (karakterler, mekânlar, anlatıcılar, müzik etiketleri): kullanıcı başına tek satır
create table if not exists public.library (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  manifest jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.library enable row level security;
drop policy if exists "own library" on public.library;
create policy "own library" on public.library
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Dosya deposu: kova "videos" (özel), yol: <user_id>/<video_id>/<dosya> ve <user_id>/library/<dosya>
insert into storage.buckets (id, name, public, file_size_limit)
values ('videos', 'videos', false, 524288000)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "own objects" on storage.objects;
create policy "own objects" on storage.objects
  for all to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
