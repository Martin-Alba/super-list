-- ============================================================
-- Super — esqueleto compartido
-- Invariante (R16 / constitución B.3): las tablas publicadas en
-- supabase_realtime NO tienen política DELETE. La desaparición es
-- siempre un cambio de estado, porque los eventos DELETE de Realtime
-- están exentos de RLS y se emitirían a todos los suscriptores.
-- ============================================================

do $$ begin
  create type public.member_status as enum ('pending','active','rejected','removed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.member_role as enum ('owner','member');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  owner_id   uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id     uuid not null references public.groups(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  status       public.member_status not null default 'pending',
  role         public.member_role   not null default 'member',
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references public.profiles(id),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id, status);

create table if not exists public.group_invites (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  token      text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  name       text not null check (btrim(name) <> ''),
  quantity   text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists items_group_idx on public.items (group_id) where deleted_at is null;

-- ============================================================
-- R11: pertenencia sin recursión. SECURITY DEFINER + search_path fijado.
-- Una SECURITY DEFINER sin search_path es escalada de privilegios (B.1).
-- ============================================================

create or replace function public.is_active_member(p_group_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = p_group_id
      and m.user_id  = (select auth.uid())
      and m.status   = 'active'
  );
$$;

create or replace function public.is_group_owner(p_group_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = p_group_id
      and m.user_id  = (select auth.uid())
      and m.status   = 'active'
      and m.role     = 'owner'
  );
$$;

create or replace function public.shares_active_group(p_user_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.group_members me
    join public.group_members other on other.group_id = me.group_id
    where me.user_id = (select auth.uid()) and me.status = 'active'
      and other.user_id = p_user_id and other.status = 'active'
  );
$$;

-- ============================================================
-- R1: el perfil lo crea un trigger, no el código de la app.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ============================================================
-- RLS. Lecturas por política; escrituras por RPC SECURITY DEFINER (B.5).
-- Ninguna tabla tiene política DELETE (R16).
-- ============================================================

alter table public.profiles      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.items         enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_active_group(id));

drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups for select to authenticated
  using (public.is_active_member(id));

-- Cada quien lee SIEMPRE su propia fila, en cualquier estado: es lo que
-- entrega al expulsado el evento de su expulsión (R7) filtrado por RLS.
drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_active_member(group_id));

-- La política de items NO filtra deleted_at a propósito: si lo hiciera, el
-- UPDATE que marca el borrado no se entregaría por Realtime y R9 perdería
-- el borrado en vivo. El filtrado de borrados es cosa de las consultas.
drop policy if exists items_select on public.items;
create policy items_select on public.items for select to authenticated
  using (public.is_active_member(group_id));

drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert to authenticated
  with check (public.is_active_member(group_id) and created_by = (select auth.uid()));

drop policy if exists items_update on public.items;
create policy items_update on public.items for update to authenticated
  using (public.is_active_member(group_id))
  with check (public.is_active_member(group_id));

-- R12: sin esto no hay eventos y el fallo es silencioso.
-- `alter publication ... add table` falla si ya esta: se guarda contra el
-- catalogo para que la migracion se pueda reaplicar (constitucion C).
do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='items') then
    alter publication supabase_realtime add table public.items;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='group_members') then
    alter publication supabase_realtime add table public.group_members;
  end if;
end $$;
