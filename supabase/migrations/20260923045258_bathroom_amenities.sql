-- Bathroom basics every hotel stocks. Their absence made the assistant
-- tell a guest "we don't carry shampoo" and then escalate it to the desk,
-- which is the wrong answer twice over.
--
-- toothbrush stays available=false on purpose: DEMO-RUNSHEET's failure beat
-- uses it, and "dental kit" is now the alternative the assistant can offer.

insert into inventory_items (name, category, price, dietary_tags, available, stock_count) values
  ('shampoo',     'amenity', null, '{}', true, 20),
  ('conditioner', 'amenity', null, '{}', true, 20),
  ('body wash',   'amenity', null, '{}', true, 20),
  ('dental kit',  'amenity', null, '{}', true, 15)
on conflict (name) do nothing;
