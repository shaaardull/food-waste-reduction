import { create } from 'zustand';
import type { Restaurant, User } from '@plate-clean/shared-types';

const TOKEN_KEY = 'plate_clean_token';
const USER_KEY = 'plate_clean_user';
const RESTAURANT_KEY = 'plate_clean_active_restaurant';

interface AuthState {
  user: User | null;
  token: string | null;
  activeRestaurant: Restaurant | null;
  setAuth: (user: User, token: string) => void;
  setActiveRestaurant: (restaurant: Restaurant | null) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: (() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  })(),
  token: localStorage.getItem(TOKEN_KEY),
  activeRestaurant: (() => {
    const raw = localStorage.getItem(RESTAURANT_KEY);
    return raw ? (JSON.parse(raw) as Restaurant) : null;
  })(),
  setAuth: (user, token) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user, token });
  },
  setActiveRestaurant: (restaurant) => {
    if (restaurant) {
      localStorage.setItem(RESTAURANT_KEY, JSON.stringify(restaurant));
    } else {
      localStorage.removeItem(RESTAURANT_KEY);
    }
    set({ activeRestaurant: restaurant });
  },
  clearAuth: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(RESTAURANT_KEY);
    set({ user: null, token: null, activeRestaurant: null });
  },
}));
