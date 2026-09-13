-- A realistic room-service menu for the demo.
--
-- Deliberately covers every item the RQ1/RQ2 utterance set and agent.py's
-- KEYTERMS already name. Before this, only towel/toothbrush/nasi lemak
-- existed, so a guest speaking one of the recorded test lines ("can you
-- hantar satu char kuey teow") would have been told the item is not offered
-- -- the WER test set described orders the system could not fulfil.
--
-- Also spreads the stock states the admin UI renders differently, so the
-- Inventory tab is meaningful on sight: null = unlimited, <=3 = low
-- (heavy ink underline), 0 = out (alert chip), and available=false = hidden
-- from the menu the voice agent reads.
--
-- ON CONFLICT DO NOTHING keyed on the unique name: re-runnable, and it will
-- not clobber the three rows that already exist.

insert into inventory_items (name, category, price, dietary_tags, available, stock_count) values
  -- food
  ('char kuey teow',      'food', 12.00, '{halal}',                      true,  6),
  ('roti canai',          'food',  6.00, '{halal,vegetarian}',           true, 10),
  ('mee goreng',          'food', 11.00, '{halal,vegetarian}',           true,  7),
  ('chicken satay',       'food', 15.00, '{halal}',                      true,  0),
  ('club sandwich',       'food', 18.00, '{}',                           true,  8),
  ('caesar salad',        'food', 16.00, '{vegetarian}',                 true,  5),
  ('fruit platter',       'food', 14.00, '{vegan,gluten-free,nut-free}', true,  4),
  ('chicken congee',      'food',  9.00, '{halal,gluten-free}',          true,  2),

  -- beverage
  ('teh tarik',           'beverage',  5.00, '{halal,vegetarian}',            true, null),
  ('kopi o',              'beverage',  4.50, '{halal,vegan,gluten-free}',     true, null),
  ('still water',         'beverage',  3.00, '{halal,vegan,gluten-free,nut-free}', true, null),
  ('sparkling water',     'beverage',  6.00, '{halal,vegan,gluten-free}',     true, 24),
  ('fresh orange juice',  'beverage',  9.00, '{halal,vegan,gluten-free}',     true, 12),
  ('iced lemon tea',      'beverage',  6.00, '{halal,vegan,gluten-free}',     true, 18),
  ('beer, can',           'beverage', 15.00, '{}',                            true,  9),
  ('house red, glass',    'beverage', 28.00, '{vegan}',                       true,  6),

  -- amenity (no charge, so price stays null like the existing towel row)
  ('extra pillow',        'amenity', null, '{}', true, 12),
  ('extra blanket',       'amenity', null, '{}', true,  8),
  ('bath towel set',      'amenity', null, '{}', true, 15),
  ('slippers',            'amenity', null, '{}', true, 20),
  ('shower cap',          'amenity', null, '{}', true, 25),
  ('comb',                'amenity', null, '{}', true, 14),
  ('shaving kit',         'amenity', null, '{}', true,  6),
  ('sewing kit',          'amenity', null, '{}', true,  3),
  ('iron and board',      'amenity', null, '{}', true,  2),
  ('phone charger, usb-c','amenity', null, '{}', false, 0)
on conflict (name) do nothing;
