-- Toothbrush on the menu. It was seeded hidden and out of stock (the "not
-- available" demo path), but guests ask for it constantly and the substitute
-- (dental kit) flow kept tripping the model into sending extras.
update public.inventory_items
set available = true, stock_count = 20, updated_at = now()
where name = 'toothbrush';
