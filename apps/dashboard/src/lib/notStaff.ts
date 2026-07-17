import { create } from 'zustand';

/**
 * A 403 with NOT_RESTAURANT_STAFF / NOT_ON_STAFF from ANY API call means
 * the caller isn't on the staff of the restaurant they're trying to act
 * on. Rather than let each screen render a raw error, api.ts trips this
 * flag; App.tsx watches it and routes to /not-on-staff.
 */
interface NotStaffState {
  active: boolean;
  restaurantSlug: string | null;
  restaurantId: string | null;
  trigger: (info: { restaurantSlug?: string | null; restaurantId?: string | null }) => void;
  clear: () => void;
}

export const useNotStaffStore = create<NotStaffState>((set) => ({
  active: false,
  restaurantSlug: null,
  restaurantId: null,
  trigger: ({ restaurantSlug = null, restaurantId = null }) =>
    set({ active: true, restaurantSlug, restaurantId }),
  clear: () => set({ active: false, restaurantSlug: null, restaurantId: null }),
}));
