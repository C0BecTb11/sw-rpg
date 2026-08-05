create table systems (
  id text primary key,
  name text not null,
  faction text not null,
  texture text not null,
  left_pct numeric not null,
  top_pct numeric not null,
  radius integer not null,
  speed numeric not null
);

alter table systems enable row level security;

create policy "Anyone can view systems"
  on systems for select
  using (true);

insert into systems (id, name, faction, texture, left_pct, top_pct, radius, speed) values
  ('coruscant', 'Корусант', 'republic', 'assets/planets/coruscant.png', 6, 55, 16, 0.0006),
  ('kuat', 'Куат', 'republic', 'assets/planets/kuat.png', 10, 35, 15, 0.0010),
  ('corellia', 'Кореллия', 'republic', 'assets/planets/corellia.png', 14, 68, 15, 0.0010),
  ('alderaan', 'Альдераан', 'republic', 'assets/planets/alderaan.png', 30, 28, 14, 0.0009),
  ('anaxes', 'Анаксес', 'republic', 'assets/planets/anaxes.png', 22, 50, 14, 0.0008),
  ('naboo', 'Набу', 'republic', 'assets/planets/naboo.png', 37, 15, 14, 0.0012),
  ('kashyyyk', 'Кашиик', 'republic', 'assets/planets/kashyyyk.png', 4, 18, 15, 0.0011),
  ('kamino', 'Камино', 'republic', 'assets/planets/kamino.png', 40, 88, 13, 0.0011),
  ('christophsis', 'Кристофсис', 'republic', 'assets/planets/christophsis.png', 42, 68, 13, 0.0010),
  ('ryloth', 'Рилот', 'republic', 'assets/planets/ryloth.png', 22, 82, 14, 0.0009),
  ('utapau', 'Утапау', 'cis', 'assets/planets/utapau.png', 50, 50, 14, 0.0009),
  ('raxus', 'Раксус', 'cis', 'assets/planets/raxus.png', 94, 62, 14, 0.0010),
  ('geonosis', 'Геонозис', 'cis', 'assets/planets/geonosis.png', 65, 55, 15, 0.0009),
  ('muunilinst', 'Муунилинст', 'cis', 'assets/planets/muunilinst.png', 60, 32, 14, 0.0010),
  ('maygito', 'Майгито', 'cis', 'assets/planets/maygito.png', 58, 78, 13, 0.0008),
  ('catoneimoidia', 'Като-Неймодия', 'cis', 'assets/planets/catoneimoidia.png', 72, 65, 14, 0.0011),
  ('mustafar', 'Мустафар', 'cis', 'assets/planets/mustafar.png', 88, 78, 14, 0.0010),
  ('hypori', 'Хайпори', 'cis', 'assets/planets/hypori.png', 92, 45, 13, 0.0009),
  ('umbara', 'Умбара', 'cis', 'assets/planets/umbara.png', 86, 8, 13, 0.0011),
  ('feorust', 'Фоэрост', 'cis', 'assets/planets/feorust.png', 78, 25, 14, 0.0009);