-- Create table for expense categories
create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone default now()
);

alter table public.expense_categories enable row level security;

-- Allow everyone to read active categories
drop policy if exists exp_cat_read on public.expense_categories;
create policy exp_cat_read on public.expense_categories
for select
using (active);

-- Only admins can insert/update/delete
drop policy if exists exp_cat_admin_ins on public.expense_categories;
create policy exp_cat_admin_ins on public.expense_categories
for insert to authenticated
with check (exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));

drop policy if exists exp_cat_admin_upd on public.expense_categories;
create policy exp_cat_admin_upd on public.expense_categories
for update to authenticated
using (exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'))
with check (exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));

drop policy if exists exp_cat_admin_del on public.expense_categories;
create policy exp_cat_admin_del on public.expense_categories
for delete to authenticated
using (exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));


