-- Entries that belong to no workspace: sign-ins and server settings. Row security hides them from the app role,
-- so this one function reads them, and only the platform administrator's route calls it.
-- `terms` are ilike patterns, and every one must match. Null `areas` means all of them, and an empty list means none.
create function platform_audit_page(terms text[], areas text[], since timestamptz, until timestamptz, newest_first boolean, page_size integer, page_offset integer)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if coalesce(current_setting('app.workspace_id', true), '') <> '' then
    raise exception 'Server activity cannot be read inside a workspace.';
  end if;
  with found as (
    select a.id, a.actor_id, coalesce(u.name, u.email) as actor_name, a.action, a.target_type, a.target_id, a.details, a.ip, a.at
    from audit_events a left join "user" u on u.id = a.actor_id
    where a.workspace_id is null
      and (areas is null or split_part(a.action, '.', 1) = any(areas))
      and (since is null or a.at >= since)
      and (until is null or a.at <= until)
      and not exists (
        select 1 from unnest(terms) as term
        where concat_ws(' ', replace(a.action, '.', ' '), coalesce(u.name, u.email), a.target_type, a.target_id) not ilike term
      )
  ), page as (
    select * from found
    order by case when newest_first then id end desc, case when not newest_first then id end asc
    limit least(page_size, 200) offset page_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from found),
    'events', coalesce((select jsonb_agg(to_jsonb(page) order by case when newest_first then id end desc, case when not newest_first then id end asc) from page), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function platform_audit_page(text[], text[], timestamptz, timestamptz, boolean, integer, integer) from public;
