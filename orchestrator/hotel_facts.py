"""The hotel's fact sheet — what hotel_info reads back to guests.

Edit freely; this is the only place the assistant gets policy and facility
answers from. It is told to answer ONLY from here, so a question with no
entry becomes an escalation instead of an invented answer.

Floors 8 and 12 are guest floors (rooms 0803/0804, 1204/1205) — keep that
consistent with the sim's corridor.
"""
# ponytail: static dict; move to a Supabase table + Inventory-style tab when
# staff need to edit it without a restart.
HOTEL_FACTS = {
    # Late check-out is repeated here on purpose: a guest asking "what time
    # is checkout, can I leave at 3?" gets looked up as check_in_out, and the
    # fee must come back with it rather than depend on a second lookup.
    "check_in_out": "Check-in from 3pm, check-out by 12 noon. Early check-in "
                    "depends on availability — the front desk can confirm on the day. "
                    "Late check-out is $30 per extra hour after 12 noon, up to 5pm at "
                    "the latest (e.g. 3pm = 3 hours = $90; 5pm = $150). On request, "
                    "subject to availability.",
    "late_checkout": "Late check-out is $30 per extra hour after the 12 noon "
                     "check-out, up to 5pm at the latest (e.g. 3pm = 3 hours = $90; "
                     "5pm = $150). Later than 5pm is not possible. On request, "
                     "subject to availability.",
    "facilities": "Lobby, front desk and café on the ground floor. Gym on level 3, "
                  "open 6am to 10pm. Pool on level 5, open 7am to 9pm. "
                  "Restaurant on level 2: breakfast 6:30 to 10:30am, dinner 6 to 10pm. "
                  "Rooftop bar on level 15, open 5pm to midnight.",
    "wifi": "Wi-Fi network 'Concierge-Guest', no password — sign in with your "
            "room number and surname.",
    "breakfast": "Breakfast is served at the level 2 restaurant, 6:30 to 10:30am. "
                 "In-room breakfast can be ordered through me.",
    "parking": "Basement car park, levels B1 and B2. Valet at the main entrance, "
               "free for hotel guests.",
    "laundry": "Laundry bags are in the wardrobe. Leave them out by 9am for "
               "same-day return by 6pm.",
}
