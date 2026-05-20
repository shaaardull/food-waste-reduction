import { create } from 'zustand';
import type { Restaurant } from '@plate-clean/shared-types';

const TOKEN_KEY = 'plate_dashboard_token';
const USER_KEY = 'plate_dashboard_user';
const REST_KEY = 'plate_dashboard_restaurant_id';
const RESTAURANT_DETAIL_KEY = 'plate_dashboard_restaurant';

interface StaffUser {
  id: string;
  email: string;
  role: string;
  display_name?: string | null;
}

interface AuthState {
  user: StaffUser | null;
  token: string | null;
  restaurantId: string | null;
  /** Cached full Restaurant row for the active restaurant; powers the theming hook. */
  activeRestaurant: Restaurant | null;
  setAuth: (user: StaffUser, token: string) => void;
  setRestaurantId: (id: string) => void;
  setActiveRestaurant: (restaurant: Restaurant | null) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: (() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StaffUser) : null;
  })(),
  token: localStorage.getItem(TOKEN_KEY),
  restaurantId: localStorage.getItem(REST_KEY),
  activeRestaurant: (() => {
    const raw = localStorage.getItem(RESTAURANT_DETAIL_KEY);
    return raw ? (JSON.parse(raw) as Restaurant) : null;
  })(),
  setAuth: (user, token) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user, token });
  },
  setRestaurantId: (id) => {
    localStorage.setItem(REST_KEY, id);
    set({ restaurantId: id });
  },
  setActiveRestaurant: (restaurant) => {
    if (restaurant) {
      localStorage.setItem(RESTAURANT_DETAIL_KEY, JSON.stringify(restaurant));
    } else {
      localStorage.removeItem(RESTAURANT_DETAIL_KEY);
    }
    set({ activeRestaurant: restaurant });
  },
  clearAuth: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(REST_KEY);
    localStorage.removeItem(RESTAURANT_DETAIL_KEY);
    set({ user: null, token: null, restaurantId: null, activeRestaurant: null });
  },
}));
