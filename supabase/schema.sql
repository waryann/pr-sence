-- Présences de l'église : schéma Supabase
-- Les tables ne sont jamais lisibles directement depuis le site (RLS sans règle + droits retirés).
-- Tout passe par les fonctions ci-dessous, qui vérifient le code de l'église à chaque appel.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------
create table if not exists public.membres (
  id          text primary key default gen_random_uuid()::text,
  nom         text not null,
  commission  text not null default '',
  statut      text not null default '',
  actif       boolean not null default true,
  cree_le     timestamptz not null default now()
);

create table if not exists public.seances (
  date        date primary key,
  titre       text not null default '',
  presences   jsonb not null default '{}'::jsonb,   -- { "<id membre>": "p" | "z" }
  modifie_le  timestamptz not null default now()
);

create table if not exists public.messages (
  id      bigint generated always as identity primary key,
  auteur  text not null,
  texte   text not null,
  envoye  timestamptz not null default now()
);

create table if not exists public.reglages (
  cle     text primary key,
  valeur  text not null
);

alter table public.membres  enable row level security;
alter table public.seances  enable row level security;
alter table public.messages enable row level security;
alter table public.reglages enable row level security;
revoke all on public.membres, public.seances, public.messages, public.reglages from anon, authenticated;

-- ---------- Vérification du code (10 essais ratés = blocage 15 minutes) ----------
create or replace function public._verifier(p_code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  h text; bloque timestamptz; echecs int;
begin
  select valeur into h from reglages where cle = 'code_hash';
  if h is null then return 'PAS_DE_CODE'; end if;
  select valeur::timestamptz into bloque from reglages where cle = 'bloque_jusqua';
  if bloque is not null and bloque > now() then return 'BLOQUE'; end if;
  if p_code is null or crypt(p_code, h) <> h then
    insert into reglages values ('echecs', '1')
      on conflict (cle) do update set valeur = (reglages.valeur::int + 1)::text
      returning valeur::int into echecs;
    if echecs >= 10 then
      insert into reglages values ('bloque_jusqua', (now() + interval '15 minutes')::text)
        on conflict (cle) do update set valeur = excluded.valeur;
      update reglages set valeur = '0' where cle = 'echecs';
    end if;
    return 'MAUVAIS_CODE';
  end if;
  update reglages set valeur = '0' where cle = 'echecs' and valeur <> '0';
  return null;
end $$;

-- ---------- Fonctions appelées par le site ----------
create or replace function public.etat() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('code_defini', exists (select 1 from reglages where cle = 'code_hash'));
$$;

create or replace function public.ping() returns text
language sql security definer set search_path = public as $$
  select 'ok'::text from (select count(*) from reglages) t;
$$;

create or replace function public.definir_code(p_nouveau text, p_ancien text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e text;
begin
  if p_nouveau is null or length(trim(p_nouveau)) < 6 then
    return jsonb_build_object('erreur', 'CODE_TROP_COURT');
  end if;
  if exists (select 1 from reglages where cle = 'code_hash') then
    e := _verifier(p_ancien);
    if e is not null then return jsonb_build_object('erreur', e); end if;
  end if;
  insert into reglages values ('code_hash', crypt(trim(p_nouveau), gen_salt('bf', 10)))
    on conflict (cle) do update set valeur = excluded.valeur;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.verifier_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code);
begin
  return case when e is null then jsonb_build_object('ok', true) else jsonb_build_object('erreur', e) end;
end $$;

create or replace function public.charger(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code);
begin
  if e is not null then return jsonb_build_object('erreur', e); end if;
  return jsonb_build_object(
    'membres',  coalesce((select jsonb_agg(to_jsonb(m) order by m.nom) from membres m), '[]'::jsonb),
    'seances',  coalesce((select jsonb_agg(jsonb_build_object('date', s.date, 'titre', s.titre, 'presences', s.presences) order by s.date) from seances s), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(x order by x.envoye) from (select * from messages order by envoye desc limit 40) x), '[]'::jsonb)
  );
end $$;

create or replace function public.marquer(p_code text, p_date date, p_membre text, p_valeur text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code);
begin
  if e is not null then return jsonb_build_object('erreur', e); end if;
  if p_valeur is not null and p_valeur not in ('p', 'z') then return jsonb_build_object('erreur', 'VALEUR'); end if;
  insert into seances (date, presences)
    values (p_date, case when p_valeur is null then '{}'::jsonb else jsonb_build_object(p_membre, p_valeur) end)
  on conflict (date) do update set
    presences = case when p_valeur is null then seances.presences - p_membre
                     else seances.presences || jsonb_build_object(p_membre, p_valeur) end,
    modifie_le = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.titrer_seance(p_code text, p_date date, p_titre text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code);
begin
  if e is not null then return jsonb_build_object('erreur', e); end if;
  insert into seances (date, titre) values (p_date, left(coalesce(p_titre, ''), 80))
  on conflict (date) do update set titre = excluded.titre, modifie_le = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.enregistrer_membre(p_code text, p_id text, p_nom text, p_commission text, p_statut text, p_actif boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code); nid text;
begin
  if e is not null then return jsonb_build_object('erreur', e); end if;
  if coalesce(trim(p_nom), '') = '' then return jsonb_build_object('erreur', 'NOM_VIDE'); end if;
  if p_id is null then
    insert into membres (nom, commission, statut, actif)
      values (left(trim(p_nom), 120), left(coalesce(trim(p_commission), ''), 40), left(coalesce(trim(p_statut), ''), 10), coalesce(p_actif, true))
      returning id into nid;
  else
    update membres set nom = left(trim(p_nom), 120), commission = left(coalesce(trim(p_commission), ''), 40),
      statut = left(coalesce(trim(p_statut), ''), 10), actif = coalesce(p_actif, true)
      where id = p_id returning id into nid;
  end if;
  return jsonb_build_object('ok', true, 'id', nid);
end $$;

create or replace function public.supprimer_membre(p_code text, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code);
begin
  if e is not null then return jsonb_build_object('erreur', e); end if;
  delete from membres where id = p_id;
  update seances set presences = presences - p_id where presences ? p_id;
  return jsonb_build_object('ok', true);
end $$;

-- p_lignes : [{ "id": "<id existant ou null>", "nom", "statut", "commission", "pres": "p" | "z" | null }]
create or replace function public.importer(p_code text, p_date date, p_lignes jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code); l jsonb; mid text; pres jsonb := '{}'::jsonb; crees int := 0;
begin
  if e is not null then return jsonb_build_object('erreur', e); end if;
  for l in select * from jsonb_array_elements(p_lignes) loop
    mid := nullif(l->>'id', '');
    if mid is null then
      insert into membres (nom, statut, commission)
        values (left(trim(l->>'nom'), 120), left(coalesce(l->>'statut', ''), 10), left(coalesce(l->>'commission', ''), 40))
        returning id into mid;
      crees := crees + 1;
    end if;
    if p_date is not null and l->>'pres' in ('p', 'z') then
      pres := pres || jsonb_build_object(mid, l->>'pres');
    end if;
  end loop;
  if p_date is not null and pres <> '{}'::jsonb then
    insert into seances (date, presences) values (p_date, pres)
    on conflict (date) do update set presences = seances.presences || excluded.presences, modifie_le = now();
  end if;
  return jsonb_build_object('ok', true, 'crees', crees);
end $$;

create or replace function public.envoyer_message(p_code text, p_auteur text, p_texte text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := _verifier(p_code);
begin
  if e is not null then return jsonb_build_object('erreur', e); end if;
  if coalesce(trim(p_texte), '') = '' then return jsonb_build_object('erreur', 'VIDE'); end if;
  insert into messages (auteur, texte) values (left(coalesce(nullif(trim(p_auteur), ''), 'Quelqu''un'), 40), left(trim(p_texte), 500));
  delete from messages where envoye < now() - interval '30 days';
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Droits : le site (rôle anon) n'appelle que les fonctions publiques ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.etat(), public.ping(), public.definir_code(text, text), public.verifier_code(text),
  public.charger(text), public.marquer(text, date, text, text), public.titrer_seance(text, date, text),
  public.enregistrer_membre(text, text, text, text, text, boolean), public.supprimer_membre(text, text),
  public.importer(text, date, jsonb), public.envoyer_message(text, text, text)
to anon, authenticated;
