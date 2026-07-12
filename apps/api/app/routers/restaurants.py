from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import ImageInvalid, NotRestaurantStaff
from app.models.menu_extraction import MenuExtraction
from app.models.menu_item import MenuItem
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.reward import RewardRule
from app.models.user import User
from app.schemas.restaurant import (
    MenuExtractedItemOut,
    MenuExtractionOut,
    MenuItemOut,
    MenuItemPatchIn,
    MenuItemsBulkIn,
    RestaurantCreateIn,
    RestaurantOut,
    RestaurantPatchIn,
    RewardRuleIn,
    RewardRuleOut,
    StaffInviteIn,
    StaffInviteOut,
)
from app.security import get_current_user, hash_password, haversine_m
from app.services import storage
from app.vision import anthropic_client as vision_client

router = APIRouter()


@router.get("", response_model=list[RestaurantOut])
async def list_restaurants(
    db: AsyncSession = Depends(get_db),
    lat: float | None = Query(default=None),
    lng: float | None = Query(default=None),
    radius_km: float | None = Query(default=None, gt=0, le=200),
) -> list[RestaurantOut]:
    result = await db.execute(select(Restaurant).where(Restaurant.is_active.is_(True)))
    restaurants = list(result.scalars().all())
    if lat is not None and lng is not None and radius_km is not None:
        max_m = radius_km * 1000
        restaurants = [
            r for r in restaurants if haversine_m(lat, lng, r.latitude, r.longitude) <= max_m
        ]
    return [RestaurantOut.model_validate(r) for r in restaurants]


@router.post("", response_model=RestaurantOut, status_code=status.HTTP_201_CREATED)
async def create_restaurant(
    payload: RestaurantCreateIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RestaurantOut:
    """Admin-only restaurant creation (§5.2)."""
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )
    kwargs: dict[str, object] = dict(
        name=payload.name,
        slug=payload.slug,
        address=payload.address,
        latitude=payload.latitude,
        longitude=payload.longitude,
        geofence_radius_m=payload.geofence_radius_m,
        timezone=payload.timezone,
        currency=payload.currency,
        is_active=True,
        theme_primary_color=payload.theme_primary_color,
        theme_logo_url=str(payload.theme_logo_url) if payload.theme_logo_url else None,
        tagline=payload.tagline,
    )
    # GST fields only get overridden when the caller passes them —
    # otherwise we let the DB defaults (5%, HSN 9963, no GSTIN) apply.
    if payload.gstin is not None:
        kwargs["gstin"] = payload.gstin
    if payload.gst_rate is not None:
        kwargs["gst_rate"] = payload.gst_rate
    if payload.hsn_code is not None:
        kwargs["hsn_code"] = payload.hsn_code
    if payload.bill_prefix is not None:
        kwargs["bill_prefix"] = payload.bill_prefix
    if payload.gst_enabled is not None:
        kwargs["gst_enabled"] = payload.gst_enabled
    restaurant = Restaurant(**kwargs)
    db.add(restaurant)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"slug '{payload.slug}' already exists",
        ) from exc
    await db.refresh(restaurant)
    return RestaurantOut.model_validate(restaurant)


@router.get("/{slug}", response_model=RestaurantOut)
async def get_restaurant(slug: str, db: AsyncSession = Depends(get_db)) -> RestaurantOut:
    result = await db.execute(select(Restaurant).where(Restaurant.slug == slug))
    restaurant = result.scalar_one_or_none()
    if restaurant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")
    return RestaurantOut.model_validate(restaurant)


async def _require_owner_or_admin(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> None:
    """Deprecated compatibility shim — kept so callers don't have to
    move imports in the same sprint. The per-role hierarchy was
    flattened by product decision: any staff (owner / manager /
    server) can now perform every restaurant-scoped action.
    Delegates to the flat any-staff check below. Callers should
    switch to `_require_any_restaurant_staff` directly in future.
    """
    await _require_any_restaurant_staff(db, user, restaurant_id)


async def _require_any_restaurant_staff(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> None:
    """Menu editing is delegated all the way down to servers — the
    per-role decision was made explicitly in the sprint kickoff. Any
    membership in restaurant_staff for this restaurant passes; role
    doesn't matter. Admins pass unconditionally.
    """
    if user.role == "admin":
        return
    if user.role != "staff":
        raise NotRestaurantStaff()
    res = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    )
    if res.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not on the staff of this restaurant",
        )


@router.patch("/{restaurant_id}", response_model=RestaurantOut)
async def patch_restaurant(
    restaurant_id: UUID,
    payload: RestaurantPatchIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RestaurantOut:
    """Owner of the restaurant or platform admin can edit."""
    await _require_owner_or_admin(db, user, restaurant_id)
    restaurant = await db.get(Restaurant, restaurant_id)
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    data = payload.model_dump(exclude_unset=True)
    if "theme_logo_url" in data and data["theme_logo_url"] is not None:
        data["theme_logo_url"] = str(data["theme_logo_url"])
    for key, value in data.items():
        setattr(restaurant, key, value)
    await db.commit()
    await db.refresh(restaurant)
    return RestaurantOut.model_validate(restaurant)


@router.get("/{restaurant_id}/menu", response_model=list[MenuItemOut])
async def get_menu(restaurant_id: UUID, db: AsyncSession = Depends(get_db)) -> list[MenuItemOut]:
    """Diner-facing menu — active items only, no auth. This is what the
    Order screen renders."""
    result = await db.execute(
        select(MenuItem).where(MenuItem.restaurant_id == restaurant_id, MenuItem.is_active.is_(True))
    )
    return [MenuItemOut.model_validate(m) for m in result.scalars().all()]


@router.get("/{restaurant_id}/menu-items", response_model=list[MenuItemOut])
async def list_menu_items_for_staff(
    restaurant_id: UUID,
    include_inactive: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MenuItemOut]:
    """Staff-side menu view — same shape as GET /menu but authenticated
    and optionally includes soft-deleted rows so the dashboard can
    surface an "Archived" section and offer one-tap undo. Any
    restaurant staff can call."""
    await _require_any_restaurant_staff(db, user, restaurant_id)
    query = select(MenuItem).where(MenuItem.restaurant_id == restaurant_id)
    if not include_inactive:
        query = query.where(MenuItem.is_active.is_(True))
    query = query.order_by(MenuItem.category, MenuItem.name)
    result = await db.execute(query)
    return [MenuItemOut.model_validate(m) for m in result.scalars().all()]


@router.post(
    "/{restaurant_id}/menu-items",
    response_model=list[MenuItemOut],
    status_code=status.HTTP_201_CREATED,
)
async def add_menu_items(
    restaurant_id: UUID,
    payload: MenuItemsBulkIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MenuItemOut]:
    """Bulk-add menu items. Any restaurant staff (owner / manager /
    server) can add — the sprint kickoff explicitly widened this so a
    waiter noticing a new special can add it without pinging an owner.
    Admins pass unconditionally."""
    await _require_any_restaurant_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    created: list[MenuItem] = []
    for item in payload.items:
        m = MenuItem(
            restaurant_id=restaurant_id,
            name=item.name,
            description=item.description,
            price_minor=item.price_minor,
            category=item.category,
            is_reward_eligible=item.is_reward_eligible,
            is_active=True,
            reference_image_url=str(item.reference_image_url)
            if item.reference_image_url
            else None,
        )
        db.add(m)
        created.append(m)
    await db.commit()
    for m in created:
        await db.refresh(m)
    return [MenuItemOut.model_validate(m) for m in created]


@router.patch(
    "/{restaurant_id}/menu-items/{item_id}",
    response_model=MenuItemOut,
)
async def patch_menu_item(
    restaurant_id: UUID,
    item_id: UUID,
    payload: MenuItemPatchIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MenuItemOut:
    """Partial update of a single menu item. Any restaurant staff can edit
    (the wider role set was decided in the sprint kickoff — a waiter can
    correct a price in the moment). Only fields the client sends are
    applied; everything else is untouched."""
    await _require_any_restaurant_staff(db, user, restaurant_id)
    item = await db.get(MenuItem, item_id)
    if item is None or item.restaurant_id != restaurant_id:
        raise HTTPException(status_code=404, detail="Menu item not found")
    # Pydantic's exclude_unset gives us "the keys the client actually
    # sent" — critical for partial updates so a missing `description`
    # doesn't stomp the existing value with None.
    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        if key == "reference_image_url" and value is not None:
            value = str(value)
        setattr(item, key, value)
    await db.commit()
    await db.refresh(item)
    return MenuItemOut.model_validate(item)


@router.delete(
    "/{restaurant_id}/menu-items/{item_id}",
    response_model=MenuItemOut,
)
async def delete_menu_item(
    restaurant_id: UUID,
    item_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MenuItemOut:
    """Soft delete — flip `is_active=false`. The row survives so past
    `meal_session_items` still resolve their FK, and an "Undo" chip in
    the dashboard can flip it back with a PATCH. `GET /restaurants/:id/menu`
    already filters `is_active=true`, so a soft-deleted item vanishes
    from the diner Order screen immediately."""
    await _require_any_restaurant_staff(db, user, restaurant_id)
    item = await db.get(MenuItem, item_id)
    if item is None or item.restaurant_id != restaurant_id:
        raise HTTPException(status_code=404, detail="Menu item not found")
    if not item.is_active:
        # Idempotent — a second delete on an already-inactive row is a
        # no-op, not an error. Matches the spirit of the staff validate
        # endpoint's idempotency.
        return MenuItemOut.model_validate(item)
    item.is_active = False
    await db.commit()
    await db.refresh(item)
    return MenuItemOut.model_validate(item)


# Menu categories we consider "valid" server-side. The Claude tool
# schema constrains its output to this same set, but a defensive
# server-side coerce keeps a hallucinated category from bleeding into
# the response — we simply drop it to None and let staff pick.
_VALID_MENU_CATEGORIES = {"starter", "main", "side", "bread", "drink", "dessert"}


@router.post(
    "/{restaurant_id}/menu-items/extract",
    response_model=MenuExtractionOut,
)
async def extract_menu_from_photo(
    restaurant_id: UUID,
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MenuExtractionOut:
    """Vision-based menu-card import. Staff uploads a photo of the
    printed menu; Claude returns a structured list of proposed dishes
    which the frontend surfaces in a review grid. Nothing lands in
    `menu_items` here — the staff clicks Confirm on the frontend and
    that hits the existing bulk-add endpoint.

    Runs synchronously (5–10 s round trip). If we ever need async we
    lift this into a Celery task; the response shape stays the same
    behind an extraction_id.
    """
    await _require_any_restaurant_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    image_bytes = await image.read()
    try:
        mime, _sha = storage.validate_and_hash(image_bytes)
    except ImageInvalid:
        raise
    # Mint the extraction id up front so we can lay the S3 object
    # under a stable key even if the vision call fails — the audit
    # row stays useful for post-mortem.
    extraction_id = uuid4()
    image_key = storage.upload_menu_extraction(extraction_id, image_bytes, mime)

    # Synchronous vision call. `extract_menu_from_image` handles its
    # own timing + error mapping to ModelUnavailable.
    tool_input, processing_ms, model_version = vision_client.extract_menu_from_image(
        image_bytes, mime
    )

    raw_items = tool_input.get("items", []) or []
    proposed: list[MenuExtractedItemOut] = []
    for item in raw_items:
        try:
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            category = item.get("category")
            if category not in _VALID_MENU_CATEGORIES:
                category = None
            price_minor = int(item.get("price_minor") or 0)
            confidence = float(item.get("confidence") or 0.0)
            description = item.get("description") or None
            proposed.append(
                MenuExtractedItemOut(
                    name=name[:120],
                    description=(description[:400] if description else None),
                    price_minor=max(0, min(price_minor, 1_000_000_00)),
                    category=category,
                    confidence=max(0.0, min(confidence, 1.0)),
                )
            )
        except (TypeError, ValueError):
            # A malformed row from the model shouldn't blow up the
            # whole extraction. Skip it and let the notes carry the
            # signal.
            continue

    extraction_row = MenuExtraction(
        id=extraction_id,
        restaurant_id=restaurant_id,
        staff_user_id=user.id,
        image_s3_key=image_key,
        model_name="claude-vision",
        model_version=model_version,
        raw_output=tool_input,
        items_proposed=len(proposed),
        items_accepted=0,  # bumped when staff confirms via bulk-add
        processing_ms=processing_ms,
        extracted_at=datetime.now(UTC),
    )
    db.add(extraction_row)
    await db.commit()

    return MenuExtractionOut(
        extraction_id=extraction_id,
        items=proposed,
        detected_currency=str(tool_input.get("detected_currency") or "INR"),
        confidence=float(tool_input.get("confidence") or 0.0),
        notes=(tool_input.get("notes") or None),
        processing_ms=processing_ms,
        model_name="claude-vision",
        model_version=model_version,
    )


@router.post(
    "/{restaurant_id}/reward-rules",
    response_model=RewardRuleOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_reward_rule(
    restaurant_id: UUID,
    payload: RewardRuleIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RewardRuleOut:
    await _require_owner_or_admin(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    reward_item = await db.get(MenuItem, payload.reward_menu_item_id)
    if reward_item is None or reward_item.restaurant_id != restaurant_id:
        raise HTTPException(
            status_code=400, detail="reward_menu_item_id must belong to this restaurant"
        )
    rule = RewardRule(
        restaurant_id=restaurant_id,
        name=payload.name,
        consumption_threshold=Decimal(str(payload.consumption_threshold)),
        reward_menu_item_id=payload.reward_menu_item_id,
        daily_redemption_cap_per_user=payload.daily_redemption_cap_per_user,
        is_active=True,
        allowed_reward_types=payload.allowed_reward_types,
        bill_discount_minor=payload.bill_discount_minor,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return RewardRuleOut.model_validate(rule)


@router.post(
    "/{restaurant_id}/staff",
    response_model=StaffInviteOut,
    status_code=status.HTTP_201_CREATED,
)
async def invite_staff(
    restaurant_id: UUID,
    payload: StaffInviteIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StaffInviteOut:
    """Any restaurant staff or admin can invite a new staff user and
    link them to this restaurant.

    This is a Phase-1 single-step invite — sets a password directly. A real
    invite-by-email flow can replace this in Phase 2 without changing callers.

    Single-owner constraint: each restaurant has exactly one owner
    account (the person who legally owns the entity). We enforce
    that here — attempting to invite a second `owner` while one
    already exists returns 409. Managers and servers have no such
    cap; a restaurant can have as many of each as it wants.
    """
    await _require_any_restaurant_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    if payload.role == "owner":
        existing_owner = await db.execute(
            select(RestaurantStaff).where(
                RestaurantStaff.restaurant_id == restaurant_id,
                RestaurantStaff.role == "owner",
            )
        )
        if existing_owner.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "OWNER_ALREADY_EXISTS",
                    "message": (
                        "This restaurant already has an owner. Invite the "
                        "new person as a manager instead."
                    ),
                },
            )

    email = payload.email.lower()
    existing = await db.execute(select(User).where(User.email == email))
    new_user = existing.scalar_one_or_none()
    if new_user is None:
        new_user = User(
            email=email,
            display_name=payload.display_name,
            password_hash=hash_password(payload.password),
            role="staff",
        )
        db.add(new_user)
        await db.flush()
    elif new_user.role == "diner":
        # Promote and reset password if owner wants to convert an existing
        # diner account to staff at this restaurant.
        new_user.role = "staff"
        new_user.password_hash = hash_password(payload.password)

    link = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == new_user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    )
    if link.scalar_one_or_none() is None:
        db.add(
            RestaurantStaff(
                user_id=new_user.id,
                restaurant_id=restaurant_id,
                role=payload.role,
            )
        )

    await db.commit()
    await db.refresh(new_user)
    return StaffInviteOut(user_id=new_user.id, email=new_user.email, role=payload.role)
