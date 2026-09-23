/**
 * Staff-facing wording, and the enumerations the edit form offers.
 *
 * The mockup shipped with invented tool names (place_order, get_menu,
 * get_order_status). These are the tools the orchestrator actually
 * declares — see orchestrator/tools.py SESSION_TOOLS, which is the source
 * of truth. Keep them in step.
 */

export const TOOL_HUMAN: Record<string, string> = {
  check_menu: 'Menu lookup',
  dispatch_delivery: 'New order',
  deliver_parcel: 'Food delivery',
  check_delivery_status: 'Order status',
  amend_delivery: 'Changed an order',
  recall_robot: 'Recalled a robot',
  get_fleet_state: 'Fleet check',
  announce_arrival: 'Announced arrival',
  hotel_info: 'Hotel info',
  escalate_to_frontdesk: 'Escalated to desk',
};

/** Collapses the tools into the flow diagram's five tool nodes. */
export const TOOL_GROUP: Record<string, string> = {
  check_menu: 'menu',
  dispatch_delivery: 'dispatch',
  deliver_parcel: 'parcel',
  amend_delivery: 'dispatch',
  recall_robot: 'dispatch',
  check_delivery_status: 'status',
  get_fleet_state: 'status',
  announce_arrival: 'status',
  hotel_info: 'info',
  escalate_to_frontdesk: 'escalate',
};

export const ARG_HUMAN: Record<string, string> = {
  room: 'Room',
  items: 'Items',
  priority: 'Priority',
  task_id: 'Order',
  add: 'Added',
  remove: 'Removed',
  new_room: 'New room',
  reason: 'Reason',
  topic: 'Topic',
  source: 'From',
  description: 'What',
};

/**
 * Menu categories.
 *
 * These are the DB's vocabulary, not the mockup's: inventory_items has a
 * CHECK constraint on ('amenity','food','beverage'), and it is also the
 * vocabulary the voice agent reads back to guests. The mockup drew
 * food/drink/amenities; changing the UI was the one-line side of that
 * mismatch, so the constraint and the agent were left untouched.
 */
export const CATS = ['food', 'beverage', 'amenity'] as const;

/** Free-form in the DB (dietary_tags is a bare text[]); these are the
 *  suggestions the edit form offers, not a constraint. */
export const TAGS = ['vegan', 'vegetarian', 'gluten-free', 'nut-free', 'halal'] as const;
