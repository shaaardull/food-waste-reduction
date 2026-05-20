"""Seed: 2 restaurants, 1 staff user each, 20 menu items, 1 reward rule each, 1 diner.

Run: `python -m app.scripts.seed` after migrations.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.menu_item import MenuItem
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.reward import RewardRule
from app.models.user import User
from app.security import hash_password

settings = get_settings()

RESTAURANTS = [
    {
        "name": "Spice Trail",
        "slug": "spice-trail",
        "address": "12 Linking Road, Bandra West, Mumbai",
        "latitude": 19.0613,
        "longitude": 72.8307,
        "currency": "INR",
        "timezone": "Asia/Kolkata",
        "theme_primary_color": "#b45309",  # amber-700
        "tagline": "North Indian classics. Done quietly.",
        "menu": [
            ("Butter Chicken", "main", 38000, True),
            ("Paneer Tikka Masala", "main", 32000, True),
            ("Dal Makhani", "main", 28000, True),
            ("Jeera Rice", "side", 18000, False),
            ("Garlic Naan", "side", 9000, False),
            ("Tandoori Roti", "side", 4000, False),
            ("Mixed Veg Raita", "side", 10000, False),
            ("Masala Papad", "side", 8000, False),
            ("Mango Lassi", "drink", 12000, False),
            ("Gulab Jamun", "dessert", 9000, True),
        ],
    },
    {
        "name": "Konkan Kitchen",
        "slug": "konkan-kitchen",
        "address": "44 Hill Road, Bandra West, Mumbai",
        "latitude": 19.0571,
        "longitude": 72.8295,
        "currency": "INR",
        "timezone": "Asia/Kolkata",
        "theme_primary_color": "#0e7490",  # cyan-700
        "tagline": "Coastal kitchen, family recipes.",
        "menu": [
            ("Sol Kadhi", "drink", 8000, False),
            ("Fish Thali", "main", 45000, True),
            ("Prawn Curry", "main", 52000, True),
            ("Bombil Fry", "main", 38000, True),
            ("Solkadhi", "drink", 7000, False),
            ("Modak (steamed)", "dessert", 10000, True),
            ("Sukha Bombil", "side", 18000, False),
            ("Kombdi Vade", "main", 36000, True),
            ("Chicken Sukka", "main", 34000, True),
            ("Coconut Rice", "side", 14000, False),
        ],
    },
]


def run() -> None:
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as db:
        # Admin (platform operator) — has access to POST /restaurants and the
        # onboarding wizard in the dashboard.
        admin_email = "admin@example.com"
        admin = db.execute(select(User).where(User.email == admin_email)).scalar_one_or_none()
        if admin is None:
            admin = User(
                email=admin_email,
                display_name="Demo Admin",
                password_hash=hash_password("plate-clean-demo"),
                role="admin",
            )
            db.add(admin)
            db.flush()
            print(f"+ admin {admin_email} (password: plate-clean-demo)")

        # Diner
        diner_email = "diner@example.com"
        diner = db.execute(select(User).where(User.email == diner_email)).scalar_one_or_none()
        if diner is None:
            diner = User(
                email=diner_email,
                display_name="Demo Diner",
                password_hash=hash_password("plate-clean-demo"),
                role="diner",
            )
            db.add(diner)
            db.flush()
            print(f"+ diner {diner_email} (password: plate-clean-demo)")

        for idx, r in enumerate(RESTAURANTS, start=1):
            restaurant = db.execute(
                select(Restaurant).where(Restaurant.slug == r["slug"])
            ).scalar_one_or_none()
            if restaurant is None:
                restaurant = Restaurant(
                    name=r["name"],
                    slug=r["slug"],
                    address=r["address"],
                    latitude=r["latitude"],
                    longitude=r["longitude"],
                    geofence_radius_m=settings.GEOFENCE_DEFAULT_RADIUS_M,
                    timezone=r["timezone"],
                    currency=r["currency"],
                    is_active=True,
                    theme_primary_color=r.get("theme_primary_color", "#0f766e"),
                    tagline=r.get("tagline"),
                )
                db.add(restaurant)
                db.flush()
                print(f"+ restaurant {r['slug']}")
            staff_email = f"staff{idx}@example.com"
            staff = db.execute(select(User).where(User.email == staff_email)).scalar_one_or_none()
            if staff is None:
                staff = User(
                    email=staff_email,
                    display_name=f"Demo Staff {idx}",
                    password_hash=hash_password("plate-clean-demo"),
                    role="staff",
                )
                db.add(staff)
                db.flush()
                print(f"+ staff {staff_email} (password: plate-clean-demo)")
            link = db.execute(
                select(RestaurantStaff).where(
                    RestaurantStaff.user_id == staff.id,
                    RestaurantStaff.restaurant_id == restaurant.id,
                )
            ).scalar_one_or_none()
            if link is None:
                db.add(RestaurantStaff(user_id=staff.id, restaurant_id=restaurant.id, role="manager"))

            reward_item = None
            for name, category, price, reward_eligible in r["menu"]:
                existing = db.execute(
                    select(MenuItem).where(
                        MenuItem.restaurant_id == restaurant.id, MenuItem.name == name
                    )
                ).scalar_one_or_none()
                if existing is None:
                    mi = MenuItem(
                        restaurant_id=restaurant.id,
                        name=name,
                        price_minor=price,
                        category=category,
                        is_reward_eligible=reward_eligible,
                        is_active=True,
                    )
                    db.add(mi)
                    db.flush()
                    if reward_eligible and category == "dessert":
                        reward_item = mi
                elif existing.is_reward_eligible and existing.category == "dessert":
                    reward_item = existing

            if reward_item is not None:
                existing_rule = db.execute(
                    select(RewardRule).where(RewardRule.restaurant_id == restaurant.id)
                ).scalar_one_or_none()
                if existing_rule is None:
                    db.add(
                        RewardRule(
                            restaurant_id=restaurant.id,
                            name=f"Free {reward_item.name}",
                            consumption_threshold=Decimal("0.75"),
                            reward_menu_item_id=reward_item.id,
                            daily_redemption_cap_per_user=1,
                            is_active=True,
                            # §12: diner picks menu item OR bill discount.
                            allowed_reward_types=["menu_item", "bill_discount"],
                            # Default the bill discount to the dessert's price so
                            # the diner's two options have the same nominal value.
                            bill_discount_minor=reward_item.price_minor,
                        )
                    )
                    print(f"+ reward rule on {r['slug']}: free {reward_item.name} at 0.75 threshold")

        db.commit()
        print("seed complete.")


if __name__ == "__main__":
    run()
