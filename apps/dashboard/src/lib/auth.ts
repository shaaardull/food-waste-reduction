import { create } from 'zustand';

const TOKEN_KEY = 'plate_dashboard_token';
const USER_KEY = 'plate_dashboard_user';
const REST_KEY = 'plate_dashboard_restaurant_id';

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
  setAuth: (user: StaffUser, token: string) => void;
  setRestaurantId: (id: string) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: (() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StaffUser) : null;
  })(),
  token: localStorage.getItem(TOKEN_KEY),
  restaurantId: localStorage.getItem(REST_KEY),
  setAuth: (user, token) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user, token });
  },
  setRestaurantId: (id) => {
    localStorage.setItem(REST_KEY, id);
    set({ restaurantId: id });
  },
  clearAuth: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(REST_KEY);
    set({ user: null, token: null, restaurantId: null });
  },
}));
